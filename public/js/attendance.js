// 出勤簿生成ロジック（タイムカードxls → 個人別月次出勤簿）
// SheetJS (window.XLSX) を使用

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];
const LEGAL_DAILY_HOURS = 8;
const LEGAL_WEEKLY_HOURS = 40;
const MONTHLY_OT_LIMIT = 45; // 36協定上限
const BREAK_HOURS = 0.75;    // 休憩一律45分
const NIGHT_START = 22;      // 深夜労働 22:00-05:00
const NIGHT_END = 29;        // = 翌5:00 (5 + 24)

// "HH:MM" or "HH：MM"（全角コロン）を 0-100 の小数時間に変換
function toHours(hhmm) {
  if (hhmm == null) return null;
  const s = String(hhmm).replace(/：/g, ':').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
}

function fmtTime(h) {
  if (h == null || isNaN(h)) return '';
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function round2(x) { return Math.round(x * 100) / 100; }

// セル内の "16:4321:57" や "16:43 21:57" を ["16:43","21:57"] に分解
function extractTimes(cell) {
  if (cell == null) return [];
  const s = String(cell).trim();
  if (!s) return [];
  const arr = [];
  const re = /(\d{1,2}):(\d{2})/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    arr.push(`${m[1].padStart(2, '0')}:${m[2]}`);
  }
  return arr;
}

// 22:00-翌5:00 の深夜労働時間を算出
// 出勤 inH が 5 未満（例：00:30 出勤）の場合は前日から持ち越したとみなし深夜帯拡張
function nightHours(inH, outH) {
  // 通常帯: 出勤時刻以降 → [22,29) を深夜としてカウント
  let night = Math.max(0, Math.min(outH, NIGHT_END) - Math.max(inH, NIGHT_START));
  // 出勤が 5 未満の場合、inH~5 は深夜
  if (inH < 5) night += Math.max(0, Math.min(outH, 5) - inH);
  return night;
}

// 年月を推定：出席統計の「統計日」文字列から
function parseYearMonthFrom(statSheet) {
  try {
    for (const row of statSheet) {
      for (const cell of row) {
        const s = String(cell || '');
        const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
      }
    }
  } catch (e) {}
  // フォールバック：ファイル名から
  return null;
}

// 出席記録シートから人ごとの日別打刻データを抽出
// 返り値: [{ id, name, dept, days: [{day, punches:[...]}] }]
function parseAttendanceSheet(sheet) {
  const people = [];
  for (let r = 0; r < sheet.length; r++) {
    const row = sheet[r] || [];
    // 「作業番号:」セルが含まれる行をヘッダ行とみなす
    const hasHeader = row.some(c => String(c || '').trim() === '作業番号:');
    if (!hasHeader) continue;

    // 各ラベル位置を取得
    const labelCols = {};
    for (let c = 0; c < row.length; c++) {
      const label = String(row[c] || '').trim();
      if (label === '作業番号:' || label === '名前:' || label === '部門:') {
        labelCols[label] = c;
      }
    }
    // ラベル間の非空セルを値とする（次ラベル手前まで走査）
    const STOPS = ['作業番号:', '名前:', '部門:'];
    const scanBetween = (startCol) => {
      for (let k = startCol + 1; k < row.length; k++) {
        const v = String(row[k] || '').trim();
        if (STOPS.includes(v)) return ''; // 次ラベルに到達 = 値なし
        if (v) return v;
      }
      return '';
    };
    const id = labelCols['作業番号:'] != null ? scanBetween(labelCols['作業番号:']) : '';
    const name = labelCols['名前:'] != null ? scanBetween(labelCols['名前:']) : '';
    const dept = labelCols['部門:'] != null ? scanBetween(labelCols['部門:']) : '';

    // 次の行が打刻データ（31列、col 0 = 日1）
    const dataRow = sheet[r + 1] || [];
    const days = [];
    for (let c = 0; c < 31; c++) {
      const punches = extractTimes(dataRow[c]);
      days.push({ day: c + 1, punches });
    }
    people.push({ id, name: name || `(無名 #${id})`, dept, days });
    r++; // データ行はスキップ
  }
  return people;
}

