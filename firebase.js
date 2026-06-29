import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyB5DizmQIgHOo7ceWW7xZjBKe7PKTUAOXI",
  authDomain: "ludo-bc5a4.firebaseapp.com",
  databaseURL: "https://ludo-bc5a4-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ludo-bc5a4",
  storageBucket: "ludo-bc5a4.firebasestorage.app",
  messagingSenderId: "251735799777",
  appId: "1:251735799777:web:646d877b7fd0e06004c4a0"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export { db };