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

// --- 打刻ヘルパ（4種: in / out / break_start / break_end）---

/** punch リストから現在の状態を判定: 'none' | 'working' | 'on_break' | 'done' */
export function getCurrentStatus(punches) {
  if (!punches || !punches.length) return 'none';
  const sorted = [...punches].sort((a, b) => a.timestamp - b.timestamp);
  const last = sorted[sorted.length - 1];
  switch (last.type) {
    case 'in':           return 'working';
    case 'out':          return 'done';
    case 'break_start':  return 'on_break';
    case 'break_end':    return 'working';
    default:             return 'none';
  }
}

/**
 * 1日分の punches から実働時間 (ms) を計算（マルチセッション対応）。
 *
 * 仕様：
 *   状態を時系列に走査して 'working' 区間の合計を workMs に加算する。
 *   - 1日に複数回の in/out（テレワークで再出勤など）→ 各セッションを個別に加算
 *     セッション間のギャップ（一旦退勤 → 移動 → 再出勤）は実働に含まれない
 *   - 複数回の break_start/break_end → 各休憩を個別に加算
 *   - 未閉ペアは無視（戻り打刻なし → 計上しない）
 *
 * 戻り値: { firstIn, lastOut, workMs, breakMs, hasIn, hasOut, status, sessions }
 *   sessions = 完結した (in→out) セッション数
 */
export function computeWorkHours(punches) {
  const result = {
    firstIn: null, lastOut: null,
    workMs: 0, breakMs: 0,
    hasIn: false, hasOut: false,
    status: 'none', sessions: 0
  };
  if (!punches || !punches.length) return result;
  const sorted = [...punches].sort((a, b) => a.timestamp - b.timestamp);

  // 表示用 firstIn / lastOut
  for (const p of sorted) {
    if (p.type === 'in' && result.firstIn === null) result.firstIn = p.timestamp;
    if (p.type === 'out') result.lastOut = p.timestamp;
  }
  result.hasIn  = result.firstIn !== null;
  result.hasOut = result.lastOut !== null;

  // 状態マシン走査
  let state = 'none';
  let workStart = null, breakStart = null;

  for (const p of sorted) {
    if (p.type === 'in') {
      if (state === 'none' || state === 'done') {
        workStart = p.timestamp;
        state = 'working';
      }
      // duplicate in は無視
    } else if (p.type === 'out') {
      if (state === 'working' && workStart != null) {
        result.workMs += p.timestamp - workStart;
        result.sessions++;
      } else if (state === 'on_break') {
        // 休憩中の直帰：未閉休憩はカウントしない、セッション完結扱いにはする
        result.sessions++;
      }
      workStart = null; breakStart = null;
      state = 'done';
    } else if (p.type === 'break_start') {
      if (state === 'working' && workStart != null) {
        result.workMs += p.timestamp - workStart;
        workStart = null;
        breakStart = p.timestamp;
        state = 'on_break';
      }
    } else if (p.type === 'break_end') {
      if (state === 'on_break' && breakStart != null) {
        result.breakMs += p.timestamp - breakStart;
        breakStart = null;
        workStart = p.timestamp;
        state = 'working';
      }
    }
  }
  result.status = state;
  return result;
}

/** ms → 時間（小数）*/
export function msToHours(ms) { return ms / 3600000; }

// --- ユーザー一覧キャッシュ（rivan-style）---
let _allUsers = null;
export async function loadAllUsers(force = false) {
  if (_allUsers && !force) return _allUsers;
  const snap = await get(ref(db, 'users'));
  _allUsers = snap.exists() ? snap.val() : {};
  return _allUsers;
}
export function getAllUsers() { return _allUsers || {}; }
