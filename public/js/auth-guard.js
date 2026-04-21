// 認証ガード（みんなの出勤簿・最小構成）
import {
  auth, db, ref, get, set, serverTimestamp,
  onAuthStateChanged, signOut,
} from './firebase-init.js';

export function requireAuth(callback) {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        location.href = '/login';
        return;
      }
      const userRef = ref(db, `att_users/${user.uid}`);
      let snap = await get(userRef);
      if (!snap.exists()) {
        const fallbackName = user.displayName || (user.email ? user.email.split('@')[0] : user.uid.slice(0, 6));
        try {
          await set(userRef, {
            name: fallbackName,
            email: user.email || '',
            created_at: serverTimestamp(),
            updated_at: serverTimestamp(),
          });
          snap = await get(userRef);
        } catch (ex) {
          console.error('failed to create user doc:', ex);
        }
      }
      const profile = snap.exists()
        ? { id: user.uid, ...snap.val() }
        : { id: user.uid, name: user.email || '', email: user.email };
      window.__me = profile;
      unsub();
      if (callback) callback(profile, user);
      resolve(profile);
    });
  });
}

export function redirectIfAuthed(target = '/attendance') {
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
