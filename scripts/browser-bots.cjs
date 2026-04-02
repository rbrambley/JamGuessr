/*
  Browser bot runner for hosted JamGuessr games.
  - You host manually in your own browser.
  - Bots join by room code and act as players.

  Usage (PowerShell):
  $env:JAM_BOT_ROOM_CODE="ABCD"
  $env:JAM_BOT_COUNT="4"
  $env:JAM_BOT_BASE_URL="https://rbrambley.github.io/JamGuessr"
  $env:JAM_BOT_HEADLESS="false"
  node scripts/browser-bots.cjs
*/

const DEFAULT_BASE_URL = "https://rbrambley.github.io/JamGuessr";
const DEFAULT_BOT_COUNT = 3;
const MIN_ACTION_DELAY_MS = 1200;
const MAX_ACTION_DELAY_MS = 2600;
const PLAY_VIEW_SETTLE_DELAY_MS = 1800;
const PLAYBACK_POKE_COOLDOWN_MS = 2200;
const BOT_BROWSER_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding"
];

const QUERY_BANK = {
  pop: [
    "dua lipa levitating",
    "the weeknd blinding lights",
    "billie eilish bad guy",
    "ed sheeran shape of you"
  ],
  rock: [
    "queen bohemian rhapsody",
    "journey dont stop believin",
    "bon jovi livin on a prayer",
    "linkin park numb"
  ],
  indie: [
    "black sheep metric",
    "the killers mr brightside",
    "phoenix 1901",
    "vampire weekend a punk"
  ],
  hiphop: [
    "de la soul me myself and i",
    "outkast hey ya",
    "kendrick lamar humble",
    "dr dre still dre"
  ],
  electronic: [
    "daft punk one more time",
    "calvin harris summer",
    "avicii levels",
    "disclosure latch"
  ],
  throwback: [
    "toto africa",
    "a ha take on me",
    "abba dancing queen",
    "fleetwood mac dreams"
  ]
};

const BOT_PERSONAS = [
  {
    label: "Indie Scout",
    tastes: ["indie", "rock", "throwback"],
    tickMinMs: 1400,
    tickMaxMs: 2900,
    thinkMinMs: 500,
    thinkMaxMs: 1500,
    topResultBias: 0.72,
    guessConfidence: 0.68
  },
  {
    label: "Chart Chaser",
    tastes: ["pop", "electronic", "hiphop"],
    tickMinMs: 1000,
    tickMaxMs: 2200,
    thinkMinMs: 300,
    thinkMaxMs: 900,
    topResultBias: 0.8,
    guessConfidence: 0.58
  },
  {
    label: "Throwback Nerd",
    tastes: ["throwback", "rock", "pop"],
    tickMinMs: 1600,
    tickMaxMs: 3300,
    thinkMinMs: 600,
    thinkMaxMs: 1700,
    topResultBias: 0.6,
    guessConfidence: 0.74
  },
  {
    label: "Club Curator",
    tastes: ["electronic", "pop", "hiphop"],
    tickMinMs: 900,
    tickMaxMs: 2100,
    thinkMinMs: 250,
    thinkMaxMs: 800,
    topResultBias: 0.85,
    guessConfidence: 0.52
  },
  {
    label: "Genre Hopper",
    tastes: ["hiphop", "indie", "throwback", "rock"],
    tickMinMs: 1200,
    tickMaxMs: 2600,
    thinkMinMs: 400,
    thinkMaxMs: 1200,
    topResultBias: 0.67,
    guessConfidence: 0.62
  }
];

