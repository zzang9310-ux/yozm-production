// 배양 LOT 경과일 사용현황 (v301): 반출(유청분리실 → 충진)마다 배양 LOT 배출일(LOT 앞 6자리)부터 며칠 지나 썼는지 주차별로 집계
// 색은 LOT 추적·클레임 LOT·자사검사와 같음: 2일 이하 초록 · 3일 파랑 · 4일 이상 빨강
import { html, useState, useMemo, Card, Stat, DataTable, Icon, exportCSV, saveFile, toast } from '../ui.js';
import { clothAgeDays, lotOutDate, fillerOf, tankOf, CLOTH_AGE_LIMIT, allPacks, allBatches, productOf, lot7 } from '../model.js';
import { parseExpiry, lotExpiry } from './claim.js';
import { n, fmtMD, fmtDate, today, addDays, weekRange, weeksOfMonth, monthRange, addMonths, buildPdf } from '../util.js';

const BANDS = [
  { key: 'fresh', label: '2일 이하', color: 'var(--good)', cls: 'lot-fresh', test: (d) => d <= 2 },
  { key: 'mid', label: '3일', color: 'var(--info)', cls: 'lot-mid', test: (d) => d === 3 },
  { key: 'old', label: `${CLOTH_AGE_LIMIT}일 이상`, color: 'var(--bad)', cls: 'lot-old', test: (d) => d >= CLOTH_AGE_LIMIT },
];
const bandOf = (d) => BANDS.find((b) => b.test(d));
// 주차 이름: 그 주 토요일이 속한 달의 N주차 (일~토, 생산실적 분석과 같은 규칙) → 9/27~10/3 = 10월 1주차
const weekName = (from) => { const to = addDays(from, 6); const ym = to.slice(0, 7); const w = weeksOfMonth(ym).find((x) => x.from === from); return `${Number(ym.slice(5))}월 ${w ? w.n : '?'}주차`; };
const pct = (a, b) => b ? `${(a / b * 100).toFixed(1)}%` : '—';
const kgTxt = (v) => `${n(Math.round(v))}kg`;

