# Trickplayer for G2 — beta 0.9.20

Watch an episode on your glasses as trick-play frames and subtitles. The
picture updates every few seconds while the dialogue keeps pace, so you follow
the story without a screen in front of you.

## Installing

**`trickplayer-0.9.20.ehpk`** — sideload through EvenHub.

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

## Fixed in 0.9.20

- **Blank screens between scenes.** The recent list's labels include a resume
  time, which moves as you watch — and changing the labels rebuilt the whole
  glasses page, which empties the picture. That happened every 15 seconds for
  the entire session. Labels are still kept up to date; the page is only rebuilt
  when the list is actually on screen.
- **Quality dropping after a pause.** Your guess was almost exactly right: on
  resume, the first frame queues behind the catch-up frame that goes with it, so
  a ~2s picture took ~4.5s of wall clock and the app read that as a slow link.
  It now judges the send itself, and ignores the first frame after resuming or
  seeking entirely.
- **Two videos playing at once.** Picking from the recent list while something
  was playing started the new one without stopping the old. Preparing any item
  now stops whatever is running first.

## New in 0.9.19

- **A menu on the glasses.** Tap, then long press, to raise it:
  - **Play / Pause** — one entry that toggles, because menu labels cannot be
    changed while the page is up.
  - **Stop** — ends playback and returns to the recent list.
  - **Recently played** — the list, without stopping.
- **Using the menu no longer pauses playback.** Opening the menu hands the
  foreground to the overlay and back, and the app treated the "back" half as the
  phone leaving the app — so a menu selection would have paused the video, and
  choosing Play / Pause would have undone itself.

Worth checking: does raising the menu (the *tap* half of tap-then-long-press)
pause playback on its own? A tap is also the pause gesture. The report now marks
taps and menu items, so a session will show it.

## Fixed in 0.9.18

All from one session, and all introduced by 0.9.16/0.9.17:

- **The recent list covered the picture.** Starting a video from the phone left
  the list up on the glasses, with subtitles showing underneath it. Starting
  playback now takes the screen back.
- **Picking from the list started the wrong video.** Playing something moves it
  to the top of the list, but the picker on the glasses still showed the old
  order — so the first row was no longer what you were looking at. The picker
  now redraws when the list changes, and a tap is matched to the label that was
  on screen.
- **"Select video to begin" appeared under the picture** during quiet stretches,
  because that is the text container's default and it comes back every time the
  page is rebuilt.
- **Quality never recovered.** It only climbed back after sends faster than
  2.5s; on a link where every send took ~3.7s and nothing failed, the picture
  stayed coarse indefinitely. Any delivered frame now counts towards trying a
  better one, at the cost of an occasional probe.
- **The picture format never came back down.** After one bad patch it sent
  double-size frames for the rest of the session. It now retries the smaller
  format once frames are landing.

## Fixed in 0.9.17

- **Resume where you stopped.** Position is saved every 15 seconds while
  playing, and picking an item — from the glasses list or the phone — carries
  on from there. The phone list and the glasses list both show the resume point.
  Anything watched past 97% starts from the beginning instead.
- **"Loading [title]" on the glasses** the moment you pick something, rather
  than "Select video to begin" sitting there while the index loads.
- **Quiet stretches clear the subtitle line.** A scene with no dialogue used to
  leave the previous scene's line under an unrelated picture.

## New in 0.9.16

- **The glasses have an idle screen.** A thin frame where the picture will be,
  and "Select video to begin" — instead of "Sign in to Plex", which you usually
  are not being asked to do.
- **Recently played, on the glasses.** The last five items you played appear as
  a list at startup: scroll with the temple, tap to start. That means picking up
  where you left off without taking the phone out. They are on the phone's first
  screen too.
- **"Recently played" in the glasses menu** brings that list back during
  playback.
- **Browsing is faster.** Going into an episode and back out used to re-check
  every episode in the list. Answers are now kept for the session. (Not kept
  between launches on purpose — the reasoning is in the README.)

## Changed in 0.9.15

Reporting only. Your 2:32 session was clean — 159 pictures, all delivered, with
the phone asleep from a minute in — and the **picture levels worked for the
first time on hardware**: one send took 4.3s, it dropped a level, the next four
were fast, and it stepped back up to full. You didn't notice, which is the aim.

Three pieces of noise fixed, all in the report:

- **"PLAYBACK STOPPED at 5s and nothing says why"** — you were browsing, and
  nothing had played yet. It now requires playback to have actually been running.
- **"end of playback" recorded three times while browsing** — with no episode
  loaded, a zero-length one counts as finished.
- **"left the item" recorded five times while nothing was playing.**

