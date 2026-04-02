const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const admin = require("firebase-admin");

const PORT = Number(process.env.PORT || 3000);
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SEARCH_MIN_QUERY_LENGTH = 4;
const SEARCH_MAX_RESULTS = 5;
const SEARCH_FETCH_CANDIDATES = 10;
const MUSIC_CATEGORY_ID = "10";
const MAX_VIDEO_DURATION_SECONDS = 12 * 60;
const MIN_VIDEO_DURATION_SECONDS = 30;
const CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || (7 * 24 * 60 * 60 * 1000));
const NEGATIVE_CACHE_TTL_MS = Number(process.env.SEARCH_NEGATIVE_CACHE_TTL_MS || (6 * 60 * 60 * 1000));
const CACHE_PERSIST_FILE = process.env.SEARCH_CACHE_FILE || path.join(ROOT_DIR, ".cache", "youtube-search-cache.json");
const CACHE_PERSIST_DEBOUNCE_MS = Number(process.env.SEARCH_CACHE_PERSIST_DEBOUNCE_MS || 500);
const CACHE_PERSIST_MAX_ENTRIES = Number(process.env.SEARCH_CACHE_MAX_ENTRIES || 5000);
const QUOTA_SEARCH_UNITS = Number(process.env.YOUTUBE_SEARCH_UNITS || 100);
const QUOTA_DETAILS_UNITS = Number(process.env.YOUTUBE_DETAILS_UNITS || 1);
const QUOTA_DAILY_BUDGET_UNITS = Number(process.env.YOUTUBE_DAILY_BUDGET_UNITS || 10000);
const QUOTA_GUARD_THRESHOLD_UNITS = Number(
  process.env.YOUTUBE_QUOTA_GUARD_THRESHOLD_UNITS || Math.floor(QUOTA_DAILY_BUDGET_UNITS * 0.85)
);
const ROOT_DIR = __dirname;
const CLEANUP_INTERVAL_MS = Number(process.env.ROOM_CLEANUP_INTERVAL_MS || (5 * 60 * 1000));
const CLEANUP_SCAN_LIMIT = Number(process.env.ROOM_CLEANUP_SCAN_LIMIT || 200);
const CLEANUP_MAX_DELETE_PER_RUN = Number(process.env.ROOM_CLEANUP_MAX_DELETE_PER_RUN || 25);
const CLEANUP_LOBBY_IDLE_MS = Number(process.env.ROOM_CLEANUP_LOBBY_IDLE_MS || (30 * 60 * 1000));
const CLEANUP_ACTIVE_IDLE_MS = Number(process.env.ROOM_CLEANUP_ACTIVE_IDLE_MS || (2 * 60 * 60 * 1000));
const CLEANUP_FINISHED_IDLE_MS = Number(process.env.ROOM_CLEANUP_FINISHED_IDLE_MS || (24 * 60 * 60 * 1000));

const cache = new Map();
const inFlightSearches = new Map();
let cleanupBusy = false;
let adminDb = null;
let cachePersistTimer = null;
let estimatedQuotaDayKey = "";
let estimatedQuotaUnitsUsed = 0;

function getUtcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetQuotaIfDayRolled() {
  const dayKey = getUtcDayKey();
  if (estimatedQuotaDayKey !== dayKey) {
    estimatedQuotaDayKey = dayKey;
    estimatedQuotaUnitsUsed = 0;
  }
}

function addEstimatedQuota(units) {
  resetQuotaIfDayRolled();
  estimatedQuotaUnitsUsed += Math.max(0, Number(units || 0));
  schedulePersistedCacheWrite();
}

function canSpendEstimatedQuota(units) {
  resetQuotaIfDayRolled();
  return (estimatedQuotaUnitsUsed + Math.max(0, Number(units || 0))) <= QUOTA_GUARD_THRESHOLD_UNITS;
}

function schedulePersistedCacheWrite() {
  if (cachePersistTimer) return;
  cachePersistTimer = setTimeout(() => {
    cachePersistTimer = null;
    persistCacheToDisk();
  }, CACHE_PERSIST_DEBOUNCE_MS);
}