/** v343 소비기한으로 찾기: 그 소비기한 제품(제품 LOT)마다 들어간 배양 LOT와 반출 때 경과일(2일 이하 · 3일 · 4일 이상) */
function ExpirySearch({ state, go }) {
  const [q, setQ] = useState('');
  const [exp, setExp] = useState('');
  const run = () => { const e = parseExpiry(q.trim()); setExp(e || (q.trim() ? 'bad' : '')); };
  const res = useMemo(() => {
    if (!exp || exp === 'bad') return null;
    const batchById = new Map(allBatches(state).map((b) => [b.id, b]));
    const moveById = new Map(state.separations.filter((s) => s.kind === 'move').map((s) => [s.id, s]));
    const cultureById = new Map(state.cultures.map((c) => [c.id, c]));
    const packs = allPacks(state).filter((p) => p.kind !== 'repack' && (p.expiry || lotExpiry(p.productLot)) === exp);
    const groups = new Map(); const used = new Map(); let noLink = 0;
    for (const p of packs) {
      const b = batchById.get(p.batchId); const srcs = ((b && b.sources) || []).filter((s) => s.kind !== 'drink');
      if (!srcs.length) { noLink++; continue; }
      const plot = lot7(p.productLot); const prod = productOf(state, p.productCode); const pname = String(prod ? prod.name : p.productName || p.productCode || '').replace(/^충진[-_]\s*/, '');
      srcs.forEach((s, si) => {
        const c = cultureById.get(s.cultureId); if (!c) return;
        const mv = s.moveId ? moveById.get(s.moveId) : null; const press = !!(mv && mv.source === 'press');
        const md = (mv && mv.date) || b.date; const age = clothAgeDays(c.lot, md, press);
        const cl = Number(s.cloths) || (mv ? Number(mv.cloths) || 0 : 0);
        const k = `${plot}|${c.id}|${press ? 'p' : 'r'}`;
        const g = groups.get(k) || { id: k, plot, products: new Set(), fills: new Set(), c, tank: tankOf(state, c.tankId).name, out: lotOutDate(c.lot), moves: new Set(), age: null, press, cloths: 0, seen: new Set() };
        g.products.add(pname); g.fills.add(`${b.date}|${(b.fillerName || fillerOf(state, b.fillerId).name)}`); g.moves.add(md);
        if (age != null && (g.age == null || age > g.age)) g.age = age;
        const uk = `${b.id}|${si}`; if (!g.seen.has(uk)) { g.seen.add(uk); g.cloths += cl; }
        groups.set(k, g);
        if (!used.has(uk)) used.set(uk, { age, cloths: cl });
      });
    }
    const rows = [...groups.values()].sort((a, b) => a.plot.localeCompare(b.plot) || (b.age ?? -1) - (a.age ?? -1) || a.c.lot.localeCompare(b.c.lot));
    const tot = [...used.values()].reduce((a, u) => a + u.cloths, 0);
    const byBand = BANDS.map((bd) => ({ ...bd, cloths: [...used.values()].filter((u) => u.age != null && bd.test(u.age)).reduce((a, u) => a + u.cloths, 0) }));
    return { rows, tot, byBand, plots: new Set(rows.map((r) => r.plot)).size, packs: packs.length, noLink };
  }, [state, exp]);
  // v344 PDF 저장: 이 카드(검색 결과)만 A4 세로로. 표 줄 경계에서 페이지를 나눔
  const [shooting, setShooting] = useState(false);
  const savePdf = async () => {
    if (shooting || !res) return;
    setShooting(true);
    try {
      const mod = await import('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.esm.js');
      const h2c = mod.default || window.html2canvas;
      await new Promise((r) => setTimeout(r, 150));
      const el = document.getElementById('ca-exp-shot'); if (!el) throw new Error('화면을 찾지 못했습니다');
      const bg = getComputedStyle(document.body).backgroundColor;
      el.style.width = '1040px'; void el.offsetWidth; await new Promise((r) => setTimeout(r, 40));
      const top = el.getBoundingClientRect().top; const cuts = new Set();
      for (const c of el.querySelectorAll(':scope > *, tr, .filters')) { const b = Math.round(c.getBoundingClientRect().bottom - top); if (b > 0) cuts.add(b); }
      const SCALE = 2; let canvas;
      try { canvas = await h2c(el, { scale: SCALE, backgroundColor: bg, useCORS: true, logging: false }); } finally { el.style.width = ''; }
      if (!canvas || !canvas.width) throw new Error('화면을 그리지 못했습니다');
      const pageH = Math.floor(canvas.width * (774 / 555)); const cutPx = [...cuts].map((v) => v * SCALE).sort((a, b) => a - b);
      const images = []; let y = 0;
      while (y < canvas.height - 4) {
        let end = Math.min(canvas.height, y + pageH);
        if (end < canvas.height) { const c = cutPx.filter((v) => v > y + pageH * 0.4 && v <= end); if (c.length) end = c[c.length - 1]; }
        const pc = document.createElement('canvas'); pc.width = canvas.width; pc.height = end - y;
        const g = pc.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, pc.width, pc.height); g.drawImage(canvas, 0, y, canvas.width, end - y, 0, 0, canvas.width, end - y);
        const blob = await new Promise((r) => pc.toBlob(r, 'image/jpeg', 0.92)); if (!blob) throw new Error('이미지를 만들지 못했습니다');
        images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: pc.width, h: pc.height }); y = end;
      }
      if (images.length && await saveFile(`반제경과_소비기한_${exp}.pdf`, buildPdf(images))) toast(`PDF ${images.length}페이지를 저장했습니다.`);
    } catch (e) { toast(`PDF 저장 실패: ${e.message || e}`, 'bad'); }
    setShooting(false);
  };
  return html`<div id="ca-exp-shot" class=${`shot-page ${shooting ? 'shooting' : ''}`}>
    ${shooting && html`<div class="shot-head"><b>소비기한 ${fmtDate(exp)} 제품의 반제 경과</b><span>${state.settings.companyName} · ${fmtDate(today())} 출력</span></div>`}
    <${Card} title="소비기한으로 찾기" desc=${shooting ? '그 소비기한 제품에 들어간 배양 LOT와 반출 때 경과일 (2일 이하 초록 · 3일 파랑 · 4일 이상 빨강)' : '소비기한(예: 26.10.30)을 넣으면 그 소비기한 제품에 들어간 배양 LOT와 반출 때 경과일을 보여 줍니다'} flush
      actions=${res && res.rows.length && !shooting ? html`<button class="btn sm" onClick=${savePdf}><${Icon} name="download" />PDF 저장</button>` : ''}>
    <div class="filters" style="padding:12px 14px;gap:8px;align-items:center">
      ${!shooting && html`<input class="input" style="width:170px" placeholder="소비기한 26.10.30" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && run()} />
      <button class="btn sm primary" onClick=${run}><${Icon} name="search" />찾기</button>
      ${exp && html`<button class="btn sm ghost" onClick=${() => { setQ(''); setExp(''); }}><${Icon} name="x" />지우기</button>`}`}
      ${exp === 'bad' && html`<span class="muted" style="font-size:12.5px">날짜를 읽지 못했습니다 (예: 26.10.30 · 2026-10-30)</span>`}
      ${res && html`<span style="font-size:13px">소비기한 <b>${fmtDate(exp)}</b> · 제품 LOT ${n(res.plots)}개 · 반제 ${n(Math.round(res.tot))}포</span>
        ${res.byBand.map((b) => html`<span key=${b.key} class="chip" style="gap:4px"><span class=${b.cls} style="font-weight:700">${b.label}</span> ${n(Math.round(b.cloths))}포 · ${pct(b.cloths, res.tot)}</span>`)}`}
    </div>
    ${res && (res.rows.length ? html`<${DataTable} rows=${res.rows} keyFn=${(r) => r.id} cols=${[
      { key: 'plot', label: '제품 LOT', render: (r) => html`<b>${r.plot}</b>`, sub: (r) => [...r.products].join(' · ') },
      { key: 'fill', label: '충진', render: (r) => [...r.fills].sort().map((f) => { const [d, fl] = f.split('|'); return html`<div key=${f} style="white-space:nowrap">${fmtDate(d)} <span class="muted">${fl}</span></div>`; }) },
      { key: 'lot', label: '배양 LOT', render: (r) => html`<button class=${`linkish ${r.age != null ? bandOf(r.age).cls : ''}`} style="font-weight:700" onClick=${() => go('trace', { cultureId: r.c.id })}>${r.c.lot}</button>${r.press ? html` <span class="chip accent">FP</span>` : ''}`, sub: (r) => r.tank },
      { key: 'out', label: '배출일', render: (r) => r.out ? fmtDate(r.out) : '—' },
      { key: 'mv', label: '반출일', render: (r) => [...r.moves].sort().map((d) => fmtDate(d)).join(', ') },
      { key: 'age', label: '경과', num: true, render: (r) => r.age == null ? '—' : html`<b class=${bandOf(r.age).cls}>${r.age}일</b>`, sub: (r) => r.age == null ? '' : bandOf(r.age).label },
      { key: 'cl', label: '포', num: true, render: (r) => `${n(Math.round(r.cloths * 10) / 10)}포` },
    ]} />` : html`<div class="empty">소비기한 ${fmtDate(exp)} 제품에 배양 LOT가 연결된 충진 기록이 없습니다.</div>`)}
    ${res && res.noLink > 0 && html`<div class="note" style="padding:8px 14px">배양 LOT가 연결 안 된 포장 내역 ${n(res.noLink)}건(전산 백데이터 등)은 뺐습니다</div>`}
  <//></div>`;
}

