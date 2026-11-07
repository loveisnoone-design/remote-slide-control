"""Preview renderer: turns a speaker's uploaded deck into slide images and notes.

POST /render {"deck_id": "..."} with the speaker's Supabase access token as a
Bearer token. The service checks the caller may render that deck, marks it
"rendering" and does the work in the background, updating public.decks.progress
as it goes so the upload page can show live progress.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from render import NeedsAgent, RenderError, new_workdir, render_file

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
RENDER_WIDTH = int(os.environ.get("RENDER_WIDTH", "1280"))
MAX_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "300")) * 1024 * 1024
CONCURRENCY = int(os.environ.get("RENDER_CONCURRENCY", "2"))
BUCKET = "decks"
UUID_RE = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

log = logging.getLogger("renderer")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Slide Relay preview renderer")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

_slots = asyncio.Semaphore(CONCURRENCY)


class RenderRequest(BaseModel):
    deck_id: str


def _svc_headers(extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    h = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
    if extra:
        h.update(extra)
    return h


async def _rest(client: httpx.AsyncClient, method: str, path: str, **kw: Any) -> httpx.Response:
    headers = _svc_headers(kw.pop("headers", None))
    return await client.request(method, f"{SUPABASE_URL}/rest/v1/{path}", headers=headers, **kw)


async def _update_deck(client: httpx.AsyncClient, deck_id: str, patch: dict[str, Any]) -> None:
    r = await _rest(client, "PATCH", f"decks?id=eq.{deck_id}", json=patch, headers={"Prefer": "return=minimal"})
    if r.status_code >= 300:
        log.warning("deck update failed %s %s", r.status_code, r.text[:200])


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "soffice": bool(shutil.which("soffice")), "pdftoppm": bool(shutil.which("pdftoppm"))}


@app.post("/render", status_code=202)
async def render(req: RenderRequest, background: BackgroundTasks, authorization: str = Header(default="")) -> dict[str, Any]:
    import re

    if not SUPABASE_URL or not SERVICE_KEY:
        raise HTTPException(500, "renderer is not configured")
    if not re.match(UUID_RE, req.deck_id):
        raise HTTPException(400, "bad deck id")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "sign in first")

    async with httpx.AsyncClient(timeout=20) as client:
        u = await client.get(f"{SUPABASE_URL}/auth/v1/user", headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {token}"})
        if u.status_code != 200:
            raise HTTPException(401, "invalid session")
        user_id = u.json().get("id")

        r = await _rest(client, "GET", f"decks?id=eq.{req.deck_id}&select=id,session_id,invite_id,source,file_name,storage_path,status")
        rows = r.json() if r.status_code == 200 else []
        if not rows:
            raise HTTPException(404, "deck not found")
        deck = rows[0]
        if deck["source"] != "upload" or not deck.get("storage_path") or not deck.get("invite_id"):
            raise HTTPException(400, "not an uploaded deck")
        if deck["status"] == "rendering":
            return {"ok": True, "status": "rendering"}

        # The uploader (any device of that invite) or the session owner may render it.
        m = await _rest(
            client,
            "GET",
            f"session_members?select=id&role=eq.speaker&invite_id=eq.{deck['invite_id']}&user_id=eq.{user_id}",
        )
        allowed = m.status_code == 200 and len(m.json()) > 0
        if not allowed:
            s = await _rest(client, "GET", f"sessions?select=id&id=eq.{deck['session_id']}&owner=eq.{user_id}")
            allowed = s.status_code == 200 and len(s.json()) > 0
        if not allowed:
            raise HTTPException(403, "not allowed")

        await _update_deck(client, deck["id"], {"status": "rendering", "progress": 0, "error": None})

    background.add_task(_process, deck)
    return {"ok": True, "status": "rendering"}


async def _process(deck: dict[str, Any]) -> None:
    async with _slots:
        workdir = new_workdir()
        async with httpx.AsyncClient(timeout=120) as client:
            try:
                await _do_render(client, deck, workdir)
            except NeedsAgent as e:
                await _update_deck(client, deck["id"], {"status": "needs_agent", "progress": 0, "error": str(e)[:200]})
            except RenderError as e:
                await _update_deck(client, deck["id"], {"status": "failed", "error": str(e)[:200]})
            except Exception as e:  # noqa: BLE001
                log.exception("render failed")
                await _update_deck(client, deck["id"], {"status": "failed", "error": "unexpected error"[:200]})
                del e
            finally:
                shutil.rmtree(workdir, ignore_errors=True)


async def _do_render(client: httpx.AsyncClient, deck: dict[str, Any], workdir: Path) -> None:
    path = deck["storage_path"]
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{quote(path)}"
    src = workdir / ("source" + Path(path).suffix.lower())
    size = 0
    async with client.stream("GET", url, headers=_svc_headers()) as resp:
        if resp.status_code != 200:
            raise RenderError(f"could not download the file ({resp.status_code})")
        with src.open("wb") as f:
            async for chunk in resp.aiter_bytes():
                size += len(chunk)
                if size > MAX_BYTES:
                    raise RenderError("file is too large to preview")
                f.write(chunk)

    loop = asyncio.get_running_loop()
    progress = {"last": -1}

    def on_progress(done: int, total: int) -> None:
        pct = int(done * 90 / total)  # the last 10% is the upload
        if pct - progress["last"] >= 10 or done == total:
            progress["last"] = pct
            asyncio.run_coroutine_threadsafe(_update_deck(client, deck["id"], {"progress": pct}), loop)

    result = await asyncio.to_thread(render_file, src, workdir, RENDER_WIDTH, on_progress)

    base = f"{deck['session_id']}/previews/{deck['invite_id']}/{deck['id']}"
    rows = []
    for s in result.slides:
        image_path = None
        if s.image:
            image_path = f"{base}/{s.n}.png"
            up = await client.post(
                f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{quote(image_path)}",
                headers=_svc_headers({"Content-Type": "image/png", "x-upsert": "true", "cache-control": "60"}),
                content=s.image.read_bytes(),
            )
            if up.status_code >= 300:
                raise RenderError(f"could not store slide {s.n}")
        rows.append(
            {
                "deck_id": deck["id"],
                "n": s.n,
                "image_path": image_path,
                "title": s.title,
                "notes": s.notes,
                "builds": s.builds,
                "hidden": s.hidden,
            }
        )

    await _rest(client, "DELETE", f"slides?deck_id=eq.{deck['id']}")
    ins = await _rest(client, "POST", "slides", json=rows, headers={"Prefer": "return=minimal"})
    if ins.status_code >= 300:
        raise RenderError("could not save slide details")
    await _update_deck(
        client,
        deck["id"],
        {"status": "ready", "progress": 100, "slide_count": len(rows), "aspect": result.aspect, "error": None},
    )
    log.info("rendered %s: %d slides", deck["file_name"], len(rows))
