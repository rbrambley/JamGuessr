// ── Room management ──────────────────────────────────────────────────────────

function nowMs() {
  return Date.now();
}

function normalizePlaybackMode(mode) {
  return mode === "native_handoff" ? "native_handoff" : "embed";
}

function buildPlaybackState(phase = "pending", source = null) {
  return {
    phase,
    updatedAt: nowMs(),
    source
  };
}

function derivePlaybackStatePhase(playback) {
  if (!playback) return "pending";
  if (playback.status === "paused") return "paused";
  if (playback.status === "playing") return "playing";
  return "ready";
}

function normalizePlaybackStatePhase(phase) {
  const allowed = new Set(["pending", "launching", "ready", "playing", "paused", "ended"]);
  return allowed.has(phase) ? phase : "pending";
}

const PLAYER_STALE_AFTER_MS = 25000;
const HOST_STALE_AFTER_MS = 5 * 60 * 1000;
const HOST_RECLAIM_WINDOW_MS = 10 * 60 * 1000;

function withRoomActivity(patch = {}) {
  return {
    ...patch,
    lastActivityAt: nowMs()
  };
}

async function ensureAuthenticatedUid() {
  const auth = firebase.auth();
  if (auth.currentUser?.uid) {
    return auth.currentUser.uid;
  }

  await auth.signInAnonymously();

  if (!auth.currentUser?.uid) {
    throw new Error("Authentication failed. Please refresh and try again.");
  }

  return auth.currentUser.uid;
}

function resolvePlaybackLeaderIdFromPlayerData(playersData = []) {
  const screens = playersData.filter(player => (player?.role || "player") === "screen");
  if (screens.length > 0) {
    return screens[0].id;
  }

  const host = playersData.find(player => !!player?.isHost);
  return host?.id || null;
}

async function createRoom(hostName, maxRounds) {
  const uid = await ensureAuthenticatedUid();
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  const now = nowMs();
  let roomRef;
  try {
    roomRef = await db.collection("rooms").add({
      code,
      hostName,
      hostId: uid,
      maxRounds,
      status: "lobby",
      currentRound: 1,
      currentSongIndex: 0,
      allSongsPlayed: false,
      playbackMode: "native_handoff",
      playbackModeFallbackEnabled: true,
      playbackState: {
        phase: "pending",
        updatedAt: now,
        source: "system:create-room"
      },
      playbackConfig: {
        autoplayEnabled: false,
        adPacingMode: "normal"
      },
      playbackLeaderPlayerId: uid,
      createdAt: now,
      lastActivityAt: now,
      roundPerkAppliedRound: null
    });
  } catch (e) {
    throw new Error(`Could not create room document. Check Firestore rules for /rooms create. ${e?.message || ""}`.trim());
  }
  // Add host as first player
  try {
    await db.collection("rooms").doc(roomRef.id)
      .collection("players").doc(uid).set({
        name: hostName,
        role: "player",
        score: 0,
        isHost: true,
        submitted: false,
        lastSeen: Date.now(),
        joinedAt: Date.now()
      });
  } catch (e) {
    throw new Error(`Room created, but could not create host player document. Check Firestore rules for /rooms/{roomId}/players/{uid}. ${e?.message || ""}`.trim());
  }

  // Persist IDs locally
  localStorage.setItem("jamguessr_roomId", roomRef.id);
  sessionStorage.setItem("jamguessr_playerId", uid);
  localStorage.removeItem("jamguessr_playerId");
  return roomRef.id;
}

