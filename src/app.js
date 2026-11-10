// 앱 셸: 사이드바 내비게이션, 라우팅, 저장소 초기화
import { html, render, useState, useEffect, useStore, Icon, Toasts, ConfirmHost } from './ui.js';
import { init, enterDemo, exitDemo, login, logout, importJSON, exportJSON, getState, save, remove } from './store.js';
import { retentionCandidates, purgeRetention } from './excel.js';
import { toast } from './ui.js';
import { n } from './util.js';
import { DashboardPage } from './pages/dashboard.js';
import { TracePage } from './pages/trace.js';
import { ClaimPage } from './pages/claim.js';
import { NcrPage } from './pages/ncr.js';
import { ClothAgePage } from './pages/clothage.js';
import { BanjeStockPage } from './pages/banjestock.js';
import { ShipPage } from './pages/ship.js';
import { AnalysisPage } from './pages/analysis.js';
import { CulturePage } from './pages/culture.js';
import { SeparationPage } from './pages/separation.js';
import { FillPage } from './pages/fill.js';
import { JournalPage } from './pages/journal.js';
import { ReconcilePage } from './pages/reconcile.js';
import { MaterialsPage } from './pages/materials.js';
import { MasterPage } from './pages/master.js';

// 사이드바 아래에 보이는 앱 버전: 게시할 때마다 올림 (어느 버전이 열렸는지 확인용)
const APP_VERSION = 'v348 (11/11)';

// 자사검사 = 클레임 LOT와 같은 추적 화면, 저장본만 따로 (claims 모음에 kind: 'inspect')
const InspectPage = (props) => html`<${ClaimPage} ...${props} kind="inspect" />`;

// 첫 화면·메뉴 첫 항목 = 생산실적 분석. 대시보드는 메뉴에서 뺐지만 #home 주소로는 여전히 열림(hidden)
const PAGES = {
  analysis: { title: '생산실적 분석', group: '현황', icon: 'chart', comp: AnalysisPage },
  ship: { title: '출고현황', group: '현황', icon: 'package', comp: ShipPage, parent: 'analysis', owner: true }, // 생산실적 분석의 하위 메뉴 · 아티팩트 주인만 (v250)
  trace: { title: 'LOT 추적', group: '현황', icon: 'search', comp: TracePage },
  ncr: { title: '클레임/자사검사 현황', group: '현황', icon: 'alert', comp: NcrPage }, // v253: '부적합 현황'에서 이름 변경
  claim: { title: '클레임 LOT', group: '현황', icon: 'alert', comp: ClaimPage, parent: 'ncr' }, // 클레임/자사검사 현황의 하위 메뉴 (기본 접힘)
  inspect: { title: '자사검사', group: '현황', icon: 'check', comp: InspectPage, parent: 'ncr' },
  banjestock: { title: '반제품 현황', group: '현황', icon: 'funnel', comp: BanjeStockPage }, // v307: 유청분리실 면포(반제품) 재고
  banje: { title: '반제 사용 현황', group: '현황', icon: 'flask', comp: ClothAgePage, parent: 'banjestock' }, // v301: 배양 LOT 배출 → 반출 경과일 주차별 · v307 반제품 현황 하위로 옮김
  home: { title: '대시보드', group: '현황', icon: 'home', comp: DashboardPage, hidden: true },
  culture: { title: '배양 실적', group: '실적 입력', icon: 'flask', comp: CulturePage },
  separation: { title: '유청분리 · 소분', group: '실적 입력', icon: 'funnel', comp: SeparationPage },
  fill: { title: '충진/포장 실적', group: '실적 입력', icon: 'package', comp: FillPage },
  journal: { title: '충진일지 등록', group: '실적 입력', icon: 'clipboard', comp: JournalPage },
  reconcile: { title: '전산 대조', group: '관리', icon: 'clipboard', comp: ReconcilePage },
  materials: { title: '원부자재 수불', group: '관리', icon: 'box', comp: MaterialsPage },
  master: { title: '기준정보', group: '관리', icon: 'settings', comp: MasterPage },
};

