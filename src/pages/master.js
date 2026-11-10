// 기준정보: 제품, 자재 품목, 설비·탱크, 생산계획, 데이터 관리
import { html, useState, useMemo, Card, Chip, Icon, Field, Modal, DataTable, Empty, Segmented, toast, confirmAsync, exportCSV } from '../ui.js';
import { save, remove, saveSettings, exportJSON, importJSON, enterDemo, exitDemo, DEFAULT_SETTINGS } from '../store.js';
import { productOf, bomOf, planRequirements, DEFAULT_BREAKS } from '../model.js';
import { n, fmtDate, today, uid, num, monthRange, ymLabel, addMonths, dow } from '../util.js';
import { exportMonthXlsx, exportXlsx, retentionCandidates, purgeRetention, buildSheets } from '../excel.js';

const TABS = [{ value: 'products', label: '제품' }, { value: 'bom', label: 'BOM' }, { value: 'materials', label: '자재' }, { value: 'equipment', label: '설비·탱크' }, { value: 'plans', label: '생산계획' }, { value: 'data', label: '데이터' }];

export function MasterPage({ state, params }) {
  const [tab, setTab] = useState(params.tab || 'products');
  return html`
    <div class="page-head"><div><div class="eyebrow">설정</div><h1>기준정보</h1></div></div>
    <${Card}><${Segmented} options=${TABS} value=${tab} onChange=${setTab} /><//>
    ${tab === 'products' && html`<${Products} state=${state} />`}
    ${tab === 'bom' && html`<${Bom} state=${state} />`}
    ${tab === 'materials' && html`<${Materials} state=${state} />`}
    ${tab === 'equipment' && html`<${Equipment} state=${state} />`}
    ${tab === 'plans' && html`<${Plans} state=${state} />`}
    ${tab === 'data' && html`<${DataTab} state=${state} />`}`;
}

/** v347 사용자 관리 (Firebase 사이트, 관리자만): 들어올 수 있는 구글 계정 등록·권한·삭제. 문서 ID = 이메일(소문자) */
function MembersCard({ state }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const list = [...(state.members || [])].sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) || String(a.id).localeCompare(String(b.id)));
  const owners = list.filter((m) => m.role === 'owner').length;
  const add = async () => {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { toast('구글 이메일 주소를 확인해 주세요.', 'bad'); return; }
    await save('members', { id: e, email: e, name: name.trim(), role, addedAt: new Date().toISOString() });
    setEmail(''); setName(''); setRole('member'); toast(`${e} 계정을 등록했습니다. 이제 이 계정으로 로그인할 수 있습니다.`);
  };
  const setRoleOf = async (m, r) => {
    if (m.role === 'owner' && r !== 'owner' && owners <= 1) { toast('관리자가 한 명은 있어야 합니다.', 'bad'); return; }
    await save('members', { ...m, role: r });
  };
  const del = async (m) => {
    if (m.id === state.userEmail) { toast('지금 로그인한 내 계정은 지울 수 없습니다.', 'bad'); return; }
    if (m.role === 'owner' && owners <= 1) { toast('관리자가 한 명은 있어야 합니다.', 'bad'); return; }
    if (await confirmAsync(`${m.id} 계정을 삭제할까요? 이 계정은 더 이상 들어올 수 없습니다.`)) { await remove('members', m.id); toast('삭제했습니다.'); }
  };
  return html`<${Card} title="사용자 관리 (구글 계정)" count=${list.length} desc="등록된 구글 계정만 로그인할 수 있습니다 · 관리자는 출고현황(매출)과 이 화면을 봅니다">
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      <${Field} label="구글 이메일"><input class="input" style="width:230px" placeholder="example@gmail.com" value=${email} onInput=${(e) => setEmail(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && add()} /><//>
      <${Field} label="이름 (선택)"><input class="input" style="width:110px" value=${name} onInput=${(e) => setName(e.target.value)} /><//>
      <${Field} label="권한"><select class="input" value=${role} onChange=${(e) => setRole(e.target.value)}><option value="member">일반</option><option value="owner">관리자</option></select><//>
      <button class="btn primary" onClick=${add}><${Icon} name="plus" />등록</button>
    </div>
    <div class="table-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>구글 이메일</th><th>이름</th><th>권한</th><th></th></tr></thead><tbody>
      ${list.map((m) => html`<tr key=${m.id}><td>${m.id}${m.id === state.userEmail ? html` <span class="chip">나</span>` : ''}</td><td>${m.name || html`<span class="muted">—</span>`}</td>
        <td><select class="input sm" value=${m.role || 'member'} onChange=${(e) => setRoleOf(m, e.target.value)}><option value="member">일반</option><option value="owner">관리자</option></select></td>
        <td><button class="btn sm ghost" onClick=${() => del(m)}><${Icon} name="trash" />삭제</button></td></tr>`)}
    </tbody></table></div>
  <//>`;
}

