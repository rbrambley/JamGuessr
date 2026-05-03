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
| Lobby join (host + player) | Create room, invite player, both join lobby | Both visible in lobby, no permission errors | [ ] | |
| Screen role assignment | Add third client, set role to Screen | Screen role shown and persisted | [ ] | |
| Start after submissions | All submit one song, host starts | No validation crash, game enters playing | [ ] | |
| Player guess flow | Player submits guesses during round | Guesses persist, reveal gating works | [ ] | |
| Screen restrictions | Screen client during play/reveal | No guess UI, no host controls | [ ] | |
| Reveal/scoring transition | Complete round and advance | Scores/reveal/next round are correct | [ ] | |

### Native Handoff Mode

| Test | Steps | Expected | Pass | Notes |
|---|---|---|---|---|
| Default mode check | Create new room and inspect picker | Native Handoff is active by default | [ ] | |
| Active button behavior | Tap active mode button | No action; active button is non-interactive | [ ] | |
| Mode switch behavior | Switch to Embed, then back to Native | Inactive button switches mode successfully | [ ] | |
| Submission to play transition | All submit songs | No currentRound error; flow continues | [ ] | |
| Host native controls | Use Open App, Started, Pause, Resume, Next | Phase updates propagate to all clients | [ ] | |
| Player native status | Observe player view during host phase changes | Status banner/metadata update correctly | [ ] | |
| Screen in native mode | Observe screen client in native mode | Playback/status only, no guess/host controls | [ ] | |
| Reveal/scoring parity | Complete round and score | Same scoring/reveal behavior as embed | [ ] | |

### Compatibility and Recovery

| Test | Steps | Expected | Pass | Notes |
|---|---|---|---|---|
| Old room compatibility | Join room lacking new playback fields | No crash; fallback/default behavior works | [ ] | |
| Host reconnect recovery | Refresh/rejoin host during native round | Phase recovers safely; clients remain stable | [ ] | |
| Player reconnect recovery | Refresh/rejoin player during round | Player restores to correct room state | [ ] | |
| Invite deep link | Open invite URL with `?join=CODE` | Room code auto-filled, user enters name only | [ ] | |

## Pass 2

Repeat all sections above for a second clean pass before removing embed fallback guard.

### Result

- [ ] Pass 1 complete
- [ ] Pass 2 complete
- [ ] Ready for embed fallback retirement checkpoint

## Exit Criteria for Fallback Retirement

1. Two clean QA passes with no blockers.
2. No permission errors in join/start/phase transitions.
3. No scoring or reveal regressions in either mode.
