const firebaseConfig = window.__JAMGUESSR_FIREBASE_CONFIG__ || {
  apiKey: window.__JAMGUESSR_FIREBASE_API_KEY__ || "",
  authDomain: "jamguessr.firebaseapp.com",
  projectId: "jamguessr",
  storageBucket: "jamguessr.firebasestorage.app",
  messagingSenderId: "490683672522",
  appId: "1:490683672522:web:ae4c2fef947d002c63d133"
};

const missingFirebaseFields = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingFirebaseFields.length > 0) {
  throw new Error(
    `Missing Firebase config fields: ${missingFirebaseFields.join(", ")}. ` +
    "Set window.__JAMGUESSR_FIREBASE_CONFIG__ before loading js/firebase-config.js"
  );
}

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Backend endpoint used for YouTube search.
// For same-origin local development, keep the relative default.
// For GitHub Pages + separate backend hosting, replace with your full backend URL,
// for example: "https://your-backend.example.com/api/youtube-search"
const YOUTUBE_SEARCH_ENDPOINT = "https://jamguessr-backend.onrender.com/api/youtube-search";
const YOUTUBE_BACKEND_HEALTH = "https://jamguessr-backend.onrender.com/health";

// Wake the Render free-tier backend immediately so it's ready before the user searches.
// Render spins down after inactivity; this first request triggers the cold start early.
(function pingBackend() {
  fetch(YOUTUBE_BACKEND_HEALTH).catch(() => {});
})();
