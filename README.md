# Trickplayer

**Watch your own media on Even Realities G2 glasses — as a still frame every few seconds, with the subtitles in sync.**

Trickplayer takes the preview thumbnails and subtitle track your Plex or Jellyfin server already generates and streams them to your glasses. You get the picture of what's happening and the dialogue as it's spoken, on a display you can see through, from a server you own.

| Screenshots | |
|---|---|
| ![A trick-play frame on the glasses with two lines of subtitle beneath it](store_assets/glasses_scene_1.png) | ![A second scene on the glasses display](store_assets/glasses_scene_2.png) |

| Video (simulator) |
| :---: |
| <video width="572" height="284" src="https://github.com/user-attachments/assets/55b9374e-d3db-4d82-8c0c-5b47f2c63f0e"></video> |

> Screenshots and clip show *Tears of Steel* — (CC) Blender Foundation, [mango.blender.org](https://mango.blender.org), used under CC BY 3.0.

---

## What it actually is

It is **not** video. The G2 display is 576×288 and monochrome green, and the Bluetooth link to it carries a few kilobytes a second — nowhere near enough for moving pictures.

What it *is*: your media server already builds a **trick-play index** for every item — the strip of thumbnails you scrub through in the web player. Trickplayer fetches those thumbnails and the subtitle track, then shows you one frame at a time alongside the lines spoken during it.

---

## How it works

A **scene** is one frame plus every subtitle cue that starts during it. Scenes tile the episode end to end, so a line straddling a boundary is shown once, in the scene it begins in — never twice.

Three things make it watchable given how slow the link is:

- **The next frame is fetched while you're still reading the current one.** By the time a scene ends, its replacement is usually already on the glasses.
- **Quality adapts to the link.** If sends start failing or dragging, the picture drops to a cheaper form automatically, then climbs back when the link recovers. You get a coarser image rather than a stalled one.

---

## Features

### Your own server, and nothing else
Connects to Plex or Jellyfin running on hardware you control. Sign in once on the phone and it remembers.

### Browse from the glasses or the phone
Your phone handles sign-in and full library browsing. The glasses carry the shortcuts — **Recently played**, **Continue watching**, and **Playlists** — so once something is set up you never have to take the phone out.

<p align="center">
  <img src="store_assets/glasses_select.png" alt="The glasses picker showing Recently played, Continue watching and Playlists" width="420">
</p>

### Picks up where you left off
Reads the resume position from your media server, and can optionally report back as you watch so your other clients stay in step. Reporting is **off** until you turn it on — it writes to your server.

### Adaptive picture quality
Bluetooth to glasses is unreliable by nature. Rather than stalling, the picture steps down through progressively cheaper forms and climbs back when the link improves. You can also pin it by hand if you'd rather have consistency than adaptation.

### Tuned for a see-through display
Contrast, brightness and gamma, plus a **Glare** control that gives up the brightest levels.

### Private by construction
Trickplayer talks to your media server and to nothing else. No account to create, no telemetry, no analytics, no third party. Diagnostic logging is off until you switch it on, stays on your phone, and only ever leaves if you copy it and send it yourself.

---

## What you need

- A pair of **Even Realities G2** glasses and the Even Hub app.
- A **Plex or Jellyfin** server you can reach. Jellyfin support is experimental.
- Items that have **both** a trick-play index **and** subtitles. Trickplayer checks each one and shows you which will play, so you don't have to guess.

### Server setup

| | What to enable | Subtitles |
|---|---|---|
| **Plex** | *Generate video preview thumbnails* — Settings → Scheduled Tasks | **External `.srt` files only.** Plex's API does not expose embedded subtitle tracks, so sidecar files are required. |
| **Jellyfin** | *Enable trickplay image extraction* — per library settings | Embedded tracks work, as well as sidecars. |

---

## Controls

### On the glasses

| Gesture | What it does |
|---|---|
| Swipe up / down | Move through a list |
| Tap | Choose the highlighted row |
| Tap, then long press | Open the contextual menu |
| Double tap | Exit the app |

The contextual menu holds **Play / Pause**, **Play from start**, and **Return to list**.


### On the phone

Sign in, browse your full library, play, pause, seek, and everything under Settings.

---

## Settings

| Setting | What it changes |
|---|---|
| **Framerate** | How often a new image is sent. Fewer images means longer gaps between images but may be more reliable. |
| **Picture quality** | *Auto* adjusts based on connection quality. *Quality* and *Speed* pin it. |
| **Glare** | How much of the top of the brightness range to give up. (depending on content the brightest level blows out the image) |
| **Contrast / Brightness / Gamma** | Standard tone controls, with a live preview. |
| **Skip silent scenes** | Drop stretches with no dialogue, so the episode moves faster. |
| **Report progress** | Write your position back to the media server. Off by default. |
| **Debugging tools** | Message logging and link capture, both off by default. |

---

## FAQ

<details>
<summary><b>Is this streaming video to my glasses?</b></summary>

No — and it can't be. The link carries a few kilobytes a second, and the display is monochrome green. Trickplayer sends one still every few seconds, using the preview thumbnails your server already generated. Think motion comic, not film.
</details>

<details>
<summary><b>Why does an item say it can't be played?</b></summary>

It is missing one of the two halves. Trickplayer needs a trick-play index *and* subtitles for the same item. The list tells you which items have both, so nothing fails halfway through. See [server setup](#server-setup) for what to enable.
</details>

<details>
<summary><b>Why does Plex need external subtitle files?</b></summary>

Plex's API doesn't expose subtitles embedded inside a video file — only sidecar files sitting next to it. That's a Plex limitation rather than a Trickplayer one. Jellyfin does serve embedded tracks, so it works either way there.
</details>

<details>
<summary><b>What's the catch with Jellyfin?</b></summary>

Remote access. Glasses apps declare in advance which domains they may reach, and Plex has a first-party one (`plex.direct`) that covers every user's server. Jellyfin has no equivalent, so there is no single domain to declare.

Local connections work. For remote access, Trickplayer also permits `*.ts.net`, so a [Tailscale](https://tailscale.com) network will reach your server from anywhere. Anything else is currently out of reach.
</details>

<details>
<summary><b>The picture got blocky mid-episode. Is something broken?</b></summary>

No — that's the quality ladder doing its job. When sends slow down or fail, the picture steps down to something cheaper so frames keep arriving rather than stopping, then climbs back on its own once the link recovers. Locking your phone is the most common cause: it slows Bluetooth enough to push full-size frames past the host's deadline.
</details>

<details>
<summary><b>Does it send my viewing data anywhere?</b></summary>

No. It talks to your media server and nothing else. There is no account, no telemetry and no analytics. If you turn on *Report progress*, positions are written to **your** server — the same thing any other client does — and nowhere else.
</details>

<details>
<summary><b>Why is the brightest part of the picture uncomfortable?</b></summary>

The display's top level reads much brighter than its position in the range suggests, which on a see-through display can cause eye strain. The **Glare** setting gives up the brightest levels to soften it. It is on by default, at a cost of roughly half a percent of the picture.
</details>

<details>
<summary><b>Can I watch anything, or just TV?</b></summary>

Anything with thumbnails and subtitles — films, episodes, whatever is in a playlist. Subtitle-led material fares best, since the dialogue drives the pacing.
</details>

---

## For developers

### Run it

```bash
npm install
npm run dev          # vite, bound to the LAN so a phone can load it
npm run simulate     # desktop glasses simulator
```

To load a dev build on real glasses, point the Even Hub app at `http://<your-ip>:5173`. To package a release:

```bash
npx evenhub pack app.json dist -o trickplayer-X.Y.Z.ehpk
```

> The SDK is pinned to `0.0.14`. Later versions changed bridge behaviour that the foreground/background handling depends on.

### Tests

Everything runs headless, without glasses:

```bash
npm run conformance      # the shared findings ledger, asserted against this code
npm run quality-check    # the picture ladder
npm run telemetry-check  # report generation and redaction
npm run ble-sim          # the send queue under a lossy link
npm run png-check        # the PNG encoder
npm run route-check      # server discovery and route racing
npm run store-check      # every persisted key is actually hydrated
npm run redaction-check  # nothing identifying reaches a report
npm run pixel-bench      # the pixel pipeline, timed and pinned byte-for-byte
```

### Layout

```
index.html          webview host, zoom-locked viewport
src/main.ts         the engine: BLE queue, scene pipeline, image path, glasses UI
src/ui.ts           the phone panels, and the engine's UI hooks
src/quality.ts      the picture ladder
src/pixels.ts       greyscale, tone, dither, block expansion
src/png.ts          4-bit greyscale PNG encoder
src/timeline.ts     trick-play index parsing
src/subtitles.ts    SRT parsing and cleaning
src/plex*.ts        Plex sign-in, server discovery, library
src/jellyfin*.ts    Jellyfin equivalents
src/logging.ts      the debugging tools panel
app.json            manifest and network permissions
tools/              the test suites above
```

### Display facts worth knowing

- 576×288, 4-bit greyscale — 16 shades of green.
- Images are sent at 256×128, inside the 288×144 container maximum.
- Image containers **cannot** capture events; a full-screen text container is used as the event layer.
- A list holds exactly 20 rows, and a menu 10 items with 32-byte labels.

---

## Credits

*Tears of Steel* — (CC) Blender Foundation, [mango.blender.org](https://mango.blender.org). Licensed under [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/). Every screenshot and the demo clip in this README show that film; see [`store_assets/README.md`](store_assets/README.md) for why it is the one film these repositories carry images of.

Trickplayer is not affiliated with Plex, Jellyfin, or Even Realities.
