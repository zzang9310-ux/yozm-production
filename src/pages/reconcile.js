// 전산 대조: 날짜를 고르면 그날 앱에 입력한 충진/포장 실적(품목명·제품 LOT·수량)이 나오고,
// 전산(ERP) "생산실적 현황" 엑셀을 올리면 같은 표에 전산 수량·차이가 붙으며 다른 줄은 빨간색으로 표시됩니다.
//  - 키: 품목코드 + 제품 LOT (전산 "2026.11.09 B3" ↔ 앱 "26-1109 B3")
//  - "불량 전산대로 반영": 전산 불량수량을 맞춰진 포장 내역이 속한 충진 배치의 불량(ea)에 합산해 저장
import { html, useState, useMemo, Card, Chip, Icon, Field, Stat, DataTable, Empty, toast, confirmAsync, exportCSV } from '../ui.js';
import { save, remove } from '../store.js';
import { pendingMovesFor, attachMovesToDraft } from '../draft.js';
import { parseErpFillXlsx } from '../excel.js';
import { productOf, fillerOf, bomRequirements, pickMaterialLot } from '../model.js';
import { n, fmtDate, dow, num, sum, addDays, today, uid, batchNo } from '../util.js';

/**
 * 전산에만 있는 줄(앱에 미입력)로 충진 배치를 미리 만든다 — 면포·계근·폐기 없이 "전산 임시" 배치(erpDraft).
 * 묶음 = 날짜 + 설비 + 재공품 유형(제품 기준정보). 같은 날 같은 설비·유형 배치가 이미 있으면 그 묶음은 건너뜀(수동 추가).
 * 시작/종료 = 줄들의 가장 이른 시작시간 ~ 가장 늦은 완성시간, 인원 = 기준정보 설비 기본 작업자, 불량 = 줄 합산.
 */
export function buildErpDrafts(state, erpOnlyItems, date) {
  const fillers = state.settings.fillers || [];
  const groups = new Map();
  for (const it of erpOnlyItems) for (const r of it.erp) {
    const fillerId = it.fillerId; const p = productOf(state, r.productCode); const mixType = p ? (p.mixType || '') : '';
    const k = `${fillerId}|${mixType}`;
    if (!groups.has(k)) groups.set(k, { fillerId, mixType, rows: [] });
    groups.get(k).rows.push(r);
  }
  const drafts = [], skipped = [];
  const seqBase = new Map();
  // 버퍼 번호(버퍼1·2…)는 설비별로 전산 시작시간이 이른 묶음부터. 시간이 없는 묶음(벌크 등)은 맨 뒤
  const firstTime = (g) => { const t = g.rows.map((r) => r.time).filter(Boolean).sort(); return t[0] || '99:99'; };
  const ordered = [...groups.values()].sort((a, b) => a.fillerId.localeCompare(b.fillerId) || firstTime(a).localeCompare(firstTime(b)));
  for (const g of ordered) {
    const filler = fillers.find((x) => x.id === g.fillerId);
    if (!filler) { skipped.push({ ...g, why: '설비를 알 수 없음' }); continue; }
    if (state.batches.some((b) => b.date === date && b.fillerId === g.fillerId && (b.mixType || '') === g.mixType)) { skipped.push({ ...g, why: '같은 날·설비·유형 배치가 이미 있음' }); continue; }
    const seq = (seqBase.get(g.fillerId) ?? state.batches.filter((b) => b.date === date && b.fillerId === g.fillerId).length) + 1; seqBase.set(g.fillerId, seq);
    // 전산의 시작/완성시간은 전산 입력 시각이라(1분짜리 줄이 흔함) 가동 시간으로 쓰지 않고 비고에만 적어 둠 — 작업시간은 나중에 배치 수정에서 입력
    const times = g.rows.map((r) => r.time).filter(Boolean).sort(), ends = g.rows.map((r) => r.endTime).filter(Boolean).sort();
    // 묶음의 줄 여러 개가 전부 5분 안에(첫 시작~마지막 완성) 입력됐으면 퇴근 전 몰아 입력한 것 → 줄 사이 순서는 입력 순서일 뿐이라 표시해 둠
    const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
    const spanMin = times.length && ends.length ? toMin(ends[ends.length - 1]) - toMin(times[0]) : null;
    const bulkEntry = g.rows.length >= 2 && spanMin != null && spanMin <= 5;
    const erpSpan = times.length ? `${times[0]}~${ends.length ? ends[ends.length - 1] : '?'}${bulkEntry ? ' (몰아 입력)' : ''}` : '';
    const crew = { fill: [...((filler.crew || {}).fill || [])], cap: [...((filler.crew || {}).cap || [])], pack: [...((filler.crew || {}).pack || [])] };
    const workers = crew.fill.length + crew.cap.length + crew.pack.length;
    const goodEa = sum(g.rows, (r) => r.goodEa), defectEa = sum(g.rows, (r) => r.defectEa);
    const id = uid();
    const batch = { id, date, fillerId: g.fillerId, mixType: g.mixType, batchNo: batchNo(date, filler.name, seq, g.mixType), sources: [], fermentKg: 0, ingredientKg: 0, outKg: 0, inputKg: 0, wasteKg: 0,
      goodEa, defectEa, goodKg: null, lossKg: 0, startTime: '', endTime: '', breakMin: 0, runMin: 0, crew, workers, hours: 0,
      note: `전산 생산실적에서 미리 등록${erpSpan ? ` (전산 입력 시각 ${erpSpan})` : ''}`, erpDraft: true, erpImportedAt: new Date().toISOString(), erpSpan };
    const packs = g.rows.map((r) => {
      const packLots = bomRequirements(state, r.productCode, r.goodEa).map((q) => { const lot = pickMaterialLot(state, q.materialCode); return { materialCode: q.materialCode, lotId: lot ? lot.id : '', qty: Math.round(q.total * 1000) / 1000 }; });
      // erpTime: 전산 시작시간 — 같은 배치 안 제품 LOT의 충진 순서(전산 입력 순) 표시용
      return { id: uid(), batchId: id, date, kind: 'normal', productCode: r.productCode, productLot: r.lot, expiry: r.expiry || '', qty: r.goodEa, usedKg: null, workers: 0, hours: 0, packLots, note: '', erpTime: r.time || '', erpEndTime: r.endTime || '' };
    });
    drafts.push({ batch, packs, filler: filler.name, rows: g.rows });
  }
  return { drafts, skipped };
}

