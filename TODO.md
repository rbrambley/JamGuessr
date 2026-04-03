# JamGuessr Todo List

## Bugs

- [ ] **Fix player video playback stopping** *(Priority: Medium)* — complete remaining per-song seek interruption fix around the 3s mark.

## Core Features
- [ ] **Dedicated playback device mode** — special "screen" join role: plays audio/video only, no guessing UI. Intended for TV/Chromecast in-person scenarios where players watch together but guess on their own phones.

- [ ] **Roadtrip safe driver mode** *(Priority: Medium)* — driver joins with a low-distraction "car screen" flow and is forced into playback-only screen role (no guessing). Driver device should be the only audio output target (Bluetooth/CarPlay/Android Auto). Host controls must stay with a passenger.
	- Acceptance criteria:
	- Driver join flow is low-distraction (max 2 taps after room code entry).
	- Driver device in this mode cannot submit guesses or access host controls.
	- Host cannot start a game unless host role is on a non-driver/passenger device.
	- Playback-only driver screen shows only essential controls/status (connect, playing, volume guidance).
	- If driver disconnects, room falls back safely to passenger playback device selection.

- [ ] **Unique player assignment per round** — during song assignment, do not allow selecting the same player for every song in a round. Enforce a one-to-one mapping so each song is assigned to a different player within that round.

- [ ] **Party mode** — no rounds, no scoring, just a shared collaborative song queue anyone can add to. Basically a jukebox mode alongside the existing Game mode.

- [ ] **Playlist export** — end-of-game option to download all played songs (title, artist, YouTube URL) as a file (CSV, TXT, or similar).

## Single Player Modes

- [ ] **Daily challenge seed** *(Priority: Medium)* — one shared daily playlist with global leaderboard and one-attempt scoring.
- [ ] **Streak survival mode** *(Priority: Quick Win)* — continue until first miss; track personal best and longest correct streak.
- [ ] **Career progression** *(Priority: Big Ticket)* — XP + rank tiers (Rookie DJ -> Festival Headliner) unlocked by consistency, not only high scores.
- [ ] **Practice lab mode** *(Priority: Medium)* — unranked mode with filters (decade, genre, artist) and optional answer reveal after each guess.

## 1v1 Multiplayer Modes

- [ ] **Best-of series duel** *(Priority: Quick Win)* — first to win 2/3 or 3/5 rounds takes the match; includes tiebreaker song if tied.
- [ ] **Steal window mechanic** *(Priority: Medium)* — if opponent misses, other player gets a short steal opportunity for partial points.
- [ ] **Alternating categories** *(Priority: Medium)* — each player picks one round category (genre/era/theme), then one random round decides the winner.
- [ ] **Blind wager final round** *(Priority: Big Ticket)* — both players secretly wager a percentage of score before final song reveal.

## Scoring and Competitive Systems

- [ ] **Perfect-round reward choice** *(Priority: Quick Win)* — if a player gets every song right in a round, choose next-round perk: 1.5x multiplier or halve one opponent's points for that round.
- [ ] **Risk multiplier mode** *(Priority: Medium)* — before each round, choose Safe (1x) or Risk (2x for all-correct, 0.5x if any miss).
- [ ] **Combo chain bonus** *(Priority: Medium)* — consecutive correct answers build combo multipliers (1.1x, 1.25x, 1.5x) that reset on miss.
- [ ] **Comeback shield** *(Priority: Big Ticket)* — trailing player can activate one-time score protection to reduce incoming sabotage effects.

## YouTube Premium Related

- [x] **YouTube session helper messaging** *(Done)* — added sign-in/ad-session helper copy on home + lobby, including condensed mobile text.
- [ ] **Premium status toggle (host + player profile)** *(Priority: Medium)* — optional self-declared "I have YouTube Premium" setting to tailor gameplay perks without requiring unsupported account detection.
- [ ] **Premium-host game modifier** *(Priority: Medium)* — if host enables Premium mode, default to longer preview windows and fewer pause gaps between songs to create a smoother ad-free experience.
- [ ] **Premium player perk tokens** *(Priority: Big Ticket)* — Premium players get one "skip clue wait" token per round (instant reveal of one hint category like decade or genre).
- [ ] **Premium lobby theme pack** *(Priority: Quick Win)* — cosmetic-only perks (exclusive avatars, badges, winner animations) for Premium users to avoid pay-to-win imbalance.

## Visual and UX Enhancements

- [ ] **Round-end score celebrations** *(Priority: Medium)* — faster, more exciting score updates; winner gets celebration emoji + winner-only event, lowest scorer gets thumbs-down emoji + low-score-only event.

## Priority Buckets

### Quick Wins
- [ ] Perfect-round reward choice
- [ ] Streak survival mode
- [ ] Best-of series duel
- [ ] Premium lobby theme pack

### Next Session Plan (Single Player)
- [ ] **[30m] Streak survival mode - MVP scope lock** — confirm guess rule (title OR artist), fixed preview window, and first-miss-ends-run behavior.
- [ ] **[30m] Song pool source - phase 1** — use controlled JamGuessr catalog for now (avoid fully random playlist pulls in ranked modes).
- [ ] **[60m] Streak survival mode - gameplay state** — add solo state fields (`currentStreak`, `bestStreak`, `runActive`, `currentSongId`, `usedSongIds`).
- [ ] **[30m] Streak survival mode - UI entry** — add "Single Player" start option on home screen and route to solo flow.
- [ ] **[120m] Streak survival mode - answer flow** — add guess input, submit, correctness check, reveal, and auto-advance on correct.
- [ ] **[30m] Streak survival mode - game over** — show final streak, best streak, and restart button.
- [ ] **[30m] Streak survival mode - persistence** — save `bestStreak` locally first (localStorage), then optional cloud sync later.
- [ ] **[120m] Daily challenge seed follow-up** — implement deterministic date-based song selection after streak mode is stable.
- [ ] **[120m] Song pool source - phase 2 automation** — schedule ingestion/validation job (nightly) with dedupe + embeddability checks.

### Medium
- [ ] Fix player video playback stopping
- [ ] Roadtrip safe driver mode
- [ ] Daily challenge seed
- [ ] Steal window mechanic
- [ ] Alternating categories
- [ ] Risk multiplier mode
- [ ] Combo chain bonus
- [ ] Practice lab mode
- [ ] Premium status toggle
- [ ] Premium-host game modifier
- [ ] Round-end score celebrations

### Big Ticket
- [ ] Career progression
- [ ] Blind wager final round
- [ ] Premium player perk tokens
- [ ] Comeback shield
