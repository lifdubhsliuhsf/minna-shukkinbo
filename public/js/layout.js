// レイアウトヘルパ：ヘッダ、ボトムナビ、フラッシュ通知

/** 上部ヘッダ HTML を返す */
export function renderHeader(title, opts = {}) {
  const { back, right } = opts;
  const backHtml = back
    ? `<a href="${back.href}" class="text-sm text-gray-500 hover:text-gray-900 mr-2">← ${back.label}</a>`
    : '';
  return `
    <header class="sticky top-0 z-20 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
      <div class="flex items-center min-w-0">
        ${backHtml}
        <h1 class="font-bold text-base truncate">${title}</h1>
      </div>
      <div class="flex items-center gap-3 text-sm">${right || ''}</div>
    </header>
  `;
}

/**
 * ボトムナビ HTML を返す。role を見て管理タブ・社労士タブを出し分け。
 * 現在のページに active マークを付けるため active=/punch などを渡す。
 */
export function renderBottomNav(activePath, role) {
  const tabs = [
    { path: '/punch',      label: '打刻',   emoji: '⏰', show: true },
    { path: '/today',      label: '一覧',   emoji: '📋', show: true },
    { path: '/period',     label: '期間',   emoji: '📅', show: true },
    { path: '/admin',      label: '管理',   emoji: '🔧', show: role === 'manager' || role === 'office' },
    { path: '/attendance', label: '社労士', emoji: '📊', show: role === 'office' },
    { path: '/settings',   label: '設定',   emoji: '⚙️', show: true },
  ].filter(t => t.show);

  return `
    <nav class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-30">
      <div class="max-w-3xl mx-auto grid" style="grid-template-columns: repeat(${tabs.length}, 1fr);">
        ${tabs.map(t => {
          const active = activePath === t.path;
          const cls = active ? 'text-gray-900 font-bold' : 'text-gray-400 hover:text-gray-700';
          return `
            <a href="${t.path}" class="${cls} flex flex-col items-center justify-center py-2 text-[11px]">
              <span class="text-lg leading-none">${t.emoji}</span>
              <span class="mt-0.5">${t.label}</span>
            </a>`;
        }).join('')}
      </div>
    </nav>
  `;
}

/** 一時的なフラッシュメッセージ（成功/エラー） */
export function showFlash(msg, type = 'ok') {
  const el = document.createElement('div');
  const cls = type === 'err'
    ? 'bg-red-100 text-red-900 border-red-400'
    : 'bg-green-100 text-green-900 border-green-400';
  el.className = `fixed top-4 left-1/2 -translate-x-1/2 px-5 py-3 border rounded shadow-lg z-50 ${cls} text-sm font-bold pointer-events-none`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}
