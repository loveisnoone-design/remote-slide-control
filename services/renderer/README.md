# Preview renderer

Turns a speaker's uploaded deck into slide images, titles and speaker notes so
they can check their slides before the show. Optional: without it, previews
appear once the show laptop opens the file (the agent exports exact images from
PowerPoint/Keynote either way).

| Input | How |
| --- | --- |
| `.pptx` `.ppt` `.odp` | LibreOffice → PDF (hidden slides included, so numbering matches PowerPoint) → PNG per slide; notes, titles and click builds from the .pptx |
| `.pdf` | PNG per page |
| `.key` | Tried with LibreOffice; if it can't read the file the deck is marked "previewed by the show laptop" |

## Environment

| Variable | Meaning |
| --- | --- |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server only — never put it in the web app) |
| `ALLOWED_ORIGINS` | Your web app origin(s), comma separated, e.g. `https://slides.example.com` |
| `RENDER_WIDTH` | Image width in px (default 1280) |
| `MAX_UPLOAD_MB` | Largest file it will download (default 300) |
| `RENDER_CONCURRENCY` | Renders at once per instance (default 2) |

## Deploy on Google Cloud Run (uses your Google / Firebase account)

```bash
gcloud run deploy slide-relay-renderer \
  --source services/renderer \
  --region asia-southeast1 \
  --memory 2Gi --cpu 2 --timeout 600 --concurrency 4 \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --set-env-vars SUPABASE_URL=https://YOUR-PROJECT.supabase.co,ALLOWED_ORIGINS=https://YOUR-WEB-APP \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=supabase-service-role:latest
```

`--no-cpu-throttling` matters: the render runs after the request returns, and
Cloud Run otherwise pauses the CPU between requests. Billing must be enabled on
the Google Cloud project. `--allow-unauthenticated` only opens the URL — every
request is still checked against the caller's Supabase session.

Then set `VITE_RENDERER_URL` in the web app to the service URL.

## Run locally

```bash
docker build -t slide-relay-renderer services/renderer
docker run --rm -p 8080:8080 -e SUPABASE_URL=… -e SUPABASE_SERVICE_ROLE_KEY=… -e ALLOWED_ORIGINS=http://localhost:5173 slide-relay-renderer
```

Tests (need LibreOffice and Poppler installed): `cd services/renderer && pytest`.