// 1日分の打刻から出勤・退勤・労働時間を計算
function computeDay(punches, dateObj) {
  if (!punches || punches.length === 0) return null;
  // 小数時間に変換
  const hours = punches.map(toHours).filter(x => x != null).sort((a, b) => a - b);
  if (hours.length === 0) return null;

  let inH = hours[0];
  let outH = hours[hours.length - 1];
  if (hours.length === 1) {
    // 打刻1つだけ → 退勤不明
    outH = null;
  }

  // 深夜またぎ（退勤が出勤より小さければ翌日）
  let spanH = null;
  let breakH = 0;
  let workH = 0;
  if (outH != null) {
    if (outH < inH) outH += 24;
    spanH = outH - inH;
    breakH = BREAK_HOURS; // 一律45分
    workH = Math.max(0, spanH - breakH);
  }

  const nightH = outH != null ? nightHours(inH, outH) : 0;
  const overtimeH = outH != null ? Math.max(0, workH - LEGAL_DAILY_HOURS) : 0;

  return {
    punches,
    inH,
    outH,
    breakH: round2(breakH),
    workH: round2(workH),
    overtimeH: round2(overtimeH),
    nightH: round2(nightH),
    incomplete: outH == null,
  };
}

// 年月の日数
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

// 1日分の日付 → 曜日番号 (0=Sun..6=Sat)
function weekdayOf(y, m, d) { return new Date(y, m - 1, d).getDay(); }

// 月曜始まりの週インデックス（月内通し番号、同じ週なら同じ値）
function weekIndexOf(y, m, d) {
  const dt = new Date(y, m - 1, d);
  // 月曜=0 として、月初1日からの週番号
  const firstDay = new Date(y, m - 1, 1);
  const firstMonOffset = (firstDay.getDay() + 6) % 7; // 月=0,..日=6
  const dayOffset = (dt.getDay() + 6) % 7;
  const daysSinceMonday = Math.floor((dt - firstDay) / 86400000) + firstMonOffset;
  return Math.floor(daysSinceMonday / 7);
}

// 人ごとの月次サマリを計算
export function buildMonthlyRecords(people, year, month) {
  const dim = daysInMonth(year, month);
  return people.map(person => {
    const rows = [];
    let monthWork = 0, monthOT = 0, monthNight = 0;
    // 週ごとの労働時間集計
    const weekWork = {}; // weekIdx -> cum labor hours (running)
    const weekOT = {};
    for (let d = 1; d <= dim; d++) {
      const wd = weekdayOf(year, month, d);
      const wk = weekIndexOf(year, month, d);
      const dayData = person.days[d - 1];
      const comp = computeDay(dayData.punches, null);
      const row = {
        day: d,
        weekday: WEEKDAY[wd],
        isHoliday: wd === 0 || wd === 6,
        punches: dayData.punches,
        inH: comp ? comp.inH : null,
        outH: comp ? comp.outH : null,
        breakH: comp ? comp.breakH : 0,
        workH: comp ? comp.workH : 0,
        overtimeH: comp ? comp.overtimeH : 0,
        nightH: comp ? comp.nightH : 0,
        incomplete: comp ? comp.incomplete : false,
        edited: !!dayData.edited,
        editNote: dayData.editNote || '',
        alerts: [],
      };
      if (row.edited) row.alerts.push('編集済');
      if (comp) {
        monthWork += row.workH;
        monthOT += row.overtimeH;
        monthNight += row.nightH;
        weekWork[wk] = (weekWork[wk] || 0) + row.workH;
        weekOT[wk] = (weekOT[wk] || 0) + row.overtimeH;
      }
      row.weekOTCum = round2(weekOT[wk] || 0);
      row.weekWorkCum = round2(weekWork[wk] || 0);

      if (row.incomplete) row.alerts.push('打刻漏れ');
      if (row.workH > LEGAL_DAILY_HOURS) row.alerts.push(`日${LEGAL_DAILY_HOURS}h超`);
      if (row.weekWorkCum > LEGAL_WEEKLY_HOURS) row.alerts.push(`週${LEGAL_WEEKLY_HOURS}h超`);

      rows.push(row);
    }
    // 月次アラート
    const monthAlerts = [];
    if (monthOT > MONTHLY_OT_LIMIT) {
      monthAlerts.push(`月残業${MONTHLY_OT_LIMIT}h超（36協定上限）: ${round2(monthOT)}h`);
    }
    return {
      ...person,
      year, month,
      rows,
      totals: {
        workH: round2(monthWork),
        overtimeH: round2(monthOT),
        nightH: round2(monthNight),
      },
      monthAlerts,
    };
  });
}