export function ClothAgePage({ state, go }) {
  // 기본 기간: 지난주(끝난 주)까지 6주 — 11/9 기준이면 10월 1주차(9/27) ~ 11월 1주차(11/7)
  // v303: 기간은 날짜로 (시작일 ~ 종료일). 주차별 표는 그 기간이 걸친 주(일~토)마다, 주 안에서도 기간 안의 날만 셈
  const lastFrom = addDays(weekRange(today()).from, -7);
  const [fromRaw, setFrom] = useState(addDays(lastFrom, -35));
  const [toRaw, setTo] = useState(addDays(lastFrom, 6));
  const [showAll, setShowAll] = useState(false);
  const from = fromRaw <= toRaw ? fromRaw : toRaw, to = fromRaw <= toRaw ? toRaw : fromRaw;

  const data = useMemo(() => {
    const cul = new Map(state.cultures.map((c) => [c.id, c]));
    const moves = [];
    for (const m of state.separations) {
      if (m.kind !== 'move' || !m.date || m.date < from || m.date > to) continue;
      const c = cul.get(m.cultureId); if (!c) continue;
      const d = clothAgeDays(c.lot, m.date, m.source === 'press'); if (d == null) continue; // v336: FP +1일
      moves.push({ m, c, d, band: bandOf(d), wk: weekRange(m.date).from, cloths: Number(m.cloths) || 0, kg: Number(m.kg) || 0 });
    }
    const weeks = []; for (let w = weekRange(from).from; w <= to; w = addDays(w, 7)) weeks.push(w);
    const sum = (list) => ({ n: list.length, cloths: list.reduce((s, x) => s + x.cloths, 0), kg: list.reduce((s, x) => s + x.kg, 0) });
    const rowOf = (list) => ({ all: sum(list), ...Object.fromEntries(BANDS.map((b) => [b.key, sum(list.filter((x) => x.band === b))])), oldLots: new Set(list.filter((x) => x.band.key === 'old').map((x) => x.c.id)).size });
    const byWeek = weeks.map((w) => ({ id: w, from: w < from ? from : w, to: addDays(w, 6) > to ? to : addDays(w, 6), name: weekName(w), ...rowOf(moves.filter((x) => x.wk === w)) }));
    // 4일 이상 반출: 같은 날·같은 배양 LOT·같은 설비·같은 유형은 한 줄로 합침
    const g = new Map();
    for (const x of moves.filter((x) => x.band.key === 'old')) {
      const k = `${x.m.date}|${x.c.id}|${x.m.fillerId || ''}|${x.m.mixType || ''}`;
      const e = g.get(k) || { id: k, date: x.m.date, c: x.c, d: x.d, filler: fillerOf(state, x.m.fillerId).name, mix: x.m.mixType || '', press: x.m.source === 'press', cloths: 0, kg: 0, n: 0 };
      e.cloths += x.cloths; e.kg += x.kg; e.n++; g.set(k, e);
    }
    const old = [...g.values()].sort((a, b) => b.date.localeCompare(a.date) || b.d - a.d || a.c.lot.localeCompare(b.c.lot));
    // 설비별 4일 이상
    const fm = new Map();
    for (const x of moves) { const f = fillerOf(state, x.m.fillerId).name; const e = fm.get(f) || { id: f, name: f, list: [] }; e.list.push(x); fm.set(f, e); }
    const byFiller = [...fm.values()].map((e) => ({ id: e.id, name: e.name, ...rowOf(e.list) })).sort((a, b) => b.old.cloths - a.old.cloths || b.all.cloths - a.all.cloths);
    const maxD = moves.reduce((s, x) => Math.max(s, x.d), 0);
    return { total: rowOf(moves), byWeek, old, byFiller, maxD };
  }, [state, from, to]);

  const T = data.total;
  const bar = (r) => r.all.cloths ? html`<div style="display:flex;height:10px;border-radius:4px;overflow:hidden;gap:2px;min-width:120px" title=${BANDS.map((b) => `${b.label} ${pct(r[b.key].cloths, r.all.cloths)}`).join(' · ')}>
    ${BANDS.map((b) => r[b.key].cloths ? html`<span key=${b.key} style=${`flex:${r[b.key].cloths};background:${b.color}`}></span>` : '')}</div>` : html`<span class="muted">—</span>`;
  const bandCell = (b, r) => r[b.key].cloths ? html`<b class=${b.key === 'old' ? b.cls : ''}>${n(r[b.key].cloths)}</b><span class="muted">포</span><span class="sub">${pct(r[b.key].cloths, r.all.cloths)} · ${kgTxt(r[b.key].kg)}</span>` : html`<span class="muted">0</span>`;
  const allCell = (r) => html`<b>${n(r.all.cloths)}</b><span class="muted">포</span><span class="sub">${n(r.all.n)}건 · ${kgTxt(r.all.kg)}</span>`;
  const lotsCell = (r) => r.oldLots ? html`<b class="lot-old">${n(r.oldLots)}</b>개` : html`<span class="muted">0</span>`;
  // 합계 줄도 같은 칸 모양으로 (DataTable은 total이 있으면 c.total(total)을 부름)
  const sumCols = (first) => [first,
    { key: 'all', label: '반출 합계', num: true, render: allCell, total: allCell },
    ...BANDS.map((b) => ({ key: b.key, label: html`<span class=${b.cls} style="font-weight:700">${b.label}</span>`, num: true, render: (r) => bandCell(b, r), total: (r) => bandCell(b, r) })),
    { key: 'bar', label: '비율', render: bar, total: bar },
    { key: 'lots', label: `${CLOTH_AGE_LIMIT}일 이상 배양 LOT`, num: true, render: lotsCell, total: lotsCell },
  ];
  const oldShown = showAll ? data.old : data.old.slice(0, 15);
  const csv = () => exportCSV(`배양LOT_경과일_${from}_${to}.csv`, ['반출일', '배양 LOT', '탱크', '배출일', '경과일', '충진 설비', '유형', '면포/필터프레스', '포', 'kg'],
    data.old.map((r) => [r.date, r.c.lot, tankOf(state, r.c.tankId).name, lotOutDate(r.c.lot), r.d, r.filler, r.mix, r.press ? '필터프레스' : '면포', r.cloths, Math.round(r.kg * 10) / 10]));
  // v303 PDF 저장 (생산실적 분석·출고현황과 같은 방식): 1장 = 요약·주차별·설비별, 2장부터 = 4일 이상 반출 내역 (한 장에 30줄씩)
  const [shooting, setShooting] = useState(false);
  const OLD_PER_PAGE = 30;
  const oldPages = []; for (let i = 0; i < data.old.length; i += OLD_PER_PAGE) oldPages.push(data.old.slice(i, i + OLD_PER_PAGE));
  const shotIds = ['ca-shot-1', ...oldPages.map((_, i) => `ca-shot-old-${i}`)];
  const savePdf = async () => {
    if (shooting) return;
    setShooting(true);
    try {
      const mod = await import('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.esm.js');
      const h2c = mod.default || window.html2canvas;
      await new Promise((r) => setTimeout(r, 120)); // 캡처용 페이지가 그려질 시간
      const bg = getComputedStyle(document.body).backgroundColor;
      const images = [];
      for (const [i, id] of shotIds.entries()) {
        const el = document.getElementById(id); if (!el) continue;
        el.style.width = '1040px'; void el.offsetWidth;
        const need = Math.max(1040, ...[...el.querySelectorAll('.table-wrap')].map((w) => w.scrollWidth + 34));
        el.style.width = `${Math.min(need, 2400)}px`; void el.offsetWidth;
        await new Promise((r) => setTimeout(r, 30));
        let canvas;
        try { canvas = await h2c(el, { scale: 2, backgroundColor: bg, useCORS: true, logging: false }); } finally { el.style.width = ''; }
        if (!canvas || !canvas.width || canvas.width * canvas.height > 250e6) throw new Error(`${i + 1}장 크기가 너무 큽니다`);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
        if (!blob) throw new Error(`${i + 1}장 이미지를 만들지 못했습니다`);
        images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height });
      }
      if (images.length && await saveFile(`반제사용현황_${from}_${to}.pdf`, buildPdf(images))) toast(`PDF ${images.length}페이지를 저장했습니다.`);
    } catch (e) { toast(`PDF 저장 실패: ${e.message || e}`, 'bad'); }
    setShooting(false);
  };
  const shotHead = (i) => shooting ? html`<div class="shot-head"><b>반제 사용 현황 · ${fmtDate(from)} ~ ${fmtDate(to)}</b><span>${state.settings.companyName || ''} · ${i}/${shotIds.length} · ${fmtDate(today())} 출력</span></div>` : '';
  const shotCls = `shot-page ${shooting ? 'shooting' : ''}`;
  const oldCols = [
    { key: 'date', label: '반출일', render: (r) => html`<span style="white-space:nowrap">${fmtDate(r.date)}</span>`, sub: (r) => weekName(weekRange(r.date).from) },
    { key: 'lot', label: '배양 LOT', render: (r) => html`<button class="linkish lot-old" style="font-weight:700" onClick=${() => go('trace', { cultureId: r.c.id })}>${r.c.lot}</button>`, sub: (r) => tankOf(state, r.c.tankId).name },
    { key: 'out', label: '배출일', render: (r) => fmtDate(lotOutDate(r.c.lot)) },
    { key: 'd', label: '경과일', num: true, render: (r) => html`<b class="lot-old">${r.d}일</b>` },
    { key: 'filler', label: '충진 설비', render: (r) => r.filler, sub: (r) => r.mix },
    { key: 'src', label: '구분', render: (r) => r.press ? html`<span class="chip accent">필터프레스</span>` : html`<span class="chip sky">면포</span>` },
    { key: 'cloths', label: '포', num: true, render: (r) => html`<b>${n(r.cloths)}</b>`, sub: (r) => r.n > 1 ? `${n(r.n)}건 합침` : '' },
    { key: 'kg', label: 'kg', num: true, render: (r) => n(Math.round(r.kg)) },
  ];
  // 빠른 선택: 지난주까지 6주 · 지난달 · 이번 달
  const thisM = today().slice(0, 7); const prevM = monthRange(addMonths(thisM, -1));
  const quick = [
    { label: '최근 6주', f: addDays(lastFrom, -35), t: addDays(lastFrom, 6) },
    { label: '지난달', f: prevM.from, t: prevM.to },
    { label: '이번 달', f: `${thisM}-01`, t: today() },
  ];

  return html`
    <div class="page-head"><div><div class="eyebrow">반제품 현황</div><h1>반제 사용 현황</h1><div class="muted" style="font-size:13px;margin-top:4px">배양 LOT가 배출된 뒤 며칠 지나 충진으로 반출됐는지 (2일 이하 초록 · 3일 파랑 · ${CLOTH_AGE_LIMIT}일 이상 빨강)</div></div>
      <div class="actions"><button class="btn primary" disabled=${shooting} onClick=${savePdf} title=${`A4 세로 ${shotIds.length}페이지 PDF 한 파일로 저장 (인쇄용)`}><${Icon} name="download" />${shooting ? 'PDF 만드는 중…' : `PDF 저장 (${shotIds.length}장)`}</button><button class="btn" onClick=${csv} disabled=${!data.old.length}><${Icon} name="download" />${CLOTH_AGE_LIMIT}일 이상 CSV</button></div></div>

    <${Card}>
      <div class="filters" style="align-items:flex-end;gap:10px">
        <div class="field" style="min-width:0"><label>기간 (반출일)</label>
          <div class="row" style="flex-wrap:nowrap;gap:6px"><input type="date" class="input" style="width:160px" value=${fromRaw} max=${toRaw} onChange=${(e) => e.target.value && setFrom(e.target.value)} /><span>~</span><input type="date" class="input" style="width:160px" value=${toRaw} min=${fromRaw} onChange=${(e) => e.target.value && setTo(e.target.value)} /></div></div>
        <div class="row" style="gap:6px">${quick.map((q) => html`<button key=${q.label} class=${`btn sm ${from === q.f && to === q.t ? 'primary' : ''}`} onClick=${() => { setFrom(q.f); setTo(q.t); }}>${q.label}</button>`)}</div>
        <span class="muted" style="font-size:12.5px;align-self:center">${fmtDate(from)} ~ ${fmtDate(to)} · 경과일 = 반출일 − 배출일(LOT 앞 6자리)</span>
      </div>
    <//>

    ${!shooting && html`<${ExpirySearch} state=${state} go=${go} />`}

    <div id="ca-shot-1" class=${shotCls}>
    ${shotHead(1)}
    <div class="stats">
      <${Stat} k="반출 합계" v=${n(T.all.cloths)} unit="포" s=${`${n(T.all.n)}건 · ${kgTxt(T.all.kg)}`} />
      ${BANDS.map((b) => html`<${Stat} key=${b.key} k=${html`<span class=${b.cls}>${b.label}</span>`} v=${n(T[b.key].cloths)} unit="포" s=${`${pct(T[b.key].cloths, T.all.cloths)} · ${kgTxt(T[b.key].kg)}`} />`)}
    </div>

    <${Card} title="주차별 사용현황" count=${data.byWeek.length} desc=${`주차는 일~토 · 포 수 기준 비율 · 작은 글씨 = 비율 · kg${data.maxD ? ` · 가장 오래된 반출 ${data.maxD}일` : ''}`} flush>
      <${DataTable} rows=${data.byWeek} total=${T} cols=${sumCols({ key: 'name', label: '주차', render: (r) => html`<b>${r.name}</b>`, sub: (r) => r.from === r.to ? fmtMD(r.from) : `${fmtMD(r.from)}~${fmtMD(r.to)}`, total: () => '합계' })} />
    <//>

    <${Card} title="충진 설비별" count=${data.byFiller.length} desc=${`${CLOTH_AGE_LIMIT}일 이상 포 수가 많은 설비부터`} flush>
      <${DataTable} rows=${data.byFiller} cols=${sumCols({ key: 'name', label: '충진 설비', render: (r) => html`<b>${r.name}</b>` })} />
    <//>
    </div>

    ${!shooting && html`<${Card} title=${`${CLOTH_AGE_LIMIT}일 이상 반출 내역`} count=${data.old.length} desc="같은 날·같은 배양 LOT·같은 설비·같은 유형은 한 줄로 합침 · 배양 LOT를 누르면 LOT 추적" flush>
      <${DataTable} rows=${oldShown} empty=${html`<div class="empty">이 기간에 ${CLOTH_AGE_LIMIT}일 이상 지난 배양 LOT 반출이 없습니다.</div>`} cols=${oldCols} />
      ${data.old.length > 15 && html`<div style="padding:10px 14px"><button class="btn sm" onClick=${() => setShowAll(!showAll)}>${showAll ? '15줄만 보기' : `나머지 ${n(data.old.length - 15)}줄 더 보기`}</button></div>`}
    <//>`}
    ${shooting && oldPages.map((rows, i) => html`<div key=${i} id=${`ca-shot-old-${i}`} class=${shotCls}>
      ${shotHead(i + 2)}
      <${Card} title=${`${CLOTH_AGE_LIMIT}일 이상 반출 내역${oldPages.length > 1 ? ` (${i + 1}/${oldPages.length})` : ''}`} count=${data.old.length} desc="같은 날·같은 배양 LOT·같은 설비·같은 유형은 한 줄로 합침" flush>
        <${DataTable} rows=${rows} cols=${oldCols} />
      <//>
    </div>`)}`;
}
