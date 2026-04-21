// 出勤簿データの RTDB 永続化ヘルパ
// 構造:
//   /attendance/master                 マスタ（全員共有）: { entries: [...], updated_by, updated_at }
//   /attendance/months/{YYYY-MM}       月次データ: { uploaded_by, uploaded_at, filename, year, month, records: {...}, edits: {...} }

import { db, ref, get, set, update, onValue, off, serverTimestamp } from './firebase-init.js';

const MASTER_PATH = 'attendance/master';
const MONTHS_PATH = 'attendance/months';

export function ymKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ---- マスタ ----
export async function loadMaster() {
  const snap = await get(ref(db, MASTER_PATH));
  if (!snap.exists()) return { entries: [], updated_at: null, updated_by: null };
  const v = snap.val();
  return { entries: v.entries || [], updated_at: v.updated_at || null, updated_by: v.updated_by || null };
}

export async function saveMaster(entries, uid) {
  await set(ref(db, MASTER_PATH), {
    entries,
    updated_by: uid || null,
    updated_at: serverTimestamp(),
  });
}

export async function clearMaster() {
  await set(ref(db, MASTER_PATH), null);
}

// ---- 月次 ----
// recordsWithoutRows: records 配列から計算可能な rows は保存しない（idempotent 再計算）
//   ただしサマリ確認用に totals/monthAlerts と入力データ (dept/name/id/fullName等) は保存
export async function saveMonth(year, month, records, meta = {}, uid = null) {
  const key = ymKey(year, month);
  const path = `${MONTHS_PATH}/${key}`;
  const recMap = {};
  for (const r of records) {
    const k = String(r.id || '').replace(/[.#$\[\]\/]/g, '_') || `idx_${Object.keys(recMap).length}`;
    // 生データ（_rawDays）を保存。これがあれば計算は再現可能
    const rawDays = (r._rawDays || []).map(d => {
      const out = { day: d.day };
      if (d.status) out.status = d.status;
      if (d.actualInRaw) out.actualInRaw = d.actualInRaw;
      if (d.actualOutRaw) out.actualOutRaw = d.actualOutRaw;
      if (d.actualIn != null) out.actualIn = d.actualIn;
      if (d.actualOut != null) out.actualOut = d.actualOut;
      if (d.schedIn != null) out.schedIn = d.schedIn;
      if (d.schedOut != null) out.schedOut = d.schedOut;
      if (d.laborHours != null) out.laborHours = d.laborHours;
      return out;
    });
    recMap[k] = {
      id: r.id || '',
      name: r.name || '',
      dept: r.dept || '',
      fullName: r.fullName || '',
      store: r.store || '',
      grade: r.grade || '',
      days: rawDays,
    };
  }
  await set(ref(db, path), {
    uploaded_by: uid || null,
    uploaded_at: serverTimestamp(),
    filename: meta.filename || '',
    year, month,
    records: recMap,
  });
}

export async function loadMonth(year, month) {
  const key = ymKey(year, month);
  const snap = await get(ref(db, `${MONTHS_PATH}/${key}`));
  return snap.exists() ? snap.val() : null;
}

export async function listMonths() {
  const snap = await get(ref(db, MONTHS_PATH));
  if (!snap.exists()) return [];
  const val = snap.val() || {};
  return Object.entries(val)
    .map(([key, v]) => ({
      key,
      year: v.year || parseInt(key.split('-')[0], 10),
      month: v.month || parseInt(key.split('-')[1], 10),
      filename: v.filename || '',
      uploaded_at: v.uploaded_at || 0,
      uploaded_by: v.uploaded_by || null,
      count: v.records ? Object.keys(v.records).length : 0,
    }))
    .sort((a, b) => (b.key).localeCompare(a.key));
}

export async function deleteMonth(year, month) {
  await set(ref(db, `${MONTHS_PATH}/${ymKey(year, month)}`), null);
}

// ---- 編集（打刻漏れ補正） ----
// edits: { "{作業番号}": { "{day}": { inTime: "HH:MM", outTime: "HH:MM", note } } }
export async function saveEdit(year, month, workId, day, edit) {
  const key = ymKey(year, month);
  const safeId = String(workId).replace(/[.#$\[\]\/]/g, '_');
  const path = `${MONTHS_PATH}/${key}/edits/${safeId}/${day}`;
  if (edit == null) await set(ref(db, path), null);
  else await set(ref(db, path), { ...edit, updated_at: serverTimestamp() });
}

export async function loadEdits(year, month) {
  const key = ymKey(year, month);
  const snap = await get(ref(db, `${MONTHS_PATH}/${key}/edits`));
  return snap.exists() ? snap.val() : {};
}

// 保存された月次データから people を復元（buildMonthlyRecordsFromCard に渡せる形）
export function monthDataToPeople(monthData) {
  const records = monthData.records || {};
  return Object.values(records).map(r => ({
    id: r.id, name: r.name, dept: r.dept,
    fullName: r.fullName, store: r.store, grade: r.grade,
    days: r.days || [],
  }));
}

// edits を people の days に適用（手動補正の出勤/退勤で上書き）
export function applyEdits(people, edits) {
  if (!edits) return;
  const toHours = (s) => {
    if (!s) return null;
    const m = String(s).replace(/：/g, ':').match(/^(\d{1,2}):(\d{2})$/);
    return m ? parseInt(m[1], 10) + parseInt(m[2], 10) / 60 : null;
  };
  for (const p of people) {
    const safeId = String(p.id).replace(/[.#$\[\]\/]/g, '_');
    const personEdits = edits[safeId];
    if (!personEdits) continue;
    for (const [dayStr, edit] of Object.entries(personEdits)) {
      const d = parseInt(dayStr, 10);
      if (!d || d < 1 || d > 31) continue;
      // 該当日のデータを探す（無ければ追加）
      let slot = (p.days || []).find(x => x.day === d);
      if (!slot) {
        slot = { day: d };
        p.days = p.days || [];
        p.days.push(slot);
      }
      // 手動編集で実打刻を上書き
      if (edit.inTime || edit.outTime) {
        slot.actualInRaw = edit.inTime || '';
        slot.actualOutRaw = edit.outTime || '';
        slot.actualIn = toHours(edit.inTime);
        slot.actualOut = toHours(edit.outTime);
        slot.edited = true;
        slot.editNote = edit.note || '';
      }
    }
  }
}
