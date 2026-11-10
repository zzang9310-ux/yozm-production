// 원부자재 수불: 기간별 투입 자재(주별·월별, 실적 × BOM 환산), LOT별 재고, 입고 등록, 사용 내역(배양·포장에서 자동 집계)
import { html, useState, useMemo, Card, Chip, Icon, Field, Modal, DataTable, Empty, Segmented, toast, confirmAsync, exportCSV } from '../ui.js';
import { save, remove } from '../store.js';
import { materialStock, materialUsage, productOf } from '../model.js';
import { n, fmtDate, fmtMD, today, uid, num, weeksOfMonth, monthRange, addMonths } from '../util.js';

const LOT_STATUS = { ok: ['재고 보유', 'good'], soon: ['기한 임박', 'warn'], expired: ['기한 경과', 'bad'], empty: ['소진', ''] };

export function MaterialsPage({ state, go }) {
  const [tab, setTab] = useState('period');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null);
  const mat = useMemo(() => materialStock(state), [state]);
  const lots = mat.lots.filter((l) => !q || (l.lot + l.material.name + l.materialCode).toLowerCase().includes(q.toLowerCase()));
  const del = async (l) => { if (await confirmAsync(`자재 LOT ${l.lot}을 삭제할까요?`)) { await remove('materialLots', l.id); toast('삭제했습니다.'); } };
  const usage = useMemo(() => {
    const rows = [];
    for (const c of state.cultures) for (const r of c.rawLots || []) rows.push({ date: c.date, lotId: r.lotId, qty: r.qty, ref: `배양 ${c.lot}`, refType: 'culture', refId: c.id });
    for (const p of state.packs) for (const r of p.packLots || []) rows.push({ date: p.date, lotId: r.lotId, materialCode: r.materialCode, qty: r.qty, ref: `포장 ${p.productLot}`, refType: 'pack', refId: p.id });
    return rows.map((r) => ({ ...r, lot: mat.lots.find((l) => l.id === r.lotId), mat: state.materials.find((m) => m.code === (r.materialCode || (mat.lots.find((l) => l.id === r.lotId) || {}).materialCode)) }))
      .filter((r) => !q || ((r.lot ? r.lot.lot : '') + (r.mat ? r.mat.name : '')).toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 300);
  }, [state, mat, q]);

  return html`
    <div class="page-head"><div><div class="eyebrow">자재</div><h1>원부자재 수불</h1></div>
      <div class="actions"><button class="btn" onClick=${() => exportCSV('자재LOT재고.csv', ['자재코드', '자재명', 'LOT', '입고일', '기한', '입고수량', '사용', '폐기', '잔량', '단위', '상태'], mat.lots.map((l) => [l.materialCode, l.material.name, l.lot, l.receivedDate, l.expiry, l.qty, l.usedQty, l.disposedQty, l.remaining, l.material.unit, LOT_STATUS[l.status][0]]))}><${Icon} name="download" />재고 CSV</button><button class="btn primary" disabled=${!state.canWrite} onClick=${() => setModal({})}><${Icon} name="plus" />입고 등록</button></div></div>

    ${mat.byMaterial.some((m) => m.belowSafety) && html`<div class="banner warn"><${Icon} name="alert" /><span>안전재고 미달: ${mat.byMaterial.filter((m) => m.belowSafety).map((m) => `${m.name} (가용 ${n(m.available)} / 안전 ${n(m.safety)} ${m.unit})`).join(' · ')}</span></div>`}

    <${Card}>
      <div class="filters">
        <${Segmented} options=${[{ value: 'period', label: '기간별 투입' }, { value: 'lots', label: 'LOT별 재고' }, { value: 'summary', label: '자재별 요약' }, { value: 'usage', label: '사용 내역' }]} value=${tab} onChange=${setTab} />
        <div class="search" style="min-width:min(100%,280px)"><${Icon} name="search" /><input id="mat-q" class="input" placeholder="자재명 · LOT 검색" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
      </div>
    <//>

    ${tab === 'period' && html`<${PeriodUsage} state=${state} go=${go} q=${q} />`}
    ${tab === 'lots' && html`<${Card} title="LOT별 자재 재고" count=${lots.length} desc=${`${fmtDate(today())} 기준`} flush>
      <${DataTable} rows=${lots} cols=${[
        { key: 'material', label: '자재', render: (l) => l.material.name, sub: (l) => l.materialCode },
        { key: 'lot', label: 'LOT', render: (l) => html`<button class="linkish" onClick=${() => go('trace', { q: l.lot })}>${l.lot}</button>`, sub: (l) => l.supplier || '' },
        { key: 'receivedDate', label: '입고일', render: (l) => fmtDate(l.receivedDate) }, { key: 'expiry', label: '기한', render: (l) => l.expiry ? fmtDate(l.expiry) : '미지정' },
        { key: 'qty', label: '입고', num: true, render: (l) => n(l.qty) }, { key: 'usedQty', label: '사용', num: true, render: (l) => n(l.usedQty) }, { key: 'disposedQty', label: '폐기', num: true, render: (l) => n(l.disposedQty) },
        { key: 'remaining', label: '잔량', num: true, render: (l) => html`<b>${n(l.remaining)}</b> ${l.material.unit}` },
        { key: 'status', label: '상태', render: (l) => html`<${Chip} tone=${LOT_STATUS[l.status][1]} dot>${LOT_STATUS[l.status][0]}<//>` },
        { key: 'act', label: '', render: (l) => html`<div class="row-actions"><button class="icon-btn" aria-label="수정" onClick=${() => setModal({ rec: l })}><${Icon} name="edit" /></button><button class="icon-btn danger" aria-label="삭제" disabled=${!state.canWrite} onClick=${() => del(l)}><${Icon} name="trash" /></button></div>` },
      ]} empty=${html`<${Empty} title="등록된 자재 LOT가 없습니다">입고 등록으로 원유·용기 등 자재 LOT를 추가하세요. 자재 품목은 기준정보에서 관리합니다.<//>`} />
    <//>`}
    ${tab === 'summary' && html`<${Card} title="자재별 가용 재고" flush>
      <${DataTable} rows=${mat.byMaterial} keyFn=${(m) => m.code} cols=${[
        { key: 'name', label: '자재', sub: (m) => m.code }, { key: 'kind', label: '구분', render: (m) => m.kind === 'raw' ? '원자재' : '부자재' },
        { key: 'lots', label: 'LOT 수', num: true, render: (m) => n(m.lots.filter((l) => l.remaining > 0).length) },
        { key: 'available', label: '가용 재고', num: true, render: (m) => `${n(m.available)} ${m.unit}` }, { key: 'safety', label: '안전재고', num: true, render: (m) => m.safety ? `${n(m.safety)} ${m.unit}` : '—' },
        { key: 'st', label: '상태', render: (m) => m.belowSafety ? html`<${Chip} tone="warn" dot>안전재고 미달<//>` : html`<${Chip} tone="good" dot>정상<//>` },
      ]} empty=${html`<${Empty} title="자재 품목이 없습니다">기준정보 → 자재에서 품목을 등록하세요.<//>`} />
    <//>`}
    ${tab === 'usage' && html`<${Card} title="사용 내역" count=${usage.length} flush>
      <${DataTable} rows=${usage} keyFn=${(r, i) => i} cols=${[
        { key: 'date', label: '일자', render: (r) => fmtDate(r.date) }, { key: 'material', label: '자재', render: (r) => r.mat ? r.mat.name : r.lot ? r.lot.material.name : '(알 수 없음)' }, { key: 'lot', label: 'LOT', render: (r) => r.lot ? r.lot.lot : html`<span class="muted">LOT 미지정</span>` },
        { key: 'qty', label: '사용량', num: true, render: (r) => `${n(r.qty, 3)} ${r.mat ? r.mat.unit : r.lot ? r.lot.material.unit : ''}` },
        { key: 'ref', label: '사용처', render: (r) => html`<button class="linkish" onClick=${() => go('trace', { q: r.ref.split(' ')[1] })}>${r.ref}</button>` },
      ]} empty=${html`<${Empty} title="사용 내역이 없습니다">배양 실적의 원유 LOT, 포장 내역의 포장재 LOT를 연결하면 집계됩니다.<//>`} />
    <//>`}
    ${modal && html`<${LotModal} state=${state} init=${modal} onClose=${() => setModal(null)} />`}`;
}

// ---------- 기간별 투입 자재 ----------
// 분류 표시·정렬 순서: 원자재(원유 → 유산균 → 부원료) → 부자재(용기 → 캡 → 리드 → 라벨 → 카톤 → 그 외)
const GROUP_ORDER = ['원유', '유산균', '부원료', '용기', '캡', '리드', '라벨', '카톤'];
function groupLabel(m) {
  if (m.group && m.group !== '구분없음') return m.group;
  const nm = m.name || '';
  for (const g of ['리드', '라벨', '카톤', '캡', '용기', '비닐백', '슬리브']) if (nm.includes(g)) return g;
  // 자재 기준정보에 없는 코드(엑셀 BOM에만 있는 부원료 등)는 ERP 코드 체계로 추정: 5BF… = 부원료, 5ML… = 원유, 5BC… = 유산균
  const code = String(m.code || '');
  if (code.startsWith('5BF')) return '부원료';
  if (code.startsWith('5ML')) return '원유';
  if (code.startsWith('5BC')) return '유산균';
  return m.kind === 'raw' ? '원자재' : '부자재';
}
// 소수 자릿수: 개수(ea·봉)는 정수, 롤은 소수 2자리, kg 등은 100 이상이면 정수·그 아래는 1자리 (부원료 소량 구분용)
const dec = (unit, v = 0) => unit === 'ea' || unit === '봉' ? 0 : unit === '롤' ? 2 : Math.abs(v) >= 100 ? 0 : 1;

function PeriodUsage({ state, go, q }) {
  const [mode, setMode] = useState('week');
  const [ym, setYm] = useState(today().slice(0, 7));
  const td = today();
  // 열: 주별 = 그 달의 주차(일~토 블록, 아직 시작 안 한 주 제외) / 월별 = 기준 월까지 최근 6개월
  const periods = useMemo(() => {
    if (mode === 'week') return weeksOfMonth(ym).filter((w) => w.from <= td).map((w) => ({ key: w.from, label: `${w.n}주차`, sub: `${fmtMD(w.from)}~${fmtMD(w.to)}`, from: w.from, to: w.to }));
    const list = [];
    for (let i = 5; i >= 0; i--) { const m = addMonths(ym, -i); if (m > td.slice(0, 7)) continue; list.push({ key: m, label: `${Number(m.slice(5))}월`, sub: `${m.slice(0, 4)}년`, ...monthRange(m) }); }
    return list;
  }, [mode, ym]);
  const data = useMemo(() => {
    const cols = periods.map((p) => ({ ...p, usage: materialUsage(state, p) }));
    const byCode = new Map();
    for (const c of cols) for (const r of c.usage.rows) {
      if (!byCode.has(r.materialCode)) byCode.set(r.materialCode, { materialCode: r.materialCode, material: r.material, basis: r.basis, cells: {}, total: 0, bomTotal: 0 });
      const row = byCode.get(r.materialCode); row.cells[c.key] = r; row.total += r.qty; row.bomTotal += r.bomQty;
    }
    const order = (r) => { const m = r.material; const g = GROUP_ORDER.indexOf(groupLabel(m)); return [m.kind === 'raw' ? 0 : 1, g < 0 ? 99 : g, m.name || '']; };
    const rows = [...byCode.values()].sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); });
    const missing = new Map();
    for (const c of cols) for (const [code, ea] of c.usage.missing) missing.set(code, (missing.get(code) || 0) + ea);
    return { cols, rows, missing: [...missing], cultures: cols.reduce((s, c) => s + c.usage.cultures, 0) };
  }, [state, periods]);
  const rows = data.rows.filter((r) => !q || (r.material.name + r.materialCode).toLowerCase().includes(q.toLowerCase()));
  const pname = (code) => { const p = productOf(state, code); return p ? p.name : code; };
  const cell = (r, key) => {
    const x = r.cells[key];
    if (!x || !(x.qty > 0)) return html`<span class="muted">·</span>`;
    const tip = x.basis === 'culture' ? '배양 실적 합계 (BOM 환산은 아래 작은 글씨)' : [...x.byProduct].map(([code, ea]) => `${pname(code)} ${n(ea)}개`).join('\n');
    return html`<span title=${tip}>${n(x.qty, dec(r.material.unit, x.qty))}</span>${x.basis === 'culture' && x.bomQty > 0 ? html`<span class="sub">BOM ${n(x.bomQty, dec(r.material.unit === '봉' ? 'kg' : r.material.unit, x.bomQty))}</span>` : ''}`;
  };
  const title = mode === 'week' ? `${Number(ym.slice(5))}월 주별 투입 자재` : `월별 투입 자재 (${Number(addMonths(ym, -5).slice(5))}월~${Number(ym.slice(5))}월)`;
  const csv = () => exportCSV(`투입자재_${mode === 'week' ? ym + '_주별' : ym + '_월별'}.csv`, ['자재코드', '자재명', '구분', '단위', ...data.cols.map((c) => `${c.label} (${c.sub})`), '합계', '산출'],
    rows.map((r) => [r.materialCode, r.material.name, groupLabel(r.material), r.material.unit || '', ...data.cols.map((c) => { const x = r.cells[c.key]; return x ? Math.round(x.qty * 1000) / 1000 : 0; }), Math.round(r.total * 1000) / 1000, r.basis === 'culture' ? '배양 실적' : '포장 수량 × BOM']));
  const cols = [
    { key: 'm', label: '자재', render: (r) => r.material.name, sub: (r) => r.materialCode },
    { key: 'g', label: '구분', render: (r) => html`<${Chip} tone=${r.material.kind === 'raw' ? 'accent' : ''}>${groupLabel(r.material)}<//>` },
    { key: 'u', label: '단위', render: (r) => r.material.unit || '' },
    ...data.cols.map((c) => ({ key: c.key, label: html`${c.label}<div class="muted" style="font-weight:400;font-size:11px">${c.sub}</div>`, num: true, render: (r) => cell(r, c.key) })),
    { key: 'tot', label: '합계', num: true, render: (r) => html`<b>${n(r.total, dec(r.material.unit, r.total))}</b>${r.basis === 'culture' && r.bomTotal > 0 ? html`<span class="sub">BOM ${n(r.bomTotal, dec(r.material.unit === '봉' ? 'kg' : r.material.unit, r.bomTotal))}</span>` : ''}` },
  ];
  return html`
    <${Card}>
      <div class="filters">
        <${Field} label="보기"><${Segmented} options=${[{ value: 'week', label: '주별' }, { value: 'month', label: '월별' }]} value=${mode} onChange=${setMode} /><//>
        <${Field} label=${mode === 'week' ? '월' : '기준 월'}><div class="row" style="flex-wrap:nowrap"><button class="btn sm" aria-label="이전 달" onClick=${() => setYm(addMonths(ym, -1))}><${Icon} name="left" /></button><input id="mat-month" type="month" class="input" style="width:140px" value=${ym} onInput=${(e) => e.target.value && setYm(e.target.value)} /><button class="btn sm" aria-label="다음 달" onClick=${() => setYm(addMonths(ym, 1))}><${Icon} name="right" /></button></div><//>
        <div class="spacer"></div>
        <div class="note" style="align-self:center">자재 ${n(rows.length)}종 · 배양 ${n(data.cultures)}건 반영</div>
      </div>
    <//>
    ${data.missing.length > 0 && html`<div class="banner warn"><${Icon} name="alert" /><span>BOM이 없어 자재를 환산하지 못한 제품: ${data.missing.map(([code, ea]) => `${pname(code)} ${n(ea)}개`).join(' · ')}</span><button onClick=${() => go('master', { tab: 'bom' })}>기준정보 → BOM에서 등록</button></div>`}
    <${Card} title=${title} count=${rows.length} desc="부자재·부원료 = 그 기간 포장 수량 × BOM 단위소요량 · 원유·유산균 = 그 기간 배양 실적(원유 kg·스타터 봉), 작은 글씨는 포장 수량 기준 BOM 환산값 · 주차는 일~토" actions=${html`<button class="btn sm" onClick=${csv}><${Icon} name="download" />CSV</button>`} flush>
      <${DataTable} rows=${rows} keyFn=${(r) => r.materialCode} cols=${cols} empty=${html`<${Empty} title="이 기간에 투입된 자재가 없습니다">충진/포장 실적과 배양 실적을 입력하면 BOM을 기준으로 자재 투입량이 자동 집계됩니다. 제품별 BOM은 기준정보 → BOM에서 확인하세요.<//>`} />
    <//>`;
}

