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
  reveal: ["view-playing", "view-reveal"],
  finished: ["view-playing", "view-reveal", "view-final"]
};

const CANONICAL_STATUS_VIEW = {
  lobby: "view-lobby",
  picking: "view-picking",
  playing: "view-playing",
  reveal: "view-reveal",
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
      renderRevealView(room, isHost);
      break;
    case "view-final":
      renderFinalResults(players);
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
let playbackTimer = null;
let lastAppliedPlaybackVersion = null;
let lastLoadedVideoIdForPlayback = null;
let pausedHeartbeatDebounceTimer = null;
let hardStoppedVideoId = null;
let hardStoppedAtSec = 0;

const YOUTUBE_SEARCH_MIN_QUERY_LENGTH = 4;
const YOUTUBE_SEARCH_COOLDOWN_MS = 1000;
const YOUTUBE_SEARCH_MAX_RESULTS = 5;
const youtubeSearchCache = new Map();
let lastYouTubeSearchAt = 0;
let didRedirectAfterRemoval = false;
let hasLoadedPlayersSnapshot = false;
let hasConfirmedPlayerPresence = false;
let hostAutoplayEnabled = false;
let autoplayAdvancePending = false;
let presenceHeartbeatTimer = null;
let hostElectionTimer = null;
let lastSeenHostChangeAt = 0;
let isInitialRoomRender = true;
let hostPlaybackSyncTimer = null;
let hostPlaybackSyncInFlight = false;
let suppressHostPlaybackBroadcastUntil = 0;

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
  if (pausedHeartbeatDebounceTimer) {
    clearTimeout(pausedHeartbeatDebounceTimer);
    pausedHeartbeatDebounceTimer = null;
  }
  stopYouTubePlayback();
  hardStoppedVideoId = null;
  hardStoppedAtSec = 0;
  lastLoadedVideoIdForPlayback = null;
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

function clearPlaybackTimer() {
  if (playbackTimer) {
    clearTimeout(playbackTimer);
    playbackTimer = null;
  }
}

function stopYouTubePlayback() {
  clearPlaybackTimer();
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
          resolve();
        },
        onStateChange: evt => {
          if (evt?.data === YT.PlayerState.ENDED) {
            handleHostAutoplayAdvance();
          }
          handleHostPlaybackStateChange(evt?.data);
        }
      }
    });
  });

  return ytPlayer;
}

function isCurrentPlayerHost() {
  const me = players.find(p => p.id === currentPlayerId);
  return !!me?.isHost;
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
  const shouldRun = !!isHost && room?.status === "playing" && !room?.allSongsPlayed;
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

  if (playback.version && playback.version === lastAppliedPlaybackVersion) {
    return;
  }

  const player = await ensureYouTubePlayer();
  if (!player) return;

  clearPlaybackTimer();
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
  const isDirectRevealToPlaying = lastRoomStatus === "reveal" && room.status === "playing";
  const resumingHardStoppedSameVideo =
    isDirectRevealToPlaying && hardStoppedVideoId === playback.videoId;

  // If we hard-stopped on reveal/end and are resuming the same song, load it
  // directly at the synced position for a smoother return to playing.
  if (resumingHardStoppedSameVideo) {
    player.loadVideoById({
      videoId: playback.videoId,
      startSeconds: elapsedSec
    });
    lastLoadedVideoIdForPlayback = playback.videoId;
  }

  if (!sameVideo && !resumingHardStoppedSameVideo) {
    player.cueVideoById({
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
        player.playVideo();
      }
      if (statusEl && status === "playing") statusEl.textContent = "Playing";
      hardStoppedVideoId = null;
      hardStoppedAtSec = 0;
    } catch (e) {
      if (statusEl) statusEl.textContent = "Playback blocked. Click player to start audio.";
    }
  }, delayMs);
}

