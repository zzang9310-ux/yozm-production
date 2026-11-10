// 출고현황 (생산실적 분석 하위 메뉴): 전산 "출하현황" 엑셀을 올리면 달별로 요약 저장 → 매출·거래처·품목·채널·신선도·무상 출고를 전월과 비교
import { html, useState, useMemo, Card, Chip, Icon, Empty, Field, Stat, DonutChart, exportCSV, toast, confirmAsync, saveFile } from '../ui.js';
import { save, remove } from '../store.js';
import { parseShipXlsx, decodeMonth } from '../shipdata.js';
import { n, addMonths, ymLabel, monthRange, weeksOfMonth, parseISO, HOLIDAYS, buildPdf, fmtDate, today } from '../util.js';

/** 일별 매출 막대 + 출고 EA 꺾은선(오른쪽 축, 위쪽 띠) · 막대 위 금액(백만원)·점 위 EA(천) · 일평균 점선(전월 일평균도) · 토(파랑)/일·공휴일(빨강) · 마우스를 올리면 EA·kg */
function DailyBars({ ym, A, P, pName }) {
  const [tip, setTip] = useState(null);
  const [sel, setSel] = useState(null); // 누른 날 (그날 판매 제품 목록)
  const [selAll, setSelAll] = useState(false);
  const { to } = monthRange(ym); const last = Number(to.slice(8));
  const days = Array.from({ length: last }, (_, k) => {
    const iso = `${ym}-${String(k + 1).padStart(2, '0')}`; const d = A.byDay.get(k + 1); const w = parseISO(iso).getDay();
    return { day: k + 1, iso, w, off: w === 0 || HOLIDAYS.has(iso), sat: w === 6, sales: d ? d.sales : 0, ea: d ? d.ea : 0, kg: d ? d.kg : 0 };
  });
  // 한 영역에 매출 막대(왼쪽 축)와 출고 EA 꺾은선(오른쪽 축)을 겹침. 눈금선은 같이 씀(양쪽 축 칸 수를 맞춤)
  // EA 축은 위로 한 칸 여유를 둬(범위를 넓게) 선이 막대 끝에 붙지 않게 함. 막대 금액은 막대 안쪽 위(흰 글씨), EA 숫자는 점 위
  const W = 1000, H = 330, padL = 46, padR = 58, padT = 30, padB = 44;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxV = Math.max(1, ...days.map((d) => d.sales / 1e6));
  const step = [10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => maxV / s <= 4) || 1000;
  const k = Math.ceil(maxV / step); // 칸 수
  const top = k * step;
  const y = (v) => padT + ih - (v / top) * ih;
  const slot = iw / last; const bw = Math.min(28, slot * 0.68);
  const x = (i) => padL + slot * i + slot / 2;
  const avg = A.perDay / 1e6; const pAvg = P && P.perDay ? P.perDay / 1e6 : null;
  const maxDay = days.reduce((m, d) => (d.sales > m.sales ? d : m), days[0]);
  const ticks = Array.from({ length: k + 1 }, (_, i) => i * step);
  const DOW = '일월화수목금토';
  const eaVals = days.filter((d) => d.ea > 0).map((d) => d.ea);
  const eMax = eaVals.length ? Math.max(...eaVals) : 1;
  const eStep = [5000, 10000, 20000, 25000, 50000, 100000].find((s) => (eMax * 1.25) / s <= k) || 100000;
  const eTop = k * eStep;
  const ye = (v) => padT + ih - (v / eTop) * ih;
  const path = days.map((d, i) => (d.ea > 0 ? `${i === 0 || days[i - 1].ea <= 0 ? 'M' : 'L'}${x(i)},${ye(d.ea)}` : '')).join(' ');
  return html`<div class="chart-wrap">
    <div class="legend"><span><i style="background:var(--s1)"></i>그날 매출 (백만원 · 왼쪽 축 · 막대 안 숫자)</span><span><i style="background:var(--s2);height:3px;vertical-align:3px"></i>출고 EA (천 개 · 오른쪽 축 · 점 위 숫자)</span><span><i style="background:var(--fg-2);height:2px;vertical-align:3px"></i>매출 출고일 평균</span>${pAvg != null && html`<span><i style="background:var(--muted);height:2px;vertical-align:3px"></i>${pName} 평균</span>`}<span class="muted">토 <b style="color:var(--info)">파랑</b> · 일·공휴일 <b style="color:var(--bad)">빨강</b></span></div>
    <svg class="chart ship-daily" viewBox="0 0 ${W} ${H}" onMouseLeave=${() => setTip(null)}>
      <g class="grid">${ticks.map((t) => html`<line key=${t} x1=${padL} x2=${W - padR} y1=${y(t)} y2=${y(t)} />`)}</g>
      <g class="axis">${ticks.map((t) => html`<text key=${t} x=${padL - 8} y=${y(t) + 4} text-anchor="end">${n(t)}</text>`)}<text x=${padL - 8} y=${padT - 14} text-anchor="end">백만원</text></g>
      ${eaVals.length > 0 && html`<g class="ship-ea">${ticks.map((t, j) => html`<text key=${'et' + j} class="ax" x=${W - padR + 8} y=${y(t) + 4}>${n((j * eStep) / 1000)}</text>`)}<text class="ax" x=${W - padR + 8} y=${padT - 14}>천 EA</text></g>`}
      ${days.map((d, i) => d.sales > 0 && html`<rect key=${'b' + i} class=${`bar ${d === maxDay ? 'hl' : ''} ${sel === d.day ? 'sel' : ''}`} x=${x(i) - bw / 2} y=${y(d.sales / 1e6)} width=${bw} height=${Math.max(1, padT + ih - y(d.sales / 1e6))} rx="3" />`)}
      ${pAvg != null && html`<line class="ship-avg prev" x1=${padL} x2=${W - padR} y1=${y(pAvg)} y2=${y(pAvg)} /><text class="ship-avg-t prev" x=${W - padR - 2} y=${y(pAvg) + (pAvg > avg ? -5 : 14)} text-anchor="end">${pName} 평균 ${n(pAvg)}</text>`}
      <line class="ship-avg" x1=${padL} x2=${W - padR} y1=${y(avg)} y2=${y(avg)} /><text class="ship-avg-t" x=${W - padR - 2} y=${y(avg) + (pAvg != null && pAvg > avg ? 14 : -5)} text-anchor="end">평균 ${n(avg)}</text>
      ${days.map((d, i) => { if (!(d.sales > 0)) return null; const h = padT + ih - y(d.sales / 1e6); const inside = h >= 20; return html`<text key=${'v' + i} class=${`ship-bv ${inside ? 'in' : ''}`} x=${x(i)} y=${inside ? y(d.sales / 1e6) + 14 : y(d.sales / 1e6) - 5} text-anchor="middle">${n(d.sales / 1e6)}</text>`; })}
      ${eaVals.length > 0 && html`<g class="ship-ea">
        <path class="ln" d=${path} />
        ${days.map((d, i) => d.ea > 0 && html`<circle key=${'ep' + i} class="pt" cx=${x(i)} cy=${ye(d.ea)} r="3.4" />`)}
        ${days.map((d, i) => d.ea > 0 && html`<text key=${'ev' + i} class="pv" x=${x(i)} y=${ye(d.ea) - 8} text-anchor="middle">${n(d.ea / 1000)}</text>`)}
      </g>`}
      <g class="axis">${days.map((d, i) => html`<text key=${'d' + i} x=${x(i)} y=${padT + ih + 17} text-anchor="middle" class=${d.off ? 'off' : d.sat ? 'sat' : ''}>${d.day}</text><text key=${'w' + i} x=${x(i)} y=${padT + ih + 32} text-anchor="middle" class=${`dw ${d.off ? 'off' : d.sat ? 'sat' : ''}`}>${DOW[d.w]}</text>`)}</g>
      ${days.map((d, i) => html`<rect key=${'h' + i} class=${d.sales > 0 ? 'ship-hit' : ''} x=${padL + slot * i} y=${padT} width=${slot} height=${ih + 36} fill="transparent" onMouseEnter=${() => setTip({ i, x: x(i) / W * 100, y: y(d.sales / 1e6) / H * 100 })} onClick=${() => { if (d.sales > 0) { setSel(sel === d.day ? null : d.day); setSelAll(false); } }} />`)}
    </svg>
    ${tip && (() => { const d = days[tip.i]; return html`<div class="chart-tip" style=${`left:${tip.x}%;top:${tip.y}%`}><b>${Number(ym.slice(5))}/${d.day}(${DOW[d.w]})</b><br/>${d.sales ? html`매출 ${won(d.sales)}원<br/>출고 ${n(d.ea)} EA · ${n(d.kg)} kg<br/><span style="opacity:.75">${sel === d.day ? '누르면 목록 닫기' : '누르면 그날 판매 제품'}</span>` : '출고 없음'}</div>`; })()}
    ${!sel && html`<div class="note ship-tap-note" style="margin-top:4px">막대를 누르면 그날 판매된 제품 목록이 아래에 나옵니다.</div>`}
    ${sel && (() => {
      const d = days[sel - 1]; const list = [...(A.dayItems.get(sel) || new Map()).values()].sort((a, b) => b.sales - a.sales);
      const shown = selAll ? list : list.slice(0, 15);
      return html`<div class="ship-day">
        <div class="ship-day-h"><b>${Number(ym.slice(5))}/${d.day}(${DOW[d.w]}) 판매 제품</b><span class="muted">${list.length}종 · 매출 ${won(d.sales)}원 · ${n(d.ea)} EA</span><span class="spacer"></span><button class="btn sm ghost" onClick=${() => setSel(null)}><${Icon} name="x" />닫기</button></div>
        <div class="table-wrap"><table class="tbl compact"><thead><tr><th>품목</th><th>품목군</th><th class="num">판매 EA</th><th class="num">매출 (백만원)</th><th class="num">비중</th><th>거래처 (EA)</th></tr></thead><tbody>
          ${shown.map((it) => { const cs = [...it.custs.entries()].sort((a, b) => b[1] - a[1]); return html`<tr key=${it.code}><td><b>${it.n}</b></td><td class="muted">${it.grp}</td><td class="num">${n(it.ea)}</td><td class="num">${n(it.sales / 1e6, 1)}</td><td class="num">${n(d.sales ? (it.sales / d.sales) * 100 : 0, 1)}%</td><td class="muted ship-day-c">${cs.slice(0, 4).map(([c, ea]) => `${c} ${n(ea)}`).join(' · ')}${cs.length > 4 ? ` 외 ${cs.length - 4}곳` : ''}</td></tr>`; })}
        </tbody></table></div>
        ${list.length > 15 && html`<div style="padding:6px 2px"><button class="linkish" onClick=${() => setSelAll(!selAll)}>${selAll ? '상위 15종만 보기' : `나머지 ${list.length - 15}종 펼치기`}</button></div>`}
      </div>`;
    })()}
  </div>`;
}

