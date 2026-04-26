// 認証ガード（rivan-ops-pwa style + 三層ロール: staff / manager / office）
import {
  auth, db, ref, get, set, serverTimestamp, runTransaction,
  onAuthStateChanged, signOut, loadAllUsers
} from './firebase-init.js';

/** meta/firstOfficeUid が未設定なら自分を office に登録 (atomic) */
async function maybeAssignFirstOffice(uid) {
  const flagRef = ref(db, 'meta/firstOfficeUid');
  const tx = await runTransaction(flagRef, (cur) => cur ? undefined : uid);
  return tx.committed && tx.snapshot.val() === uid;
}

/**
 * ログイン必須。未ログインなら /login にリダイレクト。
 * 初回ログイン時は users/{uid} を自動作成し、初回ユーザーは office、それ以降は staff。
 * 解決値は profile = { id, name, email, role, ... }
 */
export function requireAuth(callback) {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) { location.href = '/login'; return; }

      const userRef = ref(db, `users/${user.uid}`);
      let snap = await get(userRef);

      if (!snap.exists()) {
        const fallbackName = user.displayName || (user.email ? user.email.split('@')[0] : user.uid.slice(0, 6));
        let role = 'staff';
        try { if (await maybeAssignFirstOffice(user.uid)) role = 'office'; } catch (_) {}
        try {
          await set(userRef, {
            name: fallbackName,
            email: user.email || '',
            role,
            color_index: Math.floor(Math.random() * 7),
            created_at: serverTimestamp(),
            updated_at: serverTimestamp()
          });
          snap = await get(userRef);
        } catch (ex) { console.error('user doc create failed:', ex); }
      }

      const profile = snap.exists()
        ? { id: user.uid, ...snap.val() }
        : { id: user.uid, name: user.email || '不明', email: user.email, role: 'staff' };

      try { await loadAllUsers(); } catch (_) {}

      window.__me = profile;
      window.__auth = user;
      unsub();
      if (callback) callback(profile, user);
      resolve(profile);
    });
  });
}

/**
 * requireAuth + ロール check。NG なら alert + /punch にリダイレクト。
 * usage: const me = await requireRole(['office']);
 */
export async function requireRole(roles, fallback = '/punch') {
  const me = await requireAuth();
  if (!roles.includes(me.role)) {
    alert(`この画面は ${roles.join(' / ')} 権限のみ操作可能です（現在: ${me.role}）`);
    location.href = fallback;
    return null;
  }
  return me;
}

/** 既ログインなら target にリダイレクト（login/register画面用） */
export function redirectIfAuthed(target = '/punch') {
  onAuthStateChanged(auth, (user) => {
    if (window.__suppressAuthRedirect) return;
    if (user) location.href = target;
  });
}

export async function logout() {
  await signOut(auth);
  location.href = '/login';
}

window.__logout = logout;
