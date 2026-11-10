// 반제품 현황 (v307): 지금 유청분리실에 남아 있는 면포(반제품) 재고 — 배양 LOT별 소분·반출·폐기·재고와 배출 후 경과일
// 경과일 색은 LOT 추적·반제 사용 현황과 같음: 2일 이하 초록 · 3일 파랑 · 4일 이상 빨강 (오늘 기준)
import { html, useState, useMemo, Card, Stat, DataTable, Icon, exportCSV } from '../ui.js';
import { cultureStock, tankOf, lotOutDate, clothAgeDays, CLOTH_AGE_LIMIT, FP_AGE_EXTRA, STATUS } from '../model.js';
import { n, fmtDate, today, addDays, dow } from '../util.js';

const ageClsOf = (d) => d == null ? '' : d >= CLOTH_AGE_LIMIT ? 'lot-old' : d >= 3 ? 'lot-mid' : 'lot-fresh';
const kgTxt = (v) => `${n(Math.round(v))}kg`;
const c1 = (v) => n(v, Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1); // 포 수: 정수면 소수점 없이

export function BanjeStockPage({ state, go }) {
  const td = today();
  const [pendOpen, setPendOpen] = useState(false); // 충진 배정 대기: 기본 접힘 (v308)
  const [days, setDays] = useState(14); // 최근 N일 안에 배출된 LOT만 (오래된 LOT의 기록 오차가 섞이지 않게)
  const rows = useMemo(() => {
    const from = addDays(td, -days);
    const out = [];
    for (const c of state.cultures) {
      const out0 = lotOutDate(c.lot); if (!out0 || out0 < from) continue;
      const s = cultureStock(state, c.id);
      if (!s.hasWhey || !s.splits.length) continue;
      const pend = s.pendingMoves.reduce((a, m) => a + Number(m.cloths || 0), 0);
      if (s.remaining <= 0.05 && pend <= 0.05) continue;
      // 필터프레스 재고 = 소분 때 FP 포 수 − FP로 반출·폐기한 포 수
      const fpSplit = s.splits.reduce((a, x) => a + Number(x.pressCloths || 0), 0);
      const fpOut = [...s.moves, ...s.disposes].filter((m) => m.source === 'press').reduce((a, m) => a + Number(m.cloths || 0), 0);
      const fpLeft = Math.max(0, Math.min(s.remaining, fpSplit - fpOut));
      out.push({ id: c.id, c, s, tank: tankOf(state, c.tankId), out: out0, age: clothAgeDays(c.lot, td), pend, fpLeft });
    }
    return out.sort((a, b) => (b.age ?? -1) - (a.age ?? -1) || a.c.lot.localeCompare(b.c.lot));
  }, [state, td, days]);

  const stock = rows.filter((r) => r.s.remaining > 0.05);
  const sumC = (list) => list.reduce((a, r) => a + r.s.remaining, 0);
  const sumK = (list) => list.reduce((a, r) => a + r.s.remainingKg, 0);
  // v336: FP 재고는 경과일 +1일 → 한 LOT의 일반 면포 재고와 FP 재고를 나눠 구간에 넣음 (kg은 포 수 비율로 나눔)
  const parts = stock.flatMap((r) => { const room = Math.max(0, r.s.remaining - r.fpLeft), kgPer = r.s.remaining > 0 ? r.s.remainingKg / r.s.remaining : 0;
    return [{ r, cloths: room, kg: room * kgPer, age: r.age }, { r, cloths: r.fpLeft, kg: r.fpLeft * kgPer, age: r.age == null ? null : r.age + FP_AGE_EXTRA }].filter((p) => p.cloths > 0.05); });
  const bandOf = (test) => { const ps = parts.filter((p) => p.age != null && test(p.age)); return { lots: new Set(ps.map((p) => p.r.id)).size, cloths: ps.reduce((a, p) => a + p.cloths, 0), kg: ps.reduce((a, p) => a + p.kg, 0) }; };
  const bands = [
    { key: 'fresh', label: '2일 이하', cls: 'lot-fresh', ...bandOf((a) => a <= 2) },
    { key: 'mid', label: '3일', cls: 'lot-mid', ...bandOf((a) => a === 3) },
    { key: 'old', label: `${CLOTH_AGE_LIMIT}일 이상`, cls: 'lot-old', ...bandOf((a) => a >= CLOTH_AGE_LIMIT) },
  ];
  const pendRows = rows.filter((r) => r.pend > 0.05).flatMap((r) => r.s.pendingMoves.map((m) => ({ id: m.id, r, m })));

  const csv = () => exportCSV(`반제품현황_${td}.csv`, ['배양 LOT', '탱크', '배출일', '경과일', '소분 포', '반출 포', '폐기 포', '재고 포', '재고 kg', 'FP 재고 포', '충진 배정 대기 포', '상태'],
    rows.map((r) => [r.c.lot, r.tank.name, r.out, r.age, r.s.splitCloths, r.s.usedCloths, r.s.disposedCloths, Math.round(r.s.remaining * 10) / 10, Math.round(r.s.remainingKg), r.fpLeft, r.pend, (STATUS[r.s.status] || {}).label || r.s.status]));

  return html`
    <div class="page-head"><div><div class="eyebrow">반제품</div><h1>반제품 현황</h1><div class="muted" style="font-size:13px;margin-top:4px">${fmtDate(td)}(${dow(td)}) 기준 유청분리실 면포 재고 · 경과일 = 오늘 − 배출일(LOT 앞 6자리) · 2일 이하 초록 · 3일 파랑 · ${CLOTH_AGE_LIMIT}일 이상 빨강</div></div>
      <div class="actions"><button class="btn" onClick=${csv} disabled=${!rows.length}><${Icon} name="download" />CSV</button></div></div>

    <div class="stats">
      <${Stat} hero k="면포 재고" v=${n(sumC(stock), 0)} unit="포" s=${`배양 LOT ${n(stock.length)}개 · ${kgTxt(sumK(stock))}`} />
      ${bands.map((b) => html`<${Stat} key=${b.key} k=${html`<span class=${b.cls}>${b.label}</span>`} v=${n(b.cloths, 0)} unit="포" s=${`${n(b.lots)}개 LOT · ${kgTxt(b.kg)}`} />`)}
    </div>

    <${Card} title="배양 LOT별 면포 재고" count=${stock.length} desc=${html`배출 후 오래된 순 · 배양 LOT를 누르면 LOT 추적 · <label style="white-space:nowrap">최근 <select class="input" style="width:auto;display:inline-block;padding:2px 6px" value=${days} onChange=${(e) => setDays(+e.target.value)}>${[7, 14, 30].map((d) => html`<option key=${d} value=${d}>${d}</option>`)}</select>일 배출</label>`} flush>
      <${DataTable} rows=${stock} empty=${html`<div class="empty">남은 면포 재고가 없습니다.</div>`} cols=${[
        { key: 'lot', label: '배양 LOT', render: (r) => html`<button class=${`linkish lot ${ageClsOf(r.age)}`} style="font-weight:700" onClick=${() => go('trace', { cultureId: r.c.id })}>${r.c.lot}</button>`, sub: (r) => r.tank.name },
        { key: 'out', label: '배출일', render: (r) => html`<span style="white-space:nowrap">${fmtDate(r.out)}(${dow(r.out)})</span>` },
        { key: 'age', label: '경과일', num: true, render: (r) => r.age == null ? '—' : html`<b class=${ageClsOf(r.age)}>${r.age}일</b>`, sub: (r) => FP_AGE_EXTRA && r.fpLeft > 0 && r.age != null ? html`<span class=${ageClsOf(r.age + FP_AGE_EXTRA)}>FP ${r.age + FP_AGE_EXTRA}일</span>` : '' },
        { key: 'split', label: '소분', num: true, render: (r) => `${n(r.s.splitCloths)}포` },
        { key: 'used', label: '반출', num: true, render: (r) => `${c1(r.s.usedCloths)}포`, sub: (r) => r.s.disposedCloths ? `폐기 ${n(r.s.disposedCloths)}포` : '' },
        { key: 'rem', label: '재고', num: true, render: (r) => html`<b>${c1(r.s.remaining)}</b>포`, sub: (r) => kgTxt(r.s.remainingKg) },
        { key: 'fp', label: '그중 FP', num: true, render: (r) => r.fpLeft > 0 ? html`<span class="chip accent">FP ${n(r.fpLeft)}포</span>` : html`<span class="muted">—</span>` },
        { key: 'st', label: '상태', render: (r) => { const st = STATUS[r.s.status]; return st ? html`<span class=${`chip ${st.tone || ''}`}>${st.label}</span>` : r.s.status; } },
      ]} />
    <//>

    ${pendRows.length > 0 && html`<${Card} title="반출됐지만 충진 배정 대기" count=${pendRows.length} desc=${`유청분리실에서 충진설비로 보냈는데 아직 충진 배치에 연결되지 않은 면포 · ${c1(pendRows.reduce((a, x) => a + Number(x.m.cloths || 0), 0))}포`} flush
      actions=${html`<button class="btn sm ghost" onClick=${() => setPendOpen(!pendOpen)}><${Icon} name=${pendOpen ? 'up' : 'down'} />${pendOpen ? '접기' : '펼치기'}</button>`}>
      ${pendOpen && html`<${DataTable} rows=${pendRows} cols=${[
        { key: 'lot', label: '배양 LOT', render: (x) => html`<button class=${`linkish lot ${ageClsOf(x.r.age == null ? null : x.r.age + (x.m.source === 'press' ? FP_AGE_EXTRA : 0))}`} style="font-weight:700" onClick=${() => go('trace', { cultureId: x.r.c.id })}>${x.r.c.lot}</button>`, sub: (x) => x.r.tank.name },
        { key: 'date', label: '반출일', render: (x) => fmtDate(x.m.date) },
        { key: 'filler', label: '충진 설비', render: (x) => x.m.fillerId ? ((state.settings.fillers || []).find((f) => f.id === x.m.fillerId) || {}).name || x.m.fillerId : html`<span class="muted">설비 대기</span>`, sub: (x) => x.m.mixType || '' },
        { key: 'cloths', label: '포', num: true, render: (x) => html`<b>${c1(Number(x.m.cloths || 0))}</b>${x.m.source === 'press' ? html` <span class="chip accent">FP</span>` : ''}`, sub: (x) => kgTxt(Number(x.m.kg || 0)) },
      ]} />`}
    <//>`}`;
}