/** 주차별 합계 + 전월 대비 누적 진도 */
function WeekStrip({ ym, A, P, pName }) {
  const { to } = monthRange(ym);
  const weeks = weeksOfMonth(ym).map((w) => {
    const from = w.from < `${ym}-01` ? `${ym}-01` : w.from; const end = w.to > to ? to : w.to;
    let sales = 0, ea = 0, days = 0;
    for (let d = Number(from.slice(8)); d <= Number(end.slice(8)); d++) { const x = A.byDay.get(d); if (x && x.sales > 0) { sales += x.sales; ea += x.ea; days++; } }
    return { n: w.n, from, end, sales, ea, days };
  });
  const maxS = Math.max(1, ...weeks.map((w) => w.sales));
  let cross = null;
  if (P && P.sales > 0) { let acc = 0; for (let d = 1; d <= Number(to.slice(8)); d++) { const x = A.byDay.get(d); acc += x ? x.sales : 0; if (acc >= P.sales) { cross = d; break; } } }
  const prog = P && P.sales > 0 ? (A.sales / P.sales) * 100 : null;
  const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8))}`;
  return html`<div class="ship-weeks">${weeks.map((w) => html`<div key=${w.n} class="ship-week">
      <div class="h">${w.n}주차 <span class="muted">${md(w.from)}~${md(w.end)}</span></div>
      <div class="v">${won(w.sales)}<small>원</small></div>
      <div class="bar"><i style=${`width:${(w.sales / maxS) * 100}%`}></i></div>
      <div class="s">${n(w.ea)} EA · 출고일 ${w.days}일 · 비중 ${n(A.sales ? (w.sales / A.sales) * 100 : 0, 1)}%</div>
    </div>`)}</div>
    ${prog != null && html`<div class="ship-prog">
      <div class="row" style="justify-content:space-between"><span><b>${pName} 매출 대비</b> ${won(A.sales)}원 / ${won(P.sales)}원</span><b class=${prog >= 100 ? 'up' : 'down'}>${n(prog, 1)}%</b></div>
      <div class="bar"><i style=${`width:${Math.min(100, prog)}%`}></i>${prog > 100 && html`<i class="over" style=${`width:${Math.min(100, prog - 100)}%`}></i>`}</div>
      <div class="note">${cross ? `${Number(ym.slice(5))}/${cross}에 ${pName} 한 달 매출을 넘어섰습니다.` : `${pName} 한 달 매출까지 ${won(P.sales - A.sales)}원 남았습니다.`}</div>
    </div>`}`;
}

const won = (v) => { const a = Math.abs(v); if (a >= 1e8) return `${n(v / 1e8, 2)}억`; if (a >= 1e4) return `${n(v / 1e4, 0)}만`; return n(v); };
const mil = (v) => n(v / 1e6, 1); // 백만원
const rate = (c, p) => (p ? ((c - p) / Math.abs(p)) * 100 : null);
const sign = (v, d = 1) => (v == null ? '' : `${v > 0 ? '+' : ''}${n(v, d)}`);
/** 증감 칩: 늘면 초록, 줄면 빨강 (reverse면 반대: 반품·무상 출고) */
function Delta({ c, p, reverse, unit = '%', small }) {
  if (p == null) return html`<span class="muted" style="font-size:12px">—</span>`;
  if (!p && !c) return html`<span class="muted" style="font-size:12px">—</span>`;
  if (!p) return html`<${Chip} tone=${reverse ? 'bad' : 'good'}>신규<//>`;
  const r = rate(c, p); const up = r > 0.05, down = r < -0.05;
  const tone = !up && !down ? '' : (up !== !!reverse ? 'good' : 'bad');
  return html`<${Chip} tone=${tone}>${small ? '' : up ? '▲ ' : down ? '▼ ' : ''}${sign(r)}${unit}<//>`;
}
const FRESH = [
  { k: '3일 이하', test: (d) => d <= 3, color: 'var(--bad)' },
  { k: '4~6일', test: (d) => d >= 4 && d <= 6, color: 'var(--warn)' },
  { k: '7~9일', test: (d) => d >= 7 && d <= 9, color: '#94a3b8' },
  { k: '10~12일', test: (d) => d >= 10 && d <= 12, color: 'color-mix(in srgb, var(--good) 55%, #ffffff)' },
  { k: '13일 이상', test: (d) => d >= 13, color: 'var(--good)' },
];