async function joinRoom(code, playerName) {
  const uid = await ensureAuthenticatedUid();
  const snap = await db.collection("rooms").where("code", "==", code).get();
  if (snap.empty) throw new Error("Room not found. Check the code and try again.");

  const roomDoc = snap.docs[0];
  const roomId = roomDoc.id;

  if (roomDoc.data().status !== "lobby") {
    throw new Error("This game has already started.");
  }

  try {
    await db.collection("rooms").doc(roomId)
      .collection("players").doc(uid).set({
        name: playerName,
        role: "player",
        score: 0,
        isHost: false,
        submitted: false,
        lastSeen: Date.now(),
        joinedAt: Date.now()
      });
  } catch (e) {
    throw new Error(`Could not create player document for this user. Check Firestore rules for /rooms/{roomId}/players/{uid}. ${e?.message || ""}`.trim());
  }

  localStorage.setItem("jamguessr_roomId", roomId);
  sessionStorage.setItem("jamguessr_playerId", uid);
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
    const playerDoc = await tx.get(playerRef);
    if (!playerDoc.exists) {
      throw new Error("Player not found in room.");
    }

    const playerData = playerDoc.data() || {};
    if (playerData.role === "screen") {
      throw new Error("Screen devices cannot submit songs.");
    }

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
  const roomRef = db.collection("rooms").doc(roomId);
  const guesserRef = roomRef.collection("players").doc(playerId);
  const guessedRef = roomRef.collection("players").doc(guessedPlayerId);

  const [guesserDoc, guessedDoc] = await Promise.all([
    guesserRef.get(),
    guessedRef.get()
  ]);

  if (!guesserDoc.exists) {
    throw new Error("Guessing player not found.");
  }

  if (!guessedDoc.exists) {
    throw new Error("Selected player is no longer in the room.");
  }

  if ((guesserDoc.data() || {}).role === "screen") {
    throw new Error("Screen devices cannot submit guesses.");
  }

  if ((guessedDoc.data() || {}).role === "screen") {
    throw new Error("Screen devices cannot be selected as a guess target.");
  }

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
  await db.collection("rooms").doc(roomId).update(withRoomActivity({ status: "picking" }));
}

async function startPlaying(roomId) {
  const roomRef = db.collection("rooms").doc(roomId);
  const [roomDoc, playersSnap] = await Promise.all([
    roomRef.get(),
    roomRef.collection("players").orderBy("joinedAt", "asc").get()
  ]);
  const roomData = roomDoc.exists ? (roomDoc.data() || {}) : {};
  const playbackMode = normalizePlaybackMode(roomData.playbackMode);
  const playersData = playersSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));
  const nextLeaderId = resolvePlaybackLeaderIdFromPlayerData(playersData);

  await roomRef.update({
    status: "playing",
    currentSongIndex: 0,
    allSongsPlayed: false,
    playbackMode,
    playbackState: buildPlaybackState("pending", "system:start-playing"),
    playback: null,
    playbackLeaderPlayerId: nextLeaderId,
    playbackConfig: {
      autoplayEnabled: false,
      adPacingMode: "normal"
    },
    lastActivityAt: nowMs()
  });
}

async function revealRound(roomId) {
  await db.collection("rooms").doc(roomId).update(withRoomActivity({ status: "scoring" }));
}

async function setPerfectRoundPerk(roomId, playerId, perkType, targetPlayerId = null, sourceRound = null) {
  const roomRef = db.collection("rooms").doc(roomId);
  const playerRef = roomRef.collection("players").doc(playerId);

  await db.runTransaction(async tx => {
    const [roomDoc, playerDoc] = await Promise.all([
      tx.get(roomRef),
      tx.get(playerRef)
    ]);

    if (!roomDoc.exists) {
      throw new Error("Room not found.");
    }
    if (!playerDoc.exists) {
      throw new Error("Player not found.");
    }

    const room = roomDoc.data() || {};
    const player = playerDoc.data() || {};
    const nextRound = (room.currentRound || 0) + 1;
    const normalizedType = perkType === "halve-opponent" ? "halve-opponent" : "multiplier";

    if (room.status !== "reveal") {
      throw new Error("Perk choices can only be set during reveal.");
    }

    if (room.currentRound >= room.maxRounds) {
      throw new Error("No next round available for this perk.");
    }

    if ((player.role || "player") === "screen") {
      throw new Error("Screen devices cannot set perks.");
    }

    if (sourceRound !== null && Number(sourceRound) !== Number(room.currentRound)) {
      throw new Error("Round changed before perk could be saved.");
    }

    if (normalizedType === "halve-opponent") {
      if (!targetPlayerId || targetPlayerId === playerId) {
        throw new Error("Select a valid opponent target.");
      }

      const targetRef = roomRef.collection("players").doc(targetPlayerId);
      const targetDoc = await tx.get(targetRef);
      if (!targetDoc.exists) {
        throw new Error("Target player not found.");
      }

      const target = targetDoc.data() || {};
      if ((target.role || "player") === "screen") {
        throw new Error("Screen devices cannot be targeted.");
      }
    }

    tx.update(playerRef, {
      activePerkType: normalizedType,
      activePerkRound: nextRound,
      activePerkTargetId: normalizedType === "halve-opponent" ? targetPlayerId : null,
      lastPerkSourceRound: room.currentRound
    });
  });
}