// 給料みなし手当.xlsx からマスタデータ（所属・氏名・グレード）を抽出
// シート名を見てもっとも新しい「*分 社労士*」優先、なければ「*分*」を見る
// 返り値: [{ store, fullName, surname, grade }]
export function parseMasterWorkbook(arrayBuffer) {
  const XLSX = window.XLSX;
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetNames = wb.SheetNames;
  const entries = [];

  // ---- 社労士シート（社員） ----
  const salSheet = sheetNames.find(n => /社労士/.test(n)) || sheetNames.find(n => /分/.test(n));
  if (salSheet) {
    entries.push(...parseSalariedSheet(XLSX.utils.sheet_to_json(wb.Sheets[salSheet], { header: 1, defval: '' })));
  }
  // ---- アルバイト時給一覧 ----
  const baitoSheet = sheetNames.find(n => /アルバイト/.test(n) || /時給/.test(n));
  if (baitoSheet) {
    entries.push(...parseBaitoSheet(XLSX.utils.sheet_to_json(wb.Sheets[baitoSheet], { header: 1, defval: '' })));
  }
  if (!entries.length) throw new Error('マスタのシートが見つかりません');
  return entries;
}

// 社労士用シートパーサ（「部門」行→「氏名」行を拾う）
function parseSalariedSheet(aoa) {
  const entries = [];

  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r] || [];
    if (String(row[0] || '').trim() !== '部門') continue;
    // この行の列 1..N から店舗名が広がる（空は直前の継承）
    const stores = [];
    let last = '';
    for (let c = 1; c < row.length; c++) {
      const v = String(row[c] || '').trim();
      if (v) last = v;
      stores.push(last);
    }
    // 次の「氏名」行を探す（通常は次の行）
    let nameRow = null;
    for (let k = r + 1; k < Math.min(r + 5, aoa.length); k++) {
      if (String((aoa[k] || [])[0] || '').trim() === '氏名') { nameRow = aoa[k]; break; }
    }
    if (!nameRow) continue;
    for (let c = 1; c < nameRow.length; c++) {
      const raw = String(nameRow[c] || '').trim();
      if (!raw) continue;
      // "谷川蓮也　店長G2" → 氏名と役職に分離（全角/半角スペース区切り）
      const parts = raw.split(/[\s　]+/);
      const fullName = parts[0];
      const grade = parts.slice(1).join(' ');
      const surname = fullName.slice(0, 2); // 多くの日本人姓は2文字（例外はあるが簡便）
      entries.push({ store: stores[c - 1] || '', fullName, surname, grade, type: '社員' });
    }
  }
  return entries;
}

// アルバイト時給一覧パーサ: 店舗名がヘッダ行にあり、以降の行に氏名／時給情報
function parseBaitoSheet(aoa) {
  const entries = [];
  if (!aoa.length) return entries;
  // 1行目: 店舗名が非空セルの列を持つ
  const header = aoa[0] || [];
  const storeByCol = {};
  let lastStore = '';
  for (let c = 0; c < header.length; c++) {
    const v = String(header[c] || '').trim();
    if (v) lastStore = v;
    storeByCol[c] = lastStore;
  }
  // 2行目以降: 各列は [氏名, 日給/時給, 金額, 備考...] のブロック
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] || '').trim();
      // 氏名らしき値（数値や空でない、かつラベルでない）。その右が "日給"/"時給" ならブロック先頭とみなす
      if (!v) continue;
      const next = String(row[c + 1] || '').trim();
      if (/^(日給|時給)$/.test(next)) {
        const store = storeByCol[c] || '';
        entries.push({ store, fullName: v, surname: v.slice(0, 2), grade: `バイト ${next}`, type: 'バイト' });
      }
    }
  }
  return entries;
}

