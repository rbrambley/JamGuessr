# JamGuessr
**Whose song is it anyway?**

A multiplayer music guessing game hosted on GitHub Pages.  
Players pick songs, listen together, and try to guess who chose each track. Score points, climb the leaderboard, and reveal the full playlist at the end.

---

## How to play

1. One player **creates a room** and shares the room code.
2. Other players **join** with that code.
3. The host starts the game — everyone **picks songs** (one per round).
4. The group listens together and **guesses** who picked each track.
5. Correct guesses earn points. The **final leaderboard** and full playlist are revealed at the end.

---

## Setup

### 1. Firebase

This project uses [Firebase Firestore](https://firebase.google.com/) for real-time multiplayer state.

1. Create a free Firebase project at <https://console.firebase.google.com/>
2. Enable **Cloud Firestore** (start in test mode for development)
3. Set your Firebase config at runtime (before `js/firebase-config.js` loads) in both pages.

If only your API key is changing, you can set just this and use the built-in JamGuessr defaults:

```html
<script>
  window.__JAMGUESSR_FIREBASE_API_KEY__ = "YOUR_API_KEY";
</script>
```

Or set the full config object:

```html
<script>
  window.__JAMGUESSR_FIREBASE_CONFIG__ = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
  };
</script>
```

4. `js/firebase-config.js` now reads this runtime object and will throw if any fields are missing.

### 2. YouTube Search Backend

YouTube search now runs through a tiny Node backend so the API key is not exposed in the browser and repeated searches are cached across players.

Set your key before starting the app:

```powershell
$env:YOUTUBE_API_KEY="YOUR_YOUTUBE_DATA_API_KEY"
node server.js
```

This starts the site and the shared search endpoint at `http://localhost:3000`.

### 3. Deploy Backend To Render

This repo includes `render.yaml` so you can deploy the backend with Render Blueprint support.

1. Push this repo to GitHub.
2. In Render, choose **New +** -> **Blueprint**.
3. Select this repository.
4. Render will detect `render.yaml` and create the `jamguessr-backend` web service.
5. Set these environment variables in Render:

```text
YOUTUBE_API_KEY=YOUR_YOUTUBE_DATA_API_KEY
ALLOWED_ORIGIN=https://<your-username>.github.io
```

If your site will be served from `https://<your-username>.github.io/<repo-name>/`, the allowed origin is still:

```text
https://<your-username>.github.io
```

After deployment, Render will give you a backend URL like:

```text
https://jamguessr-backend.onrender.com
```

Update `js/firebase-config.js` to point to that backend:

```js
const YOUTUBE_SEARCH_ENDPOINT = "https://jamguessr-backend.onrender.com/api/youtube-search";
```

### 4. GitHub Pages

1. Commit and push to a GitHub repository.
2. Go to **Settings > Pages**, set the source to `main` branch / root.
3. Your game will be live at `https://<your-username>.github.io/<repo-name>/`

Note: the YouTube search backend cannot run on GitHub Pages alone. For production, host `server.js` on a Node-capable service and point your site to that origin.

---

## Project structure

```
index.html          — Home screen (create / join room)
game.html           — In-game screen (lobby, picking, playing, reveal, final)
css/
  styles.css        — Dark-theme styles
js/
  firebase-config.js  — Firebase init (fill in your keys)
  api.js            — Firestore read/write helpers
  state.js          — Runtime state variables
  game-logic.js     — Game flow + Firestore listeners
  ui.js             — Lobby UI rendering
server.js          — Static server + shared YouTube search cache endpoint
render.yaml        — Render deployment blueprint for backend
```

---

## Firestore data model

```
rooms/{roomId}
  code, hostName, maxRounds, status, currentRound, currentSongIndex, createdAt

  players/{playerId}
    name, score, isHost, submitted, joinedAt

  songs/{songId}
    title, artist, pickedBy, addedAt

  guesses/{guessId}
    songId, guessedBy, guessedPlayerId, submittedAt
```
