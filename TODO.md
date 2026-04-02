# JamGuessr Todo List

## Bugs

## Features
- [ ] **Dedicated playback device mode** — special "screen" join role: plays audio/video only, no guessing UI. Intended for TV/Chromecast in-person scenarios where players watch together but guess on their own phones.

- [ ] **Unique player assignment per round** — during song assignment, do not allow selecting the same player for every song in a round. Enforce a one-to-one mapping so each song is assigned to a different player within that round.

- [ ] **Party mode** — no rounds, no scoring, just a shared collaborative song queue anyone can add to. Basically a jukebox mode alongside the existing Game mode.

- [ ] **Playlist export** — end-of-game option to download all played songs (title, artist, YouTube URL) as a file (CSV, TXT, or similar).

## Idea Backlog

### YouTube Premium Related Ideas
- [ ] **Premium status toggle (host + player profile)** — optional self-declared "I have YouTube Premium" setting to tailor gameplay perks without requiring unsupported account detection.
- [ ] **Premium-host game modifier** — if host enables Premium mode, default to longer preview windows and fewer pause gaps between songs to create a smoother ad-free experience.
- [ ] **Premium player perk tokens** — Premium players get one "skip clue wait" token per round (instant reveal of one hint category like decade or genre).
- [ ] **Premium lobby theme pack** — cosmetic-only perks (exclusive avatars, badges, winner animations) for Premium users to avoid pay-to-win imbalance.

### Single Player Ideas
- [ ] **Daily challenge seed** — one shared daily playlist with global leaderboard and one-attempt scoring.
- [ ] **Streak survival mode** — continue until first miss; track personal best and longest correct streak.
- [ ] **Career progression** — XP + rank tiers (Rookie DJ -> Festival Headliner) unlocked by consistency, not only high scores.
- [ ] **Practice lab mode** — unranked mode with filters (decade, genre, artist) and optional answer reveal after each guess.

### 1v1 Multiplayer Ideas
- [ ] **Best-of series duel** — first to win 2/3 or 3/5 rounds takes the match; includes tiebreaker song if tied.
- [ ] **Steal window mechanic** — if opponent misses, other player gets a short steal opportunity for partial points.
- [ ] **Alternating categories** — each player picks one round category (genre/era/theme), then one random round decides the winner.
- [ ] **Blind wager final round** — both players secretly wager a percentage of score before final song reveal.

### Bonus Scoring Modes
- [ ] **Perfect-round reward choice** — if a player gets every song right in a round, choose next-round perk: 1.5x multiplier or halve one opponent's points for that round.
- [ ] **Risk multiplier mode** — before each round, choose Safe (1x) or Risk (2x for all-correct, 0.5x if any miss).
- [ ] **Combo chain bonus** — consecutive correct answers build combo multipliers (1.1x, 1.25x, 1.5x) that reset on miss.
- [ ] **Comeback shield** — trailing player can activate one-time score protection to reduce incoming sabotage effects.

## Prioritized Roadmap

### Quick Wins (Ship First)
- [ ] **Perfect-round reward choice** — high excitement, low UI/backend complexity.
- [ ] **Streak survival mode (single player)** — reuses current game loop with minimal multiplayer dependencies.
- [ ] **Best-of series duel (1v1)** — mostly match wrapper logic on top of existing rounds.
- [ ] **Premium lobby theme pack** — cosmetic value with low gameplay risk.

### Medium Effort (Next)
- [ ] **Daily challenge seed** — needs deterministic playlist seed + leaderboard storage.
- [ ] **Steal window mechanic (1v1)** — requires timing state + arbitration for steal attempts.
- [ ] **Risk multiplier mode** — requires per-round commit/lock scoring logic.
- [ ] **Practice lab mode** — needs flexible filters and alternate end-of-round flow.

### Big-Ticket Modes (Roadmap)
- [ ] **Career progression** — persistent XP/rank economy and anti-exploit balancing.
- [ ] **Blind wager final round (1v1)** — hidden wager UX + fair reveal and reconciliation flow.
- [ ] **Premium player perk tokens** — entitlement setting + token economy balancing.
- [ ] **Comeback shield + sabotage systems** — broad score interaction framework and fairness tuning.
