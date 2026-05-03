// ── Lobby UI ───────────────────────────────────────────────────────────────────

function isLobbyScreenRole(player) {
  return (player?.role || "player") === "screen";
}

function getLobbyParticipatingPlayers(playersList) {
  return (playersList || []).filter(player => !isLobbyScreenRole(player));
}

function renderLobby(players, code, isHost, room) {
  const minimumPlayers = 2;
  const participantCount = getLobbyParticipatingPlayers(players).length;
  const screenCount = Math.max(0, players.length - participantCount);
  const roomCodeEl = document.getElementById("room-code-display");
  if (roomCodeEl) {
    roomCodeEl.innerHTML = `
      <div class="room-code-label">Room Code</div>
      <div class="room-code-value">${code}</div>
    `;
  }

  const copyBtn = document.getElementById("copy-room-btn");
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(code);
        } else {
          const temp = document.createElement("input");
          temp.value = code;
          document.body.appendChild(temp);
          temp.select();
          document.execCommand("copy");
          document.body.removeChild(temp);
        }
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy Code";
        }, 1200);
      } catch (e) {
        alert("Could not copy room code. Please copy it manually: " + code);
      }
    };
  }

  const inviteBtn = document.getElementById("copy-invite-btn");
  if (inviteBtn) {
    inviteBtn.onclick = async () => {
      const inviteText = `Join my JamGuessr room! Code: ${code} — play at https://rbrambley.github.io/JamGuessr`;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(inviteText);
        } else {
          const temp = document.createElement("input");
          temp.value = inviteText;
          document.body.appendChild(temp);
          temp.select();
          document.execCommand("copy");
          document.body.removeChild(temp);
        }
        inviteBtn.textContent = "Invite Copied";
        setTimeout(() => {
          inviteBtn.textContent = "Copy Invite";
        }, 1200);
      } catch (e) {
        alert("Could not copy invite. Share this code manually: " + code);
      }
    };
  }

  const waitingText = document.getElementById("lobby-waiting-text");
  if (waitingText) {
    const needed = Math.max(0, minimumPlayers - participantCount);
    const screenSuffix = screenCount > 0 ? ` (+${screenCount} screen${screenCount === 1 ? "" : "s"})` : "";
    if (needed > 0) {
      waitingText.textContent = `${participantCount}/${minimumPlayers} players ready${screenSuffix} - need ${needed} more player${needed === 1 ? "" : "s"} to begin`;
    } else if (isHost) {
      waitingText.textContent = `${participantCount} players ready${screenSuffix} - everyone is ready. Start when you are.`;
    } else {
      waitingText.textContent = `${participantCount} players ready${screenSuffix} - waiting for host to start.`;
    }
  }

  const list = document.getElementById("player-list");
  list.innerHTML = "";
  players.forEach(p => {
    const li = document.createElement("li");
    li.className = "lobby-player-row";

    const main = document.createElement("div");
    main.className = "lobby-player-main";

    const avatar = document.createElement("div");
    avatar.className = "lobby-avatar";
    avatar.textContent = (p.name || "?").trim().charAt(0).toUpperCase();
    main.appendChild(avatar);

    const meta = document.createElement("div");
    meta.className = "lobby-player-meta";

    const nameLine = document.createElement("div");
    nameLine.className = "lobby-name-line";
    const youTag = p.id === currentPlayerId ? " (You)" : "";
    nameLine.textContent = p.name + youTag;
    meta.appendChild(nameLine);

    const stateLine = document.createElement("div");
    stateLine.className = "lobby-state-line";

    const rolePill = document.createElement("span");
    if (p.isHost) {
      rolePill.className = "role-pill role-pill-host";
      rolePill.textContent = "Host";
    } else if (isLobbyScreenRole(p)) {
      rolePill.className = "role-pill role-pill-screen";
      rolePill.textContent = "Screen";
    } else {
      rolePill.className = "role-pill role-pill-player";
      rolePill.textContent = "Player";
    }
    stateLine.appendChild(rolePill);

    const state = document.createElement("span");
    state.className = "lobby-state";
    state.textContent = "Connected";
    stateLine.appendChild(state);

    meta.appendChild(stateLine);
    main.appendChild(meta);
    li.appendChild(main);

    if (isHost && p.id !== currentPlayerId && !p.isHost) {
      const roleBtn = document.createElement("button");
      roleBtn.type = "button";
      roleBtn.className = "secondary-btn role-toggle-link";
      const currentlyScreen = isLobbyScreenRole(p);
      roleBtn.textContent = currentlyScreen ? "Set as Player" : "Set as Screen";
      roleBtn.onclick = async () => {
        roleBtn.disabled = true;
        try {
          await setPlayerRole(roomId, currentPlayerId, p.id, currentlyScreen ? "player" : "screen");
        } catch (e) {
          alert("Could not change role: " + (e?.message || "unknown error"));
          roleBtn.disabled = false;
        }
      };
      li.appendChild(roleBtn);

      const kickLink = document.createElement("button");
      kickLink.type = "button";
      kickLink.className = "kick-player-link";
      kickLink.textContent = "Kick";
      kickLink.onclick = async () => {
        const ok = confirm(`Kick ${p.name} from the room?`);
        if (!ok) return;
        kickLink.disabled = true;
        try {
          await leaveRoom(roomId, p.id);
        } catch (e) {
          alert("Could not kick player: " + (e?.message || "unknown error"));
          kickLink.disabled = false;
        }
      };
      li.appendChild(kickLink);
    }

    list.appendChild(li);
  });

  renderLobbyPlaybackModePicker(isHost, room);
}

function renderLobbyPlaybackModePicker(isHost, room) {
  const container = document.getElementById("lobby-playback-mode-picker");
  if (!container) return;

  if (!isHost) {
    container.innerHTML = "";
    return;
  }

  const currentMode = (room && room.playbackMode) ? room.playbackMode : "embed";

  container.innerHTML = `
    <div class="lobby-mode-picker">
      <div class="lobby-mode-picker-label">Playback Mode</div>
      <div class="lobby-mode-picker-buttons">
        <button type="button"
          class="lobby-mode-btn${currentMode === "embed" ? " lobby-mode-btn-active" : ""}"
          data-mode="embed">
          YouTube Embed
        </button>
        <button type="button"
          class="lobby-mode-btn${currentMode === "native_handoff" ? " lobby-mode-btn-active" : ""}"
          data-mode="native_handoff">
          Native App Handoff
        </button>
      </div>
    </div>
  `;

  container.querySelectorAll(".lobby-mode-btn").forEach(btn => {
    const mode = btn.dataset.mode;
    if (mode === currentMode) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await setRoomPlaybackMode(roomId, currentPlayerId, mode);
      } catch (e) {
        alert("Could not change playback mode: " + (e?.message || "unknown error"));
        btn.disabled = false;
      }
    });
  });
}
