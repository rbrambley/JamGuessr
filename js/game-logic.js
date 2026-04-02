// -- View management -----------------------------------------------------------

function setView(id) {
  document.querySelectorAll(".view").forEach(v => v.style.display = "none");
  const target = document.getElementById(id);
  if (target) target.style.display = "block";
}

const STATUS_VIEW_ORDER = {
  lobby: ["view-lobby"],
  picking: ["view-lobby", "view-picking"],
  playing: ["view-picking", "view-playing"],
  scoring: ["view-playing", "view-reveal"],
  reveal: ["view-playing", "view-reveal"],
  finalizing: ["view-playing", "view-reveal", "view-final"],
  finished: ["view-playing", "view-reveal", "view-final"]
};

const CANONICAL_STATUS_VIEW = {
  lobby: "view-lobby",
  picking: "view-picking",
  playing: "view-playing",
  scoring: "view-reveal",
  reveal: "view-reveal",
  finalizing: "view-final",
  finished: "view-final"
};

let lastRoomStatus = null;

function getVisibleViewId() {
  const visible = document.querySelector(".view[style*='display: block']");
  return visible ? visible.id : null;
}

function updateMobileTabState(roomStatus, activeViewId) {
  const allowed = STATUS_VIEW_ORDER[roomStatus] || [];
  document.querySelectorAll(".mobile-tab").forEach(btn => {
    const viewId = btn.dataset.view;
    const isAllowed = allowed.includes(viewId);
    btn.disabled = !isAllowed;
    btn.classList.toggle("is-active", activeViewId === viewId);
  });
}

function resolveTargetView(roomStatus, currentVisibleViewId) {
  const allowed = STATUS_VIEW_ORDER[roomStatus] || [];
  const fallback = CANONICAL_STATUS_VIEW[roomStatus] || "view-lobby";

  if (!currentVisibleViewId) return fallback;
  if (allowed.includes(currentVisibleViewId)) return currentVisibleViewId;
  return fallback;
}

function renderViewById(viewId, room, isHost) {
  switch (viewId) {
    case "view-lobby":
      resetPickingView();
      renderLobby(players, room.code, isHost);
      break;
    case "view-picking":
      renderSongInputs(room.currentRound, room.maxRounds);
      break;
    case "view-playing":
      renderPlayingView(room, isHost);
      break;
    case "view-reveal":
      if (room.status === "scoring") {
        renderScoreProcessingView(room, isHost);
      } else {
        renderRevealView(room, isHost);
      }
      break;
    case "view-final":
      if (room.status === "finalizing") {
        renderFinalProcessingView(room, isHost);
      } else {
        renderFinalResults(players);
      }
      break;
    default:
      setView(CANONICAL_STATUS_VIEW[room.status] || "view-lobby");
      break;
  }
}

function setupMobileTabs() {
  const buttons = document.querySelectorAll(".mobile-tab");
  if (!buttons.length) return;

  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      if (!currentRoom || btn.disabled) return;

      const targetViewId = btn.dataset.view;
      if (!targetViewId) return;

      const me = players.find(p => p.id === currentPlayerId);
      const isHost = !!me?.isHost;

      setView(targetViewId);
      updateMobileTabState(currentRoom.status, targetViewId);
      renderViewById(targetViewId, currentRoom, isHost);
    });
  });
}

const POINTS_PER_CORRECT_GUESS = 1;
const POINTS_FOR_PICKER_REVEAL = 1;

let pickingSearchResults = [];
let pickingSelectedSong = null;
let lastPickingRound = null;

let ytApiPromise = null;
let ytPlayer = null;
let ytPlayerReady = false;
let ytPlayerInitPromise = null;
let playbackTimer = null;
let lastAppliedPlaybackVersion = null;
let lastPlaybackApplyAttemptAt = 0;
let lastLoadedVideoIdForPlayback = null;
let pausedHeartbeatDebounceTimer = null;
let hardStoppedVideoId = null;
let hardStoppedAtSec = 0;

const YOUTUBE_SEARCH_MIN_QUERY_LENGTH = 4;
const YOUTUBE_SEARCH_COOLDOWN_MS = 1000;
const YOUTUBE_SEARCH_MAX_RESULTS = 5;
const youtubeSearchCache = new Map();
let lastYouTubeSearchAt = 0;
const EMERGENCY_FALLBACK_SONGS = [
  { title: "Blinding Lights", artist: "The Weeknd", youtubeVideoId: "4NRXx6U8ABQ" },
  { title: "Levitating", artist: "Dua Lipa", youtubeVideoId: "TUVcZfQe-Kw" },
  { title: "Bad Guy", artist: "Billie Eilish", youtubeVideoId: "DyDfgMOUjCI" },
  { title: "Shape of You", artist: "Ed Sheeran", youtubeVideoId: "JGwWNGJdvx8" },
  { title: "Bohemian Rhapsody", artist: "Queen", youtubeVideoId: "fJ9rUzIMcZQ" },
  { title: "Don't Stop Believin'", artist: "Journey", youtubeVideoId: "1k8craCGpgs" },
  { title: "Livin' on a Prayer", artist: "Bon Jovi", youtubeVideoId: "lDK9QqIzhwk" },
  { title: "Numb", artist: "Linkin Park", youtubeVideoId: "kXYiU_JCYtU" },
  { title: "Mr. Brightside", artist: "The Killers", youtubeVideoId: "gGdGFtwCNBE" },
  { title: "HUMBLE.", artist: "Kendrick Lamar", youtubeVideoId: "tvTRZJ-4EyI" },
  { title: "Still D.R.E.", artist: "Dr. Dre", youtubeVideoId: "_CL6n0FJZpk" },
  { title: "One More Time", artist: "Daft Punk", youtubeVideoId: "FGBhQbmPwH8" },
  { title: "Summer", artist: "Calvin Harris", youtubeVideoId: "ebXbLfLACGM" },
  { title: "Levels", artist: "Avicii", youtubeVideoId: "_ovdm2yX4MA" },
  { title: "Take On Me", artist: "a-ha", youtubeVideoId: "djV11Xbc914" },
  { title: "Africa", artist: "Toto", youtubeVideoId: "FTQbiNvZqaY" },
  { title: "Dancing Queen", artist: "ABBA", youtubeVideoId: "xFrGuyw1V8s" },
  { title: "Dreams", artist: "Fleetwood Mac", youtubeVideoId: "mrZRURcb1cM" }
];
let didRedirectAfterRemoval = false;
let hasLoadedPlayersSnapshot = false;
let hasConfirmedPlayerPresence = false;
let hostAutoplayEnabled = false;
let autoplayAdvancePending = false;
let autoplaySyncedKey = "";

let revealRenderInFlight = false;
let revealScoresAppliedRound = -1;
let scoreFinalizeInFlight = false;
let finalFinalizeInFlight = false;
let lastRenderedRevealRound = -1;
let lastRenderedFinalSignature = "";
let presenceHeartbeatTimer = null;
let hostElectionTimer = null;
let lastSeenHostChangeAt = 0;
let isInitialRoomRender = true;
let hostPlaybackSyncTimer = null;
let clientPlaybackGuardTimer = null;
let hostPlaybackSyncInFlight = false;
let suppressHostPlaybackBroadcastUntil = 0;
let playbackReinforceTimer = null;
let lastPlaybackReinforceKey = "";
let audioUnlocked = false;
let allSubmissionsUnsub = null;
let lastAttemptedHostReclaimAt = 0;
let screenModeEnteredFullscreen = false;
let screenModeFullscreenAttemptedSongKey = "";
let lastClientGuardCorrectionAt = 0;
const CLIENT_DESYNC_RECOVERY_COOLDOWN_MS = 12000;
const PLAYBACK_TELEMETRY_MAX_EVENTS = 120;
let playbackTelemetryState = "idle";
let playbackTelemetrySongKey = "";

function getTelemetryPlayerLabel() {
  const me = players.find(p => p.id === currentPlayerId);
  return {
    id: currentPlayerId || "unknown",
    name: me?.name || "unknown",
    isHost: !!me?.isHost
  };
}

function getTelemetrySongKey(room = currentRoom) {
  if (!room) return "none";
  const playback = room.playback || null;
  const baseRound = playback?.round ?? room.currentRound ?? -1;
  const baseSongIndex = playback?.songIndex ?? room.currentSongIndex ?? -1;
  const videoId = playback?.videoId || lastLoadedVideoIdForPlayback || "none";
  return `${baseRound}:${baseSongIndex}:${videoId}`;
}

function logPlaybackTelemetry(nextState, details = {}) {
  const validStates = new Set(["ready", "playing", "blocked", "recovered"]);
  if (!validStates.has(nextState)) return;

  const songKey = getTelemetrySongKey(currentRoom);
  const prevState = playbackTelemetryState;
  const prevSongKey = playbackTelemetrySongKey;
  const isSameTransition = prevState === nextState && prevSongKey === songKey;
  if (isSameTransition) return;

  const player = getTelemetryPlayerLabel();
  const entry = {
    at: new Date().toISOString(),
    roomId: roomId || "unknown",
    roomCode: currentRoom?.code || "unknown",
    round: currentRoom?.currentRound ?? -1,
    songIndex: currentRoom?.currentSongIndex ?? -1,
    songKey,
    playerId: player.id,
    playerName: player.name,
    isHost: player.isHost,
    from: prevState,
    to: nextState,
    ...details
  };

  const store = (window.__jamPlaybackTelemetry = window.__jamPlaybackTelemetry || []);
  store.push(entry);
  if (store.length > PLAYBACK_TELEMETRY_MAX_EVENTS) {
    store.splice(0, store.length - PLAYBACK_TELEMETRY_MAX_EVENTS);
  }

  console.info("[PlaybackTelemetry]", entry);
  playbackTelemetryState = nextState;
  playbackTelemetrySongKey = songKey;
}

function markPlaybackPlaying(details = {}) {
  if (playbackTelemetryState === "blocked") {
    logPlaybackTelemetry("recovered", details);
    return;
  }
  logPlaybackTelemetry("playing", details);
}

// -- Room listeners ------------------------------------------------------------

function startListening() {
  db.collection("rooms").doc(roomId).onSnapshot(doc => {
    if (!doc.exists) {
      cleanupLocalGameState();
      alert("This room has been closed.");
      window.location.href = "index.html";
      return;
    }
    currentRoom = doc.data();
    handleRoomUpdate(currentRoom);
  });

  db.collection("rooms").doc(roomId).collection("players")
    .orderBy("joinedAt")
    .onSnapshot(snap => {
      hasLoadedPlayersSnapshot = true;
      players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (currentRoom) handleRoomUpdate(currentRoom);
    });

  db.collection("rooms").doc(roomId).collection("songs")
    .orderBy("addedAt", "asc")
    .onSnapshot(snap => {
      songs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (currentRoom) handleRoomUpdate(currentRoom);
    });

  db.collection("rooms").doc(roomId).collection("guesses")
    .onSnapshot(snap => {
      guesses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (currentRoom) handleRoomUpdate(currentRoom);
    });
}

