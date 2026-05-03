# Native Handoff Reconnect and Fallback Handling

Date: 2026-05-03

## What was implemented

1. Native-mode reconnect recovery
- Added host-side recovery for native handoff when host ownership changes during playing.
- If phase is ambiguous during reconnect (`pending` or `launching`), host writes `ready` as safe fallback.
- Preserves explicit phases (`playing`, `paused`, `ended`) and does not overwrite them.

2. Embed-loop isolation in native mode
- Disabled host YouTube heartbeat sync loop in native mode.
- Disabled client playback guard loop in native mode.
- Disabled leader auto-start YouTube sync path in native mode.

## Why

- Prevent embed playback machinery from interfering with native handoff sessions.
- Ensure host disconnect/rejoin events produce recoverable, stable native phase state.
- Keep clients in a safe, non-crashing status path while host authority transitions.

## Key code references

- Native reconnect recovery: js/game-logic.js (maybeRecoverNativePlaybackAfterReconnect)
- Host sync loop guard: js/game-logic.js (updateHostPlaybackSyncLoop)
- Client guard loop guard: js/game-logic.js (updateClientPlaybackGuardLoop)
- Leader auto-start guard: js/game-logic.js (maybeStartPlaybackFromLeader)

## Behavior summary

- On host churn in native mode during playing:
  - Existing explicit phase is preserved when meaningful.
  - Ambiguous startup phases are normalized to `ready` for safe recovery.
- No embed sync pulses are emitted/processed during native mode.