const keyOf = (code, lot) => `${String(code).trim()}|${String(lot).trim()}`;
const shortName = (s) => String(s || '').replace(/^충진[-_]\s*/, '');
const STATUS = { match: { label: '일치', tone: 'good' }, diff: { label: '수량 차이', tone: 'bad' }, erpOnly: { label: '전산에만 있음', tone: 'bad' }, appOnly: { label: '앱에만 있음', tone: 'bad' }, none: { label: '', tone: '' } };

/** 전산 행과 앱 포장 내역을 날짜별로 대조. erpRows가 비어 있으면 앱 실적 목록만 만든다(status 'none'). */
export function reconcileDate(state, erpRows, date) {
  const hasErp = erpRows.length > 0;
  const erp = erpRows.filter((r) => r.date === date);
  const packs = state.packs.filter((p) => p.date === date);
  const batchOf = (id) => state.batches.find((b) => b.id === id);
  const fillerIdOfCode = (code, fillerStr) => {
    const fs = state.settings.fillers || [];
    let f = code ? fs.find((x) => (x.code || '').toUpperCase() === code) : null;
    for (const kw of ['벌크', '드링크', '로타리', '반자동']) if (!f && fillerStr.includes(kw)) f = fs.find((x) => x.name.includes(kw));
    return f ? f.id : '';
  };
  const erpByKey = new Map(); for (const r of erp) { const k = keyOf(r.productCode, r.lot); if (!erpByKey.has(k)) erpByKey.set(k, []); erpByKey.get(k).push(r); }
  const appByKey = new Map(); for (const p of packs) { const k = keyOf(p.productCode, p.productLot); if (!appByKey.has(k)) appByKey.set(k, []); appByKey.get(k).push(p); }
  const keys = [...new Set([...appByKey.keys(), ...erpByKey.keys()])];
  const items = keys.map((k) => {
    const e = erpByKey.get(k) || [], a = appByKey.get(k) || [];
    const [code, lot] = k.split('|');
    const product = productOf(state, code);
    const erpGood = sum(e, (r) => r.goodEa), appQty = sum(a, (p) => p.qty);
    const status = !hasErp ? 'none' : e.length && a.length ? (erpGood === appQty ? 'match' : 'diff') : e.length ? 'erpOnly' : 'appOnly';
    const batches = [...new Set(a.map((p) => p.batchId))].map(batchOf).filter(Boolean);
    const fillerId = batches.length ? batches[0].fillerId : fillerIdOfCode(e[0] ? e[0].fillerCode : '', e[0] ? e[0].fillerStr : '');
    return { key: k, code, lot, name: product ? shortName(product.name) : shortName(e[0] ? e[0].productName : code), fillerId, filler: fillerOf(state, fillerId).name, batches, batchNo: batches.map((b) => b.batchNo).join(', '),
      erp: e, app: a, erpGood, erpDefect: sum(e, (r) => r.defectEa), erpInput: sum(e, (r) => r.inputEa), appQty, diff: appQty - erpGood, status, bad: status === 'diff' || status === 'erpOnly' || status === 'appOnly' };
  }).sort((a, b) => a.filler.localeCompare(b.filler) || a.batchNo.localeCompare(b.batchNo) || a.name.localeCompare(b.name) || a.lot.localeCompare(b.lot));
  const by = (st) => items.filter((x) => x.status === st);
  const dayBatches = state.batches.filter((b) => b.date === date);
  const fillerIds = [...new Set([...items.map((x) => x.fillerId), ...dayBatches.map((b) => b.fillerId)])].filter(Boolean);
  const byFiller = fillerIds.map((fid) => {
    const its = items.filter((x) => x.fillerId === fid);
    const batches = dayBatches.filter((b) => b.fillerId === fid);
    return { fillerId: fid, filler: fillerOf(state, fid).name, erpGood: sum(its, (x) => x.erpGood), appGood: sum(its, (x) => x.appQty), erpDefect: sum(its, (x) => x.erpDefect), appDefect: sum(batches, (b) => b.defectEa),
      erpRunMin: sum(its, (x) => sum(x.erp, (r) => r.runMin)), appRunMin: sum(batches, (b) => b.runMin), batches: batches.length, lines: its.length, bad: its.filter((x) => x.bad).length };
  }).sort((a, b) => a.filler.localeCompare(b.filler));
  const total = { erpGood: sum(items, (x) => x.erpGood), appGood: sum(items, (x) => x.appQty), erpDefect: sum(items, (x) => x.erpDefect), appDefect: sum(dayBatches, (b) => b.defectEa), erpLines: erp.length, appLines: packs.length, bad: items.filter((x) => x.bad).length };
  return { date, hasErp, items, match: by('match'), diff: by('diff'), erpOnly: by('erpOnly'), appOnly: by('appOnly'), byFiller, total };
}