function cleanupLocalGameState() {
  if (presenceHeartbeatTimer) {
    clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = null;
  }
  if (hostElectionTimer) {
    clearInterval(hostElectionTimer);
    hostElectionTimer = null;
  }
  if (hostPlaybackSyncTimer) {
    clearInterval(hostPlaybackSyncTimer);
    hostPlaybackSyncTimer = null;
  }
  if (clientPlaybackGuardTimer) {
    clearInterval(clientPlaybackGuardTimer);
    clientPlaybackGuardTimer = null;
  }
  if (pausedHeartbeatDebounceTimer) {
    clearTimeout(pausedHeartbeatDebounceTimer);
    pausedHeartbeatDebounceTimer = null;
  }
  if (allSubmissionsUnsub) {
    allSubmissionsUnsub();
    allSubmissionsUnsub = null;
  }
  stopYouTubePlayback();
  exitScreenFullscreenIfNeeded();
  unlockLandscapeIfSupported();
  screenModeFullscreenAttemptedSongKey = "";
  hardStoppedVideoId = null;
  hardStoppedAtSec = 0;
  lastLoadedVideoIdForPlayback = null;
  document.body.classList.remove("screen-device-mode");
  localStorage.removeItem("jamguessr_roomId");
  sessionStorage.removeItem("jamguessr_playerId");
}

function getCurrentHostPlayer() {
  return players.find(p => !!p.isHost) || null;
}

async function touchPlayerPresence() {
  if (!roomId || !currentPlayerId) return;
  try {
    await db.collection("rooms").doc(roomId)
      .collection("players").doc(currentPlayerId)
      .update({ lastSeen: Date.now() });
  } catch (e) {
    // Ignore best-effort heartbeat failures (player may have already left).
  }
}

async function ensureRoomHasActiveHost() {
  if (!roomId) return;
  try {
    await ensureActiveHost(roomId);
  } catch (e) {
    console.error("Host failover check failed", e);
  }
}

async function maybeReclaimHost(room) {
  if (!roomId || !currentPlayerId || !room?.lastHostChange?.changedAt) return;
  if (players.find(p => p.id === currentPlayerId)?.isHost) return;

  const hostChange = room.lastHostChange;
  if (hostChange.previousHostId !== currentPlayerId) return;
  if (!["host_disconnected", "host_missing"].includes(hostChange.reason)) return;
  if (hostChange.changedAt <= lastAttemptedHostReclaimAt) return;

  lastAttemptedHostReclaimAt = hostChange.changedAt;
  try {
    await reclaimHostIfEligible(roomId, currentPlayerId);
  } catch (e) {
    console.error("Host reclaim failed", e);
  }
}

function setupPresenceAndHostMonitoring() {
  touchPlayerPresence();
  ensureRoomHasActiveHost();

  if (!presenceHeartbeatTimer) {
    presenceHeartbeatTimer = setInterval(() => {
      touchPlayerPresence();
    }, 8000);
  }

  if (!hostElectionTimer) {
    hostElectionTimer = setInterval(() => {
      ensureRoomHasActiveHost();
    }, 10000);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      touchPlayerPresence();
      ensureRoomHasActiveHost();
      if (currentRoom) {
        maybeReclaimHost(currentRoom);
      }
    }
  });
}

function escapeHtml(value) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeYouTubeSearchQuery(query) {
  return (query || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function extractYouTubeVideoIdFromInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  // Accept direct 11-char IDs for quick manual fallback when API quota is exhausted.
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    const host = (parsed.hostname || "").toLowerCase();

    if (host.includes("youtube.com")) {
      if (parsed.pathname === "/watch") {
        const id = parsed.searchParams.get("v") || "";
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
      }

      if (parsed.pathname.startsWith("/shorts/")) {
        const id = parsed.pathname.split("/").filter(Boolean)[1] || "";
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
      }
    }

    if (host === "youtu.be") {
      const id = parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
    }
  } catch (e) {
    // Not a URL — caller handles as normal text query.
  }

  return "";
}

function buildManualSongSelectionFromVideoId(videoId) {
  return {
    youtubeVideoId: videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: `YouTube video (${videoId})`,
    artist: "Manual link",
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  };
}

function searchEmergencyFallbackSongs(query, maxResults = YOUTUBE_SEARCH_MAX_RESULTS) {
  const normalized = normalizeYouTubeSearchQuery(query);
  if (!normalized) return [];

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];

  const scored = EMERGENCY_FALLBACK_SONGS
    .map(song => {
      const haystack = normalizeYouTubeSearchQuery(`${song.title} ${song.artist}`);
      let score = 0;
      tokens.forEach(token => {
        if (haystack.includes(token)) score += 2;
      });
      if (haystack.includes(normalized)) score += 3;
      return { song, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(entry => ({
      youtubeVideoId: entry.song.youtubeVideoId,
      youtubeUrl: `https://www.youtube.com/watch?v=${entry.song.youtubeVideoId}`,
      title: entry.song.title,
      artist: entry.song.artist,
      thumbnailUrl: `https://i.ytimg.com/vi/${entry.song.youtubeVideoId}/hqdefault.jpg`
    }));

  return scored;
}

function buildSongDisplayCard(song, options = {}) {
  const card = document.createElement("div");
  card.className = "song-search-item song-display-card";
  if (options.selected) {
    card.classList.add("song-search-item-selected");
  }

  const thumb = document.createElement("img");
  thumb.className = "song-search-thumb";
  thumb.alt = "thumbnail";
  thumb.src = song?.thumbnailUrl || "https://i.ytimg.com/vi/default/hqdefault.jpg";
  card.appendChild(thumb);

  const meta = document.createElement("span");
  meta.className = "song-search-meta";

  const title = document.createElement("span");
  title.className = "song-search-title";
  title.textContent = song?.title || "Unknown Title";
  meta.appendChild(title);

  const channel = document.createElement("span");
  channel.className = "song-search-channel";
  channel.textContent = song?.artist || "Unknown Artist";
  meta.appendChild(channel);

  card.appendChild(meta);
  return card;
}

function clearPlaybackTimer() {
  if (playbackTimer) {
    clearTimeout(playbackTimer);
    playbackTimer = null;
  }
}

function stopYouTubePlayback() {
  clearPlaybackTimer();
  const unlockBtn = document.getElementById("audio-unlock-btn");
  if (unlockBtn) unlockBtn.style.display = "none";
  if (!ytPlayer || !ytPlayerReady) return;

  try {
    const currentVideoId = ytPlayer.getVideoData?.()?.video_id || lastLoadedVideoIdForPlayback;
    hardStoppedVideoId = currentVideoId || null;
    hardStoppedAtSec = Math.max(0, Number(ytPlayer.getCurrentTime?.() || 0));
    ytPlayer.pauseVideo();
    ytPlayer.stopVideo();
  } catch (e) {
    // Best-effort stop; player may not be ready during fast view transitions.
  }
}

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) {
    return Promise.resolve();
  }
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise(resolve => {
    const prior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prior === "function") prior();
      resolve();
    };

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
  });

  return ytApiPromise;
}

async function ensureYouTubePlayer() {
  const mount = document.getElementById("youtube-player");
  if (!mount) return null;
  if (ytPlayer && ytPlayerReady) return ytPlayer;

  // Guard against concurrent calls: if initialization is already in flight,
  // wait for it rather than spawning a second YT.Player on the same element.
  if (ytPlayerInitPromise) return ytPlayerInitPromise;

  ytPlayerInitPromise = (async () => {
    await loadYouTubeApi();

    await new Promise(resolve => {
      ytPlayer = new YT.Player("youtube-player", {
      width: "100%",
      height: "100%",
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1
      },
      events: {
        onReady: () => {
          ytPlayerReady = true;
          logPlaybackTelemetry("ready", { source: "yt-onReady" });
          resolve();
        },
        onStateChange: evt => {
          if (window.YT) {
            if (evt?.data === YT.PlayerState.PLAYING || evt?.data === YT.PlayerState.BUFFERING) {
              markPlaybackPlaying({ source: "yt-onStateChange", ytState: evt?.data });
              clearYouTubePlayerError();
            }
          }
          if (evt?.data === YT.PlayerState.ENDED) {
            handleHostAutoplayAdvance();
          }
          handleHostPlaybackStateChange(evt?.data);
        },
        onError: evt => {
          const code = evt?.data;
          const VIDEO_NOT_FOUND = 100;
          const EMBED_NOT_ALLOWED = 101;
          const EMBED_NOT_ALLOWED_DISGUISED = 150;
          const isEmbedError = code === EMBED_NOT_ALLOWED || code === EMBED_NOT_ALLOWED_DISGUISED;
          const isNotFound = code === VIDEO_NOT_FOUND;
          const videoId = lastLoadedVideoIdForPlayback || "unknown";
          const reason = isEmbedError ? "embed-not-allowed" : isNotFound ? "video-not-found" : `yt-error-${code}`;
          logPlaybackTelemetry("blocked", { source: "yt-onError", ytErrorCode: code, videoId, reason });
          const msg = isEmbedError
            ? "\u26a0\ufe0f This video can't be embedded. The host should pick a different upload."
            : isNotFound
              ? "\u26a0\ufe0f Video not found or unavailable."
              : `\u26a0\ufe0f YouTube playback error (code ${code}).`;
          showYouTubePlayerError(msg);
        }
      }
      });
    });

    ytPlayerInitPromise = null;
    return ytPlayer;
  })();

  return ytPlayerInitPromise;
}

function isCurrentPlayerHost() {
  const me = players.find(p => p.id === currentPlayerId);
  return !!me?.isHost;
}

function isScreenRole(player) {
  return (player?.role || "player") === "screen";
}

function getParticipatingPlayers() {
  return (players || []).filter(player => !isScreenRole(player));
}

function getGuessablePlayers() {
  return getParticipatingPlayers();
}

function isCurrentPlayerScreen() {
  const me = players.find(p => p.id === currentPlayerId);
  return isScreenRole(me);
}

function hasScreenPlaybackModeEnabled() {
  return (players || []).some(player => isScreenRole(player));
}

function shouldRenderPlaybackForCurrentClient() {
  if (!hasScreenPlaybackModeEnabled()) {
    return true;
  }
  return isCurrentPlayerScreen();
}

function isScreenPlaybackClient() {
  return hasScreenPlaybackModeEnabled() && isCurrentPlayerScreen();
}

function updateScreenDeviceLayoutState() {
  const isScreenClient = isScreenPlaybackClient();
  const isPortraitViewport = window.matchMedia("(orientation: portrait)").matches;
  const shouldRotateForCastMirror = isScreenClient && isPortraitViewport && !document.fullscreenElement;

  document.body.classList.toggle("screen-device-mode", isScreenClient);
  document.body.classList.toggle("screen-device-portrait-cast", shouldRotateForCastMirror);
}

async function lockLandscapeIfSupported() {
  try {
    if (screen?.orientation?.lock) {
      await screen.orientation.lock("landscape");
    }
  } catch (e) {
    // Orientation lock is optional and unsupported on many browsers/devices.
  }
}

function unlockLandscapeIfSupported() {
  try {
    if (screen?.orientation?.unlock) {
      screen.orientation.unlock();
    }
  } catch (e) {
    // Ignore best-effort cleanup failures.
  }
}

async function exitScreenFullscreenIfNeeded() {
  if (!screenModeEnteredFullscreen) return;
  if (!document.fullscreenElement) {
    screenModeEnteredFullscreen = false;
    return;
  }
  try {
    await document.exitFullscreen();
  } catch (e) {
    // Ignore if browser blocks non-gesture exit.
  } finally {
    screenModeEnteredFullscreen = false;
  }
}