function Products({ state }) {
  const [modal, setModal] = useState(null);
  const rows = [...state.products].sort((a, b) => a.code.localeCompare(b.code));
  const del = async (p) => { if (await confirmAsync(`제품 ${p.name}을 삭제할까요?`)) { await remove('products', p.id); toast('삭제했습니다.'); } };
  return html`<${Card} title="제품 내역" count=${rows.length} actions=${html`<button class="btn primary sm" disabled=${!state.canWrite} onClick=${() => setModal({})}><${Icon} name="plus" />제품 등록</button>`} flush>
    <${DataTable} rows=${rows} cols=${[
      { key: 'code', label: '제품코드', sub: (p) => p.erpCode || '' }, { key: 'name', label: '제품명' }, { key: 'fillList', label: '충진 목록', render: (p) => p.fillList ? html`<${Chip} tone="good" dot>${p.sort ?? ''}번<//>` : html`<span class="muted">—</span>` }, { key: 'mixType', label: '재공품 유형', render: (p) => p.mixType || '—' }, { key: 'weightG', label: '단위중량 (g)', num: true, render: (p) => n(p.weightG) }, { key: 'unit', label: '단위' }, { key: 'shelfDays', label: '소비기한 (일)', num: true, render: (p) => n(p.shelfDays) },
      { key: 'act', label: '', render: (p) => html`<div class="row-actions"><button class="icon-btn" aria-label="수정" onClick=${() => setModal({ rec: p })}><${Icon} name="edit" /></button><button class="icon-btn danger" aria-label="삭제" disabled=${!state.canWrite} onClick=${() => del(p)}><${Icon} name="trash" /></button></div>` },
    ]} empty=${html`<${Empty} title="등록된 제품이 없습니다">제품을 등록해야 포장 내역과 제품 LOT를 기록할 수 있습니다.<//>`} />
    ${modal && html`<${SimpleModal} title=${modal.rec ? '제품 수정' : '제품 등록'} init=${modal.rec ? { ...modal.rec, fillList: modal.rec.fillList ? 'y' : 'n' } : { id: '', code: '', name: '', mixType: '', weightG: '', unit: 'ea', shelfDays: 21, erpCode: '', fillList: 'y', sort: state.products.filter((p) => p.fillList).length + 1 }} onClose=${() => setModal(null)}
      fields=${[['code', '제품코드', 'text', 'YG-100'], ['name', '제품명', 'text', '충진-플레인 100g'], ['mixType', '재공품 유형', 'select', [['', '(없음)'], ...(state.settings.mixTypes || []).map((m) => [m.name, m.name])]], ['weightG', '단위중량 (g)', 'number', '100'], ['unit', '단위', 'text'], ['shelfDays', '소비기한 (일)', 'number'], ['erpCode', 'ERP 품목코드', 'text', '2YOW0000001'], ['fillList', '충진 배치 제품 목록', 'select', [['y', '표시'], ['n', '숨김']]], ['sort', '충진 목록 순서', 'number', '1']]}
      onSubmit=${async (f) => { if (!f.code.trim() || !f.name.trim()) { toast('제품코드와 제품명은 필수입니다.', 'bad'); return false; } await save('products', { ...f, id: f.id || f.code.trim(), code: f.code.trim(), weightG: num(f.weightG), shelfDays: num(f.shelfDays), fillList: f.fillList === 'y', sort: f.sort === '' || f.sort == null ? 9999 : num(f.sort) }); return true; }} />`}
  <//>`;
}

// ERP BOM 트리(엑셀 26.10.27 BOM.xlsx 구조 그대로): 완제품 → 충진 반제품 → 용기·캡·리드·라벨 / 그릭 → 발효유 → 살균유 → 원유·유산균
const KIND_TONE = { 제품: 'accent', 반제품: 'good', 원자재: 'warn', 부자재: '' };
const fmtQty = (v) => v == null || v === '' ? '—' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 6 });
function flattenTree(nodes, depth = 0, out = []) { for (const nd of nodes || []) { out.push({ ...nd, depth }); flattenTree(nd.children, depth + 1, out); } return out; }
function BomTreeTable({ tree, root }) {
  const rows = flattenTree(tree, root ? 1 : 0);
  if (root) rows.unshift({ ...root, depth: 0, children: [] });
  if (!rows.length) return html`<p class="note">엑셀 BOM에 하위 항목이 없습니다.</p>`;
  return html`<div class="table-wrap"><table class="tbl bomtree">
    <thead><tr><th style="width:54px">레벨</th><th>품목</th><th style="width:64px">구분</th><th class="num" style="width:100px">단위소요량</th><th style="width:50px">단위</th><th style="width:76px">공급구분</th><th style="width:76px">투입공정</th><th>분류</th></tr></thead>
    <tbody>${rows.map((r, i) => html`<tr key=${i} class="d${Math.min(r.depth, 6)} k-${r.kind || ''}">
      <td class="muted">${r.lv || (r.depth === 0 ? '0' : '')}</td>
      <td><div class="nm" style="padding-left:${r.depth * 18}px">${r.depth > 0 && html`<span class="tick"></span>`}<b>${r.name}</b><span class="code">${r.code}</span></div></td>
      <td>${r.kind ? html`<${Chip} tone=${KIND_TONE[r.kind] || ''}>${r.kind}<//>` : ''}</td>
      <td class="num">${fmtQty(r.qty)}</td>
      <td>${r.unit || ''}</td><td class="muted">${r.supply || ''}</td><td class="muted">${r.proc || ''}</td>
      <td class="muted">${[r.cat1, r.cat2, r.cat3, r.cat4].filter(Boolean).join(' · ')}</td>
    </tr>`)}</tbody></table></div>`;
}

