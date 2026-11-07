"""Turn an uploaded deck into slide images plus titles and speaker notes.

PPTX/PPT/ODP/Keynote → PDF with LibreOffice (hidden slides included, so slide
numbers match PowerPoint's), PDF → one PNG per page with Poppler, and notes,
titles, click builds and hidden flags read from the .pptx with python-pptx.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

OFFICE_EXT = {".pptx", ".ppt", ".odp", ".key", ".pps", ".ppsx"}
PDF_EXT = {".pdf"}
CONVERT_TIMEOUT = int(os.environ.get("CONVERT_TIMEOUT_SEC", "240"))


class RenderError(Exception):
    """Conversion failed in a way worth telling the speaker about."""


class NeedsAgent(RenderError):
    """The server can't read this format; the show laptop will export it."""


@dataclass
class SlideOut:
    n: int
    image: Optional[Path]
    title: Optional[str] = None
    notes: Optional[str] = None
    builds: Optional[int] = None
    hidden: bool = False


@dataclass
class RenderResult:
    slides: list[SlideOut] = field(default_factory=list)
    aspect: Optional[float] = None


def _clean(text: Optional[str]) -> Optional[str]:
    if text is None:
        return None
    t = re.sub(r"\r\n?|\x0b", "\n", text).replace("\x00", "").strip()
    return t or None


def read_pptx_meta(path: Path) -> tuple[list[dict], Optional[float]]:
    """Titles, notes, click builds and hidden flags per slide, and the slide aspect."""
    from pptx import Presentation  # imported lazily so PDF-only use needs no python-pptx

    prs = Presentation(str(path))
    aspect = None
    if prs.slide_width and prs.slide_height:
        aspect = float(prs.slide_width) / float(prs.slide_height)
    out: list[dict] = []
    for slide in prs.slides:
        title = None
        try:
            if slide.shapes.title is not None:
                title = slide.shapes.title.text
        except Exception:  # noqa: BLE001 — malformed shapes shouldn't stop the render
            title = None
        notes = None
        try:
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
                notes = slide.notes_slide.notes_text_frame.text
        except Exception:  # noqa: BLE001
            notes = None
        el = slide._element  # noqa: SLF001 — python-pptx has no public API for these
        hidden = el.get("show") in ("0", "false")
        builds = len(el.xpath('.//p:cTn[@nodeType="clickEffect"]'))
        out.append({"title": _clean(title), "notes": _clean(notes), "builds": builds, "hidden": hidden})
    return out, aspect


def to_pdf(src: Path, workdir: Path) -> Path:
    """Convert with LibreOffice in its own profile so several conversions can run at once."""
    profile = workdir / f"lo-profile-{uuid.uuid4().hex}"
    filter_opts = json.dumps(
        {
            "ExportHiddenSlides": {"type": "boolean", "value": "true"},
            "ExportNotesPages": {"type": "boolean", "value": "false"},
        }
    )
    attempts = [f"pdf:impress_pdf_Export:{filter_opts}", "pdf"]
    last_err = ""
    for target in attempts:
        cmd = [
            "soffice",
            f"-env:UserInstallation={profile.as_uri()}",
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--convert-to",
            target,
            "--outdir",
            str(workdir),
            str(src),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=CONVERT_TIMEOUT)
        except subprocess.TimeoutExpired as e:
            raise RenderError("conversion took too long") from e
        pdf = workdir / f"{src.stem}.pdf"
        if proc.returncode == 0 and pdf.exists() and pdf.stat().st_size > 0:
            shutil.rmtree(profile, ignore_errors=True)
            return pdf
        last_err = (proc.stderr or proc.stdout or "").strip()[-300:]
    shutil.rmtree(profile, ignore_errors=True)
    if src.suffix.lower() == ".key":
        raise NeedsAgent("Keynote file could not be converted on the server")
    raise RenderError(f"LibreOffice could not convert the file {last_err}".strip())


def pdf_pages(pdf: Path) -> tuple[int, Optional[float]]:
    proc = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RenderError("could not read the PDF")
    pages = int(re.search(r"^Pages:\s+(\d+)", proc.stdout, re.M).group(1)) if "Pages:" in proc.stdout else 0
    m = re.search(r"^Page size:\s+([\d.]+) x ([\d.]+)", proc.stdout, re.M)
    aspect = float(m.group(1)) / float(m.group(2)) if m and float(m.group(2)) > 0 else None
    return pages, aspect


def render_page(pdf: Path, page: int, out_base: Path, width: int) -> Path:
    cmd = [
        "pdftoppm",
        "-png",
        "-f",
        str(page),
        "-l",
        str(page),
        "-singlefile",
        "-scale-to-x",
        str(width),
        "-scale-to-y",
        "-1",
        str(pdf),
        str(out_base),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    png = out_base.with_suffix(".png")
    if proc.returncode != 0 or not png.exists():
        raise RenderError(f"could not draw slide {page}")
    return png


def render_file(
    src: Path,
    workdir: Path,
    width: int = 1280,
    on_progress: Callable[[int, int], None] | None = None,
) -> RenderResult:
    ext = src.suffix.lower()
    if ext in PDF_EXT:
        pdf = src
    elif ext in OFFICE_EXT:
        pdf = to_pdf(src, workdir)
    else:
        raise RenderError("unsupported file type")

    meta: list[dict] = []
    aspect: Optional[float] = None
    if ext in {".pptx", ".ppsx"}:
        try:
            meta, aspect = read_pptx_meta(src)
        except Exception:  # noqa: BLE001 — notes are a bonus; images still render
            meta = []

    pages, pdf_aspect = pdf_pages(pdf)
    if pages <= 0:
        raise RenderError("the file has no slides")
    aspect = aspect or pdf_aspect
    result = RenderResult(aspect=aspect)
    img_dir = workdir / "img"
    img_dir.mkdir(exist_ok=True)
    for i in range(1, pages + 1):
        png = render_page(pdf, i, img_dir / f"{i}", width)
        m = meta[i - 1] if i - 1 < len(meta) else {}
        result.slides.append(
            SlideOut(
                n=i,
                image=png,
                title=m.get("title"),
                notes=m.get("notes"),
                builds=m.get("builds"),
                hidden=bool(m.get("hidden", False)),
            )
        )
        if on_progress:
            on_progress(i, pages)
    return result


def new_workdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="render-"))