async function maybeEnterFullscreenForScreenPlayback(room) {
  if (!isScreenPlaybackClient()) return;
  if (!room || room.status !== "playing" || room.allSongsPlayed) return;

  const songKey = getTelemetrySongKey(room);
  if (songKey === screenModeFullscreenAttemptedSongKey) return;
  screenModeFullscreenAttemptedSongKey = songKey;

  if (document.fullscreenElement) {
    screenModeEnteredFullscreen = true;
    await lockLandscapeIfSupported();
    return;
  }

  const shell = document.querySelector(".youtube-player-shell") || document.querySelector(".app-shell");
  const requestFullscreen = shell?.requestFullscreen?.bind(shell);
  if (!requestFullscreen) return;

  try {
    await requestFullscreen();
    screenModeEnteredFullscreen = true;
    await lockLandscapeIfSupported();
  } catch (e) {
    // Browsers often require a direct user gesture for fullscreen.
  }
}

function mapYouTubeStateToPlaybackStatus(ytState) {
  if (!window.YT) return "paused";
  if (ytState === YT.PlayerState.PLAYING || ytState === YT.PlayerState.BUFFERING) return "playing";
  return "paused";
}

async function broadcastHostPlaybackState(force = false) {
  if (!isCurrentPlayerHost()) return;
  if (!currentRoom || currentRoom.status !== "playing" || currentRoom.allSongsPlayed) return;
  if (!ytPlayer || !ytPlayerReady || hostPlaybackSyncInFlight) return;
  if (!force && Date.now() < suppressHostPlaybackBroadcastUntil) return;

  const roundSongs = getSongsForRound(currentRoom.currentRound);
  const song = roundSongs[currentRoom.currentSongIndex];
  if (!song?.youtubeVideoId) return;

  let playerState;
  let currentSec;
  try {
    playerState = ytPlayer.getPlayerState();
    currentSec = Math.max(0, Number(ytPlayer.getCurrentTime?.() || 0));
  } catch (e) {
    return;
  }

  const status = mapYouTubeStateToPlaybackStatus(playerState);

  // Don't immediately propagate a "paused" state from the periodic heartbeat —
  // YouTube pre/mid-roll ads make the host player appear paused even though
  // content is actively playing for everyone else.  Debounce it so a brief
  // interruption (e.g. a short ad transition) doesn't freeze all clients.
  // A force=true call (from onStateChange, i.e. the host clicking pause)
  // bypasses this and broadcasts immediately.
  if (status === "paused" && !force) {
    if (!pausedHeartbeatDebounceTimer) {
      pausedHeartbeatDebounceTimer = setTimeout(() => {
        pausedHeartbeatDebounceTimer = null;
        broadcastHostPlaybackState(true);
      }, 2500);
    }
    return;
  }

  // A "playing" broadcast cancels any pending debounced "paused" broadcast.
  if (pausedHeartbeatDebounceTimer) {
    clearTimeout(pausedHeartbeatDebounceTimer);
    pausedHeartbeatDebounceTimer = null;
  }

  const startAtMs = status === "playing"
    ? Date.now() - Math.floor(currentSec * 1000)
    : Date.now();

  hostPlaybackSyncInFlight = true;
  try {
    await syncRoomPlayback(roomId, {
      videoId: song.youtubeVideoId,
      round: currentRoom.currentRound,
      songIndex: currentRoom.currentSongIndex,
      status,
      pausedAtSec: currentSec,
      startAtMs,
      version: Date.now()
    });
  } catch (e) {
    console.error("Host playback sync failed", e);
  } finally {
    hostPlaybackSyncInFlight = false;
  }
}

function updateHostPlaybackSyncLoop(room, isHost) {
  const shouldRun =
    !!isHost &&
    shouldRenderPlaybackForCurrentClient() &&
    room?.status === "playing" &&
    !room?.allSongsPlayed;
  if (!shouldRun) {
    if (hostPlaybackSyncTimer) {
      clearInterval(hostPlaybackSyncTimer);
      hostPlaybackSyncTimer = null;
    }
    if (pausedHeartbeatDebounceTimer) {
      clearTimeout(pausedHeartbeatDebounceTimer);
      pausedHeartbeatDebounceTimer = null;
    }
    return;
  }

  if (hostPlaybackSyncTimer) return;

  hostPlaybackSyncTimer = setInterval(() => {
    broadcastHostPlaybackState(false);
  }, 3000);
}

async function guardClientPlaybackSync(room) {
  if (!room || isCurrentPlayerHost()) return;
  if (!shouldRenderPlaybackForCurrentClient()) return;
  if (room.status !== "playing" || room.allSongsPlayed) return;

  const playback = room.playback;
  if (!playback || playback.round !== room.currentRound || playback.songIndex !== room.currentSongIndex) return;

  if (!ytPlayer || !ytPlayerReady) {
    await applyRoomPlayback(room);
    return;
  }

  try {
    const now = Date.now();
    const playerState = ytPlayer.getPlayerState();
    const activeVideoId = ytPlayer.getVideoData?.()?.video_id || "";

    if (isScreenPlaybackClient()) {
      // For the designated screen client, avoid aggressive drift corrections
      // that can cause visible micro-seeks/choppiness. Only recover when the
      // wrong video is mounted or playback is clearly missing.
      const isPlayingState = window.YT && (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING);
      const sameExpectedVideo = activeVideoId === playback.videoId;
      const recentlyCorrected = (now - lastClientGuardCorrectionAt) < 12000;
      if ((!sameExpectedVideo || !isPlayingState) && !recentlyCorrected) {
        lastClientGuardCorrectionAt = now;
        await applyRoomPlayback(room);
      }
      return;
    }

    const actualSec = Math.max(0, Number(ytPlayer.getCurrentTime?.() || 0));
    const expectedSec = playback.status === "paused"
      ? Math.max(0, Number(playback.pausedAtSec || 0))
      : Math.max(0, (Date.now() - (playback.startAtMs || Date.now())) / 1000);
    const driftSec = Math.abs(actualSec - expectedSec);
    const shouldBePlaying = playback.status !== "paused";
    const isPlayingState = window.YT && (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING);
    const isPausedState = window.YT && playerState === YT.PlayerState.PAUSED;
    const sameExpectedVideo = activeVideoId === playback.videoId;
    const recentlyAppliedPlayback = (now - lastPlaybackApplyAttemptAt) < CLIENT_DESYNC_RECOVERY_COOLDOWN_MS;

    // Ads/transient YouTube states can look like a pause/desync even though the
    // right video is already mounted. Avoid repeatedly reloading the same video
    // during that window, which can trap clients in an ad refresh loop.
    if (shouldBePlaying && !isPlayingState && sameExpectedVideo && recentlyAppliedPlayback) {
      return;
    }

    const needsStateRecovery = (shouldBePlaying && !isPlayingState) || (!shouldBePlaying && !isPausedState);
    const needsDriftRecovery = shouldBePlaying && isPlayingState && driftSec > 4.5;
    const needsHardDriftRecovery = shouldBePlaying && driftSec > 7.0;
    const correctionCooldownMs = 9000;
    const recentlyCorrected = (now - lastClientGuardCorrectionAt) < correctionCooldownMs;

    if (needsStateRecovery || needsDriftRecovery || needsHardDriftRecovery) {
      if (!needsStateRecovery && !needsHardDriftRecovery && recentlyCorrected) {
        return;
      }

      if (shouldBePlaying) {
        logPlaybackTelemetry("blocked", {
          source: "client-guard",
          reason: !isPlayingState ? "not-playing" : (needsHardDriftRecovery ? "hard-drift" : "drift"),
          driftSec: Number(driftSec.toFixed(2)),
          activeVideoId,
          expectedVideoId: playback.videoId || "none"
        });
      }
      lastClientGuardCorrectionAt = now;
      await applyRoomPlayback(room);
      if (shouldBePlaying) {
        markPlaybackPlaying({ source: "client-guard-reapply" });
      }
    }
  } catch (e) {
    // Best-effort local correction only.
  }
}

function updateClientPlaybackGuardLoop(room, isHost) {
  const shouldRun =
    !isHost &&
    shouldRenderPlaybackForCurrentClient() &&
    room?.status === "playing" &&
    !room?.allSongsPlayed;
  if (!shouldRun) {
    if (clientPlaybackGuardTimer) {
      clearInterval(clientPlaybackGuardTimer);
      clientPlaybackGuardTimer = null;
    }
    return;
  }

  if (clientPlaybackGuardTimer) return;

  const guardIntervalMs = isScreenPlaybackClient() ? 2200 : 1000;
  clientPlaybackGuardTimer = setInterval(() => {
    guardClientPlaybackSync(currentRoom);
  }, guardIntervalMs);
}

function handleHostPlaybackStateChange(ytState) {
  if (!isCurrentPlayerHost()) return;
  if (!currentRoom || currentRoom.status !== "playing") return;
  if (Date.now() < suppressHostPlaybackBroadcastUntil) return;
  if (!window.YT) return;
  // Ignore transient states: UNSTARTED, CUED — only broadcast meaningful changes.
  const { UNSTARTED, CUED } = YT.PlayerState;
  if (ytState === UNSTARTED || ytState === CUED) return;

  broadcastHostPlaybackState(true);
}

async function handleHostAutoplayAdvance() {
  if (!hostAutoplayEnabled || autoplayAdvancePending) return;
  if (!currentRoom || currentRoom.status !== "playing" || currentRoom.allSongsPlayed) return;
  if (!isCurrentPlayerHost()) return;

  const roundSongs = getSongsForRound(currentRoom.currentRound);
  if (roundSongs.length === 0) return;

  autoplayAdvancePending = true;

  try {
    const nextIndex = currentRoom.currentSongIndex + 1;
    if (nextIndex < roundSongs.length) {
      await advanceSongForEveryone(currentRoom, nextIndex);
    } else {
      await markAllSongsPlayed(roomId);
    }
  } catch (e) {
    console.error("Autoplay advance failed", e);
  } finally {
    setTimeout(() => {
      autoplayAdvancePending = false;
    }, 500);
  }
}