export function ReconcilePage({ state, params, go }) {
  const [date, setDate] = useState(params.date || today());
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [onlyBad, setOnlyBad] = useState(false);

  const onFile = async (f) => {
    if (!f) return;
    setBusy(true); setErr(''); setParsed(null); setFile(f);
    try {
      const buf = await f.arrayBuffer();
      const res = await parseErpFillXlsx(buf);
      if (!res.rows.length) throw new Error('읽을 수 있는 충진 실적 줄이 없습니다.');
      setParsed(res);
      if (res.dates.length && !res.dates.includes(date)) setDate(res.dates[0]);
      toast(`전산 실적 ${n(res.rows.length)}줄을 읽었습니다 (${res.dates.map(fmtDate).join(', ')}).`);
    } catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
  };
  const erpForDate = parsed && parsed.dates.includes(date);
  const rec = useMemo(() => reconcileDate(state, erpForDate ? parsed.rows : [], date), [state, parsed, erpForDate, date]);
  const rows = onlyBad && rec.hasErp ? rec.items.filter((x) => x.bad) : rec.items;

  const applyDefects = async () => {
    if (!rec.hasErp) return;
    const perBatch = new Map();
    for (const it of rec.items) if (it.app.length && it.erp.length) { const bid = it.app[0].batchId; perBatch.set(bid, (perBatch.get(bid) || 0) + it.erpDefect); }
    const changes = [...perBatch].map(([bid, d]) => ({ b: state.batches.find((x) => x.id === bid), d })).filter((x) => x.b && num(x.b.defectEa) !== x.d);
    if (!changes.length) { toast('이미 전산 불량과 같습니다.'); return; }
    const msg = `${fmtDate(rec.date)} 충진 배치 ${changes.length}건의 불량(ea)을 전산 불량수량으로 바꿀까요? ${changes.map((c) => `${c.b.batchNo}: ${n(c.b.defectEa)} → ${n(c.d)}`).join(' · ')}`;
    if (!(await confirmAsync(msg, { ok: '반영', danger: false }))) return;
    for (const c of changes) await save('batches', { ...c.b, defectEa: c.d });
    toast(`배치 ${changes.length}건의 불량을 반영했습니다.`);
  };
  // 전산에만 있는 줄 → 충진 배치 미리 등록 (전산 임시 배치: 면포·계근·폐기는 나중에 배치 수정에서 입력)
  const draftPlan = useMemo(() => rec.hasErp && rec.erpOnly.length ? buildErpDrafts(state, rec.erpOnly, date) : null, [state, rec, date]);
  const [drafting, setDrafting] = useState(false);
  const createDrafts = async () => {
    if (!draftPlan || !draftPlan.drafts.length) return;
    const lines = draftPlan.drafts.map((d) => `${d.batch.batchNo}: ${d.rows.length}줄 · 양품 ${n(d.batch.goodEa)} ea${d.batch.defectEa ? ` · 불량 ${n(d.batch.defectEa)}` : ''}`);
    const skip = draftPlan.skipped.map((s) => `${fillerOf(state, s.fillerId).name} ${s.mixType || '(유형 없음)'} ${s.rows.length}줄 건너뜀 (${s.why})`);
    const msg = `${fmtDate(date)} 전산 줄로 충진 배치 ${draftPlan.drafts.length}건과 제품 LOT ${sum(draftPlan.drafts, (d) => d.packs.length)}줄을 미리 등록할까요? 면포(반출)·계근량·폐기량·작업시간은 비어 있는 "전산 임시" 배치로 저장되고, 나중에 충진/포장 실적에서 배치를 열어 채우면 됩니다.\n\n${lines.join('\n')}${skip.length ? '\n\n' + skip.join('\n') : ''}`;
    if (!(await confirmAsync(msg, { ok: '미리 등록', danger: false }))) return;
    setDrafting(true);
    try {
      let merged = 0;
      for (const d of draftPlan.drafts) {
        await save('batches', d.batch); for (const p of d.packs) await save('packs', p);
        // 그날 그 설비·유형으로 이미 반출된(배정 대기) 면포가 있으면 임시 배치의 배양 LOT로 바로 붙임
        merged += await attachMovesToDraft(state, d.batch, pendingMovesFor(state, date, d.batch.fillerId, d.batch.mixType));
      }
      toast(`충진 배치 ${draftPlan.drafts.length}건을 전산 임시로 등록했습니다.${merged ? ` 배정 대기 면포 ${merged}건을 함께 붙였습니다.` : ''}`);
    } catch (e) { toast(`등록 실패: ${e.message || e}`, 'bad'); }
    setDrafting(false);
  };
  // 임시 충진 실적(전산 임시 배치) 목록: 이 날 것은 표로, 다른 날 것은 날짜 칩으로. 정식 배치를 저장하면 같은 날·설비·제품 줄은 자동으로 빠짐(fill.absorbErpDrafts)
  const drafts = useMemo(() => state.batches.filter((b) => b.erpDraft), [state]);
  const dayDrafts = drafts.filter((b) => b.date === date).sort((a, b) => a.batchNo.localeCompare(b.batchNo));
  const otherDraftDates = [...new Set(drafts.filter((b) => b.date !== date).map((b) => b.date))].sort();
  const missingOf = (b) => { const m = []; if (!(b.sources || []).length) m.push('면포'); if (num(b.inputKg) <= 0) m.push('계근'); if (!b.startTime || !b.endTime) m.push('작업시간'); return m; };
  const deleteDraft = async (b) => {
    const packs = state.packs.filter((p) => p.batchId === b.id);
    if (!(await confirmAsync(`임시 배치 ${b.batchNo}와 제품 LOT ${packs.length}줄을 삭제할까요? 분석의 생산량에서도 빠집니다.`))) return;
    for (const p of packs) await remove('packs', p.id);
    await remove('batches', b.id);
    toast(`임시 배치 ${b.batchNo}를 삭제했습니다.`);
  };
  const csv = () => exportCSV(`전산대조_${rec.date}.csv`, ['구분', '설비', '배치', '품목코드', '품목', '제품 LOT', '앱 수량', '전산 양품', '차이', '전산 불량', '전산 투입'],
    rec.items.map((x) => [STATUS[x.status].label, x.filler, x.batchNo, x.code, x.name, x.lot, x.appQty, x.erp.length ? x.erpGood : '', x.erp.length && x.app.length ? x.diff : '', x.erpDefect, x.erpInput]));

  const cols = [
    { key: 'filler', label: '설비', render: (x) => html`<b>${x.filler}</b>${x.batches.some((b) => b.erpDraft) ? html` <${Chip} tone="warn" dot>전산 임시<//>` : ''}`, sub: (x) => x.batchNo },
    { key: 'name', label: '품목명', render: (x) => html`<b>${x.name}</b>`, sub: (x) => x.code },
    { key: 'lot', label: '제품 LOT', render: (x) => html`<span class="lot">${x.lot}</span>`, sub: (x) => x.erp.length && x.erp[0].lotRaw !== x.lot ? `전산 ${x.erp[0].lotRaw}` : '' },
    { key: 'app', label: '앱 수량 (ea)', num: true, render: (x) => x.app.length ? n(x.appQty) : html`<span class="muted">없음</span>`, sub: (x) => x.app.length > 1 ? `${x.app.length}줄 합계` : '', total: (t) => n(t.appGood) },
    ...(rec.hasErp ? [
      { key: 'erp', label: '전산 양품 (ea)', num: true, render: (x) => x.erp.length ? n(x.erpGood) : html`<span class="muted">없음</span>`, sub: (x) => x.erp.length && x.erpDefect ? `불량 ${n(x.erpDefect)}` : '', total: (t) => n(t.erpGood) },
      { key: 'diff', label: '차이 (앱 − 전산)', num: true, render: (x) => x.erp.length && x.app.length ? (x.diff === 0 ? '0' : `${x.diff > 0 ? '+' : ''}${n(x.diff)}`) : '—', total: (t) => `${t.appGood - t.erpGood > 0 ? '+' : ''}${n(t.appGood - t.erpGood)}` },
      { key: 'st', label: '확인 내용', render: (x) => x.status === 'match' ? html`<${Chip} tone="good" dot>일치<//>` : html`<${Chip} tone="bad" dot>${x.status === 'diff' ? `수량 다름 (앱 ${n(x.appQty)} / 전산 ${n(x.erpGood)})` : x.status === 'erpOnly' ? '전산에만 있음 · 앱에 미입력' : '앱에만 있음 · 전산에 없음'}<//>`, total: (t) => t.bad ? `확인 ${n(t.bad)}건` : '전부 일치' },
    ] : []),
    { key: 'act', label: '', render: (x) => html`<button class="linkish" onClick=${() => go('fill', { date })}>충진/포장 열기</button>` },
  ];

  return html`
    <div class="page-head"><div><div class="eyebrow">관리</div><h1>전산 대조</h1></div>
      <div class="actions">
        <label class="btn ${parsed ? '' : 'primary'}" style="cursor:pointer" title="전산 → 생산실적 현황 → 엑셀 저장한 파일 (.xlsx). 브라우저에서만 읽습니다"><${Icon} name="upload" />${busy ? '읽는 중…' : '엑셀 올리기'}<input type="file" accept=".xlsx,.xls,.xlsm" style="display:none" disabled=${busy} onChange=${(e) => { onFile(e.target.files && e.target.files[0]); e.target.value = ''; }} /></label>
        <button class="btn primary" disabled=${!state.canWrite || drafting || !draftPlan || !draftPlan.drafts.length} onClick=${createDrafts} title=${!parsed ? '먼저 전산 엑셀을 올리세요' : !draftPlan || !draftPlan.drafts.length ? '앱에 없는 전산 줄이 없어 저장할 임시 실적이 없습니다' : '앱에 없는 전산 줄을 임시 충진 실적으로 저장'}><${Icon} name="check" />임시 충진 실적 저장${draftPlan && draftPlan.drafts.length ? ` (${n(draftPlan.drafts.length)}건)` : ''}</button>
        <button class="btn" onClick=${csv}><${Icon} name="download" />CSV</button>
      </div></div>

    <${Card}>
      <div class="filters">
        <${Field} label="날짜"><div class="row" style="flex-wrap:nowrap"><button class="btn sm" onClick=${() => setDate(addDays(date, -1))} aria-label="이전 날"><${Icon} name="left" /></button><input type="date" class="input" style="width:150px" value=${date} onInput=${(e) => e.target.value && setDate(e.target.value)} /><button class="btn sm" onClick=${() => setDate(addDays(date, 1))} aria-label="다음 날"><${Icon} name="right" /></button></div><//>
        ${parsed ? html`<${Field} label="올린 전산 엑셀"><div class="note" style="line-height:36px">${file ? file.name : ''} · ${n(parsed.rows.length)}줄 · ${parsed.dates.map((d) => html`<button key=${d} class="chip clickable ${d === date ? 'accent' : ''}" style="margin-right:4px" onClick=${() => setDate(d)}>${fmtDate(d)}</button>`)}</div><//>`
          : html`<${Field} label="전산 엑셀"><div class="note" style="line-height:36px">오른쪽 위 "엑셀 올리기"로 전산 생산실적 현황(.xlsx)을 올리면 전산 수량과 차이가 표시됩니다</div><//>`}
        ${rec.hasErp && html`<${Field} label="보기"><div class="seg"><button class=${!onlyBad ? 'active' : ''} onClick=${() => setOnlyBad(false)}>전체</button><button class=${onlyBad ? 'active' : ''} onClick=${() => setOnlyBad(true)}>다른 줄만</button></div><//>`}
      </div>
      ${busy && html`<div class="note" style="margin-top:8px">엑셀을 읽는 중…</div>`}
      ${err && html`<div class="banner bad" style="margin-top:10px"><${Icon} name="alert" /><span>${err}</span></div>`}
      ${parsed && !erpForDate && html`<div class="banner warn" style="margin-top:10px"><${Icon} name="alert" /><span>올린 엑셀에는 ${fmtDate(date)} 실적이 없습니다. 파일에 있는 날짜: ${parsed.dates.map(fmtDate).join(', ')}</span></div>`}
    <//>

    ${rec.hasErp && html`<div class="stats">
      <${Stat} hero k=${`${fmtDate(date)}(${dow(date)}) 대조`} v=${rec.total.bad === 0 ? '전부 일치' : `${n(rec.total.bad)}건 다름`} s=${`앱 ${n(rec.total.appLines)}줄 · 전산 ${n(rec.total.erpLines)}줄 · 일치 ${n(rec.match.length)}`} />
      <${Stat} k="수량 다름" v=${n(rec.diff.length)} unit="건" s="품목·LOT는 같고 수량만 다른 줄" />
      <${Stat} k="전산에만" v=${n(rec.erpOnly.length)} unit="건" s="앱에 입력하지 않은 줄" />
      <${Stat} k="앱에만" v=${n(rec.appOnly.length)} unit="건" s="전산에 없는 줄" />
      <${Stat} k="양품 합계 (앱 / 전산)" v=${`${n(rec.total.appGood)} / ${n(rec.total.erpGood)}`} s=${`차이 ${rec.total.appGood - rec.total.erpGood > 0 ? '+' : ''}${n(rec.total.appGood - rec.total.erpGood)} ea`} />
      <${Stat} k="불량 합계 (앱 / 전산)" v=${`${n(rec.total.appDefect)} / ${n(rec.total.erpDefect)}`} s=${`차이 ${rec.total.appDefect - rec.total.erpDefect > 0 ? '+' : ''}${n(rec.total.appDefect - rec.total.erpDefect)} ea`} />
    </div>`}

    <${Card} title=${`${fmtDate(date)}(${dow(date)}) 충진/포장 실적`} count=${rows.length} desc=${rec.hasErp ? `앱 입력과 전산을 품목코드 + 제품 LOT로 맞춤 · 빨간 줄 = 수량이 다르거나 한쪽에만 있음 (${n(rec.total.bad)}건)` : '앱에 입력한 포장 내역(제품 LOT) 기준 · 전산 엑셀을 올리면 전산 수량과 차이가 함께 표시됩니다'} flush>
      <${DataTable} cols=${cols} rows=${rows} keyFn=${(x) => x.key} rowClass=${(x) => x.bad ? 'row-bad' : ''} total=${rows.length ? rec.total : null}
        empty=${html`<${Empty} title=${onlyBad ? '다른 줄이 없습니다' : '이 날 입력한 충진/포장 실적이 없습니다'}>${onlyBad ? '앱과 전산이 모두 일치합니다.' : html`충진/포장 실적에서 배치를 등록하면 여기에 나옵니다. <button class="linkish" onClick=${() => go('fill', { date })}>충진/포장 실적 열기</button>`}<//>`} />
    <//>

    ${(dayDrafts.length > 0 || otherDraftDates.length > 0) && html`<${Card} title=${`${fmtDate(date)}(${dow(date)}) 임시 충진 실적`} count=${dayDrafts.length} desc="전산 생산실적으로 미리 잡아 둔 배치 · 충진/포장 실적에서 계근량이나 작업시간을 넣어 저장하면 정식 배치가 되어 여기서 빠지고, 따로 등록한 정식 배치가 있으면 같은 날·설비·제품의 임시 줄은 자동 삭제됩니다 (배양·유청분리 입력과 무관)" flush>
      <${DataTable} rows=${dayDrafts} keyFn=${(b) => b.id} cols=${[
        { key: 'batch', label: '배치', render: (b) => html`<b>${b.batchNo}</b>`, sub: (b) => `${fillerOf(state, b.fillerId).name} · ${b.mixType || '유형 없음'}` },
        { key: 'lots', label: '제품 LOT', render: (b) => html`<div class="chips">${state.packs.filter((p) => p.batchId === b.id).map((p) => { const name = shortName((productOf(state, p.productCode) || {}).name || p.productCode); return html`<span key=${p.id} class="chip" title=${name}>${name} <span class="lot">${p.productLot}</span> <b>${n(p.qty)}</b></span>`; })}</div>` },
        { key: 'good', label: '양품 (ea)', num: true, render: (b) => n(b.goodEa), sub: (b) => b.defectEa ? `불량 ${n(b.defectEa)}` : '', total: (t) => n(t.goodEa) },
        { key: 'missing', label: '미입력', render: (b) => html`<div class="chips">${missingOf(b).map((m) => html`<${Chip} key=${m} tone="warn" dot>${m}<//>`)}</div>` },
        { key: 'at', label: '등록', render: (b) => b.erpImportedAt ? new Date(b.erpImportedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—', sub: (b) => b.erpSpan ? `전산 입력 ${b.erpSpan}` : '' },
        { key: 'act', label: '', render: (b) => html`<div class="row" style="gap:10px;flex-wrap:nowrap"><button class="linkish" onClick=${() => go('fill', { date: b.date })}>충진/포장 열기</button><button class="linkish" style="color:var(--bad)" disabled=${!state.canWrite} onClick=${() => deleteDraft(b)}>삭제</button></div>` },
      ]} total=${dayDrafts.length ? { goodEa: sum(dayDrafts, (b) => b.goodEa) } : null} empty=${html`<${Empty} title="이 날 임시 충진 실적이 없습니다">전산 엑셀을 올려 '충진 배치 미리 등록'을 누르면 여기에 나옵니다.<//>`} />
      ${otherDraftDates.length > 0 && html`<div class="note" style="padding:10px 14px">다른 날 임시 배치: ${otherDraftDates.map((d) => html`<button key=${d} class="chip clickable" style="margin-right:4px" onClick=${() => setDate(d)}>${fmtDate(d)} · ${n(drafts.filter((b) => b.date === d).length)}건</button>`)}</div>`}
    <//>`}
    ${rec.hasErp && draftPlan && (draftPlan.drafts.length > 0 || draftPlan.skipped.length > 0) && html`<${Card} title="충진 배치 미리 등록" count=${draftPlan.drafts.length} desc=${`전산에만 있는 ${n(rec.erpOnly.length)}줄을 날짜·설비·재공품 유형으로 묶음 · 면포(반출)·계근량·폐기량·작업시간은 비워 두고 나중에 충진/포장 실적의 배치 수정에서 입력`}
      actions=${html`<button class="btn primary sm" disabled=${!state.canWrite || drafting || !draftPlan.drafts.length} onClick=${createDrafts}><${Icon} name="check" />임시 충진 실적 저장 (${n(draftPlan.drafts.length)}건)</button>`}>
      <div class="chips">${draftPlan.drafts.map((d) => html`<span key=${d.batch.id} class="chip" title=${d.rows.map((r) => `${shortName(r.productName)} ${r.lot} ${n(r.goodEa)}`).join('\n')}>${d.batch.batchNo} <b>${n(d.batch.goodEa)}</b> ea · ${d.rows.length}줄${d.batch.erpSpan ? html`<span class="muted" style="margin-left:4px">전산 ${d.batch.erpSpan}</span>` : ''}</span>`)}
        ${draftPlan.skipped.map((s, i) => html`<span key=${'s' + i} class="chip bad" title=${s.why}>${fillerOf(state, s.fillerId).name} ${s.mixType || '(유형 없음)'} ${s.rows.length}줄 건너뜀 · ${s.why}</span>`)}</div>
    <//>`}
    ${rec.hasErp && html`<${Card} title="설비별 요약" flush
      actions=${html`<button class="btn primary" disabled=${!state.canWrite || rec.total.erpDefect === rec.total.appDefect} onClick=${applyDefects} title="전산 불량수량을 맞춰진 포장 내역이 속한 충진 배치의 불량(ea)에 합산해 저장"><${Icon} name="check" />불량 전산대로 반영</button>`}>
      <${DataTable} rows=${rec.byFiller} keyFn=${(x) => x.fillerId} rowClass=${(x) => x.bad || x.appGood !== x.erpGood ? 'row-bad' : ''} cols=${[
        { key: 'filler', label: '설비', render: (x) => html`<b>${x.filler}</b>`, sub: (x) => `배치 ${n(x.batches)}건 · 줄 ${n(x.lines)}`, total: () => '합계' },
        { key: 'good', label: '양품 (앱 / 전산)', num: true, render: (x) => html`${n(x.appGood)} / ${n(x.erpGood)}`, sub: (x) => x.appGood === x.erpGood ? '' : `차이 ${x.appGood - x.erpGood > 0 ? '+' : ''}${n(x.appGood - x.erpGood)}`, total: (t) => `${n(t.appGood)} / ${n(t.erpGood)}` },
        { key: 'defect', label: '불량 (앱 / 전산)', num: true, render: (x) => html`${n(x.appDefect)} / ${n(x.erpDefect)}`, sub: (x) => x.appDefect === x.erpDefect ? '' : `차이 ${x.appDefect - x.erpDefect > 0 ? '+' : ''}${n(x.appDefect - x.erpDefect)}`, total: (t) => `${n(t.appDefect)} / ${n(t.erpDefect)}` },
        { key: 'run', label: '작업시간 분 (앱 / 전산)', num: true, render: (x) => html`${n(x.appRunMin)} / ${n(x.erpRunMin)}`, total: (t) => `${n(t.appRunMin)} / ${n(t.erpRunMin)}` },
        { key: 'st', label: '상태', render: (x) => x.bad === 0 && x.appGood === x.erpGood ? html`<${Chip} tone="good" dot>일치<//>` : html`<${Chip} tone="bad" dot>다른 줄 ${n(x.bad)}건<//>`, total: (t) => t.bad ? `확인 ${n(t.bad)}건` : '전부 일치' },
      ]} total=${{ appGood: rec.total.appGood, erpGood: rec.total.erpGood, appDefect: rec.total.appDefect, erpDefect: rec.total.erpDefect, appRunMin: sum(rec.byFiller, (x) => x.appRunMin), erpRunMin: sum(rec.byFiller, (x) => x.erpRunMin), bad: rec.total.bad }} />
    <//>`}
  `;
}
