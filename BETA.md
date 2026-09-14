# Trickplayer for G2 — beta 0.9.3

Watch an episode on your glasses as trick-play frames and subtitles. The
picture updates every few seconds while the dialogue keeps pace, so you follow
the story without a screen in front of you.

## Installing

**`trickplayer-0.9.3.ehpk`** — sideload through EvenHub.

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

## Fixed in 0.9.3

- **The logging session survives a relaunch.** It was being written to browser
  storage, which a packaged app discards — the same fault that used to lose
  your server — so a crash took the recording of the crash with it.
- **Logging stays on once you turn it on**, and starts before the app does
  anything, so the launch itself is inside the session. There is a **Stop
  logging** button for when you are done.
- **A session that recorded a freeze is no longer thrown away.** An outage is
  an *absence* of writes, and the rule for keeping a session only kept ones
  that had writes in them — so the quiet failures, which are the interesting
  ones, were discarded on the way back up.

## Fixed in 0.9.2

- **"Connect with logging" no longer ends the app.** It used to open a second
  page, and on the glasses opening a page is a navigation: the G2 offers to end
  the feature, the display containers go with it, and the picture never comes
  back even if you dismiss the prompt. The recorder now switches on where you
  are, without going anywhere. **Discard session** did the same thing for the
  same reason and no longer does.
- **A refused image write now says why.** The glasses answer with a reason
  every time and the app was throwing it away, so a report could only say
  "0 sent, 20 failed". It now names the reason and, when every image is refused
  instantly while text keeps landing, says outright that the container is gone
  rather than blaming the link.

## Fixed in 0.9.1

From the first round of beta feedback:

- **Your server is remembered.** A packaged app does not keep its own browser
  storage, which is why it asked for a fresh Plex code every launch. Sign-in is
  now held by the host and survives a relaunch.
- **The picture no longer freezes in silence.** Frames come off the network
  every few seconds; subtitles are parsed once and held in memory. So when the
  server became unreachable — a stale connection after a long sleep, a network
  change — the picture stopped and the dialogue carried on as if nothing was
  wrong, with nothing said. It now says so on screen and recovers on its own.
- **Link recovery works in both directions.** A dropped link can kill either
  channel and leave the other running; recovery previously only handled one of
  the two, and the beta hit the other one.

## If something goes wrong

Tap **Connect with logging** on the first screen. You only need to do this
once — it stays on across relaunches, and the session keeps accumulating, so a
crash or a disconnect is recorded rather than lost. **Stop logging** ends it. The recorder panel appears
above the app and everything keeps working — it does not leave the page, and it
does not disturb the glasses. Play as normal, then **Generate report** and
**Copy report**.

(In a browser, `/telemetry.html` does the same thing.)

Play as normal for five minutes — fifteen is better — then **Generate report**
and **Copy report**, and send it over. It captures write times, failures,
stalls and any gap where nothing was sent at all, and it says what it thinks
the cause was. No media, no credentials, no server addresses in it.

**Time the prepare path** on that page needs no glasses and no sign-in at all,
so it is worth a tap on any phone: it reports how long your device takes to
get a frame ready, which is the number that was four seconds.

**Saved state** on that page says whether this build will remember your server.
It should read "kept by the host". If it says "browser only", sign-in will not
survive a relaunch and that is worth reporting on its own.
