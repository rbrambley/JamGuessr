// ── Lobby UI ───────────────────────────────────────────────────────────────────

function renderLobby(players, code, isHost) {
  const minimumPlayers = 2;
  const playerCount = players.length;
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
    const needed = Math.max(0, minimumPlayers - playerCount);
    if (needed > 0) {
      waitingText.textContent = `${playerCount}/${minimumPlayers} connected - need ${needed} more player${needed === 1 ? "" : "s"} to begin`;
    } else if (isHost) {
      waitingText.textContent = `${playerCount} connected - everyone is ready. Start when you are.`;
    } else {
      waitingText.textContent = `${playerCount} connected - waiting for host to start.`;
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
    rolePill.className = "role-pill " + (p.isHost ? "role-pill-host" : "role-pill-player");
    rolePill.textContent = p.isHost ? "Host" : "Player";
    stateLine.appendChild(rolePill);

    const state = document.createElement("span");
    state.className = "lobby-state";
    state.textContent = "Connected";
    stateLine.appendChild(state);

    meta.appendChild(stateLine);
    main.appendChild(meta);
    li.appendChild(main);

    if (isHost && p.id !== currentPlayerId && !p.isHost) {
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

}