// タイムカード上の氏名 ("谷川 74") からマスタを検索
// 姓の前方一致 or フルネーム一致
export function lookupMaster(masterEntries, timecardName) {
  if (!masterEntries || !masterEntries.length) return null;
  const s = String(timecardName || '').trim();
  if (!s) return null;
  // 番号などを除いた "姓" 部分を取る
  const baseName = s.replace(/[\s　]*\d+$/, '').trim(); // 末尾の数字を除去
  // フルネーム完全一致
  let hit = masterEntries.find(e => e.fullName === baseName);
  if (hit) return hit;
  // 姓1〜3文字の前方一致（最長優先）
  const candidates = masterEntries.filter(e => e.fullName.startsWith(baseName) || baseName.startsWith(e.surname));
  if (candidates.length === 0) return null;
  // 同姓多数なら返さない（誤マッチ防止）
  const uniqStores = new Set(candidates.map(c => c.store + '|' + c.fullName));
  if (uniqStores.size > 1 && baseName.length <= 2) {
    // 複数候補 → 曖昧フラグ
    return { ambiguous: true, candidates };
  }
  return candidates[0];
}

// カードレポートシート1枚を3人ブロックに分けてパース
// 1ブロック = 15列幅。人が埋まっていればエントリを返す
//   [{ id, name, dept, year, month, days: [{day, status, actualIn, actualOut, schedIn, schedOut, laborHours}], statusCounts }]
function parseCardReportSheet(aoa, sheetName) {
  const persons = [];
  if (!aoa || !aoa.length) return persons;
  const header0 = String((aoa[0] || [])[0] || '');
  if (!/カードレポート/.test(header0)) return persons;

  const BLOCK_W = 15;
  for (let base = 0; base + 10 <= (aoa[2] || []).length; base += BLOCK_W) {
    // Row 2: dept@base+1, name@base+9
    // Row 3: dateRange@base+1, workId@base+9
    const row2 = aoa[2] || [], row3 = aoa[3] || [];
    const labelDept = String(row2[base] || '').trim();
    if (labelDept !== '部門') continue; // ブロック構造が崩れていたらスキップ
    const dept = String(row2[base + 1] || '').trim();
    const name = String(row2[base + 9] || '').trim();
    const dateRange = String(row3[base + 1] || '').trim();
    const workId = String(row3[base + 9] || '').trim();
    if (!name) continue; // 未使用スロット

    // 日付範囲から年月を抽出: "2026-3-01 ~ 2026-3-31"
    const ymMatch = dateRange.match(/(\d{4})[-\/](\d{1,2})[-\/]\d{1,2}/);
    const year = ymMatch ? parseInt(ymMatch[1], 10) : null;
    const month = ymMatch ? parseInt(ymMatch[2], 10) : null;

    // Row 11-41 が日別データ（最大31日）
    const days = [];
    for (let r = 11; r < Math.min(aoa.length, 11 + 31); r++) {
      const row = aoa[r] || [];
      const dayLabel = String(row[base] || '').trim();
      const m = dayLabel.match(/^(\d{1,2})/);
      if (!m) continue;
      const day = parseInt(m[1], 10);
      const c = (off) => String(row[base + off] || '').trim();
      const actualInRaw = c(1), actualOutRaw = c(3);
      const schedInRaw = c(6), schedOutRaw = c(8);
      const laborRaw = c(10);

      // 特殊ステータス判定（第1 or 第2ゾーンの出勤セルに 有給/欠勤/出張 が入る）
      let status = null;
      const tryStatus = (v) => {
        if (!v) return null;
        if (/^(欠勤|休暇|有給|出張)$/.test(v)) return v;
        return null;
      };
      status = tryStatus(actualInRaw) || tryStatus(schedInRaw);

      const toH = (s) => {
        if (!s) return null;
        if (tryStatus(s)) return null;
        return toHours(s);
      };
      const actualIn = toH(actualInRaw);
      const actualOut = toH(actualOutRaw);
      const schedIn = toH(schedInRaw);
      const schedOut = toH(schedOutRaw);
      // 労働時間: 24h超は月合計値（最終行のサマリ）なので無視
      let laborHours = laborRaw ? (parseFloat(laborRaw) || null) : null;
      if (laborHours != null && laborHours > 24) laborHours = null;

      days.push({
        day,
        status,
        actualInRaw: tryStatus(actualInRaw) ? '' : actualInRaw,
        actualOutRaw: tryStatus(actualOutRaw) ? '' : actualOutRaw,
        actualIn, actualOut,
        schedIn, schedOut,
        laborHours,
      });
    }

    persons.push({ id: workId, name, dept, year, month, days, _sheet: sheetName });
  }
  return persons;
}

