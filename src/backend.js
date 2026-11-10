// Firebase 백엔드: Firestore(공유 저장소) + 구글 계정 로그인 (v347: 팀 공용 비밀번호 → 사람마다 구글 계정)
// 누가 들어올 수 있는지는 Firestore의 members 모음(문서 ID = 구글 이메일, role 'owner'|'member')과 보안 규칙(firestore.rules)으로 정함.
// 저장소 API 모양(collection().onSnapshot / doc().set …)이 Artifact 공유 DB와 같아서 store.js는 그대로 씀.
// SDK는 Firebase CDN(gstatic)의 compat ESM 빌드를 지연 로드 — 설정이 비어 있으면 아무것도 불러오지 않음.
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
let firebase = null, auth = null, db = null;

export function hasFirebase() { return !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId); }

/** SDK를 불러와 초기화. { auth, db } 또는 (설정 없음·로드 실패) null */
export async function initFirebase() {
  if (!hasFirebase()) return null;
  if (db) return { auth, db };
  try {
    const mod = await import(SDK + 'firebase-app-compat.js');
    firebase = mod.default || window.firebase;
    await import(SDK + 'firebase-auth-compat.js');
    await import(SDK + 'firebase-firestore-compat.js');
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    auth = firebase.auth(); db = firebase.firestore();
    // 끊겼을 때 마지막 데이터로 계속 보이게 (여러 탭 동시 사용 허용). 지원 안 되는 브라우저면 그냥 온라인으로만
    try { await db.enablePersistence({ synchronizeTabs: true }); } catch { /* ignore */ }
    return { auth, db };
  } catch (e) {
    console.error('Firebase 로드 실패', e);
    return null;
  }
}

/** 로그인 상태 변화 구독. cb(user|null) */
export function onAuth(cb) { return auth ? auth.onAuthStateChanged(cb) : () => {}; }
export function currentUser() { return auth ? auth.currentUser : null; }

const AUTH_MSG = {
  'auth/popup-closed-by-user': '로그인 창을 닫았습니다. 다시 눌러 주세요.',
  'auth/cancelled-popup-request': '로그인 창을 닫았습니다. 다시 눌러 주세요.',
  'auth/unauthorized-domain': '이 사이트 주소가 Firebase에 등록되지 않았습니다. Firebase 콘솔 → Authentication → 설정 → 승인된 도메인에 이 주소를 추가하세요.',
  'auth/operation-not-allowed': 'Firebase 콘솔 → Authentication → 로그인 방법에서 "Google"을 사용 설정해야 합니다.',
  'auth/too-many-requests': '시도가 너무 많았습니다. 잠시 후 다시 해 주세요.',
  'auth/network-request-failed': '인터넷 연결을 확인해 주세요.',
};
/** 구글 계정으로 로그인 (팝업, 막히면 페이지 이동 방식). 실패하면 한국어 메시지로 throw */
export async function loginGoogle() {
  if (!auth) throw new Error('저장소에 아직 연결되지 않았습니다.');
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' }); // 여러 구글 계정 중에서 고르게
  try { await auth.signInWithPopup(provider); }
  catch (e) {
    if (e && e.code === 'auth/popup-blocked') { await auth.signInWithRedirect(provider); return; }
    throw new Error(AUTH_MSG[e && e.code] || `로그인 실패 (${(e && e.code) || e})`);
  }
}
/** 로그인한 구글 계정이 members 모음에 등록돼 있는지 → { ok, role } (등록 안 됨·권한 없음이면 ok false) */
export async function memberOf(email) {
  if (!db || !email) return { ok: false };
  try { const snap = await db.doc(`members/${String(email).toLowerCase()}`).get(); return snap.exists ? { ok: true, role: (snap.data() || {}).role || 'member' } : { ok: false }; }
  catch { return { ok: false }; }
}
export async function logout() { if (auth) await auth.signOut(); }