function persistCacheToDisk() {
  try {
    const now = Date.now();
    const entries = [];

    cache.forEach((entry, query) => {
      if (!entry || entry.expiresAt <= now) return;
      entries.push({
        query,
        items: Array.isArray(entry.items) ? entry.items : [],
        expiresAt: Number(entry.expiresAt || 0),
        isNegative: !!entry.isNegative
      });
    });

    entries.sort((a, b) => b.expiresAt - a.expiresAt);
    const limited = entries.slice(0, CACHE_PERSIST_MAX_ENTRIES);

    const payload = {
      version: 1,
      quota: {
        dayKey: estimatedQuotaDayKey || getUtcDayKey(),
        unitsUsed: Math.max(0, Number(estimatedQuotaUnitsUsed || 0))
      },
      entries: limited
    };

    fs.mkdirSync(path.dirname(CACHE_PERSIST_FILE), { recursive: true });
    fs.writeFileSync(CACHE_PERSIST_FILE, JSON.stringify(payload), "utf8");
  } catch (e) {
    console.warn("Warning: could not persist search cache:", e.message || e);
  }
}

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_PERSIST_FILE)) return;
    const raw = fs.readFileSync(CACHE_PERSIST_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const now = Date.now();
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    entries.forEach(entry => {
      const query = normalizeQuery(entry?.query || "");
      if (!query) return;
      const expiresAt = Number(entry?.expiresAt || 0);
      if (expiresAt <= now) return;

      cache.set(query, {
        items: Array.isArray(entry?.items) ? entry.items : [],
        expiresAt,
        isNegative: !!entry?.isNegative
      });
    });

    const quotaDayKey = String(parsed?.quota?.dayKey || "");
    if (quotaDayKey === getUtcDayKey()) {
      estimatedQuotaDayKey = quotaDayKey;
      estimatedQuotaUnitsUsed = Math.max(0, Number(parsed?.quota?.unitsUsed || 0));
    } else {
      resetQuotaIfDayRolled();
    }
  } catch (e) {
    console.warn("Warning: could not load persisted search cache:", e.message || e);
  }
}

function parseServiceAccountJson() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch (e) {
    console.warn("Warning: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Cleanup worker disabled.");
    return null;
  }
}

function initAdminDb() {
  if (adminDb) return adminDb;

  try {
    const sa = parseServiceAccountJson();
    const app = sa
      ? admin.initializeApp({ credential: admin.credential.cert(sa) })
      : admin.initializeApp();
    adminDb = app.firestore();
    return adminDb;
  } catch (e) {
    console.warn("Warning: could not initialize firebase-admin. Cleanup worker disabled.", e.message || e);
    return null;
  }
}

function roomLastActivityAt(room) {
  return Number(
    room.lastActivityAt ||
    room.lastHostChange?.changedAt ||
    room.createdAt ||
    0
  );
}

function roomIdleTtlMs(status) {
  if (status === "lobby") return CLEANUP_LOBBY_IDLE_MS;
  if (status === "finished") return CLEANUP_FINISHED_IDLE_MS;
  return CLEANUP_ACTIVE_IDLE_MS;
}

function shouldDeleteRoom(room, now) {
  const last = roomLastActivityAt(room);
  if (!last) return false;
  return (now - last) >= roomIdleTtlMs(room.status || "lobby");
}

async function runRoomCleanup() {
  if (cleanupBusy) return;
  cleanupBusy = true;

  try {
    const db = initAdminDb();
    if (!db) return;

    const now = Date.now();
    const roomsSnap = await db.collection("rooms").limit(CLEANUP_SCAN_LIMIT).get();
    if (roomsSnap.empty) return;

    const staleDocs = roomsSnap.docs.filter(doc => shouldDeleteRoom(doc.data() || {}, now));
    if (staleDocs.length === 0) return;

    const toDelete = staleDocs.slice(0, CLEANUP_MAX_DELETE_PER_RUN);
    for (const doc of toDelete) {
      await db.recursiveDelete(doc.ref);
    }

    console.log(`[cleanup] deleted ${toDelete.length} stale room(s)`);
  } catch (e) {
    console.warn("[cleanup] failed:", e.message || e);
  } finally {
    cleanupBusy = false;
  }
}

function startCleanupWorker() {
  // Attempt immediate run soon after boot, then continue on interval.
  setTimeout(() => {
    runRoomCleanup();
  }, 10 * 1000);

  setInterval(() => {
    runRoomCleanup();
  }, CLEANUP_INTERVAL_MS);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8"
};

function normalizeOrigin(origin) {
  return (origin || "").trim().replace(/\/+$/, "");
}