// 1日分のデータから出勤簿の row を計算
// 優先順位: 実打刻 > 所定時刻 > ステータス(欠勤/有給/出張)
function computeCardRow(dayData) {
  const { status, actualIn, actualOut, schedIn, schedOut, laborHours } = dayData;

  const result = {
    status: status || null,
    inH: null, outH: null,
    breakH: 0, workH: 0, overtimeH: 0, nightH: 0,
    source: 'empty',
    incomplete: false,
  };

  if (status) {
    result.source = 'status';
    return result;
  }

  // 優先: 実打刻（両方ある）→ 実打刻
  if (actualIn != null && actualOut != null) {
    result.inH = actualIn;
    let outH = actualOut < actualIn ? actualOut + 24 : actualOut;
    const span = outH - actualIn;
    result.breakH = BREAK_HOURS;
    result.workH = Math.max(0, span - BREAK_HOURS);
    result.outH = outH;
    result.source = 'actual';
  }
  // 実打刻 in のみ + 所定 out で補完
  else if (actualIn != null && schedOut != null) {
    result.inH = actualIn;
    let outH = schedOut < actualIn ? schedOut + 24 : schedOut;
    const span = outH - actualIn;
    result.breakH = BREAK_HOURS;
    result.workH = Math.max(0, span - BREAK_HOURS);
    result.outH = outH;
    result.source = 'mixed';
  }
  // 所定のみ（実打刻なし）
  else if (schedIn != null && schedOut != null) {
    result.inH = schedIn;
    let outH = schedOut < schedIn ? schedOut + 24 : schedOut;
    const span = outH - schedIn;
    result.breakH = BREAK_HOURS;
    result.workH = Math.max(0, span - BREAK_HOURS);
    result.outH = outH;
    result.source = 'scheduled';
  }
  // 最終手段: laborHours があればそれ
  else if (laborHours != null) {
    result.workH = laborHours;
    result.source = 'labor-only';
  }
  // 実打刻 in だけで所定も無い → 打刻漏れ
  else if (actualIn != null) {
    result.inH = actualIn;
    result.incomplete = true;
    result.source = 'incomplete';
  }

  // laborHours が明示的にあればそちらを信頼（システム側で既に休憩・丸めを考慮した値）
  if (laborHours != null && result.source !== 'status') {
    result.workH = laborHours;
  }

  // 残業・深夜
  result.overtimeH = round2(Math.max(0, result.workH - LEGAL_DAILY_HOURS));
  if (result.inH != null && result.outH != null) {
    result.nightH = round2(nightHours(result.inH, result.outH));
  }
  result.workH = round2(result.workH);
  result.breakH = round2(result.breakH);
  return result;
}