async function nextRound(roomId, nextRound) {
  const roomRef = db.collection("rooms").doc(roomId);
  const [roomDoc, playersSnap] = await Promise.all([
    roomRef.get(),
    roomRef.collection("players").get()
  ]);
  const roomData = roomDoc.exists ? (roomDoc.data() || {}) : {};
  const playbackMode = normalizePlaybackMode(roomData.playbackMode);
  const batch = db.batch();

  playersSnap.docs.forEach(doc => {
    batch.update(doc.ref, { submitted: false });
  });

  batch.update(roomRef, {
    status: "picking",
    currentRound: nextRound,
    currentSongIndex: 0,
    allSongsPlayed: false,
    playbackMode,
    playbackState: buildPlaybackState("pending", "system:next-round"),
    playback: null,
    lastActivityAt: nowMs(),
    revealScoredRound: null,
    roundPerkAppliedRound: null
  });

  await batch.commit();
}

async function finishGame(roomId) {
  await db.collection("rooms").doc(roomId).update(withRoomActivity({ status: "finalizing" }));
}

async function setRoomAutoplayEnabled(roomId, actorId, enabled) {
  const roomRef = db.collection("rooms").doc(roomId);
  const actorRef = roomRef.collection("players").doc(actorId);

  await db.runTransaction(async tx => {
    const [roomDoc, actorDoc] = await Promise.all([
      tx.get(roomRef),
      tx.get(actorRef)
    ]);

    if (!roomDoc.exists) {
      throw new Error("Room not found.");
    }

    if (!actorDoc.exists) {
      throw new Error("Host session not found.");
    }

    const actor = actorDoc.data() || {};
    if (!actor.isHost) {
      throw new Error("Only the host can change autoplay.");
    }

    const roomData = roomDoc.data() || {};
    const playbackConfig = roomData.playbackConfig || {};

    tx.update(roomRef, withRoomActivity({
      playbackConfig: {
        ...playbackConfig,
        autoplayEnabled: !!enabled
      }
    }));
  });
}

async function setRoomAdPacingMode(roomId, actorId, mode) {
  const roomRef = db.collection("rooms").doc(roomId);
  const actorRef = roomRef.collection("players").doc(actorId);

  await db.runTransaction(async tx => {
    const [roomDoc, actorDoc] = await Promise.all([
      tx.get(roomRef),
      tx.get(actorRef)
    ]);

    if (!roomDoc.exists) {
      throw new Error("Room not found.");
    }

    if (!actorDoc.exists) {
      throw new Error("Host session not found.");
    }

    const actor = actorDoc.data() || {};
    if (!actor.isHost) {
      throw new Error("Only the host can adjust ad pacing.");
    }

    const roomData = roomDoc.data() || {};
    const playbackConfig = roomData.playbackConfig || {};
    const normalizedMode = mode === "ad-aware" ? "ad-aware" : "normal";

    tx.update(roomRef, withRoomActivity({
      playbackConfig: {
        ...playbackConfig,
        adPacingMode: normalizedMode
      }
    }));
  });
}