function resolveCorsOrigin(req) {
  if (ALLOWED_ORIGIN === "*") return "*";

  const requestOrigin = normalizeOrigin(req.headers.origin || "");
  const allowedOrigins = ALLOWED_ORIGIN
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return allowedOrigins[0] || "";
}

function corsHeaders(req) {
  const origin = resolveCorsOrigin(req);
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function sendJson(req, res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(req)
  });
  res.end(JSON.stringify(payload));
}

function normalizeQuery(query) {
  return (query || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getCachedResults(query) {
  const cached = cache.get(query);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    cache.delete(query);
    schedulePersistedCacheWrite();
    return null;
  }
  return cached;
}

function setCachedResults(query, items, options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs || CACHE_TTL_MS));
  cache.set(query, {
    items,
    expiresAt: Date.now() + ttlMs,
    isNegative: !!options.isNegative
  });
  schedulePersistedCacheWrite();
}

function isYouTubeQuotaError(payload) {
  const message = String(payload?.error?.message || "");
  const reasons = Array.isArray(payload?.error?.errors)
    ? payload.error.errors.map(err => String(err?.reason || "")).join(" ")
    : "";
  return /quota|dailyLimitExceeded|quotaExceeded|daily limit|get started/i.test(`${message} ${reasons}`);
}

function parseIso8601DurationToSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || "");
  if (!match) return 0;

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return (hours * 3600) + (minutes * 60) + seconds;
}

async function handleYouTubeSearch(req, reqUrl, res) {
  const query = reqUrl.searchParams.get("q") || "";
  const normalizedQuery = normalizeQuery(query);

  if (!YOUTUBE_API_KEY) {
    sendJson(req, res, 500, { error: { message: "Server is missing YOUTUBE_API_KEY." } });
    return;
  }

  if (normalizedQuery.length < SEARCH_MIN_QUERY_LENGTH) {
    sendJson(req, res, 400, { error: { message: `Search must be at least ${SEARCH_MIN_QUERY_LENGTH} characters.` } });
    return;
  }

  const cachedEntry = getCachedResults(normalizedQuery);
  if (cachedEntry) {
    sendJson(req, res, 200, {
      items: cachedEntry.items,
      cached: true,
      cachedNegative: !!cachedEntry.isNegative
    });
    return;
  }

  if (inFlightSearches.has(normalizedQuery)) {
    const sharedResult = await inFlightSearches.get(normalizedQuery);
    sendJson(req, res, sharedResult.statusCode, sharedResult.payload);
    return;
  }

  const searchPromise = (async () => {
    try {
      const estimatedCost = QUOTA_SEARCH_UNITS + QUOTA_DETAILS_UNITS;
      if (!canSpendEstimatedQuota(estimatedCost)) {
        return {
          statusCode: 429,
          payload: {
            error: {
              message: "YouTube search temporarily unavailable (daily quota guard active)."
            },
            quotaGuard: true
          }
        };
      }

      const apiUrl = new URL("https://www.googleapis.com/youtube/v3/search");
      apiUrl.searchParams.set("part", "snippet");
      apiUrl.searchParams.set("type", "video");
      apiUrl.searchParams.set("videoEmbeddable", "true");
      apiUrl.searchParams.set("videoCategoryId", MUSIC_CATEGORY_ID);
      apiUrl.searchParams.set("maxResults", String(SEARCH_FETCH_CANDIDATES));
      apiUrl.searchParams.set("q", query);
      apiUrl.searchParams.set("key", YOUTUBE_API_KEY);

      const searchResponse = await fetch(apiUrl);
      addEstimatedQuota(QUOTA_SEARCH_UNITS);
      const searchData = await searchResponse.json();

      if (!searchResponse.ok) {
        if (isYouTubeQuotaError(searchData)) {
          estimatedQuotaUnitsUsed = Math.max(estimatedQuotaUnitsUsed, QUOTA_GUARD_THRESHOLD_UNITS);
          schedulePersistedCacheWrite();
        }
        return {
          statusCode: searchResponse.status,
          payload: {
            error: { message: searchData?.error?.message || "YouTube search failed." }
          }
        };
      }

      const baseItems = (searchData.items || []).map(item => ({
        id: item.id?.videoId || "",
        title: item.snippet?.title || "",
        artist: item.snippet?.channelTitle || "",
        thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || ""
      })).filter(item => item.id);

      if (baseItems.length === 0) {
        setCachedResults(normalizedQuery, [], {
          ttlMs: NEGATIVE_CACHE_TTL_MS,
          isNegative: true
        });
        return {
          statusCode: 200,
          payload: { items: [], cached: false }
        };
      }

      const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
      detailsUrl.searchParams.set("part", "contentDetails,snippet,status");
      detailsUrl.searchParams.set("id", baseItems.map(item => item.id).join(","));
      detailsUrl.searchParams.set("key", YOUTUBE_API_KEY);

      const detailsResponse = await fetch(detailsUrl);
      addEstimatedQuota(QUOTA_DETAILS_UNITS);
      const detailsData = await detailsResponse.json();

      if (!detailsResponse.ok) {
        if (isYouTubeQuotaError(detailsData)) {
          estimatedQuotaUnitsUsed = Math.max(estimatedQuotaUnitsUsed, QUOTA_GUARD_THRESHOLD_UNITS);
          schedulePersistedCacheWrite();
        }
        return {
          statusCode: detailsResponse.status,
          payload: {
            error: { message: detailsData?.error?.message || "Could not validate YouTube results." }
          }
        };
      }

      const detailsById = new Map((detailsData.items || []).map(item => [item.id, item]));

      const items = baseItems
        .filter(item => {
          const details = detailsById.get(item.id);
          if (!details) return false;

          const categoryId = details.snippet?.categoryId || "";
          const durationSeconds = parseIso8601DurationToSeconds(details.contentDetails?.duration || "");
          const embeddable = details.status?.embeddable !== false;

          if (!embeddable) return false;
          if (categoryId !== MUSIC_CATEGORY_ID) return false;
          if (durationSeconds < MIN_VIDEO_DURATION_SECONDS) return false;
          if (durationSeconds > MAX_VIDEO_DURATION_SECONDS) return false;
          return true;
        })
        .slice(0, SEARCH_MAX_RESULTS)
        .map(item => ({
          youtubeVideoId: item.id,
          youtubeUrl: `https://www.youtube.com/watch?v=${item.id}`,
          title: item.title,
          artist: item.artist,
          thumbnailUrl: item.thumbnailUrl
        }));

      setCachedResults(normalizedQuery, items, {
        ttlMs: items.length > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS,
        isNegative: items.length === 0
      });

      return {
        statusCode: 200,
        payload: { items, cached: false }
      };
    } catch (error) {
      return {
        statusCode: 500,
        payload: {
          error: { message: error.message || "Unexpected server error." }
        }
      };
    }
  })();

  inFlightSearches.set(normalizedQuery, searchPromise);
  try {
    const result = await searchPromise;
    sendJson(req, res, result.statusCode, result.payload);
  } finally {
    inFlightSearches.delete(normalizedQuery);
  }
}