// 전산 품목군(영문) → 화면 표시용 한글. 표에 없는 값은 그대로
const GRP_KO = { Plain: '플레인', Soft: '소프트', Compote: '콩포트(토핑결합)', Flavored: '플레이버', Drinking: '드링크', 'Ice Cream': '아이스크림', Others: '기타', 기타: '기타' };
const grpKo = (g) => GRP_KO[String(g || '').trim()] || String(g || '').trim() || '기타';

/** 한 달 요약 계산 */
function summarize(dm) {
  if (!dm) return null;
  const custs = dm.custs, items = dm.items, reps = dm.reps || [];
  const T = { sales: 0, saleEa: 0, saleKg: 0, saleSales: 0, freeEa: 0, freeKg: 0, retEa: 0, retSales: 0, lines: 0 };
  const byCust = new Map(), byItem = new Map(), byGrp = new Map(), byCh = new Map(), byRep = new Map(), byDay = new Map(), custItem = new Map(), freeBy = new Map(), dayItems = new Map();
  const add = (map, key, mk) => { let o = map.get(key); if (!o) { o = mk(); map.set(key, o); } return o; };
  const blank = () => ({ sales: 0, ea: 0, kg: 0, free: 0, ret: 0, lines: 0 });
  const days = new Set(), activeCust = new Set(), activeItem = new Set();
  for (const r of dm.f) {
    const cu = custs[r.c] || { n: '?' }, it = items[r.i] || { n: '?', grp: '기타' }, rep = reps[r.p] || '(없음)';
    T.lines += r.lines;
    if (r.t === 1) { T.freeEa += r.ea; T.freeKg += r.kg; const o = add(freeBy, cu.n, () => ({ n: cu.n, internal: cu.internal, ea: 0, kg: 0, items: new Map() })); o.ea += r.ea; o.kg += r.kg; o.items.set(it.n, (o.items.get(it.n) || 0) + r.ea); }
    if (r.t === 2) { T.retEa += r.ea; T.retSales += r.sales; }
    if (r.t === 0) { T.saleEa += r.ea; T.saleKg += r.kg; T.saleSales += r.sales; days.add(r.day); if (!cu.internal) activeCust.add(r.c); activeItem.add(r.i); }
    T.sales += r.sales;
    const put = (o) => { o.sales += r.sales; if (r.t === 0) { o.ea += r.ea; o.kg += r.kg; } if (r.t === 1) o.free += r.ea; if (r.t === 2) o.ret += r.ea; o.lines += r.lines; };
    put(add(byCust, cu.n, () => ({ ...blank(), key: cu.n, n: cu.n, ch: cu.ch, sub: cu.sub, internal: cu.internal, items: new Set() }))); byCust.get(cu.n).items.add(it.code);
    put(add(byItem, it.code, () => ({ ...blank(), key: it.code, n: it.n, grp: grpKo(it.grp), mid: it.mid, kind: it.kind, custs: new Set() }))); if (r.t === 0) byItem.get(it.code).custs.add(cu.n);
    put(add(byGrp, it.grp || '기타', () => ({ ...blank(), key: it.grp || '기타', n: grpKo(it.grp) })));
    put(add(byCh, cu.ch || '기타', () => ({ ...blank(), key: cu.ch || '기타', n: cu.ch || '기타' })));
    put(add(byRep, rep, () => ({ ...blank(), key: rep, n: rep, custs: new Set() }))); if (r.t === 0 && !cu.internal) byRep.get(rep).custs.add(cu.n);
    put(add(byDay, r.day, () => ({ ...blank(), key: r.day, day: r.day })));
    if (r.t === 0) { // 그날 판매 제품 목록 (막대를 누르면 표시)
      const dm = add(dayItems, r.day, () => new Map());
      const o = add(dm, it.code, () => ({ code: it.code, n: it.n, grp: grpKo(it.grp), ea: 0, kg: 0, sales: 0, custs: new Map() }));
      o.ea += r.ea; o.kg += r.kg; o.sales += r.sales; o.custs.set(cu.n, (o.custs.get(cu.n) || 0) + r.ea);
    }
    put(add(custItem, `${cu.n}|${it.code}`, () => ({ ...blank(), cust: cu.n, code: it.code, n: it.n, grp: grpKo(it.grp) })));
  }
  // 신선도: 출고 시점 남은 소비기한 (EA 가중)
  const freshCust = new Map(); const freshAll = FRESH.map(() => 0); let fEa = 0, fSum = 0; const freshItem = new Map();
  for (const x of dm.fresh) {
    const cu = custs[x.c] || { n: '?' }; const it = items[x.i] || { n: '?' };
    const b = FRESH.findIndex((f) => f.test(x.left));
    const o = add(freshCust, cu.n, () => ({ n: cu.n, ea: 0, sum: 0, min: Infinity, buckets: FRESH.map(() => 0) }));
    o.ea += x.ea; o.sum += x.left * x.ea; if (x.ea > 0) o.min = Math.min(o.min, x.left); if (b >= 0) o.buckets[b] += x.ea;
    const oi = add(freshItem, it.code, () => ({ n: it.n, ea: 0, sum: 0 })); oi.ea += x.ea; oi.sum += x.left * x.ea;
    if (b >= 0) freshAll[b] += x.ea; fEa += x.ea; fSum += x.left * x.ea;
  }
  return { ...T, days: days.size, custCount: activeCust.size, itemCount: activeItem.size, avgPrice: T.saleEa > 0 ? T.saleSales / T.saleEa : null, perDay: days.size ? T.sales / days.size : 0,
    byCust, byItem, byGrp, byCh, byRep, byDay, custItem, freeBy, dayItems, freshCust, freshItem, freshAll, freshAvg: fEa > 0 ? fSum / fEa : null, freshEa: fEa };
}