async function applyRoomPlayback(room) {
  const statusEl = document.getElementById("youtube-player-status");
  const roundSongs = getSongsForRound(room.currentRound);
  const currentSong = roundSongs[room.currentSongIndex];

  if (!currentSong || !currentSong.youtubeVideoId) {
    if (statusEl) {
      statusEl.textContent = "No YouTube video selected for this song.";
    }
    return;
  }

  const playback = room.playback;
  if (!playback || playback.round !== room.currentRound || playback.songIndex !== room.currentSongIndex) {
    if (statusEl) {
      statusEl.textContent = "Waiting for host to start playback...";
    }
    return;
  }

  const samePlaybackVersion = playback.version && playback.version === lastAppliedPlaybackVersion;
  if (samePlaybackVersion && (Date.now() - lastPlaybackApplyAttemptAt) < 2500 && ytPlayer && ytPlayerReady) {
    let activeVideoId = "";
    let playerState = null;
    try {
      activeVideoId = ytPlayer.getVideoData?.()?.video_id || "";
      playerState = ytPlayer.getPlayerState?.();
    } catch (e) {
      // If probing player state fails, fall through and re-apply playback.
    }

    const isUnstarted = !!(window.YT && playerState === YT.PlayerState.UNSTARTED);
    const shouldForceRecovery = activeVideoId !== playback.videoId || isUnstarted;
    if (!shouldForceRecovery) {
      return;
    }
  }

  const player = await ensureYouTubePlayer();
  if (!player) return;

  clearPlaybackTimer();
  lastPlaybackApplyAttemptAt = Date.now();
  lastAppliedPlaybackVersion = playback.version;
  if (isCurrentPlayerHost()) {
    suppressHostPlaybackBroadcastUntil = Date.now() + 1600;
  }

  const now = Date.now();
  const status = playback.status || "playing";
  const startAtMs = playback.startAtMs || now;
  const elapsedSec = status === "paused"
    ? Math.max(0, Number(playback.pausedAtSec || 0))
    : Math.max(0, (now - startAtMs) / 1000);
  const delayMs = status === "paused" ? 0 : Math.max(0, startAtMs - now);

  if (statusEl) {
    if (status === "paused") {
      statusEl.textContent = "Paused by host";
    } else {
      statusEl.textContent = delayMs > 0
        ? `Starting in ${Math.ceil(delayMs / 1000)}...`
        : "Playing";
    }
  }

  // Only re-cue the player when the video actually changes.  Re-cueing the
  // same video forces a full reload cycle and calling playVideo() immediately
  // after is unreliable (the cue is async).  For same-video resumes/seeks —
  // which includes ad-end recovery — skip straight to seekTo + play/pause.
  const sameVideo = lastLoadedVideoIdForPlayback === playback.videoId;
  const activeVideoId = player.getVideoData?.()?.video_id || "";
  const forceLoadMissingVideo = sameVideo && activeVideoId !== playback.videoId;
  const isDirectRevealToPlaying = lastRoomStatus === "reveal" && room.status === "playing";
  const resumingHardStoppedSameVideo =
    isDirectRevealToPlaying && hardStoppedVideoId === playback.videoId;

  const shouldMuteForAutoplay = !isCurrentPlayerHost() && !audioUnlocked && !isScreenPlaybackClient();

  // If we hard-stopped on reveal/end and are resuming the same song, load it
  // directly at the synced position for a smoother return to playing.
  if (resumingHardStoppedSameVideo) {
    if (shouldMuteForAutoplay) player.mute();
    player.loadVideoById({
      videoId: playback.videoId,
      startSeconds: elapsedSec
    });
    lastLoadedVideoIdForPlayback = playback.videoId;
  }

  if ((!sameVideo || forceLoadMissingVideo) && !resumingHardStoppedSameVideo) {
    if (shouldMuteForAutoplay) player.mute();
    player.loadVideoById({
      videoId: playback.videoId,
      startSeconds: elapsedSec
    });
    lastLoadedVideoIdForPlayback = playback.videoId;
  }

  playbackTimer = setTimeout(() => {
    try {
      if (!sameVideo || resumingHardStoppedSameVideo || elapsedSec > 0.5) {
        player.seekTo(elapsedSec, true);
      }
      if (status === "paused") {
        player.pauseVideo();
      } else {
        if (isScreenPlaybackClient()) {
          try { player.unMute(); } catch (e) { /* best-effort */ }
        }
        player.playVideo();
        markPlaybackPlaying({ source: "applyRoomPlayback" });
      }
      if (statusEl && status === "playing") statusEl.textContent = "Playing";
      hardStoppedVideoId = null;
      hardStoppedAtSec = 0;
      if (!isCurrentPlayerHost()) showAudioUnlockButton(player);

      // Recovery path for rare clients that remain in an empty/unstarted iframe
      // after a sync pulse (observed in bot sessions under join/playback race).
      setTimeout(() => {
        try {
          const activeVideoId = player.getVideoData?.()?.video_id || "";
          const missingExpectedVideo = activeVideoId !== playback.videoId;
          const needsRecovery = missingExpectedVideo;

          if (!needsRecovery) return;

          if (!isCurrentPlayerHost() && !audioUnlocked) player.mute();
          player.loadVideoById({
            videoId: playback.videoId,
            startSeconds: elapsedSec
          });

          if (status === "paused") {
            player.pauseVideo();
          } else {
            player.playVideo();
            logPlaybackTelemetry("recovered", { source: "missing-video-recovery" });
          }
        } catch (e) {
          // Best-effort recovery only.
        }
      }, 1400);
    } catch (e) {
      logPlaybackTelemetry("blocked", {
        source: "applyRoomPlayback",
        reason: "playback-command-error",
        error: e?.message || String(e || "unknown")
      });
      if (statusEl) statusEl.textContent = "Playback blocked. Click player to start audio.";
    }
  }, delayMs);
}

function showYouTubePlayerError(message) {
  const statusEl = document.getElementById("youtube-player-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.add("youtube-player-status-error");
}

function clearYouTubePlayerError() {
  const statusEl = document.getElementById("youtube-player-status");
  if (!statusEl) return;
  statusEl.classList.remove("youtube-player-status-error");
}

function showAudioUnlockButton(player) {
  if (audioUnlocked) return;
  const btn = document.getElementById("audio-unlock-btn");
  if (!btn) return;
  btn.style.display = "block";
  if (isScreenPlaybackClient()) {
    btn.textContent = "Enable Sound (and Fullscreen)";
  }
  logPlaybackTelemetry("blocked", { source: "unlock-button", reason: "autoplay-policy" });
  btn.onclick = () => {
    audioUnlocked = true;
    btn.style.display = "none";
    try {
      player.unMute();
      const state = player.getPlayerState();
      if (state !== YT.PlayerState.PLAYING) player.playVideo();
      if (isScreenPlaybackClient()) {
        maybeEnterFullscreenForScreenPlayback(currentRoom);
      }
      logPlaybackTelemetry("recovered", { source: "unlock-button-click" });
    } catch (e) { /* ignore */ }
  };
}

async function syncSongForEveryone(room, songIndex, startDelayMs = 1200) {
  const roundSongs = getSongsForRound(room.currentRound);
  const song = roundSongs[songIndex];
  if (!song?.youtubeVideoId) return;
  const startAtMs = Date.now() + startDelayMs;

  // Load and play on the host's player directly — the host skips applyRoomPlayback
  // so their player must be started here as the source of truth.
  if (isCurrentPlayerHost()) {
    try {
      const player = await ensureYouTubePlayer();
      if (player) {
        // Suppress broadcast until after the video starts, otherwise the
        // pre-play CUED/PAUSED state would overwrite the "playing" Firestore doc.
        suppressHostPlaybackBroadcastUntil = Date.now() + startDelayMs + 2000;
        player.loadVideoById({ videoId: song.youtubeVideoId, startSeconds: 0 });
      }
    } catch (e) {
      console.error("Host player load failed:", e);
    }
  }

  await syncRoomPlayback(roomId, {
    videoId: song.youtubeVideoId,
    round: room.currentRound,
    songIndex,
    status: "playing",
    startAtMs,
    version: Date.now()
  });

  // One-shot reinforcement broadcast: helps slower clients that were still
  // mounting player UI when the first playback version arrived.
  const reinforceKey = `${room.currentRound}:${songIndex}:${song.youtubeVideoId}:${startAtMs}`;
  if (lastPlaybackReinforceKey !== reinforceKey) {
    lastPlaybackReinforceKey = reinforceKey;
    if (playbackReinforceTimer) {
      clearTimeout(playbackReinforceTimer);
      playbackReinforceTimer = null;
    }
    playbackReinforceTimer = setTimeout(async () => {
      playbackReinforceTimer = null;
      try {
        if (!currentRoom || currentRoom.status !== "playing" || currentRoom.currentRound !== room.currentRound) return;
        await syncRoomPlayback(roomId, {
          videoId: song.youtubeVideoId,
          round: room.currentRound,
          songIndex,
          status: "playing",
          startAtMs,
          version: Date.now()
        });
      } catch (e) {
        console.error("Playback reinforcement failed", e);
      }
    }, startDelayMs + 1800);
  }
}

async function advanceSongForEveryone(room, nextIndex) {
  await advanceSong(roomId, nextIndex);
  const roomForSync = currentRoom || room;
  await syncSongForEveryone(roomForSync, nextIndex, 1200);
}

// -- Routing by room status ----------------------------------------------------

function handleRoomUpdate(room) {
  const me = players.find(p => p.id === currentPlayerId);
  if (!me) {
    if (!hasLoadedPlayersSnapshot || !hasConfirmedPlayerPresence) {
      return;
    }

    if (!didRedirectAfterRemoval) {
      didRedirectAfterRemoval = true;
      cleanupLocalGameState();
      alert("You were removed from this room.");
      window.location.href = "index.html";
    }
    return;
  }

  hasConfirmedPlayerPresence = true;

  const hostChange = room.lastHostChange;
  if (hostChange?.changedAt && hostChange.changedAt > lastSeenHostChangeAt) {
    if (!isInitialRoomRender) {
      if (hostChange.reason === "host_reclaimed") {
        if (hostChange.hostId === currentPlayerId) {
          alert("Host controls returned to you.");
        } else {
          const nextHostName = hostChange.hostName || "A player";
          alert(`${nextHostName} reclaimed host controls.`);
        }
      } else if (hostChange.hostId === currentPlayerId) {
        alert("The previous host left or disconnected. You are now the host.");
      } else {
        const nextHostName = hostChange.hostName || "A player";
        alert(`The previous host left or disconnected. ${nextHostName} is now the host.`);
      }
    }
    lastSeenHostChangeAt = hostChange.changedAt;
  }

  currentRoom = room;
  updateScreenDeviceLayoutState();
  maybeReclaimHost(room);
  const isHost = !!me.isHost;

  if (room.status !== "reveal") {
    revealScoresAppliedRound = -1;
    lastRenderedRevealRound = -1;
  }

  if (room.status !== "finished") {
    lastRenderedFinalSignature = "";
  }

  if (room.status === "scoring") {
    maybeFinalizeRoundScoring(room, isHost);
  }

  if (room.status === "finalizing") {
    maybeFinalizeGameResults(room, isHost);
  }

  updateHostPlaybackSyncLoop(room, isHost);
  updateClientPlaybackGuardLoop(room, isHost);

  if (room.status !== "playing") {
    stopYouTubePlayback();
    exitScreenFullscreenIfNeeded();
    unlockLandscapeIfSupported();
    screenModeFullscreenAttemptedSongKey = "";
    playbackTelemetryState = "idle";
    playbackTelemetrySongKey = "";
  }

  renderMetaPanel(room);

  if (room.status === "playing") {
    renderHostPlayingControls(room, isHost);
  } else {
    const hc = document.getElementById("host-controls-inline");
    if (hc) hc.innerHTML = "";
  }

  const visibleViewId = getVisibleViewId();
  const statusChanged = room.status !== lastRoomStatus;
  const targetViewId = statusChanged
    ? (CANONICAL_STATUS_VIEW[room.status] || "view-lobby")
    : resolveTargetView(room.status, visibleViewId);

  setView(targetViewId);
  updateMobileTabState(room.status, targetViewId);

  // Don't re-render the pick screen while the user is actively searching —
  // it would wipe the input. Only skip when the view isn't changing.
  const pickScreenActive = targetViewId === "view-picking" && !statusChanged;
  const userTypingInSearch = pickScreenActive &&
    document.activeElement?.id === "song-search-query";
  const searchHasText = pickScreenActive &&
    (document.getElementById("song-search-query")?.value || "").length > 0;

  if (!pickScreenActive || (!userTypingInSearch && !searchHasText)) {
    renderViewById(targetViewId, room, isHost);
  }

  if (room.status === "playing") {
    maybeEnterFullscreenForScreenPlayback(room);
  }

  updateScreenDeviceLayoutState();

  lastRoomStatus = room.status;
  isInitialRoomRender = false;
}

function resetPickingView() {
  const songInputs = document.getElementById("song-inputs");
  if (songInputs) songInputs.innerHTML = "";

  const submitBtn = document.getElementById("submit-songs-btn");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.style.display = "block";
  }

  const waitingMsg = document.getElementById("waiting-msg");
  if (waitingMsg) waitingMsg.style.display = "none";
}

