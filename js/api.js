// ── Room management ──────────────────────────────────────────────────────────

async function createRoom(hostName, maxRounds) {
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  const roomRef = await db.collection("rooms").add({
    code,
    hostName,
    maxRounds,
    status: "lobby",
    currentRound: 1,
    currentSongIndex: 0,
    allSongsPlayed: false,
    createdAt: Date.now()
  });
  // Add host as first player
  const playerRef = await db.collection("rooms").doc(roomRef.id)
    .collection("players").add({
      name: hostName,
      score: 0,
      isHost: true,
      submitted: false,
      lastSeen: Date.now(),
      joinedAt: Date.now()
    });
  // Persist IDs locally
  localStorage.setItem("jamguessr_roomId", roomRef.id);
  sessionStorage.setItem("jamguessr_playerId", playerRef.id);
  localStorage.removeItem("jamguessr_playerId");
  return roomRef.id;
}

async function joinRoom(code, playerName) {
  const snap = await db.collection("rooms").where("code", "==", code).get();
  if (snap.empty) throw new Error("Room not found. Check the code and try again.");

  const roomDoc = snap.docs[0];
  const roomId = roomDoc.id;

  if (roomDoc.data().status !== "lobby") {
    throw new Error("This game has already started.");
  }

  const playerRef = await db.collection("rooms").doc(roomId)
    .collection("players").add({
      name: playerName,
      score: 0,
      isHost: false,
      submitted: false,
      lastSeen: Date.now(),
      joinedAt: Date.now()
    });

  localStorage.setItem("jamguessr_roomId", roomId);
  sessionStorage.setItem("jamguessr_playerId", playerRef.id);
  localStorage.removeItem("jamguessr_playerId");
  return roomId;
}

// ── Song submission ───────────────────────────────────────────────────────────

async function submitSongs(roomId, playerId, songs, roundNumber) {
  const song = songs?.[0];
  if (!song || !song.title) {
    throw new Error("Missing song for this round.");
  }

  const songDocId = `round_${roundNumber}_player_${playerId}`;
  const songRef = db.collection("rooms").doc(roomId).collection("songs").doc(songDocId);
  const playerRef = db.collection("rooms").doc(roomId).collection("players").doc(playerId);

  await db.runTransaction(async tx => {
    const existingSong = await tx.get(songRef);
    if (existingSong.exists) {
      throw new Error("You already submitted a song for this round.");
    }

    tx.set(songRef, {
      title: song.title,
      artist: song.artist,
      youtubeVideoId: song.youtubeVideoId || null,
      youtubeUrl: song.youtubeUrl || null,
      thumbnailUrl: song.thumbnailUrl || null,
      pickedBy: playerId,
      round: roundNumber,
      pickerPointAwarded: false,
      addedAt: Date.now()
    });

    tx.update(playerRef, { submitted: true });
  });
}

// ── Guessing ─────────────────────────────────────────────────────────────────

async function submitGuess(roomId, playerId, songId, guessedPlayerId) {
  const guessesRef = db.collection("rooms").doc(roomId).collection("guesses");
  const existingSnap = await guessesRef
    .where("songId", "==", songId)
    .where("guessedBy", "==", playerId)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    await existingSnap.docs[0].ref.update({
      guessedPlayerId,
      submittedAt: Date.now(),
      scoreAwarded: false
    });
    return;
  }

  await guessesRef.add({
    songId,
    guessedBy: playerId,
    guessedPlayerId,
    scoreAwarded: false,
    submittedAt: Date.now()
  });
}

// ── Host controls ─────────────────────────────────────────────────────────────

async function startGame(roomId) {
  await db.collection("rooms").doc(roomId).update({ status: "picking" });
}

async function startPlaying(roomId) {
  await db.collection("rooms").doc(roomId).update({
    status: "playing",
    currentSongIndex: 0,
    allSongsPlayed: false,
    playback: null
  });
}

async function revealRound(roomId) {
  await db.collection("rooms").doc(roomId).update({ status: "reveal" });
}

async function nextRound(roomId, nextRound) {
  const roomRef = db.collection("rooms").doc(roomId);
  const playersSnap = await roomRef.collection("players").get();
  const batch = db.batch();

  playersSnap.docs.forEach(doc => {
    batch.update(doc.ref, { submitted: false });
  });

  batch.update(roomRef, {
    status: "picking",
    currentRound: nextRound,
    currentSongIndex: 0,
    allSongsPlayed: false,
    playback: null
  });

  await batch.commit();
}

async function finishGame(roomId) {
  await db.collection("rooms").doc(roomId).update({ status: "finished" });
}

async function advanceSong(roomId, nextIndex) {
  await db.collection("rooms").doc(roomId).update({
    currentSongIndex: nextIndex,
    status: "playing",
    playback: null
  });
}

async function syncRoomPlayback(roomId, playback) {
  await db.collection("rooms").doc(roomId).update({ playback });
}

