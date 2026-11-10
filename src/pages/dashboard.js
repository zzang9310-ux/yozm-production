// 대시보드: 오늘 현황, 탱크 보드, 처리 대기 LOT, 알림, 최근 추이
import { html, useState, useMemo, Card, Stat, Chip, Icon, Empty, DataTable, BarLineChart } from '../ui.js';
import { analyze, tankBoard, cultureStock, materialStock, STATUS, OPEN_STATUSES, productOf, tankLines } from '../model.js';
import { n, pct, fmtDate, fmtMD, dow, addDays, monthRange, today, sum } from '../util.js';

export function DashboardPage({ state, go, params }) {
  // 기준일: 기본은 오늘. 날짜를 바꾸면 실적·탱크 현황·생산계획·추이가 그 날짜 기준으로 바뀜 (자재·대기 LOT 알림은 현재 기준)
  const real = today();
  const [t, setT] = useState(params.date || real);
  const isToday = t === real;
  const dayLabel = isToday ? '오늘' : `${fmtMD(t)}(${dow(t)})`;
  const day = useMemo(() => analyze(state, { from: t, to: t }), [state, t]);
  const month = useMemo(() => analyze(state, monthRange(t.slice(0, 7))), [state, t]);
  const week = useMemo(() => analyze(state, { from: addDays(t, -6), to: t }), [state, t]);
  const trend = useMemo(() => analyze(state, { from: addDays(t, -13), to: t }), [state, t]);
  const board = useMemo(() => tankBoard(state, t), [state, t]);
  const open = useMemo(() => state.cultures.map((c) => ({ c, stock: cultureStock(state, c.id) })).filter((r) => OPEN_STATUSES.includes(r.stock.status))
    .sort((a, b) => a.c.date.localeCompare(b.c.date)), [state]);
  const stockCloths = sum(open, (r) => r.stock.remaining), stockKg = sum(open, (r) => r.stock.remainingKg);
  const mat = useMemo(() => materialStock(state), [state]);
  const alerts = [];
  for (const l of mat.lots) { if (l.status === 'expired') alerts.push({ tone: 'bad', text: `${l.material.name} LOT ${l.lot} 기한 경과 (${fmtDate(l.expiry)}) · 잔량 ${n(l.remaining)} ${l.material.unit}` }); else if (l.status === 'soon') alerts.push({ tone: 'warn', text: `${l.material.name} LOT ${l.lot} 기한 임박 (${fmtDate(l.expiry)})` }); }
  for (const m of mat.byMaterial) if (m.belowSafety) alerts.push({ tone: 'warn', text: `${m.name} 안전재고 미달 · 가용 ${n(m.available)} / 안전 ${n(m.safety)} ${m.unit}` });
  const plansToday = state.plans.filter((p) => p.date === t);

  return html`
    <div class="page-head"><div><div class="eyebrow">${state.settings.companyName}</div><h1>${fmtDate(t)} (${dow(t)}) 생산 현황</h1></div>
      <div class="actions">
        <div class="row" style="flex-wrap:nowrap"><button class="btn sm" aria-label="이전 날" onClick=${() => setT(addDays(t, -1))}><${Icon} name="left" /></button><input id="dash-date" type="date" class="input" style="width:150px" value=${t} max=${real} onInput=${(e) => e.target.value && setT(e.target.value)} /><button class="btn sm" aria-label="다음 날" disabled=${isToday} onClick=${() => setT(addDays(t, 1))}><${Icon} name="right" /></button>${!isToday && html`<button class="btn sm" onClick=${() => setT(real)}>오늘</button>`}</div>
        <button class="btn" onClick=${() => go('analysis', isToday ? { period: 'day' } : { period: 'day', date: t })}><${Icon} name="chart" />실적 분석</button><button class="btn primary" onClick=${() => go('fill', { date: t })}><${Icon} name="plus" />충진/포장 입력</button></div></div>

    <div class="stats">
      <${Stat} hero k=${`${dayLabel} 양품`} v=${n(day.total.goodKg, 0)} unit="kg" s=${`${n(day.total.goodEa)} ea · 작업 ${day.total.jobs}건`} />
      <${Stat} k=${`${dayLabel} 수율`} v=${pct(day.total.yieldPct)} s=${`${isToday ? '최근 7일' : `${fmtMD(addDays(t, -6))}~${fmtMD(t)}`} ${pct(week.total.yieldPct)}`} />
      <${Stat} k=${`${Number(t.slice(5, 7))}월 누적 양품`} v=${n(month.total.goodKg, 0)} unit="kg" s=${`${n(month.total.goodEa)} ea · 수율 ${pct(month.total.yieldPct)}`} />
      <${Stat} k="면포 재고" v=${n(stockCloths)} unit="포" s=${`약 ${n(stockKg)} kg · 충진 대기 LOT ${open.filter((r) => r.stock.status !== 'wait_split').length}건`} />
      <${Stat} k="소분 대기" v=${n(open.filter((r) => r.stock.status === 'wait_split').length)} unit="LOT" s="배양 완료 후 면포 소분 전" />
    </div>

    ${alerts.length > 0 && html`<div class="stack" style="gap:6px">${alerts.slice(0, 6).map((a, i) => html`<div key=${i} class="banner ${a.tone}"><${Icon} name="alert" /><span>${a.text}</span></div>`)}</div>`}

    <div class="grid2">
      <${Card} title="탱크 현황">
        <div class="stack" style="gap:10px">${tankLines(state).map((line) => html`<div key=${line.id}>
          <div class="line-head" style="margin-bottom:6px"><span class="line-name">${line.name}</span>${line.dest && html`<span class="line-dest" style="margin-left:0">→ ${line.dest}</span>`}</div>
          <div class="tanks">${line.tanks.map((tank) => { const { culture, stock } = board.find((b) => b.tank.id === tank.id) || {}; return html`<div key=${tank.id} class="tank ${culture && stock.status !== 'done' && stock.status !== 'disposed' ? 'active' : 'idle'}">
            <div class="n"><span>${tank.name}</span><small>${tank.capT}T</small></div>
            ${culture ? html`<button class="linkish l" style="text-align:left" onClick=${() => go('trace', { cultureId: culture.id })}>${culture.lot}</button><div class="s">${fmtMD(culture.date)} · ${STATUS[stock.status].label}${stock.remaining > 0 ? ` ${stock.remaining}포` : ''}${stock.drinkRemainingL > 0 ? ` ${n(stock.drinkRemainingL)}L` : ''}${stock.hasPress ? ' · 필터프레스' : ''}</div>` : html`<div class="l">기록 없음</div><div class="s">—</div>`}
          </div>`; })}</div>
        </div>`)}</div>
      <//>
      <${Card} title="처리 대기 LOT" count=${open.length} flush>
        <${DataTable} rows=${open.slice(0, 12)} keyFn=${(r) => r.c.id} cols=${[
          { key: 'lot', label: '배양 LOT', render: (r) => html`<button class="linkish" onClick=${() => go('trace', { cultureId: r.c.id })}>${r.c.lot}</button>`, sub: (r) => `${fmtMD(r.c.date)}(${dow(r.c.date)}) · ${r.c.tankId.replace('T', '')}번 탱크` },
          { key: 'status', label: '상태', render: (r) => html`<${Chip} tone=${STATUS[r.stock.status].tone} dot>${STATUS[r.stock.status].label}<//>` },
          { key: 'remaining', label: '재고', num: true, render: (r) => r.stock.status === 'wait_drink' || (r.stock.drinkRemainingL > 0 && r.stock.status === 'partial') ? `드링크 ${n(r.stock.drinkRemainingL)} L` : r.stock.splits.length ? `${n(r.stock.remaining)}포 · ${n(r.stock.remainingKg)} kg` : r.stock.hasPress ? `필터프레스 예상 약 ${n(r.stock.pressClothsEst, 0)}포` : `${n(r.stock.wheyKg)} kg 원유` },
          { key: 'go', label: '', render: (r) => { const st = r.stock.status; const sep = st === 'wait_split' || st === 'wait_move' || (st === 'partial' && r.stock.drinkRemainingL <= 0); return html`<button class="btn sm" onClick=${() => go(sep ? 'separation' : 'fill', { cultureId: r.c.id })}>${st === 'wait_split' ? '소분 입력' : sep ? '반출 기록' : '충진 배치'}</button>`; } },
        ]} empty=${html`<${Empty} title="대기 중인 LOT가 없습니다">배양 실적을 입력하면 여기에 표시됩니다.<//>`} />
      <//>
    </div>

    <div class="grid2">
      <${Card} title=${isToday ? '최근 14일 추이' : `${fmtMD(addDays(t, -13))} ~ ${fmtMD(t)} 추이`}>
        <${BarLineChart} data=${trend.byDay.map((d) => ({ label: fmtMD(d.key), title: `${fmtDate(d.key)}(${dow(d.key)})`, bar: d.goodKg, line: d.yieldPct, hl: d.key === t }))} barLabel="양품" barUnit=" kg" barDigits=${1} lineLabel="수율" lineUnit="%" lineMin=${0} lineMax=${100} height=${200} />
      <//>
      <${Card} title=${`${dayLabel} 생산계획 대비 실적`} flush>
        <${DataTable} rows=${plansToday} cols=${[
          { key: 'product', label: '제품', render: (r) => (productOf(state, r.productCode) || {}).name || r.productCode },
          { key: 'qty', label: '계획', num: true, render: (r) => n(r.qty) },
          { key: 'done', label: '실적', num: true, render: (r) => n((day.byProduct.find((p) => p.key === r.productCode) || {}).qty || 0) },
          { key: 'rate', label: '달성률', num: true, render: (r) => { const d = (day.byProduct.find((p) => p.key === r.productCode) || {}).qty || 0; const v = r.qty > 0 ? d / r.qty * 100 : null; return html`<${Chip} tone=${v == null ? '' : v >= 100 ? 'good' : v >= 80 ? 'warn' : 'bad'}>${pct(v, 0)}<//>`; } },
        ]} empty=${html`<${Empty} title=${`${dayLabel} 등록된 생산계획이 없습니다`}>${dayLabel} 포장 실적: ${day.byProduct.map((p) => `${p.label} ${n(p.qty)} ea`).join(' · ') || '없음'}<//>`} />
      <//>
    </div>`;
}
