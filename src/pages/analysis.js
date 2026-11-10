// 생산실적 분석: 일간 / 주간 / 월간 KPI, 설비별·일별·제품별·LOT별 표, 추이 차트
import { html, useState, useMemo, Card, Stat, Chip, Icon, Field, Segmented, DataTable, BarLineChart, DonutChart, exportCSV, saveFile, toast } from '../ui.js';
import { analyze } from '../model.js';
import { n, pct, sum, fmtDate, fmtMD, dow, addDays, weekRange, weeksOfMonth, monthRange, today, addMonths, prevBusinessDay, buildPdf } from '../util.js';

const PERIODS = [{ value: 'day', label: '일간' }, { value: 'week', label: '주간' }, { value: 'month', label: '월간' }];

export function AnalysisPage({ state, params, go }) {
  const [period, setPeriod] = useState(params.period || 'month');
  // 일간은 항상 전 영업일(토·일·공휴일 제외)로 시작: 전날 실적을 다음 영업일에 봄. 월간·주간은 오늘 기준
  const [date, setDate] = useState(params.date || ((params.period || 'month') === 'day' ? prevBusinessDay() : today()));
  const changePeriod = (p) => { if (p === 'day' && period !== 'day') setDate(prevBusinessDay()); setPeriod(p); };
  const [fillerId, setFillerId] = useState('');

  // 주간 (v318): 달·주차를 고르지 않고 한 주(일~토)씩 이동. 기본은 이번 주, 비교·추이는 그 주까지 최근 5주
  //  주 이름은 토요일이 속한 달 기준 "11월 2주차"
  const ym = date.slice(0, 7);
  const thisWeek = weekRange(today()).from;
  const [wk, setWk] = useState(() => weekRange(params.date || today()).from);
  const weekName = (from) => { const m = addDays(from, 6).slice(0, 7); const w = weeksOfMonth(m).find((x) => x.from === from); return { m, n: w ? w.n : 1, text: `${Number(m.slice(5))}월 ${w ? w.n : 1}주차` }; };
  const curWeek = { from: wk, to: addDays(wk, 6), ...weekName(wk) };
  const range = useMemo(() => period === 'day' ? { from: date, to: date } : period === 'week' ? { from: wk, to: addDays(wk, 6) } : monthRange(ym), [period, date, wk, ym]);
  const a = useMemo(() => analyze(state, { ...range, fillerId }), [state, range, fillerId]);
  const chartRange = useMemo(() => period === 'day' ? { from: addDays(date, -13), to: date } : range, [period, date, range]);
  const chart = useMemo(() => analyze(state, { ...chartRange, fillerId }), [state, chartRange, fillerId]);
  // 월간: 막대그래프 옆 도넛은 금월, 월별 실적 비교 옆 도넛은 최근 4개월(지금 보는 달 포함, 월별 추이·비교와 같은 기간) 재공품 유형별 비중
  const mix3 = useMemo(() => period === 'month' ? analyze(state, { from: monthRange(addMonths(ym, -3)).from, to: range.to, fillerId }).byMix : [], [state, period, ym, range.to, fillerId]);
  const mix3Label = `${Number(addMonths(ym, -3).slice(5))}월~${Number(ym.slice(5))}월`;
  const setMonth = (nextYm) => { setDate(nextYm + '-01'); };
  const shift = (dir) => {
    if (period === 'day') { setDate(addDays(date, dir)); return; }
    if (period === 'month') { setDate(addMonths(ym, dir) + '-01'); return; }
    // 주간: 한 주씩 (이번 주 다음으로는 안 감)
    const nw = addDays(wk, 7 * dir);
    if (nw > thisWeek) return;
    setWk(nw);
  };
  const t = a.total;
  const legacyDays = (state.legacy || []).filter((d) => d.date >= range.from && d.date <= range.to).sort((x, y) => x.date.localeCompare(y.date));
  // 월별·주별 시리즈: 월간은 최근 4개월(마지막이 지금 보는 달), 주간은 지금 보는 주까지 최근 5주 (v318)
  const WEEKS_N = 5;
  const series = useMemo(() => {
    if (period === 'day') return [];
    const list = [];
    if (period === 'month') for (let i = 3; i >= 0; i--) { const m = addMonths(ym, -i); list.push({ key: m, label: `${m.slice(0, 4)}년 ${Number(m.slice(5))}월`, short: `${Number(m.slice(5))}월`, ...monthRange(m) }); }
    else for (let i = WEEKS_N - 1; i >= 0; i--) { const from = addDays(wk, -7 * i), to = addDays(from, 6); const w = weekName(from); list.push({ key: from, label: `${w.text} (${fmtMD(from)}~${fmtMD(to)})`, short: `${Number(w.m.slice(5))}/${w.n}주`, from, to }); }
    return list.map((s) => ({ ...s, ...analyze(state, { from: s.from, to: s.to, fillerId }).total }));
  }, [state, period, ym, wk, fillerId]);
  const curIdx = period === 'week' ? series.findIndex((s) => s.from === range.from) : series.length - 1;
  const cur = curIdx >= 0 ? series[curIdx] : null;
  // 전주/전월: 시리즈 안의 바로 앞 칸. 1주차면 지난달 마지막 주를 따로 계산
  const prev = useMemo(() => {
    if (!cur) return null;
    if (curIdx > 0) return series[curIdx - 1];
    if (period !== 'week') return null;
    const from = addDays(cur.from, -7), to = addDays(from, 6); const wm = to.slice(0, 7); const wk = weeksOfMonth(wm).find((w) => w.from === from);
    return { key: from, label: `${Number(wm.slice(5))}월 ${wk ? wk.n : ''}주차 (${fmtMD(from)}~${fmtMD(to)})`, short: `${Number(wm.slice(5))}/${wk ? wk.n : ''}주`, from, to, ...analyze(state, { from, to, fillerId }).total };
  }, [series, curIdx, period, state, fillerId]);
  // 전월·전주 대비 비교 지표 (bad: 늘면 나쁜 지표, point: %p 차이로만 표시, neutral: 색 없음)
  const CMP = [
    { k: 'persons', label: '인원', unit: '명', neutral: true },
    { k: 'goodEa', label: '생산량', unit: 'ea' }, { k: 'weighedKg', label: '계근량', unit: 'kg', d: 0 },
    { k: 'yieldPct', label: '충진 수율', unit: '%', d: 1, point: true }, { k: 'defectEa', label: '불량', unit: 'ea', bad: true },
    { k: 'eaPerPerson', label: '1인당', unit: 'ea/명' },
  ];
  const cmpRows = prev ? CMP.map((m) => { const c = cur[m.k], p = prev[m.k]; const diff = c != null && p != null ? c - p : null; const rate = m.point || diff == null ? null : (p ? diff / Math.abs(p) * 100 : null); return { ...m, key: m.k + m.unit, c, p, diff, rate }; }) : [];
  const fmtV = (m, v) => v == null ? '—' : m.point ? pct(v, m.d) : n(v, m.d || 0);
  const diffTone = (m, diff) => diff == null || diff === 0 || m.neutral ? '' : (diff > 0) !== !!m.bad ? 'good' : 'bad';
  const label = period === 'day' ? `${fmtDate(date)}(${dow(date)}) 하루 실적` : period === 'week' ? `${curWeek.text} · ${fmtDate(range.from)}(일) ~ ${fmtDate(range.to)}(토)` : `${fmtDate(range.from)} ~ ${fmtDate(range.to)} 월 전체`;

  const kpiCols = [
    { key: 'label', label: '구분' },
    { key: 'goodEa', label: '양품 (ea)', num: true, render: (r) => n(r.goodEa), total: (x) => n(x.goodEa) },
    { key: 'goodKg', label: '양품 (kg)', num: true, render: (r) => n(r.goodKg), total: (x) => n(x.goodKg) },
    { key: 'weighedKg', label: '계근량 (kg)', num: true, render: (r) => n(r.weighedKg), sub: (r) => r.wasteKg > 0 ? `폐기 ${n(r.wasteKg)}` : '', total: (x) => n(x.weighedKg) },
    { key: 'wheyYieldPct', label: '발효유 수율', num: true, render: (r) => pct(r.wheyYieldPct), sub: (r) => r.fermentKg > 0 ? `발효유 ${n(r.fermentKg)} kg` : '', total: (x) => pct(x.wheyYieldPct) },
    { key: 'lossKg', label: 'LOSS (kg)', num: true, render: (r) => n(r.lossKg), sub: (r) => r.lossPct == null ? '' : pct(r.lossPct), total: (x) => n(x.lossKg) },
    { key: 'yieldPct', label: '충진 수율', num: true, render: (r) => pct(r.yieldPct), total: (x) => pct(x.yieldPct) },
    { key: 'defectPct', label: '불량률', num: true, render: (r) => pct(r.defectPct, 2), total: (x) => pct(x.defectPct, 2) },
    { key: 'persons', label: '인원', num: true, render: (r) => n(r.persons), sub: (r) => r.personsSource === 'headcount' ? '월 총인원' : '', total: (x) => n(x.persons) },
    { key: 'hours', label: '충진 (h)', num: true, render: (r) => n(r.hours, 1), total: (x) => n(x.hours, 1) },
    { key: 'kgPerPerson', label: '1인당 kg', num: true, render: (r) => n(r.kgPerPerson), total: (x) => n(x.kgPerPerson) },
    { key: 'kgPerHour', label: '시간당 kg', num: true, render: (r) => n(r.kgPerHour), total: (x) => n(x.kgPerHour) },
    { key: 'bpm', label: 'BPM', num: true, render: (r) => r.stdBpm && r.bpmPct != null ? html`<${Chip} tone=${r.bpmPct >= 100 ? 'good' : r.bpmPct >= 85 ? 'warn' : 'bad'}>${n(r.bpm, 1)}<//>` : n(r.bpm, 1), sub: (r) => r.stdBpm ? `기준 ${n(r.stdBpm, 1)} · ${pct(r.bpmPct, 0)}` : '', total: (x) => n(x.bpm, 1) },
  ];
  // 주별·월별 실적 비교 표: 가로 = 주/달, 세로 = 지표. 각 숫자 아래에 바로 앞 주/달과의 차이 (LOSS는 줄면 초록, 인원·근로시간은 색 없음)
  const unitWord = period === 'month' ? '달' : '주';
  const SER_METRICS = [
    { k: 'goodEa', label: '양품', unit: 'ea', d: 0 }, { k: 'goodKg', label: '양품', unit: 'kg', d: 0 },
    { k: 'weighedKg', label: '계근량', unit: 'kg', d: 0 }, { k: 'lossKg', label: 'LOSS', unit: 'kg', d: 0, bad: true },
    { k: 'wheyYieldPct', label: '발효유 수율', unit: '%', d: 1, point: true }, { k: 'yieldPct', label: '충진 수율', unit: '%', d: 1, point: true }, { k: 'persons', label: '인원', unit: '명', d: 0, neutral: true },
    { k: 'eaPerPerson', label: '1인당 생산량', unit: 'ea/명', d: 0 }, { k: 'hours', label: '충진시간', unit: 'h', d: 1, neutral: true },
  ];
  const diffCell = (m, v, pv) => {
    if (v == null || pv == null) return '—';
    const d = v - pv;
    if (Math.abs(d) < 1e-9) return html`<span class="diff flat">±0</span>`;
    const tone = m.neutral ? 'flat' : (d > 0) !== !!m.bad ? 'up' : 'down';
    const sign = d > 0 ? '+' : '';
    const txt = m.point ? `${sign}${n(d, m.d)}%p` : `${sign}${n(d, m.d)}${pv ? ` (${sign}${n(d / Math.abs(pv) * 100, 1)}%)` : ''}`;
    return html`<span class=${`diff ${tone}`}>${txt}</span>`;
  };
  const serCols = [
    { key: 'label', label: '지표', width: '18%', render: (r) => html`<b>${r.label}</b>`, sub: (r) => r.unit },
    ...series.map((s, i) => {
      const [head, tail] = s.label.split(' (');
      return { key: s.key, width: `${(82 / series.length).toFixed(2)}%`, label: html`${head}${tail ? html`<span class="sub">${tail.replace(/\)$/, '')}</span>` : ''}${s === cur ? html`<span class="sub">지금 보는 ${unitWord}</span>` : ''}`,
        render: (r) => { const v = fmtV(r, s[r.k]); return s === cur ? html`<b>${v}</b>` : v; },
        sub: (r) => i > 0 ? diffCell(r, s[r.k], series[i - 1][r.k]) : '' };
    }),
  ];
  const cmpCard = html`<${Card} style=${period === 'month' ? 'grid-column:1/3' : ''} title=${period === 'month' ? '월별 실적 비교 (최근 4개월)' : `주별 실적 비교 (최근 ${series.length}주)`} flush>
    <div class="series-cmp"><${DataTable} cols=${serCols} rows=${SER_METRICS} keyFn=${(r) => r.k + r.unit} empty=${html`<div class="empty">실적이 없습니다.</div>`} /></div>
  <//>`;
  const kpiRow = (r) => [r.label, r.goodEa, n(r.goodKg), n(r.weighedKg), n(r.wasteKg), n(r.fermentKg), r.wheyYieldPct == null ? '' : n(r.wheyYieldPct, 1), n(r.lossKg), r.lossPct == null ? '' : n(r.lossPct, 1), r.yieldPct == null ? '' : n(r.yieldPct, 1), r.persons, n(r.hours, 1), n(r.kgPerPerson), n(r.kgPerHour), n(r.bpm, 1), r.stdBpm ?? '', r.stdBpm ? n(r.bpmPct, 0) : ''];
  const doCSV = () => exportCSV(`생산실적_${range.from}_${range.to}.csv`, ['구분', '양품 ea', '양품 kg', '계근량 kg', '폐기 kg', '발효유 kg', '발효유 수율 %', 'LOSS kg', 'LOSS %', '충진 수율 %', '인원', '충진 h', '1인당 kg', '시간당 kg', 'BPM', '기준 BPM', 'BPM 달성률 %'],
    [kpiRow({ label: '전체', ...t }), ...a.byFiller.map(kpiRow), ...series.map(kpiRow), ...a.byDay.filter((d) => d.jobs).map(kpiRow)]);

  // PDF 저장(인쇄용): 화면을 묶음(일간 2장, 주간·월간 3장)으로 나눠 각각 캡처해 A4 세로 한 페이지씩 담은 PDF 한 파일로 저장.
  // 파일 하나라 아티팩트의 '파일 저장' 확인 창도 한 번이고, 인쇄하면 바로 페이지별로 나옴. html2canvas는 누를 때만 CDN에서 불러옴
  const [shooting, setShooting] = useState(false);
  const shotIds = period === 'day' ? ['an-shot-1', 'an-shot-2'] : ['an-shot-1', 'an-shot-2', 'an-shot-3'];
  // PDF 머리글 제목: "10월 생산실적 분석" / "10월 3주차 생산실적 분석" / "2026.10.30(금) 생산실적 분석"
  const shotLabel = period === 'month' ? `${Number(ym.slice(5))}월 생산실적 분석` : period === 'week' ? `${curWeek.text} 생산실적 분석` : `${fmtDate(date)}(${dow(date)}) 생산실적 분석`;
  const savePdf = async () => {
    if (shooting) return;
    setShooting(true);
    try {
      const mod = await import('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.esm.js');
      const h2c = mod.default || window.html2canvas;
      await new Promise((r) => setTimeout(r, 80)); // 캡처용 머리글이 그려질 시간
      const bg = getComputedStyle(document.body).backgroundColor;
      const images = [];
      for (const [i, id] of shotIds.entries()) {
        const el = document.getElementById(id); if (!el) continue;
        // 세로형 한 장: 기본 폭 1040px, 표가 더 넓으면 가장 넓은 표에 맞춰 넓힘 (max-content는 고정 레이아웃 표에서 폭이 폭발하므로 쓰지 않음)
        el.style.width = '1040px'; void el.offsetWidth;
        const need = Math.max(1040, ...[...el.querySelectorAll('.table-wrap')].map((w) => w.scrollWidth + 34));
        el.style.width = `${Math.min(need, 2400)}px`; void el.offsetWidth;
        await new Promise((r) => setTimeout(r, 30));
        let canvas;
        try { canvas = await h2c(el, { scale: 2, backgroundColor: bg, useCORS: true, logging: false }); } finally { el.style.width = ''; }
        if (!canvas || !canvas.width || canvas.width * canvas.height > 250e6) throw new Error(`${i + 1}장 크기가 너무 큽니다 (${canvas ? canvas.width + '×' + canvas.height : '없음'})`);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
        if (!blob) throw new Error(`${i + 1}장 이미지를 만들지 못했습니다`);
        images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height });
      }
      const name = `생산실적_${period === 'day' ? date : period === 'week' ? `${curWeek.m}_${curWeek.n}주차` : ym}.pdf`;
      if (images.length && await saveFile(name, buildPdf(images))) toast(`PDF ${images.length}페이지를 저장했습니다.`);
    } catch (e) { toast(`PDF 저장 실패: ${e.message || e}`, 'bad'); }
    setShooting(false);
  };
  const shotHead = (i) => shooting ? html`<div class="shot-head"><b>${shotLabel}</b><span>${state.settings.companyName} · ${i}/${shotIds.length} · ${fmtDate(today())} 출력</span></div>` : '';
  const prodTotal ={ lots: sum(a.byProduct, (r) => r.lots), qty: sum(a.byProduct, (r) => r.qty), kg: sum(a.byProduct, (r) => r.kg) };
  const days = a.byDay.filter((d) => d.jobs > 0).map((d) => ({ ...d, label: `${fmtMD(d.key)}(${dow(d.key)})` }));
  // 제품별 생산량 + 탱크별 수율: 일간은 2장 끝에, 주간·월간은 3장으로 따로 저장
  const prodTankBlock = html`<div class="grid2" style="align-items:start;grid-template-columns:minmax(300px,2fr) minmax(0,3fr)">
    <${Card} title="제품별 생산량" count=${a.byProduct.length} flush>
      <${DataTable} rows=${a.byProduct} keyFn=${(r) => r.key} cols=${[
        { key: 'label', label: '제품', render: (r) => html`<b>${r.label}</b>` },
        { key: 'qty', label: '수량 (ea)', num: true, render: (r) => n(r.qty), total: (x) => n(x.qty) },
        { key: 'kg', label: '중량 (kg)', num: true, render: (r) => n(r.kg), total: (x) => n(x.kg) },
        { key: 'share', label: '비중', num: true, render: (r) => pct(prodTotal.kg ? r.kg / prodTotal.kg * 100 : null, 0), total: () => '100%' },
      ]} total=${a.byProduct.length ? prodTotal : null} empty=${html`<div class="empty">포장 내역이 없습니다.</div>`} />
    <//>
    <${Card} title="탱크별 수율" count=${a.byTank.length}
      actions=${html`<button class="btn sm" onClick=${() => exportCSV(`탱크별수율_${range.from}_${range.to}.csv`, ['탱크', '배양 LOT 수', '원유 kg', '충진 이동 kg', '계근 투입 kg', '양품 kg', '수율 %', '충진 수율 %'],
        a.byTank.map((r) => [r.tank, r.lotCount, r.rawKg, n(r.usedKg), n(r.inputKg), n(r.goodKg), n(r.wheyPct, 1), n(r.fillYield, 1)]))}><${Icon} name="download" />CSV</button>`} flush>
      <${DataTable} rows=${a.byTank} keyFn=${(r) => r.tankId} cols=${[
        { key: 'tank', label: '탱크', render: (r) => html`<b>${r.tank}</b>`, sub: (r) => `LOT ${r.lotCount}건` },
        { key: 'rawKg', label: '원유 (kg)', num: true, render: (r) => n(r.rawKg), total: (x) => n(x.rawKg) },
        { key: 'usedKg', label: '충진 이동 (kg)', num: true, render: (r) => n(r.usedKg), total: (x) => n(x.usedKg) },
        { key: 'inputKg', label: '계근 (kg)', num: true, render: (r) => n(r.inputKg), total: (x) => n(x.inputKg) },
        { key: 'goodKg', label: '양품 (kg)', num: true, render: (r) => n(r.goodKg), total: (x) => n(x.goodKg) },
        { key: 'wheyPct', label: '수율', num: true, render: (r) => pct(r.wheyPct), total: (x) => pct(x.wheyPct) },
        { key: 'fillYield', label: '충진 수율', num: true, render: (r) => pct(r.fillYield), total: (x) => pct(x.fillYield) },
      ]} total=${a.byTank.length ? a.tankTotal : null} empty=${html`<div class="empty">해당 기간에 충진된 배양 LOT가 없습니다.</div>`} />
    <//>
  </div>`;

  return html`
    <div class="page-head"><div><div class="eyebrow">Production performance</div><h1>생산실적 분석</h1></div>
      <div class="actions"><button class="btn primary" disabled=${shooting} onClick=${savePdf} title=${`화면을 A4 세로 ${shotIds.length}페이지 PDF 한 파일로 저장 (인쇄용)`}><${Icon} name="download" />${shooting ? 'PDF 만드는 중…' : `PDF 저장 (${shotIds.length}장)`}</button><button class="btn" onClick=${doCSV}><${Icon} name="download" />CSV 저장</button></div></div>

    <${Card}>
      <div class="filters">
        <${Field} label="기간"><${Segmented} options=${PERIODS} value=${period} onChange=${changePeriod} /><//>
        ${period === 'week' ? html`
          <${Field} label="주 (일~토)"><div class="row" style="flex-wrap:nowrap;gap:8px"><button class="btn sm" aria-label="이전 주" onClick=${() => shift(-1)}><${Icon} name="left" /></button><b style="min-width:200px;text-align:center;font-size:14.5px;white-space:nowrap">${curWeek.text} <span class="muted" style="font-weight:400;font-size:13px">${fmtMD(curWeek.from)}~${fmtMD(curWeek.to)}</span></b><button class="btn sm" aria-label="다음 주" disabled=${wk >= thisWeek} onClick=${() => shift(1)}><${Icon} name="right" /></button>${wk !== thisWeek ? html`<button class="btn sm ghost" onClick=${() => setWk(thisWeek)}>이번 주</button>` : ''}</div><//>`
        : html`<${Field} label=${period === 'month' ? '기준 월' : '기준일'}><div class="row" style="flex-wrap:nowrap"><button class="btn sm" aria-label="이전" onClick=${() => shift(-1)}><${Icon} name="left" /></button>${period === 'month' ? html`<input id="an-month" type="month" class="input" style="width:140px" value=${ym} onInput=${(e) => e.target.value && setMonth(e.target.value)} />` : html`<input id="an-date" type="date" class="input" style="width:150px" value=${date} onInput=${(e) => e.target.value && setDate(e.target.value)} />`}<button class="btn sm" aria-label="다음" onClick=${() => shift(1)}><${Icon} name="right" /></button></div><//>`}
        <${Field} label="충진설비"><select id="an-filler" class="input" value=${fillerId} onChange=${(e) => setFillerId(e.target.value)}><option value="">전체</option>${state.settings.fillers.map((f) => html`<option key=${f.id} value=${f.id}>${f.name}</option>`)}</select><//>
        <div class="spacer"></div>
        <div class="note" style="align-self:center">${label} · 작업 ${n(t.jobs)}건${legacyDays.length ? html` · <span class="chip accent" title=${`전산 생산_백데이타 엑셀에서 옮긴 실적 (${legacyDays[0].date} ~ ${legacyDays[legacyDays.length - 1].date}). 실적 입력 화면에는 없고 분석에만 합산됩니다.`}>전산 백데이터 ${legacyDays.length}일 포함</span>` : ''}</div>
      </div>
    <//>

    <div id="an-shot-1" class=${`shot-page ${shooting ? 'shooting' : ''}`}>
    ${shotHead(1)}
    <div class="stats">
      <${Stat} hero k="수율" v=${pct(t.yieldPct)} s=${shooting ? '' : `양품 kg ÷ (계근량 − 폐기) · LOSS ${n(t.lossKg)} kg${t.quantityOnly > 0 ? ` · 계근 없는 ${n(t.quantityOnly)}건 제외` : ''}`} />
      <${Stat} k="생산량" v=${n(t.goodEa)} unit="ea" s=${`${n(t.goodKg)} kg · 불량 ${n(t.defectEa)} ea`} />
      <${Stat} k="1인당 생산량" v=${n(t.eaPerPerson)} unit="ea/명" s=${`${n(t.kgPerPerson)} kg/명 · 인원 ${n(t.persons)}명${t.personsSource === 'headcount' && !shooting ? ` (${Number(t.headcountYm.slice(5))}월 총인원)` : ''}`} />
      <${Stat} k="시간당 생산량" v=${n(t.eaPerHour)} unit="ea/h" s=${`${n(t.kgPerHour)} kg/h`} />
      <${Stat} k="충진시간" v=${n(t.hours, 1)} unit="h" s="설비별 가동 시간 합 (휴게 제외)" />
    </div>

    ${t.jobs === 0 && html`<div class="banner info"><${Icon} name="alert" /><span>선택한 기간에 충진/포장 실적이 없습니다. 실적 입력 → 충진/포장에서 입력하거나 기간을 바꿔 보세요.</span><span class="spacer"></span><button onClick=${() => go('fill', { date })}>충진/포장 입력</button></div>`}

    <div class=${`chart-row ${period !== 'day' && prev ? 'three' : ''}`}>
    ${period !== 'day' && prev && html`<${Card} title=${period === 'month' ? '전월 대비' : '전주 대비'} desc=${`${prev.label} → ${cur.label}`} flush>
          <div class="compact"><${DataTable} rows=${cmpRows} keyFn=${(r) => r.key} cols=${[
            { key: 'label', label: '지표', render: (r) => html`<b>${r.label}</b>`, sub: (r) => r.unit || '' },
            { key: 'c', label: period === 'month' ? '이번 달' : '이번 주', num: true, render: (r) => html`<b>${fmtV(r, r.c)}</b>` },
            { key: 'p', label: period === 'month' ? '전월' : '전주', num: true, render: (r) => fmtV(r, r.p) },
            { key: 'diff', label: '차이 (증감률)', num: true, render: (r) => r.diff == null ? '—' : html`<${Chip} tone=${diffTone(r, r.diff)}>${r.diff > 0 ? '+' : ''}${r.point ? `${n(r.diff, 1)}%p` : n(r.diff, r.d || 0)}<//>`, sub: (r) => r.rate == null ? (r.point || r.p ? '' : '전기 없음') : `${r.rate > 0 ? '+' : ''}${n(r.rate, 1)}%` },
          ]} /></div>
        <//>`}
      ${period === 'day'
        ? html`<${Card} title="충진 설비별 생산" desc=${`${fmtDate(date)}(${dow(date)})`}>
            ${a.byFiller.filter((r) => r.jobs > 0).length === 0 ? html`<div class="empty">이 날 충진 실적이 없습니다.</div>`
              : html`<${BarLineChart} data=${a.byFiller.filter((r) => r.jobs > 0).map((r) => ({ label: r.label, title: r.label, persons: r.persons, runMin: r.runMin, stdBpm: r.stdBpm, bpmPct: r.bpmPct, bar: r.goodEa, bar2: r.weighedKg, line: r.yieldPct, bpm: r.bpm }))} barLabel="양품 ea" barUnit=" ea" bar2Label="계근량 kg" bar2Unit=" kg" bar2Digits=${0} lineLabel="수율" lineUnit="%" lineMin=${0} lineMax=${100} width=${560} height=${290} hideBarAxis sub=${(d) => [`${n(d.bar)} ea`, `${n(d.bar2)} kg`]} extra=${(d) => `${d.line == null ? '수율 — (계근량 미입력) · ' : ''}가동 ${n(d.runMin)}분 · 인원 ${n(d.persons)}명${d.bpm != null ? ` · BPM ${n(d.bpm, 1)}` : ''}${d.stdBpm ? ` (기준 ${n(d.stdBpm, 1)} · 달성 ${pct(d.bpmPct, 0)})` : ''}`} />`}
          <//>`
        : html`<${Card} title=${period === 'month' ? '월별 추이 (최근 4개월)' : `주별 추이 (최근 ${series.length}주)`}>
            <${BarLineChart} data=${series.map((s) => ({ label: s.short, title: s.label, persons: s.persons, bar: s.weighedKg, bar2: s.goodEa, line: s.yieldPct, hl: s === cur }))} barLabel="계근량 kg" barUnit=" kg" barDigits=${0} bar2Label="양품 ea" bar2Unit=" ea" lineLabel="수율" lineUnit="%" lineMin=${0} lineMax=${100} width=${prev ? 440 : 560} height=${prev ? 330 : 290} hideBarAxis sub=${(d) => [`${n(d.bar2)} ea`, `${n(d.bar)} kg`]} extra=${(d) => `인원 ${n(d.persons)}명`} />
          <//>`}
      ${period === 'month'
        ? html`<${Card} title="금월 재공품 유형별 비중" desc=${`${Number(ym.slice(5))}월 양품 kg 기준`}>
            <${DonutChart} data=${a.byMix.map((m) => ({ label: m.label, value: m.goodKg }))} unit=" kg" digits=${0} centerLabel="양품 합계" />
          <//>`
        : html`<${Card} title="재공품 유형별 비중" desc=${`${period === 'day' ? '이 날' : '이번 주'} 양품 kg 기준`}>
            <${DonutChart} data=${a.byMix.map((m) => ({ label: m.label, value: m.goodKg }))} unit=" kg" digits=${0} centerLabel="양품 합계" />
          <//>`}
    </div>

    <${Card} title="설비별 생산성" flush>
      <${DataTable} cols=${period === 'month' ? kpiCols.filter((c) => c.key !== 'persons' && c.key !== 'kgPerPerson') : kpiCols} rows=${a.byFiller} keyFn=${(r) => r.key} total=${{ ...t }} />
    <//>
    </div>

    <div id="an-shot-2" class=${`shot-page ${shooting ? 'shooting' : ''}`}>
    ${shotHead(2)}
    ${period === 'month' ? html`<div class="chart-row three">${cmpCard}
      <${Card} title="최근 4개월 재공품 유형별 비중" desc=${`${mix3Label} 양품 kg 기준`}>
        <${DonutChart} data=${mix3.map((m) => ({ label: m.label, value: m.goodKg }))} unit=" kg" digits=${0} centerLabel="4개월 양품" />
      <//></div>` : period === 'week' ? cmpCard : ''}
    <${Card} title="재공품 유형별" flush>
      <${DataTable} rows=${a.byMix} keyFn=${(r) => r.key} cols=${[
        { key: 'label', label: '재공품 유형' },
        { key: 'fermentKg', label: '발효유 (kg)', num: true, render: (r) => n(r.fermentKg, 0), sub: (r) => r.ingredientKg > 0 ? `부원료 ${n(r.ingredientKg, 0)} kg` : '', total: (x) => n(x.fermentKg, 0) },
        { key: 'wheyYieldPct', label: '발효유 수율', num: true, render: (r) => pct(r.wheyYieldPct), sub: (r) => r.curdKg > 0 ? `분리 후 ${n(r.curdKg, 0)} kg` : '', total: (x) => pct(x.wheyYieldPct) },
        { key: 'weighedKg', label: '계근 (kg)', num: true, render: (r) => n(r.weighedKg, 0), sub: (r) => r.wasteKg > 0 ? `폐기 ${n(r.wasteKg)}` : '', total: (x) => n(x.weighedKg, 0) },
        { key: 'lossKg', label: 'LOSS (kg)', num: true, render: (r) => n(r.lossKg), sub: (r) => r.lossPct == null ? '' : pct(r.lossPct), total: (x) => n(x.lossKg) },
        { key: 'goodEa', label: '양품 (ea)', num: true, render: (r) => n(r.goodEa), total: (x) => n(x.goodEa) },
        { key: 'goodKg', label: '양품 (kg)', num: true, render: (r) => n(r.goodKg), total: (x) => n(x.goodKg) },
        { key: 'yieldPct', label: '충진 수율', num: true, render: (r) => pct(r.yieldPct), total: (x) => pct(x.yieldPct) },
        { key: 'bpm', label: 'BPM', num: true, render: (r) => n(r.bpm, 1), total: (x) => n(x.bpm, 1) },
      ]} total=${a.byMix.length ? { ...t } : null} empty=${html`<div class="empty">해당 기간에 실적이 없습니다.</div>`} />
    <//>
    ${period !== 'month' && html`<${Card} title="일별 실적" flush>
      <${DataTable} cols=${kpiCols} rows=${days} keyFn=${(r) => r.key} total=${days.length ? { ...t } : null} empty=${html`<div class="empty">해당 기간에 실적이 없습니다.</div>`} />
    <//>`}

    ${period === 'day' ? prodTankBlock : ''}
    </div>

    ${period !== 'day' && html`<div id="an-shot-3" class=${`shot-page ${shooting ? 'shooting' : ''}`}>
      ${shotHead(3)}
      ${prodTankBlock}
    </div>`}

    <details class="formula"><summary>집계 기준과 계산식</summary><div class="inner">
      <div>일반 작업은 충진부터 포장까지 한 작업입니다. 충진 양품수량을 한 번만 집계하며 제품·LOT별 포장 내역은 생산량에 다시 더하지 않습니다.</div>
      <div><code>발효유 수율</code> = Σ(계근량 + 폐기량) ÷ Σ발효유 kg × 100. 발효유 kg는 면포 × 포당 kg(유청분리 전), 계근량+폐기량은 유청분리 후 면포 무게입니다. 발효유 kg와 계근량이 모두 있는 배치(충진일지로 등록한 작업)만 계산합니다.</div>
      <div><code>충진 수율</code> = Σ양품 kg ÷ Σ(계근량 − 버퍼탱크 폐기량) × 100. 양품 kg는 직접 입력값을 우선 사용하고, 없으면 포장 내역의 중량(수량 × 제품 단위중량)을 사용합니다. 재공품 유형별 표의 <code>부원료</code>는 계근량 × (1 − 1/부재료 비율)로, 엑셀 충진 시트의 소요자재 출고량(발효유 + 부원료)과 같은 식입니다.</div>
      <div><code>충진시간</code> = 작업별 휴게시간 제외 시간의 합. <code>시간당</code> = 양품 ÷ 충진시간. 동시에 가동한 설비의 시간은 각각 합산합니다.</div>
      <div><code>인원</code> = 기준정보 → 데이터에 등록한 그 달의 <b>월별 총인원</b>. 등록이 없는 달은 그 기간·설비에서 일한 사람 수로, 작업자 이름이 같으면 배치가 여러 건이어도 한 명으로 셉니다(1호기 5명이 배치 2건 → 5명). 설비별 표의 인원은 항상 작업자 기준입니다. <code>1인당</code> = 양품 ÷ 인원.</div>
      <div><b>전산 백데이터</b>: 생산_백데이타 엑셀(0731·0831·0930·1024 저장본)에서 옮긴 2026년 7월 1일~10월 23일 충진·포장 실적은 분석과 대시보드 집계에만 합산되고 실적 입력 화면·LOT 추적·엑셀 내보내기에는 나오지 않습니다. 계근량·시작/종료 시각·작업자가 함께 들어 있어 수율·LOSS·BPM·인원 계산에도 포함됩니다. 계근량 없이 수량만 있는 배치가 있으면 생산량·1인당·시간당에는 들어가고 <code>수율</code>·<code>LOSS</code>에서는 빠집니다.</div>
      <div> <code>BPM</code> = 배치별 양품 ea ÷ 가동 분(점심·오전 휴게 자동 차감)의 단순 평균 — 엑셀 전체보고와 같은 식. 설비별 표에서는 기준정보의 설비 기준 BPM 대비 달성률을 함께 표시합니다 (100% 이상 초록, 85% 이상 노랑, 미만 빨강).</div>
      <div>탱크별 수율: <code>수율</code> = 계근 투입 kg ÷ 충진 이동 kg, <code>충진 수율</code> = 양품 kg ÷ 계근 투입 kg. 한 배치에 여러 배양 LOT를 섞은 경우 각 LOT의 면포 중량 비율로 계근·양품을 배분합니다.</div>
      <div>주간은 기준일이 속한 일요일~토요일이며 월 경계를 넘어도 7일 전체를 집계합니다.</div>
    </div></details>`;
}