async function markAllSongsPlayed(roomId) {
  await db.collection("rooms").doc(roomId).update({ allSongsPlayed: true });
}

async function resetGame(roomId) {
  const roomRef = db.collection("rooms").doc(roomId);

  const [playersSnap, songsSnap, guessesSnap] = await Promise.all([
    roomRef.collection("players").get(),
    roomRef.collection("songs").get(),
    roomRef.collection("guesses").get()
  ]);

  const batch = db.batch();

  playersSnap.docs.forEach(doc => {
    batch.update(doc.ref, { score: 0, submitted: false });
  });

  songsSnap.docs.forEach(doc => {
    batch.delete(doc.ref);
  });

  guessesSnap.docs.forEach(doc => {
    batch.delete(doc.ref);
  });

  batch.update(roomRef, {
    status: "lobby",
    currentRound: 1,
    currentSongIndex: 0,
    allSongsPlayed: false,
    playback: null
  });

  await batch.commit();
}

async function leaveRoom(roomId, playerId) {
  const roomRef = db.collection("rooms").doc(roomId);
  const playersQuery = roomRef.collection("players").orderBy("joinedAt", "asc");

  await db.runTransaction(async tx => {
    const playersSnap = await tx.get(playersQuery);
    if (playersSnap.empty) return;

    const players = playersSnap.docs;
    const leavingDoc = players.find(doc => doc.id === playerId);
    if (!leavingDoc) return;

    const leavingIsHost = !!leavingDoc.data()?.isHost;
    tx.delete(leavingDoc.ref);

    if (!leavingIsHost) {
      return;
    }

    const remaining = players.filter(doc => doc.id !== playerId);
    if (remaining.length === 0) {
      return;
    }

    const replacement = remaining[0];
    remaining.forEach(doc => {
      const data = doc.data() || {};
      if (doc.id === replacement.id) {
        if (!data.isHost) {
          tx.update(doc.ref, { isHost: true });
        }
      } else if (data.isHost) {
        tx.update(doc.ref, { isHost: false });
      }
    });

    tx.update(roomRef, {
      lastHostChange: {
        previousHostId: playerId,
        hostId: replacement.id,
        hostName: replacement.data()?.name || "Player",
        changedAt: Date.now(),
        reason: "host_left"
      }
    });
  });
}

async function ensureActiveHost(roomId, staleAfterMs = 25000) {
  const roomRef = db.collection("rooms").doc(roomId);
  const playersQuery = roomRef.collection("players").orderBy("joinedAt", "asc");

  return db.runTransaction(async tx => {
    const [roomDoc, playersSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(playersQuery)
    ]);

    if (!roomDoc.exists || playersSnap.empty) {
      return { changed: false };
    }

    const now = Date.now();
    const players = playersSnap.docs;
    const currentHostDoc = players.find(doc => !!doc.data()?.isHost);
    const currentHostData = currentHostDoc?.data() || null;
    const currentHostLastSeen = currentHostData?.lastSeen || 0;
    const hostMissingOrStale = !currentHostDoc || (now - currentHostLastSeen) > staleAfterMs;

    if (!hostMissingOrStale) {
      return { changed: false };
    }

    const activeCandidates = players.filter(doc => (now - (doc.data()?.lastSeen || 0)) <= staleAfterMs);
    const replacementDoc = activeCandidates[0] || players[0];
    if (!replacementDoc) {
      return { changed: false };
    }

    const replacementData = replacementDoc.data();
    const replacementId = replacementDoc.id;
    const currentHostId = currentHostDoc?.id || null;

    if (currentHostId === replacementId && replacementData?.isHost) {
      return { changed: false };
    }

    players.forEach(doc => {
      const data = doc.data() || {};
      if (doc.id === replacementId) {
        if (!data.isHost) {
          tx.update(doc.ref, { isHost: true });
        }
      } else if (data.isHost) {
        tx.update(doc.ref, { isHost: false });
      }
    });

    tx.update(roomRef, {
      lastHostChange: {
        previousHostId: currentHostId,
        hostId: replacementId,
        hostName: replacementData?.name || "Player",
        changedAt: now,
        reason: currentHostDoc ? "host_disconnected" : "host_missing"
      }
    });

    return {
      changed: true,
      hostId: replacementId,
      hostName: replacementData?.name || "Player"
    };
  });
}

async function closeRoom(roomId) {
  const roomRef = db.collection("rooms").doc(roomId);
  const [playersSnap, songsSnap, guessesSnap] = await Promise.all([
    roomRef.collection("players").get(),
    roomRef.collection("songs").get(),
    roomRef.collection("guesses").get()
  ]);

  const batch = db.batch();
  playersSnap.docs.forEach(doc => batch.delete(doc.ref));
  songsSnap.docs.forEach(doc => batch.delete(doc.ref));
  guessesSnap.docs.forEach(doc => batch.delete(doc.ref));
  batch.delete(roomRef);

  await batch.commit();
}
