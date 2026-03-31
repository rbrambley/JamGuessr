// ── Lobby UI ───────────────────────────────────────────────────────────────────

function renderLobby(players, code, isHost) {
  document.getElementById("room-code-display").textContent = "Room Code: " + code;

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
          copyBtn.textContent = "Copy Room Code";
        }, 1200);
      } catch (e) {
        alert("Could not copy room code. Please copy it manually: " + code);
      }
    };
  }

  const waitingText = document.getElementById("lobby-waiting-text");
  if (waitingText) {
    const needed = Math.max(0, 2 - players.length);
    if (needed > 0) {
      waitingText.textContent = "Waiting for " + needed + " more player" + (needed === 1 ? "" : "s") + "...";
    } else if (isHost) {
      waitingText.textContent = "Ready to start.";
    } else {
      waitingText.textContent = "Waiting for host to start the game.";
    }
  }

  const list = document.getElementById("player-list");
  list.innerHTML = "";
  players.forEach(p => {
    const li = document.createElement("li");
    li.textContent = p.name + (p.isHost ? " (host)" : "");
    list.appendChild(li);
  });

  const startBtn = document.getElementById("start-game-btn");
  startBtn.style.display = isHost ? "block" : "none";

  startBtn.onclick = () => {
    if (players.length < 2) {
      alert("Need at least 2 players to start.");
      return;
    }
    startGame(roomId);
  };
}