// カードレポート由来の people から月次 records を構築（出席記録由来より優先）
function buildMonthlyRecordsFromCard(people, year, month) {
  const dim = daysInMonth(year, month);
  return people.map(person => {
    const rows = [];
    let monthWork = 0, monthOT = 0, monthNight = 0;
    const weekWork = {}, weekOT = {};
    const daysMap = {};
    for (const d of person.days || []) daysMap[d.day] = d;

    for (let d = 1; d <= dim; d++) {
      const wd = weekdayOf(year, month, d);
      const wk = weekIndexOf(year, month, d);
      const dayData = daysMap[d] || { day: d, status: null };
      const comp = computeCardRow(dayData);

      const row = {
        day: d,
        weekday: WEEKDAY[wd],
        isHoliday: wd === 0 || wd === 6,
        status: comp.status,
        punches: [
          dayData.actualInRaw || '',
          dayData.actualOutRaw || '',
        ].filter(Boolean),
        inH: comp.inH,
        outH: comp.outH,
        breakH: comp.breakH,
        workH: comp.workH,
        overtimeH: comp.overtimeH,
        nightH: comp.nightH,
        incomplete: comp.incomplete,
        source: comp.source,
        alerts: [],
      };
      if (comp.status) row.alerts.push(comp.status);
      if (comp.source === 'scheduled') row.alerts.push('所定時刻で計上');
      if (comp.source === 'mixed') row.alerts.push('退勤は所定');
      if (comp.incomplete) row.alerts.push('打刻漏れ');

      monthWork += row.workH;
      monthOT += row.overtimeH;
      monthNight += row.nightH;
      weekWork[wk] = (weekWork[wk] || 0) + row.workH;
      weekOT[wk] = (weekOT[wk] || 0) + row.overtimeH;
      row.weekWorkCum = round2(weekWork[wk] || 0);
      row.weekOTCum = round2(weekOT[wk] || 0);
      if (row.workH > LEGAL_DAILY_HOURS) row.alerts.push(`日${LEGAL_DAILY_HOURS}h超`);
      if (row.weekWorkCum > LEGAL_WEEKLY_HOURS) row.alerts.push(`週${LEGAL_WEEKLY_HOURS}h超`);
      rows.push(row);
    }
    const monthAlerts = [];
    if (monthOT > MONTHLY_OT_LIMIT) monthAlerts.push(`月残業${MONTHLY_OT_LIMIT}h超: ${round2(monthOT)}h`);

    return {
      id: person.id, name: person.name, dept: person.dept,
      fullName: person.fullName, store: person.store, grade: person.grade,
      year, month,
      rows,
      totals: { workH: round2(monthWork), overtimeH: round2(monthOT), nightH: round2(monthNight) },
      monthAlerts,
      // 再計算用の生データ（RTDB保存時に使う）
      _rawDays: person.days || [],
    };
  });
}

// 保存データ（_rawDays を持つ records 配列の代わり）から records を再構築
export function rebuildRecordsFromRaw(personsRaw, year, month) {
  // personsRaw: [{id, name, dept, fullName, store, grade, days:[{...}] }]
  return buildMonthlyRecordsFromCard(personsRaw, year, month);
}