async function syncSongForEveryone(room, songIndex, startDelayMs = 1200) {
  const roundSongs = getSongsForRound(room.currentRound);
  const song = roundSongs[songIndex];
  if (!song?.youtubeVideoId) return;

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
    startAtMs: Date.now() + startDelayMs,
    version: Date.now()
  });
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
      if (hostChange.hostId === currentPlayerId) {
        alert("The previous host left or disconnected. You are now the host.");
      } else {
        const nextHostName = hostChange.hostName || "A player";
        alert(`The previous host left or disconnected. ${nextHostName} is now the host.`);
      }
    }
    lastSeenHostChangeAt = hostChange.changedAt;
  }

  currentRoom = room;
  const isHost = !!me.isHost;
  updateHostPlaybackSyncLoop(room, isHost);

  if (room.status !== "playing") {
    stopYouTubePlayback();
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
  const playerNameEl = document.getElementById("player-name-display");
  if (playerNameEl) {
    playerNameEl.textContent = me ? `${me.name} • ${isHost ? "Host" : "Player"}` : "Joining room...";
  }

  const roundEl = document.getElementById("round-display");
  if (roundEl) {
    if (room.status === "finished") {
      roundEl.textContent = "GAME OVER";
      roundEl.style.color = "#f87171";
    } else if (room.status === "playing") {
      const roundSongs = getSongsForRound(room.currentRound);
      const songCount = Math.max(roundSongs.length, players.length);
      const songIdx = room.allSongsPlayed ? songCount : Math.min(room.currentSongIndex + 1, songCount);
      roundEl.textContent = `Round ${room.currentRound} of ${room.maxRounds} • Song ${songIdx} of ${songCount}`;
      roundEl.style.color = "";
    } else if (room.status === "reveal") {
      roundEl.textContent = `Round ${room.currentRound} of ${room.maxRounds} • Reveal`;
      roundEl.style.color = "";
    } else {
      roundEl.textContent = `Round ${room.currentRound} of ${room.maxRounds} • ${room.status === "lobby" ? "Lobby" : "Song Selection"}`;
      roundEl.style.color = "";
    }
  }

  const pointsEl = document.getElementById("points-display");
  if (pointsEl) {
    pointsEl.textContent = room.status === "finished"
      ? ""
      : "Scoring: +1 correct guess, +1 reveal bonus";
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
  const winner = isFinished ? [...players].sort((a, b) => b.score - a.score)[0] : null;

  players.forEach(p => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary-btn player-chip";

    const trophy = isFinished && winner && p.id === winner.id ? " 🏆" : "";
    const score = ` - ${p.score || 0} pts`;
    btn.textContent = p.name + (p.id === currentPlayerId ? " (You)" : "") + score + trophy;

    btn.disabled = true;
    if (p.id === currentPlayerId) btn.classList.add("player-chip-active");
    if (trophy) btn.classList.add("player-chip-winner");

    buttonRow.appendChild(btn);
  });

  hostActions.innerHTML = "";
  if (!isHost || room.status === "finished") return;

  const endBtn = document.createElement("button");
  endBtn.type = "button";
  endBtn.className = "secondary-btn danger-btn";
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

    const text = document.createElement("div");
    text.className = "song-search-selected-text";
    const artist = pickingSelectedSong.artist || "Unknown Artist";
    text.textContent = `${pickingSelectedSong.title} - ${artist}`;

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

    selectedEl.appendChild(text);
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
      const resp = await fetch(`${YOUTUBE_SEARCH_ENDPOINT}?q=${encodeURIComponent(q)}`);
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error?.message || "Search failed");
      }

      pickingSearchResults = data.items || [];
      youtubeSearchCache.set(normalizedQuery, pickingSearchResults);
      renderSearchResults();
      if (pickingSearchResults.length === 0) {
        alert("No results found. Try a different search.");
      }
    } catch (e) {
      alert(e.message || "YouTube search error");
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

  const me = players.find(p => p.id === currentPlayerId);
  if (me?.submitted) {
    submitBtn.style.display = "none";
    waitingMsg.style.display = "block";
    waitingMsg.textContent = "Waiting for other players to submit this round's song...";

    if (searchBlockEl) searchBlockEl.style.display = "none";

    const myRoundSong = getSongsForRound(currentRound).find(song => song.pickedBy === currentPlayerId);
    if (selectedEl) {
      if (myRoundSong?.title) {
        const artist = myRoundSong.artist || "Unknown Artist";
        selectedEl.innerHTML = `<div class="song-search-selected-text">${escapeHtml(myRoundSong.title)} - ${escapeHtml(artist)}</div>`;
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
  const unsub = db.collection("rooms").doc(roomId).collection("players")
    .onSnapshot(snap => {
      const all = snap.docs.map(d => d.data());
      if (all.length > 0 && all.every(p => p.submitted)) {
        unsub();
        startPlaying(roomId);
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
  renderNowPlayingBanner(room);
  renderMasterPlaylist(room);
  setYouTubeInteractionLock(isHost);
  // Host controls their own player directly — applying their own Firestore
  // broadcast would re-cue the video every 3s and interrupt playback.
  if (!isHost) {
    applyRoomPlayback(room);
  }
}

function setYouTubeInteractionLock(isHost) {
  const shell = document.querySelector(".youtube-player-shell");
  if (!shell) return;

  shell.classList.toggle("youtube-player-locked", !isHost);

  const statusEl = document.getElementById("youtube-player-status");
  if (!statusEl) return;

  if (!isHost && !statusEl.textContent) {
    statusEl.textContent = "Playback is host-controlled to keep everyone in sync.";
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
      ? "Ready to play on all clients."
      : "No YouTube video selected for this song.";
  }
}

function renderMasterPlaylist(room) {
  const container = document.getElementById("playlist-songs");
  if (!container) return;
  container.innerHTML = "";

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

      const songTitle = document.createElement("div");
      songTitle.className = "playlist-song-title";
      songTitle.textContent = `${song.title}${song.artist ? " - " + song.artist : ""}`;
      card.appendChild(songTitle);

      const isCurrentRoundSong = song.round === room.currentRound;
      const canGuessNow = room.status === "playing" && isCurrentRoundSong;
      const isPicker = song.pickedBy === currentPlayerId;

      if (canGuessNow && !isPicker) {
        const myGuess = guesses.find(g => g.songId === song.id && g.guessedBy === currentPlayerId);
        const row = document.createElement("div");
        row.className = "playlist-song-guesses";

        players.forEach(p => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "guess-btn" + (myGuess?.guessedPlayerId === p.id ? " guess-btn-selected" : "");
          btn.textContent = p.name;
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

        if (isPicker && canGuessNow) {
          note.textContent = "You picked this song.";
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
  let totalNeeded = 0;
  let totalDone = 0;

  roundSongs.forEach(song => {
    const nonPickers = players.filter(p => p.id !== song.pickedBy);
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

async function renderRevealView(room, isHost) {
  const roundSongs = getSongsForRound(room.currentRound);
  if (roundSongs.length === 0) {
    document.getElementById("round-results").textContent = "No songs found for this round.";
    return;
  }

  if (isHost) {
    for (const song of roundSongs) {
      await awardScoresForSong(song);
    }
  }

  const resultsDiv = document.getElementById("round-results");
  resultsDiv.innerHTML = "";

  roundSongs.forEach(song => {
    const picker = players.find(p => p.id === song.pickedBy);
    const correctCount = guesses.filter(g =>
      g.songId === song.id &&
      g.guessedPlayerId === song.pickedBy &&
      g.guessedBy !== song.pickedBy
    ).length;

    const row = document.createElement("p");
    row.textContent = `${song.title}${song.artist ? " - " + song.artist : ""}: picked by ${picker ? picker.name : "?"}, ${correctCount} correct guess(es).`;
    resultsDiv.appendChild(row);
  });

  const nextBtn = document.getElementById("next-round-btn");
  nextBtn.style.display = isHost ? "block" : "none";

  if (isHost) {
    if (room.currentRound < room.maxRounds) {
      nextBtn.textContent = "Next Round";
      nextBtn.onclick = () => nextRound(roomId, room.currentRound + 1);
    } else {
      nextBtn.textContent = "Finish Game";
      nextBtn.onclick = () => finishGame(roomId);
    }
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
  const isHost = players.find(p => p.id === currentPlayerId)?.isHost;

  const allSongs = [...(songs || [])].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.addedAt - b.addedAt;
  });

  const playlist = document.getElementById("full-playlist");
  playlist.innerHTML = "";
  allSongs.forEach(s => {
    const picker = players.find(p => p.id === s.pickedBy);
    const li = document.createElement("li");
    li.textContent = `Round ${s.round}: ${s.title}${s.artist ? " - " + s.artist : ""} (picked by ${picker ? picker.name : "?"})`;
    playlist.appendChild(li);
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
