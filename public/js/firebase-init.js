// Firebase 初期化（みんなの出勤簿・最小構成）
// 別の Firebase プロジェクトに切り替えるときはこのファイルの firebaseConfig を差し替える
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, setPersistence,
  browserLocalPersistence, updateProfile,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getDatabase, ref, get, set, update, onValue, off, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDXhwm9eGBcK7I589vpYxhqI3EWLMK8qU0",
  authDomain: "attendance-app-b047c.firebaseapp.com",
  projectId: "attendance-app-b047c",
  databaseURL: "https://attendance-app-b047c-default-rtdb.firebaseio.com",
  storageBucket: "attendance-app-b047c.firebasestorage.app",
  messagingSenderId: "4615884946",
  appId: "1:4615884946:web:597976f564fd83fea0964b"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

setPersistence(auth, browserLocalPersistence).catch(() => {});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

export {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile,
  ref, get, set, update, onValue, off, serverTimestamp,
};

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