async function setPlayerRole(roomId, actorId, targetPlayerId, role) {
  const nextRole = role === "screen" ? "screen" : "player";
  const roomRef = db.collection("rooms").doc(roomId);
  const actorRef = roomRef.collection("players").doc(actorId);
  const targetRef = roomRef.collection("players").doc(targetPlayerId);

  await db.runTransaction(async tx => {
    const [actorDoc, targetDoc] = await Promise.all([
      tx.get(actorRef),
      tx.get(targetRef)
    ]);

    if (!actorDoc.exists) {
      throw new Error("Host session not found.");
    }

    if (!targetDoc.exists) {
      throw new Error("Selected player no longer exists.");
    }

    const actor = actorDoc.data() || {};
    const target = targetDoc.data() || {};

    if (!actor.isHost) {
      throw new Error("Only the host can change player roles.");
    }

    if (target.isHost) {
      throw new Error("Host role cannot be changed to screen mode.");
    }

    tx.update(targetRef, {
      role: nextRole,
      submitted: nextRole === "screen" ? true : !!target.submitted
    });
  });

  // Recompute playback leader after role update.
  const playersSnap = await roomRef.collection("players").orderBy("joinedAt", "asc").get();
  const playersData = playersSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));
  const nextLeaderId = resolvePlaybackLeaderIdFromPlayerData(playersData);
  await roomRef.update(withRoomActivity({ playbackLeaderPlayerId: nextLeaderId }));
}

async function advanceSong(roomId, nextIndex) {
  await db.collection("rooms").doc(roomId).update({
    currentSongIndex: nextIndex,
    status: "playing",
    playbackState: buildPlaybackState("pending", "system:advance-song"),
    playback: null,
    lastActivityAt: nowMs()
  });
}

async function syncRoomPlayback(roomId, actorId, playback) {
  const roomRef = db.collection("rooms").doc(roomId);
  const actorRef = roomRef.collection("players").doc(actorId);

  await db.runTransaction(async tx => {
    const [roomDoc, actorDoc] = await Promise.all([
      tx.get(roomRef),
      tx.get(actorRef)
    ]);

    if (!roomDoc.exists) {
      throw new Error("Room not found.");
    }

    if (!actorDoc.exists) {
      throw new Error("Playback actor is not in this room.");
    }

    const roomData = roomDoc.data() || {};
    const actorData = actorDoc.data() || {};
    const leaderId = roomData.playbackLeaderPlayerId || null;

    if (!leaderId) {
      throw new Error("Playback leader is not configured.");
    }

    if (leaderId !== actorId) {
      throw new Error("Only the playback leader can publish playback sync.");
    }

    if ((actorData.role || "player") === "screen" || !!actorData.isHost) {
      tx.update(roomRef, withRoomActivity({
        playback,
        playbackState: buildPlaybackState(derivePlaybackStatePhase(playback), "leader:sync")
      }));
      return;
    }

    throw new Error("Playback leader is invalid.");
  });
}

async function setRoomPlaybackState(roomId, actorId, phase, source = "host:manual") {
  const roomRef = db.collection("rooms").doc(roomId);
  const actorRef = roomRef.collection("players").doc(actorId);

  await db.runTransaction(async tx => {
    const [roomDoc, actorDoc] = await Promise.all([
      tx.get(roomRef),
      tx.get(actorRef)
    ]);

    if (!roomDoc.exists) {
      throw new Error("Room not found.");
    }

    if (!actorDoc.exists) {
      throw new Error("Host session not found.");
    }

    const actor = actorDoc.data() || {};
    if (!actor.isHost) {
      throw new Error("Only the host can update playback state.");
    }

    tx.update(roomRef, withRoomActivity({
      playbackState: {
        phase: normalizePlaybackStatePhase(phase),
        updatedAt: nowMs(),
        source: source || "host:manual"
      }
    }));
  });
}

async function setRoomPlaybackMode(roomId, actorId, mode) {
  const roomRef = db.collection("rooms").doc(roomId);
  const actorRef = roomRef.collection("players").doc(actorId);

  await db.runTransaction(async tx => {
    const [roomDoc, actorDoc] = await Promise.all([
      tx.get(roomRef),
      tx.get(actorRef)
    ]);

    if (!roomDoc.exists) throw new Error("Room not found.");
    if (!actorDoc.exists) throw new Error("Host session not found.");

    const actor = actorDoc.data() || {};
    if (!actor.isHost) throw new Error("Only the host can change playback mode.");

    tx.update(roomRef, withRoomActivity({
      playbackMode: normalizePlaybackMode(mode)
    }));
  });
}