function Bom({ state }) {
  const [mode, setMode] = useState('semi'); // semi: 충진 반제품(앱 제품), top: 완제품
  const [sel, setSel] = useState('');
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();
  const products = [...state.products].filter((p) => !ql || (p.name + p.code + (p.mixType || '')).toLowerCase().includes(ql)).sort((a, b) => (a.mixType || '').localeCompare(b.mixType || '') || a.name.localeCompare(b.name));
  const tops = [...(state.bomTop || [])].filter((t) => !ql || (t.name + t.code).toLowerCase().includes(ql)).sort((a, b) => (Number(!!a.end) - Number(!!b.end)) || a.code.localeCompare(b.code));
  const bom = mode === 'semi' && sel ? bomOf(state, sel) : null;
  const product = mode === 'semi' && sel ? productOf(state, sel) : null;
  const top = mode === 'top' && sel ? (state.bomTop || []).find((t) => t.id === sel) : null;
  const [lines, setLines] = useState(null);
  const cur = lines || (bom ? (bom.lines || []).map((l) => ({ ...l })) : []);
  const pick = (code) => { setSel(code); setLines(null); };
  const switchMode = (m, code = '') => { setMode(m); setSel(code); setLines(null); };
  const setLine = (i, patch) => setLines((o) => { const r = [...(o || cur)]; r[i] = { ...r[i], ...patch }; return r; });
  const saveBom = async () => {
    const clean = cur.filter((l) => l.materialCode && num(l.qty) > 0).map((l) => { const m = state.materials.find((x) => x.code === l.materialCode); return { materialCode: l.materialCode, name: m ? m.name : l.name || l.materialCode, qty: num(l.qty), unit: l.unit || (m ? m.unit : ''), group: l.group || (m ? m.group : '') }; });
    await save('bom', { ...(bom || { id: sel, productCode: sel }), lines: clean }); setLines(null); toast('BOM을 저장했습니다.');
  };
  const treeCount = (b) => b && Array.isArray(b.tree) ? flattenTree(b.tree).length : 0;
  return html`<div class="grid2" style="grid-template-columns:minmax(280px,1fr) 2.2fr">
    <${Card} title=${mode === 'semi' ? '충진 반제품' : '완제품'} count=${mode === 'semi' ? products.length : tops.length} desc=${mode === 'semi' ? '앱에서 충진·포장하는 제품' : 'ERP 완제품 (엑셀 BOM 레벨 0)'} flush>
      <div style="padding:10px 14px 4px;display:grid;gap:8px">
        <${Segmented} options=${[{ value: 'semi', label: '충진 반제품' }, { value: 'top', label: '완제품' }]} value=${mode} onChange=${(m) => switchMode(m)} />
        <div class="search"><${Icon} name="search" /><input class="input" placeholder=${mode === 'semi' ? '제품명 · 코드 · 유형' : '완제품명 · 코드'} value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
      </div>
      ${mode === 'semi' ? html`<div class="lot-list" style="max-height:60vh">${products.map((p) => { const b = bomOf(state, p.code); const tc = treeCount(b); return html`<button key=${p.code} class="lot-item ${sel === p.code ? 'active' : ''}" onClick=${() => pick(p.code)}><span class="lot" style="font-weight:600">${p.name}</span><${Chip} tone=${tc || (b && b.lines?.length) ? 'good' : ''}>${tc ? `${tc}항목` : b && b.lines?.length ? `${b.lines.length}개` : 'BOM 없음'}<//><span class="meta">${p.code}${p.mixType ? ` · ${p.mixType}` : ''} · ${n(p.weightG)} g</span></button>`; })}</div>`
      : html`<div class="lot-list" style="max-height:60vh">${tops.length === 0 && html`<${Empty} title="완제품 BOM이 없습니다">엑셀 BOM을 불러오면 여기에 완제품 목록이 표시됩니다.<//>`}${tops.map((t) => html`<button key=${t.id} class="lot-item ${sel === t.id ? 'active' : ''}" onClick=${() => pick(t.id)}><span class="lot" style="font-weight:600">${t.name}</span><${Chip} tone=${t.end ? 'warn' : 'good'}>${t.end ? '사용종료' : `${flattenTree(t.tree).length}항목`}<//><span class="meta">${t.code}</span></button>`)}</div>`}
    <//>
    ${top ? html`<${Card} title=${top.name} desc=${`${top.code} · 완제품${top.end ? ' · 사용종료' : ''}`} actions=${html`<${Chip} tone="accent">엑셀 BOM<//>`}>
      <${BomTreeTable} tree=${top.tree} root=${{ lv: '0', code: top.code, name: top.name, kind: '제품', qty: 1, unit: top.unit || 'ea' }} />
    <//>`
    : product ? html`<${Card} title=${product.name} desc=${`${product.code} · ${product.mixType || '유형 없음'} · 규격 ${n(product.weightG)} g`} actions=${html`<button class="btn primary sm" disabled=${!state.canWrite || !lines} onClick=${saveBom}><${Icon} name="check" />저장</button>`}>
      ${bom && (bom.yogurtKg || bom.fermentKg) && html`<div class="pipeline" style="margin-bottom:12px">
        ${bom.yogurtKg > 0 && html`<div class="pipe"><div class="k">그릭요거트 (kg/개)</div><div class="v">${n(bom.yogurtKg, 3)}</div><div class="s">${bom.blend ? bom.blend : '유청분리공정품'}</div></div>`}
        ${bom.fermentKg > 0 && html`<div class="pipe"><div class="k">발효유 (kg/개)</div><div class="v">${n(bom.fermentKg, 3)}</div><div class="s">${bom.yogurtKg > 0 ? `수율 ${n(bom.yogurtKg / bom.fermentKg * 100, 0)}%` : '직접 충진'}</div></div>`}
        ${bom.milkKg > 0 && html`<div class="pipe"><div class="k">원유 (kg/개)</div><div class="v">${n(bom.milkKg, 3)}</div><div class="s">유산균 ${n(bom.starterBags, 5)} 봉</div></div>`}
      </div>`}
      ${bom && Array.isArray(bom.tree) && bom.tree.length > 0 && html`<div class="fieldset" style="margin-bottom:12px"><div class="legend">ERP BOM 구조 (엑셀 26.10.27)</div>
        <${BomTreeTable} tree=${bom.tree} root=${{ lv: '1', code: product.code, name: product.name, kind: '반제품', qty: 1, unit: product.unit || 'ea' }} />
        ${(bom.usedIn || []).length > 0 && html`<div style="margin-top:10px"><div class="legend" style="margin-bottom:6px">이 반제품을 쓰는 완제품 ${bom.usedIn.length}종</div><div style="display:flex;flex-wrap:wrap;gap:6px">${bom.usedIn.map((u) => html`<button key=${u.code} class="chip clickable ${u.end ? '' : 'good'}" title=${u.code} onClick=${() => switchMode('top', u.code)}>${u.name}${u.end ? ' (종료)' : ''}</button>`)}</div></div>`}
      </div>`}
      <div class="fieldset"><div class="legend">포장재 단위소요량 (제품 1개당) · 앱 계산용</div>
        ${cur.map((l, i) => { const m = state.materials.find((x) => x.code === l.materialCode); return html`<div key=${i} class="src-row" style="grid-template-columns:1fr 110px 80px 36px">
          <${Field} label="자재"><select value=${l.materialCode} onChange=${(e) => { const mm = state.materials.find((x) => x.code === e.target.value); setLine(i, { materialCode: e.target.value, unit: mm ? mm.unit : '', name: mm ? mm.name : '' }); }}><option value="">선택</option>${[...state.materials].sort((a, b) => a.name.localeCompare(b.name)).map((x) => html`<option key=${x.code} value=${x.code}>${x.name} (${x.code})</option>`)}</select><//>
          <${Field} label="소요량"><input type="number" min="0" step="any" value=${l.qty} onInput=${(e) => setLine(i, { qty: e.target.value })} /><//>
          <${Field} label="단위"><input value=${l.unit || (m ? m.unit : '')} readonly /><//>
          <button class="icon-btn danger" aria-label="제거" onClick=${() => setLines((o) => (o || cur).filter((_, j) => j !== i))}><${Icon} name="x" /></button>
        </div>`; })}
        <div><button class="btn sm" onClick=${() => setLines([...cur, { materialCode: '', qty: 1, unit: '' }])}><${Icon} name="plus" />자재 추가</button></div>
      </div>
    <//>` : html`<${Card}><${Empty} title=${mode === 'semi' ? '제품을 선택하세요' : '완제품을 선택하세요'}>${mode === 'semi' ? '왼쪽에서 제품을 고르면 ERP BOM 구조와 포장재 단위소요량을 보고 고칠 수 있습니다.' : '왼쪽에서 완제품을 고르면 엑셀 BOM 트리(충진 반제품 → 그릭 → 발효유 → 원유)를 보여줍니다.'}<//><//>`}
  </div>`;
}

function Materials({ state }) {
  const [modal, setModal] = useState(null);
  const rows = [...state.materials].sort((a, b) => a.code.localeCompare(b.code));
  const del = async (m) => { if (await confirmAsync(`자재 ${m.name}을 삭제할까요?`)) { await remove('materials', m.id); toast('삭제했습니다.'); } };
  return html`<${Card} title="자재 품목" count=${rows.length} actions=${html`<button class="btn primary sm" disabled=${!state.canWrite} onClick=${() => setModal({})}><${Icon} name="plus" />자재 등록</button>`} flush>
    <${DataTable} rows=${rows} cols=${[
      { key: 'code', label: '자재코드' }, { key: 'name', label: '자재명' }, { key: 'kind', label: '구분', render: (m) => m.kind === 'raw' ? '원자재' : '부자재', sub: (m) => m.group || '' }, { key: 'unit', label: '단위' }, { key: 'safety', label: '안전재고', num: true, render: (m) => m.safety ? n(m.safety) : '—' },
      { key: 'act', label: '', render: (m) => html`<div class="row-actions"><button class="icon-btn" aria-label="수정" onClick=${() => setModal({ rec: m })}><${Icon} name="edit" /></button><button class="icon-btn danger" aria-label="삭제" disabled=${!state.canWrite} onClick=${() => del(m)}><${Icon} name="trash" /></button></div>` },
    ]} empty=${html`<${Empty} title="등록된 자재가 없습니다">원유, 유산균, 용기 등 자재 품목을 등록하세요.<//>`} />
    ${modal && html`<${SimpleModal} title=${modal.rec ? '자재 수정' : '자재 등록'} init=${modal.rec || { id: '', code: '', name: '', kind: 'raw', group: '', unit: 'kg', safety: '' }} onClose=${() => setModal(null)}
      fields=${[['code', '자재코드', 'text', '5MLR0000001'], ['name', '자재명', 'text', '원유 서울우유 (kg)'], ['kind', '구분', 'select', [['raw', '원자재 (원유·유산균·부원료)'], ['pack', '부자재 (용기·캡·리드·라벨)']]], ['group', '분류', 'text', '용기 / 캡 / 리드 / 라벨 / 부원료'], ['unit', '단위', 'text', 'kg / ea / 롤 / 봉'], ['safety', '안전재고', 'number']]}
      onSubmit=${async (f) => { if (!f.code.trim() || !f.name.trim()) { toast('자재코드와 자재명은 필수입니다.', 'bad'); return false; } await save('materials', { ...f, id: f.id || f.code.trim(), code: f.code.trim(), safety: f.safety === '' ? '' : num(f.safety) }); return true; }} />`}
  <//>`;
}

