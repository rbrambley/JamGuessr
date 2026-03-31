const firebaseConfig = {
  apiKey: "AIzaSyCw4JX4m29X1-_ePlZlNW6DFX5Np41zvUw",
  authDomain: "jamguessr.firebaseapp.com",
  projectId: "jamguessr",
  storageBucket: "jamguessr.firebasestorage.app",
  messagingSenderId: "490683672522",
  appId: "1:490683672522:web:ae4c2fef947d002c63d133"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Backend endpoint used for YouTube search.
// For same-origin local development, keep the relative default.
// For GitHub Pages + separate backend hosting, replace with your full backend URL,
// for example: "https://your-backend.example.com/api/youtube-search"
const YOUTUBE_SEARCH_ENDPOINT = "https://jamguessr-backend.onrender.com/api/youtube-search";