async function markAllSongsPlayed(roomId) {
  await db.collection("rooms").doc(roomId).update(withRoomActivity({
    allSongsPlayed: true,
    playbackState: buildPlaybackState("ended", "system:all-songs-played")
  }));
}

async function resetGame(roomId) {
  const roomRef = db.collection("rooms").doc(roomId);

  const [roomDoc, playersSnap, songsSnap, guessesSnap] = await Promise.all([
    roomRef.get(),
    roomRef.collection("players").get(),
    roomRef.collection("songs").get(),
    roomRef.collection("guesses").get()
  ]);
  const roomData = roomDoc.exists ? (roomDoc.data() || {}) : {};
  const playbackMode = normalizePlaybackMode(roomData.playbackMode);

  const batch = db.batch();

  playersSnap.docs.forEach(doc => {
    batch.update(doc.ref, {
      score: 0,
      submitted: false,
      activePerkType: null,
      activePerkRound: null,
      activePerkTargetId: null,
      lastPerkSourceRound: null
    });
  });

  const playersData = playersSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));
  const nextLeaderId = resolvePlaybackLeaderIdFromPlayerData(playersData);

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
    playbackMode,
    playbackState: buildPlaybackState("pending", "system:reset-game"),
    playback: null,
    playbackLeaderPlayerId: nextLeaderId,
    playbackConfig: {
      autoplayEnabled: false,
      adPacingMode: "normal"
    },
    lastActivityAt: nowMs(),
    revealScoredRound: null,
    roundPerkAppliedRound: null
  });

  await batch.commit();
}