export function ShipPage({ state, go }) {
  const docs = (state.shipments || []).filter((d) => d.kind === 'month');
  const months = [...new Set(docs.map((d) => d.ym))].sort().reverse();
  const [ym, setYm] = useState(months[0] || '');
  const cur = months.includes(ym) ? ym : months[0] || '';
  const prevYm = cur ? addMonths(cur, -1) : '';
  const curDoc = docs.find((d) => d.ym === cur); const prevDoc = docs.find((d) => d.ym === prevYm);
  const A = useMemo(() => summarize(decodeMonth(curDoc)), [curDoc]);
  const P = useMemo(() => summarize(decodeMonth(prevDoc)), [prevDoc]);
  const [busy, setBusy] = useState(false);
  const [openCust, setOpenCust] = useState(null);
  const [openItem, setOpenItem] = useState(null);
  const [allItems, setAllItems] = useState(false);
  const [allCust, setAllCust] = useState(false);
  // 무상 출고·반품은 기본 숨김, 필터 줄의 버튼으로 열고 닫음 (이 브라우저에 기억)
  const [showFree, setShowFreeRaw] = useState(() => { try { return localStorage.getItem('yozm-ship-free') === '1'; } catch { return false; } });
  const setShowFree = (v) => { setShowFreeRaw(v); try { localStorage.setItem('yozm-ship-free', v ? '1' : '0'); } catch { /* 저장 불가 환경 */ } };

  const upload = async (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const out = await parseShipXlsx(await file.arrayBuffer(), file.name);
      const mdocs = out.filter((d) => d.kind === 'month');
      const exist = mdocs.filter((d) => docs.some((x) => x.id === d.id));
      const summary = mdocs.map((d) => `${ymLabel(d.ym)} ${n(d.rows)}줄 (${d.from.slice(5).replace('-', '/')}~${d.to.slice(5).replace('-', '/')})`).join('\n');
      if (exist.length && !(await confirmAsync(`${summary}\n\n${exist.map((d) => ymLabel(d.ym)).join(', ')} 출고현황이 이미 있습니다. 새 파일 내용으로 바꿀까요?`, { ok: '바꾸기', danger: true }))) { setBusy(false); return; }
      for (const d of out) { await save('shipments', d); if (d.kind === 'lots') await save('shiplots', d); } // v316: LOT별 출고처는 모두 읽는 사본도 (매출 없음)
      setYm(mdocs[mdocs.length - 1].ym);
      toast(`출고현황을 저장했습니다. ${mdocs.map((d) => `${ymLabel(d.ym)} ${n(d.rows)}줄`).join(' · ')}`);
    } catch (ex) { toast(ex.message || String(ex), 'bad'); }
    setBusy(false);
  };
  const delMonth = async () => {
    if (!cur || !(await confirmAsync(`${ymLabel(cur)} 출고현황을 삭제할까요? 같은 파일을 다시 올리면 되살릴 수 있습니다.`))) return;
    await remove('shipments', cur); await remove('shipments', `${cur}-lots`); await remove('shiplots', `${cur}-lots`); toast(`${ymLabel(cur)} 출고현황을 삭제했습니다.`);
  };
  const doCSV = () => {
    if (!A) return;
    const rows = [...A.custItem.values()].sort((a, b) => b.sales - a.sales).map((r) => [cur, r.cust, r.n, r.code, r.grp, Math.round(r.ea), Math.round(r.kg), Math.round(r.sales), Math.round(r.free), Math.round(r.ret)]);
    exportCSV(`출고현황_${cur}.csv`, ['월', '거래처', '품목명', '품목코드', '품목군', '판매 EA', '판매 kg', '매출(공급가)', '무상 EA', '반품 EA'], rows);
  };

  // v302 PDF 저장: 생산실적 분석과 같은 방식 — 화면을 3장(요약·일별 / 거래처 / 채널·품목)으로 나눠 html2canvas로 찍어 A4 세로 PDF 한 파일로
  const [shooting, setShooting] = useState(false);
  const shotIds = ['sh-shot-1', 'sh-shot-2', 'sh-shot-3'];
  const savePdf = async () => {
    if (shooting || !A) return;
    setShooting(true);
    try {
      const mod = await import('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.esm.js');
      const h2c = mod.default || window.html2canvas;
      await new Promise((r) => setTimeout(r, 80)); // 캡처용 머리글이 그려질 시간
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
      if (images.length && await saveFile(`출고현황_${cur}.pdf`, buildPdf(images))) toast(`PDF ${images.length}페이지를 저장했습니다.`);
    } catch (e) { toast(`PDF 저장 실패: ${e.message || e}`, 'bad'); }
    setShooting(false);
  };
  const shotHead = (i) => shooting ? html`<div class="shot-head"><b>${ymLabel(cur)} 출고현황</b><span>${state.settings.companyName || ''} · ${i}/${shotIds.length} · ${fmtDate(today())} 출력</span></div>` : '';
  const shotCls = `shot-page ${shooting ? 'shooting' : ''}`;

  const head = html`<div class="page-head"><div><div class="eyebrow">Shipments</div><h1>출고현황</h1></div>
    <div class="actions">
      ${A && html`<button class="btn primary" disabled=${shooting} onClick=${savePdf} title="화면을 A4 세로 3페이지 PDF 한 파일로 저장 (인쇄용)"><${Icon} name="download" />${shooting ? 'PDF 만드는 중…' : 'PDF 저장 (3장)'}</button>`}
      <label class=${`btn primary ${!state.canWrite || busy ? 'disabled' : ''}`} title="전산 → 출하현황 엑셀(한 달 또는 여러 달)을 올리면 달별로 요약해 저장합니다">
        <${Icon} name="upload" />${busy ? '읽는 중…' : '출하현황 엑셀 올리기'}
        <input type="file" accept=".xlsx,.xls" style="display:none" disabled=${!state.canWrite || busy} onChange=${upload} />
      </label>
      ${A && html`<button class="btn" onClick=${doCSV}><${Icon} name="download" />CSV</button>`}
      ${A && state.canWrite && html`<button class="btn ghost" onClick=${delMonth} title="이 달 출고현황 삭제"><${Icon} name="x" />이 달 삭제</button>`}
    </div></div>`;

  if (!A) return html`${head}<${Card}><${Empty} title="아직 올린 출고현황이 없습니다">전산에서 <b>출하현황</b> 엑셀을 내려받아 위 <b>출하현황 엑셀 올리기</b>를 누르세요. 달별로 요약해 저장하고, 전월 파일도 올리면 증감이 함께 보입니다.<//><//>`;

  const pName = ymLabel(prevYm).replace(/^\d+년 /, '');
  const cName = ymLabel(cur).replace(/^\d+년 /, '');
  const has = !!P;
  const pv = (k) => (P ? P[k] : null);
  const totalOut = A.saleEa + A.freeEa;

  // 주목할 변화 (전월 대비 매출 증감)
  const changes = (curMap, prevMap, min = 0) => {
    const keys = new Set([...curMap.keys(), ...prevMap.keys()]);
    const list = [...keys].map((k) => { const c = curMap.get(k), p = prevMap.get(k); return { k, n: (c || p).n, c: c ? c.sales : 0, p: p ? p.sales : 0, internal: (c || p).internal }; }).filter((x) => !x.internal && (Math.abs(x.c) >= min || Math.abs(x.p) >= min));
    list.forEach((x) => { x.d = x.c - x.p; });
    return { up: list.filter((x) => x.d > 0).sort((a, b) => b.d - a.d).slice(0, 5), down: list.filter((x) => x.d < 0).sort((a, b) => a.d - b.d).slice(0, 5) };
  };
  const chC = has ? changes(A.byCust, P.byCust) : null;
  const chI = has ? changes(A.byItem, P.byItem) : null;
  const newCust = has ? [...A.byCust.values()].filter((x) => !x.internal && x.sales > 0 && !P.byCust.has(x.key)).map((x) => x.n) : [];
  const lostCust = has ? [...P.byCust.values()].filter((x) => !x.internal && x.sales > 0 && !A.byCust.has(x.key)).map((x) => x.n) : [];
  const ChangeList = ({ title, rows, tone }) => html`<div class="ship-chg"><div class="ship-chg-h">${title}</div>${rows.length ? rows.map((x) => html`<div key=${x.k} class="ship-chg-r"><span class="nm" title=${x.n}>${x.n}</span><b class=${tone}>${x.d > 0 ? '+' : ''}${won(x.d)}</b><span class="muted">${x.p ? sign(rate(x.c, x.p), 0) + '%' : '신규'}</span></div>`) : html`<div class="muted" style="font-size:12.5px">없음</div>`}</div>`;

  // 거래처 표
  const custRows = [...A.byCust.values()].filter((x) => !x.internal).sort((a, b) => b.sales - a.sales);
  const custShown = allCust ? custRows : custRows.slice(0, 15);
  const itemRows = [...A.byItem.values()].sort((a, b) => b.sales - a.sales);
  const itemShown = allItems ? itemRows : itemRows.slice(0, 10);
  const custItems = (cname) => [...A.custItem.values()].filter((x) => x.cust === cname).sort((a, b) => b.sales - a.sales || b.ea - a.ea);
  const itemCusts = (code) => [...A.custItem.values()].filter((x) => x.code === code).sort((a, b) => b.ea - a.ea);
  const prevCI = (cname, code) => (has ? P.custItem.get(`${cname}|${code}`) : null);

  const freeRows = [...A.freeBy.values()].sort((a, b) => b.ea - a.ea);
  const repRows = [...A.byRep.values()].filter((x) => x.sales !== 0).sort((a, b) => b.sales - a.sales);

  return html`${head}
    <${Card}>
      <div class="filters">
        <${Field} label="월"><div class="row" style="flex-wrap:nowrap">
          <button class="btn sm" aria-label="이전 달" disabled=${months.indexOf(cur) >= months.length - 1} onClick=${() => setYm(months[months.indexOf(cur) + 1])}><${Icon} name="left" /></button>
          <select class="input" style="width:150px" value=${cur} onChange=${(e) => setYm(e.target.value)}>${months.map((m) => html`<option key=${m} value=${m}>${ymLabel(m)}</option>`)}</select>
          <button class="btn sm" aria-label="다음 달" disabled=${months.indexOf(cur) <= 0} onClick=${() => setYm(months[months.indexOf(cur) - 1])}><${Icon} name="right" /></button></div><//>
        <${Field} label="표시"><button class=${`btn ${showFree ? 'primary' : ''}`} aria-pressed=${showFree} onClick=${() => setShowFree(!showFree)} title="공급가 0원 출고(폐기·CS·샘플·광고 등)와 반품"><${Icon} name="eye" />무상 출고 · 반품 ${showFree ? '숨기기' : '보기'}</button><//>
        <div class="spacer"></div>
        <div class="note" style="align-self:center">${curDoc.file || '출하현황'} · ${n(curDoc.rows)}줄 · ${curDoc.from.replace(/-/g, '.')}~${curDoc.to.slice(5).replace('-', '.')} · 비교: ${has ? html`<b>${pName}</b>` : html`<span class="chip warn">${pName} 자료 없음</span>`}</div>
      </div>
    <//>

    <div id="sh-shot-1" class=${shotCls}>
    ${shotHead(1)}
    <div class="stats">
      <${Stat} hero k="매출액 (공급가)" v=${won(A.sales)} unit="원" s=${html`${has ? html`<${Delta} c=${A.sales} p=${P.sales} /> ${pName} ${won(P.sales)}원` : '반품 차감 · 부가세 제외'}`} />
      <${Stat} k="판매 출고량" v=${n(A.saleEa)} unit="EA" s=${html`${n(A.saleKg)} kg ${has ? html`· <${Delta} c=${A.saleEa} p=${P.saleEa} />` : ''}`} />
      <${Stat} k="출고일 평균 매출" v=${won(A.perDay)} unit="원" s=${html`출고일 ${A.days}일 ${has ? html`· <${Delta} c=${A.perDay} p=${P.perDay} />` : ''}`} />
      <${Stat} k="평균 판매단가" v=${n(A.avgPrice)} unit="원/EA" s=${html`${has ? html`<${Delta} c=${A.avgPrice} p=${P.avgPrice} /> ${pName} ${n(P.avgPrice)}원` : '판매 출고 기준 (무상·반품 제외)'}`} />
      <${Stat} k="거래처 · 품목" v=${`${A.custCount}곳 · ${A.itemCount}종`} s=${has ? `${pName} ${P.custCount}곳 · ${P.itemCount}종` : '판매 출고가 있는 거래처·품목'} />
      ${showFree && html`<${Stat} k="무상 출고 · 반품" v=${n(A.freeEa)} unit="EA" s=${html`전체 출고의 ${n(totalOut ? (A.freeEa / totalOut) * 100 : 0, 1)}% · 반품 ${n(-A.retEa)} EA (${won(-A.retSales)}원)${has ? html` · <${Delta} c=${A.freeEa} p=${P.freeEa} reverse />` : ''}`} />`}
    </div>

    ${has ? html`<${Card} title=${`${pName} 대비 주목할 변화`} desc="매출(공급가) 증감이 큰 거래처·품목">
        <div class="ship-chgs">
          <${ChangeList} title="▲ 매출이 늘어난 거래처" rows=${chC.up} tone="up" />
          <${ChangeList} title="▼ 매출이 줄어든 거래처" rows=${chC.down} tone="down" />
          <${ChangeList} title="▲ 매출이 늘어난 품목" rows=${chI.up} tone="up" />
          <${ChangeList} title="▼ 매출이 줄어든 품목" rows=${chI.down} tone="down" />
        </div>
        ${(newCust.length > 0 || lostCust.length > 0) && html`<div class="note" style="margin-top:10px">${newCust.length ? html`신규 거래처: <b>${newCust.join(', ')}</b>` : ''}${newCust.length && lostCust.length ? ' · ' : ''}${lostCust.length ? html`이번 달 출고 없음: <b>${lostCust.join(', ')}</b>` : ''}</div>`}
      <//>`
    : html`<div class="banner info"><${Icon} name="alert" /><span>${pName} 출하현황을 올리면 전월 대비 증감, 늘어난·줄어든 거래처와 품목이 함께 표시됩니다.</span></div>`}

    <${Card} title="일별 매출" desc="막대에 마우스를 올리면 그날 출고 EA·kg">
      <${DailyBars} ym=${cur} A=${A} P=${P} pName=${pName} />
      <${WeekStrip} ym=${cur} A=${A} P=${P} pName=${pName} />
    <//>
    </div>

    <div id="sh-shot-2" class=${shotCls}>
    ${shotHead(2)}
    <${Card} title="거래처별 매출" count=${custRows.length} desc="집계 거래처 기준 · 줄을 누르면 품목별 내역" flush>
      <div class="table-wrap"><table class="tbl ship-tbl">
        <thead><tr><th>거래처</th><th>채널</th><th class="num">매출 (백만원)</th><th class="num">비중</th>${has && html`<th class="num">${pName} (백만원)</th><th class="num">증감</th>`}<th class="num">판매 EA</th><th class="num">평균단가</th><th class="num">품목 수</th></tr></thead>
        <tbody>${custShown.map((x) => { const p = has ? P.byCust.get(x.key) : null; const open = openCust === x.key; return html`
          <tr key=${x.key} class=${`clickable ${open ? 'open' : ''}`} onClick=${() => setOpenCust(open ? null : x.key)}>
            <td><b>${x.n}</b></td><td><span class="muted">${x.ch}${x.sub ? ` · ${x.sub}` : ''}</span></td>
            <td class="num"><b>${mil(x.sales)}</b></td><td class="num">${n(A.sales ? (x.sales / A.sales) * 100 : 0, 1)}%</td>
            ${has && html`<td class="num">${p ? mil(p.sales) : '—'}</td><td class="num"><${Delta} c=${x.sales} p=${p ? p.sales : 0} /></td>`}
            <td class="num">${n(x.ea)}</td><td class="num">${x.ea > 0 ? n(x.sales / x.ea) : '—'}</td><td class="num">${x.items.size}</td>
          </tr>
          ${open && html`<tr key=${x.key + '-d'} class="ship-sub"><td colspan=${has ? 9 : 7}><table class="tbl compact"><thead><tr><th>품목</th><th>품목군</th><th class="num">판매 EA</th><th class="num">매출 (백만원)</th>${has && html`<th class="num">${pName} EA</th><th class="num">EA 증감</th>`}<th class="num">무상 EA</th></tr></thead><tbody>
            ${custItems(x.key).map((ci) => { const pc = prevCI(x.key, ci.code); return html`<tr key=${ci.code}><td>${ci.n}</td><td class="muted">${ci.grp}</td><td class="num">${n(ci.ea)}</td><td class="num">${mil(ci.sales)}</td>${has && html`<td class="num">${pc ? n(pc.ea) : '—'}</td><td class="num"><${Delta} c=${ci.ea} p=${pc ? pc.ea : 0} /></td>`}<td class="num">${ci.free ? n(ci.free) : ''}</td></tr>`; })}
          </tbody></table></td></tr>`}`; })}
        </tbody></table></div>
      ${custRows.length > 15 && !shooting && html`<div style="padding:8px 14px"><button class="linkish" onClick=${() => setAllCust(!allCust)}>${allCust ? '상위 15곳만 보기' : `거래처 ${custRows.length}곳 모두 보기`}</button></div>`}
    <//>
    </div>

    <div id="sh-shot-3" class=${shotCls}>
    ${shotHead(3)}
    <div class="grid2" style="align-items:start">
      <${Card} title="채널별 매출" desc="채널구분 기준 · 공급가">
        <${DonutChart} data=${[...A.byCh.values()].filter((x) => x.sales > 0).sort((a, b) => b.sales - a.sales).map((x) => ({ label: x.n, value: x.sales / 1e6 }))} unit="백만" digits=${0} centerLabel="매출" />
        ${has && html`<div class="ship-mini">${[...A.byCh.values()].filter((x) => x.sales > 0).sort((a, b) => b.sales - a.sales).map((x) => { const p = P.byCh.get(x.key); return html`<span key=${x.key}>${x.n} <${Delta} c=${x.sales} p=${p ? p.sales : 0} small /></span>`; })}</div>`}
      <//>
      <${Card} title="품목군별 매출" desc="품목군 기준 · 공급가">
        <${DonutChart} data=${[...A.byGrp.values()].filter((x) => x.sales > 0).sort((a, b) => b.sales - a.sales).map((x) => ({ label: x.n, value: x.sales / 1e6 }))} unit="백만" digits=${0} centerLabel="매출" />
        ${has && html`<div class="ship-mini">${[...A.byGrp.values()].filter((x) => x.sales > 0).sort((a, b) => b.sales - a.sales).map((x) => { const p = P.byGrp.get(x.key); return html`<span key=${x.key}>${x.n} <${Delta} c=${x.sales} p=${p ? p.sales : 0} small /></span>`; })}</div>`}
      <//>
    </div>

    <${Card} title="품목별 출고" count=${itemRows.length} desc="매출 순 · 줄을 누르면 거래처별 내역" flush>
      <div class="table-wrap"><table class="tbl ship-tbl">
        <thead><tr><th>품목</th><th>품목군</th><th class="num">판매 EA</th>${has && html`<th class="num">EA 증감</th>`}<th class="num">매출 (백만원)</th>${has && html`<th class="num">매출 증감</th>`}<th class="num">평균단가</th><th class="num">거래처</th></tr></thead>
        <tbody>${itemShown.map((x) => { const p = has ? P.byItem.get(x.key) : null; const open = openItem === x.key; return html`
          <tr key=${x.key} class=${`clickable ${open ? 'open' : ''}`} onClick=${() => setOpenItem(open ? null : x.key)}>
            <td><b>${x.n}</b><span class="sub">${x.key}</span></td><td class="muted">${x.grp}${x.mid && x.mid !== x.grp ? ` · ${x.mid}` : ''}</td>
            <td class="num"><b>${n(x.ea)}</b></td>${has && html`<td class="num"><${Delta} c=${x.ea} p=${p ? p.ea : 0} /></td>`}
            <td class="num">${mil(x.sales)}</td>${has && html`<td class="num"><${Delta} c=${x.sales} p=${p ? p.sales : 0} /></td>`}
            <td class="num">${x.ea > 0 ? n(x.sales / x.ea) : '—'}</td><td class="num">${x.custs.size}</td>
          </tr>
          ${open && html`<tr key=${x.key + '-d'} class="ship-sub"><td colspan=${has ? 8 : 6}><table class="tbl compact"><thead><tr><th>거래처</th><th class="num">판매 EA</th><th class="num">비중</th><th class="num">매출 (백만원)</th>${has && html`<th class="num">${pName} EA</th><th class="num">EA 증감</th>`}</tr></thead><tbody>
            ${itemCusts(x.key).map((ci) => { const pc = prevCI(ci.cust, x.key); return html`<tr key=${ci.cust}><td>${ci.cust}${ci.free && !ci.ea ? html` <span class="chip warn">무상 ${n(ci.free)}</span>` : ''}</td><td class="num">${n(ci.ea)}</td><td class="num">${x.ea ? n((ci.ea / x.ea) * 100, 1) + '%' : ''}</td><td class="num">${mil(ci.sales)}</td>${has && html`<td class="num">${pc ? n(pc.ea) : '—'}</td><td class="num"><${Delta} c=${ci.ea} p=${pc ? pc.ea : 0} /></td>`}</tr>`; })}
          </tbody></table></td></tr>`}`; })}
        </tbody></table></div>
      ${itemRows.length > 10 && !shooting && html`<div style="padding:8px 14px"><button class="linkish" onClick=${() => setAllItems(!allItems)}>${allItems ? '상위 10종만 보기' : `나머지 ${itemRows.length - 10}종 펼치기 (전체 ${itemRows.length}종)`}</button></div>`}
    <//>

    ${showFree && html`<${Card} title="무상 출고 · 반품" desc="공급가 0원 출고(폐기·CS·샘플·광고 등)와 반품" flush>
      <div class="table-wrap"><table class="tbl compact"><thead><tr><th>출고처</th><th class="num">EA</th><th class="num">kg</th><th>주요 품목</th></tr></thead><tbody>
        ${freeRows.map((x) => html`<tr key=${x.n}><td>${x.n}${x.internal ? '' : html` <span class="chip">거래처</span>`}</td><td class="num">${n(x.ea)}</td><td class="num">${n(x.kg)}</td><td class="muted">${[...x.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${n(v)}`).join(' · ')}</td></tr>`)}
        ${A.retEa < 0 && html`<tr><td><b>반품</b></td><td class="num">${n(A.retEa)}</td><td class="num"></td><td class="muted">금액 ${won(A.retSales)}원</td></tr>`}
      </tbody></table></div>
    <//>`}
    </div>`;
}