function SimpleModal({ title, init, fields, onSubmit, onClose }) {
  const [f, setF] = useState({ ...init });
  const submit = async () => { if (await onSubmit(f)) { toast('저장했습니다.'); onClose(); } };
  return html`<${Modal} title=${title} onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>취소</button><button class="btn primary" onClick=${submit}>저장</button>`}>
    <div class="form-grid">${fields.map(([k, label, type, extra]) => html`<${Field} key=${k} label=${label}>
      ${type === 'select' ? html`<select value=${f[k]} onChange=${(e) => setF({ ...f, [k]: e.target.value })}>${extra.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select>`
        : html`<input type=${type} value=${f[k] ?? ''} placeholder=${typeof extra === 'string' ? extra : ''} onInput=${(e) => setF({ ...f, [k]: e.target.value })} />`}
    <//>`)}</div>
  <//>`;
}

function Equipment({ state }) {
  const s = state.settings;
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const [f, setF] = useState({ companyName: s.companyName, lotDateOffset: s.lotDateOffset, offDays: (s.offDays || []).map(Number), milkDensity: s.milkDensity, cultureTypes: s.cultureTypes.join(', '), tanks: s.tanks.map((t) => ({ ...t })),
    fillers: s.fillers.map((x) => ({ code: '', ...x, crewFill: ((x.crew || {}).fill || []).join(', '), crewCap: ((x.crew || {}).cap || []).join(', '), crewPack: ((x.crew || {}).pack || []).join(', ') })),
    lines: (s.lines || []).map((l) => ({ id: l.id, name: l.name, dest: l.dest || '', tankIds: (l.tankIds || []).join(', ') })),
    mixTypes: (s.mixTypes || []).map((m) => ({ ...m })), workers: (s.workers || []).join(', '), productLotDateBase: s.productLotDateBase || 'expiry', pressMaxL: s.pressMaxL ?? 2000, pressKgPerCloth: s.pressKgPerCloth ?? 51.5, autoBreaks: (s.autoBreaks && s.autoBreaks.length ? s.autoBreaks : DEFAULT_BREAKS).map((x) => ({ ...x })) });
  const setTank = (i, patch) => setF((o) => { const t = [...o.tanks]; t[i] = { ...t[i], ...patch }; return { ...o, tanks: t }; });
  const setFiller = (i, patch) => setF((o) => { const t = [...o.fillers]; t[i] = { ...t[i], ...patch }; return { ...o, fillers: t }; });
  const setLine = (i, patch) => setF((o) => { const t = [...o.lines]; t[i] = { ...t[i], ...patch }; return { ...o, lines: t }; });
  const setMix = (i, patch) => setF((o) => { const t = [...o.mixTypes]; t[i] = { ...t[i], ...patch }; return { ...o, mixTypes: t }; });
  const submit = async () => {
    const tanks = f.tanks.filter((t) => t.id.trim() && t.name.trim()).map((t) => ({ id: t.id.trim(), name: t.name.trim(), capT: num(t.capT) }));
    const names = (t) => String(t || '').split(/[,،\s]+/).map((v) => v.trim()).filter(Boolean);
    const fillers = f.fillers.filter((x) => x.id.trim() && x.name.trim()).map((x) => ({ id: x.id.trim(), name: x.name.trim(), code: (x.code || '').trim().toUpperCase(), stdBpm: num(x.stdBpm) > 0 ? num(x.stdBpm) : null, crew: { fill: names(x.crewFill), cap: names(x.crewCap), pack: names(x.crewPack) } }));
    const lines = f.lines.filter((l) => l.name.trim()).map((l, i) => ({ id: l.id || `L${i + 1}`, name: l.name.trim(), dest: l.dest.trim(), tankIds: l.tankIds.split(',').map((x) => x.trim()).filter(Boolean) }));
    const mixTypes = f.mixTypes.filter((m) => (m.name || '').trim()).map((m) => ({ name: m.name.trim(), ratio: num(m.ratio) || 1 }));
    const workers = f.workers.split(',').map((x) => x.trim()).filter(Boolean);
    await saveSettings({ companyName: f.companyName, lotDateOffset: num(f.lotDateOffset), offDays: [...f.offDays].sort(), milkDensity: num(f.milkDensity) || 1.03, cultureTypes: f.cultureTypes.split(',').map((x) => x.trim()).filter(Boolean), tanks, fillers, lines, mixTypes, workers, productLotDateBase: f.productLotDateBase, pressMaxL: num(f.pressMaxL) || 2000, pressKgPerCloth: num(f.pressKgPerCloth) || 51.5, autoBreaks: f.autoBreaks.filter((x) => x.startBefore && x.endAfter && num(x.min) > 0).map((x) => ({ label: (x.label || '').trim() || '휴게', startBefore: x.startBefore, endAfter: x.endAfter, min: num(x.min) })) });
    toast('기준정보를 저장했습니다.');
  };
  return html`<div class="grid2">
    <${Card} title="기본 설정" actions=${html`<button class="btn primary sm" disabled=${!state.canWrite} onClick=${submit}><${Icon} name="check" />저장</button>`}>
      <div class="form-grid">
        <${Field} label="팀/회사 이름"><input value=${f.companyName} onInput=${(e) => setF({ ...f, companyName: e.target.value })} /><//>
        <${Field} label="배양 LOT 날짜 기준" hint="LOT의 날짜 = 배양일 + 이 값 (예: 1이면 다음날)"><input type="number" min="0" max="7" value=${f.lotDateOffset} onInput=${(e) => setF({ ...f, lotDateOffset: e.target.value })} /><//>
        <${Field} label="공장 휴무 요일" hint="배출일이 휴무면 다음 가동일 날짜로 LOT 생성 (금요일 배양 → 일요일)"><div class="row" style="gap:4px;flex-wrap:wrap">${DAYS.map((d, i) => html`<button key=${i} type="button" class="chip clickable ${f.offDays.includes(i) ? 'warn' : ''}" onClick=${() => setF({ ...f, offDays: f.offDays.includes(i) ? f.offDays.filter((x) => x !== i) : [...f.offDays, i] })}>${d}</button>`)}</div><//>
        <${Field} label="원유 비중 (kg/L)"><input type="number" step="0.001" value=${f.milkDensity} onInput=${(e) => setF({ ...f, milkDensity: e.target.value })} /><//>
        <${Field} label="필터프레스 최대 (L)" hint="배관 행선지에 '필터프레스'가 있는 탱크만 선택 가능"><input type="number" min="0" step="100" value=${f.pressMaxL} onInput=${(e) => setF({ ...f, pressMaxL: e.target.value })} /><//>
        <${Field} label="필터프레스 포당 kg" hint="예상 면포 = L × 비중 ÷ 이 값"><input type="number" min="1" step="0.1" value=${f.pressKgPerCloth} onInput=${(e) => setF({ ...f, pressKgPerCloth: e.target.value })} /><//>
        <${Field} label="배출 구분 목록" hint="쉼표로 구분 · '필터프레스'가 들어간 구분을 고르면 필터프레스 이동량을 입력" class="span-all"><input value=${f.cultureTypes} onInput=${(e) => setF({ ...f, cultureTypes: e.target.value })} /><//>
        <${Field} label="제품 LOT 날짜 기준" hint="LOT = 날짜(yy-MMdd) + 설비코드 + 충진 요일(월1~일7)"><select value=${f.productLotDateBase} onChange=${(e) => setF({ ...f, productLotDateBase: e.target.value })}><option value="expiry">소비기한</option><option value="fill">충진일</option></select><//>
        <${Field} label="작업자 명단" hint="쉼표로 구분 · 충진 배치 입력 시 자동완성" class="span-all"><input value=${f.workers} onInput=${(e) => setF({ ...f, workers: e.target.value })} /><//>
      </div>
      <div class="fieldset" style="margin-top:14px"><div class="legend">휴게 자동 차감 (엑셀과 동일) · 배치 시작이 "시작 기준" 이전이고 종료가 "종료 기준" 이후면 가동 시간에서 그 분을 뺍니다 · BPM = 양품 ea ÷ 가동 분</div>
        ${f.autoBreaks.map((x, i) => html`<div key=${i} class="src-row" style="grid-template-columns:1fr 110px 110px 90px 36px">
          <${Field} label="이름"><input value=${x.label || ''} onInput=${(e) => setF((o) => { const t = [...o.autoBreaks]; t[i] = { ...t[i], label: e.target.value }; return { ...o, autoBreaks: t }; })} /><//>
          <${Field} label="시작 기준 (이전)"><input type="time" value=${x.startBefore || ''} onInput=${(e) => setF((o) => { const t = [...o.autoBreaks]; t[i] = { ...t[i], startBefore: e.target.value }; return { ...o, autoBreaks: t }; })} /><//>
          <${Field} label="종료 기준 (이후)"><input type="time" value=${x.endAfter || ''} onInput=${(e) => setF((o) => { const t = [...o.autoBreaks]; t[i] = { ...t[i], endAfter: e.target.value }; return { ...o, autoBreaks: t }; })} /><//>
          <${Field} label="차감 (분)"><input type="number" min="0" value=${x.min ?? ''} onInput=${(e) => setF((o) => { const t = [...o.autoBreaks]; t[i] = { ...t[i], min: e.target.value }; return { ...o, autoBreaks: t }; })} /><//>
          <button class="icon-btn danger" aria-label="제거" onClick=${() => setF((o) => ({ ...o, autoBreaks: o.autoBreaks.filter((_, j) => j !== i) }))}><${Icon} name="x" /></button>
        </div>`)}
        <div><button class="btn sm" onClick=${() => setF((o) => ({ ...o, autoBreaks: [...o.autoBreaks, { label: '', startBefore: '', endAfter: '', min: '' }] }))}><${Icon} name="plus" />휴게 규칙 추가</button></div>
      </div>
      <div class="fieldset" style="margin-top:14px"><div class="legend">충진설비 · 코드는 제품 LOT 글자 · 기준 BPM은 설비의 분당 양품 수(양품 ea ÷ 가동 분, 실적 BPM 옆에 달성률 표시) · 작업자는 배치 등록 때 기본값으로 채워집니다 (쉼표로 구분)</div>
        ${f.fillers.map((x, i) => html`<div key=${i} class="filler-row">
          <div class="src-row" style="grid-template-columns:80px 1fr 70px 110px 36px"><${Field} label="ID"><input value=${x.id} onInput=${(e) => setFiller(i, { id: e.target.value })} /><//><${Field} label="이름"><input value=${x.name} onInput=${(e) => setFiller(i, { name: e.target.value })} /><//><${Field} label="코드"><input value=${x.code || ''} maxlength="2" onInput=${(e) => setFiller(i, { code: e.target.value })} /><//><${Field} label="기준 BPM"><input type="number" min="0" step="0.1" value=${x.stdBpm ?? ''} placeholder="예: 20" onInput=${(e) => setFiller(i, { stdBpm: e.target.value })} /><//><button class="icon-btn danger" aria-label="제거" onClick=${() => setF((o) => ({ ...o, fillers: o.fillers.filter((_, j) => j !== i) }))}><${Icon} name="x" /></button></div>
          <div class="src-row" style="grid-template-columns:1fr 1fr 1fr"><${Field} label="충진 작업자"><input value=${x.crewFill} onInput=${(e) => setFiller(i, { crewFill: e.target.value })} /><//><${Field} label="캡 작업자"><input value=${x.crewCap} onInput=${(e) => setFiller(i, { crewCap: e.target.value })} /><//><${Field} label="포장 작업자"><input value=${x.crewPack} onInput=${(e) => setFiller(i, { crewPack: e.target.value })} /><//></div>
        </div>`)}
        <div><button class="btn sm" onClick=${() => setF((o) => ({ ...o, fillers: [...o.fillers, { id: `F${o.fillers.length + 1}`, name: '', code: '', crewFill: '', crewCap: '', crewPack: '' }] }))}><${Icon} name="plus" />설비 추가</button></div>
      </div>
      <div class="fieldset" style="margin-top:14px"><div class="legend">재공품 유형 · 부재료 비율 (부원료 = 계근량 × (1 − 1/비율))</div>
        ${f.mixTypes.map((m, i) => html`<div key=${i} class="src-row" style="grid-template-columns:1fr 110px 36px"><${Field} label="유형"><input value=${m.name} onInput=${(e) => setMix(i, { name: e.target.value })} /><//><${Field} label="비율"><input type="number" step="0.001" min="1" value=${m.ratio} onInput=${(e) => setMix(i, { ratio: e.target.value })} /><//><button class="icon-btn danger" aria-label="제거" onClick=${() => setF((o) => ({ ...o, mixTypes: o.mixTypes.filter((_, j) => j !== i) }))}><${Icon} name="x" /></button></div>`)}
        <div><button class="btn sm" onClick=${() => setF((o) => ({ ...o, mixTypes: [...o.mixTypes, { name: '', ratio: 1 }] }))}><${Icon} name="plus" />유형 추가</button></div>
      </div>
    <//>
    <${Card} title="배양 탱크">
      <div class="fieldset" style="margin-bottom:14px"><div class="legend">배관(라인) 구성 · 탱크 ID를 쉼표로 구분</div>
        ${f.lines.map((l, i) => html`<div key=${i} class="src-row" style="grid-template-columns:90px 1fr 1fr 36px"><${Field} label="배관 이름"><input value=${l.name} onInput=${(e) => setLine(i, { name: e.target.value })} /><//><${Field} label="탱크 ID"><input value=${l.tankIds} placeholder="T01, T02, T03, T04" onInput=${(e) => setLine(i, { tankIds: e.target.value })} /><//><${Field} label="행선지"><input value=${l.dest} placeholder="유청분리실 · 필터프레스" onInput=${(e) => setLine(i, { dest: e.target.value })} /><//><button class="icon-btn danger" aria-label="제거" onClick=${() => setF((o) => ({ ...o, lines: o.lines.filter((_, j) => j !== i) }))}><${Icon} name="x" /></button></div>`)}
        <div><button class="btn sm" onClick=${() => setF((o) => ({ ...o, lines: [...o.lines, { id: `L${o.lines.length + 1}`, name: `${o.lines.length + 1}배관`, tankIds: '', dest: '' }] }))}><${Icon} name="plus" />배관 추가</button></div>
      </div>
      <div class="stack" style="gap:8px">
        ${f.tanks.map((t, i) => html`<div key=${i} class="src-row" style="grid-template-columns:90px 1fr 90px 36px"><${Field} label="ID"><input value=${t.id} onInput=${(e) => setTank(i, { id: e.target.value })} /><//><${Field} label="이름"><input value=${t.name} onInput=${(e) => setTank(i, { name: e.target.value })} /><//><${Field} label="용량 (T)"><input type="number" step="0.5" value=${t.capT} onInput=${(e) => setTank(i, { capT: e.target.value })} /><//><button class="icon-btn danger" aria-label="제거" onClick=${() => setF((o) => ({ ...o, tanks: o.tanks.filter((_, j) => j !== i) }))}><${Icon} name="x" /></button></div>`)}
        <div><button class="btn sm" onClick=${() => setF((o) => ({ ...o, tanks: [...o.tanks, { id: `T${String(o.tanks.length + 1).padStart(2, '0')}`, name: `${o.tanks.length + 1}번 탱크`, capT: 5 }] }))}><${Icon} name="plus" />탱크 추가</button></div>
      </div>
    <//>
  </div>`;
}

function Plans({ state }) {
  const [ym, setYm] = useState(today().slice(0, 7));
  const [f, setF] = useState({ date: today(), productCode: state.products[0]?.code || '', qty: '', note: '' });
  const r = monthRange(ym);
  const rows = state.plans.filter((p) => p.date >= r.from && p.date <= r.to).sort((a, b) => a.date.localeCompare(b.date));
  const total = rows.reduce((s, p) => s + num(p.qty), 0);
  const add = async () => { if (!f.productCode || num(f.qty) <= 0) { toast('제품과 수량을 입력하세요.', 'bad'); return; } await save('plans', { id: uid(), date: f.date, productCode: f.productCode, qty: num(f.qty), note: f.note }); toast('계획을 등록했습니다.'); setF({ ...f, qty: '' }); };
  const del = async (p) => { await remove('plans', p.id); };
  return html`<${Card} title="완제품 생산계획" count=${rows.length} desc=${`${ymLabel(ym)} 계획 합계 ${n(total)} ea`} actions=${html`<div class="row" style="flex-wrap:nowrap"><button class="btn sm" onClick=${() => setYm(addMonths(ym, -1))} aria-label="이전 달"><${Icon} name="left" /></button><input type="month" class="input" style="width:150px" value=${ym} onInput=${(e) => e.target.value && setYm(e.target.value)} /><button class="btn sm" onClick=${() => setYm(addMonths(ym, 1))} aria-label="다음 달"><${Icon} name="right" /></button></div>`}>
    <div class="filters" style="margin-bottom:12px">
      <${Field} label="생산예정일"><input type="date" value=${f.date} onInput=${(e) => setF({ ...f, date: e.target.value })} /><//>
      <${Field} label="제품"><select value=${f.productCode} onChange=${(e) => setF({ ...f, productCode: e.target.value })}>${state.products.map((p) => html`<option key=${p.code} value=${p.code}>${p.name}</option>`)}</select><//>
      <${Field} label="계획수량"><input type="number" min="0" value=${f.qty} onInput=${(e) => setF({ ...f, qty: e.target.value })} /><//>
      <${Field} label="비고"><input value=${f.note} onInput=${(e) => setF({ ...f, note: e.target.value })} /><//>
      <button class="btn primary" disabled=${!state.canWrite} onClick=${add}><${Icon} name="plus" />등록</button>
    </div>
    <${DataTable} rows=${rows} cols=${[
      { key: 'date', label: '생산예정일', render: (p) => `${fmtDate(p.date)} (${dow(p.date)})` }, { key: 'product', label: '제품', render: (p) => (productOf(state, p.productCode) || {}).name || p.productCode }, { key: 'qty', label: '계획수량', num: true, render: (p) => n(p.qty) }, { key: 'note', label: '비고' },
      { key: 'act', label: '', render: (p) => html`<div class="row-actions"><button class="icon-btn danger" aria-label="삭제" disabled=${!state.canWrite} onClick=${() => del(p)}><${Icon} name="trash" /></button></div>` },
    ]} empty=${html`<${Empty} title="이 달의 생산계획이 없습니다">위에서 날짜·제품·수량을 입력해 등록하세요.<//>`} />
    ${rows.length > 0 && html`<div style="margin-top:16px"><h3 style="font-size:14px;font-weight:600;margin-bottom:6px">계획 기준 자재 필요량 <span class="note">· 제품 1개당 BOM × 월 계획수량 · 가용 재고와 비교</span></h3>
      <${DataTable} rows=${planRequirements(state, rows)} keyFn=${(r) => r.materialCode} cols=${[
        { key: 'material', label: '자재', render: (r) => r.material.name, sub: (r) => r.materialCode }, { key: 'total', label: '필요량', num: true, render: (r) => `${n(r.total, 2)} ${r.unit || r.material.unit || ''}` },
        { key: 'available', label: '가용 재고', num: true, render: (r) => n(r.available, 2) }, { key: 'shortage', label: '부족', num: true, render: (r) => r.shortage > 0 ? html`<${Chip} tone="bad">${n(r.shortage, 2)}<//>` : html`<${Chip} tone="good">충분<//>` },
      ]} empty=${html`<div class="empty">계획된 제품에 BOM이 없어 자재 필요량을 계산할 수 없습니다. 기준정보 → BOM에서 등록하세요.</div>`} /></div>`}
  <//>`;
}