// xlsバッファをパース → 人ごとのレコード配列を返す
// 新実装: カードレポート（個人別シート）をメインデータとして使う
export function parseTimecardWorkbook(arrayBuffer, opts = {}) {
  const XLSX = window.XLSX;
  const wb = XLSX.read(arrayBuffer, { type: 'array' });

  const RESERVED = new Set(['シフト情報', '出席統計', '出席記録', '例外統計', 'Sheet1']);
  const cardSheetNames = wb.SheetNames.filter(n => !RESERVED.has(n));

  if (cardSheetNames.length === 0) {
    throw new Error('カードレポートシートが見つかりません');
  }

  // 全カードレポートから人を抽出
  const allPersons = [];
  for (const sn of cardSheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
    const persons = parseCardReportSheet(aoa, sn);
    allPersons.push(...persons);
  }

  // 対象年月の決定優先順位:
  //   1. opts.targetYM（UIからの明示指定）
  //   2. opts.filename に含まれる YYYYMM
  //   3. 各人のシート日付範囲の最頻値
  //   4. 現在月
  let targetYM = null;
  if (opts.targetYM) targetYM = opts.targetYM;
  else if (opts.filename) {
    const fm = opts.filename.match(/(\d{4})(\d{2})/);
    if (fm) targetYM = { year: +fm[1], month: +fm[2] };
  }
  if (!targetYM) {
    const ymCounts = {};
    for (const p of allPersons) {
      if (p.year && p.month) {
        const k = `${p.year}-${p.month}`;
        ymCounts[k] = (ymCounts[k] || 0) + 1;
      }
    }
    if (Object.keys(ymCounts).length > 0) {
      const top = Object.entries(ymCounts).sort((a, b) => b[1] - a[1])[0][0];
      const [y, m] = top.split('-').map(Number);
      targetYM = { year: y, month: m };
    }
  }
  if (!targetYM) targetYM = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };

  // シート内の日付ラベルは古いテンプレのまま更新されていないことがある。
  // ファイル名で年月が明示されている場合はラベルを信用せず、全員を取り込む。
  // そうでない場合のみ、対象月の人だけ含める。
  const trustLabels = !(opts.targetYM || opts.filename);
  const inScope = trustLabels
    ? allPersons.filter(p => p.year === targetYM.year && p.month === targetYM.month)
    : allPersons;
  const outScope = trustLabels
    ? allPersons.filter(p => p.name && !(p.year === targetYM.year && p.month === targetYM.month))
    : [];

  // 作業番号で重複排除
  const seen = new Set();
  const uniq = [];
  for (const p of inScope) {
    const key = String(p.id || p.name).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key); uniq.push(p);
  }

  // マスタ突合
  const master = opts.master || [];
  for (const p of uniq) {
    const hit = lookupMaster(master, p.name);
    if (hit && !hit.ambiguous) {
      p.fullName = hit.fullName;
      p.store = hit.store;
      p.grade = hit.grade;
    }
  }

  const records = buildMonthlyRecordsFromCard(uniq, targetYM.year, targetYM.month);
  return {
    records,
    year: targetYM.year,
    month: targetYM.month,
    excludedOtherMonth: outScope.map(p => ({ id: p.id, name: p.name, year: p.year, month: p.month })),
  };
}

// 1人分の出勤簿を AoA (xlsx行列) に変換
export function recordToAoa(rec, storeName = '') {
  const displayName = rec.fullName || rec.name;
  const store = rec.store || storeName;
  const grade = rec.grade ? `（${rec.grade}）` : '';
  const dept  = rec.dept ? `部門: ${rec.dept}` : '';
  const header1 = [`名前: ${displayName}${grade}`, `作業番号: ${rec.id}`, dept || `所属する店舗: ${store}`, `年月: ${rec.year}/${String(rec.month).padStart(2, '0')}`];

  // 集計アラートを上部に表示
  const flags = [];
  if (rec.monthAlerts && rec.monthAlerts.length) flags.push(...rec.monthAlerts);
  const anyWeek = rec.rows.some(row => row.alerts.some(a => a.startsWith('週')));
  const anyDay  = rec.rows.some(row => row.alerts.some(a => a.startsWith('日')));
  const anyIncomplete = rec.rows.some(row => row.incomplete);
  const anyEdit = rec.rows.some(row => row.edited);
  if (anyWeek)       flags.push('週40h超あり');
  if (anyDay)        flags.push('日8h超あり');
  if (anyIncomplete) flags.push('打刻漏れあり');
  if (anyEdit)       flags.push('編集あり');
  const alertLine = flags.length ? [`⚠ ${flags.join(' / ')}`] : [];

  const sep = ['', '', '', '', '', '', '', '', ''];
  const colHeader = ['日付', '出勤時間', '退勤時間', '休憩時間', '労働時間', '残業時間', '深夜労働時間', '残業時間累計[週]', 'アラート'];
  const aoa = [header1];
  if (alertLine.length) aoa.push(alertLine);
  aoa.push(sep, colHeader);
  for (const row of rec.rows) {
    aoa.push([
      `${rec.month}/${row.day}(${row.weekday})`,
      fmtTime(row.inH),
      fmtTime(row.outH),
      row.breakH || 0,
      row.workH || 0,
      row.overtimeH || 0,
      row.nightH || 0,
      row.weekOTCum || 0,
      row.alerts.join('／'),
    ]);
  }
  aoa.push([
    '合計', '', '', '',
    rec.totals.workH, rec.totals.overtimeH, rec.totals.nightH, '',
    rec.monthAlerts.join('／'),
  ]);
  return aoa;
}

