// 클레임/자사검사 현황 (v253 전 이름: 부적합 현황): 클레임 LOT · 자사검사에 저장한 목록(공유 저장소 claims, kind로 구분)을 모아 월별 통계를 보여줌
// 한 건 = 저장본의 한 줄(클레임/검사 한 건). 같은 줄이 여러 저장본에 들어 있으면 저장본마다 셈
import { html, useState, useMemo, Card, Stat, Icon, Empty, DataTable, Segmented, saveFile, toast } from '../ui.js';
import { traceClaims, parseExpiry, receiptOf, isReceipt, kindOf, NCR_KINDS, bufferLabel, spanText, TRACED_ST, parseCount, lotExpiry } from './claim.js';
import { lot7, lotOutDate, FP_AGE_EXTRA } from '../model.js';
import { shipmentsForLot } from '../shipdata.js';
import { n, pct, today, fmtDate, dow, buildPdf } from '../util.js';

const shortName = (s) => String(s || '').replace(/^충진[-_]\s*/, '');
// v314: '비교' 구분 삭제 (원인 분석에서 클레임 LOT × 자사검사를 함께 봄) — 기본은 원인 분석
const VIEW = [{ value: 'cause', label: '원인 분석' }, { value: 'claim', label: '클레임' }, { value: 'inspect', label: '자사검사' }];
const NO_MIX = '(충진 미연결)';
const NO_TYPE = '(내용 미기재)';
// 원인(유형) 열: 엑셀의 "클레임 내용" · "검사 내용" · 유형 · 원인 · 증상 · 사유 열
const isCause = (k) => /내용|유형|원인|증상|사유/.test(String(k || '')) && !isReceipt(k);
// 효모 구간: 자사검사(품질팀 검사표)처럼 내용 열이 없고 효모 수치만 있으면 이 구간을 원인 칸에 씀
// 사내 기준: 효모 50 이하 → 50 미만 / 50~99 / 100~499 / 500~999 / 1000 이상
const yeastBand = (y) => y >= 1000 ? '효모 1000 이상' : y >= 500 ? '효모 500~999' : y >= 100 ? '효모 100~499' : y >= 50 ? '효모 50~99' : '효모 50 미만';
const YEAST_LIMIT = 50;
// v299: 효모 값이 없고 "11월 7일 예정"처럼 예정일만 적힌 자사검사 = 결과 대기 (내용을 안 적은 게 아님)
const WAIT_TYPE = '결과 대기';
const isWaiting = (it) => it.yeast == null && it.mold == null && (it.extras || []).some(([k, v]) => /효모|곰팡이/.test(k) && /예정/.test(String(v || '')));
const causeOf = (it) => { const f = (it.extras || []).find(([k, v]) => isCause(k) && String(v || '').trim()); return f ? String(f[1]).trim() : it.yeast != null ? yeastBand(it.yeast) : isWaiting(it) ? WAIT_TYPE : NO_TYPE; };
const yTxt = (v) => v == null ? '—' : v === 0 ? '<10' : v >= 1000000 ? 'TNTC' : n(v); // TNTC = 셀 수 없이 많음 (claim.js TNTC_COUNT 1천만 · 중앙값이 TNTC와 섞여 백만 넘으면 TNTC로) // TNTC = 셀 수 없이 많음 (claim.js TNTC_COUNT)
const median = (a) => { const v = [...a].sort((x, y) => x - y); const k = v.length; return !k ? null : k % 2 ? v[(k - 1) / 2] : (v[k / 2 - 1] + v[k / 2]) / 2; };
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
// 효모 구간은 순서·색 고정: 50 미만(초록) → 50~99(연두) → 100~499(노랑) → 500~999(주황) → 1000 이상(빨강)
const BAND_ORDER = ['효모 50 미만', '효모 50~99', '효모 100~499', '효모 500~999', '효모 1000 이상'];
const BAND_COLOR = { '효모 50 미만': 'var(--good)', '효모 50~99': '#8fbf3a', '효모 100~499': 'var(--warn)', '효모 500~999': '#eb6834', '효모 1000 이상': 'var(--bad)' };
const colorOf = (c, ci) => BAND_COLOR[c] || COLORS[ci % COLORS.length];
const addMonth = (ym, d) => { const [y, m] = ym.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + d, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`; };
const ymLabel = (ym) => `${ym.slice(0, 4)}년 ${Number(ym.slice(5))}월`;

/** 재공품 유형별 누적 막대: x = 재공품 유형, 막대 안은 원인별로 쌓음 (스크린샷의 식품별 원인 현황과 같은 모양) */
function StackedBars({ mixes, causes, cell }) {
  const W = 460, H = 280, padL = 34, padB = 34, padT = 12, padR = 8;
  const totals = mixes.map((m) => causes.reduce((s, c) => s + cell(c, m), 0));
  const max = Math.max(1, ...totals);
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : max <= 100 ? 20 : Math.ceil(max / 5 / 10) * 10;
  const top = Math.ceil(max / step) * step;
  const ih = H - padT - padB, iw = W - padL - padR;
  const y = (v) => padT + ih - (v / top) * ih;
  const bw = Math.min(46, (iw / Math.max(1, mixes.length)) * 0.55);
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  return html`<div>
    <svg viewBox=${`0 0 ${W} ${H}`} width="100%" role="img" aria-label="재공품 유형별 원인 누적 막대" style="display:block;max-width:${W}px;margin:0 auto">
      ${ticks.map((v) => html`<g key=${v}><line x1=${padL} x2=${W - padR} y1=${y(v)} y2=${y(v)} stroke="var(--line)" stroke-width="1" /><text x=${padL - 6} y=${y(v) + 4} text-anchor="end" font-size="11" fill="var(--fg-2)">${v}</text></g>`)}
      ${mixes.map((m, i) => {
        const cx = padL + iw * (i + 0.5) / mixes.length; let acc = 0;
        return html`<g key=${m}>
          ${causes.map((c, ci) => { const v = cell(c, m); if (!v) return null; const y0 = y(acc), y1 = y(acc + v); acc += v; return html`<rect key=${c} x=${cx - bw / 2} y=${y1} width=${bw} height=${Math.max(0, y0 - y1 - 1)} fill=${colorOf(c, ci)}><title>${m} · ${c}: ${v}건</title></rect>`; })}
          ${totals[i] > 0 && html`<text x=${cx} y=${y(totals[i]) - 4} text-anchor="middle" font-size="11" font-weight="600" fill="var(--fg)">${totals[i]}</text>`}
          <text x=${cx} y=${H - padB + 16} text-anchor="middle" font-size="12" fill="var(--fg)">${m.length > 7 ? m.slice(0, 7) + '…' : m}</text>
        </g>`;
      })}
    </svg>
    <div style="display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:center;margin-top:6px;font-size:12px;color:var(--fg-2)">
      ${causes.map((c, ci) => html`<span key=${c} style="display:inline-flex;align-items:center;gap:5px"><span style=${`width:10px;height:10px;border-radius:2px;background:${colorOf(c, ci)}`}></span>${c}</span>`)}
    </div>
  </div>`;
}

/** 생산일(검사일자)별 효모 꺾은선: 가로 = 그 달의 날짜, 세로 = 그날 효모 중앙값(로그 눈금). 면포 = 파랑, 필터프레스 = 주황 (색만 다름)
 *  검사가 없는 날은 건너뛰고 앞뒤 날을 이음 */
const LINES = [{ key: '면포', color: 'var(--c1)' }, { key: '필터프레스', color: 'var(--c2)' }];
function YeastLines({ rows, ym }) {
  const W = 760, H = 270, padL = 44, padR = 12, padT = 16, padB = 30;
  const [y0, m0] = ym.split('-').map(Number); const days = new Date(Date.UTC(y0, m0, 0)).getUTCDate();
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = (d) => padL + (d - 0.5) / days * iw;
  const lo = Math.log10(50), hi = Math.log10(6000);
  const y = (v) => padT + ih - (Math.log10(Math.max(v, 50)) - lo) / (hi - lo) * ih;
  const series = LINES.map((s) => {
    const byDay = new Map();
    for (const r of rows) { if (r.src !== s.key || !r.date || !r.date.startsWith(ym)) continue; const d = +r.date.slice(8, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r.yeast); }
    const pts = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, ys]) => ({ d, med: median(ys), max: Math.max(...ys), n: ys.length }));
    return { ...s, pts };
  });
  const ticks = [100, 200, 500, 1000, 2000, 5000];
  const dTicks = []; for (let d = 1; d <= days; d += (days > 20 ? 3 : 1)) dTicks.push(d);
  return html`<div>
    <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--fg-2);margin-bottom:4px">
      ${series.map((s) => html`<span key=${s.key} style="display:inline-flex;align-items:center;gap:6px"><span style=${`width:16px;height:3px;border-radius:2px;background:${s.color}`}></span>${s.key} <span class="muted">(${n(s.pts.reduce((a, p) => a + p.n, 0))}건)</span></span>`)}
      <span>${'그날 효모 중앙값 · 세로 로그 눈금 · 점선 = 1000'}</span>
    </div>
    <svg viewBox=${`0 0 ${W} ${H}`} width="100%" role="img" aria-label="생산일별 효모 중앙값 꺾은선, 면포와 필터프레스 비교" style="display:block">
      ${ticks.map((v) => html`<g key=${v}><line x1=${padL} x2=${W - padR} y1=${y(v)} y2=${y(v)} stroke="var(--line)" stroke-width="1" stroke-dasharray=${v === 1000 ? '4 3' : ''} /><text x=${padL - 6} y=${y(v) + 4} text-anchor="end" font-size="11" fill="var(--fg-2)">${n(v)}</text></g>`)}
      ${dTicks.map((d) => html`<text key=${d} x=${x(d)} y=${H - padB + 16} text-anchor="middle" font-size="11" fill="var(--fg-2)">${m0}/${d}</text>`)}
      ${series.map((s) => html`<g key=${s.key}>
        ${s.pts.length > 1 && html`<polyline points=${s.pts.map((p) => `${x(p.d)},${y(p.med)}`).join(' ')} fill="none" stroke=${s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`}
        ${s.pts.map((p) => html`<circle key=${p.d} cx=${x(p.d)} cy=${y(p.med)} r="4" fill=${s.color} stroke="var(--surface)" stroke-width="1.5"><title>${m0}/${p.d} · ${s.key} · ${n(p.n)}건 · 중앙값 ${yTxt(p.med)} · 최대 ${yTxt(p.max)}</title></circle>`)}
      </g>`)}
    </svg>
  </div>`;
}

export function NcrPage({ state, go }) {
  const [view, setView] = useState('cause');

  // 저장본마다 추적을 돌려 한 줄씩 펼침: { kind, month, product, cause, mix, fillers: [{ name, press, cloth }], tanks[], traced }
  const rows = useMemo(() => {
    const out = [];
    for (const doc of state.claims || []) {
      const kind = kindOf(doc);
      const res = traceClaims(state, doc.items || [], doc.overrides || {});
      for (const r of res) {
        const d = parseExpiry(receiptOf(r)) || String(doc.savedAt || '').slice(0, 10);
        // 충진 설비별로 그 건이 필터프레스(FP) 면포를 썼는지 · 일반 면포를 썼는지
        const fm = new Map();
        for (const pk of r.packs) {
          if (!pk.filler || !pk.filler.name) continue;
          const f = fm.get(pk.filler.name) || { name: pk.filler.name, press: false, cloth: false };
          for (const x of pk.cultures) { if (x.kind === 'drink') continue; if (x.source === 'press') f.press = true; else f.cloth = true; }
          fm.set(pk.filler.name, f);
        }
        // 재공품 유형: 찾은 충진 배치의 유형 중 가장 많은 것 (한 건은 한 유형으로만 셈)
        const mc = new Map(); for (const pk of r.packs) { const m = pk.batch && pk.batch.mixType; if (m) mc.set(m, (mc.get(m) || 0) + 1); }
        const mix = mc.size ? [...mc.entries()].sort((a, b) => b[1] - a[1])[0][0] : NO_MIX;
        // 배양 LOT별로 그 건이 필터프레스 면포를 썼는지 · 일반 면포를 썼는지 (드링크 원액은 따로)
        const lm = new Map();
        for (const pk of r.packs) for (const x of pk.cultures) {
          const l = lm.get(x.c.id) || { id: x.c.id, lot: x.c.lot, tank: x.tank ? x.tank.name : '', press: false, cloth: false, drink: false, products: [], dates: [] };
          if (x.kind === 'drink') l.drink = true; else if (x.source === 'press') l.press = true; else l.cloth = true;
          // 그 LOT로 만든 클레임 제품의 품목명 · 충진일
          const pn = pk.product ? shortName(pk.product.name) : ''; if (pn && !l.products.includes(pn)) l.products.push(pn);
          // 충진일 + 호기 + 제품 LOT(소비기한)를 한 쌍으로 (같은 날 두 설비거나 소비기한이 둘이면 두 줄) — v254: 소비기한(제품 LOT) 칸 추가
          const fd = pk.batch ? pk.batch.date : pk.p.date; const fk = `${fd || ''}|${pk.filler ? pk.filler.name : ''}|${lot7(pk.p.productLot || '')}|${pk.p.expiry || ''}`; if (fd && !l.dates.includes(fk)) l.dates.push(fk);
          lm.set(x.c.id, l);
        }
        // 자사검사 엑셀 열: 면포/필터프레스(T열, 없으면 추적한 반출 출처), 라인(없으면 충진 설비), 구분(초·중·말)
        const ex = (k) => { const f = (r.it.extras || []).find(([h]) => h === k); return f ? String(f[1]).trim() : ''; };
        const lotsArr = [...lm.values()];
        const tSrc = ex('면포/필터프레스');
        const src = /필터|프레스|FP/i.test(tSrc) ? '필터프레스' : /면포/.test(tSrc) ? '면포' : lotsArr.some((l) => l.press) ? '필터프레스' : lotsArr.some((l) => l.cloth) ? '면포' : '(미확인)';
        const lineRaw = ex('라인');
        const line = lineRaw ? (/^\d+$/.test(lineRaw) ? `${lineRaw}호기` : lineRaw.replace(/로터리/, '로타리')) : (fm.size ? [...fm.keys()][0] : '(미확인)');
        const stage = ex('구분') || '(미기재)';
        // 버퍼(충진 배치): 클레임과 자사검사가 같은 버퍼로 추적됐는지 보려고 배치 id별로 모음
        const bufs = [];
        for (const pk of r.packs) for (const b of (pk.batches && pk.batches.length ? pk.batches : pk.batch ? [pk.batch] : [])) {
          if (!b || bufs.some((x) => x.id === b.id)) continue;
          bufs.push({ id: b.id, date: b.date, filler: pk.filler ? pk.filler.name : '', label: bufferLabel([b]) || b.batchNo || '', span: spanText([b]), lot: lot7(pk.p.productLot), product: pk.product ? shortName(pk.product.name) : '', rawLot: pk.p.productLot || '', code: pk.p.productCode || '',
            cultures: pk.cultures.filter((x) => x.kind !== 'drink').map((x) => ({ lot: x.c.lot, tank: x.tank ? x.tank.name : '', press: x.source === 'press' })) });
        }
        // v288: 이 검사·클레임의 제품 LOT (자기 LOT와 같은 포장 내역 우선) — 제품 LOT·품목별 효모 표용
        const plot = r.it.lot ? lot7(r.it.lot) : (r.packs[0] ? lot7(r.packs[0].p.productLot) : '');
        const ppk = r.packs.find((pk) => lot7(pk.p.productLot) === plot) || r.packs[0] || null;
        // v311 원인 분석: 이 건 제품 LOT에 들어간 배양 LOT의 배양일·배출일·충진일 (발효 → 배출 → 충진 흐름, 반제 경과일)
        const cul = [];
        for (const pk of r.packs) {
          if (plot && lot7(pk.p.productLot) !== plot) continue;
          const fill = pk.batch ? pk.batch.date : pk.p.date;
          for (const x of pk.cultures) { if (x.kind === 'drink') continue; cul.push({ lot: x.c.lot, tank: x.tank ? x.tank.name : '', press: x.source === 'press', brew: x.c.date || '', out: lotOutDate(x.c.lot) || '', fill: fill || '', cloths: Number(x.cloths) || 0, buf: (pk.batches && pk.batches.length ? pk.batches.map((b) => b.id).join('+') : pk.batch ? pk.batch.id : pk.p.id) }); }
        }
        out.push({ plot, prawLot: ppk ? ppk.p.productLot : '', pcode: ppk ? ppk.p.productCode : '', pdate: ppk ? (ppk.batch ? ppk.batch.date : ppk.p.date) : '', pfiller: ppk && ppk.filler ? ppk.filler.name : '',
          time: r.it.time || '', // v300: 클레임 시간대
          expiry: r.it.expiry || '', pname: r.it.name || '', cul, lotGiven: !!r.it.lot, // v311 원인 분석
          extras: r.it.extras || [], // v293: 겹치는 LOT 표의 효모 일차별 칸용
          sample: /임의/.test(doc.name || ''), // v295: 시험(임의) 클레임 저장본
          kind, date: d, month: d ? d.slice(0, 7) : '', product: r.product ? shortName(r.product.name) : (r.it.name || '(품목 미확인)'), cause: causeOf(r.it), mix, fillers: [...fm.values()], lots: lotsArr, traced: TRACED_ST.has(r.status), yeast: r.it.yeast != null ? r.it.yeast : null, mold: r.it.mold != null ? r.it.mold : null, src, line, stage, bufs });
      }
    }
    return out;
  }, [state]);

  // 월: 기본은 기록이 있는 가장 최근 달 (없으면 이번 달)
  const latest = useMemo(() => rows.map((r) => r.month).filter(Boolean).sort().pop() || today().slice(0, 7), [rows]);
  const [ymSel, setYm] = useState('');
  const [allProd, setAllProd] = useState(false); // 품목별: 상위 10개만, 나머지는 펼치기 (v255)
  const [allPL, setAllPL] = useState(false); // 제품 LOT·품목별 효모: 상위 10개만, 나머지는 펼치기 (v289)
  const ym = ymSel || latest;
  const shown = rows.filter((r) => (view === 'all' || r.kind === (view === 'cause' ? 'claim' : view)) && r.month === ym);
  const isKindView = view === 'claim' || view === 'inspect';
  const cnt = (k) => shown.filter((r) => r.kind === k).length;

  // 묶어서 세기: keyOf가 배열을 주면 각 값마다 1건
  const tally = (keyOf) => {
    const m = new Map();
    for (const r of shown) {
      const ks = [].concat(keyOf(r)).filter(Boolean);
      for (const k of (ks.length ? ks : ['(연결 없음)'])) { const t = m.get(k) || { key: k, claim: 0, inspect: 0, total: 0, cloth: 0, press: 0, 초: 0, 중: 0, 말: 0 }; t[r.kind]++; t.total++; if (r.src === '면포') t.cloth++; else if (r.src === '필터프레스') t.press++; if (r.kind === 'inspect' && (r.stage === '초' || r.stage === '중' || r.stage === '말')) t[r.stage]++; m.set(k, t); }
    }
    return [...m.values()];
  };
  const byProduct = tally((r) => r.product).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key, 'ko'));
  const byFiller = tally((r) => r.fillers.map((f) => f.name)).sort((a, b) => b.total - a.total);
  // 배양 LOT별: 한 건이 여러 LOT면 각각 셈. 옆에 그 LOT를 면포로 썼는지 필터프레스로 썼는지 (이 달 건들 합쳐서)
  const lotInfo = new Map();
  for (const r of shown) for (const l of r.lots) {
    const t = lotInfo.get(l.lot) || { tank: l.tank, press: false, cloth: false, drink: false, products: [], dates: [] };
    t.press = t.press || l.press; t.cloth = t.cloth || l.cloth; t.drink = t.drink || l.drink;
    for (const p of l.products) if (!t.products.includes(p)) t.products.push(p);
    for (const d of l.dates) if (!t.dates.includes(d)) t.dates.push(d);
    lotInfo.set(l.lot, t);
  }
  const lotProducts = (r) => { const t = lotInfo.get(r.key); return t && t.products.length ? t.products.map((p, i) => html`<div key=${i}>${p}</div>`) : html`<span class="muted">—</span>`; };
  // 충진일 · 호기 칸: 같은 순서로 줄을 맞춤 (한 줄 = 충진일 + 그날 호기)
  const lotFills = (r) => { const t = lotInfo.get(r.key); return t ? [...t.dates].sort().map((k) => { const [d, f, lot, exp] = k.split('|'); return { k, d, f, lot, exp }; }) : []; };
  // 소비기한 (제품 LOT) 칸: 충진일·호기 칸과 같은 줄 순서
  const lotExps = (r) => { const fs = lotFills(r); return fs.length ? fs.map((x) => html`<div key=${x.k} style="white-space:nowrap">${x.exp ? fmtDate(x.exp).replace(/^20(\d{2})/, '$1') : '—'}${x.lot ? html` <span class="muted" style="font-size:12px">(${x.lot})</span>` : ''}</div>`) : html`<span class="muted">—</span>`; };
  const lotDates = (r) => { const fs = lotFills(r); return fs.length ? fs.map((x) => html`<div key=${x.k} style="white-space:nowrap">${fmtDate(x.d)}(${dow(x.d)})</div>`) : html`<span class="muted">—</span>`; };
  const lotFillers = (r) => { const fs = lotFills(r); return fs.length ? fs.map((x) => html`<div key=${x.k} style="white-space:nowrap">${x.f || html`<span class="muted">—</span>`}</div>`) : html`<span class="muted">—</span>`; };
  const byLot = tally((r) => r.lots.map((l) => l.lot)).sort((a, b) => b.total - a.total || b.key.localeCompare(a.key));
  // 발효탱크 LOT별 원인 내역: "곰팡이 2 · 부풂 1"
  const lotCause = new Map();
  for (const r of shown) for (const l of new Set(r.lots.map((x) => x.lot))) { const m = lotCause.get(l) || new Map(); m.set(r.cause, (m.get(r.cause) || 0) + 1); lotCause.set(l, m); }
  const lotCauseText = (k) => { const m = lotCause.get(k); return m ? [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${v}`).join(' · ') : ''; };
  const srcCell = (r) => { const t = lotInfo.get(r.key); if (!t) return html`<span class="muted">—</span>`; const out = [];
    if (t.cloth) out.push(html`<span key="c" class="chip sky">면포</span>`);
    if (t.press) out.push(html`<span key="p" class="chip accent">필터프레스</span>`);
    if (t.drink) out.push(html`<span key="d" class="chip">드링크</span>`);
    return out.length ? html`<span class="row" style="gap:4px;flex-wrap:nowrap">${out}</span>` : html`<span class="muted">—</span>`; };
  const topFiller = byFiller[0] && byFiller[0].key !== '(연결 없음)' ? byFiller[0] : null;
  // 가장 많은 설비의 건 중 면포 / FP를 쓴 건 (둘 다 쓴 건은 양쪽에 셈)
  const topSrc = topFiller ? shown.reduce((s, r) => { const f = r.fillers.find((x) => x.name === topFiller.key); if (f) { if (f.cloth) s.cloth++; if (f.press) s.press++; } return s; }, { cloth: 0, press: 0 }) : null;

  // 원인 × 재공품 유형 교차표: 행 = 원인(많은 순), 열 = 재공품 유형(기준정보 순서, 미연결은 맨 끝)
  const mixOrder = (state.settings.mixTypes || []).map((m) => m.name);
  const mixes = [...new Set(shown.map((r) => r.mix))].sort((a, b) => (a === NO_MIX) - (b === NO_MIX) || ((mixOrder.indexOf(a) + 1 || 99) - (mixOrder.indexOf(b) + 1 || 99)) || a.localeCompare(b, 'ko'));
  const causeCount = new Map(); for (const r of shown) causeCount.set(r.cause, (causeCount.get(r.cause) || 0) + 1);
  // 효모 구간은 건수가 없어도 5단계를 모두 보여줌 (기준 50 이하 대비 얼마나 벗어났는지 보이게)
  if ([...causeCount.keys()].some((c) => BAND_ORDER.includes(c))) for (const b of BAND_ORDER) if (!causeCount.has(b)) causeCount.set(b, 0);
  const bandIdx = (c) => BAND_ORDER.indexOf(c);
  const causes = [...causeCount.keys()].sort((a, b) => (a === NO_TYPE) - (b === NO_TYPE) || (a === WAIT_TYPE) - (b === WAIT_TYPE) || (bandIdx(a) >= 0 && bandIdx(b) >= 0 ? bandIdx(a) - bandIdx(b) : 0) || causeCount.get(b) - causeCount.get(a) || a.localeCompare(b, 'ko'));
  const cell = (c, m) => shown.filter((r) => r.cause === c && r.mix === m).length;
  const crossCols = [
    { key: 'cause', label: '구분', render: (c) => html`<b>${c}</b>` },
    ...mixes.map((m) => ({ key: m, label: m, num: true, render: (c) => { const v = cell(c, m); return v ? n(v) : html`<span class="muted">0</span>`; }, total: () => n(shown.filter((r) => r.mix === m).length) })),
    { key: 'sum', label: '합계', num: true, render: (c) => html`<b>${n(causeCount.get(c))}</b>`, total: () => html`<b>${n(shown.length)}</b>` },
  ];

  // 배양 LOT별 효모 (자사검사 효모 수치가 있는 건만): 한 검사 건이 여러 LOT면 각 LOT에 넣음. 배양 LOT 연결이 없는 건은 따로 한 줄
  const yRows = shown.filter((r) => r.yeast != null);
  const yMap = new Map();
  for (const r of yRows) for (const key of (r.lots.length ? r.lots.map((l) => l.lot) : ['(배양 LOT 미연결)'])) {
    const t = yMap.get(key) || { key, ys: [], molds: 0, insps: [] }; t.ys.push(r.yeast); if (r.mold > 0) t.molds++;
    t.insps.push(r); // v256~257: 초·중·말 검사 횟수 · 문제 건수
    yMap.set(key, t);
  }
  const byLotYeast = [...yMap.values()].map((t) => ({ ...t, med: median(t.ys), max: Math.max(...t.ys), hi: t.ys.filter((v) => v >= 1000).length, total: t.ys.length }))
    .sort((a, b) => (a.key === '(배양 LOT 미연결)') - (b.key === '(배양 LOT 미연결)') || b.hi - a.hi || b.med - a.med || b.max - a.max);
  // v288: 제품 LOT·품목별 효모 — 검사 한 건 = 그 검사의 제품 LOT + 품목 한 줄 (배양 LOT별로 나누면 한 검사가 여러 줄로 퍼져서)
  const prodLotYeast = (() => {
    const m = new Map();
    for (const r of yRows) {
      const key = r.plot ? `${r.plot}|${r.product}` : `(제품 LOT 미연결)|${r.product}`;
      const t = m.get(key) || { key, plot: r.plot, prawLot: r.prawLot, pcode: r.pcode, product: r.product, ys: [], molds: 0, insps: [], fills: [], cultures: [] };
      t.ys.push(r.yeast); if (r.mold > 0) t.molds++; t.insps.push(r);
      if (r.pdate && !t.fills.some((f) => f.d === r.pdate && f.f === r.pfiller)) t.fills.push({ d: r.pdate, f: r.pfiller });
      for (const l of r.lots) { const c = t.cultures.find((x) => x.lot === l.lot); if (c) { c.press = c.press || l.press; c.cloth = c.cloth || l.cloth; } else t.cultures.push({ lot: l.lot, tank: l.tank, press: l.press, cloth: l.cloth, drink: l.drink }); }
      m.set(key, t);
    }
    return [...m.values()].map((t) => ({ ...t, med: median(t.ys), max: Math.max(...t.ys), hi: t.ys.filter((v) => v >= 1000).length, total: t.ys.length }))
      .sort((a, b) => b.hi - a.hi || b.molds - a.molds || b.max - a.max || b.med - a.med || String(a.plot).localeCompare(String(b.plot)));
  })();
  // 효모 통계 (자사검사): 묶음별 건수 · 중앙값 · 평균 · 500/1000 이상 · 곰팡이 검출
  const [ySplit, setYSplit] = useState('src');
  const [openTanks, setOpenTanks] = useState(() => new Set());
  const toggleTank = (k) => setOpenTanks((s) => { const t = new Set(s); if (t.has(k)) t.delete(k); else t.add(k); return t; });
  const Y_SPLITS = [{ value: 'src', label: '면포/필터프레스' }, { value: 'line', label: '호기' }, { value: 'mix', label: '재공품 유형' }, { value: 'stage', label: '초·중·말' }, { value: 'tank', label: '배양 탱크' }];
  const yKeyOf = { src: (r) => r.src, line: (r) => r.line, mix: (r) => r.mix, stage: (r) => r.stage, tank: (r) => r.lots.map((l) => l.tank).filter(Boolean) };
  const yGroupOrder = { stage: ['초', '중', '말'], src: ['면포', '필터프레스'] };
  const yStat = (key, list) => { const ys = list.map((r) => r.yeast); return { key, total: ys.length, med: median(ys), mean: ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : null, max: ys.length ? Math.max(...ys) : null, ge500: ys.filter((v) => v >= 500).length, ge1000: ys.filter((v) => v >= 1000).length, molds: list.filter((r) => r.mold > 0).length }; };
  const yGroups = (() => {
    const m = new Map();
    for (const r of yRows) { const ks = [].concat(yKeyOf[ySplit](r)).filter(Boolean); for (const k of (ks.length ? [...new Set(ks)] : ['(미확인)'])) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); } }
    const ord = yGroupOrder[ySplit] || [];
    const groups = [...m.entries()].map(([k, list]) => yStat(k, list)).sort((a, b) => ((ord.indexOf(a.key) + 1 || 99) - (ord.indexOf(b.key) + 1 || 99)) || b.med - a.med || String(a.key).localeCompare(String(b.key), 'ko', { numeric: true }));
    if (ySplit !== 'tank') return groups;
    // 배양 탱크: 탱크 줄 아래에 그 탱크의 배양 LOT 줄들 (1000 이상 건수 → 중앙값 순)
    // 탱크 줄을 누르면 LOT 줄을 펼치거나 숨김 (기본 숨김)
    const out = [];
    for (const g of groups) {
      const lm = new Map();
      for (const r of yRows) for (const l of r.lots) { if (l.tank !== g.key) continue; if (!lm.has(l.lot)) lm.set(l.lot, []); if (!lm.get(l.lot).includes(r)) lm.get(l.lot).push(r); }
      const lots = [...lm.entries()].map(([lot, list]) => ({ ...yStat(lot, list), key: `${g.key}|${lot}`, label: lot, level: 1 }))
        .sort((a, b) => b.ge1000 - a.ge1000 || b.med - a.med || String(b.label).localeCompare(String(a.label)));
      out.push({ ...g, level: 0, lotCount: lots.length, open: openTanks.has(g.key) });
      if (openTanks.has(g.key)) out.push(...lots);
    }
    return out;
  })();
  const ySrc = (s) => yStat(s, yRows.filter((r) => r.src === s));
  const yCloth = ySrc('면포'), yPress = ySrc('필터프레스');
  const pctOf = (a, b) => b ? pct(a / b * 100, 0) : '—';

  // 초·중·말 검사 칸 (v257): 단계별 검사 횟수를 세로로, 문제 있던 검사가 있으면 빨간색 "(3건 중 1건)"
  // 문제 = 효모 1000 이상 또는 곰팡이 검출 (사내 기준 50은 11월 자사검사 113건이 모두 넘어서 구분이 안 됨 → 표의 빨간 효모 기준과 같게)
  const BAD_YEAST = 1000;
  const inspBad = (r) => (r.yeast != null && r.yeast >= BAD_YEAST) || r.mold > 0;
  const stageCell = (insps) => {
    const st = { 초: [], 중: [], 말: [], 기타: [] };
    for (const r of insps || []) (st[r.stage] || st.기타).push(r);
    const line = (s, list, small) => { if (!list.length && small) return ''; const bad = list.filter(inspBad).length;
      return html`<div key=${s} style=${bad ? 'color:var(--bad);font-weight:700' : small ? 'font-size:12px;color:var(--fg-2)' : ''}>${s} <b>${n(list.length)}</b>번${bad ? ` (${n(list.length)}건 중 ${n(bad)}건)` : ''}</div>`; };
    return html`<div style="white-space:nowrap;line-height:1.5;font-size:12px" title=${`빨간색 = 문제 있던 검사 (효모 ${BAD_YEAST} 이상 또는 곰팡이 검출)`}>${['초', '중', '말'].map((s) => line(s, st[s]))}${line('기타', st.기타, true)}</div>`;
  };
  // v293 겹치는 LOT 표: 효모 일차별·곰팡이 칸 — 단계마다 값이 같으면 하나, 다르면 "초 : <10 / 중 : 120 / 말 : 120"처럼 세로로.
  //       검출(10 이상·TNTC)은 빨강 굵게, 여러 값 중 <10은 감춤 (자사검사 화면과 같은 규칙)
  const OV_TESTS = [['효모\n(3일차)', '효모/곰팡이 (3일차)'], ['효모\n(4일차)', '효모/곰팡이 (4일차)'], ['효모\n(5일차)', '효모 (5일차)'], ['곰팡이', '곰팡이']];
  const exOf = (r, h) => { const f = (r.extras || []).find(([k]) => k === h); return f ? String(f[1]).trim() : ''; };
  const normV = (v) => { const ps = String(v).split('/').map((s) => s.trim()).filter(Boolean); return new Set(ps).size === 1 ? ps[0] : ps.join(' / '); };
  const badV = (v) => /양성/.test(v) || (!/예정/.test(v) && (parseCount(v) ?? 0) > 0);
  const fmtV = (v) => /^\d[\d,]*$/.test(v) ? n(Number(v.replace(/,/g, ''))) : /예정/.test(v) ? v.replace(/(\d+)월\s*(\d+)일\s*예정/, '$1/$2 예정') : v;
  const stOf = (r) => ['초', '중', '말'].includes(r.stage) ? r.stage : '기타';
  const testCellOv = (insps, h) => {
    const vals = insps.map((r) => ({ st: stOf(r), v: normV(exOf(r, h)) })).filter((x) => x.v && !/^[-–—]$/.test(x.v));
    if (!vals.length) return html`<span class="muted">—</span>`;
    const RED = 'color:var(--bad);font-weight:700';
    // v294: 값이 같아도 하나로 줄이지 않고, 그 LOT에서 검사한 단계를 항상 "초 : / 중 : / 말 :"로 (이 일차 값이 없는 단계는 —)
    const stages = ['초', '중', '말', '기타'].filter((s) => insps.some((r) => stOf(r) === s));
    // v297: 한 단계에 검사가 여러 건이면 최대값 하나만 "초 : 1,340 외 5건"
    const score = (p) => /양성/.test(p) ? Infinity : /예정/.test(p) ? -1 : (parseCount(p) ?? 0);
    return html`<div style="white-space:normal;word-break:keep-all;line-height:1.5;font-size:12px;text-align:left;display:inline-block">${stages.map((s) => { const xs = vals.filter((x) => x.st === s); const lbl = s === '기타' ? '기타 : ' : `${s} : `;
      if (!xs.length) return html`<div key=${s} class="muted">${lbl}—</div>`;
      const parts = xs.flatMap((x) => x.v.split('/').map((p) => p.trim()).filter(Boolean));
      const top = parts.reduce((a, p) => score(p) > score(a) ? p : a, parts[0]);
      const more = xs.length - 1;
      return html`<div key=${s} style=${badV(top) ? RED : ''} title=${more ? xs.map((x) => fmtV(x.v)).join(', ') : ''}>${lbl}${fmtV(top)}${more ? html`<span style="font-weight:400;color:var(--fg-2)"> 외</span>` : ''}</div>`; })}</div>`;
  };
  const yTone = (v) => v >= 1000 ? 'var(--bad)' : v >= 500 ? 'var(--warn)' : '';
  const yCell = (v) => html`<b style=${yTone(v) ? `color:${yTone(v)}` : 'font-weight:500'}>${yTxt(v)}</b>`;

  // 겹치는 버퍼탱크: 이 달 클레임과 자사검사가 같은 버퍼(충진 배치)로 추적된 것
  // v287: 클레임 기준 — 클레임은 고른 달, 자사검사는 달과 상관없이 그 클레임이 걸린 버퍼의 검사를 모두 따라옴
  //       (11월에 접수된 클레임의 제품이 10월에 충진·검사된 경우를 놓치지 않게)
  // v296: 줄 = 각 클레임·검사 "자기" 제품 LOT 기준 (충진일·호기·제품 LOT). 버퍼 기준으로 합치면 같은 버퍼에 든 다른 소비기한 LOT까지 딸려 와서
  //       클레임은 고른 달, 자사검사는 달과 상관없이 같은 제품 LOT면 따라옴. 버퍼 번호는 그 LOT가 들어간 버퍼만
  const merged = new Map();
  const lotKeyOf = (r) => r.plot ? `${r.pdate || ''}|${r.pfiller || ''}|${r.plot}` : '';
  // v300: 클레임 시간대 기준 — 버퍼 번호·배양 LOT는 클레임 제품이 만들어진 버퍼에서만,
  //       자사검사도 그 버퍼에서 뽑은 것만 비교 (같은 LOT라도 다른 시간대 버퍼의 검사는 빼고 "다른 시간대 검사"로 따로 적음)
  const ownBufs = (r) => (r.bufs || []).filter((b) => b.lot === r.plot);
  const addClaim = (r) => {
    const k = lotKeyOf(r); if (!k) return;
    let m = merged.get(k);
    if (!m) { m = { id: k, date: r.pdate, filler: r.pfiller, plot: r.plot, labels: [], lots: [], cultures: [], claims: [], insps: [], otherInsps: [], bufIds: new Set(), times: [] }; merged.set(k, m); }
    for (const b of ownBufs(r)) {
      m.bufIds.add(b.id);
      if (b.label && !m.labels.includes(b.label)) m.labels.push(b.label);
      for (const c of b.cultures) { const e = m.cultures.find((x) => x.lot === c.lot); if (e) e.press = e.press || c.press; else m.cultures.push({ ...c }); }
    }
    if (r.time) m.times.push(r.time);
    // 품목: 클레임의 품목(그 클레임이 가리키는 포장 내역)으로
    if (!m.lots.some((l) => l.code === r.pcode)) m.lots.push({ lot: r.plot, product: r.product, rawLot: r.prawLot, code: r.pcode });
    if (!m.claims.includes(r)) m.claims.push(r);
  };
  const addInsp = (r) => {
    const m = merged.get(lotKeyOf(r)); if (!m) return;
    // 클레임 쪽 버퍼를 모르면(추적이 버퍼까지 안 됨) 예전처럼 같은 LOT 검사를 모두 비교
    const same = !m.bufIds.size || ownBufs(r).some((b) => m.bufIds.has(b.id));
    const arr = same ? m.insps : m.otherInsps; if (!arr.includes(r)) arr.push(r);
  };
  for (const r of shown) if (r.kind === 'claim') addClaim(r);
  for (const r of rows) if (r.kind === 'inspect') addInsp(r);
  const timeSpan = (ts) => { const v = [...ts].sort(); return v[0] === v[v.length - 1] ? v[0] : `${v[0]}~${v[v.length - 1]}`; };
  const otherTxt = (r) => [['초', '중', '말'].includes(r.stage) ? r.stage : '', r.time, bufText(ownBufs(r).map((b) => b.label).filter(Boolean))].filter(Boolean).join(' ');
  const bufText = (labels) => { const nos = labels.map((l) => (/버퍼\s*(\d+)/.exec(l) || [])[1]).filter(Boolean).sort((a, b) => a - b); return nos.length ? `버퍼 ${nos.join('·')}` : labels.join(', '); };
  // v288: 클레임이 걸린 LOT 전부(겹치는 자사검사가 없는 것도 "겹치는 자사검사 없음"으로) — overlap은 그중 자사검사가 있는 것
  const claimLots = [...merged.values()].filter((t) => t.claims.length).map((t) => {
    const ys = t.insps.map((r) => r.yeast).filter((v) => v != null);
    const cc = new Map(); for (const r of t.claims) cc.set(r.cause, (cc.get(r.cause) || 0) + 1);
    return { ...t, ymed: median(ys), ymin: ys.length ? Math.min(...ys) : null, ymax: ys.length ? Math.max(...ys) : null, molds: t.insps.filter((r) => r.mold > 0).length,
      press: t.cultures.some((c) => c.press) || t.insps.some((r) => r.src === '필터프레스'), cloth: t.cultures.some((c) => !c.press) || t.insps.some((r) => r.src === '면포'),
      tanks: [...new Set(t.cultures.map((c) => c.tank).filter(Boolean))], causeText: [...cc.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') };
  }).sort((a, b) => (b.insps.length > 0) - (a.insps.length > 0) || b.claims.length - a.claims.length || (b.ymax || 0) - (a.ymax || 0) || String(a.date).localeCompare(String(b.date)));
  const overlap = claimLots.filter((t) => t.insps.length);
  const claimBufCount = claimLots.length;
  const ovClaimSet = new Set(overlap.flatMap((t) => t.claims)); const ovClaims = ovClaimSet.size;
  const ovInspSet = new Set(overlap.flatMap((t) => t.insps));
  const ovMed = median([...ovInspSet].map((r) => r.yeast).filter((v) => v != null));
  const nonOvMed = median(shown.filter((r) => r.kind === 'inspect' && !ovInspSet.has(r) && r.yeast != null).map((r) => r.yeast));

  const traced = shown.filter((r) => r.traced).length;
  // 품목별·충진 설비별에 붙이는 면포 / 필터프레스 건수
  const SRC_COLS = [
    { key: 'cloth', label: '면포', num: true, render: (r) => r.cloth ? n(r.cloth) : html`<span class="muted">0</span>` },
    { key: 'press', label: '필터프레스', num: true, render: (r) => r.press ? html`<b style="color:var(--c2)">${n(r.press)}</b>` : html`<span class="muted">0</span>` },
  ];
  const cols = (first, extra = [], sub) => [
    { key: 'key', label: first, ...(sub ? { render: (r) => html`<b>${r.key}</b>`, sub } : {}) },
    ...extra,
    ...(view === 'all' ? [{ key: 'claim', label: '클레임', num: true, render: (r) => n(r.claim) }, { key: 'inspect', label: '자사검사', num: true, render: (r) => n(r.inspect) }] : []),
    { key: 'total', label: '합계', num: true, render: (r) => html`<b>${n(r.total)}</b>` },
    { key: 'share', label: '비중', num: true, render: (r) => pct(shown.length ? r.total / shown.length * 100 : null, 0) },
  ];
  // 자사검사: 품목별에 초·중·말 검사 건수 (v255)
  const STAGE_COLS = ['초', '중', '말'].map((s) => ({ key: `st-${s}`, label: s, num: true, render: (r) => r[s] ? n(r[s]) : html`<span class="muted">0</span>` }));
  const emptyRow = html`<div class="empty">이 달에 기록이 없습니다.</div>`;

  // ---------- 분석 의견 (v295): 비교 화면(겹치는 LOT 표) 기준 — 이 달 클레임이 걸린 제품 LOT마다 자사검사 결과와 맞춰 봄 ----------
  const opinion = view !== 'all' ? null : (() => { // v314: 비교 화면을 없애 계산하지 않음
    const md = (d) => d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '';
    const lotName = (t) => `${[...new Set(t.lots.map((l) => `${l.lot} ${l.product}`))].join(', ')} (${md(t.date)} ${t.filler}${t.labels && t.labels.length ? ` · ${bufText(t.labels)}` : ''})`;
    const claimN = cnt('claim');
    const withInsp = claimLots.filter((t) => t.insps.length), noInsp = claimLots.filter((t) => !t.insps.length);
    // 자사검사 결과 요약: 효모 최대(어느 단계), 곰팡이 검출 여부
    const inspSum = (t) => {
      const ys = t.insps.filter((r) => r.yeast != null); const ymax = ys.length ? Math.max(...ys.map((r) => r.yeast)) : null;
      const hiSt = [...new Set(ys.filter((r) => r.yeast === ymax && ymax > 0).map((r) => r.stage).filter((s) => ['초', '중', '말'].includes(s)))];
      const molds = t.insps.filter((r) => r.mold > 0);
      const dates = [...new Set(t.insps.map((r) => r.date).filter(Boolean))].sort().map(md);
      const level = ymax == null ? 'none' : ymax >= 1000 || molds.length ? 'bad' : ymax > 0 ? 'low' : 'clean';
      return { ymax, hiSt, molds, dates, level, n: t.insps.length };
    };
    // 합친 줄 안에서 클레임이 나온 버퍼 / 자사검사를 한 버퍼
    const bufsIn = (rs, t) => { const ls = new Set(); for (const r of rs) for (const b of r.bufs || []) if (b.date === t.date && b.filler === t.filler && t.lots.some((l) => l.lot === b.lot) && b.label) ls.add(b.label); return [...ls]; };
    const causeKinds = (t) => { const c = new Map(); for (const r of t.claims) c.set(r.cause, (c.get(r.cause) || 0) + 1); return c; };
    const hasCause = (t, re) => [...causeKinds(t).keys()].some((k) => re.test(k));

    const summary = [];
    if (!claimN) summary.push(`${ymLabel(ym)}에는 클레임이 없어 자사검사와 맞춰 볼 대상이 없습니다.`);
    else {
      const untraced = claimN - claimLots.reduce((s, t) => s + t.claims.length, 0);
      summary.push(`${ymLabel(ym)} 클레임 ${n(claimN)}건은 제품 LOT ${n(claimLots.length)}개(충진일·호기 기준)에서 나왔습니다. ${noInsp.length ? `그중 ${n(withInsp.length)}개 LOT는 자사검사 기록이 있고, ${n(noInsp.length)}개 LOT는 자사검사가 없습니다.` : withInsp.length > 1 ? `${n(withInsp.length)}개 LOT 모두 자사검사 기록이 있습니다.` : '이 LOT는 자사검사 기록이 있습니다.'}${untraced > 0 ? ` 제품 LOT까지 추적되지 않은 클레임 ${n(untraced)}건은 빠져 있습니다.` : ''}`);
      for (const t of withInsp.slice(0, 6)) {
        const s = inspSum(t);
        const cb = bufsIn(t.claims, t), ib = bufsIn(t.insps, t); const miss = cb.filter((l) => !ib.includes(l));
        t._bufNote = cb.length && ib.length ? ` 클레임은 ${bufText(cb)}, 자사검사는 ${bufText(ib)}에서 나왔습니다${miss.length ? ` — ${bufText(miss)}는 검사하지 않은 버퍼입니다` : ''}.` : '';
        t._miss = miss;
        const res = s.level === 'bad' ? `효모 최대 ${yTxt(s.ymax)}${s.hiSt.length ? `(${s.hiSt.join('·')})` : ''}${s.molds.length ? `, 곰팡이 검출 ${n(s.molds.length)}건` : ''}로 출하 전 검사에서도 이상이 보였습니다`
          : s.level === 'low' ? `효모 최대 ${yTxt(s.ymax)}${s.hiSt.length ? `(${s.hiSt.join('·')})` : ''}, 곰팡이 불검출로 출하 전 검사는 기준 안이었습니다`
          : s.level === 'clean' ? '효모·곰팡이 모두 <10으로 출하 전 검사는 깨끗했습니다' : '검사 결과가 아직 없습니다';
        summary.push(`${lotName(t)}: 클레임 ${n(t.claims.length)}건(${t.causeText}) — 자사검사 ${n(s.n)}건(검사 ${s.dates.join('·')}) ${res}.${t._bufNote}`);
      }
      if (withInsp.length > 6) summary.push(`그 밖에 자사검사와 겹친 LOT ${n(withInsp.length - 6)}개는 위 표에서 확인하세요.`);
      if (noInsp.length) summary.push(`자사검사가 없는 클레임 LOT: ${noInsp.slice(0, 4).map((t) => `${lotName(t)} 클레임 ${n(t.claims.length)}건(${t.causeText})`).join(' / ')}${noInsp.length > 4 ? ` 외 ${n(noInsp.length - 4)}개` : ''}.`);
      // 여러 클레임 LOT에 공통으로 들어간 배양 LOT
      const cul = new Map(); for (const t of claimLots) for (const c of t.cultures) { const x = cul.get(c.lot) || { lot: c.lot, tank: c.tank, lots: 0, claims: 0 }; x.lots++; x.claims += t.claims.length; cul.set(c.lot, x); }
      const common = [...cul.values()].filter((x) => x.lots >= 2).sort((a, b) => b.claims - a.claims);
      if (common.length) summary.push(`여러 클레임 LOT에 공통으로 들어간 배양 LOT: ${common.slice(0, 4).map((x) => `${x.lot}(${x.tank || ''} · LOT ${n(x.lots)}개 · 클레임 ${n(x.claims)}건)`).join(', ')}.`);
    }

    const causes = [];
    const moldClaimClean = withInsp.filter((t) => hasCause(t, /곰팡이/) && inspSum(t).molds.length === 0);
    const badMatch = withInsp.filter((t) => inspSum(t).level === 'bad');
    if (badMatch.length) causes.push(`${badMatch.map((t) => t.lots[0] ? t.lots[0].lot : '').filter(Boolean).join(', ')}는 클레임 전에 자사검사에서 이미 효모·곰팡이가 높게 나왔습니다. 유통 문제보다 그날 그 설비·배양 LOT의 공정 오염 가능성이 큽니다.`);
    if (moldClaimClean.length) causes.push(`곰팡이 클레임이 나온 LOT 중 ${n(moldClaimClean.length)}개는 자사검사에서 곰팡이가 검출되지 않았습니다. 출하 시점에는 균수가 적어 보이지 않다가 유통·보관 중 자랐거나, 검사 샘플(초·중·말)이 문제 버퍼를 잡지 못했을 수 있습니다.`);
    const missLots = withInsp.filter((t) => t._miss && t._miss.length);
    if (missLots.length) causes.push(`같은 LOT라도 자사검사를 안 한 버퍼에서 클레임이 나왔습니다 (${missLots.slice(0, 3).map((t) => `${t.lots[0] ? t.lots[0].lot : ''} ${bufText(t._miss)}`).join(', ')}). 그 버퍼의 상태는 출하 전 검사로 확인되지 않았습니다.`);
    const cul2 = new Map(); for (const t of claimLots) for (const c of t.cultures) cul2.set(c.lot, (cul2.get(c.lot) || 0) + 1);
    const repeated = [...cul2.entries()].filter(([, v]) => v >= 2).map(([k]) => k);
    if (repeated.length) causes.push(`배양 LOT ${repeated.slice(0, 3).join(', ')}가 여러 클레임 LOT에 같이 들어갔습니다. 해당 배양 탱크의 배출 검사 결과와 탱크 세척 기록을 같이 확인하세요.`);
    if (claimLots.some((t) => t.cultures.some((c) => c.press))) causes.push('필터프레스(FP) 면포가 들어간 클레임 LOT가 있습니다. FP 공정(여과포·압착 뒤 이송)의 위생 상태도 함께 확인하세요.');
    if (!causes.length) causes.push(claimN ? '이 달 클레임과 자사검사 비교에서는 특정 공정으로 좁혀지는 뚜렷한 신호가 보이지 않습니다.' : '비교할 클레임이 없습니다.');

    const actions = [
      { title: '즉시', items: [
        ...(badMatch.length ? [`자사검사에서도 높았던 LOT(${badMatch.map((t) => t.lots[0] ? t.lots[0].lot : '').filter(Boolean).join(', ')})는 남은 재고·출하처를 확인하고 회수 여부를 판단합니다.`] : []),
        ...(noInsp.length || missLots.length ? [`자사검사가 없는 클레임 LOT·버퍼(${[...noInsp.map((t) => t.lots[0] ? t.lots[0].lot : ''), ...missLots.map((t) => `${t.lots[0] ? t.lots[0].lot : ''} ${bufText(t._miss)}`)].filter(Boolean).slice(0, 4).join(', ')})는 보관 샘플(유보품)이 있으면 효모·곰팡이를 검사합니다.`] : []),
        '클레임 응대 기록에 해당 LOT의 자사검사 결과(일차별 초·중·말)를 함께 남깁니다.',
      ] },
      { title: '1~2주 안', items: [
        ...(repeated.length ? [`공통 배양 LOT(${repeated.slice(0, 3).join(', ')})의 배양 탱크·면포 소분·반출 과정을 점검합니다.`] : []),
        ...(moldClaimClean.length ? ['곰팡이 클레임 LOT는 유통 온도·보관 기간과 포장 밀봉 상태를 확인합니다.'] : []),
        '클레임이 몰린 버퍼(제조시간대)의 충진 전후 세척 기록을 확인합니다.',
      ] },
      { title: '재발 방지', items: [
        '자사검사 샘플을 버퍼마다(적어도 초·말) 뽑아, 클레임이 나와도 원인 버퍼를 바로 찾을 수 있게 합니다.',
        '클레임 엑셀에 제품 LOT와 제조시간을 꼭 적어 자사검사와 바로 겹쳐 봅니다.',
      ] },
    ];
    const sample = shown.some((r) => r.kind === 'claim' && r.sample); // 이 달 클레임에 시험(임의) 데이터가 섞였을 때만 안내
    const note = `비교 화면의 겹치는 LOT 표(${ymLabel(ym)} 클레임 · 달과 상관없이 같은 제품 LOT의 자사검사)로 자동 계산한 참고 의견입니다.${sample ? ' 임의로 만든 시험 클레임이 섞여 있으면 결과가 실제와 다릅니다.' : ''}`;
    return { summary, causes, actions, note };
  })();

  // ---------- 원인 분석 (v311): 생산팀 클레임 접수 내역 분석(2026.11.10) 방식 ----------
  //  ① 유형별 → ② 구매 채널별 → ③ 접수 시점 잔여 소비기한 → ④ 동일 LOT 복수 클레임의 제조 공정(발효 → 배출 → 충진, 반제 경과일)
  //  → ⑤ 같은 충진일·설비 자사검사 → ⑥ 검토 의견(공정 원인이 안 보이면 유통·보관 온도 이탈 가능성) · 향후 조치
  const CVS_RE = /gs\s*25|^cu$|씨유|세븐|7\s*-?\s*eleven|이마트\s*24|emart\s*24|미니스톱|ministop/i;
  const CA_BANDS = [
    { key: 'over', label: '소비기한 경과 후 접수', test: (d) => d < 0, color: 'var(--bad)' },
    { key: 'day', label: '소비기한 당일 접수', test: (d) => d === 0, color: 'var(--warn)' },
    { key: 'd2', label: '소비기한 1~2일 전 접수', test: (d) => d >= 1 && d <= 2, color: 'var(--c1)' },
    { key: 'd5', label: '소비기한 3~5일 전 접수', test: (d) => d >= 3 && d <= 5, color: 'var(--good)' },
    { key: 'd6', label: '소비기한 6일 이상 전 접수', test: (d) => d >= 6, color: 'var(--fg-2)' },
  ];
  const AGE_LIMIT = 3; // 반제는 배출 후 3일까지 정상, 4일 이상이면 문제 (공정 원인 후보)
  const ca = useMemo(() => {
    if (view !== 'cause') return null;
    const cl = rows.filter((r) => r.kind === 'claim' && r.month === ym);
    const N = cl.length;
    const p1 = (v, d = N) => d ? `${Math.round(v / d * 1000) / 10}%` : '—';
    const dd = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
    const typeOf = (r) => exOf(r, '클레임 유형') || r.cause;
    const shopOf = (r) => exOf(r, '구매처');
    const tallyBy = (list, f) => { const m = new Map(); for (const r of list) { const k = f(r) || '(미기재)'; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].map(([key, v]) => ({ key, v })).sort((a, b) => (a.key === '(미기재)') - (b.key === '(미기재)') || b.v - a.v || a.key.localeCompare(b.key, 'ko')); };
    const types = tallyBy(cl, typeOf);
    const qualityN = cl.filter((r) => /변질|관능/.test(typeOf(r))).length;
    const shops = tallyBy(cl, shopOf).map((s) => ({ ...s, cvs: CVS_RE.test(s.key.trim()) })).sort((a, b) => b.cvs - a.cvs || (a.key === '(미기재)') - (b.key === '(미기재)') || b.v - a.v);
    const cvsN = cl.filter((r) => CVS_RE.test(shopOf(r).trim())).length;
    // 접수일 − 소비기한
    const remOf = (r) => r.expiry && r.date ? dd(r.expiry, r.date) : null;
    const known = cl.filter((r) => remOf(r) != null);
    // v325: 구간을 묶지 않고 하루씩 — 경과 후 · 당일 · 1일 전 · 2일 전 … (가장 먼 날까지, 색은 파랑 → 초록으로 차례로)
    // v340: 두 막대 그래프(잔여 소비기한 · 반제 경과)는 변질·관능이상 클레임만 (이물·기타·미기재 제외)
    const qcl = cl.filter((r) => /변질|관능/.test(typeOf(r)));
    const qKnown = qcl.filter((r) => remOf(r) != null);
    const qNear = qKnown.filter((r) => remOf(r) <= 2).length;
    const maxD = Math.max(0, ...qKnown.map(remOf).filter((d) => d > 0));
    const dayColor = (d) => { const t = maxD > 1 ? (d - 1) / (maxD - 1) : 0; return `hsl(${Math.round(212 - t * 82)} ${Math.round(68 - t * 8)}% ${Math.round(50 - t * 8)}%)`; };
    const bandDefs = [CA_BANDS[0], CA_BANDS[1], ...Array.from({ length: maxD }, (_, i) => ({ key: `d${i + 1}`, label: `소비기한 ${i + 1}일 전 접수`, test: (d) => d === i + 1, color: dayColor(i + 1) }))];
    // v339: 소비기한 미기재·확인불가도 '확인 불가' 막대로 넣어 합계 = 이 달 전체 건수
    const bands = [...bandDefs.map((b) => ({ ...b, v: qKnown.filter((r) => b.test(remOf(r))).length })), { key: 'unk', label: '확인 불가', color: 'var(--line-strong)', v: qcl.length - qKnown.length }].filter((b) => b.key !== 'unk' || b.v > 0);
    const nearN = known.filter((r) => remOf(r) <= 2).length;
    // v335 클레임 제품의 반제 경과: 클레임 제품 버퍼에 들어간 반제(버퍼·배양 LOT 한 번씩)를 포 수로 2일 이하 / 3일 / 4일 이상
    //  경과 = 충진일 − 배출일, 필터프레스(FP)는 배출 다음 날 유청분리하므로 +1일
    const ageOf = (c) => c.out && c.fill ? dd(c.fill, c.out) + (c.press ? FP_AGE_EXTRA : 0) : null;
    const usedMap = new Map(); let ageClaims = 0;
    // 라인(LOT)을 적은 클레임만 (소비기한만이면 그날 LOT가 여럿이라 반제가 부풀어짐)
    for (const r of cl) { if (!r.lotGiven || !r.cul.length) continue; ageClaims++; for (const c of r.cul) { const k = `${c.buf}|${c.lot}`; if (!usedMap.has(k)) usedMap.set(k, { age: ageOf(c), cloths: c.cloths || 0 }); } }
    const AGE_BANDS = [{ key: 'a2', label: '2일 이하', test: (a) => a <= 2, color: 'var(--good)' }, { key: 'a3', label: '3일', test: (a) => a === 3, color: 'var(--c1)' }, { key: 'a4', label: '4일 이상', test: (a) => a >= 4, color: 'var(--bad)' }];
    const ageBandsCloth = AGE_BANDS.map((b) => ({ ...b, v: [...usedMap.values()].filter((u) => u.age != null && b.test(u.age)).reduce((a, u) => a + u.cloths, 0) }));
    const ageTot = ageBandsCloth.reduce((a, b) => a + b.v, 0);
    // v339: 그래프는 클레임 건수 기준 — 클레임마다 그 제품에 들어간 반제 중 가장 오래된 경과일로 나누고, 배양 LOT가 연결 안 된 클레임은 '확인 불가' (합계 = 이 달 전체)
    const claimAge = (r) => { const as = r.cul.map(ageOf).filter((a) => a != null); return as.length ? Math.max(...as) : null; };
    const UNK_BAND = { key: 'unk', label: '확인 불가', color: 'var(--line-strong)' };
    // v340: 변질·관능이상 클레임만, 확인 불가 막대는 빼고 건수만 설명에 (비율은 변질·관능이상 전체 건수 기준)
    const ageBands = AGE_BANDS.map((b) => ({ ...b, v: qcl.filter((r) => { const a = claimAge(r); return a != null && b.test(a); }).length }));
    const ageKnown = ageBands.reduce((a, b) => a + b.v, 0); void UNK_BAND;
    // 동일 LOT 복수 클레임: 제품 LOT별로 묶고, 배양 LOT의 배양일·배출일·충진일로 공정 흐름
    const gm = new Map();
    for (const r of cl) {
      if (!r.plot || !r.lotGiven) continue; // 라인(LOT)을 적은 클레임만 LOT로 묶음 (소비기한만 있으면 그날 LOT가 여럿이라)
      let g = gm.get(r.plot);
      if (!g) { g = { plot: r.plot, claims: [], cul: new Map(), fills: new Set(), fillers: new Set(), bufIds: new Set(), shops: new Set(), products: new Set() }; gm.set(r.plot, g); }
      g.claims.push(r);
      for (const c of r.cul) { const e = g.cul.get(c.lot) || { ...c, fills: new Set() }; e.press = e.press || c.press; if (c.fill) e.fills.add(c.fill); g.cul.set(c.lot, e); }
      if (r.pdate) g.fills.add(r.pdate); if (r.pfiller) g.fillers.add(r.pfiller);
      for (const b of ownBufs(r)) g.bufIds.add(b.id);
      if (shopOf(r)) g.shops.add(shopOf(r)); if (r.product) g.products.add(r.product);
    }
    // 출고처(편의점) 기준 (v311): 전산 출하현황의 제품 LOT별 출고처로 클레임 LOT가 어느 채널에 몇 EA 나갔는지 → 채널별 클레임 비중과 비교
    const chOf = (s) => { const t = String(s || '').trim(); return /gs\s*25/i.test(t) ? 'GS25' : /^cu\b|씨유|비지에프|bgf/i.test(t) ? 'CU' : /세븐|미니스톱|7\s*-?\s*eleven/i.test(t) ? '세븐일레븐' : /이마트\s*24|emart\s*24/i.test(t) ? '이마트24'
      // 클레임 구매처 ↔ 전산 거래처 이름 맞추기 (배민 = B마트, 웰스토리 = 삼성 웰스토리, 스마트스토어 = 스토어팜, 카카오 …)
      : /b\s*마트|배민/i.test(t) ? 'B마트(배민)' : /웰스토리/.test(t) ? '삼성 웰스토리' : /스마트\s*스토어|스토어팜|네이버/.test(t) ? '스토어팜(네이버)' : /카카오/.test(t) ? '카카오' : t || '(미기재)'; };
    const isCvsCh = (c) => ['GS25', 'CU', '세븐일레븐', '이마트24'].includes(c);
    const shipCache = new Map();
    const shipOf = (plot) => { if (!shipCache.has(plot)) shipCache.set(plot, shipmentsForLot(state, plot).filter((s) => !/^사내/.test(s.cust) && s.ea > 0)); return shipCache.get(plot); };
    // 같은 LOT라도 품목마다 출고처가 다름(춘식이 키캡 = GS25, 패트와매트 = CU) → 클레임 제품과 같은 품목의 출고만 비교
    const normI = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\*\d+|\s+/g, '').replace(/블랜드/g, '블렌드');
    const sameItem = (a, b) => { const x = normI(a), y = normI(b); return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x)); };
    const matchShip = (g) => {
      const sh = shipOf(g.plot);
      const claims = g.claims.filter((r) => sh.some((s) => sameItem(s.item, r.pname)));
      const ships = sh.filter((s) => claims.some((r) => sameItem(s.item, r.pname)));
      return { claims, ships, items: [...new Set(ships.map((s) => s.item))] };
    };
    const chMap = new Map(); let shippedLots = 0, shippedClaims = 0;
    const shipYm = new Map(); const shipDays = []; // v315: 출고 기간 (출고 EA 머리글에 "10월")
    // v338: 숫자를 위 표와 맞춤 — 클레임은 이 달 전체(구매처 기타·미기재는 '확인 불가'), 출고 EA는 출고와 맞춘 LOT·품목만.
    //  만 EA당은 출고와 맞춘 클레임(mclaims)으로만 계산. 전산 거래처 '기타'(온라인 3P)는 '기타 거래처'로 이름을 구분
    const UNK = '확인 불가';
    const claimCh = (s) => { const t = String(s || '').trim(); return !t || /^\(?기타\)?$|미기재|확인\s*불가/.test(t) ? UNK : chOf(t); };
    const shipCh = (s) => String(s || '').trim() === '기타' ? '기타 거래처' : chOf(s);
    const addCh = (c) => { if (!chMap.has(c)) chMap.set(c, { key: c, ea: 0, claims: 0, mclaims: 0, lots: new Set() }); return chMap.get(c); };
    const matched = new Set();
    for (const g of gm.values()) {
      const m = matchShip(g); if (!m.ships.length) continue;
      shippedLots++; shippedClaims += m.claims.length; for (const r of m.claims) matched.add(r);
      for (const s of m.ships) { const t = addCh(shipCh(s.cust)); t.ea += s.ea; t.lots.add(g.plot); shipYm.set(s.ym, (shipYm.get(s.ym) || 0) + s.ea); if (s.date) shipDays.push(s.date); }
    }
    for (const r of cl) { const t = addCh(claimCh(shopOf(r))); t.claims++; if (matched.has(r)) t.mclaims++; }
    const chEa = [...chMap.values()].reduce((a, t) => a + t.ea, 0);
    const channels = [...chMap.values()].map((t) => ({ ...t, unk: t.key === UNK, cvs: isCvsCh(t.key), eaShare: chEa ? t.ea / chEa : 0, clShare: N ? t.claims / N : 0, rate: t.ea ? t.mclaims / t.ea * 10000 : null }))
      .sort((a, b) => a.unk - b.unk || b.claims - a.claims || b.ea - a.ea);
    const cvsEaShare = chEa ? channels.filter((c) => c.cvs).reduce((a, c) => a + c.ea, 0) / chEa : 0;
    const cvsClShare = N ? channels.filter((c) => c.cvs).reduce((a, c) => a + c.claims, 0) / N : 0;
    const pc = (v) => `${Math.round(v * 100)}%`;
    // 출고 기간: 출고가 있는 달 (예: "10월", 두 달이면 "10~11월"), 출고일 범위
    const yms = [...shipYm.keys()].sort();
    const mon = (ym) => `${+ym.slice(5, 7)}월`;
    const shipPeriod = !yms.length ? '' : yms.length === 1 ? mon(yms[0]) : `${+yms[0].slice(5, 7)}~${mon(yms[yms.length - 1])}`;
    shipDays.sort();
    const shipRange = shipDays.length ? `${fmtDate(shipDays[0]).slice(5)}~${fmtDate(shipDays[shipDays.length - 1]).slice(5)}` : '';
    const shipYmText = yms.length > 1 ? yms.map((y) => `${mon(y)} ${n(Math.round(shipYm.get(y)))} EA`).join(' · ') : '';
    const dows = (ds) => [...new Set([...ds].filter(Boolean).sort())].map((d) => dow(d)).filter((v, i, a) => a.indexOf(v) === i).join('·');
    const groups = [...gm.values()].filter((g) => g.claims.length >= 2).map((g) => {
      const cul = [...g.cul.values()].map((c) => ({ ...c, age: Math.max(...[...c.fills].map((f) => c.out ? dd(f, c.out) + (c.press ? FP_AGE_EXTRA : 0) : -1)) })); // FP 보정은 model.js FP_AGE_EXTRA (v337: 0)
      const press = cul.some((c) => c.press), cloth = cul.some((c) => !c.press);
      const ages = cul.map((c) => c.age).filter((v) => Number.isFinite(v) && v >= 0);
      const maxAge = ages.length ? Math.max(...ages) : null;
      const flow = cul.length ? `${dows(cul.map((c) => c.brew))} 발효 → ${dows(cul.map((c) => c.out))} ${press && !cloth ? 'FP 유청분리' : '배출'} → ${dows(g.fills)} 충진` : '';
      const flowTitle = cul.map((c) => `${c.lot}: 배양 ${c.brew ? fmtDate(c.brew) : '?'} · 배출 ${c.out ? fmtDate(c.out) : '?'} · 충진 ${[...c.fills].map(fmtDate).join(', ')} (배출 후 ${c.age}일)`).join('\n');
      // 같은 충진일·설비에서 클레임이 난 다른 제품 LOT (같은 날 같은 반제를 썼을 수 있음)
      const sameDay = cl.filter((r) => r.plot !== g.plot && g.fills.has(r.pdate) && g.fillers.has(r.pfiller));
      // 같은 충진일·설비 자사검사 (달과 상관없이): 클레임 버퍼에서 뽑은 것 / 같은 LOT 다른 시간대 / 같은 날 다른 LOT
      // own = 그 검사 제품(버퍼·LOT)에서 나온 이 달 클레임 수: 일치 = 클레임 LOT 건수, 같은 LOT 다른 시간 = 0, 같은 날 다른 LOT = 그 LOT 클레임 수
      const insps = rows.filter((r) => r.kind === 'inspect' && g.fills.has(r.pdate) && g.fillers.has(r.pfiller)).map((r) => { const rel = ownBufs(r).some((b) => g.bufIds.has(b.id)) ? 'buf' : r.plot === g.plot ? 'lot' : 'day'; return { r, rel, own: rel === 'buf' ? g.claims.length : rel === 'lot' ? 0 : cl.filter((c) => c.lotGiven && c.plot === r.plot).length }; })
        .sort((a, b) => String(a.r.pdate).localeCompare(String(b.r.pdate)) || String(a.r.time).localeCompare(String(b.r.time)));
      const ymaxOf = (xs) => { const ys = xs.map((x) => x.r.yeast).filter((v) => v != null); return ys.length ? Math.max(...ys) : null; };
      const bufIns = insps.filter((x) => x.rel === 'buf');
      // 이 LOT의 출고처별 EA · 클레임 · 출고일과 출고 시 남은 소비기한
      const ms = matchShip(g);
      const shipCh = new Map(); for (const s of ms.ships) shipCh.set(chOf(s.cust), (shipCh.get(chOf(s.cust)) || 0) + s.ea);
      const shipEa = [...shipCh.values()].reduce((a, v) => a + v, 0);
      const clCh = new Map(); for (const r of g.claims) { const c = chOf(shopOf(r)); clCh.set(c, (clCh.get(c) || 0) + 1); }
      const exp = lotExpiry(g.plot);
      const sdates = ms.ships.map((s) => s.date).filter(Boolean).sort();
      const shipLeft = exp && sdates.length ? [dd(exp, sdates[sdates.length - 1]), dd(exp, sdates[0])] : null;
      const chRows = [...new Set([...shipCh.keys(), ...clCh.keys()])].map((c) => ({ c, ea: shipCh.get(c) || 0, share: shipEa ? (shipCh.get(c) || 0) / shipEa : 0, cl: clCh.get(c) || 0 })).sort((a, b) => b.cl - a.cl || b.ea - a.ea);
      // 출고 비중보다 클레임이 두 배 이상 몰린 채널 (같은 품목 출고와 맞춘 클레임 2건 이상)
      const mcl = ms.claims.length;
      const skew = shipEa && mcl >= 3 ? chRows.filter((x) => x.cl >= 2 && x.cl / mcl >= 2 * x.share && x.share < 0.5) : [];
      return { ...g, shipEa, chRows, shipItems: ms.items, shipClaims: mcl, shipDates: sdates, shipLeft, skew, cul, press, cloth, maxAge, flow, flowTitle, sameDay, insps, bufMax: ymaxOf(bufIns), bufMold: bufIns.some((x) => x.r.mold > 0), bufMoldN: bufIns.filter((x) => x.r.mold > 0).length, bufN: bufIns.length, otherMax: ymaxOf(insps.filter((x) => x.rel !== 'buf')), otherHi: insps.filter((x) => x.rel !== 'buf' && x.r.yeast != null && x.r.yeast >= 1000) };
    }).sort((a, b) => b.claims.length - a.claims.length || String(a.plot).localeCompare(String(b.plot)));
    const big = groups.filter((g) => g.claims.length >= 3);
    const focus = big.length ? big : groups;
    const skewed = focus.filter((g) => g.skew.length);
    const overAge = groups.filter((g) => g.maxAge != null && g.maxAge > AGE_LIMIT);
    // 공정 신호: 클레임 버퍼 자사검사 효모 1000 이상, 또는 곰팡이 검출 2건 이상 (한 건 10은 단발성으로 따로 적음)
    const bufBad = focus.filter((g) => (g.bufMax != null && g.bufMax >= 1000) || g.bufMoldN >= 2);
    const noLine = cl.filter((r) => !r.plot).length;
    const lotTxt = (g) => `${g.plot.replace(/^(\d{2})-(\d{4})\s*/, '20$1$2')}`;

    // 검토 의견
    const summary = [];
    if (!N) summary.push(`${ymLabel(ym)}에는 클레임이 없습니다.`);
    else {
      const top = types[0];
      summary.push(`${ymLabel(ym)} 클레임 ${n(N)}건 중 ${top.key} ${n(top.v)}건(${p1(top.v)})이 가장 많고, 변질·관능이상을 합하면 ${n(qualityN)}건(${p1(qualityN)})입니다.`);
      summary.push(`구매 채널은 편의점이 ${n(cvsN)}건(${p1(cvsN)})입니다.${focus.some((g) => g.shops.size >= 2) ? ' 같은 LOT의 클레임이 서로 다른 구매처에서도 나왔습니다.' : ''}`);
      if (chEa) summary.push(`출고처 기준(클레임이 걸린 제품 LOT ${n(shippedLots)}개 · 클레임 제품과 같은 품목의 전산 출고 ${n(Math.round(chEa))} EA, 클레임 ${n(N)}건): 편의점 출고 비중 ${pc(cvsEaShare)} · 클레임 비중 ${pc(cvsClShare)}. ${channels.filter((c) => c.cvs && (c.ea || c.claims)).map((c) => `${c.key} 출고 ${pc(c.eaShare)} → 클레임 ${n(c.claims)}건(${pc(c.clShare)})`).join(', ')}.${cvsClShare >= cvsEaShare * 1.3 && cvsClShare - cvsEaShare >= 0.15 ? ' 같은 LOT·같은 품목이라도 편의점으로 나간 제품에서 클레임이 출고 비중보다 많이 나왔습니다 (편의점은 점주 해피콜로 접수가 쉬워 접수율 자체가 높을 수 있다는 점도 감안).' : ''}`);
      if (known.length) summary.push(`소비기한이 확인되는 ${n(known.length)}건 중 ${n(nearN)}건(${p1(nearN, known.length)})이 소비기한 2일 전 이내(당일·경과 포함)에 접수됐습니다 — 소비기한 임박·경과 시점에 변질이 드러난 경우가 대부분입니다.`);
      for (const g of focus.slice(0, 5)) summary.push(`${lotTxt(g)} (${[...g.products].join('·')}) 클레임 ${n(g.claims.length)}건: ${!g.cul.length ? '배양 LOT 미연결(적힌 LOT로 충진 기록을 못 찾음)' : `${g.press && !g.cloth ? '필터프레스' : g.press ? '면포+필터프레스' : '면포'} · ${g.flow}`}${g.fillers.size ? ` · ${[...g.fillers].join('·')} ${[...g.fills].map((d) => `${fmtDate(d).slice(5)}(${dow(d)})`).join('·')}` : ''}${g.maxAge != null && g.maxAge >= 0 ? ` · 반제는 배출 후 최대 ${g.maxAge}일째 사용` : ''}${g.sameDay.length ? ` · 같은 날 같은 설비의 다른 LOT 클레임 ${n(g.sameDay.length)}건 더 있음` : ''}${g.shipEa ? ` · 같은 품목 출고 ${g.chRows.filter((x) => x.ea).slice(0, 4).map((x) => `${x.c} ${pc(x.share)}`).join('·')} / 클레임 ${g.chRows.filter((x) => x.cl).map((x) => `${x.c} ${x.cl}`).join('·')}${g.shipLeft ? ` · 출고 때 소비기한 ${g.shipLeft[0] === g.shipLeft[1] ? g.shipLeft[0] : `${g.shipLeft[0]}~${g.shipLeft[1]}`}일 남음` : ''}` : ''}.`);
      if (skewed.length) summary.push(`출고 비중보다 클레임이 몰린 채널: ${skewed.map((g) => `${lotTxt(g)} ${g.skew.map((x) => `${x.c}(출고 ${pc(x.share)} → 클레임 ${pc(x.cl / g.claims.length)})`).join(', ')}`).join(' / ')} — 그 채널의 배송·매장 보관 온도를 우선 확인할 필요가 있습니다.`);
      else if (focus.some((g) => g.shipEa)) summary.push('동일 LOT 클레임은 출고 비중과 비슷하게 여러 채널에서 나왔습니다 — 편의점 한 곳의 문제라기보다 LOT 공통 요인(제조 또는 공통 물류 구간)을 함께 봐야 합니다.');
      if (groups.length) summary.push(overAge.length ? `배출 후 72시간(3일)을 넘긴 반제를 쓴 LOT: ${overAge.map((g) => `${lotTxt(g)}(${g.maxAge}일)`).join(', ')}.` : '동일 LOT 복수 클레임에서 배출 후 72시간(3일)을 넘겨 사용한 반제는 없습니다.'); // v330: '3일째 반제 기준 경계' 문장 삭제 (사용자 요청)
      const withBuf = focus.filter((g) => g.bufN);
      if (withBuf.length) summary.push(`클레임 시간대(같은 버퍼) 자사검사: ${withBuf.map((g) => `${lotTxt(g)} ${n(g.bufN)}건 효모 최대 ${yTxt(g.bufMax)}${g.bufMoldN ? `·곰팡이 검출 ${n(g.bufMoldN)}건` : ''}`).join(', ')}${withBuf.every((g) => (g.bufMax == null || g.bufMax < 1000) && g.bufMoldN < 2) ? ' — 출하 전 검사로는 클레임과 이어지는 이상이 보이지 않습니다' : ''}.`);
      const hi = focus.flatMap((g) => g.otherHi.map((x) => ({ g, x })));
      if (hi.length) summary.push(`같은 날 같은 설비의 다른 시간대·다른 LOT 검사에서는 효모가 높았지만(${[...new Set(hi.map(({ x }) => `${lot7(x.r.plot || '')} ${x.r.stage !== '(미기재)' ? x.r.stage : ''} ${x.r.time} ${yTxt(x.r.yeast)}`.replace(/\s+/g, ' ').trim()))].slice(0, 3).join(', ')}) 그 제품의 클레임은 없습니다 — 자사 효모 결과와 실제 클레임이 반드시 일치하지는 않습니다(변질 전에 판매·소비될 수 있음).`);
      if (noLine) summary.push(`라인(LOT)이 적히지 않아 제품 LOT로 묶지 못한 클레임이 ${n(noLine)}건 있습니다.`);
    }
    const processSignal = overAge.length > 0 || bufBad.length > 0;
    const conclusion = !N ? [] : processSignal ? [
      `제조 공정에서 확인할 신호가 있습니다: ${[...(overAge.length ? [`배출 후 3일 넘은 반제 사용(${overAge.map(lotTxt).join(', ')})`] : []), ...(bufBad.length ? [`클레임 시간대 자사검사 이상(${bufBad.map((g) => `${lotTxt(g)} 효모 ${yTxt(g.bufMax)}${g.bufMold ? '·곰팡이' : ''}`).join(', ')})`] : [])].join(' · ')}. 해당 LOT의 발효·유청분리·충진 이력과 세척 기록을 먼저 확인하세요.`,
      ...(cvsN / N >= 0.5 && known.length && nearN / known.length >= 0.7 ? ['접수가 소비기한 임박·경과 시점과 편의점 채널에 몰려 있어 유통·보관 단계 온도 관리도 함께 확인할 필요가 있습니다.'] : []),
      ...(skewed.length ? [`${skewed.map((g) => `${lotTxt(g)}의 ${g.skew.map((x) => x.c).join('·')}`).join(', ')}처럼 출고 비중보다 클레임이 몰린 채널은 해당 채널의 유통 단계 원인도 함께 봐야 합니다.`] : []),
    ] : [
      ...(skewed.length ? [`출고 비중보다 클레임이 몰린 채널이 있습니다(${skewed.map((g) => `${lotTxt(g)} ${g.skew.map((x) => x.c).join('·')}`).join(', ')}). 같은 LOT인데 특정 채널에서만 많이 나왔다면 제조보다 그 채널의 배송·매장 보관 문제일 가능성이 큽니다.`] : []),
      '동일 LOT 복수 클레임의 발효·유청분리·충진 공정과 자사검사 이력을 비교했지만, 지금 자료로는 클레임과 직접 연결되는 제조 공정상 원인이 특정되지 않습니다.',
      ...(known.length && nearN / known.length >= 0.5 ? [`접수가 소비기한 임박·경과 시점${cvsN / N >= 0.5 ? '과 편의점 유통 채널' : ''}에 몰려 있어, 유통·보관 중 냉장 온도 이탈(콜드체인) 가능성을 고려해야 합니다. 온도가 벗어나면 효모 등 미생물이 늘어 소비기한 임박 시점에 변질·관능이상으로 나타날 수 있습니다(추정).`] : []),
    ];
    // ---------- v333 계절 요인 (환절기): 봄 3~5월 · 가을 9~11월. 이 달 클레임 내용·전월 추이·자사검사 효모와 엮어서 씀 ----------
    const curMon = +ym.slice(5, 7);
    const season = [9, 10, 11].includes(curMon) ? '가을 환절기' : [3, 4, 5].includes(curMon) ? '봄 환절기' : '';
    const why = (r) => `${exOf(r, '클레임 내용')} ${r.cause}`;
    const moldN = cl.filter((r) => /곰팡이/.test(why(r))).length;
    const yeastN = cl.filter((r) => !/곰팡이/.test(why(r)) && /효모|팽창|부풂|이미|이취|알코올|시큼|쉰/.test(why(r))).length;
    const daysIn = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 0)).getUTCDate(); };
    const curDays = ym === today().slice(0, 7) ? Math.max(1, +today().slice(8, 10)) : daysIn(ym);
    const pym = addMonth(ym, -1); const prevN = rows.filter((r) => r.kind === 'claim' && r.month === pym).length;
    const perDay = N / curDays, prevPerDay = prevN / daysIn(pym);
    const insM = rows.filter((r) => r.kind === 'inspect' && r.month === ym && r.yeast != null);
    const insOver = insM.filter((r) => r.yeast > YEAST_LIMIT).length;
    const seasonal = [];
    if (N) {
      if (prevN && perDay >= prevPerDay * 1.3) seasonal.push(`하루 평균 클레임이 ${+pym.slice(5)}월 ${n(prevPerDay, 1)}건 → ${curMon}월 ${n(perDay, 1)}건으로 늘었습니다${season ? ` (${season})` : ''}.`);
      if (season && known.length && nearN / known.length >= 0.5) seasonal.push(`유통·매장 온도 관리: 날이 선선해지면 하차장 대기, 냉장 진열대 문 열어 두기 같은 일이 잦아지는데 낮 기온은 아직 높아 짧은 온도 이탈이 생기기 쉽습니다. 이 달 접수의 ${p1(nearN, known.length)}가 소비기한 2일 전 이내(당일·경과 포함)였습니다.`);
      if (season && moldN) seasonal.push(`결로: 일교차가 크면 차가운 제품이 따뜻한 곳으로 옮겨질 때 뚜껑·실링에 물이 맺혀 곰팡이가 자라기 쉽고, 공장 안 천장·배관 결로가 떨어지는 것도 환절기에 흔한 오염 경로입니다 (이 달 곰팡이 클레임 ${n(moldN)}건).`);
      if (season === '가을 환절기' && moldN) seasonal.push('공기 중 곰팡이 포자: 가을은 실외 곰팡이 포자가 가장 많은 시기로 알려져 있어, 외기 유입·공조 필터 상태에 따라 충진실 낙하균이 늘 수 있습니다.');
      if (yeastN) seasonal.push(`효모는 냉장에서도 천천히 자라 한 번 온도가 벗어나면 빠르게 늘고, 가스로 팽창을 일으키거나 이미·이취를 냅니다. 그래서 소비기한 임박·경과 시점에 드러납니다 (이 달 효모·팽창·이미 관련 ${n(yeastN)}건).`);
      if (insM.length >= 10 && insOver / insM.length >= 0.7) seasonal.push(`이 달 자사검사 효모가 ${n(insM.length)}건 중 ${n(insOver)}건(${p1(insOver, insM.length)}) 사내 기준 ${YEAST_LIMIT}을 넘었습니다 — 유통만이 아니라 공장 안 효모 부하도 함께 올라간 신호입니다.`);
    }
    // v334 종합 판단 (원인 판단 끝에): 환절기 + 효모·곰팡이 클레임이면, 공장 안 신호(자사검사 효모 기준 초과·같은 날 다른 버퍼 고효모)와
    //  유통 신호(소비기한 임박·경과 접수 집중)를 함께 보고 "둘이 겹침" / "유통 쪽이 더 큼"으로 정리
    if (N && season && (moldN || yeastN)) {
      const plantSig = [];
      if (insM.length && insOver / insM.length >= 0.5) plantSig.push(`자사검사 효모 기준(${YEAST_LIMIT}) 초과 ${p1(insOver, insM.length)}`);
      const hiOther = focus.flatMap((g) => g.otherHi.map((x) => x.r.yeast)); if (hiOther.length) plantSig.push(`같은 날 다른 버퍼 자사검사 효모 최대 ${yTxt(Math.max(...hiOther))}`);
      if (moldN) plantSig.push(`곰팡이 클레임 ${n(moldN)}건`);
      const distSig = known.length && nearN / known.length >= 0.5;
      if (distSig && plantSig.length >= 2) conclusion.push(`종합: 이번 증가는 ${season} 환경(공기·결로)으로 공장 안 효모·곰팡이 부하가 오른 것과 유통 단계 온도 이탈이 겹친 것으로 보입니다 (공장 쪽: ${plantSig.join(', ')} · 유통 쪽: 소비기한 2일 전 이내 접수 ${p1(nearN, known.length)}).`);
      else if (distSig) conclusion.push(`종합: 공장 안 효모·곰팡이 부하가 올라간 신호는 아직 자료로 뚜렷하지 않아, 이번 증가는 ${season} 유통 단계 온도 이탈 쪽 가능성이 더 큽니다 (소비기한 2일 전 이내 접수 ${p1(nearN, known.length)}). 낙하균 측정으로 공장 쪽도 확인이 필요합니다.`);
      else if (plantSig.length >= 2) conclusion.push(`종합: ${season} 환경(공기·결로)으로 공장 안 효모·곰팡이 부하가 오른 신호가 있습니다 (${plantSig.join(', ')}).`);
    }
    const actions = !N ? [] : [
      ...(season && (moldN || yeastN) ? [`${season} 점검: 충진실·유청분리실 낙하균(효모·곰팡이) 측정, 천장·배관 결로 점검, 공조 필터 교체 주기를 확인합니다.`, '자사검사 효모를 주별 추이로 보고 오르기 시작한 시점을 확인합니다 (작년 같은 시기 클레임이 있으면 비교).'] : []),
      `동일 LOT 클레임이 3건 이상이면 발효·유청분리·충진 이력과 자사검사 결과를 비교합니다${big.length ? ` (이번 달: ${big.map(lotTxt).join(', ')})` : ''}.`,
      '효모 3일차 중간 카운팅으로 이상 징후를 미리 확인하고 클레임 접수 내역과 연결해 관리합니다.',
      ...(!processSignal && cvsN / N >= 0.5 ? ['사업본부 등 유관부서와 협조해 3PL 업체의 유통·보관 단계 냉장 온도 관리를 요청합니다.'] : []),
      ...(skewed.length ? [`클레임이 몰린 채널(${[...new Set(skewed.flatMap((g) => g.skew.map((x) => x.c)))].join('·')})의 해당 LOT 배송일 온도 기록과 매장 진열 온도를 확인 요청합니다.`] : []),
      '클레임 LOT의 출고처별 출고 EA와 클레임 건수를 같이 보고, 출고 비중보다 클레임이 몰린 채널이 있는지 매달 확인합니다 (출고현황 엑셀을 올려야 계산됨).',
      // v331: 반제는 배출 후 3일까지 정상, 4일 이상만 문제 (사용자 기준)
      ...(overAge.length ? [`배출 4일 이상 반제를 쓴 LOT(${overAge.map(lotTxt).join(', ')})의 반출 순서를 점검합니다 (반제품 현황 · 반제 사용 현황).`] : []),
      ...(noLine ? ['클레임 관리대장의 라인(LOT) 칸을 빠짐없이 적도록 요청합니다.'] : []),
    ];
    return { N, types, qualityN, shops, cvsN, known, bands, nearN, qN: qcl.length, qKnownN: qKnown.length, qNear, ageBands, ageBandsCloth, ageKnown, ageTot, ageClaims, groups, p1, conclusion, summary, actions, seasonal, season, remOf, channels, chEa, shippedLots, shippedClaims, pc, shipPeriod, shipRange, shipYmText };
  }, [view, rows, ym, state.shipments, state.shiplots]);

  const causeView = () => {
    if (!ca) return '';
    if (!ca.N) return html`<${Card}>${emptyRow}<//>`;
    const { p1 } = ca;
    // v335 세로 막대 공용: 위에 %, 아래에 구간 이름 + 수량(건/포). 높이는 가장 큰 구간 기준
    const vbars = (bands, total, unit) => { const bmax = Math.max(1, ...bands.map((b) => b.v)); const H = 130; const lab = (b) => b.label.replace(/^소비기한\s*/, '').replace(/\s*접수$/, '');
      const fmtV = (v) => unit === '포' ? n(Math.round(v)) : n(v);
      return html`<div style="display:flex;align-items:flex-end;gap:8px;padding:4px 2px 0;border-bottom:1px solid var(--line-strong)" role="img" aria-label=${bands.map((b) => `${lab(b)} ${fmtV(b.v)}${unit}`).join(', ')}>
        ${bands.map((b) => html`<div key=${b.key} style=${`flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;${b.v ? '' : 'opacity:.5'}`} title=${`${lab(b)} ${fmtV(b.v)}${unit} (${p1(b.v, total)})`}>
          <div style="font-size:13px;white-space:nowrap;margin-bottom:4px;font-weight:700">${p1(b.v, total)}</div>
          <div style=${`width:60%;max-width:90px;height:${Math.max(b.v ? 3 : 0, b.v / bmax * H)}px;background:${b.color};border-radius:6px 6px 0 0`}></div>
        </div>`)}
      </div>
      <div style="display:flex;gap:8px;padding:6px 2px 0;font-size:12.5px">
        ${bands.map((b) => html`<div key=${b.key} style=${`flex:1 1 0;min-width:0;text-align:center;line-height:1.35;${b.v ? '' : 'opacity:.5'}`}><div style="white-space:nowrap">${lab(b)}</div><b>${fmtV(b.v)}${unit}</b></div>`)}
      </div>`; };
    // v338: 숫자를 다 맞춤 — '기타'·'(미기재)'는 빼지 않고 '확인 불가' 한 줄로 맨 아래, 비율은 이 달 전체 건수 기준 + 합계 줄
    const isEtc = (k) => /^\(?기타\)?$|미기재/.test(String(k).trim());
    const withUnk = (list) => { const known = list.filter((t) => !isEtc(t.key)); const u = list.filter((t) => isEtc(t.key)).reduce((a, t) => a + t.v, 0); return u ? [...known, { key: '확인 불가', v: u, unk: true }] : known; };
    const typesAll = withUnk(ca.types), shopsAll = withUnk(ca.shops);
    const cvsShown = shopsAll.filter((s) => s.cvs).reduce((a, s) => a + s.v, 0);
    const qShown = typesAll.filter((t) => /변질|관능/.test(t.key)).reduce((a, t) => a + t.v, 0);
    const relChip = { buf: html`<span class="chip bad" title="클레임 제품과 같은 충진 버퍼(같은 시간대)에서 뽑은 검사">일치</span>`, lot: html`<span class="chip">같은 LOT 다른 시간</span>`, day: html`<span class="chip">같은 날 다른 LOT</span>` };
    // 클레임 사유: 그 LOT 클레임의 내용(세부유형)을 많은 순으로 "곰팡이 5 · 이미 2"
    const causeTxt = (g) => { const m = new Map(); for (const r of g.claims) { const k = exOf(r, '클레임 내용') || r.cause; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '); };
    const detail = ca.groups.flatMap((g) => [...g.claims, ...g.sameDay.map((r) => ({ ...r, _same: true }))].map((r, i) => ({ ...r, _g: g, _k: `${g.plot}-${i}` })));
    return html`
      <div class="grid2" style="align-items:start">
        <${Card} title="클레임 유형" desc=${`${ymLabel(ym)} · ${n(ca.N)}건`} flush>
          <${DataTable} rows=${typesAll} keyFn=${(r) => r.key} rowClass=${(r) => r.unk ? 'row-muted' : ''} total=${{ v: ca.N }} cols=${[
            { key: 'key', label: '구분', render: (r) => html`<b>${r.key}</b>`, sub: (r) => r.unk ? '유형 기타·미기재' : '' },
            { key: 'v', label: '건수', num: true, render: (r) => `${n(r.v)}건`, total: (x) => html`<b>${n(x.v)}건</b>` },
            { key: 'p', label: '비율', num: true, render: (r) => p1(r.v, ca.N), total: () => '100%' },
          ]} />
          <div class="note" style="padding:8px 14px">변질·관능이상 합계 <b>${n(qShown)}건 (${p1(qShown, ca.N)})</b> · 배송·파손 같은 서비스 클레임은 가져올 때 뺐습니다</div>
        <//>
        <${Card} title="구매 채널" desc=${`편의점 = gs25 · CU · 세븐일레븐 · 이마트24 · 미니스톱 · ${n(ca.N)}건`} flush>
          <${DataTable} rows=${shopsAll} keyFn=${(r) => r.key} rowClass=${(r) => r.unk ? 'row-muted' : ''} total=${{ v: ca.N }} cols=${[
            { key: 'key', label: '구매처', render: (r) => html`<b>${r.key}</b>${r.cvs ? html` <span class="chip sky">편의점</span>` : ''}`, sub: (r) => r.unk ? '구매처 기타·미기재' : '' },
            { key: 'v', label: '건수', num: true, render: (r) => `${n(r.v)}건`, total: (x) => html`<b>${n(x.v)}건</b>` },
            { key: 'p', label: '비중', num: true, render: (r) => p1(r.v, ca.N), total: () => '100%' },
          ]} />
          <div class="note" style="padding:8px 14px">편의점 채널 <b>${n(cvsShown)}건 (${p1(cvsShown, ca.N)})</b> · 그 밖 ${n(ca.N - cvsShown)}건</div>
        <//>
      </div>

      <div class="grid2" style="align-items:stretch">
      <${Card} title="접수 시점 잔여 소비기한" desc=${`변질·관능이상 ${n(ca.qN)}건 · 접수일 − 소비기한 · 2일 전 이내 ${n(ca.qNear)}건 (${p1(ca.qNear, ca.qN)})`}>
        ${vbars(ca.bands, ca.qN, '건')}
        ${ca.qN - ca.qKnownN > 0 && html`<div class="muted" style="font-size:12.5px;margin-top:10px">확인 불가 = 소비기한 미기재·확인불가</div>`}
      <//>
      ${/* v341: 처음 모양(v335)으로 되돌림 — 클레임 제품 버퍼에 쓰인 반제 포 수 기준 */ ''}
      <${Card} title="클레임 제품의 반제 경과">
        ${ca.ageTot ? vbars(ca.ageBandsCloth, ca.ageTot, '포') : html`<div class="empty">배양 LOT까지 연결된 클레임이 없습니다.</div>`}
        <div class="muted" style="font-size:12.5px;margin-top:10px">3일까지 정상 · 4일 이상이면 문제</div>
      <//>
      </div>

      <${Card} title="출고처별 클레임" desc=${ca.chEa ? `이 달 클레임이 걸린 제품 LOT ${n(ca.shippedLots)}개 · 클레임 제품과 같은 품목의 전산 출고(출고현황) ${n(Math.round(ca.chEa))} EA · 클레임 ${n(ca.N)}건 (출고와 맞춘 ${n(ca.shippedClaims)}건으로 만 EA당 계산)${ca.shipYmText ? ` · ${ca.shipYmText}` : ''} · 사내 출고 제외 · 클레임 비중이 출고 비중의 2배 이상이면 빨강` : '출고현황(전산 출하현황) 엑셀을 올리면 클레임 LOT가 어느 거래처로 몇 EA 나갔는지 함께 봅니다'} flush>
        ${ca.chEa ? html`<${DataTable} rows=${ca.channels.filter((c) => c.claims > 0)} keyFn=${(c) => c.key} rowClass=${(c) => c.unk ? 'row-muted' : ''}
          total=${{ ea: ca.chEa, claims: ca.N }} cols=${[
          { key: 'key', label: '출고처', render: (c) => html`<b>${c.key}</b>${c.cvs ? html` <span class="chip sky">편의점</span>` : ''}`, sub: (c) => c.unk ? '구매처 기타·미기재' : c.lots.size ? `클레임 LOT ${n(c.lots.size)}개로 출고${c.mclaims < c.claims ? ` · 출고와 못 맞춘 클레임 ${n(c.claims - c.mclaims)}건` : ''}` : '출고 기록 없음' },
          { key: 'ea', label: ca.shipPeriod ? html`<span style="display:inline-block;text-align:center;line-height:1.25"><span style="font-size:11.5px;color:var(--fg-2)">${ca.shipPeriod}${ca.shipRange ? ` (${ca.shipRange})` : ''}</span><br />출고 EA</span>` : '출고 EA', num: true, render: (c) => c.ea ? n(Math.round(c.ea)) : html`<span class="muted">${c.unk ? '—' : '0'}</span>`, total: (x) => n(Math.round(x.ea)) },
          { key: 'es', label: '출고 비중', num: true, render: (c) => c.unk ? html`<span class="muted">—</span>` : p1(c.ea, ca.chEa), total: () => '100%' },
          { key: 'cl', label: '클레임', num: true, render: (c) => c.claims ? html`<b style=${c.unk ? '' : 'color:var(--bad)'}>${n(c.claims)}건</b>` : html`<span class="muted">0</span>`, total: (x) => html`<b>${n(x.claims)}건</b>` },
          { key: 'cs', label: '클레임 비중', num: true, render: (c) => html`<b style=${!c.unk && c.claims >= 2 && c.clShare >= 2 * c.eaShare ? 'color:var(--bad)' : ''}>${p1(c.claims, ca.N)}</b>`, total: () => '100%' },
          { key: 'rate', label: '만 EA당', num: true, render: (c) => c.rate == null ? html`<span class="muted">—</span>` : n(c.rate, 1), total: () => '' },
        ]} />
        ${(() => { const hid = ca.channels.filter((c) => !c.claims); return hid.length ? html`<div class="note" style="padding:8px 14px">클레임 없는 출고처 ${n(hid.length)}곳은 줄을 숨기고 합계에만 넣음 · 출고 ${n(Math.round(hid.reduce((a, c) => a + c.ea, 0)))} EA (${p1(hid.reduce((a, c) => a + c.ea, 0), ca.chEa)}) — ${hid.slice(0, 5).map((c) => `${c.key} ${p1(c.ea, ca.chEa)}`).join(', ')}${hid.length > 5 ? ' 외' : ''}</div>` : ''; })()}` : html`<div class="empty">출고 자료가 있는 클레임 LOT가 없습니다.</div>`}
      <//>

      <${Card} title="동일 LOT 복수 클레임 · 제조 공정" count=${ca.groups.length} desc=${`같은 제품 LOT에서 클레임 2건 이상 · 반제 경과 = 충진일 − 배출일 (${AGE_LIMIT}일까지 정상, ${AGE_LIMIT + 1}일 이상이면 빨강)`} flush>
        <${DataTable} rows=${ca.groups} keyFn=${(g) => g.plot} empty=${html`<div class="empty">같은 LOT에서 2건 이상 나온 클레임이 없습니다.</div>`} cols=${[
          { key: 'lot', label: 'LOT', render: (g) => html`<b>${g.plot}</b>`, sub: (g) => [...g.products].join(' · ') },
          { key: 'n', label: '클레임', num: true, render: (g) => html`<b style="color:var(--bad)">${n(g.claims.length)}건</b>`, sub: (g) => { const m = new Map(); for (const r of g.claims) { const k = exOf(r, '클레임 내용') || r.cause; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '); } },
          { key: 'src', label: '유청분리', render: (g) => html`${g.cloth ? html`<span class="chip sky">면포</span> ` : ''}${g.press ? html`<span class="chip accent">필터프레스</span>` : ''}${!g.cul.length ? html`<span class="muted">—</span>` : ''}` },
          { key: 'filler', label: '충진 설비', render: (g) => [...g.fillers].join(' · ') || '—' },
          { key: 'fill', label: '충진일', render: (g) => [...g.fills].sort().map((d) => html`<div key=${d} style="white-space:nowrap">${fmtDate(d)}(${dow(d)})</div>`) },
          { key: 'age', label: '반제 경과', num: true, render: (g) => g.maxAge == null ? '—' : html`<b style=${g.maxAge > AGE_LIMIT ? 'color:var(--bad)' : ''}>최대 ${g.maxAge}일</b>` },
          { key: 'ship', label: '출고처 (출고 비중 → 클레임)', render: (g) => g.chRows.length ? html`<div style="font-size:12.5px;line-height:1.5;white-space:nowrap">${g.chRows.filter((x) => x.ea || x.cl).slice(0, 5).map((x) => html`<div key=${x.c} style=${g.skew.includes(x) ? 'color:var(--bad);font-weight:700' : ''}>${x.c} ${g.shipEa ? ca.pc(x.share) : '—'} → ${x.cl ? `${x.cl}건` : '0'}</div>`)}</div>` : html`<span class="muted">—</span>`, sub: (g) => g.shipEa ? `${g.shipItems.slice(0, 2).join(', ')}${g.shipItems.length > 2 ? ' 외' : ''}${g.shipLeft ? ` · 출고 때 소비기한 ${g.shipLeft[0] === g.shipLeft[1] ? g.shipLeft[0] : `${g.shipLeft[0]}~${g.shipLeft[1]}`}일 남음` : ''}` : '같은 품목 출고 자료 없음' },
          { key: 'insp', label: '자사검사 (일치)', num: true, render: (g) => g.bufN ? html`<b style=${yTone(g.bufMax) ? `color:${yTone(g.bufMax)}` : ''}>효모 ${yTxt(g.bufMax)}</b>${g.bufMold ? html` <span class="chip bad">곰팡이</span>` : ''}` : html`<span class="muted">없음</span>`, sub: (g) => g.otherMax != null ? `같은 날 다른 검사 최대 ${yTxt(g.otherMax)}` : '' },
        ]} />
      <//>

      ${detail.length > 0 && html`<${Card} title="동일 LOT 복수 클레임 세부 내역" count=${detail.length} desc="같은 날 같은 설비에서 충진된 다른 LOT 클레임도 흐리게 함께 보여 줍니다" flush>
        <${DataTable} rows=${detail} keyFn=${(r) => r._k} rowClass=${(r) => r._same ? 'row-muted' : ''} cols=${[
          { key: 'd', label: '접수일', render: (r) => r.date ? fmtDate(r.date) : '—' },
          { key: 'in', label: '인입경로', render: (r) => exOf(r, '인입경로') || '—', sub: (r) => exOf(r, '구매처') },
          { key: 'name', label: '클레임 제품명', render: (r) => r.pname || r.product, sub: (r) => exOf(r, '클레임 내용') || r.cause },
          { key: 'exp', label: '소비기한', render: (r) => html`<span style="white-space:nowrap">${r.expiry ? fmtDate(r.expiry) : '—'}${r.time ? ` ${r.time}` : ''}</span>`, sub: (r) => { const d = ca.remOf(r); return d == null ? '' : d < 0 ? `경과 ${-d}일 후 접수` : d === 0 ? '당일 접수' : `${d}일 전 접수`; } },
          { key: 'lot', label: 'LOT', render: (r) => html`<b>${r.plot}</b>` },
          { key: 'fill', label: '충진', render: (r) => r.pdate ? html`<span style="white-space:nowrap">${fmtDate(r.pdate)}(${dow(r.pdate)})</span>` : '—', sub: (r) => r.pfiller },
          { key: 'src', label: '유청분리', render: (r) => r.src },
        ]} />
      <//>`}

      ${ca.groups.some((g) => g.insps.some((x) => x.rel === 'buf')) && html`<${Card} title="자사검사 확인" desc="동일 LOT 복수 클레임 제품과 같은 충진 버퍼(같은 시간대)에서 뽑은 자사검사만 (달과 상관없이)" flush>
        <${DataTable} rows=${ca.groups.flatMap((g) => g.insps.filter((x) => x.rel === 'buf').map((x, i) => ({ ...x, g, k: `${g.plot}-${i}` })))} keyFn=${(x) => x.k}
          groups=${[{ label: '', span: 4 }, { label: '자사검사', span: 3 }]} cols=${[
          { key: 'g', label: '클레임 LOT', width: '14.28%', mergeKey: (x) => x.g.plot, render: (x) => html`<b>${x.g.plot}</b>`, sub: (x) => { const ts = x.g.claims.map((r) => r.time).filter(Boolean).sort(); return html`${[...x.g.fillers].join('·')} ${[...x.g.fills].sort().map(fmtDate).join(', ')}${ts.length ? html`<br />클레임 제품 제조 ${ts[0] === ts[ts.length - 1] ? ts[0] : `${ts[0]}~${ts[ts.length - 1]}`}` : ''}`; } },
          { key: 'why', label: '클레임 사유', width: '14.28%', mergeKey: (x) => x.g.plot, render: (x) => causeTxt(x.g) || html`<span class="muted">—</span>`, sub: (x) => `${n(x.g.claims.length)}건` },
          { key: 'lot', label: '검사 제품 LOT', width: '14.28%', render: (x) => x.r.plot || '—', sub: (x) => [x.r.stage !== '(미기재)' ? x.r.stage : '', x.r.time].filter(Boolean).join(' · ') },
          { key: 'rel', label: '관계', width: '14.28%', render: (x) => relChip[x.rel], sub: (x) => x.rel === 'buf' ? '클레임 제품과 같은 시간대' : x.own ? `이 LOT 클레임 ${n(x.own)}건` : '이 제품 클레임 없음' },
          { key: 'y', label: '효모', width: '14.28%', num: true, render: (x) => x.r.yeast == null ? html`<span class="muted">—</span>` : yCell(x.r.yeast) },
          { key: 'm', label: '곰팡이', width: '14.28%', num: true, render: (x) => x.r.mold == null ? html`<span class="muted">—</span>` : x.r.mold > 0 ? html`<b style="color:var(--bad)">${yTxt(x.r.mold)}</b>` : '<10' },
          { key: 'd', label: '검사일', width: '14.28%', render: (x) => x.r.date ? fmtDate(x.r.date) : '—' },
        ]} />
      <//>`}

      <${Card} title="검토 의견">
        <div class="ncr-opinion">
          <h3>분석 결과</h3>
          <ul>${ca.summary.map((t, i) => html`<li key=${i}>${t}</li>`)}</ul>
          <h3>원인 판단</h3>
          <ul>${ca.conclusion.map((t, i) => html`<li key=${i}>${t}</li>`)}</ul>
          ${ca.seasonal.length > 0 && html`<h3>계절 요인${ca.season ? ` (${ca.season})` : ''}</h3>
          <ul>${ca.seasonal.map((t, i) => html`<li key=${i}>${t}</li>`)}</ul>`}
          <h3>향후 조치</h3>
          <ul>${ca.actions.map((t, i) => html`<li key=${i}>${t}</li>`)}</ul>
          <div class="op-note">생산팀 클레임 접수 내역 분석(2026.11.10)과 같은 순서·기준으로 자동 계산한 참고 의견입니다. 유통 온도 이탈은 자료로 확인할 수 없는 추정이라 3PL 온도 기록으로 확인해야 합니다.</div>
        </div>
      <//>`;
  };

  // ---------- PDF 저장: 지금 보는 화면(종합/클레임/자사검사)을 한 번에 캡처해 A4 세로로 나눔. 카드·표 줄 경계에서만 자름 ----------
  const viewLabel = VIEW.find((v) => v.value === view).label;
  const [shooting, setShooting] = useState(false);
  const savePdf = async () => {
    if (shooting) return;
    setShooting(true);
    try {
      const mod = await import('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.esm.js');
      const h2c = mod.default || window.html2canvas;
      await new Promise((r) => setTimeout(r, 120)); // 캡처용 머리글이 그려질 시간
      const el = document.getElementById('ncr-shot'); if (!el) throw new Error('화면을 찾지 못했습니다');
      const bg = getComputedStyle(document.body).backgroundColor;
      el.style.width = '1040px'; void el.offsetWidth;
      const need = Math.max(1040, ...[...el.querySelectorAll('.table-wrap')].map((w) => w.scrollWidth + 34));
      el.style.width = `${Math.min(need, 2000)}px`; void el.offsetWidth;
      await new Promise((r) => setTimeout(r, 40));
      const top = el.getBoundingClientRect().top;
      const cuts = new Set();
      for (const c of el.querySelectorAll(':scope > *, .card, .grid2, tr, .stats, .op-box, h3')) { const b = Math.round(c.getBoundingClientRect().bottom - top); if (b > 0) cuts.add(b); }
      const SCALE = 2;
      let canvas;
      try { canvas = await h2c(el, { scale: SCALE, backgroundColor: bg, useCORS: true, logging: false }); } finally { el.style.width = ''; }
      if (!canvas || !canvas.width) throw new Error('화면을 그리지 못했습니다');
      const pageH = Math.floor(canvas.width * (774 / 555)); // A4 세로에서 여백 뺀 비율
      const cutPx = [...cuts].map((v) => v * SCALE).sort((a, b) => a - b);
      const images = []; let y = 0;
      while (y < canvas.height - 4) {
        let end = Math.min(canvas.height, y + pageH);
        if (end < canvas.height) { const c = cutPx.filter((v) => v > y + pageH * 0.4 && v <= end); if (c.length) end = c[c.length - 1]; }
        const pc = document.createElement('canvas'); pc.width = canvas.width; pc.height = end - y;
        const g = pc.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, pc.width, pc.height);
        g.drawImage(canvas, 0, y, canvas.width, end - y, 0, 0, canvas.width, end - y);
        const blob = await new Promise((r) => pc.toBlob(r, 'image/jpeg', 0.92));
        if (!blob) throw new Error(`${images.length + 1}장 이미지를 만들지 못했습니다`);
        images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: pc.width, h: pc.height });
        y = end;
      }
      if (images.length && await saveFile(`클레임자사검사현황_${viewLabel}_${ym}.pdf`, buildPdf(images))) toast(`PDF ${images.length}페이지를 저장했습니다.`);
    } catch (e) { toast(`PDF 저장 실패: ${e.message || e}`, 'bad'); }
    setShooting(false);
  };

  return html`<div class="ncr">
    <div class="page-head"><div><div class="eyebrow">Nonconformance</div><h1>클레임/자사검사 현황</h1></div>
      <div class="actions">
        <button class="btn primary" disabled=${shooting || !rows.length} onClick=${savePdf} title=${`지금 보는 화면(${viewLabel} · ${ymLabel(ym)})을 A4 세로 PDF로 저장`}><${Icon} name="download" />${shooting ? 'PDF 만드는 중…' : 'PDF 저장'}</button>
        <button class="btn" onClick=${() => go('claim')}><${Icon} name="alert" />클레임 LOT</button>
        <button class="btn" onClick=${() => go('inspect')}><${Icon} name="check" />자사검사</button>
      </div></div>

    <${Card}>
      <div class="filters" style="align-items:flex-end">
        <div><div style="font-size:12px;color:var(--fg-2);margin-bottom:4px">구분</div><${Segmented} options=${VIEW} value=${view} onChange=${setView} /></div>
        <div><div style="font-size:12px;color:var(--fg-2);margin-bottom:4px">월</div>
          <div class="row" style="gap:6px;flex-wrap:nowrap">
            <button class="icon-btn" aria-label="이전 달" onClick=${() => setYm(addMonth(ym, -1))}><${Icon} name="left" /></button>
            <b style="min-width:96px;text-align:center;font-size:15px">${ymLabel(ym)}</b>
            <button class="icon-btn" aria-label="다음 달" onClick=${() => setYm(addMonth(ym, 1))}><${Icon} name="right" /></button>
            ${ymSel && ymSel !== latest && html`<button class="btn sm ghost" onClick=${() => setYm('')}>최근 달</button>`}
          </div></div>
      </div>
    <//>

    <div id="ncr-shot" class=${`shot-page ${shooting ? 'shooting' : ''}`}>
    ${shooting && html`<div class="shot-head"><b>${ymLabel(ym)} 클레임/자사검사 현황 · ${viewLabel}</b><span>${state.settings.companyName} · ${fmtDate(today())} 출력</span></div>`}
    ${!rows.length ? html`<${Card}><${Empty} title="아직 저장된 부적합 기록이 없습니다">클레임 LOT 또는 자사검사에서 목록을 올리고 "저장"을 누르면 여기에 통계가 쌓입니다.<//><//>` : html`
    ${/* v290: 부적합 합계 · 배양 LOT까지 추적 · 가장 많은 품목 · 가장 많은 설비 카드 삭제 (사용자 요청) */ ''}

    ${view === 'all' && html`<${Card} title="겹치는 LOT" count=${overlap.length} desc=${`이 달 클레임이 걸린 LOT ${n(claimLots.length)}개 · 자사검사와 겹친 것 ${n(overlap.length)}개 (위) · 겹치는 자사검사가 없는 것 ${n(claimLots.length - overlap.length)}개 (아래, 흐리게)`} flush>
      <div class="stats" style="padding:14px 14px 4px">
        <${Stat} k="겹치는 LOT" v=${n(overlap.length)} unit="개" s=${`클레임이 걸린 LOT ${n(claimBufCount)}개 중`} />
        <${Stat} k="자사검사와 겹친 클레임" v=${n(ovClaims)} unit="건" s=${`클레임 ${n(cnt('claim'))}건 중 ${pctOf(ovClaims, cnt('claim'))}`} />
        <${Stat} k="겹친 LOT 효모 중앙값" v=${yTxt(ovMed)} s=${`겹치지 않은 LOT ${yTxt(nonOvMed)}`} />
        <${Stat} k="겹친 LOT 중 필터프레스" v=${n(overlap.filter((b) => b.press).length)} unit="개" s=${`면포 ${n(overlap.filter((b) => b.cloth && !b.press).length)}개`} />
      </div>
      <div class="ncr-fixed"><${DataTable} rows=${claimLots} keyFn=${(b) => b.id} rowClass=${(b) => b.insps.length ? '' : 'row-muted'} groups=${[{ label: '', span: 1 }, { label: '클레임', span: 3 }, { label: '자사검사', span: 1 + OV_TESTS.length }]} empty=${html`<div class="empty">이 달에 배양 LOT까지 추적된 클레임이 없습니다.</div>`} cols=${[
        { key: 'date', label: '충진일', width: '9%', render: (b) => html`<span style="white-space:nowrap">${fmtDate(b.date)}(${dow(b.date)})</span>`, sub: (b) => [b.filler, bufText(b.labels || [])].filter(Boolean).join(' · ') },
        { key: 'lot', label: '제품 LOT · 품목', width: '17%', render: (b) => b.lots.map((l, i) => { const open = () => go('trace', { q: l.lot, mode: 'product', packKey: `${l.rawLot || l.lot}|${l.code}` }); // 제품 LOT·품목명 어느 쪽을 눌러도 LOT 추적으로 (v265)
          return html`<div key=${i}><button class="linkish" style="font-weight:700" title="LOT 추적에서 이 제품 LOT 보기" onClick=${open}>${l.lot}</button> <button class="linkish" style="font-size:12px;color:var(--fg-2)" title="LOT 추적에서 이 제품 LOT 보기" onClick=${open}>${l.product}</button></div>`; }) },
        { key: 'culture', label: '배양 LOT', width: '15%', render: (b) => b.cultures.length ? b.cultures.map((c, i) => html`<div key=${i} style="white-space:nowrap">${c.lot} ${c.press ? html`<span class="chip accent">필터프레스</span>` : html`<span class="chip sky">면포</span>`}</div>`) : html`<span class="muted">—</span>` },
        { key: 'claims', label: '클레임', width: '16%', num: true, render: (b) => html`<b style="color:var(--bad)">${n(b.claims.length)}</b>`, sub: (b) => html`${b.causeText}${b.times.length ? html`<br />제조 ${timeSpan(b.times)}` : ''}` },
        { key: 'insp', label: '자사검사', width: '15%', render: (b) => {
          const other = b.otherInsps.length ? html`<div class="muted" style="font-size:11px;margin-top:3px;white-space:normal" title="같은 제품 LOT지만 클레임 제품과 다른 버퍼(시간대)에서 뽑은 검사라 비교에서 뺐습니다">다른 시간대 검사 ${n(b.otherInsps.length)}건 뺌<br />(${[...new Set(b.otherInsps.map(otherTxt))].join(', ')})</div>` : '';
          if (!b.insps.length) return html`<span class="muted" style="font-size:12.5px">${b.otherInsps.length ? '클레임 시간대 자사검사 없음' : '겹치는 자사검사 없음'}</span>${other}`;
          const ds = [...new Set(b.insps.map((r) => r.date).filter(Boolean))].sort(); return html`${stageCell(b.insps)}${ds.length ? html`<div class="muted" style="font-size:11.5px;margin-top:2px">검사 ${ds.map((d) => d.slice(5).replace('-', '.')).join(', ')}${ds.some((d) => !d.startsWith(ym)) ? ' (다른 달 포함)' : ''}</div>` : ''}${other}`; } },
        ...OV_TESTS.map(([l, h], i) => ({ key: `t-${h}`, cls: i === 0 || i === OV_TESTS.length - 1 ? 'vl' : '', label: html`<span style="white-space:pre;display:inline-block;text-align:center">${l}</span>`, width: '7%', render: (b) => b.insps.length ? testCellOv(b.insps, h) : html`<span class="muted">—</span>` })),
      ]} /></div>
    <//>`}

    ${view === 'cause' && causeView()}

    ${isKindView && html`<${Card} title="재공품 유형별 원인 현황">
      ${!shown.length ? emptyRow : html`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:18px;align-items:center">
        <div style="border:1px solid var(--line);border-radius:10px;overflow:hidden"><${DataTable} rows=${causes} keyFn=${(c) => c} cols=${crossCols} total=${{}} /></div>
        <${StackedBars} mixes=${mixes} causes=${causes} cell=${cell} />
      </div>`}
    <//>`}

    ${view === 'claim' && html`<${Card} title="발효탱크 LOT별" count=${byLot.filter((r) => r.key !== '(연결 없음)').length} flush>
      <${DataTable} rows=${byLot} keyFn=${(r) => r.key} empty=${emptyRow} cols=${[
        { key: 'key', label: '발효탱크 LOT', render: (r) => html`<b>${r.key}</b>`, sub: (r) => { const t = lotInfo.get(r.key); return t && t.tank ? t.tank : ''; } },
        { key: 'prod', label: '품목', render: lotProducts },
        { key: 'fill', label: '충진일', render: lotDates },
        { key: 'filler', label: '호기', render: lotFillers },
        { key: 'exp', label: '소비기한 (제품 LOT)', render: lotExps },
        { key: 'src', label: '구분', render: srcCell },
        { key: 'total', label: '클레임', num: true, render: (r) => html`<b style="color:var(--bad)">${n(r.total)}</b>` },
        { key: 'cause', label: '원인', render: (r) => lotCauseText(r.key) || html`<span class="muted">—</span>` },
        { key: 'share', label: '비중', num: true, render: (r) => pct(shown.length ? r.total / shown.length * 100 : null, 0) },
      ]} />
    <//>`}

    ${isKindView && yRows.length > 0 && html`<${Card} title="효모 통계 (자사검사)">
      <div class="stats" style="margin-bottom:14px">
        <${Stat} k="면포 효모 중앙값" v=${yTxt(yCloth.med)} s=${`${n(yCloth.total)}건 · 1000 이상 ${n(yCloth.ge1000)}건 (${pctOf(yCloth.ge1000, yCloth.total)})`} />
        <${Stat} k="필터프레스 효모 중앙값" v=${yTxt(yPress.med)} s=${`${n(yPress.total)}건 · 1000 이상 ${n(yPress.ge1000)}건 (${pctOf(yPress.ge1000, yPress.total)})`} />
        <${Stat} k="곰팡이 검출" v=${`${pctOf(yPress.molds, yPress.total)}`} s=${`필터프레스 ${n(yPress.molds)}건 · 면포 ${n(yCloth.molds)}건 (${pctOf(yCloth.molds, yCloth.total)})`} />
        <${Stat} k="효모 1000 이상" v=${n(yRows.filter((r) => r.yeast >= 1000).length)} unit="건" s=${`${n(yRows.length)}건 중 · 최대 ${yTxt(Math.max(...yRows.map((r) => r.yeast)))}`} />
      </div>
      <${YeastLines} rows=${yRows} ym=${ym} />
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 8px"><span style="font-size:12.5px;color:var(--fg-2)">묶어 보기</span><${Segmented} options=${Y_SPLITS} value=${ySplit} onChange=${setYSplit} /></div>
      <div class=${ySplit === 'tank' ? 'ncr-tree' : ''} style="border:1px solid var(--line);border-radius:10px;overflow:hidden">
        <${DataTable} rows=${yGroups} keyFn=${(r) => r.key} empty=${emptyRow} rowClass=${(r) => r.level === 1 ? 'sub-row' : ''}
          onRowClick=${ySplit === 'tank' ? (r) => { if (r.level === 0) toggleTank(r.key); } : null} cols=${[
          { key: 'key', label: ySplit === 'tank' ? '배양 탱크 · 배양 LOT (탱크를 누르면 LOT 펼치기)' : Y_SPLITS.find((s) => s.value === ySplit).label,
            render: (r) => r.level === 1 ? html`<span style="padding-left:20px;color:var(--fg-2);font-size:12.5px">└ ${r.label}</span>`
              : ySplit === 'tank' ? html`<span style="display:inline-flex;align-items:center;gap:6px"><span style=${`display:inline-block;width:10px;color:var(--fg-2);transition:transform .15s;transform:rotate(${r.open ? 90 : 0}deg)`}>▸</span><b>${r.key}</b><span class="muted" style="font-size:12px">LOT ${n(r.lotCount)}개</span></span>`
              : html`<b>${r.key}</b>` },
          { key: 'total', label: '검사', num: true, render: (r) => n(r.total) },
          { key: 'med', label: '중앙값', num: true, render: (r) => yCell(r.med) },
          { key: 'mean', label: '평균', num: true, render: (r) => n(r.mean, 0) },
          { key: 'max', label: '최대', num: true, render: (r) => yCell(r.max) },
          { key: 'ge500', label: '500 이상', num: true, render: (r) => `${n(r.ge500)} (${pctOf(r.ge500, r.total)})` },
          { key: 'ge1000', label: '1000 이상', num: true, render: (r) => r.ge1000 ? html`<b style="color:var(--bad)">${n(r.ge1000)}</b> (${pctOf(r.ge1000, r.total)})` : html`<span class="muted">0</span>` },
          { key: 'molds', label: '곰팡이 검출', num: true, render: (r) => `${n(r.molds)} (${pctOf(r.molds, r.total)})` },
        ]} />
      </div>
    <//>`}

    ${isKindView && yRows.length > 0 && html`<${Card} title="제품 LOT·품목별 효모" count=${prodLotYeast.length} desc=${prodLotYeast.length > 10 ? '문제 많은 순 상위 10개' : ''} flush>
      <div class="sticky-head"><${DataTable} rows=${allPL || shooting ? prodLotYeast : prodLotYeast.slice(0, 10)} keyFn=${(r) => r.key} empty=${emptyRow} cols=${[
        { key: 'lot', label: '제품 LOT · 품목', render: (r) => { const open = r.pcode ? () => go('trace', { q: r.plot, mode: 'product', packKey: `${r.prawLot || r.plot}|${r.pcode}` }) : null; // 누르면 LOT 추적에서 그 제품 LOT·품목
          return html`${open ? html`<button class="linkish" style="font-weight:700" title="LOT 추적에서 이 제품 LOT·품목 열기" onClick=${open}>${r.plot}</button>` : html`<b>${r.plot || '(제품 LOT 미연결)'}</b>`}<div>${open ? html`<button class="linkish" style="font-size:12.5px;color:var(--fg-2)" title="LOT 추적에서 이 제품 LOT·품목 열기" onClick=${open}>${r.product}</button>` : html`<span style="font-size:12.5px;color:var(--fg-2)">${r.product}</span>`}</div>`; } },
        { key: 'fill', label: '충진일 · 호기', render: (r) => r.fills.length ? r.fills.sort((a, b) => a.d.localeCompare(b.d)).map((f, i) => html`<div key=${i} style="white-space:nowrap">${fmtDate(f.d)}(${dow(f.d)}) <span class="muted">${f.f}</span></div>`) : html`<span class="muted">—</span>` },
        { key: 'cul', label: '배양 LOT', render: (r) => r.cultures.length ? r.cultures.map((c, i) => html`<div key=${i} style="white-space:nowrap">${c.lot} ${c.drink && !c.press && !c.cloth ? html`<span class="chip">드링크</span>` : c.press ? html`<span class="chip accent">필터프레스</span>` : html`<span class="chip sky">면포</span>`}</div>`) : html`<span class="muted">—</span>` },
        // v256: '검사' 건수 대신 초·중·말 검사 횟수를 세로로 (구분 미기재는 '기타')
        { key: 'stages', label: '초·중·말', render: (r) => stageCell(r.insps) },
        { key: 'med', label: '효모 중앙값', num: true, render: (r) => yCell(r.med) },
        { key: 'max', label: '최대', num: true, render: (r) => yCell(r.max) },
        { key: 'hi', label: '1000 이상', num: true, render: (r) => r.hi ? html`<b style="color:var(--bad)">${n(r.hi)}</b>` : html`<span class="muted">0</span>` },
        { key: 'mold', label: '곰팡이 검출', num: true, render: (r) => r.molds ? n(r.molds) : html`<span class="muted">0</span>` },
      ]} /></div>
      ${prodLotYeast.length > 10 && !shooting && html`<div style="padding:8px 14px"><button class="linkish" onClick=${() => setAllPL(!allPL)}>${allPL ? '상위 10개만 보기' : `나머지 ${prodLotYeast.length - 10}개 펼치기`}</button></div>`}
    <//>`}

    ${isKindView && html`<div class="grid2" style="align-items:start">
      <${Card} title="품목별" count=${byProduct.length} desc=${byProduct.length > 10 ? '건수 많은 순 상위 10개' : ''} flush>
        <${DataTable} rows=${allProd || shooting ? byProduct : byProduct.slice(0, 10)} keyFn=${(r) => r.key} cols=${cols('품목', view === 'inspect' ? [...STAGE_COLS, ...SRC_COLS] : SRC_COLS)} empty=${emptyRow} />
        ${byProduct.length > 10 && !shooting && html`<div style="padding:8px 14px"><button class="linkish" onClick=${() => setAllProd(!allProd)}>${allProd ? '상위 10개만 보기' : `나머지 ${byProduct.length - 10}개 품목 펼치기`}</button></div>`}
      <//>
      <${Card} title="충진 설비별" flush>
        <${DataTable} rows=${byFiller} keyFn=${(r) => r.key} cols=${cols('설비', SRC_COLS)} empty=${emptyRow} />
      <//>
    </div>`}

    ${view === 'all' && html`<${Card} title="분석 의견">
      <div class="ncr-opinion">
        <h3>현황 요약</h3>
        <ul>${opinion.summary.map((t, i) => html`<li key=${i}>${t}</li>`)}</ul>
        <h3>원인 추정</h3>
        <ul>${opinion.causes.map((t, i) => html`<li key=${i}>${t}</li>`)}</ul>
        <h3>조치 제안</h3>
        <div class="op-grid">
          ${opinion.actions.map((a) => html`<div key=${a.title} class="op-box"><b>${a.title}</b><ul>${a.items.map((t, i) => html`<li key=${i}>${t}</li>`)}</ul></div>`)}
        </div>
        <div class="op-note">${opinion.note}</div>
      </div>
    <//>`}`}
    </div>
  </div>`;
}