function readHash() { const h = (location.hash || '').replace(/^#/, ''); return PAGES[h] ? h : 'analysis'; }

// Firebase 모드 로그인 화면 (v347): 구글 계정으로 로그인. 등록된(members) 계정만 들어감
function LoginScreen({ companyName, email }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try { await login(); } catch (ex) { setErr(ex.message || String(ex)); }
    setBusy(false);
  };
  return html`<div class="login">
    <div class="login-box">
      <div class="brand"><div class="mark">Y</div><div><div class="name">요즘 생산관리</div><div class="sub">${companyName}</div></div></div>
      ${email ? html`<div class="login-err" style="line-height:1.5"><b>${email}</b> 계정은 아직 등록되지 않았습니다.<br />관리자에게 이 구글 이메일을 등록해 달라고 요청한 뒤 다시 들어오세요.</div>
        <button class="btn" type="button" onClick=${() => logout()}>다른 구글 계정으로 로그인</button>`
      : html`${err && html`<div class="login-err">${err}</div>`}
        <button class="btn primary" type="button" disabled=${busy} onClick=${go}>${busy ? '로그인 중…' : 'Google 계정으로 로그인'}</button>`}
      <div class="login-hint">관리자가 등록한 구글 계정만 들어올 수 있습니다. 한 번 로그인하면 이 브라우저에서는 계속 유지됩니다.</div>
    </div>
  </div>`;
}

function App() {
  const state = useStore();
  const [page, setPage] = useState(readHash());
  const [params, setParams] = useState({});
  const [menu, setMenu] = useState(false);
  // 하위 메뉴 펼침 상태: 기본은 모두 접힘. 하위 페이지를 열었을 때만 그 부모를 펼침
  const [subOpen, setSubOpen] = useState({});
  useEffect(() => { const par = PAGES[page].parent; if (par) setSubOpen((s) => s[par] ? s : { ...s, [par]: true }); }, [page]);
  useEffect(() => { init(); }, []);
  useEffect(() => { const f = () => setPage(readHash()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const go = (p, prm = {}) => { setParams({ ...prm, _t: Date.now() }); setPage(p); setMenu(false); try { history.replaceState(null, '', '#' + p); } catch { /* ignore */ } window.scrollTo({ top: 0 }); };

  // 반기 자동 정리: 쓰기 가능한 실제 저장소에서, 보관 기간이 끝난 달을 모두 엑셀로 내려받았으면 자동 삭제.
  // 내려받지 않은 달이 있으면 지우지 않고 배너로 안내 (기준정보 → 데이터 탭에서 처리)
  const [purged, setPurged] = useState(false);
  const ret = state.ready && state.mode === 'db' && state.canWrite && !state.demo && state.settings.retentionEnabled !== false ? retentionCandidates(state) : null;
  useEffect(() => {
    if (!ret || purged || !ret.items.length || ret.notExported.length) return;
    setPurged(true);
    purgeRetention(state).then((c) => toast(`보관 기간이 끝난 ${ret.months[0]}~${ret.months[ret.months.length - 1]} 실적 ${n(c)}건을 자동 삭제했습니다.`));
  }, [ret && ret.items.length, ret && ret.notExported.length, purged]);

  const groups = [...new Set(Object.values(PAGES).map((p) => p.group))];
  const Page = PAGES[page].comp;
  if (state.backend === 'firebase' && (state.needLogin || state.needAccess) && !state.demo) return html`<${LoginScreen} companyName=${state.settings.companyName} email=${state.needAccess ? state.userEmail : ''} /><${Toasts} />`;
  return html`
    <div class="shell">
      ${menu && html`<div class="side-bg" onClick=${() => setMenu(false)}></div>`}
      <aside class="side ${menu ? 'open' : ''}">
        <div class="brand"><div class="mark">Y</div><div><div class="name">요즘 생산관리</div><div class="sub">Production · LOT</div></div></div>
        <nav class="nav">
          ${groups.map((g) => html`<div key=${g}><div class="group">${g}</div>${Object.entries(PAGES).filter(([, p]) => p.group === g && !p.hidden && !p.parent && (!p.owner || state.isOwner)).map(([k, p]) => {
            const subs = Object.entries(PAGES).filter(([, c]) => c.parent === k && !c.hidden && (!c.owner || state.isOwner));
            const btn = html`<button class=${k === page ? 'active' : ''} onClick=${() => go(k)} aria-current=${k === page ? 'page' : undefined}><${Icon} name=${p.icon} />${p.title}</button>`;
            if (!subs.length) return html`<div key=${k}>${btn}</div>`;
            const open = !!subOpen[k];
            return html`<div key=${k}><div class="nav-row">${btn}<button class="tgl ${open ? 'open' : ''}" aria-label=${open ? '하위 메뉴 접기' : '하위 메뉴 펼치기'} aria-expanded=${open} title=${open ? '접기' : `${subs.map(([, c]) => c.title).join(', ')} 보기`} onClick=${() => setSubOpen({ ...subOpen, [k]: !open })}><${Icon} name="down" /></button></div>
              ${open && subs.map(([ck, c]) => html`<button key=${ck} class="sub ${ck === page ? 'active' : ''}" onClick=${() => go(ck)} aria-current=${ck === page ? 'page' : undefined}><${Icon} name=${c.icon} />${c.title}</button>`)}</div>`;
          })}</div>`)}
        </nav>
        <div class="side-foot">
          <div class="store"><span class="dot ${state.demo ? 'demo' : state.mode === 'nodb' ? 'off' : state.ready ? 'on' : ''}"></span>${state.demo ? '예시 데이터 · 저장 안 됨' : !state.ready ? '저장소 연결 중…' : state.mode === 'db' ? (state.canWrite ? '공유 저장소 연결됨' : '공유 저장소 · 읽기 전용') : state.mode === 'nodb' ? '공유 저장소 연결 안 됨' : '이 브라우저에 저장'}</div>
          <div>${state.settings.companyName} · 기록 ${state.cultures.length + state.batches.length + state.packs.length}건 · <span title="앱 버전 (게시할 때마다 올라감)">${APP_VERSION}</span></div>
          ${state.backend === 'firebase' && html`<div style="margin-top:6px;font-size:12px;opacity:.85;word-break:break-all">${state.userEmail}${state.isOwner ? ' · 관리자' : ''}</div><button class="linkish" style="margin-top:2px;font-size:12px" onClick=${() => logout()}>로그아웃</button>`}
        </div>
      </aside>
      <div class="main">
        <div class="topbar">
          <button class="icon-btn menu-btn" aria-label="메뉴" onClick=${() => setMenu(true)}><${Icon} name="menu" /></button>
          <div class="crumbs">${PAGES[page].group} / ${PAGES[page].parent ? `${PAGES[PAGES[page].parent].title} / ` : ''}<b>${PAGES[page].title}</b></div>
          ${state.demo ? html`<button class="btn sm primary" onClick=${exitDemo}>실제 데이터로 전환</button>` : html`<button class="btn sm ghost" onClick=${enterDemo} title="실제 기록을 건드리지 않고 화면을 확인합니다"><${Icon} name="eye" />예시 보기</button>`}
        </div>
        ${state.demo && html`<div class="banner warn" style="border-radius:0;justify-content:center"><${Icon} name="alert" /><span>예시 데이터입니다. 실제 요즘의 생산실적이 아니며, 입력한 내용은 저장되지 않습니다.</span></div>`}
        ${ret && ret.items.length > 0 && ret.notExported.length > 0 && html`<div class="banner warn" style="border-radius:0;justify-content:center"><${Icon} name="alert" /><span>보관 기간이 끝난 ${ret.months[0]}~${ret.months[ret.months.length - 1]} 실적 ${n(ret.items.length)}건이 있습니다. 엑셀로 내려받지 않은 달(${ret.notExported.join(', ')})이 있어 자동 삭제하지 않았습니다.</span><button onClick=${() => go('master', { tab: 'data' })}>기준정보 → 데이터에서 처리</button></div>`}
        ${state.ready && state.mode === 'nodb' && !state.demo && html`<div class="banner bad" style="border-radius:0;justify-content:center"><${Icon} name="alert" /><span><b>공유 저장소에 연결하지 못해 실적이 보이지 않습니다.</b> 데이터는 지워진 것이 아닙니다. claude.ai 로그인이 풀렸거나 이 페이지의 권한이 없을 때 생깁니다 — 로그인한 뒤 새로고침하세요.</span><button onClick=${() => location.reload()}>새로고침</button></div>`}
        ${state.ready && state.backend === 'artifact' && state.mode === 'db' && !state.canWrite && !state.demo && html`<div class="banner info" style="border-radius:0;justify-content:center"><${Icon} name="alert" /><span>읽기 전용으로 열렸습니다. 입력하려면 이 페이지의 공유 설정에서 기여자(Contributor) 이상 권한이 필요합니다.</span></div>`}
        <main class="content">
          ${!state.ready ? html`<div class="loading">저장소에 연결하는 중…</div>` : PAGES[page].owner && !state.isOwner ? html`<div class="card" style="padding:40px 20px;text-align:center"><b>이 화면은 볼 수 있는 권한이 없습니다.</b><div class="muted" style="margin-top:6px">관리자 계정에서만 열립니다.</div></div>` : html`<${Page} state=${state} params=${params} go=${go} key=${page} />`}
        </main>
      </div>
    </div>
    <${Toasts} /><${ConfirmHost} />`;
}

render(html`<${App} />`, document.getElementById('app'));
// 관리용 콘솔 훅: 저장소 이전·점검 때 브라우저 콘솔에서 백업 JSON을 넣고 빼기 위함 (화면에는 안 나옴)
window.__yozm = { importJSON, exportJSON, getState, save, remove };
