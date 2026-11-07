# Architecture

## Pieces

| Piece | Runs where | Talks to |
| --- | --- | --- |
| Speaker presenter view / phone remote | Speaker's browser (anonymous Supabase user) | Realtime: own speaker channel, state channel (read) |
| Operator console | Show team browser (signed-in user, session owner) | Realtime: state, op, every speaker channel; Postgres |
| Agent | Show laptop (anonymous user paired with a code) | Presentation app (COM / AppleScript), Realtime, Postgres, Storage |
| Preview renderer | Container (Cloud Run) | Storage + Postgres with the service role key |

The **agent is the single source of truth** for what is on screen. It polls the
presentation app (every 400 ms on Windows, 700 ms on macOS), and whenever
anything changes it broadcasts a full `ShowState` snapshot. It also sends the
snapshot every 5 s as a heartbeat; clients treat 12 s without one as "show laptop
offline".

## Realtime channels

All channels are Supabase **private** channels. `public.rsc_topic_allowed()` is
the rule behind the `realtime.messages` policies.

| Topic | Who can read | Who can publish | Events |
| --- | --- | --- | --- |
| `rsc:<session>:state` | everyone in the session | owner, agent | `state` (ShowState), `deck` (slide images changed) |
| `rsc:<session>:op` | owner, agent | owner, agent | `action` (operator → agent), `log`, `op_result` |
| `rsc:<session>:spk:<invite>` | owner, agent, that speaker's devices | same | `cmd`, `cmd_result`, `laser`, `ping`/`pong`, `hello`, `host_msg`, `host_msg_clear`, `ack_msg` |

Because a speaker can only publish on their own channel, the agent knows who
sent a command from the channel it arrived on. The payload can't impersonate
another speaker or the operator.

## A click, end to end

1. The speaker presses **Next** while the screen shows slide 3 build 1. The browser sends
   `cmd {id, op:'next', from:{slide:3, build:1}}` and shows *Sending*.
2. The agent re-reads PowerPoint, then runs `decideSpeakerCommand`
   (`packages/protocol/src/control.ts`):
   duplicate id → disabled → locked → not the controller → no slideshow →
   `from` doesn't match the current position (stale) → at the end.
3. If allowed, it calls the app (`View.Next()` over COM, `go to next slide` over
   AppleScript), reads the position back and replies
   `cmd_result {id, ok:true, pos:{slide:3, build:2}}`, then broadcasts the new state.
4. The browser shows *Confirmed* only on that reply. With no reply after 1.2 s it
   resends the same id once; the agent answers a repeated id with the original
   result and never clicks twice. After 4 s it tells the speaker to check the screen.

Every command, allowed or not, becomes a click-log line (broadcast to the console
and stored in `public.click_log`).

## Countdown

The agent owns the timer (`packages/protocol/src/timer.ts`): length, accumulated
time and the moment it last started. Snapshots carry *elapsed at send*; clients
add the time since they received it, so speaker, operator and laptop clocks never
need to agree. With auto-start on, the first confirmed slide change starts it —
from a speaker, the operator, or someone clicking on the laptop.

## Laser

The speaker's browser sends normalised slide coordinates (0–1) at most 15 times
a second (`LaserThrottle`, always flushing the last point). The agent forwards
points from the speaker in control only, to a transparent, click-through,
always-on-top window covering the output display. That window places the slide
inside the display the way PowerPoint/Keynote letterbox it (`fitRect`) and eases
toward each new point at display refresh rate.

## Data

| Table | Holds |
| --- | --- |
| `sessions` | One talk/hall; `owner` is the operator; default talk length |
| `invites` | One per speaker: name and secret link token |
| `session_members` | Which anonymous users joined as which speaker, and which user is the agent |
| `agent_pairings`, `pair_attempts` | 6-digit codes (10 min, single use) and throttling (10 tries / 10 min / device) |
| `decks` | `upload` rows (speaker files, server previews) and `agent` rows (exact export from the app, one per file name) |
| `slides` | Per deck: image path, title, notes, click builds, hidden |
| `messages` | Host messages and their status (delivered / seen / cleared / replaced) |
| `click_log` | Every command and its result |

Storage bucket `decks` (private):

```
<session>/uploads/<invite>/<deck>/<file>      speaker uploads           (speaker writes, owner/agent read)
<session>/previews/<invite>/<deck>/<n>.png    server previews           (renderer writes)
<session>/agent/<deck>/<n>.png                exact images from the app (agent writes, everyone in session reads)
```

## Presentation app adapters (`apps/agent/src/adapters`)

| App | How | Position | Builds | Notes source | Export during show |
| --- | --- | --- | --- | --- | --- |
| PowerPoint · Windows | COM through a long-running PowerShell 5.1 process (`resources/ppt-bridge.ps1`, JSON lines) | read back | yes (click index / count) | `NotesPage` body placeholder | yes, in a second bridge process |
| PowerPoint · Mac | AppleScript; jump/blank via keystrokes | read back | from the .pptx | the .pptx file | no |
| Keynote | JXA (`showNext`, `start … from`) | read back | not reported | `presenterNotes` | no |
| Keystrokes | SendKeys / System Events to the front window | estimated | – | – | – |
