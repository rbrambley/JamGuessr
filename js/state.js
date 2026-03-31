// ── Runtime state ─────────────────────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
const roomId = urlParams.get("room") || hashParams.get("room") || localStorage.getItem("jamguessr_roomId");

const currentPlayerId = sessionStorage.getItem("jamguessr_playerId");

let currentRoom = null;   // latest room snapshot data
let players = [];          // latest players array
let songs = [];            // songs for current round
let guesses = [];          // guesses submitted this round

// Safety: redirect to home if no room in URL
if (!roomId) {
  window.location.href = "index.html";
} else {
  // Keep a stable copy in case the server rewrites URLs and drops query params.
  localStorage.setItem("jamguessr_roomId", roomId);
}

if (!currentPlayerId) {
  // Without a tab-local player ID, this tab is not joined to the room.
  window.location.href = "index.html";
}
