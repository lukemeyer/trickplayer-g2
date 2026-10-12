Trickplayer takes the preview thumbnails and subtitles from your Plex or Jellyfin server and streams them to your glasses. You get an image every few seconds and subtitles in real-time.

YOUR OWN SERVER
Connects to Plex or Jellyfin running on your hardware, secure sign-in using a one-time PIN.

---
NOTICE: Jellyfin support is experimental, there is no first-party remote access domain (like Plex's "plex.direct"), Tailscale *.ts.net should work. 
---

BROWSE FROM GLASSES OR PHONE
Use your phone to log in and browse your full Library or access your playlists and recents from the glasses directly.

PICKS UP WHERE YOU LEFT OFF
Uses the "continue watching" timestamps from your media server and can (optionally) report back as you watch on your glasses.

ADAPTIVE IMAGE QUALITY
Streaming over bluetooth can be unreliable, image quality will automatically reduce to keep the stream going, then try to recover if the link improves.

PRIVACY
Trickplayer talks to your media server and to nothing else, even subtitle search is handled by your server. Authentication is handled by PIN on Plex and Quick Connect on Jellyfin. No new account, no telemetry, no analytics, no third party. Diagnostic logging is off until you switch it on, stays on your phone, and is only ever shared if you copy it and send it yourself.

WHAT YOU NEED
A Plex or Jellyfin server you can reach, and items that have a trick-play index. Subtitles can be separate files, text tracks inside the video, or downloaded from the app. The app checks each item and shows you which will play.

---
PLEX: Turn on "Generate video preview thumbnails" in scheduled tasks. 
JELLYFIN: Enable "Enable trickplay image extraction" in your library settings. Defaults to 10s, but can be lowered via system.xml. Subtitle search needs a subtitle plugin set up on your server.
---

Go to https://trickplayer.elsethenif.com/ for more information and tips.

Screenshots show Tears of Steel — (CC) Blender Foundation, mango.blender.org