# JamGuessr Todo List

## Bugs
- [ ] **Fix player video playback stopping** — non-host players' video stops while host keeps playing. `applyRoomPlayback` likely gets a new `version` every 3s (from host sync heartbeat), re-cuing mid-play. Need to diff video state before seeking/cuing.

## Features
- [ ] **Dedicated playback device mode** — special "screen" join role: plays audio/video only, no guessing UI. Intended for TV/Chromecast in-person scenarios where players watch together but guess on their own phones.

- [ ] **Party mode** — no rounds, no scoring, just a shared collaborative song queue anyone can add to. Basically a jukebox mode alongside the existing Game mode.

- [ ] **Playlist export** — end-of-game option to download all played songs (title, artist, YouTube URL) as a file (CSV, TXT, or similar).