## Fixed in 0.9.14

Your 1:47 session answered two things. **Locking the phone did not slow anything
this time** — 187 pictures, 100% delivered, ~1.9s each, for 11 minutes after you
locked at 1:49. And the freeze at 2:02 was a **pause**, not a stall.

- **A tap on the glasses pauses playback, and now says so on the glasses:**
  "Paused - tap to resume". Before, it just stopped changing the picture, which
  looks exactly like the freezes we have been chasing. If the glasses are on
  your face, a brush against the temple can do this.
- **Everything that can stop playback is now recorded** — glasses taps,
  double-taps, exits, leaving the item, end of episode. None of those were
  marked, which is why the report could only say "the app was idle".
- **Reports call out playback stopping for no visible reason** instead of
  writing it off as browsing.

## Changed in 0.9.13

From the 12:03 lock session. The picture levels switched as designed — the
low-res pictures you saw — but the link slowed far more than before: even the
smallest level took about 5 seconds and got through only half the time.

- **A fourth picture level, "minimal"** — very coarse (64x32), about a third the
  size of "lightest". It is also a test: if pictures this small are still slow,
  picture size isn't what limits a locked phone.
- **Much shorter pauses.** The app had paused pictures for 10, 20, 40, then 60
  seconds while half of them were still arriving — most of the 3½-minute freeze
  was those pauses. Now it only pauses once even the smallest pictures keep
  failing, and for at most 20 seconds.
- **No more display rebuilds for slow pictures** (there were eight). A rebuild
  only helps when the glasses refuse a picture instantly.
- **Reports show subtitle send times per minute.** If subtitles slow down with
  the pictures, the whole link slowed; if not, it is something about pictures.

Same test as before is ideal: play, lock the phone, leave it 10–15 minutes, and
note the times you pressed play and locked.

## Fixed in 0.9.12

From a session that ended with **"connection lost"** on the glasses:

- **Sweeps no longer set off picture recovery.** The locked sweep deliberately
  sends pictures too large to get through. Their failures were being handled
  like playback failures: the app tried to rebuild the glasses display three
  times mid-test (all refused) and paused pictures — and then video playback
  started already in that state, so its first failed frame went straight to a
  longer pause and another rebuild. Whether that load contributed to the
  connection dropping isn't known, but it shouldn't have been there.
- **The locked sweep waits 1.5s between test pictures** instead of sending them
  back to back.
- **Reports are more careful:** a sweep's failures aren't counted as "the
  picture stopped", lighter pictures aren't judged from fewer than five frames,
  and a session that gets cut off says so.

If "connection lost" happens again, a session with the phone plugged in over
USB would show what the Bluetooth link did in the seconds before.

## Changed in 0.9.11

Reporting only. The last session ran 10 minutes with every picture delivered —
but the lighter-picture switching from 0.9.10 never kicked in, because nothing
was slow, and a second locked sweep delivered every size quickly where the first
had large pictures timing out. So a locked phone does not always slow the link;
something else decides when it does.

- **Reports show picture sends minute by minute**, marking any slow or failing
  minute and the picture level used, so a slowdown is visible whatever caused it.

Still the most useful test: long playback with the phone locked, and a note of
roughly when you locked and unlocked it.

## Fixed in 0.9.10

**Pictures should keep coming with the phone locked.** The locked sweep
settled it: with the phone locked, small test pictures (up to ~8 KB) arrived in
about half a second, ~10 KB took nearly 4 seconds, and anything bigger mostly
failed after 8-9 seconds. So the glasses app still takes pictures while locked —
the Bluetooth link slows down and gives up on anything that takes too long. A
normal picture is 8-19 KB, right across that line; a subtitle is a few hundred
bytes, which is why subtitles never stopped.

- **When sending gets slow or fails, pictures get lighter** — first 4 shades of
  grey instead of 16 (about 40% of the size), then half resolution as well
  (about 15%). Expect the picture to look coarser while the phone is locked.
- **It climbs back to full pictures on its own** once sends are fast again,
  trying less and less often if the link is still slow, so a locked phone costs
  one frozen frame when it locks rather than one every few seconds.

Worth testing: play, lock the phone for several minutes with the glasses on,
then unlock. Pictures should keep changing throughout (coarser while locked),
and the report shows how each level did.

## Changed in 0.9.9

**Pictures stop when the phone locks; subtitles keep going.** The last session
narrowed it down: with the glasses worn and the phone locked, Trickplayer kept
running normally — every timer on time, no pauses, every subtitle delivered —
and each picture it handed to the Even Realities app came back failed after
8 to 14 seconds.

