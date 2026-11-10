// 저장소: 1) claude.ai 안이면 Artifact 공유 DB(claude.use('db')), 2) firebase-config.js에 설정이 있으면 Firebase Firestore(팀 비밀번호 로그인),
// 3) 둘 다 없으면 브라우저 localStorage. 예시 모드(demo)에서는 메모리에만 기록하고 저장하지 않음.
import { makeDemoData } from './demo.js';
import { configureBreaks } from './model.js';
import { hasFirebase, initFirebase, onAuth, loginGoogle as fbLogin, logout as fbLogout, memberOf } from './backend.js';

// legacy: 전산 백데이터(엑셀)에서 옮긴 과거 충진·포장 실적. 날짜별 1건 {date, batches[], packs[]} — 생산실적 분석·대시보드 집계에만 합산되고 실적 입력 화면에는 나오지 않음
// claims: 클레임 LOT 페이지에 올린 클레임 목록 저장본 {id, name, savedAt, items[], overrides{}, extraHeads[]} — 새로고침해도 유지, 팀이 같이 봄
// journals: 생산일지 입력 임시저장본 {id, fillerId, date, cols[], pages[], notes[], status 'draft'|'saved', source, updatedAt} — 검수 후 최종 저장하면 saved
// shipments: 출고현황 — 전산 출하현황 엑셀의 달별 요약 {id 'YYYY-MM', kind 'month'} + 제품 LOT별 출고처 {id 'YYYY-MM-lots', kind 'lots'} (src/shipdata.js)
// shiplots (v316): 출고현황의 제품 LOT별 출고처 문서(YYYY-MM-lots)만 복사한 것 — 매출 없음, 모두 읽기 가능 (클레임 원인 분석의 출고처별 클레임용)
// members (v347, Firebase 사이트 전용): 들어올 수 있는 구글 계정 {id: 이메일(소문자), email, role 'owner'|'member', name, addedAt} — 관리자만 읽고 씀
export const COLLECTIONS = ['products', 'materials', 'materialLots', 'cultures', 'separations', 'batches', 'packs', 'plans', 'bom', 'bomTop', 'legacy', 'claims', 'journals', 'logs', 'shipments', 'shiplots', 'members'];

