# Trickplayer (Even Realities G2)

Shows a frame from a Plex trick-play track plus the subtitles from that moment
on a pair of G2 glasses, advancing through an episode in step with the dialogue.

The **first** of three implementations of this idea. The two watch faces —
[`trickplayer-pebble`](../trickplayer-pebble) (Pebble Time 2) and
[`trickplayer-wearos`](../trickplayer-wearos) (Wear OS) — are ports of what
was worked out here. Shared rules and findings live in
[`trickplayer-knowledge`](../trickplayer-knowledge); see [KNOWLEDGE.md](KNOWLEDGE.md).

## What it actually is

A webview app running under the Even Hub SDK. It signs in to Plex, browses to an
episode, downloads that episode's trick-play index and subtitle sidecar, and then
drives the glasses on a timer: one still frame plus the lines belonging to it,
then the next.

Unlike the two watch faces, this is a **player** — it advances on a clock, not on
a glance. Single tap pauses and resumes; double tap exits. Whether that
difference should stay is an open question in the shared plan.

## Status

Working end to end against a real Plex server: sign-in, browse, eligibility
filtering, playback with synced subtitles, and recovery from a backgrounded or
suspended webview. Deployed to GitHub Pages by Actions on push to `main`.

Known debt, all tracked in `trickplayer-knowledge/PLAN.md` §3:

- The trick-play index parser hardcodes a `1000 ms` timestamp multiplier instead
  of reading the header field, and takes the last frame's length from the file
  size rather than the sentinel entry.
- The whole index file is downloaded — 9.5 MB for a 24-minute episode — and a
  `Blob` and object URL are created per frame and never revoked. The other two
  platforms range-fetch individual frames against a ~6 KB index.
- Subtitle cleaning does not strip HTML tags or ASS override blocks, so real
  Plex sidecars show `<i>` and `{\an8}` on the glasses.
- Eligibility is checked in bulk, batches of 20, up front. Lazy per-item checking
  is both faster to first result and cheaper.
- `src/image/renderer.ts`, `public/sample.png`, `public/assets/`, `old_index.html`,
  `test.ehpk`, `extract.cjs` and `make_assets.cjs` are leftovers from the template
  this repo was forked from and are referenced by nothing.

## Layout

```
index.html            webview host, zoom-locked viewport
src/main.ts           everything else — 2,500 lines, see below
src/timeline.ts       frame timeline — trick-play index parsing
src/subtitles.ts      SRT parsing
app.json              manifest; network permission whitelisted to *.plex.direct
.github/workflows/    Pages deploy
```

`main.ts` is a single file holding sign-in, server discovery, browsing,
eligibility scanning, the image pipeline, the BLE send queue, the scene pipeline
and the debug panel. Splitting it is a precondition for testing any of it
headlessly, which is why the shared conformance corpus needs `timeline.ts` separated
from its browser Blob layer first.

## Run

```bash
npm install
npm run dev
```

Then `npm run simulate` for the desktop simulator, or
`npx evenhub qr --url http://<your-ip>:5173` to load it on real glasses.

The SDK is pinned to `0.0.14` — later versions changed bridge behaviour that the
foreground/background handling depends on.

## How playback works

A **scene** is one frame plus every subtitle cue in its window. (This build
called it a *chunk* until the vocabulary was standardized across the three
platforms — see KNOWLEDGE.md.)

Scenes tile the episode, and a cue is owned by the scene it **starts** in, so a
line straddling a boundary is not shown twice.

Two things make it watchable given how slow the link is:

- **The next scene's image is prefetched** while the current scene's subtitles
  are still being read out, so the frame is usually ready before it is needed.
- **Pacing adapts.** A moving average of the last few render durations, clamped
  to 1–8 s, decides how long a scene gets. A transfer that takes four seconds on
  a bad link stretches the scene rather than desyncing it.

Consecutive cues are merged into multi-line blocks that fit the subtitle
container, so there is more to read while the next image transfers. Cues more
than 4 s apart are not merged — that gap is a real silence and merging across it
reads wrong.

## The link is the constraint

Everything above exists because BLE image transfer to the G2 is slow (~0.5–2 s
for ~20 KB) and intermittently fails.

- **All BLE writes are serialised** through one promise chain. `updateImageRawData`
  calls must not overlap; overlapping them wedges the channel.
- **A failed image send is retried** up to 3 times with a 350 ms backoff, under a
  5 s total budget. The budget matters more than the retry count: without it one
  bad frame starves the subtitle channel behind it in the queue.
- **Images are sent at 256×128**, below the 288×144 container maximum. Fewer bytes
  transfer faster and fail less. Lower it further to trade size for reliability.
- **Link state is recorded on every send** — connection type, battery, wearing
  state, queue depth, consecutive failure count. That is what distinguishes
  transient saturation from a real disconnect, which otherwise look identical.

## G2 specifics

