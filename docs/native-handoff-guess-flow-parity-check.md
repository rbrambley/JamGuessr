# Native Handoff Guess-Flow Parity Check

Date: 2026-05-03
Goal: Verify native handoff mode keeps existing guess submission, reveal, and scoring behavior with no playback-mode regressions.

## Result

Parity check passed at code level.

- Guess submission path is unchanged and playback-mode agnostic.
- Reveal/scoring/finalization path is unchanged and playback-mode agnostic.
- Native-mode logic is currently isolated to playback UI and host playback-state controls.

## Evidence

### 1) Guess submission remains unchanged

- Guess write path: js/api.js:172
  - Validates guesser and guessed target role constraints.
  - Upserts guess by song and player.
  - No dependency on playback mode or playback state.

- Guess UI trigger: js/game-logic.js:2514
  - Guess button still calls submitGuess with same parameters.
  - No native/embed branching in guess write behavior.

### 2) Guess progress and reveal gating remain unchanged

- Guess progress computation: js/game-logic.js:2547
  - Computes total required guesses and completed guesses by round.
  - Does not depend on playback mode.

- Reveal trigger for host: js/game-logic.js:2851
  - Reveal decision still based on getRoundGuessProgress.
  - No playback-mode dependency.

### 3) Scoring pipeline remains unchanged

- Round scoring finalization: js/game-logic.js:3040
  - Awards song scores, applies perk adjustments, then moves to reveal.
  - No playback-mode dependency.

- Reveal rendering path: js/game-logic.js:3163
  - Uses songs, guesses, players, and score breakdown.
  - No playback-mode dependency.

### 4) Native-mode changes are scoped to playback UI/control only

- Native playing view branch: js/game-logic.js:2288
- Native host controls (phase updates): js/game-logic.js:2515
- Canonical phase write API: js/api.js:525

These paths affect playback status and host controls, not guess/scoring calculations.

## Residual risk

- Runtime multi-client verification is still recommended for race/timing behavior across host/player/screen devices, even though static code audit shows parity.

## Suggested QA spot checks

1. Native mode, 3 players: all guess changes persist before reveal.
2. Native mode: reveal only unlocks when progress is complete.
3. Native mode: score totals and perk effects match embed mode for same round data.
4. Mode switch between rounds: no carryover guess or reveal regressions.