export const DEFAULT_SETTINGS = {
  companyName: '요즘 생산팀',
  headcount: {},          // 월별 총인원 { 'YYYY-MM': 명 } — 생산실적 분석의 1인당 생산량 분모
  lotDateOffset: 1,
  offDays: [6], // 공장 휴무 요일(0=일 … 6=토). 배출일이 휴무면 다음 가동일로 → 금요일 배양 LOT는 일요일 날짜
  tanks: [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `T${String(i + 1).padStart(2, '0')}`, name: `${i + 1}번 탱크`, capT: 5 })),
    { id: 'T11', name: '11번 탱크', capT: 2 }, { id: 'T12', name: '12번 탱크', capT: 2 },
  ],
  lines: [
    { id: 'L1', name: '1배관', tankIds: ['T01', 'T02', 'T03', 'T04'], dest: '유청분리실 · 필터프레스' },
    { id: 'L2', name: '2배관', tankIds: ['T05', 'T06', 'T07', 'T08'], dest: '유청분리실' },
    { id: 'L3', name: '3배관', tankIds: ['T09', 'T10', 'T11', 'T12'], dest: '유청분리실 · 드링크' },
  ],
  // crew: 설비별 기본 작업자 (충진/캡/포장) — 배치 등록 시 자동으로 채워지고 기준정보에서 수정
  fillers: [
    { id: 'F1', name: '1호기', code: 'A', crew: { fill: ['쟌란란', '박은주'], cap: ['박성환'], pack: ['김옥기', '이도경'] } },
    { id: 'F2', name: '2호기', code: 'B', crew: { fill: ['김병창', '채태호'], cap: ['박성환'], pack: ['이춘란', '손정화'] } },
    { id: 'F3', name: '3호기', code: 'C', crew: { fill: ['최승훈', '이가은'], cap: ['박성환'], pack: ['최경혜', '황순주'] } },
    { id: 'F4', name: '4호기', code: 'D', crew: { fill: ['박윤영', '박건호'], cap: ['박경민'], pack: [] } },
    { id: 'FR', name: '로타리', code: 'F', crew: { fill: ['김상미'], cap: [], pack: ['이상희'] } },
    { id: 'FS', name: '반자동', code: 'J', crew: { fill: ['김수지', '이태섭'], cap: [], pack: ['김춘옥', '이미숙'] } },
    { id: 'FD', name: '드링크', code: 'K', crew: { fill: ['박영섭'], cap: [], pack: ['임소영', '윤재훈'] } },
    { id: 'FB', name: '벌크', code: '', crew: { fill: ['박승규', '이상호'], cap: [], pack: ['박성곤'] } },
  ],
  cultureTypes: ['일반 배양', '필터프레스 1호기', '필터프레스 2호기', '일반 드링크', '우베 드링크', '락토프리 드링크'], // v346: 필터프레스 배출 → 1호기·2호기
  // 필터프레스(유청분리실 설비): 1~4번 탱크(배관 행선지에 '필터프레스')에서 최대 2,000 L를 받아 면포로 만듦. 예상 면포 = L × 비중 ÷ 51.5 kg
  pressMaxL: 2000,
  // 휴게 자동 차감(엑셀과 동일): 시작이 startBefore 이전·종료가 endAfter 이후인 배치에서 min 분을 가동 시간에서 뺌
  autoBreaks: [{ label: '점심', startBefore: '13:00', endAfter: '14:00', min: 70 }, { label: '오전 휴게', startBefore: '10:20', endAfter: '11:00', min: 40 }],
  pressKgPerCloth: 51.5,
  // 재공품 유형과 부재료(부원료) 출고 비율: 출고량 = 발효유 kg × 비율
  mixTypes: [ // 12종 고정(사용자 지정) · 비율은 회사 BOM(후배합공정품 ÷ 유청분리공정품)에서 산출
    { name: '플레인', ratio: 1 }, { name: '소프트', ratio: 1 }, { name: '말차', ratio: 1.15 }, { name: '카페', ratio: 1.155 }, { name: '알룰로스', ratio: 1.136 }, { name: '드링크', ratio: 1 },
    { name: '블루베리', ratio: 1.225 }, { name: '아사이볼', ratio: 1.195 }, { name: '한정선', ratio: 1.333 }, { name: '우베', ratio: 1.25 }, { name: '나이트루틴', ratio: 1.235 }, { name: '폐기', ratio: 1 },
  ],
  workers: [],
  productLotDateBase: 'expiry', // 'expiry' = 소비기한 기준, 'fill' = 충진일 기준
  milkDensity: 1.03,
  retentionEnabled: true, // 반기 자동 정리: 1월에 전년 1~6월, 7월에 전년 7~12월 실적 삭제
  exports: {},            // 월별 엑셀 내보내기 기록 { 'YYYY-MM': 내보낸 날짜 }
};

const LS_KEY = 'yozm-pm-v1';

const listeners = new Set();
// backend: 'artifact' | 'firebase' | 'local' · needLogin: Firebase 모드에서 아직 로그인 전
let state = {
  ready: false, mode: 'init', backend: '', needLogin: false, canWrite: true, isOwner: true, demo: false,
  settings: { ...DEFAULT_SETTINGS },
  ...Object.fromEntries(COLLECTIONS.map((c) => [c, []])),
};
let real = null;     // demo 모드 진입 전 실제 상태 백업
let db = null;
let unsubs = [];

export function getState() { return state; }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(state); }
// 제품은 기준정보의 표시 순서(sort)대로, 없으면 이름순
const bySort = (a, b) => ((a.sort ?? 9999) - (b.sort ?? 9999)) || String(a.name || '').localeCompare(String(b.name || ''), 'ko');
function set(patch) {
  if (Array.isArray(patch.products)) patch = { ...patch, products: [...patch.products].sort(bySort) };
  if (patch.settings) configureBreaks(patch.settings.autoBreaks);
  state = { ...state, ...patch }; emit();
}