async function leaveRoom(roomId, playerId) {
  const roomRef = db.collection("rooms").doc(roomId);
  const playersQuery = roomRef.collection("players").orderBy("joinedAt", "asc");
  const now = Date.now();

  await db.runTransaction(async tx => {
    const playersSnap = await tx.get(playersQuery);
    if (playersSnap.empty) return;

    const players = playersSnap.docs;
    const leavingDoc = players.find(doc => doc.id === playerId);
    if (!leavingDoc) return;

    const leavingIsHost = !!leavingDoc.data()?.isHost;
    tx.delete(leavingDoc.ref);

    if (!leavingIsHost) {
      const remainingNonHost = players.filter(doc => doc.id !== playerId);
      const remainingData = remainingNonHost.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));
      const nextLeaderId = resolvePlaybackLeaderIdFromPlayerData(remainingData);
      tx.update(roomRef, withRoomActivity({ playbackLeaderPlayerId: nextLeaderId }));
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
      lastActivityAt: now,
      playbackLeaderPlayerId: resolvePlaybackLeaderIdFromPlayerData(
        remaining.map(doc => ({ id: doc.id, ...(doc.data() || {}) }))
      ),
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

async function ensureActiveHost(roomId, staleAfterMs = PLAYER_STALE_AFTER_MS, hostStaleAfterMs = HOST_STALE_AFTER_MS) {
  const roomRef = db.collection("rooms").doc(roomId);
  const playersQuery = roomRef.collection("players").orderBy("joinedAt", "asc");

  // Fetch players outside the transaction — tx.get() only supports DocumentRefs.
  const playersSnap = await playersQuery.get();
  if (playersSnap.empty) return { changed: false };

  const now = Date.now();
  const players = playersSnap.docs;
  const currentHostDoc = players.find(doc => !!doc.data()?.isHost);
  const currentHostLastSeen = currentHostDoc?.data()?.lastSeen || 0;
  const hostMissingOrStale = !currentHostDoc || (now - currentHostLastSeen) > hostStaleAfterMs;

  if (!hostMissingOrStale) return { changed: false };

  const activeCandidates = players.filter(doc => (now - (doc.data()?.lastSeen || 0)) <= staleAfterMs);
  const replacementDoc = activeCandidates[0] || players[0];
  if (!replacementDoc) return { changed: false };

  const replacementId = replacementDoc.id;
  const currentHostId = currentHostDoc?.id || null;

  // Already the correct host — nothing to do.
  if (currentHostId === replacementId && replacementDoc.data()?.isHost) {
    return { changed: false };
  }

  return db.runTransaction(async tx => {
    const roomDoc = await tx.get(roomRef);
    if (!roomDoc.exists) return { changed: false };

    // Re-fetch each player doc individually inside the transaction.
    const playerDocs = await Promise.all(players.map(p => tx.get(p.ref)));

    const replacementData = playerDocs.find(d => d.id === replacementId)?.data() || {};
    const projectedPlayers = playerDocs.map(doc => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        ...data,
        isHost: doc.id === replacementId
      };
    });
    const nextLeaderId = resolvePlaybackLeaderIdFromPlayerData(projectedPlayers);

    playerDocs.forEach(doc => {
      const data = doc.data() || {};
      if (doc.id === replacementId) {
        if (!data.isHost) tx.update(doc.ref, { isHost: true });
      } else if (data.isHost) {
        tx.update(doc.ref, { isHost: false });
      }
    });

    tx.update(roomRef, {
      lastActivityAt: now,
      playbackLeaderPlayerId: nextLeaderId,
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

async function reclaimHostIfEligible(roomId, playerId, reclaimWindowMs = HOST_RECLAIM_WINDOW_MS, staleAfterMs = PLAYER_STALE_AFTER_MS) {
  const roomRef = db.collection("rooms").doc(roomId);
  const roomDoc = await roomRef.get();
  if (!roomDoc.exists) return { changed: false };

  const roomData = roomDoc.data() || {};
  const hostChange = roomData.lastHostChange || null;
  const now = Date.now();

  if (!hostChange?.changedAt) return { changed: false };
  if (hostChange.previousHostId !== playerId) return { changed: false };
  if (!["host_disconnected", "host_missing"].includes(hostChange.reason)) return { changed: false };
  if ((now - hostChange.changedAt) > reclaimWindowMs) return { changed: false };

  const playersQuery = roomRef.collection("players").orderBy("joinedAt", "asc");
  const playersSnap = await playersQuery.get();
  if (playersSnap.empty) return { changed: false };

  const players = playersSnap.docs;
  const reclaimingDoc = players.find(doc => doc.id === playerId);
  const currentHostDoc = players.find(doc => !!doc.data()?.isHost);
  if (!reclaimingDoc) return { changed: false };
  if (currentHostDoc?.id === playerId) return { changed: false };

  const reclaimingData = reclaimingDoc.data() || {};
  const reclaimingLastSeen = reclaimingData.lastSeen || 0;
  if ((now - reclaimingLastSeen) > staleAfterMs) return { changed: false };

  return db.runTransaction(async tx => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) return { changed: false };

    const playerDocs = await Promise.all(players.map(p => tx.get(p.ref)));
    const freshReclaimingDoc = playerDocs.find(doc => doc.id === playerId);
    if (!freshReclaimingDoc.exists) return { changed: false };

    const projectedPlayers = playerDocs.map(doc => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        ...data,
        isHost: doc.id === playerId
      };
    });
    const nextLeaderId = resolvePlaybackLeaderIdFromPlayerData(projectedPlayers);

    playerDocs.forEach(doc => {
      const data = doc.data() || {};
      if (doc.id === playerId) {
        if (!data.isHost) tx.update(doc.ref, { isHost: true });
      } else if (data.isHost) {
        tx.update(doc.ref, { isHost: false });
      }
    });

    tx.update(roomRef, {
      lastActivityAt: now,
      playbackLeaderPlayerId: nextLeaderId,
      lastHostChange: {
        previousHostId: currentHostDoc?.id || null,
        hostId: playerId,
        hostName: freshReclaimingDoc.data()?.name || "Player",
        changedAt: now,
        reason: "host_reclaimed"
      }
    });

    return {
      changed: true,
      hostId: playerId,
      hostName: freshReclaimingDoc.data()?.name || "Player"
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