function LotModal({ state, init, onClose }) {
  const rec = init.rec;
  const [f, setF] = useState(() => rec ? { ...rec } : { id: uid(), materialCode: state.materials[0]?.code || '', lot: '', receivedDate: today(), expiry: '', qty: '', disposedQty: 0, supplier: '', note: '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const m = state.materials.find((x) => x.code === f.materialCode);
  const submit = async () => {
    if (!f.materialCode) { toast('자재를 선택하세요. 품목이 없으면 기준정보에서 먼저 등록하세요.', 'bad'); return; }
    if (!f.lot.trim()) { toast('LOT 번호를 입력하세요.', 'bad'); return; }
    if (num(f.qty) <= 0) { toast('입고 수량을 입력하세요.', 'bad'); return; }
    const doc = { id: f.id, materialCode: f.materialCode, lot: f.lot.trim(), receivedDate: f.receivedDate, expiry: f.expiry || '', qty: num(f.qty), disposedQty: num(f.disposedQty), supplier: f.supplier || '', note: f.note || '' };
    await save('materialLots', doc); toast(rec ? '수정했습니다.' : '입고를 등록했습니다.'); onClose();
  };
  return html`<${Modal} title=${rec ? `자재 LOT 수정 · ${rec.lot}` : '자재 입고 등록'} onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>취소</button><button class="btn primary" onClick=${submit}>${rec ? '저장' : '등록'}</button>`}>
    <div class="form-grid">
      <${Field} label="자재"><select value=${f.materialCode} onChange=${(e) => set('materialCode', e.target.value)}>${state.materials.map((x) => html`<option key=${x.code} value=${x.code}>${x.name} (${x.code})</option>`)}</select><//>
      <${Field} label="LOT 번호"><input value=${f.lot} placeholder="예) MLK-261027" onInput=${(e) => set('lot', e.target.value)} /><//>
      <${Field} label="입고일"><input type="date" value=${f.receivedDate} onInput=${(e) => set('receivedDate', e.target.value)} /><//>
      <${Field} label="유통/사용 기한" hint="없으면 비워 두세요"><input type="date" value=${f.expiry} onInput=${(e) => set('expiry', e.target.value)} /><//>
      <${Field} label=${`입고 수량 (${m ? m.unit : ''})`}><input type="number" min="0" value=${f.qty} onInput=${(e) => set('qty', e.target.value)} /><//>
      <${Field} label="폐기 수량"><input type="number" min="0" value=${f.disposedQty} onInput=${(e) => set('disposedQty', e.target.value)} /><//>
      <${Field} label="공급처"><input value=${f.supplier} onInput=${(e) => set('supplier', e.target.value)} /><//>
      <${Field} label="비고" class="span-all"><input value=${f.note} onInput=${(e) => set('note', e.target.value)} /><//>
    </div>
  <//>`;
}
