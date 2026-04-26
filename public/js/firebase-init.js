// Firebase 初期化（みんなの出勤簿・統合版）
// 役割：メアド+パスワード認証、RTDB、PWA、共通ヘルパ
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, setPersistence, browserLocalPersistence, updateProfile,
  connectAuthEmulator
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getDatabase, ref, child, push, set, update, remove, get,
  onValue, off, query, orderByChild, equalTo, limitToLast,
  serverTimestamp, runTransaction, connectDatabaseEmulator
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

// --- 環境判定 ---------------------------------------------------------
const host = location.hostname;
export const IS_EMULATOR =
  host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') || host.startsWith('192.168.');

// --- 設定 -------------------------------------------------------------
const prodConfig = {
  apiKey: "AIzaSyDXhwm9eGBcK7I589vpYxhqI3EWLMK8qU0",
  authDomain: "attendance-app-b047c.firebaseapp.com",
  projectId: "attendance-app-b047c",
  databaseURL: "https://attendance-app-b047c-default-rtdb.firebaseio.com",
  storageBucket: "attendance-app-b047c.firebasestorage.app",
  messagingSenderId: "4615884946",
  appId: "1:4615884946:web:597976f564fd83fea0964b"
};

const demoConfig = {
  apiKey: "demo-api-key",
  authDomain: "localhost",
  projectId: "demo-minna-shukkinbo",
  databaseURL: `http://${host}:9000/?ns=demo-minna-shukkinbo-default-rtdb`
};

const firebaseConfig = IS_EMULATOR ? demoConfig : prodConfig;

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

if (IS_EMULATOR) {
  try { connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true }); } catch (_) {}
  try { connectDatabaseEmulator(db, host, 9000); } catch (_) {}
  console.log('[minna-shukkinbo] EMULATOR mode');
}

setPersistence(auth, browserLocalPersistence).catch(() => {});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// --- 再エクスポート（各 page から import 一本化） ---------------------
export {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile,
  ref, child, push, set, update, remove, get, onValue, off,
  query, orderByChild, equalTo, limitToLast, serverTimestamp, runTransaction
};

// --- 共通ヘルパ -------------------------------------------------------

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/** JST で yyyy-MM-dd */
export function dateKeyJST(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 月2回制の期間キー: 1-15日=H1 / 16-月末=H2 */
export function periodKeyFromDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const half = d <= 15 ? 'H1' : 'H2';
  return `${y}-${String(m).padStart(2, '0')}-${half}`;
}

/** 期間キーの範囲を返す [start, end] (両端含む yyyy-MM-dd) */
export function periodRange(periodKey) {
  const [y, m, half] = periodKey.split('-');
  const year = Number(y), month = Number(m);
  if (half === 'H1') return [`${y}-${m}-01`, `${y}-${m}-15`];
  const lastDay = new Date(year, month, 0).getDate();
  return [`${y}-${m}-16`, `${y}-${m}-${String(lastDay).padStart(2, '0')}`];
}

export function currentPeriodKey() { return periodKeyFromDate(dateKeyJST()); }

export function fmtHHmm(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtHHmmss(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// --- ロール判定（クライアント側ヒント用、サーバーでも .validate で再チェック）---
export function hasRole(profile, ...roles) {
  if (!profile) return false;
  return roles.includes(profile.role);
}

// --- ユーザー一覧キャッシュ（rivan-style）---
let _allUsers = null;
export async function loadAllUsers(force = false) {
  if (_allUsers && !force) return _allUsers;
  const snap = await get(ref(db, 'users'));
  _allUsers = snap.exists() ? snap.val() : {};
  return _allUsers;
}
export function getAllUsers() { return _allUsers || {}; }