// ---------- localStorage ----------
function loadLocal() {
  try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function persistLocal() {
  if (state.demo || state.mode !== 'local') return;
  try {
    const data = { settings: state.settings };
    for (const c of COLLECTIONS) data[c] = state[c];
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch { /* 저장 불가 환경 */ }
}

// ---------- Firestore 변환 ----------
// Firestore는 '배열 안의 배열'을 못 저장함(예: 클레임 대장 items[].extras = [[머리글, 값], …]).
// Firebase 모드에서만 저장할 때 안쪽 배열을 { _nested: [...] }로 감싸고, 읽을 때 다시 배열로 풀어 줌. 앱 코드는 그대로.
function fsEncode(v, inArr) {
  if (Array.isArray(v)) { const a = v.map((x) => fsEncode(x, true)); return inArr ? { _nested: a } : a; }
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) { if (v[k] !== undefined) o[k] = fsEncode(v[k], false); } return o; }
  return v;
}
function fsDecode(v) {
  if (Array.isArray(v)) return v.map(fsDecode);
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (ks.length === 1 && ks[0] === '_nested' && Array.isArray(v._nested)) return v._nested.map(fsDecode);
    const o = {}; for (const k of ks) o[k] = fsDecode(v[k]); return o;
  }
  return v;
}
const isFs = () => state.backend === 'firebase';
const toDb = (doc) => { const plain = JSON.parse(JSON.stringify(doc)); return isFs() ? fsEncode(plain, false) : plain; };
const fromDb = (d) => (isFs() ? fsDecode(d) : d);

// ---------- init ----------
/** 설정 문서 + 모든 컬렉션을 실시간 구독 (Artifact DB와 Firestore 모두 같은 API) */
function subscribeAll() {
  unsubscribeAll();
  const pending = new Set(['settings', ...COLLECTIONS]);
  const done = (k) => { pending.delete(k); if (!pending.size && !state.ready) set({ ready: true }); };
  unsubs.push(db.doc('settings/master').onSnapshot((snap) => {
    const d = snap.exists ? fromDb(snap.data()) : null;
    set({ settings: d ? { ...DEFAULT_SETTINGS, ...d } : { ...DEFAULT_SETTINGS } });
    done('settings');
  }, () => done('settings')));
  for (const c of COLLECTIONS) {
    unsubs.push(db.collection(c).onSnapshot((snap) => {
      const docs = snap.docs.map((d) => fromDb(d.data()));
      if (!state.demo) set({ [c]: docs });
      else real[c] = docs;
      done(c);
    }, () => done(c)));
  }
  setTimeout(() => { if (!state.ready) set({ ready: true }); }, 8000);
}
function unsubscribeAll() { for (const u of unsubs) { try { u(); } catch { /* ignore */ } } unsubs = []; }

export async function init() {
  let dbNs = null;
  if (window.claude && typeof window.claude.use === 'function') {
    try { dbNs = await window.claude.use('db'); } catch { dbNs = null; }
  }
  if (dbNs) {
    db = dbNs;
    let canWrite = true; let isOwner = false;
    try {
      const user = await window.claude.use('user');
      if (user) { const w = await user.can('data.write'); if (w === false) canWrite = false; isOwner = !!(await user.isOwner()); }
    } catch { /* ignore */ }
    // isOwner: 아티팩트 주인(사장님 계정)만 true → 출고현황 메뉴·출하 데이터는 주인만 (v250. 저장소 규칙으로도 shipments는 주인만 읽고 씀)
    set({ mode: 'db', backend: 'artifact', canWrite, isOwner });
    subscribeAll();
    return;
  }
  // 아티팩트(claude.ai) 안인데 공유 저장소를 못 받으면(로그인 풀림·권한 없음) 빈 로컬 모드로 떨어지지 않고 '연결 안 됨'으로 표시.
  // 예전에는 조용히 "이 브라우저에 저장 · 기록 0건"이 되어 실적이 모두 사라진 것처럼 보였음
  if (window.claude && typeof window.claude.use === 'function') {
    const patch = { mode: 'nodb', backend: 'artifact', ready: true, canWrite: false, settings: { ...DEFAULT_SETTINGS } };
    for (const c of COLLECTIONS) patch[c] = [];
    set(patch);
    return;
  }
  if (hasFirebase()) {
    const fb = await initFirebase();
    if (fb) {
      db = fb.db;
      set({ mode: 'db', backend: 'firebase', canWrite: true });
      // 로그인 상태에 따라 구독 시작/해제. 로그인 전에는 로그인 화면(app.js)만 표시
      // v347: 구글 로그인 → members 모음에 등록된 이메일인지 확인 → 등록돼 있으면 구독, 아니면 '등록 대기' 화면
      //  role 'owner'(관리자)만 출고현황(매출)·사용자 관리. 저장소 규칙(firestore.rules)도 같은 기준으로 막음
      onAuth(async (user) => {
        const empty = () => { const p = { settings: { ...DEFAULT_SETTINGS } }; for (const c of COLLECTIONS) p[c] = []; return p; };
        if (!user) { unsubscribeAll(); set({ ...empty(), needLogin: true, needAccess: false, userEmail: '', ready: true }); return; }
        const email = String(user.email || '').toLowerCase();
        set({ needLogin: false, ready: false, userEmail: email });
        const m = await memberOf(email);
        if (!m.ok) { unsubscribeAll(); set({ ...empty(), needAccess: true, ready: true }); return; }
        set({ needAccess: false, isOwner: m.role === 'owner', canWrite: true });
        subscribeAll();
      });
      return;
    }
  }
  const data = loadLocal();
  const patch = { mode: 'local', backend: 'local', ready: true, canWrite: true };
  if (data) {
    patch.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    for (const c of COLLECTIONS) patch[c] = Array.isArray(data[c]) ? data[c] : [];
  }
  set(patch);
}