function handleHealth(req, res) {
  sendJson(req, res, 200, { ok: true });
}

function resolveFilePath(requestPath) {
  const safePath = path.normalize(requestPath).replace(/^([.][.][/\\])+/, "");
  const relativePath = safePath === "/" ? "index.html" : safePath.replace(/^[/\\]+/, "");
  const filePath = path.join(ROOT_DIR, relativePath);
  if (!filePath.startsWith(ROOT_DIR)) return null;
  return filePath;
}

function serveStatic(req, reqUrl, res) {
  const filePath = resolveFilePath(reqUrl.pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let finalPath = filePath;
  if (fs.existsSync(finalPath) && fs.statSync(finalPath).isDirectory()) {
    finalPath = path.join(finalPath, "index.html");
  }

  if (!fs.existsSync(finalPath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const ext = path.extname(finalPath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mimeType });
  fs.createReadStream(finalPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(req)
    });
    res.end();
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/health") {
    handleHealth(req, res);
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/youtube-search") {
    await handleYouTubeSearch(req, reqUrl, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, reqUrl, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  loadCacheFromDisk();
  resetQuotaIfDayRolled();
  console.log(`JamGuessr server running at http://localhost:${PORT}`);
  console.log(`YouTube quota guard threshold: ${QUOTA_GUARD_THRESHOLD_UNITS}/${QUOTA_DAILY_BUDGET_UNITS} units/day`);
  console.log(`Loaded persisted search cache entries: ${cache.size}`);
  if (!YOUTUBE_API_KEY) {
    console.warn("Warning: YOUTUBE_API_KEY is not set. /api/youtube-search will fail until you provide it.");
  }
  startCleanupWorker();
});