function toInt(value, fallback) {
  const n = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBaseUrl(input) {
  const raw = (input || DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/, "");
}

function randomDelayMs() {
  return Math.floor(Math.random() * (MAX_ACTION_DELAY_MS - MIN_ACTION_DELAY_MS + 1)) + MIN_ACTION_DELAY_MS;
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickPersona(index) {
  return BOT_PERSONAS[index % BOT_PERSONAS.length];
}

function pickQueryForPersona(persona) {
  const bucket = randomFrom(persona.tastes);
  const pool = QUERY_BANK[bucket] || QUERY_BANK.pop;
  return randomFrom(pool);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getVisibleViewId(page) {
  return page.evaluate(() => {
    const visible = document.querySelector('.view[style*="display: block"]');
    return visible ? visible.id : null;
  });
}

class BotPlayer {
  constructor(index, browser, options) {
    this.index = index;
    this.browser = browser;
    this.options = options;
    this.persona = options.persona;
    this.name = `${this.persona.label} ${index + 1}`;
    this.context = null;
    this.page = null;
    this.running = true;
    this.lastPickAt = 0;
    this.lastViewId = "";
    this.enteredPlayingAt = 0;
    this.lastPlaybackPokeAt = 0;
    this.guessCounts = new Map();
    this.learnedPickerByArtist = new Map();
    this.learnedPickerByTitle = new Map();
    this.lastLearnedRevealRound = -1;
  }

  log(message) {
    const ts = new Date().toISOString().split("T")[1].replace("Z", "");
    console.log(`[${ts}] [${this.name}] ${message}`);
  }

  async init() {
    this.context = await this.browser.newContext({ viewport: null });
    this.page = await this.context.newPage();

    this.page.on("console", msg => {
      const text = msg.text();
      if (/error|failed/i.test(text)) {
        this.log(`console: ${text}`);
      }
    });

    await this.joinRoom();
  }

  async joinRoom() {
    const joinUrl = `${this.options.baseUrl}/index.html`;
    await this.page.goto(joinUrl, { waitUntil: "domcontentloaded" });

    await this.page.fill("#player-name", this.name);
    await this.page.fill("#room-code", this.options.roomCode);
    await this.page.click("#join-room-btn");

    await this.page.waitForURL(url => url.toString().includes("game.html"), { timeout: 15000 });
    this.log(`joined room ${this.options.roomCode}`);
  }

  async run() {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.log(`tick error: ${err.message || err}`);
      }
      const tickDelay = randomBetween(
        this.persona?.tickMinMs || MIN_ACTION_DELAY_MS,
        this.persona?.tickMaxMs || MAX_ACTION_DELAY_MS
      );
      await sleep(tickDelay || randomDelayMs());
    }
  }

  async tick() {
    if (!this.page || this.page.isClosed()) {
      this.running = false;
      return;
    }

    const viewId = await getVisibleViewId(this.page);
    if (viewId !== this.lastViewId) {
      if (viewId === "view-playing") {
        this.enteredPlayingAt = Date.now();
        this.lastPlaybackPokeAt = 0;
      }
      this.lastViewId = viewId;
    }

    if (viewId === "view-picking") {
      await this.handlePicking();
      return;
    }

    if (viewId === "view-playing") {
      await this.handlePlaybackUi();
      const settledInPlayView = Date.now() - this.enteredPlayingAt >= PLAY_VIEW_SETTLE_DELAY_MS;
      if (!settledInPlayView) return;
      await this.handleGuessing();
      return;
    }

    if (viewId === "view-reveal") {
      await this.handleRevealLearning();
      return;
    }

    if (viewId === "view-final") {
      this.log("reached final results");
      return;
    }
  }

  async handlePlaybackUi() {
    const now = Date.now();

    const unlockBtn = this.page.locator("#audio-unlock-btn");
    const unlockVisible = await unlockBtn.isVisible().catch(() => false);
    if (unlockVisible) {
      await unlockBtn.click().catch(() => {});
      this.lastPlaybackPokeAt = now;
    } else if (now - this.lastPlaybackPokeAt >= PLAYBACK_POKE_COOLDOWN_MS) {
      this.lastPlaybackPokeAt = now;
      // Some clients never render the unlock button. Poke the player shell/iframe
      // to satisfy autoplay gesture requirements and kick playback.
      await this.page.locator(".youtube-player-shell").click({
        timeout: 800,
        force: true,
        position: { x: 36, y: 36 }
      }).catch(() => {});

      await this.page.locator("#youtube-player").click({
        timeout: 800,
        force: true,
        position: { x: 64, y: 64 }
      }).catch(() => {});

      await this.page.locator("#youtube-player iframe").first().click({
        timeout: 800,
        force: true,
        position: { x: 72, y: 72 }
      }).catch(() => {});
    }

    const frames = this.page.frames();
    for (const frame of frames) {
      try {
        const skipCandidates = [
          'button[aria-label*="Skip" i]',
          'button.ytp-ad-skip-button',
          'button.ytp-ad-skip-button-modern',
          '.ytp-ad-skip-button',
          '.ytp-ad-skip-button-modern'
        ];

        for (const selector of skipCandidates) {
          const btn = frame.locator(selector).first();
          if (await btn.isVisible().catch(() => false)) {
            await btn.click({ timeout: 1000 }).catch(() => {});
            this.log("clicked Skip Ad");
            return;
          }
        }
      } catch {
        // Best-effort only; some frames are cross-origin or transient.
      }
    }
  }

  async handlePicking() {
    const now = Date.now();
    if (now - this.lastPickAt < 2500) return;

    const waitingVisible = await this.page.locator("#waiting-msg").isVisible().catch(() => false);
    if (waitingVisible) return;

    const submitBtn = this.page.locator("#submit-songs-btn");
    const submitVisible = await submitBtn.isVisible().catch(() => false);
    if (!submitVisible) return;

    const submitDisabled = await submitBtn.isDisabled();
    if (!submitDisabled) {
      await submitBtn.click();
      this.lastPickAt = now;
      this.log("submitted selected song");
      return;
    }

    const query = pickQueryForPersona(this.persona);
    const searchInput = this.page.locator("#song-search-query");
    const searchBtn = this.page.locator("#song-search-btn");

    const inputVisible = await searchInput.isVisible().catch(() => false);
    if (!inputVisible) return;

    await searchInput.fill(query);
    await sleep(randomBetween(this.persona.thinkMinMs, this.persona.thinkMaxMs));
    await searchBtn.click();

    const results = this.page.locator(".song-search-item");
    try {
      await results.first().waitFor({ timeout: 45000 });
    } catch {
      // Free-tier backend cold starts can exceed 10s; click once more and wait again.
      await searchBtn.click();
      await results.first().waitFor({ timeout: 45000 });
    }

    const count = await results.count();
    if (count === 0) return;

    let pickIndex = 0;
    if (Math.random() > this.persona.topResultBias) {
      pickIndex = Math.floor(Math.random() * count);
    } else {
      const topBand = Math.min(count, 3);
      pickIndex = Math.floor(Math.random() * topBand);
    }

    await sleep(randomBetween(this.persona.thinkMinMs, this.persona.thinkMaxMs));
    await results.nth(pickIndex).click();

    const submitEnabled = !(await submitBtn.isDisabled());
    if (submitEnabled) {
      await sleep(randomBetween(this.persona.thinkMinMs, this.persona.thinkMaxMs));
      await submitBtn.click();
      this.lastPickAt = now;
      this.log(`searched "${query}" and submitted`);
    }
  }

  async handleRevealLearning() {
    const roundInfo = await this.page.locator("#round-display").textContent().catch(() => "");
    const match = /Round\s+(\d+)/i.exec(roundInfo || "");
    const round = match ? Number.parseInt(match[1], 10) : -1;
    if (round === this.lastLearnedRevealRound) return;

    const revealed = await this.page.evaluate(() => {
      const rows = [...document.querySelectorAll("#round-results .final-playlist-item")];
      return rows.map(row => {
        const title = row.querySelector(".song-search-title")?.textContent?.trim() || "";
        const artist = row.querySelector(".song-search-channel")?.textContent?.trim() || "";
        const pickedByText = [...row.querySelectorAll(".playlist-song-note")]
          .map(el => el.textContent || "")
          .find(text => /Picked by/i.test(text)) || "";
        const pickerMatch = /Picked by\s+(.+)$/i.exec(pickedByText.trim());
        return {
          title,
          artist,
          picker: pickerMatch ? pickerMatch[1].trim() : ""
        };
      });
    });

    for (const item of revealed) {
      if (item.artist && item.picker) {
        this.learnedPickerByArtist.set(item.artist.toLowerCase(), item.picker);
      }
      if (item.title && item.picker) {
        this.learnedPickerByTitle.set(item.title.toLowerCase(), item.picker);
      }
    }

    this.lastLearnedRevealRound = round;
    if (revealed.length > 0) {
      this.log(`learned picker patterns for ${revealed.length} song(s) in reveal`);
    }
  }

  pickGuessIndex(labels, preferredName) {
    if (!labels || labels.length === 0) return -1;

    const normalizedLabels = labels.map(l => String(l || "").trim());
    const preferredIndex = preferredName
      ? normalizedLabels.findIndex(name => name === preferredName)
      : -1;

    if (preferredIndex >= 0 && Math.random() < this.persona.guessConfidence) {
      return preferredIndex;
    }

    // Less-random fallback: prefer players this bot has guessed less often.
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    normalizedLabels.forEach((name, idx) => {
      const score = this.guessCounts.get(name) || 0;
      // Small jitter keeps choices human-like while still balanced over time.
      const jitter = Math.random() * 0.35;
      if (score + jitter < bestScore) {
        bestScore = score + jitter;
        bestIndex = idx;
      }
    });

    return bestIndex;
  }

  async handleGuessing() {
    const rows = this.page.locator(".playlist-song-guesses");
    const rowCount = await rows.count();
    if (rowCount === 0) return;

    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const selectedCount = await row.locator(".guess-btn-selected").count();
      if (selectedCount > 0) continue;

      const buttons = row.locator(".guess-btn");
      const btnCount = await buttons.count();
      if (btnCount === 0) continue;

      const songMeta = await row.evaluate(el => {
        const card = el.closest(".playlist-song");
        const title = card?.querySelector(".song-search-title")?.textContent?.trim() || "";
        const artist = card?.querySelector(".song-search-channel")?.textContent?.trim() || "";
        return { title, artist };
      });

      const preferredByTitle = this.learnedPickerByTitle.get((songMeta.title || "").toLowerCase()) || "";
      const preferredByArtist = this.learnedPickerByArtist.get((songMeta.artist || "").toLowerCase()) || "";
      const preferredName = preferredByTitle || preferredByArtist || "";

      const labels = (await buttons.allTextContents()).map(t => String(t || "").trim());
      const choice = this.pickGuessIndex(labels, preferredName);
      if (choice < 0 || choice >= btnCount) continue;

      await sleep(randomBetween(120, 420));
      await buttons.nth(choice).click();
      const pickedLabel = labels[choice] || `index ${choice}`;
      this.guessCounts.set(pickedLabel, (this.guessCounts.get(pickedLabel) || 0) + 1);
      this.log(`made guess for song row ${i + 1} -> ${pickedLabel}`);
      await sleep(150);
    }
  }

  async stop() {
    this.running = false;
    if (this.context) {
      await this.context.close().catch(() => {});
    }
  }
}

