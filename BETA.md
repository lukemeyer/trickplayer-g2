# Trickplayer for G2 — beta 0.9.0

Watch an episode on your glasses as trick-play frames and subtitles. The
picture updates every few seconds while the dialogue keeps pace, so you follow
the story without a screen in front of you.

## Installing

**`trickplayer-0.9.0.ehpk`** — sideload through EvenHub.

Or open it in a browser with the glasses paired:
**https://lukemeyer.github.io/trickplayer-g2/**

The browser build is the same code and is the easier one to re-test after a
fix, since it updates the moment a change lands on `main`.

## What to expect

Sign in to Plex with a four-character code — it appears on screen and you type
it at **plex.tv/link** on any other device. No password ever reaches the
glasses.

Pick an episode and it plays continuously: a frame, then its subtitles, then
the next frame. Frames are paced off the *measured* speed of your Bluetooth
link rather than a fixed timer, so a slow link gets fewer, longer scenes
instead of a backlog.

An item only appears in the list if it has **both** a trick-play index and a
subtitle track Plex will serve separately. Most embedded subtitle tracks cannot
be fetched on their own, so a library can look emptier here than it does in
Plex. That is the filter working, not a bug.

## Known: Jellyfin does not work in this build

The Jellyfin button appears and will fail to connect.

Packaged apps declare which hosts they may reach, and a Jellyfin server is
wherever you host it — no such list can name it in advance. This beta is
Plex-only. Jellyfin works in the browser build above, which has no such
restriction.

## What changed, and what is worth hammering

This beta is the end of a Bluetooth rebuild, so the transport is where the new
risk is. Three fixes came out of real sessions on real glasses:

- **A dropped link used to kill subtitles for the rest of the session** while
  images carried on as if nothing happened. The two travel differently, and a
  busy link and a broken one look identical from the app's side. It now
  notices the asymmetry and repairs itself.
- **The pipeline froze when the phone slept** and stayed frozen after it woke.
- **Preparing a frame took four seconds on a Pixel 10** — an encode handed off
  to the phone and waited on. Now about 50x faster.

The first two are the ones worth trying to break:

1. Start playback, **lock the phone**, wait a few minutes, wake it. Playback
   should still be running, and should catch up rather than resume where it
   stopped.
2. **Walk out of range** and come back. Both the picture *and* the subtitles
   should return. Subtitles returning late, or not at all, is the interesting
   failure.
3. Leave it running for **fifteen minutes** and see whether it drifts.

## If something goes wrong

There is a second page that records every Bluetooth operation and writes a
report:

**https://lukemeyer.github.io/trickplayer-g2/telemetry.html**

Play as normal for five minutes — fifteen is better — then **Generate report**
and **Copy report**, and send it over. It captures write times, failures,
stalls and any gap where nothing was sent at all, and it says what it thinks
the cause was. No media, no credentials, no server addresses in it.

**Time the prepare path** on that page needs no glasses and no sign-in at all,
so it is worth a tap on any phone: it reports how long your device takes to
get a frame ready, which is the number that was four seconds.
