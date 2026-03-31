const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SEARCH_MIN_QUERY_LENGTH = 4;
const SEARCH_MAX_RESULTS = 5;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ROOT_DIR = __dirname;

const cache = new Map();

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
    return null;
  }
  return cached.items;
}

function setCachedResults(query, items) {
  cache.set(query, {
    items,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

async function handleYouTubeSearch(reqUrl, res) {
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

  const cachedItems = getCachedResults(normalizedQuery);
  if (cachedItems) {
    sendJson(req, res, 200, { items: cachedItems, cached: true });
    return;
  }

  try {
    const apiUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    apiUrl.searchParams.set("part", "snippet");
    apiUrl.searchParams.set("type", "video");
    apiUrl.searchParams.set("videoEmbeddable", "true");
    apiUrl.searchParams.set("maxResults", String(SEARCH_MAX_RESULTS));
    apiUrl.searchParams.set("q", query);
    apiUrl.searchParams.set("key", YOUTUBE_API_KEY);

    const response = await fetch(apiUrl);
    const data = await response.json();

    if (!response.ok) {
      sendJson(req, res, response.status, {
        error: { message: data?.error?.message || "YouTube search failed." }
      });
      return;
    }

    const items = (data.items || []).map(item => ({
      youtubeVideoId: item.id?.videoId || "",
      youtubeUrl: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : "",
      title: item.snippet?.title || "",
      artist: item.snippet?.channelTitle || "",
      thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || ""
    })).filter(item => item.youtubeVideoId);

    setCachedResults(normalizedQuery, items);
    sendJson(req, res, 200, { items, cached: false });
  } catch (error) {
    sendJson(req, res, 500, { error: { message: error.message || "Unexpected server error." } });
  }
}

function resolveFilePath(requestPath) {
  const safePath = path.normalize(requestPath).replace(/^([.][.][/\\])+/, "");
  const relativePath = safePath === "/" ? "index.html" : safePath.replace(/^[/\\]+/, "");
  const filePath = path.join(ROOT_DIR, relativePath);
  if (!filePath.startsWith(ROOT_DIR)) return null;
  return filePath;
}

function serveStatic(reqUrl, res) {
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
  res.writeHead(200, {
    "Content-Type": mimeType,
    ...corsHeaders(req)
  });
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
  console.log(`JamGuessr server running at http://localhost:${PORT}`);
  if (!YOUTUBE_API_KEY) {
    console.warn("Warning: YOUTUBE_API_KEY is not set. /api/youtube-search will fail until you provide it.");
  }
});