/** 월별 총인원: 생산실적 분석의 1인당 생산량 분모 (양품 ÷ 그 달 총인원). 한 달씩 화살표로 넘기며 입력 */
function HeadcountCard({ state }) {
  const hc = state.settings.headcount || {};
  const [ym, setYm] = useState(today().slice(0, 7));
  const [v, setV] = useState(null); // null = 저장된 값 그대로
  const saved = hc[ym] ?? '';
  const cur = v == null ? saved : v;
  const move = (dir) => { setYm(addMonths(ym, dir)); setV(null); };
  const submit = async () => {
    const next = { ...hc }; const val = num(cur);
    if (val > 0) next[ym] = val; else delete next[ym];
    await saveSettings({ headcount: next }); setV(null); toast(val > 0 ? `${ymLabel(ym)} 총인원 ${n(val)}명을 저장했습니다.` : `${ymLabel(ym)} 총인원을 지웠습니다.`);
  };
  const registered = Object.keys(hc).filter((m) => num(hc[m]) > 0).sort();
  return html`<${Card} title="월별 총인원">
    <div class="row" style="flex-wrap:nowrap;align-items:flex-end;gap:8px">
      <button class="btn" aria-label="이전 달" onClick=${() => move(-1)}><${Icon} name="left" /></button>
      <${Field} label=${ymLabel(ym)} class="tnum" style="min-width:120px"><input type="number" min="0" step="1" inputmode="numeric" placeholder="총인원 (명)" value=${cur} onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') submit(); }} /><//>
      <button class="btn" aria-label="다음 달" onClick=${() => move(1)}><${Icon} name="right" /></button>
      <button class="btn primary" disabled=${!state.canWrite || String(cur) === String(saved)} onClick=${submit}><${Icon} name="check" />저장</button>
    </div>
    <p class="note" style="margin:10px 0 0">${saved !== '' ? `${ymLabel(ym)} 저장된 총인원 ${n(saved)}명` : `${ymLabel(ym)}은 아직 미등록`}${registered.length ? ` · 등록된 달: ${registered.map((m) => `${ymLabel(m)} ${n(hc[m])}명`).join(', ')}` : ''}</p>
  <//>`;
}