// -- Meta panel ----------------------------------------------------------------

function renderMetaPanel(room) {
  const me = players.find(p => p.id === currentPlayerId);
  const isHost = !!me?.isHost;
  const minimumPlayers = 2;
  const participatingPlayers = getParticipatingPlayers();
  const playerCount = participatingPlayers.length;
  const screenCount = Math.max(0, players.length - playerCount);
  const playerNameEl = document.getElementById("player-name-display");
  if (playerNameEl) {
    playerNameEl.textContent = "";
  }

  const roundEl = document.getElementById("round-display");
  if (roundEl) {
    if (room.status === "finished") {
      roundEl.textContent = "GAME OVER";
      roundEl.style.color = "#f87171";
    } else if (room.status === "playing") {
      const roundSongs = getSongsForRound(room.currentRound);
      const songCount = Math.max(roundSongs.length, playerCount);
      const songIdx = room.allSongsPlayed ? songCount : Math.min(room.currentSongIndex + 1, songCount);
      roundEl.textContent = `Round ${room.currentRound} of ${room.maxRounds} • Song ${songIdx} of ${songCount}`;
      roundEl.style.color = "";
    } else if (room.status === "reveal") {
      roundEl.textContent = `Round ${room.currentRound} of ${room.maxRounds} • Reveal`;
      roundEl.style.color = "";
    } else if (room.status === "scoring") {
      roundEl.textContent = `Round ${room.currentRound} of ${room.maxRounds} • Scoring`;
      roundEl.style.color = "";
    } else {
      roundEl.textContent = `Round ${room.currentRound} of ${room.maxRounds} • ${room.status === "lobby" ? "Lobby" : "Song Selection"}`;
      roundEl.style.color = "";
    }
  }

  const pointsEl = document.getElementById("points-display");
  if (pointsEl) {
    if (room.status === "lobby") {
      pointsEl.classList.add("meta-status-compact");
      const needed = Math.max(0, minimumPlayers - playerCount);
      const screenSuffix = screenCount > 0 ? ` (+${screenCount} screen${screenCount === 1 ? "" : "s"})` : "";
      if (needed > 0) {
        pointsEl.textContent = `${playerCount}/${minimumPlayers} players ready${screenSuffix} • ${needed} more needed`;
      } else if (isHost) {
        pointsEl.textContent = `${playerCount} players ready${screenSuffix} • ready to start`;
      } else {
        pointsEl.textContent = `${playerCount} players ready${screenSuffix} • waiting on host`;
      }
    } else {
      pointsEl.classList.remove("meta-status-compact");
      pointsEl.textContent = "";
    }
  }

  const metaLabelEl = document.querySelector("#game-meta .meta-label");
  if (metaLabelEl) {
    metaLabelEl.textContent = "Match status";
  }

  const buttonRow = document.getElementById("all-player-buttons");
  const hostActions = document.getElementById("meta-host-actions");
  if (!buttonRow || !hostActions) return;

  buttonRow.innerHTML = "";
  const isFinished = room.status === "finished";
  const winner = isFinished ? [...participatingPlayers].sort((a, b) => b.score - a.score)[0] : null;

  // Compute per-player round deltas to highlight on chips during reveal
  const roundDeltas = new Map();
  if (room.status === "reveal") {
    const revealRoundSongs = getSongsForRound(room.currentRound);
    participatingPlayers.forEach(p => roundDeltas.set(p.id, 0));
    revealRoundSongs.forEach(song => {
      if (roundDeltas.has(song.pickedBy)) {
        roundDeltas.set(song.pickedBy, (roundDeltas.get(song.pickedBy) || 0) + POINTS_FOR_PICKER_REVEAL);
      }
      guesses.forEach(g => {
        if (g.songId === song.id && g.guessedPlayerId === song.pickedBy && g.guessedBy !== song.pickedBy) {
          roundDeltas.set(g.guessedBy, (roundDeltas.get(g.guessedBy) || 0) + POINTS_PER_CORRECT_GUESS);
        }
      });
    });
  }

  participatingPlayers.forEach(p => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary-btn player-chip";

    const trophy = isFinished && winner && p.id === winner.id ? " 🏆" : "";

    const score = document.createElement("span");
    score.className = "player-pill-score";
    score.textContent = `${p.score || 0} pts`;

    const name = document.createElement("span");
    name.className = "player-pill-name";
    name.textContent = p.name + (p.id === currentPlayerId ? " (You)" : "") + trophy;

    btn.appendChild(score);
    btn.appendChild(name);

    if (roundDeltas.size > 0) {
      const delta = roundDeltas.get(p.id) || 0;
      if (delta > 0) {
        const badge = document.createElement("span");
        badge.className = "player-pill-delta";
        badge.textContent = `+${delta}`;
        btn.appendChild(badge);
        btn.classList.add("player-chip-scoring");
      }
    }

    btn.disabled = true;
    if (p.id === currentPlayerId) btn.classList.add("player-chip-active");
    if (trophy) btn.classList.add("player-chip-winner");

    buttonRow.appendChild(btn);
  });

  hostActions.innerHTML = "";
  if (!isHost || room.status === "finished") return;

  if (room.status === "reveal") {
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "host-btn compact-control-btn meta-action-btn";
    if (room.currentRound < room.maxRounds) {
      nextBtn.textContent = "Next Round";
      nextBtn.onclick = () => nextRound(roomId, room.currentRound + 1);
    } else {
      nextBtn.textContent = "Finish Game";
      nextBtn.onclick = () => finishGame(roomId);
    }
    hostActions.appendChild(nextBtn);
  }

  if (room.status === "lobby") {
    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "host-btn compact-control-btn meta-action-btn";
    startBtn.disabled = playerCount < minimumPlayers;
    startBtn.textContent = playerCount < minimumPlayers ? `Need ${minimumPlayers} Players` : "Start Round 1";
    startBtn.onclick = () => {
      if (playerCount < minimumPlayers) {
        alert("Need at least 2 players to start.");
        return;
      }
      startGame(roomId);
    };
    hostActions.appendChild(startBtn);
  }

  const endBtn = document.createElement("button");
  endBtn.type = "button";
  endBtn.className = "secondary-btn danger-btn compact-control-btn meta-action-btn";
  endBtn.textContent = "End Match";
  endBtn.onclick = async () => {
    const ok = confirm("End this match for all players and close the room?");
    if (!ok) return;

    endBtn.disabled = true;
    try {
      await closeRoom(roomId);
      cleanupLocalGameState();
      window.location.href = "index.html";
    } catch (e) {
      alert("Could not end game: " + (e?.message || "unknown error"));
      endBtn.disabled = false;
    }
  };

  hostActions.appendChild(endBtn);
}

// -- Picking phase -------------------------------------------------------------

