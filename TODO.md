# JamGuessr Todo List

## Bugs
- [ ] **DJ kit graphic too faint on game screens** — the graphic is fine on the home screen (create/join) but is still too faint on all other screens (lobby, picking, playing, reveal, final). Needs a higher opacity or stronger treatment in those views.

- [ ] **Favicon and home-screen icon look bad** — favicon renders with a white background and appears extremely faint; looks terrible when saved as a phone shortcut. Needs a proper solid-background favicon and an `apple-touch-icon` / PWA manifest icon with good contrast.

- [ ] **Remove lines above and below the turntables graphic** — decorative border lines flanking the DJ kit image should be removed.

- [ ] **Fix player video playback stopping** — non-host players' video stops while host keeps playing. `applyRoomPlayback` likely gets a new `version` every 3s (from host sync heartbeat), re-cuing mid-play. Need to diff video state before seeking/cuing.
  - _Partial fix landed_: same-video resumes now skip `cueVideoById` and go straight to `seekTo + playVideo`, which is more reliable. Heartbeat-driven `cueVideoById` interruptions are also eliminated for the same song. Per-song drifting (re-seeking every 3 s) is still a minor annoyance but no longer causes re-loads.

## Features
- [ ] **Round-end score celebrations** — make score updates faster and more exciting. Show a celebration emoji on the round winner and trigger a winner-only special event. Show a thumbs-down emoji on the round low score and trigger a low-score-only special event.

- [ ] **Dedicated playback device mode** — special "screen" join role: plays audio/video only, no guessing UI. Intended for TV/Chromecast in-person scenarios where players watch together but guess on their own phones.

- [ ] **Party mode** — no rounds, no scoring, just a shared collaborative song queue anyone can add to. Basically a jukebox mode alongside the existing Game mode.

- [ ] **Playlist export** — end-of-game option to download all played songs (title, artist, YouTube URL) as a file (CSV, TXT, or similar).