function DataTab({ state }) {
  const [busy, setBusy] = useState(false);
  const copyBackup = async () => {
    const text = exportJSON();
    try { await navigator.clipboard.writeText(text); toast('전체 데이터(JSON)를 클립보드에 복사했습니다. 메모장 등에 붙여넣어 보관하세요.'); }
    catch { toast('복사할 수 없는 환경입니다.', 'bad'); }
  };
  const restore = async (file) => {
    if (!file) return; setBusy(true);
    try { const text = await file.text(); const count = await importJSON(text); toast(`${count}건을 복원(병합)했습니다.`); }
    catch (e) { toast('복원 실패: 파일 형식을 확인하세요.', 'bad'); }
    setBusy(false);
  };
  const counts = ['cultures', 'separations', 'batches', 'packs', 'legacy', 'materialLots', 'products', 'materials', 'plans'].map((c) => [c, (state[c] || []).length]);
  const names = { cultures: '배양', separations: '소분·폐기', batches: '충진 배치', packs: '포장 내역', legacy: '전산 백데이터 (일)', materialLots: '자재 LOT', products: '제품', materials: '자재', plans: '생산계획' };
  // 월별 엑셀 내보내기
  const [ym, setYm] = useState(() => addMonths(today().slice(0, 7), -1));
  const [xbusy, setXbusy] = useState(false);
  const monthCounts = useMemo(() => { const r = monthRange(ym); return buildSheets(state, r.from, r.to).counts; }, [state, ym]);
  const doExport = async () => { setXbusy(true); try { await exportMonthXlsx(state, ym); } catch (e) { toast(e.message || '엑셀을 만들지 못했습니다.', 'bad'); } setXbusy(false); };
  const exportedMonths = Object.entries(state.settings.exports || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12);
  // 반기 보관 정리
  const ret = useMemo(() => retentionCandidates(state), [state]);
  const [pbusy, setPbusy] = useState(false);
  const exportThenPurge = async () => {
    setPbusy(true);
    try {
      const r = await exportXlsx(state, ret.from, ret.to, `생산실적_보관종료_${ret.months[0]}_${ret.months[ret.months.length - 1]}.xlsx`);
      if (r.ok && await confirmAsync(`엑셀 저장을 요청했습니다. 보관 기간이 끝난 ${n(ret.items.length)}건을 지금 삭제할까요? 삭제 후에는 되돌릴 수 없습니다.`)) { const c = await purgeRetention(state); toast(`${n(c)}건을 삭제했습니다.`); }
    } catch (e) { toast(e.message || '엑셀을 만들지 못했습니다.', 'bad'); }
    setPbusy(false);
  };
  const purgeOnly = async () => { if (await confirmAsync(`엑셀 백업 없이 ${n(ret.items.length)}건을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?`)) { setPbusy(true); const c = await purgeRetention(state); toast(`${n(c)}건을 삭제했습니다.`); setPbusy(false); } };
  return html`<div class="grid2">
    ${state.backend === 'firebase' && state.isOwner && html`<${MembersCard} state=${state} />`}
    <${HeadcountCard} state=${state} />
    <${Card} title="월별 엑셀 내보내기">
      <div class="row" style="align-items:flex-end;gap:10px">
        <${Field} label="대상 월"><input type="month" value=${ym} onInput=${(e) => e.target.value && setYm(e.target.value)} /><//>
        <button class="btn primary" disabled=${xbusy} onClick=${doExport}><${Icon} name="download" />엑셀 내려받기</button>
      </div>
      <p class="note" style="margin:10px 0 0">${ymLabel(ym)} · 배양 ${n(monthCounts.cultures)} · 유청분리 ${n(monthCounts.separations)} · 충진 배치 ${n(monthCounts.batches)} · 포장 ${n(monthCounts.packs)}건${state.settings.exports && state.settings.exports[ym] ? ` · ${fmtDate(state.settings.exports[ym])}에 내려받음` : ''}</p>
      ${exportedMonths.length > 0 && html`<div class="chips" style="margin-top:10px">${exportedMonths.map(([m, d]) => html`<span key=${m} class="chip good" title=${`내려받은 날 ${fmtDate(d)}`}>${m}</span>`)}</div>`}
    <//>
    <${Card} title="반기 자동 정리">
      <label class="row" style="gap:8px;cursor:pointer;margin-bottom:10px"><input type="checkbox" checked=${state.settings.retentionEnabled !== false} disabled=${!state.canWrite} onChange=${(e) => saveSettings({ retentionEnabled: e.target.checked })} /><span>자동 정리 사용 (해당 달의 엑셀을 모두 내려받은 뒤 앱을 열면 자동 삭제)</span></label>
      ${ret.items.length === 0
        ? html`<p class="note" style="margin:0">${fmtDate(ret.cutoff)} 이전 실적이 없습니다. 다음 정리 대상은 ${fmtDate(ret.cutoff)} 이전 기록입니다.${state.settings.lastPurge ? ` 마지막 정리 ${fmtDate(state.settings.lastPurge)} (${n(state.settings.lastPurgeCount)}건)` : ''}</p>`
        : html`<div class="banner ${ret.notExported.length ? 'warn' : 'info'}" style="margin-bottom:10px"><${Icon} name="alert" /><span>보관 기간이 끝난 실적 <b>${n(ret.items.length)}건</b> (${ret.months[0]} ~ ${ret.months[ret.months.length - 1]})${ret.notExported.length ? ` · 엑셀로 내려받지 않은 달: ${ret.notExported.join(', ')}` : ' · 모든 달 엑셀 내려받음'}</span></div>
          <div class="row"><button class="btn primary" disabled=${pbusy || !state.canWrite} onClick=${exportThenPurge}><${Icon} name="download" />엑셀 저장 후 삭제</button><button class="btn" disabled=${pbusy || !state.canWrite} onClick=${purgeOnly}><${Icon} name="trash" />삭제만</button></div>`}
    <//>
    <${Card} title="저장소" desc=${state.mode === 'db' ? '이 페이지를 열 수 있는 팀원과 데이터를 공유합니다 (공유 데이터베이스)' : state.mode === 'local' ? '이 브라우저에만 저장됩니다. 다른 기기와 공유하려면 백업 파일을 옮기세요.' : ''}>
      <dl class="kv">${counts.map(([c, v]) => html`<dt key=${c}>${names[c]}</dt><dd key=${c + 'v'}>${n(v)}건</dd>`)}</dl>
      <div class="row" style="margin-top:14px"><button class="btn" onClick=${copyBackup}><${Icon} name="copy" />전체 데이터 복사 (JSON)</button>
        <label class="btn" style="cursor:pointer"><${Icon} name="download" />백업 파일 복원<input type="file" accept="application/json,.json" hidden disabled=${busy || !state.canWrite} onChange=${(e) => restore(e.target.files[0])} /></label></div>
    <//>
    <${Card} title="예시 데이터">
      ${state.demo ? html`<div class="banner warn" style="margin-bottom:12px"><${Icon} name="eye" /><span>지금 예시 데이터를 보고 있습니다. 입력한 내용은 저장되지 않습니다.</span></div><button class="btn primary" onClick=${exitDemo}>실제 데이터로 돌아가기</button>`
        : html`<p class="note" style="margin:0 0 12px">최근 4주간의 배양 → 유청분리 → 충진/포장 흐름을 가상으로 생성합니다. 실제 요즘의 생산실적이 아닙니다.</p><button class="btn" onClick=${enterDemo}><${Icon} name="eye" />예시 데이터 보기</button>`}
    <//>
  </div>`;
}
