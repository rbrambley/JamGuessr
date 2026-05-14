# Native Handoff QA Matrix

Date created: 2026-05-03
Purpose: Manual QA checklist for host/player/screen across `embed` and `native_handoff` modes.

## How to Use

- Run one full game cycle per section: lobby -> song pick -> play -> guess -> reveal -> next round/end.
- Mark each row Pass or Fail.
- Add notes for failures (device, browser, step, error text).

## Pass 1

### Embed Mode

| Test | Steps | Expected | Pass | Notes |
|---|---|---|---|---|
| Lobby join (host + player) | Create room, invite player, both join lobby | Both visible in lobby, no permission errors | [x] | 2026-05-14: Verified host + bot players visible in lobby. |
| Screen role assignment | Add third client, set role to Screen | Screen role shown and persisted | [x] | 2026-05-14: Toggled one player to Screen; lobby showed `2 players ready (+1 screen)` and role pill persisted. |
| Start after submissions | All submit one song, host starts | No validation crash, game enters playing | [x] | 2026-05-14: Embed mode started and entered `playing` (`Song 1 of 2`) without `currentRound`/validation errors. |
| Player guess flow | Player submits guesses during round | Guesses persist, reveal gating works | [x] | 2026-05-14: Host guess write succeeded and Reveal button unlocked only after guess completion. |
| Screen restrictions | Screen client during play/reveal | No guess UI, no host controls | [ ] | Blocked in this run: independent visible screen browser not available in Copilot browser session; needs manual device/browser check. |
| Reveal/scoring transition | Complete round and advance | Scores/reveal/next round are correct | [x] | 2026-05-14: Reveal rendered song-by-song outcomes and score deltas; host finish controls shown correctly. |

### Native Handoff Mode

| Test | Steps | Expected | Pass | Notes |
|---|---|---|---|---|
| Default mode check | Create new room and inspect picker | Native Handoff is active by default | [x] | 2026-05-14: New room showed `Native App Handoff` as active/disabled mode button. |
| Active button behavior | Tap active mode button | No action; active button is non-interactive | [x] | 2026-05-14: Clicking disabled active mode button produced no state change. |
| Mode switch behavior | Switch to Embed, then back to Native | Inactive button switches mode successfully | [x] | 2026-05-14: Switched to Embed and back to Native; active/disabled states flipped correctly each time. |
| Submission to play transition | All submit songs | No currentRound error; flow continues | [x] | 2026-05-14: Round advanced to native `playing` with host controls visible; no `currentRound` crash observed. |
| Host native controls | Use Open App, Started, Pause, Resume, Next | Phase updates propagate to all clients | [ ] | 2026-05-14 delta: post-patch contention stress in live room completed 48/48 phase writes with 0 retryable Firestore errors; manual multi-client propagation check still pending. |
| Player native status | Observe player view during host phase changes | Status banner/metadata update correctly | [ ] | Blocked in this run: no independent visible player page state in Copilot browser session; requires manual multi-device verification. |
| Screen in native mode | Observe screen client in native mode | Playback/status only, no guess/host controls | [ ] | Blocked in this run: no independent visible screen page state in Copilot browser session; requires manual multi-device verification. |
| Reveal/scoring parity | Complete round and score | Same scoring/reveal behavior as embed | [x] | 2026-05-14: Native round completed through reveal with correct per-song attribution and score increments. |

### Compatibility and Recovery

| Test | Steps | Expected | Pass | Notes |
|---|---|---|---|---|
| Old room compatibility | Join room lacking new playback fields | No crash; fallback/default behavior works | [ ] | Not executed in this pass (no curated legacy room fixture). |
| Host reconnect recovery | Refresh/rejoin host during native round | Phase recovers safely; clients remain stable | [ ] | Pre-patch run failed with reconnect-fallback write conflicts. Post-patch synthetic contention stress passed (48/48 writes, 0 retryable errors). Additional local patched reload check (2026-05-14, room `S827`) forced `launching` + `host_missing` then host reload; room recovered to native phase `ready` without `failed-precondition` fallback error. Keep open until full device-to-device manual pass. |
| Player reconnect recovery | Refresh/rejoin player during round | Player restores to correct room state | [ ] | Not executed in this pass (no independently controlled player browser page with preserved identity). |
| Invite deep link | Open invite URL with `?join=CODE` | Room code auto-filled, user enters name only | [x] | 2026-05-14: Verified `index.html?join=VZYY` pre-filled room code and focused name input. |

## Pass 2

Repeat all sections above for a second clean pass before removing embed fallback guard.

### Result

- [ ] Pass 1 complete
- [ ] Pass 2 complete
- [ ] Ready for embed fallback retirement checkpoint

Pass 1 status note (2026-05-14): Core lobby/mode/reveal flows passed in both modes; compatibility/recovery and independent player/screen observations remain open. Reconnect write stability improved after patch (synthetic contention run: 48 attempted phase writes, 48 applied, 0 retryable errors) and local patched host-reload scenario recovered cleanly to `ready`; final sign-off still requires full manual multi-device refresh/rejoin verification.

## Exit Criteria for Fallback Retirement

1. Two clean QA passes with no blockers.
2. No permission errors in join/start/phase transitions.
3. No scoring or reveal regressions in either mode.