// ---------- 로그인 (Firebase 모드) ----------
export async function login() { await fbLogin(); } // v347: 구글 계정 로그인
export async function logout() { await fbLogout(); }

// ---------- writes ----------
export async function save(col, doc) {
  if (!doc.id) throw new Error('id 없음');
  const arr = state[col].filter((x) => x.id !== doc.id).concat([doc]);
  set({ [col]: arr });
  if (state.demo) return;
  if (state.mode === 'db') await db.collection(col).doc(doc.id).set(toDb(doc));
  else persistLocal();
}
export async function remove(col, id) {
  set({ [col]: state[col].filter((x) => x.id !== id) });
  if (state.demo) return;
  if (state.mode === 'db') await db.collection(col).doc(id).delete();
  else persistLocal();
}
export async function saveSettings(patch) {
  const settings = { ...state.settings, ...patch };
  set({ settings });
  if (state.demo) return;
  if (state.mode === 'db') await db.doc('settings/master').set(toDb(settings));
  else persistLocal();
}

// ---------- demo ----------
export function enterDemo() {
  if (state.demo) return;
  real = { settings: state.settings };
  for (const c of COLLECTIONS) real[c] = state[c];
  const demo = makeDemoData(DEFAULT_SETTINGS);
  set({ demo: true, settings: { ...DEFAULT_SETTINGS, companyName: '예시 생산팀' }, ...demo });
}
export function exitDemo() {
  if (!state.demo) return;
  const patch = { demo: false, settings: real.settings };
  for (const c of COLLECTIONS) patch[c] = real[c];
  real = null;
  set(patch);
}

/** 전체 데이터 JSON 내보내기 (백업) */
export function exportJSON() {
  const data = { exportedAt: new Date().toISOString(), settings: state.settings };
  for (const c of COLLECTIONS) data[c] = state[c];
  return JSON.stringify(data, null, 2);
}
/** JSON 백업 가져오기 (id 기준 병합) */
export async function importJSON(text) {
  const data = JSON.parse(text);
  let count = 0;
  // Firebase: 수천 건을 한 건씩 기다리면 몇 분 걸려서 묶음(batch, 최대 300건·약 4MB)으로 씀. 화면은 실시간 구독으로 따라옴
  if (state.mode === 'db' && isFs() && !state.demo) {
    let batch = db.batch(), n = 0, bytes = 0;
    const flush = async () => { if (n) await batch.commit(); batch = db.batch(); n = 0; bytes = 0; };
    for (const c of COLLECTIONS) {
      if (!Array.isArray(data[c])) continue;
      for (const doc of data[c]) {
        if (!doc || !doc.id) continue;
        const enc = toDb(doc); const sz = JSON.stringify(enc).length;
        if (n >= 300 || bytes + sz > 4e6) await flush();
        batch.set(db.collection(c).doc(String(doc.id)), enc); n++; bytes += sz; count++;
      }
    }
    if (data.settings) { batch.set(db.doc('settings/master'), toDb({ ...state.settings, ...data.settings })); n++; }
    await flush();
    return count;
  }
  for (const c of COLLECTIONS) {
    if (!Array.isArray(data[c])) continue;
    for (const doc of data[c]) { if (doc && doc.id) { await save(c, doc); count++; } }
  }
  if (data.settings) await saveSettings(data.settings);
  return count;
}