Even Hub's guidelines expect every image to load with the phone locked, so the
question is what is different about a picture. One explanation fits all of it:
the Bluetooth link slows down when the phone locks, a full picture no longer
finishes in time, and a one-line subtitle still does. If that is right, smaller
pictures while locked would fix it.

- **New in the logging build: "Sweep with the phone LOCKED".** Tap it, lock the
  phone within 20 seconds, keep the glasses on, and unlock after about five
  minutes. It sends test pictures from small to large and the report says
  which of three things happened: small ones land and large ones fail (the link
  slowed — fixable here), nothing lands (the glasses app stops taking pictures
  while locked), or everything lands (something else about playback).

## Changed in 0.9.8

Reporting only — nothing about playback changed. From the last session: the
glasses were worn the whole time but reported "not worn", and the phone was
asleep for most of it, which the app could not see at all.

- **Reports measure whether the phone was asleep**, from how late the app's
  own timers fire — the phone never tells the app directly.
- **Every pause and resume is listed**, for the whole session: when the glasses
  app says it lost the foreground, when the app paused because of it, and when
  you pressed play.
- **Reports no longer draw conclusions from the "worn" flag.**

Most useful next session: start playing, **let the phone sleep for several
minutes with the glasses on**, then wake it — and if the phone can be plugged
in over USB, I can watch the Bluetooth traffic live while it sleeps.

## Changed in 0.9.7

- **Rebuilding the display page does not fix a frozen picture.** On real
  glasses the page rebuild from 0.9.5 was accepted three times and pictures
  still failed, so that is not the cause.
- **When pictures keep failing, the app backs off** — pauses pictures for 10s,
  then 20s, 40s, up to a minute, trying one frame between each — instead of
  sending another every few seconds while each refusal takes the glasses five
  seconds or more. Subtitles continue. If pictures start landing again, the
  report records it.
- **Reports can now tell three things apart** that the last one could not: how
  long a failed picture send takes, whether failures happened with the glasses
  **on or off your head**, and what the app was waiting on during a silence.

Worth testing: a long session with the glasses **on the whole time**, then one
where you take them off for a few minutes and put them back on.

## Fixed in 0.9.6

- **Plex works away from home.** Plex gives every server several addresses —
  one on your home network, one on the internet, often a relay — and which one
  works depends on where your phone is. The app used to pick one when you
  signed in and keep it forever; signed in at home, that was the home-network
  address, which stops existing the moment you leave (a VPN put you back
  inside, which is why that worked). It now tries all of them at once, prefers
  home network, then internet, then relay, and tries again automatically
  whenever the address in use stops answering — including when you walk out of
  the house mid-episode. No need to sign in again.
- **If nothing answers, it says why.** In particular, if Plex only lists a
  home-network address for your server, that usually means **Remote Access** is
  off in the server's settings, and then no app can reach it from outside
  without a VPN.

## Fixed in 0.9.5

- **The picture now comes back when it stops but subtitles keep going.** After
  a long session the image path could wedge: every frame refused, text still
  fine. The app did try to repair it, but with a setup call the glasses only
  accept at launch — refused every time, so nothing ever changed. It now
  rebuilds the page the supported way, and in testing the picture resumes
  within a couple of failed frames.
- **No more silent downgrade to the slow picture path.** When frames failed,
  the app assumed the image format was to blame and switched formats — even
  when the current one had been working for ten minutes — and it *saved* that
  choice, which could have pinned your glasses to a path that takes seconds
  per frame. It now only tries another format if the current one has never
  worked, and never remembers the switch.
- **Reports lead with a dead picture.** A freeze that lasts to the end of the
  session used to be measured as 0 seconds. It is now measured in full, put at
  the top, and the report says what recovery was attempted.

If the picture dies and does **not** come back on 0.9.5, that is exactly the
report worth sending: it will say whether the rebuild was accepted and frames
still failed, which is a different problem from the one fixed here.

## Fixed in 0.9.4

- **The picture should come back.** The glasses accepted every synthetic
  payload the sweep sent — 0, 4, 12, 28 and 44 KB — and refused every real
  frame at 16 KB. Same container, same link, sizes either side of it: the only
  difference was how the frame is encoded. The app now tries a second and a
  third encoding when frames keep failing, and remembers whichever one works.
- **New: "Which image formats work?"** on the logging panel. It sends one
  picture encoded three ways and reports which the glasses accept. Twenty
  seconds, and it settles the question rather than inferring it. **Please run
  this one first** — it tells us in one line what took a whole session to
  narrow down.
- **The sweep refuses to run during playback.** It is a minute of writes on a
  serial link, and started mid-episode it queues in front of everything the
  player wants to send. That is why subtitles took a minute to appear.

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