function renderSongInputs(currentRound, maxRounds) {
  const container = document.getElementById("song-inputs");
  if (!container) return;

  const me = players.find(p => p.id === currentPlayerId);
  if (isScreenRole(me)) {
    container.innerHTML = `
      <div class="playlist-song-note">
        Screen mode is active on this device. Song picking is disabled here, but playback stays synced.
      </div>
    `;

    const submitBtn = document.getElementById("submit-songs-btn");
    if (submitBtn) submitBtn.style.display = "none";

    const waitingMsg = document.getElementById("waiting-msg");
    if (waitingMsg) {
      waitingMsg.style.display = "none";
      waitingMsg.textContent = "";
    }
    return;
  }

  if (lastPickingRound !== currentRound) {
    pickingSearchResults = [];
    pickingSelectedSong = null;
    lastPickingRound = currentRound;
  }

  container.innerHTML = `
    <div id="song-search-block">
      <div class="song-row">
        <span>Round ${currentRound}/${maxRounds}:</span>
        <div class="song-search-row" style="width:100%">
          <input id="song-search-query" placeholder="Search YouTube song title + artist" required>
          <button id="song-search-btn" type="button" class="secondary-btn">Search</button>
        </div>
      </div>
      <div id="song-search-results" class="song-search-results"></div>
    </div>
    <div id="song-search-selected" class="song-search-selected"></div>
  `;

  const searchBlockEl = document.getElementById("song-search-block");
  const resultsEl = document.getElementById("song-search-results");
  const selectedEl = document.getElementById("song-search-selected");
  const queryEl = document.getElementById("song-search-query");
  const searchBtn = document.getElementById("song-search-btn");

  function renderSelectedSong() {
    if (!selectedEl || !searchBlockEl) return;

    selectedEl.innerHTML = "";
    if (!pickingSelectedSong) {
      searchBlockEl.style.display = "block";
      return;
    }

    const selectedCard = buildSongDisplayCard(pickingSelectedSong, { selected: true });

    const changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.className = "secondary-btn song-change-selection-btn";
    changeBtn.textContent = "Change Selection";
    changeBtn.onclick = () => {
      searchBlockEl.style.display = "block";
      selectedEl.innerHTML = "";
      const submitButton = document.getElementById("submit-songs-btn");
      if (submitButton) submitButton.disabled = false;
      queryEl?.focus();
    };

    selectedEl.appendChild(selectedCard);
    selectedEl.appendChild(changeBtn);
    searchBlockEl.style.display = "none";
  }

  if (pickingSelectedSong) {
    renderSelectedSong();
  }

  function selectSearchResult(item, btnEl) {
    pickingSelectedSong = item;
    renderSelectedSong();
    document.querySelectorAll(".song-search-item").forEach(el => el.classList.remove("song-search-item-selected"));
    if (btnEl) btnEl.classList.add("song-search-item-selected");
    const submitButton = document.getElementById("submit-songs-btn");
    if (submitButton) submitButton.disabled = false;
  }

  function renderSearchResults() {
    if (!resultsEl) return;
    resultsEl.innerHTML = "";
    pickingSearchResults.forEach(item => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "song-search-item secondary-btn";
      btn.innerHTML = `
        <img class="song-search-thumb" src="${escapeHtml(item.thumbnailUrl)}" alt="thumbnail">
        <span class="song-search-meta">
          <span class="song-search-title">${escapeHtml(item.title)}</span>
          <span class="song-search-channel">${escapeHtml(item.artist)}</span>
        </span>
      `;
      if (pickingSelectedSong?.youtubeVideoId === item.youtubeVideoId) {
        btn.classList.add("song-search-item-selected");
      }
      btn.onclick = () => selectSearchResult(item, btn);
      resultsEl.appendChild(btn);
    });
  }

  async function runSearch() {
    const q = queryEl?.value.trim();
    if (!q) return;

    const manualVideoId = extractYouTubeVideoIdFromInput(q);
    if (manualVideoId) {
      pickingSearchResults = [buildManualSongSelectionFromVideoId(manualVideoId)];
      youtubeSearchCache.set(normalizeYouTubeSearchQuery(q), pickingSearchResults);
      renderSearchResults();
      return;
    }

    if (q.length < YOUTUBE_SEARCH_MIN_QUERY_LENGTH) {
      alert(`Search must be at least ${YOUTUBE_SEARCH_MIN_QUERY_LENGTH} characters.`);
      return;
    }
    if (!YOUTUBE_SEARCH_ENDPOINT) {
      alert("Missing YouTube search endpoint configuration.");
      return;
    }

    const normalizedQuery = normalizeYouTubeSearchQuery(q);
    const now = Date.now();
    if (now - lastYouTubeSearchAt < YOUTUBE_SEARCH_COOLDOWN_MS) {
      alert("Please wait a moment before searching again.");
      return;
    }

    if (youtubeSearchCache.has(normalizedQuery)) {
      pickingSearchResults = youtubeSearchCache.get(normalizedQuery);
      renderSearchResults();
      if (pickingSearchResults.length === 0) {
        alert("No results found. Try a different search.");
      }
      return;
    }

    lastYouTubeSearchAt = now;

    searchBtn.disabled = true;
    searchBtn.textContent = "Searching...";
    try {
      const endpointUrl = `${YOUTUBE_SEARCH_ENDPOINT}?q=${encodeURIComponent(q)}`;
      let data = null;
      let found = false;

      for (let attempt = 1; attempt <= 2; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);

        try {
          const resp = await fetch(endpointUrl, { signal: controller.signal });
          const payload = await resp.json().catch(() => ({}));

          if (resp.ok) {
            data = payload;
            found = true;
            break;
          }

          const shouldRetry = resp.status >= 500 && attempt < 2;
          if (!shouldRetry) {
            throw new Error(payload?.error?.message || `Search failed (${resp.status})`);
          }
        } catch (err) {
          const canRetry = attempt < 2;
          if (!canRetry) {
            throw err;
          }
        } finally {
          clearTimeout(timeoutId);
        }

        searchBtn.textContent = "Waking server...";
        await new Promise(resolve => setTimeout(resolve, 1200));
        searchBtn.textContent = "Searching...";
      }

      if (!found || !data) {
        throw new Error("Search failed after retry.");
      }

      pickingSearchResults = data.items || [];
      youtubeSearchCache.set(normalizedQuery, pickingSearchResults);
      renderSearchResults();
      if (pickingSearchResults.length === 0) {
        alert("No results found. Try a different search.");
      }
    } catch (e) {
      const message = e?.message || "YouTube search error";
      const isQuotaError = /quota|daily limit|quotaExceeded|get started/i.test(message);
      if (isQuotaError) {
        const fallbackResults = searchEmergencyFallbackSongs(q);
        if (fallbackResults.length > 0) {
          pickingSearchResults = fallbackResults;
          youtubeSearchCache.set(normalizedQuery, pickingSearchResults);
          renderSearchResults();
          alert("YouTube search quota is exhausted right now. Showing in-game fallback song matches so the round can continue.");
        } else {
          alert("YouTube search quota is exhausted right now, and no fallback matches were found for that query. Try searching by artist/title keywords.");
        }
      } else {
        alert(message);
      }
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = "Search";
    }
  }

  searchBtn.onclick = runSearch;
  queryEl?.addEventListener("keydown", evt => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      runSearch();
    }
  });

  renderSearchResults();

  const submitBtn = document.getElementById("submit-songs-btn");
  submitBtn.disabled = !pickingSelectedSong;
  submitBtn.style.display = "block";

  const waitingMsg = document.getElementById("waiting-msg");
  waitingMsg.style.display = "none";

  if (me?.submitted) {
    const isHost = !!me?.isHost;
    if (isHost) watchForAllSubmissions();

    submitBtn.style.display = "none";
    waitingMsg.style.display = "block";
    waitingMsg.textContent = "Waiting for other players to submit this round's song...";

    if (searchBlockEl) searchBlockEl.style.display = "none";

    const myRoundSong = getSongsForRound(currentRound).find(song => song.pickedBy === currentPlayerId) || pickingSelectedSong;
    if (selectedEl) {
      if (myRoundSong?.title) {
        selectedEl.innerHTML = "";
        selectedEl.appendChild(buildSongDisplayCard(myRoundSong, { selected: true }));
      } else {
        selectedEl.innerHTML = "";
      }
    }
    return;
  }

  submitBtn.onclick = async () => {
    if (!pickingSelectedSong || !pickingSelectedSong.youtubeVideoId) {
      alert("Search and select a YouTube track before submitting.");
      return;
    }

    submitBtn.disabled = true;
    try {
      await submitSongs(roomId, currentPlayerId, [pickingSelectedSong], currentRound);

      submitBtn.style.display = "none";
      waitingMsg.style.display = "block";
      waitingMsg.textContent = "Waiting for other players to submit this round's song...";
      if (searchBlockEl) searchBlockEl.style.display = "none";
      pickingSearchResults = [];
      renderSelectedSong();

      const isHost = players.find(p => p.id === currentPlayerId)?.isHost;
      if (isHost) watchForAllSubmissions();
    } catch (e) {
      submitBtn.disabled = false;
      alert(e?.message || "Could not submit your song.");
    }
  };
}

function watchForAllSubmissions() {
  if (allSubmissionsUnsub) return;

  allSubmissionsUnsub = db.collection("rooms").doc(roomId).collection("players")
    .onSnapshot(snap => {
      const all = snap.docs.map(d => d.data());
      const participants = all.filter(player => (player?.role || "player") !== "screen");
      if (participants.length > 0 && participants.every(player => !!player.submitted)) {
        if (allSubmissionsUnsub) {
          allSubmissionsUnsub();
          allSubmissionsUnsub = null;
        }
        startPlaying(roomId).catch(e => {
          console.error("Failed to start playing phase:", e);
        });
      }
    });
}

// -- Playing phase -------------------------------------------------------------

