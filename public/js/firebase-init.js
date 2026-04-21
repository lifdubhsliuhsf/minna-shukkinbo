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
  apiKey: "AIzaSyBkkC4qKCHMsr7xs7s7lk7OAfOubdaOJtc",
  authDomain: "notification-dc72a.web.app",
  projectId: "notification-dc72a",
  databaseURL: "https://notification-dc72a-default-rtdb.firebaseio.com",
  storageBucket: "notification-dc72a.firebasestorage.app",
  messagingSenderId: "461811184321",
  appId: "1:461811184321:web:9b9238681681b58d545a40"
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