// セル内容から列幅を推定（日本語2幅、ASCII1幅で概算）
function visualWidth(s) {
  if (s == null) return 0;
  const str = String(s);
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    // 半角英数・記号は1幅、それ以外（CJK全角・全角記号）は2幅
    w += (code < 0x7f || (code >= 0xff61 && code <= 0xff9f)) ? 1 : 2;
  }
  return w;
}

// AoA の各列最大幅を計算し、ws['!cols'] に設定
function autoFitColumns(ws, aoa, { min = 4, max = 60, padding = 2 } = {}) {
  if (!aoa || !aoa.length) return;
  const colCount = Math.max(...aoa.map(r => (r || []).length));
  const widths = new Array(colCount).fill(min);
  for (const row of aoa) {
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell == null || cell === '') continue;
      // 改行を含む場合は最長行に合わせる
      const lines = String(cell).split(/\r?\n/);
      const w = Math.max(...lines.map(visualWidth));
      if (w + padding > widths[c]) widths[c] = Math.min(max, w + padding);
    }
  }
  ws['!cols'] = widths.map(w => ({ wch: w }));
}

// AoA から列幅自動調整済みの worksheet を作る
function aoaToWs(aoa, opts) {
  const XLSX = window.XLSX;
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  autoFitColumns(ws, aoa, opts);
  return ws;
}

// 複数人分を1つのxlsxに（シート分割）してダウンロード
export function exportAllToXlsx(records, { storeName = '', filename = '出勤簿.xlsx' } = {}) {
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  // 1. サマリシート: 全員1行 + アラート集計
  const summary = [['作業番号', '氏名', '部門', '総労働時間', '総残業時間', '総深夜時間', 'アラート']];
  for (const r of records) {
    const flags = [];
    if (r.monthAlerts && r.monthAlerts.length) flags.push(...r.monthAlerts);
    const anyWeek = r.rows.some(row => row.alerts.some(a => a.startsWith('週')));
    const anyDay  = r.rows.some(row => row.alerts.some(a => a.startsWith('日')));
    const anyIncomplete = r.rows.some(row => row.incomplete);
    const anyEdit = r.rows.some(row => row.edited);
    if (anyWeek)       flags.push('週40h超あり');
    if (anyDay)        flags.push('日8h超あり');
    if (anyIncomplete) flags.push('打刻漏れ');
    if (anyEdit)       flags.push('編集あり');
    summary.push([
      r.id,
      r.fullName || r.name,
      r.dept || '',
      r.totals.workH,
      r.totals.overtimeH,
      r.totals.nightH,
      flags.join('／'),
    ]);
  }
  XLSX.utils.book_append_sheet(wb, aoaToWs(summary), 'サマリ');

  // 2. 各人シート: E001_上野 形式で識別性を確保
  const used = new Set(['サマリ']);
  for (const r of records) {
    const aoa = recordToAoa(r, storeName);
    const safeId   = String(r.id || '').replace(/[\/\\\?\*\[\]:]/g, '_');
    const safeName = String(r.fullName || r.name || '').replace(/[\/\\\?\*\[\]:]/g, '_');
    let base = (safeId && safeName) ? `${safeId}_${safeName}` : (safeName || safeId || `ID${r.id}`);
    base = base.slice(0, 28);
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base.slice(0, 25)}_${i++}`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, aoaToWs(aoa), name);
  }
  XLSX.writeFile(wb, filename);
}

// 1人分だけダウンロード
export function exportOneToXlsx(rec, { storeName = '', filename } = {}) {
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  const aoa = recordToAoa(rec, storeName);
  XLSX.utils.book_append_sheet(wb, aoaToWs(aoa), (rec.fullName || rec.name || `ID${rec.id}`).slice(0, 28));
  const fn = filename || `出勤簿_${rec.year}${String(rec.month).padStart(2, '0')}_${rec.fullName || rec.name || rec.id}.xlsx`;
  XLSX.writeFile(wb, fn);
}
