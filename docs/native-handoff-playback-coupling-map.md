# Native Handoff Discovery: Playback Coupling Map

Date: 2026-05-03
Scope: Inventory where playback state is authored, synchronized, consumed, and surfaced so native handoff can reuse existing timing/scoring flow.

## 1) Core data model and ownership

Current room playback-related fields (already in use):
- `status` (room phase: lobby/picking/playing/scoring/reveal/finalizing/finished)
- `currentRound`, `currentSongIndex`, `allSongsPlayed`
- `playback` (videoId, round, songIndex, status, pausedAtSec, startAtMs, version)
- `playbackLeaderPlayerId`
- `playbackConfig` (autoplayEnabled, adPacingMode)

Playback leader resolution and updates:
- Leader selection helper: js/api.js:18
- Leader seeded on room create: js/api.js:59
- Leader reset on start playing: js/api.js:199
- Leader recomputed after role change: js/api.js:385
- Leader recomputed on leave/host changes: js/api.js:533, js/api.js:590

## 2) Write paths (authoritative state changes)

Room lifecycle writes:
- Create defaults: js/api.js:28
- Start game/picking: js/api.js:195
- Start playing (sets playback null, leader, config): js/api.js:199
- Reveal and round progression: js/api.js:219, js/api.js:287
- Song advance (resets playback): js/api.js:429
- Mark all songs played: js/api.js:477
- Reset game (clears playback and reapplies config defaults): js/api.js:481

Playback synchronization writes:
- Firestore playback publish (leader-gated): js/api.js:438
- Host heartbeat/state broadcast from YT player: js/game-logic.js:925
- Initial sync/reinforcement on song start: js/game-logic.js:1402
- Song-to-song advance orchestration: js/game-logic.js:1460

## 3) Read/consume paths (client behavior)

Room subscription and dispatch:
- Snapshot listener entry: js/game-logic.js:285
- Central room router: js/game-logic.js:1497
- View routing by room status: js/game-logic.js:19, js/game-logic.js:55

Playback consumption:
- Playback leader lookup and fallback to host: js/game-logic.js:819
- Leader auto-start if current song not synced: js/game-logic.js:1468
- Client playback guard/correction loop: js/game-logic.js:1045, js/game-logic.js:1126
- Host onStateChange -> immediate broadcast: js/game-logic.js:1148
- Apply playback payload to local player: js/game-logic.js:1186
- Playing renderer decides whether to apply playback locally: js/game-logic.js:2178
- Banner gates on "playback started" check: js/game-logic.js:2170, js/game-logic.js:2227

## 4) Role and UI coupling (must remain intact)

Screen role and playback routing:
- Screen role in lobby and host role toggle wiring: js/ui.js:3, js/ui.js:11, js/ui.js:142
- Playback render gating for screen-mode topology: js/game-logic.js:833, js/game-logic.js:838, js/game-logic.js:845

Important existing invariant:
- Guessing/scoring logic is role-gated and independent from playback transport.
- Native handoff should replace playback transport/control only, not scoring/reveal state transitions.

## 5) What this means for native handoff

Low-risk insertion points:
1. Add `playbackMode` and `playbackState` to room defaults in create/reset/start-playing code paths.
2. Keep `playback` object as compatibility payload for timer/phase UI until native parity is confirmed.
3. Branch inside playing renderer so `embed` keeps current YT pipeline and `native_handoff` reads `playbackState` instead of local iframe control.
4. Reuse leader gating and role gating exactly as-is.

## 6) Proposed first implementation slice (next task)

- Add mode/state defaults:
  - `playbackMode: "embed"`
  - `playbackState: { phase: "pending", updatedAt: nowMs(), source: null }`
- Add read guards in room update/render paths:
  - Missing `playbackMode` => treat as `embed`
  - Missing `playbackState` => synthesize pending state in memory
- Do not modify scoring, reveal, or round transition code in this slice.

## 7) Risks to watch immediately

- Hidden assumptions that `room.playback` always exists during `playing`.
- Race between leader auto-start and UI branching when mode is changed mid-round.
- Screen-role clients depending on iframe lifecycle side effects (fullscreen/unmute prompts).

## 8) Exit criteria for discovery task

- Playback write/read touchpoints identified.
- Role and scoring invariants documented.
- Safe first coding slice and migration guards defined.