function getDeterministicOrderKey(song, roundNumber) {
  const seed = `${roomId}|${roundNumber}|${song.id}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getSongsForRound(roundNumber) {
  return (songs || [])
    .filter(s => s.round === roundNumber)
    .sort((a, b) => {
      const keyA = getDeterministicOrderKey(a, roundNumber);
      const keyB = getDeterministicOrderKey(b, roundNumber);
      if (keyA !== keyB) return keyA - keyB;
      return a.addedAt - b.addedAt;
    });
}

function getPlayedSongsForRound(room) {
  const roundSongs = getSongsForRound(room.currentRound);
  const playedCount = room.allSongsPlayed
    ? roundSongs.length
    : Math.min(room.currentSongIndex + 1, roundSongs.length);
  return roundSongs.slice(0, playedCount);
}

function hasStartedPlaybackForCurrentSong(room) {
  const playback = room?.playback;
  if (!playback) return false;
  if (playback.round !== room.currentRound) return false;
  if (playback.songIndex !== room.currentSongIndex) return false;
  return !!playback.videoId;
}

function renderPlayingView(room, isHost) {
  const isScreenMode = isCurrentPlayerScreen();
  const shouldRenderPlayback = shouldRenderPlaybackForCurrentClient();
  const guessHint = document.querySelector(".guess-hint");
  if (guessHint) {
    guessHint.style.display = isScreenMode ? "none" : "block";
  }

  const playerShell = document.querySelector(".youtube-player-shell");
  if (playerShell) {
    playerShell.style.display = shouldRenderPlayback ? "block" : "none";
  }

  if (!shouldRenderPlayback) {
    stopYouTubePlayback();
    const statusEl = document.getElementById("youtube-player-status");
    if (statusEl) {
      statusEl.textContent = "Playback is on the room screen device. Use this device for guessing only.";
    }
  }

  renderNowPlayingBanner(room);
  renderMasterPlaylist(room, isScreenMode);
  setYouTubeInteractionLock(isHost);
  // Host controls their own player directly — applying their own Firestore
  // broadcast would re-cue the video every 3s and interrupt playback.
  if (!isHost && shouldRenderPlayback) {
    applyRoomPlayback(room);
  }
}

function setYouTubeInteractionLock(isHost) {
  const shell = document.querySelector(".youtube-player-shell");
  if (!shell) return;

  shell.classList.toggle("youtube-player-locked", false);

  const statusEl = document.getElementById("youtube-player-status");
  if (!statusEl) return;

  if (!isHost && !statusEl.textContent) {
    statusEl.textContent = "Playback follows the host. You can skip ads; local scrubs will snap back.";
  }
}

function renderNowPlayingBanner(room) {
  const banner = document.getElementById("now-playing-banner");
  if (!banner) return;

  const roundSongs = getSongsForRound(room.currentRound);
  if (roundSongs.length === 0) {
    banner.textContent = "Waiting for songs to load...";
    return;
  }

  if (room.allSongsPlayed) {
    banner.innerHTML = `<span class="all-songs-done">Round songs finished. Finalize guesses to reveal results.</span>`;
    return;
  }

  const currentSong = roundSongs[room.currentSongIndex];
  if (!currentSong) {
    banner.textContent = "Waiting for next song...";
    return;
  }

  if (!hasStartedPlaybackForCurrentSong(room)) {
    banner.textContent = "Host has not started this song yet.";
    const statusEl = document.getElementById("youtube-player-status");
    if (statusEl) statusEl.textContent = "Waiting for host to start playback...";
    return;
  }

  banner.innerHTML = `<span class="now-playing-label">Now Playing:</span> <strong>${currentSong.title}</strong>${currentSong.artist ? " - " + currentSong.artist : ""}`;

  const statusEl = document.getElementById("youtube-player-status");
  if (statusEl) {
    statusEl.textContent = currentSong.youtubeVideoId
      ? (hasScreenPlaybackModeEnabled()
        ? "Ready to play on the screen device."
        : "Ready to play on all clients.")
      : "No YouTube video selected for this song.";
  }
}

function renderMasterPlaylist(room, isScreenMode = false) {
  const container = document.getElementById("playlist-songs");
  if (!container) return;
  container.innerHTML = "";

  const guessablePlayers = getGuessablePlayers();

  const currentSongStarted = hasStartedPlaybackForCurrentSong(room);

  const visibleSongs = (songs || [])
    .filter(song => {
      if (song.round < room.currentRound) return true;
      if (song.round > room.currentRound) return false;
      const roundSongs = getSongsForRound(room.currentRound);
      const indexInRound = roundSongs.findIndex(s => s.id === song.id);
      const playedCount = room.allSongsPlayed
        ? roundSongs.length
        : (currentSongStarted ? room.currentSongIndex + 1 : 0);
      return indexInRound > -1 && indexInRound < playedCount;
    })
    .sort((a, b) => {
      if (a.round !== b.round) return a.round - b.round;
      return a.addedAt - b.addedAt;
    });

  const groupedByRound = new Map();
  visibleSongs.forEach(song => {
    if (!groupedByRound.has(song.round)) {
      groupedByRound.set(song.round, []);
    }
    groupedByRound.get(song.round).push(song);
  });

  const sortedRounds = [...groupedByRound.keys()].sort((a, b) => {
    if (a === room.currentRound && b !== room.currentRound) return -1;
    if (b === room.currentRound && a !== room.currentRound) return 1;
    return b - a;
  });

  sortedRounds.forEach(roundNumber => {
    const roundSongs = groupedByRound.get(roundNumber);
    const group = document.createElement("section");
    group.className = "playlist-round-group";
    group.dataset.round = String(roundNumber);

    const header = document.createElement("div");
    header.className = "playlist-round-header";

    const title = document.createElement("span");
    title.textContent = `Round ${roundNumber}`;
    header.appendChild(title);

    if (roundNumber === room.currentRound) {
      const badge = document.createElement("span");
      badge.className = "current-round-badge";
      badge.textContent = "Current Round";
      header.appendChild(badge);
    }

    const count = document.createElement("span");
    count.className = "playlist-round-count";
    count.textContent = `${roundSongs.length} song${roundSongs.length === 1 ? "" : "s"}`;
    header.appendChild(count);

    group.appendChild(header);

    roundSongs.forEach(song => {
      const card = document.createElement("div");
      card.className = "playlist-song";

      card.appendChild(buildSongDisplayCard(song));

      const isCurrentRoundSong = song.round === room.currentRound;
      const canGuessNow = !isScreenMode && room.status === "playing" && isCurrentRoundSong;
      const isPicker = song.pickedBy === currentPlayerId;

      if (canGuessNow && !isPicker) {
        const myGuess = guesses.find(g => g.songId === song.id && g.guessedBy === currentPlayerId);
        const row = document.createElement("div");
        row.className = "playlist-song-guesses";

        guessablePlayers.forEach(p => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "guess-btn" + (myGuess?.guessedPlayerId === p.id ? " guess-btn-selected" : "");

          const name = document.createElement("span");
          name.className = "player-pill-name";
          name.textContent = p.name;

          const score = document.createElement("span");
          score.className = "player-pill-score";
          score.textContent = `${p.score || 0} pts`;

          btn.appendChild(name);
          btn.appendChild(score);

          btn.onclick = async () => {
            row.querySelectorAll(".guess-btn").forEach(b => b.classList.remove("guess-btn-selected"));
            btn.classList.add("guess-btn-selected");
            await submitGuess(roomId, currentPlayerId, song.id, p.id);
          };
          row.appendChild(btn);
        });

        card.appendChild(row);
      } else {
        const picker = players.find(p => p.id === song.pickedBy);
        const note = document.createElement("div");
        note.className = "playlist-song-note";

        if (room.status === "playing" && isCurrentRoundSong) {
          if (isScreenMode) {
            note.textContent = "Screen mode display only. Players guess on their phones.";
          } else if (isPicker) {
            note.textContent = "You picked this song.";
          } else {
            note.textContent = "Guesses are still open for this song.";
          }
        } else {
          note.textContent = `Picked by ${picker ? picker.name : "?"}`;
        }

        card.appendChild(note);
      }

      group.appendChild(card);
    });

    container.appendChild(group);
  });
}

function getRoundGuessProgress(roundSongs) {
  const guessablePlayers = getGuessablePlayers();
  let totalNeeded = 0;
  let totalDone = 0;

  roundSongs.forEach(song => {
    const nonPickers = guessablePlayers.filter(p => p.id !== song.pickedBy);
    totalNeeded += nonPickers.length;

    nonPickers.forEach(player => {
      const hasGuess = guesses.some(g => g.songId === song.id && g.guessedBy === player.id);
      if (hasGuess) totalDone += 1;
    });
  });

  return {
    totalNeeded,
    totalDone,
    allDone: totalNeeded > 0 && totalDone >= totalNeeded
  };
}

function renderHostPlayingControls(room, isHost) {
  const hostControls = document.getElementById("host-controls-inline");
  if (!hostControls) return;

  hostControls.innerHTML = "";
  if (!isHost) return;

  const roundSongs = getSongsForRound(room.currentRound);
  if (roundSongs.length === 0) return;

  if (!room.allSongsPlayed) {
    const currentSong = roundSongs[room.currentSongIndex];

    // Auto-trigger playback at round start when autoplay was already enabled
    const autoplaySongKey = `${room.currentRound}:${room.currentSongIndex}`;
    if (hostAutoplayEnabled && currentSong?.youtubeVideoId && !hasStartedPlaybackForCurrentSong(room) && autoplaySyncedKey !== autoplaySongKey) {
      autoplaySyncedKey = autoplaySongKey;
      syncSongForEveryone(room, room.currentSongIndex, 2500).catch(e => console.error("Autoplay round-start sync failed:", e));
    }

    const row = document.createElement("div");
    row.className = "host-inline-controls-row";
    hostControls.appendChild(row);

    const playBtn = document.createElement("button");
    playBtn.className = "secondary-btn compact-control-btn";
    playBtn.textContent = "Play For Everyone";
    playBtn.disabled = !currentSong?.youtubeVideoId;
    playBtn.onclick = async () => {
      if (!currentSong?.youtubeVideoId) return;

      playBtn.disabled = true;
      try {
        await syncSongForEveryone(room, room.currentSongIndex, 2500);
      } catch (e) {
        alert("Could not sync playback: " + e.message);
      }
      playBtn.disabled = false;
    };
    row.appendChild(playBtn);

    const nextBtn = document.createElement("button");
    nextBtn.className = "host-btn compact-control-btn";

    if (room.currentSongIndex < roundSongs.length - 1) {
      nextBtn.textContent = "Next Song";
      nextBtn.onclick = async () => {
        nextBtn.disabled = true;
        try {
          await advanceSongForEveryone(room, room.currentSongIndex + 1);
        } catch (e) {
          alert("Could not move to next song: " + (e?.message || "unknown error"));
        }
        nextBtn.disabled = false;
      };
    } else {
      nextBtn.textContent = "End Round";
      nextBtn.onclick = () => markAllSongsPlayed(roomId);
    }
    row.appendChild(nextBtn);

    if (!hasStartedPlaybackForCurrentSong(room)) {
      const queuedNote = document.createElement("div");
      queuedNote.className = "guess-progress";
      queuedNote.textContent = "Song queued, not revealed to players yet";
      hostControls.appendChild(queuedNote);
    }

    const autoplayRow = document.createElement("div");
    autoplayRow.className = "host-inline-controls-row";
    hostControls.appendChild(autoplayRow);

    const autoplayBtn = document.createElement("button");
    autoplayBtn.className = "secondary-btn compact-control-btn compact-toggle-full" + (hostAutoplayEnabled ? " compact-toggle-enabled" : "");
    autoplayBtn.textContent = `Autoplay: ${hostAutoplayEnabled ? "On" : "Off"}`;
    autoplayBtn.onclick = async () => {
      hostAutoplayEnabled = !hostAutoplayEnabled;
      if (hostAutoplayEnabled && currentSong?.youtubeVideoId) {
        try {
          await syncSongForEveryone(room, room.currentSongIndex, 2500);
        } catch (e) {
          console.error("Autoplay start failed:", e);
        }
      }
      renderHostPlayingControls(room, isHost);
    };
    autoplayRow.appendChild(autoplayBtn);
    return;
  }

  const progress = getRoundGuessProgress(roundSongs);
  const row = document.createElement("div");
  row.className = "host-inline-controls-row";
  hostControls.appendChild(row);

  if (progress.allDone) {
    const revealBtn = document.createElement("button");
    revealBtn.className = "host-btn compact-control-btn";
    revealBtn.textContent = "Reveal Round";
    revealBtn.onclick = () => revealRound(roomId);
    row.appendChild(revealBtn);
  } else {
    const waiting = document.createElement("div");
    waiting.className = "guess-progress";
    waiting.textContent = `Waiting for guesses: ${progress.totalDone}/${progress.totalNeeded}`;
    hostControls.appendChild(waiting);
  }
}

// -- Reveal phase --------------------------------------------------------------

function renderScoreProcessingView(room, isHost) {
  const playlistContainer = document.getElementById("playlist-songs");
  if (playlistContainer) playlistContainer.innerHTML = "";

  const nextBtn = document.getElementById("next-round-btn");
  if (nextBtn) nextBtn.style.display = "none";

  const resultsDiv = document.getElementById("round-results");
  if (!resultsDiv) return;

  const message = "Processing guesses and updating scores.";

  resultsDiv.innerHTML = `
    <div class="reveal-calculating">
      <div class="reveal-calculating-title">SCORES INCOMING</div>
      <div class="reveal-calculating-copy"><span class="reveal-calc-icon">🎚️</span>${message}</div>
      <div class="reveal-calculating-bars" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
    </div>
  `;
}

function renderFinalProcessingView(room, isHost) {
  const podiumEl = document.getElementById("final-podium");
  const playlist = document.getElementById("full-playlist");
  const actions = document.querySelector(".final-actions");

  if (playlist) playlist.style.display = "none";
  if (actions) actions.style.display = "none";
  if (!podiumEl) return;

  const message = isHost
    ? "The final scores are dropping... cue the confetti cannons."
    : "The final scores are dropping... hold onto your aux cord.";

  podiumEl.innerHTML = `
    <div class="final-processing-shell">
      <div class="final-processing-burst" aria-hidden="true">
        <span>♪</span><span>♫</span><span>♬</span><span>♪</span><span>♩</span><span>♫</span>
      </div>
      <div class="final-processing-title">FINAL SCORES INCOMING</div>
      <div class="final-processing-copy">${message}</div>
    </div>
  `;
}

async function maybeFinalizeRoundScoring(room, isHost) {
  if (!isHost || scoreFinalizeInFlight) return;
  if (room.revealScoredRound === room.currentRound) return;

  const roundSongs = getSongsForRound(room.currentRound);
  if (roundSongs.length === 0) return;

  scoreFinalizeInFlight = true;
  try {
    await Promise.all([
      Promise.all(roundSongs.map(song => awardScoresForSong(song))),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    revealScoresAppliedRound = room.currentRound;
    await db.collection("rooms").doc(roomId).update({
      status: "reveal",
      revealScoredRound: room.currentRound,
      lastActivityAt: Date.now()
    });
  } catch (e) {
    console.error("Could not finalize round scoring", e);
  } finally {
    scoreFinalizeInFlight = false;
  }
}

async function maybeFinalizeGameResults(room, isHost) {
  if (!isHost || finalFinalizeInFlight) return;

  finalFinalizeInFlight = true;
  try {
    await new Promise(resolve => setTimeout(resolve, 5000));
    await db.collection("rooms").doc(roomId).update({
      status: "finished",
      lastActivityAt: Date.now()
    });
  } catch (e) {
    console.error("Could not finalize game results", e);
  } finally {
    finalFinalizeInFlight = false;
  }
}

async function renderRevealView(room, isHost) {
  if (lastRenderedRevealRound === room.currentRound && getVisibleViewId() === "view-reveal") return;
  if (revealRenderInFlight) return;
  revealRenderInFlight = true;

  try {
  // Fallback: if a client missed the transient "scoring" snapshot, still show
  // a brief processing message before reveal so the transition feels intentional.
  if (lastRoomStatus === "playing") {
    renderScoreProcessingView(room, isHost);
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (!currentRoom || currentRoom.currentRound !== room.currentRound || currentRoom.status !== "reveal") {
      return;
    }
  }

  // Clear the guess playlist for ALL clients the moment reveal starts
  const playlistContainer = document.getElementById("playlist-songs");
  if (playlistContainer) playlistContainer.innerHTML = "";

  // Keep an in-view fallback button so host is never blocked if meta actions fail to paint.
  const nextBtn = document.getElementById("next-round-btn");
  if (nextBtn) {
    nextBtn.className = "host-btn compact-control-btn";
    nextBtn.style.display = isHost ? "block" : "none";
  }

  const roundSongs = getSongsForRound(room.currentRound);
  const resultsDiv = document.getElementById("round-results");

  if (roundSongs.length === 0) {
    resultsDiv.textContent = "No songs found for this round.";
    return;
  }

  // Compute per-player round deltas from local guesses for display
  const guessablePlayers = getGuessablePlayers();
  const roundDeltas = new Map(guessablePlayers.map(p => [p.id, 0]));
  roundSongs.forEach(song => {
    if (roundDeltas.has(song.pickedBy)) {
      roundDeltas.set(song.pickedBy, (roundDeltas.get(song.pickedBy) || 0) + POINTS_FOR_PICKER_REVEAL);
    }
    guesses.forEach(g => {
      if (g.songId === song.id && g.guessedPlayerId === song.pickedBy && g.guessedBy !== song.pickedBy) {
        roundDeltas.set(g.guessedBy, (roundDeltas.get(g.guessedBy) || 0) + POINTS_PER_CORRECT_GUESS);
      }
    });
  });

  // Build staggered animated reveal cards
  resultsDiv.innerHTML = "";

  roundSongs.forEach((song, i) => {
    const picker = players.find(p => p.id === song.pickedBy);
    const songGuesses = guesses.filter(g => g.songId === song.id);

    const row = document.createElement("div");
    row.className = "final-playlist-item reveal-card";
    row.style.setProperty("--reveal-i", i);

    row.appendChild(buildSongDisplayCard(song));

    // Picker reveal row
    const pickerRow = document.createElement("div");
    pickerRow.className = "reveal-picker-row";

    const pickerLabel = document.createElement("span");
    pickerLabel.className = "reveal-picker-name";
    pickerLabel.textContent = `\uD83C\uDFB5 ${picker ? picker.name : "?"}`;
    pickerRow.appendChild(pickerLabel);

    const pickerBadge = document.createElement("span");
    pickerBadge.className = "delta-badge delta-badge-picker";
    pickerBadge.textContent = `+${POINTS_FOR_PICKER_REVEAL}`;
    pickerRow.appendChild(pickerBadge);

    row.appendChild(pickerRow);

    // Per-player guess results
    const guessResults = document.createElement("div");
    guessResults.className = "reveal-guess-results";

    guessablePlayers.filter(p => p.id !== song.pickedBy).forEach(p => {
      const g = songGuesses.find(guess => guess.guessedBy === p.id);
      const isCorrect = g?.guessedPlayerId === song.pickedBy;

      const item = document.createElement("span");
      item.className = "reveal-guess-item " + (isCorrect ? "reveal-correct" : "reveal-wrong");

      const marker = document.createElement("span");
      marker.className = "reveal-guess-marker";
      marker.textContent = isCorrect ? "\u2713" : "\u2717";
      item.appendChild(marker);

      const pname = document.createElement("span");
      pname.textContent = p.name;
      item.appendChild(pname);

      if (isCorrect) {
        const pts = document.createElement("span");
        pts.className = "delta-badge";
        pts.textContent = `+${POINTS_PER_CORRECT_GUESS}`;
        item.appendChild(pts);
      }

      guessResults.appendChild(item);
    });

    row.appendChild(guessResults);
    resultsDiv.appendChild(row);
  });

  // Round score summary (staggered after the last card)
  const summary = document.createElement("div");
  summary.className = "reveal-round-summary";
  summary.style.setProperty("--reveal-i", roundSongs.length);

  const summaryTitle = document.createElement("div");
  summaryTitle.className = "reveal-summary-title";
  summaryTitle.textContent = "Round scores";
  summary.appendChild(summaryTitle);

  const summaryGrid = document.createElement("div");
  summaryGrid.className = "reveal-summary-grid";

  [...guessablePlayers]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .forEach(p => {
      const delta = roundDeltas.get(p.id) || 0;
      const srow = document.createElement("div");
      srow.className = "reveal-summary-row";

      const pname = document.createElement("span");
      pname.className = "reveal-summary-name";
      pname.textContent = p.name + (p.id === currentPlayerId ? " (You)" : "");
      srow.appendChild(pname);

      const scoreSpan = document.createElement("span");
      scoreSpan.className = "reveal-summary-score";
      scoreSpan.textContent = `${p.score || 0} pts`;
      srow.appendChild(scoreSpan);

      if (delta > 0) {
        const badge = document.createElement("span");
        badge.className = "delta-badge";
        badge.textContent = `+${delta}`;
        srow.appendChild(badge);
      }

      summaryGrid.appendChild(srow);
    });

  summary.appendChild(summaryGrid);
  resultsDiv.appendChild(summary);

  if (nextBtn && isHost) {
    if (room.currentRound < room.maxRounds) {
      nextBtn.textContent = "Next Round";
      nextBtn.onclick = () => nextRound(roomId, room.currentRound + 1);
    } else {
      nextBtn.textContent = "Finish Game";
      nextBtn.onclick = () => finishGame(roomId);
    }
  }

  lastRenderedRevealRound = room.currentRound;
  } finally {
    revealRenderInFlight = false;
  }
}

// -- Scoring -------------------------------------------------------------------

async function awardScoresForSong(song) {
  const songRef = db.collection("rooms").doc(roomId).collection("songs").doc(song.id);

  await db.runTransaction(async tx => {
    const songDoc = await tx.get(songRef);
    if (!songDoc.exists) return;

    const songData = songDoc.data();
    if (songData.pickerPointAwarded) return;

    const pickerRef = db.collection("rooms").doc(roomId).collection("players").doc(song.pickedBy);
    tx.update(pickerRef, {
      score: firebase.firestore.FieldValue.increment(POINTS_FOR_PICKER_REVEAL)
    });
    tx.update(songRef, { pickerPointAwarded: true });
  });

  const guessesSnap = await db.collection("rooms").doc(roomId).collection("guesses")
    .where("songId", "==", song.id)
    .get();

  const txs = guessesSnap.docs.map(doc =>
    db.runTransaction(async tx => {
      const guessDoc = await tx.get(doc.ref);
      if (!guessDoc.exists) return;

      const guess = guessDoc.data();
      const isCorrect = guess.guessedPlayerId === song.pickedBy;
      const isSelfGuess = guess.guessedBy === song.pickedBy;
      const alreadyAwarded = !!guess.scoreAwarded;

      if (!isCorrect || isSelfGuess || alreadyAwarded) return;

      const playerRef = db.collection("rooms").doc(roomId).collection("players").doc(guess.guessedBy);
      tx.update(playerRef, {
        score: firebase.firestore.FieldValue.increment(POINTS_PER_CORRECT_GUESS)
      });
      tx.update(doc.ref, { scoreAwarded: true });
    })
  );

  await Promise.all(txs);
}

// -- Final results -------------------------------------------------------------

async function renderFinalResults(players) {
  const playlist = document.getElementById("full-playlist");
  const actions = document.querySelector(".final-actions");
  if (playlist) playlist.style.display = "block";
  if (actions) actions.style.display = "flex";

  const finalSignature = JSON.stringify({
    status: currentRoom?.status,
    round: currentRoom?.currentRound,
    maxRounds: currentRoom?.maxRounds,
    players: [...players]
      .map(p => ({ id: p.id, name: p.name, score: p.score || 0 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    songs: [...(songs || [])]
      .map(s => ({ id: s.id, pickedBy: s.pickedBy, round: s.round, title: s.title, artist: s.artist }))
      .sort((a, b) => a.id.localeCompare(b.id))
  });

  if (lastRenderedFinalSignature === finalSignature && getVisibleViewId() === "view-final") {
    return;
  }

  lastRenderedFinalSignature = finalSignature;

  const isHost = players.find(p => p.id === currentPlayerId)?.isHost;
  const participatingPlayers = (players || []).filter(player => !isScreenRole(player));

  // Ranked podium
  const podiumEl = document.getElementById("final-podium");
  if (podiumEl) {
    podiumEl.innerHTML = "";
    const podiumTitle = document.createElement("div");
    podiumTitle.className = "reveal-summary-title";
    podiumTitle.textContent = "Final standings";
    podiumEl.appendChild(podiumTitle);

    const grid = document.createElement("div");
    grid.className = "reveal-podium";
    const medals = ["🥇", "🥈", "🥉"];
    [...participatingPlayers].sort((a, b) => (b.score || 0) - (a.score || 0)).forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "podium-row" + (i === 0 ? " podium-winner" : "");
      row.style.setProperty("--reveal-i", i);

      const medal = document.createElement("span");
      medal.className = "podium-medal";
      medal.textContent = medals[i] || `${i + 1}.`;
      row.appendChild(medal);

      const pname = document.createElement("span");
      pname.className = "podium-name";
      pname.textContent = p.name + (p.id === currentPlayerId ? " (You)" : "");
      row.appendChild(pname);

      const scoreSpan = document.createElement("span");
      scoreSpan.className = "podium-score";
      scoreSpan.textContent = `${p.score || 0} pts`;
      row.appendChild(scoreSpan);

      grid.appendChild(row);
    });
    podiumEl.appendChild(grid);
  }

  const allSongs = [...(songs || [])].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.addedAt - b.addedAt;
  });

  const playlistEl = document.getElementById("full-playlist");
  playlistEl.innerHTML = "";
  allSongs.forEach(s => {
    const picker = players.find(p => p.id === s.pickedBy);
    const li = document.createElement("li");
    li.className = "final-playlist-item";

    const roundLabel = document.createElement("div");
    roundLabel.className = "playlist-song-note";
    roundLabel.textContent = `Round ${s.round}`;
    li.appendChild(roundLabel);

    const songCard = buildSongDisplayCard(s);
    if (s.youtubeUrl) {
      const songLink = document.createElement("a");
      songLink.className = "final-playlist-link";
      songLink.href = s.youtubeUrl;
      songLink.target = "_blank";
      songLink.rel = "noopener noreferrer";
      songLink.appendChild(songCard);
      li.appendChild(songLink);
    } else {
      li.appendChild(songCard);
    }

    const pickedBy = document.createElement("div");
    pickedBy.className = "playlist-song-note";
    pickedBy.textContent = `Picked by ${picker ? picker.name : "?"}`;
    li.appendChild(pickedBy);

    playlistEl.appendChild(li);
  });

  const playAgainBtn = document.getElementById("play-again-btn");
  const endGameBtn = document.getElementById("end-game-btn");

  playAgainBtn.textContent = isHost ? "Play Again (Same Room)" : "Back to Home";
  playAgainBtn.onclick = async () => {
    if (!isHost) {
      playAgainBtn.disabled = true;
      try {
        await leaveRoom(roomId, currentPlayerId);
      } catch (e) {
        // Ignore if already removed/room closed; still route home.
      }
      cleanupLocalGameState();
      window.location.href = "index.html";
      return;
    }

    playAgainBtn.disabled = true;
    try {
      await resetGame(roomId);
    } catch (e) {
      alert("Could not reset game: " + e.message);
      playAgainBtn.disabled = false;
    }
  };

  if (endGameBtn) {
    endGameBtn.style.display = isHost ? "inline-block" : "none";
    endGameBtn.onclick = async () => {
      if (!isHost) return;

      endGameBtn.disabled = true;
      playAgainBtn.disabled = true;
      try {
        await closeRoom(roomId);
        cleanupLocalGameState();
        window.location.href = "index.html";
      } catch (e) {
        alert("Could not close room: " + e.message);
        endGameBtn.disabled = false;
        playAgainBtn.disabled = false;
      }
    };
  }
}

// -- Boot ----------------------------------------------------------------------

setupMobileTabs();
setupPresenceAndHostMonitoring();
startListening();
