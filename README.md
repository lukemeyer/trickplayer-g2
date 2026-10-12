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

### Subtitles, however your server has them
Separate subtitle files play straight away. A text track **inside the video file** can be extracted through your server the first time you play the item — on Plex, where the server won't hand it over directly — with a progress bar, an estimate of the time left, and a **Cancel** button. After that it loads instantly. And an item with **no subtitles at all** can get some: **Find subtitles** searches through your media server, lists what it finds by release name, and your server downloads the one you pick.

### Every episode, and what it needs
Each item in a list carries badges showing whether its subtitles are ready, need extracting, or are missing, and whether it has preview thumbnails — nothing is silently left out. Every item opens on its own page with its picture, season and episode, and description; one that can't play yet says why, and offers what will fix it.

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
Trickplayer talks to your media server and to nothing else. No account to create, no telemetry, no analytics, no third party. When you search for subtitles, it's your server that asks OpenSubtitles, not the app. Diagnostic logging is off until you switch it on, stays on your phone, and only ever leaves if you copy it and send it yourself.

---

## What you need

- A pair of **Even Realities G2** glasses and the Even Hub app.
- A **Plex or Jellyfin** server you can reach. Jellyfin support is experimental.
- Items with a **trick-play index**. Subtitles can be separate files, text tracks inside the video, or downloaded from the app. Trickplayer checks each item and shows you which will play, so you don't have to guess.

### Server setup

| | What to enable | Subtitles |
|---|---|---|
| **Plex** | *Generate video preview thumbnails* — Settings → Scheduled Tasks | External `.srt` files play at once. A text track inside the file can be extracted on first play (see below). **Find subtitles** uses Plex's own subtitle search. |
| **Jellyfin** | *Enable trickplay image extraction* — per library settings | Embedded text tracks and sidecars both work. **Find subtitles** needs a subtitle plugin, such as OpenSubtitles, set up on the server. |

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

Sign in, browse your full library, play, pause, seek, extract or download subtitles, and everything under Settings. **Back** ends playback and returns to the list where you left it.

---

## Settings

| Setting | What it changes |
|---|---|
| **Framerate** | How often a new image is sent. Fewer images means longer gaps between images but may be more reliable. |
| **Picture quality** | *Auto* steps between High, Standard and Low as the connection allows. Choosing *High*, *Standard* or *Low* holds it there. |
| **Glare** | How much of the top of the brightness range to give up. (depending on content the brightest level blows out the image) |
| **Contrast / Brightness / Gamma** | Standard tone controls, with a live preview. |
| **Skip silent scenes** | Drop stretches with no dialogue, so the episode moves faster. |
| **Report progress** | Write your position back to the media server. Off by default. |
| **Debugging tools** | Message logging and link capture, both off by default, plus two checks: whether the glasses accept pictures, and how fast this phone prepares them. |

---

## FAQ

<details>
<summary><b>Is this streaming video to my glasses?</b></summary>

No — and it can't be. The link carries a few kilobytes a second, and the display is monochrome green. Trickplayer sends one still every few seconds, using the preview thumbnails your server already generated. Think motion comic, not film.
</details>

<details>
<summary><b>Why does an item say it can't be played?</b></summary>

It is missing one of the two halves. Trickplayer needs preview thumbnails (a trick-play index) *and* text subtitles for the same item. Every episode is listed, and the badges say which half each one has:

| Badge | Meaning |
|---|---|
| **SUBS** in green | Subtitles ready. Plays straight away. |
| **SUBS** in amber | Subtitles are inside the video file. Its page offers **Extract** (read them out through your server, once) or **Download** (search for a subtitle file). After either, it's green. |
| ~~**SUBS**~~ in red | Plex lists a subtitle file that isn't on the server any more. Use **Find subtitles**, or refresh the item's metadata in Plex. |
| ~~**SUBS**~~ in grey | No text subtitles. Image-based ones (PGS, VobSub), styled ASS tracks and forced-only tracks don't count. Use **Find subtitles** to get some. |
| ~~**IMG**~~ in grey | No preview thumbnails yet. That one has to be fixed on the server — see [server setup](#server-setup). |
</details>

<details>
<summary><b>What's the difference between Extract and Download?</b></summary>

Plex won't hand over a subtitle track embedded inside a video file directly, only sidecar files sitting next to it. **Extract** asks your server's transcoder to read the track out, which means the server runs through the whole file once: a few seconds to a couple of minutes depending on the video and the server's hardware. The progress bar shows an estimate of the time left once it knows the pace, and **Cancel** stops the work on the server. Your phone downloads only the subtitles themselves (tens of kilobytes), and the result is kept, so playing the item again is instant. The subtitles are the file's own, so they're in sync with it.

**Download** searches for a subtitle file instead, through your media server, and is quicker for a long video or a slow server. The file comes from a third party, so its timing may differ from your copy — see below.

Extraction reads the track that is **selected** for the item in Plex; to change the language, pick the subtitle track in a Plex app first. Jellyfin serves embedded tracks on its own, so items there never need extracting.
</details>

<details>
<summary><b>Where do downloaded subtitles come from?</b></summary>

From your media server's own subtitle search — on Plex, the OpenSubtitles agent built into the server; on Jellyfin, a subtitle plugin. Trickplayer only asks the server to search and to download the one you pick: **the server** contacts OpenSubtitles, fetches the file and attaches it to the item, so it's then there for every app that plays from your server. The file never passes through your phone.

Results list the release each file was made for, and are ordered best first: files the search matched to your exact video, then plain subtitles before ones that describe sounds (SDH), then the most downloaded. A file whose name is for a different episode is marked and moved to the bottom, even when the search calls it a match — that happens. Pick the one whose release looks like your copy; if its timing is off, search again and pick another.
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

The display's top level reads much brighter than its position in the range suggests, which on a see-through display can cause eye strain. The **Glare** setting gives up the brightest levels to soften it. It is off by default; the first two steps cost roughly half a percent of the picture.
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
src/subtitles.ts    SRT and ASS parsing, and cleaning
src/cuelayout.ts    wrapping and paging cues onto the glasses (F-002)
src/plex*.ts        Plex sign-in, server discovery, library, embedded-subtitle
                    extraction, subtitle search
src/jellyfin*.ts    Jellyfin equivalents
src/logging.ts      the debugging tools panel
app.json            manifest and network permissions
tools/              the test suites above
```

### Display facts worth knowing

- 576×288, 4-bit greyscale — 16 shades of green.
- Images are sent at 256×144, letterboxed, the container's maximum height.
- Text lines are 27 px; the 432×132 subtitle area holds four. Lines are measured with the firmware's own font metrics (`@evenrealities/pretext`) and broken by the app.
- Image containers **cannot** capture events; a full-screen text container is used as the event layer.
- A list holds exactly 20 rows, and a menu 10 items with 32-byte labels.

---

## Credits

*Tears of Steel* — (CC) Blender Foundation, [mango.blender.org](https://mango.blender.org). Licensed under [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/). Every screenshot and the demo clip in this README show that film; see [`store_assets/README.md`](store_assets/README.md) for why it is the one film these repositories carry images of.

Trickplayer is not affiliated with Plex, Jellyfin, or Even Realities.
