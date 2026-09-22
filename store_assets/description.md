Trickplayer takes the preview thumbnails and subtitles from your Plex or Jellyfin server and streams them to your glasses. You get an image every few seconds and subtitles in real-time.

YOUR OWN SERVER
Connects to Plex or Jellyfin running on hardware you own. Sign in once on the phone and it remembers.

---
NOTICE: Jellyfin support is experimental, it seems to work on local connections, but since there is no first-party remote access domain (like Plex's "plex.direct" domain) I can't set up permissions for it. 
---

BROWSE FROM GLASSES OR PHONE
Use your phone to log in and browse your full Library or access your playlists and recents from the glasses directly.

PICKS UP WHERE YOU LEFT OFF
Uses the "continue watching" timestamps from your media server and can (optionally) report back as you watch on your glasses.

ADAPTIVE IMAGE QUALITY
Streaming over bluetooth can be unreliable, image quality will automatically reduce to keep the stream going, then try to recover if the link improves.

PRIVACY
Trickplayer talks to your media server and to nothing else. Authentication is handled by PIN on Plex and Quick Connect on Jellyfin. No new account, no telemetry, no analytics, no third party. Diagnostic logging is off until you switch it on, stays on your phone, and is only ever shared if you copy it and send it yourself.

WHAT YOU NEED
A Plex or Jellyfin server you can reach, and items that have a trick-play index and subtitles. The app checks each one and shows you which will play.

---
PLEX: You need to turn on "Generate video preview thumbnails" in scheduled tasks AND make sure you have subtitles downloaded for your media. Plex ONLY supports EXTERNAL subtitle files (srt), not embeded via their API.
JELLYFIN: You need to enable "Enable trickplay image extraction" in your library settings. 
---

Screenshots show Tears of Steel — (CC) Blender Foundation, mango.blender.org