async function main() {
  const roomCode = (process.env.JAM_BOT_ROOM_CODE || "").trim().toUpperCase();
  if (!roomCode) {
    throw new Error("Missing JAM_BOT_ROOM_CODE. Example: set JAM_BOT_ROOM_CODE=ABCD");
  }

  const botCount = Math.max(1, Math.min(12, toInt(process.env.JAM_BOT_COUNT, DEFAULT_BOT_COUNT)));
  const baseUrl = normalizeBaseUrl(process.env.JAM_BOT_BASE_URL || DEFAULT_BASE_URL);
  const headless = String(process.env.JAM_BOT_HEADLESS || "false").toLowerCase() === "true";

  let playwright;
  try {
    playwright = require("playwright");
  } catch (err) {
    throw new Error(
      "Playwright is not installed. Run: npm install -D playwright ; npx playwright install chromium"
    );
  }

  console.log(`Starting ${botCount} bot(s) for room ${roomCode} at ${baseUrl}`);
  console.log(`Headless: ${headless}`);

  const browser = await playwright.chromium.launch({
    headless,
    args: BOT_BROWSER_ARGS
  });
  const bots = [];

  try {
    for (let i = 0; i < botCount; i++) {
      const persona = pickPersona(i);
      const bot = new BotPlayer(i, browser, { roomCode, baseUrl, persona });
      await bot.init();
      bot.log(`persona: ${persona.label} (${persona.tastes.join(", ")})`);
      bots.push(bot);
      await sleep(350);
    }

    console.log("All bots joined. You can now host manually.");

    const runPromises = bots.map(bot => bot.run());

    const shutdown = async () => {
      console.log("Stopping bots...");
      for (const bot of bots) {
        await bot.stop();
      }
      await browser.close().catch(() => {});
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await Promise.all(runPromises);
  } catch (err) {
    console.error("Bot runner failed:", err.message || err);
    for (const bot of bots) {
      await bot.stop();
    }
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
