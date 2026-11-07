# Slide Relay — remote slide control for hybrid events

A speaker joins from anywhere and drives the presentation running on the
**onsite show laptop**: next/back with confirmation, a laser pointer drawn on the
venue output, presenter view with notes, a host-set countdown, and quiet
messages from the host. The show team keeps an operator console with lock,
override and a full click log.

```
Speaker browser / phone ──┐                          ┌── PowerPoint (Windows · COM)
                          ├── Supabase Realtime ──── Agent on show laptop ── PowerPoint / Keynote (Mac · AppleScript)
Operator console ─────────┘   (private channels)     └── Laser overlay window · OSC / HTTP for Companion
```

| Folder | What it is |
| --- | --- |
| `apps/web` | Operator console, speaker presenter view (desktop + phone), speaker setup/upload — React + Vite |
| `apps/agent` | Desktop app for the show laptop — Electron, Windows and macOS |
| `packages/protocol` | Message types and the shared rules (command checks, timer, laser mapping) |
| `supabase/` | Database schema, access rules, Realtime channel rules, storage rules + tests |
| `services/renderer` | Optional preview service: uploaded PPTX/PDF → slide images + notes (LibreOffice) |
| `docs/` | [Architecture](docs/ARCHITECTURE.md) · [On-device test checklist](docs/TESTING.md) |

---

## 1. Supabase (one time)

1. Create a project. Pick **Southeast Asia (Singapore)** for the lowest latency from Thailand.
2. **Authentication → Sign In / Providers**: turn on **Allow anonymous sign-ins** (speakers and the show laptop use anonymous accounts) and keep **Email** on for operators.
3. **Authentication → URL Configuration**: set the Site URL to your web app address, and add it to the redirect URLs.
4. Create the tables and rules — either paste `supabase/migrations/20261107000000_init.sql` into the **SQL Editor** and run it, or with the CLI:
   ```bash
   supabase link --project-ref YOUR-REF
   supabase db push
   ```
5. **Realtime → Settings**: if your project offers a setting to allow public channel access, turn it off so only the private, rule-checked channels work. (The apps only use private channels either way.)
6. Note **Project Settings → API**: the project URL and the anon / publishable key (for the web app and agent). The service role key is only for the preview renderer.

Free-plan limits worth knowing: 200 realtime connections and 100 realtime messages/second per project (Pro: 500 / 500), and 50 MB per uploaded file. The laser is the heaviest traffic (about 15 updates/second while pointing), so one or two halls at once fit the free plan; for more, use Pro.

## 2. Web app

```bash
npm install
cp apps/web/.env.example apps/web/.env    # fill in URL + anon key
npm run dev:web                           # http://localhost:5173
```

Deploy as a static site. Build command `npm run build:web`, output `apps/web/dist`, environment variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and optionally `VITE_RENDERER_URL`.
`vercel.json` and `netlify.toml` are included; Cloudflare Pages works with the same settings (`apps/web/public/_redirects` handles routing).

## 3. Agent for the show laptop

**Installers:** download the latest from the repo's **Releases** page (Windows `.exe`, macOS `.dmg` for Apple silicon and Intel). To build a new version: GitHub → **Actions → Build agent installers → Run workflow**, and enter a release tag such as `agent-v0.1.1` to publish it as a Release (leave it empty to get the files as run artifacts only). To prefill the Supabase project on first launch, add repository secrets `RSC_SUPABASE_URL` and `RSC_SUPABASE_ANON_KEY` before running.

The installers are not code-signed yet:
- **Windows:** SmartScreen → *More info* → *Run anyway*.
- **macOS:** right-click the app → *Open* the first time. macOS then asks to let it control PowerPoint/Keynote (Automation) — allow it. Jumping to a slide, black screen and keystroke mode also need **Accessibility** (System Settings → Privacy & Security → Accessibility → Slide Relay Agent).

**From source:** `npm install && npm run dev:agent`.

## 4. Preview renderer (optional)

Lets speakers see their slides and notes right after uploading. See [services/renderer/README.md](services/renderer/README.md) for Cloud Run. Without it, previews appear as soon as the show laptop opens the file.

---

## Running a show

