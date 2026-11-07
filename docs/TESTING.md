# On-device test checklist

The protocol, agent logic, database rules and preview renderer are covered by
automated tests. What can't be tested in CI is the actual control of PowerPoint
and Keynote, so run this once on each show laptop model before the first event.
Use a test deck with: a title slide, a slide with 3 click animations, a hidden
slide, a slide with Thai text in the notes, and a 4:3 slide size if your shows
use one.

Have three windows ready: the operator console, a speaker presenter view (on a
different computer or phone, ideally on mobile data), and the agent.

## Both platforms

- [ ] Pairing: console **Connect show laptop** → type the code in the agent → agent shows *Connected*, console shows *Show laptop online*.
- [ ] A wrong code is refused; after 10 wrong tries the agent says to wait.
- [ ] Open the test deck. Agent shows the app, file name and slide count.
- [ ] Slide images: agent *Slide images* goes to *Ready*; the speaker's thumbnails switch to the exact images; notes appear with Thai text intact.
- [ ] Start the slideshow. Console program view and speaker view show slide 1.
- [ ] Without control, the speaker's buttons are disabled with *Waiting for the host to give you control*.
- [ ] **Give control.** Speaker Next → slide changes on the output; speaker shows *Confirmed · slide 2* within a moment.
- [ ] Builds: on the 3-click slide, Next steps through builds (speaker counter shows build 1/3, 2/3, 3/3) before moving on. *(Windows PowerPoint: builds shown. Keynote: "builds not reported" is expected.)*
- [ ] Double-click Next fast: the show moves once; the click log shows *ignored · slide already moved*.
- [ ] Back, thumbnail jump to slide 4, Blank/Unblank all work and show in the log.
- [ ] Advance with the laptop's own keyboard: speaker and console follow within a second.
- [ ] Timer: starts on the first slide change; ±1 min, pause, reset from the console show on the speaker view.
- [ ] Laser: speaker turns on Laser and moves over the slide → dot follows on the output display, in the right place at the corners (check the 4:3 slide too). Dot disappears when the finger lifts.
- [ ] **Lock remote control** → speaker clicks are blocked (*locked*), operator Next still works. Unlock.
- [ ] Message: send a quick message → slim bar on the speaker view, buttons don't move. *Got it* → console shows *Seen*.
- [ ] Turn the speaker's Wi-Fi off for 20 s: speaker shows *Reconnecting…* and controls pause; back on → resumes without extra clicks.
- [ ] Quit the agent: within ~12 s speaker and console show *Show laptop offline*. Reopen → reconnects to the same session.
- [ ] Show control: `curl -X POST http://127.0.0.1:9001/api/next` moves the slide; from Companion, OSC `/next` on port 9000 does too.

## Windows + PowerPoint

- [ ] Works with PowerPoint 365 and with Presenter View on (presenter view on the laptop screen, slideshow on the projector).
- [ ] With the presenter view on the laptop, the laser dot draws on the **projector** output (change *Laser display* if not).
- [ ] A file from email opened in *Protected View* is not seen until **Enable Editing** — expected.
- [ ] End of show: after the last slide PowerPoint shows "End of slide show"; speaker Next is disabled, Back returns to the last slide.
- [ ] While slide images export (watch the agent), speaker clicks still respond quickly.

## macOS + PowerPoint for Mac

- [ ] First command asks to allow control of PowerPoint (Automation) → Allow.
- [ ] Next/Back work. Jump to slide and Blank need Accessibility; without it the agent shows the Accessibility notice.
- [ ] Notes appear after the deck is saved (they are read from the .pptx file).
- [ ] Slide images export once the slideshow is stopped (the agent says it waits while playing).

## macOS + Keynote

- [ ] First command asks to allow control of Keynote → Allow.
- [ ] Next/Back/Jump work; Blank toggles with B (needs Accessibility).
- [ ] Slide images and presenter notes export while not playing.

## Keystroke mode (Google Slides in a browser)

- [ ] Agent → Settings → Presentation app → *Keystrokes*. Set *Now on slide* = 1 and the slide count.
- [ ] Present the Google Slides deck in the browser and keep it in front. Speaker Next/Back move it; the speaker view says *Sent · slide n (estimated)*.