- Display: 576×288, 4-bit greyscale — 16 shades of green.
- Image containers: 20–288 wide, 20–144 tall, 4 per page maximum.
- The image sits centred at the top; the subtitle container is 432×132 at
  y=156, filling the space below it.
- **Image containers cannot capture events.** A full-screen text container is
  used as the event layer.
- Photos and gradients need preprocessing. The app converts to luminance, applies
  brightness/contrast/gamma, and dithers — Floyd–Steinberg by default, with
  Atkinson and plain threshold as alternatives — before packing to 4-bit. The SDK
  returns `imageToGray4Failed` when its own conversion chokes, which is the signal
  that preprocessing is not optional.

## Staying alive in the background

A backgrounded webview gets its timers throttled or suspended, which kills the
pipeline mid-episode. Two mitigations, both needed:

- **A looping silent audio element** while playing, which keeps the webview from
  being suspended when the phone screen locks.
- **Explicit foreground-exit and foreground-enter handling**, which pauses the
  pipeline and resumes it rather than letting it run against a dead link and
  burn through its retry budgets.

## Sign-in

Plex PIN flow: mint a PIN, show the code, poll until it is authorised, then list
servers and let the user pick a server and a connection.

Two things the watch ports improved on and this build has not adopted: the
routes are a manual dropdown here (local / remote / relay) rather than raced
automatically, and the PIN is not persisted across a reload. Both are in
PLAN.md §3.

## Eligibility is stricter than it looks

An item is only usable if it has **both** an `sd` trick-play index and a subtitle
stream with a **non-null `key`**. Most SRT streams Plex reports are embedded in
the media file and cannot be fetched separately; only sidecars can.

That filter is a Plex limitation rather than a rule about media, which matters
for the roadmap: Jellyfin converts and serves embedded subtitles on demand, so
the same filter there would hide most of a library.

## Measuring the link

`telemetry.html` is a **separate entry point**, not a flag on the player.
Recording every BLE operation costs something, and a wearer who is just
watching an episode should not pay it. It does not duplicate the app's markup
either — it fetches `index.html` at runtime and injects the body, so there is
one copy of the flow and the two cannot drift.

Play something for five minutes, then **Generate report**. Fifteen minutes
gives better tail estimates. The report goes to the clipboard and to the
console, because a phone in a pocket has neither a clipboard the wearer can
reach nor a console — `adb logcat`, or the simulator's `/api/console`.

Three buttons do work of their own:

| | |
|---|---|
| **Sweep payload sizes** | Sends synthetic payloads from ~0 to ~44 KB. Real frames all cluster around 15 KB, so a normal session has almost no range to fit a regression against; the sweep gives the analysis its spread in about a minute. |
| **Time the prepare path** | Runs decode → pixels → encode on frames it generates itself. **Needs no glasses and no account**, so it also runs in the simulator. |
| **Discard session** | The session survives reloads on purpose; this is how you start a clean one. |

Query flags drive the same things from a harness, since neither the EvenHub
simulator nor a phone on a desk has a pointer into the WebView:

    ?play=1      start the first playable item and leave it running
    ?probe=1     sweep on load, print the report at 90s
    ?prep=1      time the prepare path, print the phase split
    ?stuck=1     inject the host pause that froze a real session
    ?notext=1    inject the container loss that killed text but not images

The last two are reproductions of reported failures. Neither can be induced
any other way — you cannot make a host suspend you on demand, and you cannot
unplug a container.

### What the report will tell you

```
    image write  n=211  p50 3ms  p90 6ms
    fetch        n=148  p50 4ms  p90 10ms  8% already cached
    prepare      n=148  p50 5ms  p90 9ms
      decode     n=169  p50 1ms  p90 2ms
      pixels     n=169  p50 2ms  p90 3ms
      encode     n=169  p50 1ms  p90 2ms
    write alone  n=208  p50 3ms
    write busy   n=3    p50 2ms  (1% of writes)
      under prepare  n=3  p50 2ms
```

Everything in it is split by **which fix it would imply**, which is the one
design rule here. `prepare` was a single number for a while, hit 4 seconds on
real hardware, and could only produce the advice "chase it" — a decode, a pixel
loop and a PNG encode have three different remedies and one number cannot
choose between them (F-046). The same applies to contention: a fetch under a
write and a decode under a write are opposite problems, because the decode can
wait and the prefetch is the only thing hiding the network.

`tools/pixel-bench.mjs` pins the middle phase off-device at ~0.5 ms, so a phone
reporting milliseconds there is fine and a phone reporting seconds is being
interrupted, not computing slowly.

### The suites

    npm run ble-sim           the transport against a simulated link
    npm run telemetry-check   plant a defect, require the report to find it
    npm run conformance       the shared corpus
    node tools/pixel-bench.mjs

`telemetry-check` is the unusual one: every case plants a known fault and fails
if the report does not name it *and* prescribe the remedy that belongs to it.
An analysis that cannot be wrong is not measuring anything.

## What is not in this repo

No frames, stills or screenshots of real media — they are stills from a TV
episode and are development artefacts rather than anything needed to build.