**Before the day (operator)**
1. Sign in at `/login`, create a session (name, room, talk length) and add each speaker. Copy each speaker's link and send it to them privately.
2. Speakers open their link → **Prepare your slides** → upload a `.pptx`, `.key` or `.pdf` (or paste a Google Slides link) and check slides and notes.

**On the show laptop**
1. Open **Slide Relay Agent**. In the console press **Connect show laptop** and type the 6-digit code into the agent.
2. Agent → **Speaker decks** → **Download & open**, or open the file yourself. If PowerPoint shows *Protected View*, click **Enable Editing** — the agent can't see protected files.
3. Start the slideshow (or press **Start slideshow** in the console). The agent exports exact slide images and notes from the app; speakers' previews switch to them automatically.
4. Check the laser lands correctly: agent → **Test laser**. If the dot shows on the wrong screen, pick the output under **Settings → Laser display**.

**During the talk (operator console)**
- **Give control** to the speaker who is presenting. Only that speaker can move slides; everyone else is view-only.
- **Lock remote control** stops all speaker clicks instantly. Operator clicks always work.
- **Speaker timer:** set the length, ±1 minute, start/pause/reset. By default it starts on the first slide change. It turns amber at 5 minutes, red in the last minute and counts up when over time.
- **Message to speaker:** tap a quick message or type one (mark urgent for red). It appears as a slim bar on the speaker's screen without moving their buttons; you see *Seen* when they tap *Got it*.
- **Click log** shows every command, who sent it and what happened.

**Speaker**
- Open the same link on show day → **Open presenter view**. Next/Back only show as confirmed once the show laptop reports the new slide — the meeting's screen share lags behind, the confirmation doesn't.
- A USB presentation clicker works in the browser: → / PgDn next, ← / PgUp back, B blank. L toggles the laser.
- On a phone the layout switches to a one-handed remote with big buttons.

## Show control (Companion, Stream Deck, OSC)

The agent listens on the show laptop (local only unless *Allow from the show network* is on — then HTTP needs the token shown in the agent).

| HTTP (`POST` or `GET` `http://host:9001/api/…`) | OSC (`udp 9000`, optional `/rsc` prefix) | Does |
| --- | --- | --- |
| `next` · `back` | `/next` · `/back` | Next / previous |
| `goto/4` | `/goto 4` | Jump to slide 4 |
| `blank` · `unblank` | `/blank 1` · `/blank 0` | Black screen |
| `lock` · `unlock` | `/lock 1` · `/lock 0` | Lock remote control |
| `start` | `/start` | Start the slideshow |
| `timer/start` · `timer/pause` · `timer/reset` · `timer/add/60` | same addresses | Countdown |
| `GET state` | — | Current slide, timer, lock (JSON) |

## Why it's safe on stage

- **Confirmed, not assumed.** Every command carries the slide·build the speaker was looking at. If the show already moved (a double click, a resend, the onsite clicker), the command is ignored instead of skipping a slide.
- **Resends are harmless.** Each click has an id; if the network drops the answer, the speaker's browser resends once and the agent replies with the original result without clicking again.
- **Reconnecting pauses controls** rather than queueing clicks that would all land at once.
- **Identity comes from the channel, not the message.** Each speaker can only publish on their own private channel, enforced by Supabase; nobody can send clicks as someone else.
- **The operator always wins:** lock, take control, disable a speaker, operator next/back.

## Known limits

- **Keynote** doesn't report build steps, so builds show as "not reported"; jumping to a slide restarts playback from that slide. Slide images export only while the show isn't playing.
- **PowerPoint for Mac:** jump-to-slide and black screen are sent as keystrokes (needs Accessibility). Notes are read from the saved `.pptx`, so save after editing notes.
- **Google Slides** runs in keystroke mode (keys to the front browser window); the position is estimated, not read back. For previews, upload a PDF export.
- Video and audio inside slides play as usual but can't be controlled remotely.
- Installers are unsigned (see above).
- The Windows COM bridge and the macOS AppleScript paths have to be checked on real machines: run through [docs/TESTING.md](docs/TESTING.md) before the first show.

## Development

```bash
npm install
npm test               # protocol + agent unit tests
npm run typecheck
npm run test:db        # schema + access rules on a throwaway local Postgres (needs Postgres server binaries)
cd services/renderer && pytest   # needs LibreOffice + Poppler
```
