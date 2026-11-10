// 충진/포장 실적: 충진 버퍼 배치(반출 면포·드링크 원액 소비) + 제품 LOT별 포장 내역
import { html, useState, useEffect, useMemo, Card, Chip, Icon, Field, Modal, DataTable, Empty, toast, confirmAsync, exportCSV } from '../ui.js';
import { save, remove, getState } from '../store.js';
import { draftFor, attachMovesToDraft, draftForFiller, attachDrinkToDraft } from '../draft.js';
import { cultureStock, batchGoodKg, batchNetInputKg, batchRunMin, batchPersons, batchHours, batchBpm, bpmOf, fillerStdBpm, bpmPct, autoBreakDetail, crewNames, mixRatio, fillerOf, productOf, materialStock, packKg, bomRequirements, pickMaterialLot, journalOnly } from '../model.js';
import { n, pct, fmtDate, fmtMD, dow, addDays, today, uid, num, calc, isExpr, batchNo, productLot, sum, monthRange, groupBy } from '../util.js';

/** 엑셀처럼 "10+10+10"을 받아 포커스가 빠질 때 합계로 바꾸는 숫자 입력 */
export function NumInput({ value, onChange, placeholder }) {
  const v = value == null ? '' : String(value);
  return html`<input type="text" inputmode="decimal" class="input tnum" style="text-align:right" value=${v} placeholder=${placeholder || ''}
    onInput=${(e) => onChange(e.target.value)} onBlur=${(e) => { if (isExpr(e.target.value)) onChange(String(calc(e.target.value))); }} />`;
}

/**
 * 정식 충진 배치를 저장할 때 전산 임시 배치(erpDraft, 전산 대조에서 미리 등록)와의 이중 집계를 막는다:
 * 같은 날·같은 설비의 임시 배치에서 이 배치에 들어 있는 제품의 제품 LOT 줄을 지우고, 줄이 하나도 안 남으면 임시 배치 자체를 삭제.
 * 줄이 남으면(같은 설비에서 다른 제품도 전산에 있었던 경우) 임시 배치는 남은 줄 합계로 줄여 둔다 — 그 제품을 정식 배치로 넣을 때 마저 빠짐.
 */
export async function absorbErpDrafts(doc, productCodes) {
  const st = getState();
  const codes = new Set((productCodes || []).filter(Boolean));
  let removed = 0, trimmed = 0;
  if (!codes.size) return { removed, trimmed };
  for (const d of st.batches.filter((b) => b.erpDraft && b.id !== doc.id && b.date === doc.date && b.fillerId === doc.fillerId)) {
    const ps = st.packs.filter((p) => p.batchId === d.id);
    const gone = ps.filter((p) => codes.has(p.productCode));
    if (!gone.length) continue;
    for (const p of gone) await remove('packs', p.id);
    const left = ps.filter((p) => !codes.has(p.productCode));
    if (!left.length) { await remove('batches', d.id); removed++; }
    else { await save('batches', { ...d, goodEa: sum(left, (p) => p.qty) }); trimmed++; }
  }
  return { removed, trimmed };
}

export function FillPage({ state, params, go }) {
  const [date, setDate] = useState(params.date || addDays(today(), -1)); // 실적 입력은 전일 기준으로 시작
  const [batchModal, setBatchModal] = useState(null);
  const [packModal, setPackModal] = useState(null);
  // 충진일지 설비 카드는 기본으로 머리글만 보이고, '펼치기'를 누르면 예전처럼 대기 면포·배치 표가 보임 (설비별 기억)
  const [opened, setOpened] = useState({});
  useEffect(() => { if (params.date) setDate(params.date); }, [params.date]);
  useEffect(() => { if (params.cultureId) setBatchModal({ presetCultureId: params.cultureId }); }, [params.cultureId]);

  const month = monthRange(date.slice(0, 7));
  const batches = useMemo(() => state.batches.filter((b) => b.date >= month.from && b.date <= month.to).sort((a, b) => b.date.localeCompare(a.date) || a.batchNo.localeCompare(b.batchNo)), [state, month.from]);
  const packs = useMemo(() => state.packs.filter((p) => p.date >= month.from && p.date <= month.to).sort((a, b) => b.date.localeCompare(a.date)), [state, month.from]);
  const dayBatches = batches.filter((b) => b.date === date);
  const pendingMoves = useMemo(() => state.separations.filter((s) => s.kind === 'move' && !s.batchId), [state]);
  const delBatch = async (b) => {
    if (await confirmAsync(`배치 ${b.batchNo}를 삭제할까요? 연결된 반출 기록은 배정 대기로 돌아가고, 이 배치의 제품 LOT(포장 내역)도 함께 삭제됩니다.`)) {
      for (const m of state.separations.filter((s) => s.kind === 'move' && s.batchId === b.id)) await save('separations', { ...m, batchId: null });
      for (const p of state.packs.filter((x) => x.batchId === b.id && x.kind !== 'repack')) await remove('packs', p.id);
      await remove('batches', b.id); toast('삭제했습니다.');
    }
  };
  const delPack = async (p) => { if (await confirmAsync(`포장 내역 ${p.productLot}을 삭제할까요?`)) { await remove('packs', p.id); toast('삭제했습니다.'); } };
  const yieldOf = (b) => { const net = batchNetInputKg(b); return net > 0 ? batchGoodKg(state, b) / net * 100 : null; };

  // ---- 설비별 보드: 선택일까지 반출됐지만 아직 배치에 안 들어간 면포를 설비·재공품 유형별로 묶어 발효유·부원료·출고량 계산 ----
  const density = state.settings.milkDensity || 1.03;
  const cultures = useMemo(() => state.cultures.map((c) => ({ c, stock: cultureStock(state, c.id) })), [state]);
  // 기본은 선택한 날짜에 유청분리에서 반출한 면포만 보임. 다른 날 반출(배정 대기)은 버튼으로 펼쳐 볼 수 있음
  const [allDates, setAllDates] = useState(false);
  const moveDate = (m) => m.fillDate || m.date;
  const otherDateMoves = pendingMoves.filter((m) => moveDate(m) !== date);
  const boardMoves = pendingMoves.filter((m) => allDates || moveDate(m) === date).map((m) => ({ ...m, culture: state.cultures.find((c) => c.id === m.cultureId) })).sort((a, b) => a.date.localeCompare(b.date));
  const waiting = boardMoves.filter((m) => !m.fillerId);
  // 발효유 출고량 = Σ(면포 × 포당 무게) — 엑셀 충진 시트 E열. 부원료는 계근량 기준이라 배치 등록 창에서 계근 입력 후 계산
  const groupsFor = (list) => [...groupBy(list, (m) => m.mixType || '(유형 없음)')].map(([mix, ms]) => {
    const ferment = Math.round(sum(ms, (m) => m.kg) * 10) / 10; const ratio = mixRatio(state, mix);
    return { mix, ms, cloths: sum(ms, (m) => m.cloths), ferment, ratio };
  });
  // 배정 대기 면포: 유형별 한 줄 요약 (유형 · LOT 칩 · 면포 → 발효유 + 부원료 = 출고량 · 등록 버튼)
  // 설비별 고정 색 (카드 띠·배지) — 설비 순서대로 서로 다른 색상
  const FILLER_HUES = [160, 215, 25, 275, 45, 330, 195, 95, 0, 240];
  const fillerColor = (i) => `hsl(${FILLER_HUES[i % FILLER_HUES.length]} 48% 40%)`;
  // 같은 날 같은 설비·유형의 전산 임시 배치가 있으면 '임시 배치에 합치기'가 기본 — 면포가 임시 배치의 배양 LOT로 붙고 배정 대기에서 빠짐
  const mergeIntoDraft = async (draft, g) => {
    const cnt = await attachMovesToDraft(state, draft, g.ms);
    toast(cnt ? `${g.mix} ${n(g.cloths)}포(${cnt}건)를 임시 배치 ${draft.batchNo}에 합쳤습니다. 계근량·작업시간을 넣으면 정식 배치가 됩니다.` : '이미 합쳐져 있습니다.');
  };
  const mergeDrinkIntoDraft = async (draft, list) => {
    const liters = sum(list, (x) => x.stock.drinkRemainingL);
    const cnt = await attachDrinkToDraft(state, draft, list.map(({ c, stock }) => ({ cultureId: c.id, liters: stock.drinkRemainingL })), density);
    toast(cnt ? `드링크 원액 ${n(liters)} L(${cnt} LOT)를 임시 배치 ${draft.batchNo}에 합쳤습니다. 계근량·작업시간을 넣으면 정식 배치가 됩니다.` : '합칠 원액이 없습니다.');
  };
  const pendingList = (groups, fillerId) => html`<div class="pend-list">${groups.map((g) => { const draft = fillerId ? draftFor(state, date, fillerId, g.mix === '(유형 없음)' ? '' : g.mix) : null; return html`<div key=${g.mix} class="pend">
    <div class="pend-type"><b>${g.mix}</b><span class="muted">${n(g.cloths)}포</span></div>
    <div class="chips">${g.ms.map((m) => html`<span key=${m.id} class="chip ${m.source === 'press' ? 'accent' : ''}" title=${m.source === 'press' ? '필터프레스에서 작업한 면포' : ''}>${m.source === 'press' ? html`<b style="margin-right:3px">FP</b>` : ''}${m.culture ? m.culture.lot : m.cultureId} <b>${n(m.cloths)}</b>${m.date !== date ? html`<span class="muted" style="margin-left:4px">${fmtMD(m.date)}</span>` : ''}</span>`)}</div>
    <div class="pend-calc"><span class="out">발효유 출고 <b>${n(g.ferment, 0)}</b> kg</span>${g.ratio > 1 ? html`<span><small>부원료 = 계근 × (1 − 1/${g.ratio}) · 계근 입력 후</small></span>` : ''}</div>
    ${draft ? html`<div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm primary" disabled=${!state.canWrite} title=${`전산 임시 배치 ${draft.batchNo}의 배양 LOT로 붙입니다`} onClick=${() => mergeIntoDraft(draft, g)}>임시 배치에 합치기</button><button class="btn sm" disabled=${!state.canWrite} onClick=${() => setBatchModal({ fillerId, mixType: g.mix === '(유형 없음)' ? '' : g.mix, moveIds: g.ms.map((m) => m.id), date })}>새 배치</button></div>`
      : html`<button class="btn sm primary" disabled=${!state.canWrite} onClick=${() => setBatchModal({ fillerId, mixType: g.mix === '(유형 없음)' ? '' : g.mix, moveIds: g.ms.map((m) => m.id), date })}>배치 등록</button>`}
  </div>`; })}</div>`;
  const batchCols = (withDate) => [
    ...(withDate ? [{ key: 'date', label: '충진일', render: (b) => `${fmtDate(b.date)} (${dow(b.date)})` }] : []),
    { key: 'batchNo', label: '배치', render: (b) => html`<button class="linkish" onClick=${() => go('trace', { q: b.batchNo })}>${b.batchNo}</button>`, sub: (b) => withDate ? `${fillerOf(state, b.fillerId).name} · ${b.mixType || '유형 미지정'}` : (b.mixType || '유형 미지정') },
        { key: 'src', label: '배양 LOT', render: (b) => html`<div class="chips">${b.erpDraft ? html`<${Chip} tone="warn" dot>전산 임시 · 계근·작업시간 미입력<//>` : !(b.sources || []).length ? html`<${Chip}>면포 연결 없음<//>` : ''}${(b.sources || []).map((s, i) => { const c = state.cultures.find((x) => x.id === s.cultureId); const mv = s.moveId ? state.separations.find((x) => x.id === s.moveId) : null; const fp = !!(mv && mv.source === 'press'); return html`<span key=${i} class="chip ${fp ? 'accent' : ''}" title=${fp ? '필터프레스에서 작업한 면포' : ''}>${fp ? html`<b style="margin-right:3px">FP</b>` : ''}${c ? c.lot : '?'} <b>${s.kind === 'drink' ? `${n(s.liters)} L` : n(s.cloths)}</b></span>`; })}</div>` },
        { key: 'kg', label: '출고 → 계근 (kg)', num: true, render: (b) => html`${n(b.outKg, 0)} <span class="muted">→</span> ${n(b.inputKg, 0)}`, sub: (b) => `재공품 수율 ${pct(num(b.outKg) > 0 && num(b.inputKg) > 0 ? num(b.inputKg) / num(b.outKg) * 100 : null)}${b.wasteKg ? ` · 폐기 ${n(b.wasteKg, 1)}` : ''}` },
        { key: 'good', label: '양품', num: true, render: (b) => html`${n(b.goodEa)} <span class="muted">ea</span>`, sub: (b) => `${n(batchGoodKg(state, b), 1)} kg · 불량 ${n(b.defectEa)}` },
        { key: 'yield', label: '수율', num: true, render: (b) => { const y = yieldOf(b); return html`<${Chip} tone=${y == null ? '' : y >= 92 ? 'good' : y >= 85 ? 'warn' : 'bad'}>${pct(y)}<//>`; } },
        { key: 'work', label: '인원 · 가동', num: true, render: (b) => `${n(batchPersons(b))}명 · ${n(batchRunMin(b))}분`, sub: (b) => `${b.startTime || ''}${b.endTime ? '~' + b.endTime : ''}${batchRunMin(b) ? ` · ${n(batchBpm(b), 1)} BPM` : ''}${batchRunMin(b) && fillerStdBpm(state, b.fillerId) ? ` (기준 ${n(fillerStdBpm(state, b.fillerId), 1)} · ${pct(bpmPct(batchBpm(b), fillerStdBpm(state, b.fillerId)), 0)})` : ''}` },
        { key: 'packs', label: '제품 LOT', render: (b) => { const ps = state.packs.filter((p) => p.batchId === b.id && p.kind !== 'repack'); return ps.length ? html`<div class="chips">${ps.map((p) => html`<span key=${p.id} class="chip good" title=${(productOf(state, p.productCode) || {}).name || ''}>${p.productLot} <b>${n(p.qty)}</b></span>`)}</div>` : html`<span class="muted">—</span>`; } },
        { key: 'act', label: '', render: (b) => html`<div class="row-actions"><button class="icon-btn" aria-label="수정" title="수정" onClick=${() => setBatchModal({ rec: b })}><${Icon} name="edit" /></button><button class="icon-btn danger" aria-label="삭제" title="삭제" disabled=${!state.canWrite} onClick=${() => delBatch(b)}><${Icon} name="trash" /></button></div>` },
  ];
  const csvBatches = () => exportCSV(`충진실적_${date.slice(0, 7)}.csv`, ['충진일', '배치번호', '설비', '재공품 유형', '사용 배양 LOT', '발효유 kg', '출고량 kg', '계근 kg', '폐기 kg', '양품 ea', '불량 ea', '양품 kg', '재공품 수율 %', '충진 수율 %', '인원', '가동 분', 'BPM', '기준 BPM', 'BPM 달성률 %', '작업자'],
    batches.map((b) => [b.date, b.batchNo, fillerOf(state, b.fillerId).name, b.mixType || '', (b.sources || []).map((s) => (state.cultures.find((c) => c.id === s.cultureId) || {}).lot).join(' / '), n(sum(b.sources || [], (s) => s.kg), 1), n(b.outKg, 1), b.inputKg, b.wasteKg, b.goodEa, b.defectEa, n(batchGoodKg(state, b), 1), n(num(b.outKg) > 0 ? num(b.inputKg) / num(b.outKg) * 100 : null, 1), n(yieldOf(b), 1), batchPersons(b), batchRunMin(b), n(batchBpm(b), 1), fillerStdBpm(state, b.fillerId) ?? '', n(bpmPct(batchBpm(b), fillerStdBpm(state, b.fillerId)), 0), crewNames(b).join(' ')]));

  return html`
    <div class="page-head"><div><div class="eyebrow">충진/포장팀</div><h1>충진/포장 실적</h1>${otherDateMoves.length > 0 && !allDates ? html`<p>다른 날 반출돼 아직 배정되지 않은 면포 ${otherDateMoves.length}건은 숨겨져 있습니다.</p>` : ''}</div>
      <div class="actions">
        <div class="row" style="flex-wrap:nowrap"><button class="btn sm" onClick=${() => setDate(addDays(date, -1))} aria-label="이전 날"><${Icon} name="left" /></button><input id="fi-date" type="date" class="input" style="width:150px" value=${date} onInput=${(e) => e.target.value && setDate(e.target.value)} /><button class="btn sm" onClick=${() => setDate(addDays(date, 1))} aria-label="다음 날"><${Icon} name="right" /></button></div>
        ${(otherDateMoves.length > 0 || allDates) && html`<button class="btn ${allDates ? 'primary' : ''}" onClick=${() => setAllDates(!allDates)} title="선택한 날짜가 아닌 날에 반출된 배정 대기 면포"><${Icon} name=${allDates ? 'x' : 'eye'} />${allDates ? '선택일 반출만' : `다른 날 반출 ${otherDateMoves.length}건 보기`}</button>`}
      </div></div>

    ${waiting.length > 0 && html`<section class="card filler-card waiting" style="--fc: var(--muted)">
      <div class="filler-head"><div class="filler-badge">?</div><div class="filler-title"><h2>설비 미정</h2><div class="filler-stats"><span class="chip info">대기 <b>${n(sum(waiting, (m) => m.cloths))}</b>포 · ${waiting.length}건</span></div><span class="muted" style="font-size:12.5px">배치 등록 창에서 설비를 고르면 그 설비로 확정됩니다</span></div></div>
      <div class="card-body flush">${pendingList(groupsFor(waiting), '')}</div>
    </section>`}

    ${(() => {
      const cards = state.settings.fillers.map((f, i) => {
        const isDrink = /드링크/.test(f.name);
        const groups = groupsFor(boardMoves.filter((m) => m.fillerId === f.id));
        const todays = dayBatches.filter((b) => b.fillerId === f.id);
        const drinkAvail = isDrink ? cultures.filter(({ c, stock }) => stock.drinkRemainingL > 0 && c.date <= date) : [];
        // 11월부터 1~4호기·로타리·반자동은 충진일지 등록에서 입력 → 여기서는 대기 면포만 보여주고 일지로 안내
        const jo = journalOnly(state, f.id, date);
        return { f, i, isDrink, jo, groups, todays, drinkAvail, active: groups.length > 0 || todays.length > 0 || drinkAvail.length > 0 };
      });
      const idle = cards.filter((x) => !x.active);
      return html`
        ${cards.filter((x) => x.active).map(({ f, i, isDrink, jo, groups, todays, drinkAvail }) => html`<section key=${f.id} class="card filler-card" style=${`--fc: ${fillerColor(i)}`}>
          <div class="filler-head">
            <div class="filler-badge" title=${f.code ? `설비코드 ${f.code}` : ''}>${f.code || f.name.slice(0, 1)}</div>
            <div class="filler-title"><h2>${f.name}</h2>
              <div class="filler-stats">
                ${todays.length > 0 && html`<span class="chip accent">배치 <b>${todays.length}</b>건 · 양품 <b>${n(sum(todays, (b) => num(b.goodEa)))}</b> ea</span>`}
                ${groups.length > 0 && html`<span class="chip info">대기 <b>${n(sum(groups, (g) => g.cloths))}</b>포 · ${groups.map((g) => g.mix).join('·')}</span>`}
                ${isDrink && drinkAvail.length > 0 && html`<span class="chip warn">원액 <b>${n(sum(drinkAvail, (x) => x.stock.drinkRemainingL))}</b> L</span>`}
              </div></div>
            ${jo ? html`<div class="row" style="gap:6px;flex-wrap:nowrap">
                <button class="btn sm" disabled=${!state.canWrite} onClick=${() => setBatchModal({ fillerId: f.id, date })} title="예전 방식으로 배치 직접 등록"><${Icon} name="plus" />배치</button>
                <button class="btn sm primary" onClick=${() => go('journal', { fillerId: f.id, date })} title="11월부터 이 설비의 충진 실적은 충진일지 등록에서 입력합니다"><${Icon} name="clipboard" />충진일지 등록</button>
                <button class="btn sm ghost" onClick=${() => setOpened({ ...opened, [f.id]: !opened[f.id] })} title=${opened[f.id] ? '대기 면포·배치 표 접기' : '예전처럼 대기 면포·배치 표 펼치기'}><${Icon} name=${opened[f.id] ? 'x' : 'eye'} />${opened[f.id] ? '접기' : '펼치기'}</button>
              </div>`
              : html`<button class="btn sm" disabled=${!state.canWrite} onClick=${() => setBatchModal({ fillerId: f.id, date })}><${Icon} name="plus" />배치</button>`}
          </div>
          ${(!jo || opened[f.id]) && html`<div class="card-body flush">
          ${isDrink && drinkAvail.length > 0 && html`<div class="sub-head">드링크 원액 (배양 당일 오후 드링크 설비로 이동 → 배양일 = 버퍼탱크 LOT 날짜) · 같은 날 LOT는 한 배치로</div><div class="pend-list">${[...groupBy(drinkAvail, ({ c }) => c.date)].map(([day, list]) => {
            const liters = sum(list, (x) => x.stock.drinkRemainingL);
            // 그 배양일의 드링크 전산 임시 배치가 있으면 '임시 배치에 합치기'가 기본
            const draft = draftForFiller(state, day, f.id, '드링크');
            const newBatch = () => setBatchModal({ presetCultureIds: list.map((x) => x.c.id), date: day });
            return html`<div key=${day} class="pend">
            <div class="pend-type"><b>드링크 원액</b><span class="muted">${fmtMD(day)} 배양·이동 · ${list.length} LOT · ${n(liters)} L</span></div>
            <div class="chips">${list.map(({ c, stock }) => html`<span key=${c.id} class="chip">${c.lot} <b>${c.tankId.replace('T', '')}번</b><span class="muted" style="margin-left:4px">${n(stock.drinkRemainingL)} L</span></span>`)}</div>
            <div class="pend-calc"><span class="out">발효유 <b>${n(liters * density, 0)}</b> kg</span></div>
            ${draft ? html`<div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm primary" disabled=${!state.canWrite} title=${`전산 임시 배치 ${draft.batchNo}의 배양 LOT로 붙입니다`} onClick=${() => mergeDrinkIntoDraft(draft, list)}>임시 배치에 합치기</button><button class="btn sm" disabled=${!state.canWrite} onClick=${newBatch}>새 배치</button></div>`
              : html`<button class="btn sm primary" disabled=${!state.canWrite} onClick=${newBatch}>${list.length > 1 ? `${list.length} LOT 함께 배치 등록` : '배치 등록'}</button>`}
          </div>`; })}</div>`}
          ${groups.length > 0 && (jo ? html`<div class="sub-head">배정 대기 면포 · 충진일지 등록에서 연결됩니다</div><div class="pend-list">${groups.map((g) => html`<div key=${g.mix} class="pend">
                <div class="pend-type"><b>${g.mix}</b><span class="muted">${n(g.cloths)}포</span></div>
                <div class="chips">${g.ms.map((m) => html`<span key=${m.id} class="chip ${m.source === 'press' ? 'accent' : ''}">${m.source === 'press' ? html`<b style="margin-right:3px">FP</b>` : ''}${m.culture ? m.culture.lot : m.cultureId} <b>${n(m.cloths)}</b>${m.date !== date ? html`<span class="muted" style="margin-left:4px">${fmtMD(m.date)}</span>` : ''}</span>`)}</div>
                <div class="pend-calc"><span class="out">발효유 출고 <b>${n(g.ferment, 0)}</b> kg</span></div>
                <button class="btn sm primary" onClick=${() => go('journal', { fillerId: f.id, date })}>충진일지 등록에서 입력</button>
              </div>`)}</div>` : html`<div class="sub-head">배정 대기 면포 · 재공품 유형별</div>${pendingList(groups, f.id)}`)}
          ${todays.length > 0 && html`<div class="sub-head">${fmtMD(date)} 충진 배치</div><${DataTable} rows=${todays} cols=${batchCols(false)} />`}
          </div>`}
        </section>`)}
        ${idle.length > 0 && html`<div class="note" style="padding:0 4px">오늘 작업 없음: ${idle.map(({ f }) => f.name).join(' · ')}${state.canWrite ? html` · <button class="linkish" style="font-weight:500" onClick=${() => setBatchModal({ date })}>다른 설비에 배치 등록</button>` : ''}</div>`}`;
    })()}

    <details class="formula"><summary>이 달 전체 충진 배치 (${batches.length}건) · 포장 내역 (${packs.length}건)</summary><div class="inner" style="gap:14px">
    <${Card} title="충진 배치" count=${batches.length} desc=${`${date.slice(0, 7)} 월 전체`} actions=${html`<button class="btn sm" onClick=${csvBatches}><${Icon} name="download" />CSV</button>`} flush>
      <${DataTable} rows=${batches} cols=${batchCols(true)} empty=${html`<${Empty} title="등록된 충진 배치가 없습니다">설비 카드의 배치 등록으로 반출 면포를 묶어 등록하세요.<//>`} />
    <//>

    <${Card} title="제품 LOT별 포장 내역" count=${packs.length} flush>
      <${DataTable} rows=${packs} cols=${[
        { key: 'date', label: '포장일', render: (p) => `${fmtDate(p.date)} (${dow(p.date)})` },
        { key: 'batch', label: '충진 배치', render: (p) => (state.batches.find((b) => b.id === p.batchId) || {}).batchNo || '—' },
        // 제품·제품 LOT 어느 쪽을 눌러도 LOT 추적에서 그 제품 LOT + 품목을 바로 고름 (v266)
        { key: 'product', label: '제품', render: (p) => html`<button class="linkish" style="color:inherit;text-align:left" onClick=${() => go('trace', { q: p.productLot, mode: 'product', packKey: `${p.productLot}|${p.productCode}` })}>${(productOf(state, p.productCode) || {}).name || p.productCode}</button>` },
        { key: 'lot', label: '제품 LOT', render: (p) => html`<button class="linkish" onClick=${() => go('trace', { q: p.productLot, mode: 'product', packKey: `${p.productLot}|${p.productCode}` })}>${p.productLot}</button>`, sub: (p) => `소비기한 ${fmtDate(p.expiry)}` },
        { key: 'qty', label: '수량', num: true, render: (p) => n(p.qty), sub: (p) => `${n(packKg(state, p), 1)} kg` },
        { key: 'mat', label: '포장재 LOT', render: (p) => (p.packLots || []).map((x) => (state.materialLots.find((l) => l.id === x.lotId) || {}).lot).filter(Boolean).join(', ') || '—' },
        { key: 'note', label: '비고' },
        { key: 'act', label: '', render: (p) => p.kind === 'repack' ? html`<div class="row-actions"><button class="icon-btn" aria-label="수정" onClick=${() => setPackModal({ rec: p })}><${Icon} name="edit" /></button><button class="icon-btn danger" aria-label="삭제" disabled=${!state.canWrite} onClick=${() => delPack(p)}><${Icon} name="trash" /></button></div>` : html`<div class="row-actions"><button class="icon-btn" aria-label="배치에서 수정" title="배치에서 수정" onClick=${() => { const b = state.batches.find((x) => x.id === p.batchId); if (b) setBatchModal({ rec: b }); }}><${Icon} name="edit" /></button></div>` },
      ]} empty=${html`<${Empty} title="포장 내역이 없습니다">충진 배치 등록에서 제품·소비기한별 양품을 넣으면 제품 LOT가 생깁니다.<//>`} />
    <//>
    </div></details>

    ${batchModal && html`<${BatchModal} state=${state} date=${date} init=${batchModal} onClose=${() => setBatchModal(null)} />`}
    ${packModal && (packModal.rec
      ? html`<${PackModal} state=${state} date=${date} init=${packModal} onClose=${() => setPackModal(null)} />`
      : html`<${PackMultiModal} state=${state} date=${date} init=${packModal} onClose=${() => setPackModal(null)} />`)}`;
}

/** 새 포장 등록: 한 배치에 제품·소비기한별로 여러 줄을 한 번에 등록 (줄마다 제품 LOT 생성) */
function PackMultiModal({ state, date, init, onClose }) {
  const s = state.settings;
  const batch0 = init.batchId ? state.batches.find((b) => b.id === init.batchId) : null;
  const [kind, setKind] = useState(init.kind || 'normal');
  const [batchId, setBatchId] = useState(batch0 ? batch0.id : '');
  const [pdate, setPdate] = useState(batch0 ? batch0.date : date);
  const [work, setWork] = useState({ workers: '', hours: '' });
  const [note, setNote] = useState('');
  const batch = state.batches.find((b) => b.id === batchId);
  const products = [...state.products].sort((a, b) => (a.mixType || '').localeCompare(b.mixType || '') || a.name.localeCompare(b.name));
  const matching = batch && batch.mixType ? products.filter((p) => !p.mixType || p.mixType === batch.mixType) : products;
  const firstProduct = matching[0] ? matching[0].code : '';
  const [lines, setLines] = useState([{ productCode: firstProduct, expiry: '', qty: batch0 ? String(batch0.goodEa) : '', productLot: '' }]);
  const setLine = (i, patch) => setLines((o) => { const r = [...o]; r[i] = { ...r[i], ...patch }; return r; });
  const recentBatches = state.batches.filter((b) => b.date >= addDays(pdate, -7) && b.date <= addDays(pdate, 1) || b.id === batchId).sort((a, b) => b.date.localeCompare(a.date));
  const fillerCode = batch ? fillerOf(state, batch.fillerId).code || '' : '';
  const expiryOf = (l) => { if (l.expiry) return l.expiry; const p = productOf(state, l.productCode); return p && p.shelfDays ? addDays(pdate, num(p.shelfDays)) : ''; };
  const lotOf = (l) => l.productLot || productLot(s.productLotDateBase === 'fill' ? pdate : expiryOf(l), pdate, fillerCode);
  const totalQty = sum(lines, (l) => calc(l.qty));
  const addLine = (i) => setLines((o) => { const base = o[i] || o[o.length - 1]; return [...o.slice(0, i + 1), { productCode: base.productCode, expiry: '', qty: '', productLot: '' }, ...o.slice(i + 1)]; });
  const submit = async () => {
    const valid = lines.filter((l) => l.productCode && calc(l.qty) > 0);
    if (!valid.length) { toast('제품과 수량을 입력하세요.', 'bad'); return; }
    if (kind === 'normal' && !batchId) { toast('일반 포장은 충진 배치를 연결해야 합니다.', 'bad'); return; }
    for (const l of valid) if (!expiryOf(l)) { toast(`${(productOf(state, l.productCode) || {}).name || l.productCode}의 소비기한을 입력하세요.`, 'bad'); return; }
    let count = 0;
    for (const l of valid) {
      const qty = calc(l.qty); const expiry = expiryOf(l);
      const packLots = bomRequirements(state, l.productCode, qty).map((r) => { const lot = pickMaterialLot(state, r.materialCode); return { materialCode: r.materialCode, lotId: lot ? lot.id : '', qty: Math.round(r.total * 1000) / 1000 }; });
      await save('packs', { id: uid(), batchId: kind === 'normal' ? batchId : (batchId || ''), date: pdate, kind, productCode: l.productCode, productLot: (l.productLot || '').trim() || lotOf(l), expiry, qty, usedKg: null, workers: kind === 'repack' ? num(work.workers) : 0, hours: kind === 'repack' ? num(work.hours) : 0, packLots, note });
      count++;
    }
    toast(`포장 ${count}건을 등록했습니다.`); onClose();
  };
  return html`<${Modal} title="포장 내역 등록" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>취소</button><button class="btn primary" onClick=${submit}>${lines.filter((l) => calc(l.qty) > 0).length || ''} 등록</button>`}>
    <div class="form-grid">
      <${Field} label="포장일 (충진일)"><input type="date" value=${pdate} onInput=${(e) => setPdate(e.target.value)} /><//>
      <${Field} label="충진 배치" hint=${batch ? `${fillerOf(state, batch.fillerId).name} · ${batch.mixType || ''} · 양품 ${n(batch.goodEa)} ea` : ''}><select value=${batchId} onChange=${(e) => { const b = state.batches.find((x) => x.id === e.target.value); setBatchId(e.target.value); if (b) setPdate(b.date); }}><option value="">선택</option>${recentBatches.map((b) => html`<option key=${b.id} value=${b.id}>${b.batchNo} · 양품 ${n(b.goodEa)} ea</option>`)}</select><//>
      ${kind === 'repack' && html`<${Field} label="작업인원 (명)"><input type="number" min="0" value=${work.workers} onInput=${(e) => setWork({ ...work, workers: e.target.value })} /><//>
        <${Field} label="근로시간 (h)"><input type="number" min="0" step="0.1" value=${work.hours} onInput=${(e) => setWork({ ...work, hours: e.target.value })} /><//>`}
    </div>
    <div class="fieldset"><div class="legend">제품 · 소비기한별 포장 수량 · 합계 ${n(totalQty)} ea${batch ? ` / 양품 ${n(batch.goodEa)} ea` : ''} · 줄마다 제품 LOT가 따로 생깁니다</div>
      ${lines.map((l, i) => { const p = productOf(state, l.productCode); return html`<div key=${i} class="src-row" style="grid-template-columns:minmax(0,1.4fr) 150px 110px minmax(0,1fr) 36px">
        <${Field} label=${i === 0 ? '제품' : ''}><select value=${l.productCode} onChange=${(e) => setLine(i, { productCode: e.target.value })}><option value="">선택</option>${matching.map((x) => html`<option key=${x.code} value=${x.code}>${x.name.replace(/^충진[-_]\s*/, '')}</option>`)}</select><//>
        <${Field} label=${i === 0 ? '소비기한' : ''}><${DateInput} value=${l.expiry || expiryOf(l)} onChange=${(v) => setLine(i, { expiry: v })} /><//>
        <${Field} label=${i === 0 ? `수량 (${p ? p.unit : 'ea'})` : ''}><${NumInput} value=${l.qty} onChange=${(v) => setLine(i, { qty: v })} /><//>
        <${Field} label=${i === 0 ? '제품 LOT' : ''}><input value=${l.productLot} placeholder=${lotOf(l)} onInput=${(e) => setLine(i, { productLot: e.target.value })} /><//>
        <button class="icon-btn danger" aria-label="제거" disabled=${lines.length === 1} onClick=${() => setLines((o) => o.filter((_, j) => j !== i))}><${Icon} name="x" /></button>
      </div>`; })}
      <div class="row"><button class="btn sm" onClick=${() => addLine(lines.length - 1)}><${Icon} name="plus" />소비기한 추가</button></div>
    </div>
    <${Field} label="비고"><input value=${note} onInput=${(e) => setNote(e.target.value)} /><//>
  <//>`;
}

const ROLES = [['fill', '충진'], ['cap', '캡'], ['pack', '포장']];
const splitNames = (s) => String(s || '').split(/[,،\s]+/).map((x) => x.trim()).filter(Boolean);

// 24시간 시각 입력: "735" "0735" "7:35" "1830" → "07:35" "18:30". 0~24시, 자정은 24:00. 오전/오후 선택기 없이 직접 타이핑.
export function normTime(v) {
  const s = String(v || '').trim().replace(/[^\d:]/g, '');
  if (!s) return '';
  let h, m;
  if (s.includes(':')) { const [a, b = '0'] = s.split(':'); h = Number(a); m = Number((b + '00').slice(0, 2)); }
  else if (s.length <= 2) { h = Number(s); m = 0; }
  else { h = Number(s.slice(0, s.length - 2)); m = Number(s.slice(-2)); }
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 24 || m < 0 || m > 59 || (h === 24 && m > 0)) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
export function TimeInput({ value, onChange }) {
  const [raw, setRaw] = useState(value || '');
  useEffect(() => { if ((value || '') !== (normTime(raw) || '')) setRaw(value || ''); }, [value]);
  const norm = normTime(raw);
  const bad = raw !== '' && norm == null;
  const commit = () => { if (norm != null) { setRaw(norm); onChange(norm); } };
  return html`<input type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" value=${raw} class=${bad ? 'input-bad' : ''} style=${bad ? 'border-color:var(--bad)' : ''} title="24시간 표기. 예: 0735, 7:35, 1830" onInput=${(e) => { const v = e.target.value; const digits = v.replace(/\D/g, ''); if (!v.includes(':') && digits.length === 4) { const t = normTime(digits); if (t != null) { setRaw(t); onChange(t); return; } } setRaw(v); }} onBlur=${commit} onKeyDown=${(e) => { if (e.key === 'Enter') { commit(); e.target.blur(); } }} />`;
}

// 날짜 직접 입력: "261109" → "2026-11-09", "20261109", "26.11.9", "2026-11-09" 모두 허용. 6자리/8자리 숫자는 치는 즉시 변환.
export function normDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let y, m, d;
  const parts = s.split(/[^\d]+/).filter(Boolean);
  if (parts.length === 3) { [y, m, d] = parts.map(Number); if (parts[0].length <= 2) y += 2000; }
  else { const digits = s.replace(/\D/g, ''); if (digits.length === 6) { y = 2000 + Number(digits.slice(0, 2)); m = Number(digits.slice(2, 4)); d = Number(digits.slice(4, 6)); } else if (digits.length === 8) { y = Number(digits.slice(0, 4)); m = Number(digits.slice(4, 6)); d = Number(digits.slice(6, 8)); } else return null; }
  if (!(y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const chk = new Date(iso + 'T00:00:00'); if (Number.isNaN(chk.getTime()) || chk.getDate() !== d) return null;
  return iso;
}
export function DateInput({ value, onChange, placeholder = 'YYMMDD' }) {
  const [raw, setRaw] = useState(value || '');
  useEffect(() => { if ((value || '') !== (normDate(raw) || '')) setRaw(value || ''); }, [value]);
  const norm = normDate(raw);
  const bad = raw !== '' && norm == null;
  const commit = () => { if (norm != null) { setRaw(norm); onChange(norm); } };
  return html`<input type="text" inputmode="numeric" maxlength="10" placeholder=${placeholder} value=${raw} style=${bad ? 'border-color:var(--bad)' : ''} title="예: 261109 → 2026-11-09, 20261109, 26.11.9" onInput=${(e) => { const v = e.target.value; const digits = v.replace(/\D/g, ''); if (digits.length === v.length && (digits.length === 6 || digits.length === 8)) { const t = normDate(digits); if (t != null) { setRaw(t); onChange(t); return; } } setRaw(v); }} onBlur=${commit} onKeyDown=${(e) => { if (e.key === 'Enter') { commit(); e.target.blur(); } }} />`;
}

function BatchModal({ state, date, init, onClose }) {
  const s = state.settings;
  const density = s.milkDensity || 1.03;
  const rec = init.rec;
  const stocks = useMemo(() => state.cultures.map((c) => ({ c, stock: cultureStock(state, c.id) })), [state]);
  const stockOf = (cultureId) => stocks.find((x) => x.c.id === cultureId);
  const moves = useMemo(() => state.separations.filter((m) => m.kind === 'move' && (!m.batchId || (rec && m.batchId === rec.id))).map((m) => ({ ...m, culture: state.cultures.find((c) => c.id === m.cultureId) })).sort((a, b) => a.date.localeCompare(b.date)), [state, rec]);

  const [f, setF] = useState(() => {
    // 양품 kg 0·작업자 비어 있음(전산 임시·엑셀 복원 배치) → 새 배치처럼 자동값(수량 × 규격, 설비 기본 작업자)을 쓴다
    // 계근량 0(전산 임시) → 비운 상태로 열어 드링크 설비는 자동 계근(양품 ea × 용량 × 비중)이 적용되게 함
    const recCrew = { fill: (rec?.crew?.fill || []).join(', '), cap: (rec?.crew?.cap || []).join(', '), pack: (rec?.crew?.pack || []).join(', ') };
    const noCrew = rec && !recCrew.fill && !recCrew.cap && !recCrew.pack;
    if (rec) return { ...rec, mixType: rec.mixType || '', inputKg: num(rec.inputKg) ? rec.inputKg : '', goodKg: rec.goodKg == null || !num(rec.goodKg) ? '' : rec.goodKg, ingredientKg: rec.ingredientKg ?? '', startTime: rec.startTime || '', endTime: rec.endTime || '', breakMin: rec.breakMin ?? '', crew: noCrew ? defaultCrew(rec.fillerId) : recCrew, crewTouched: !noCrew,moveIds: (rec.sources || []).filter((x) => x.moveId).map((x) => x.moveId), drinks: (rec.sources || []).filter((x) => x.kind === 'drink').map((x) => ({ ...x })), ingredientTouched: rec.ingredientKg != null };
    // 드링크 원액 프리셋: 배출일이 같은 LOT 여러 개를 한 배치에 함께 (presetCultureIds), 단일 LOT는 presetCultureId
    const presetIds = init.presetCultureIds || (init.presetCultureId ? [init.presetCultureId] : []);
    const presets = presetIds.map(stockOf).filter((x) => x && x.stock.drinkRemainingL > 0);
    const presetDrink = presets.length > 0;
    const drinkFiller = (s.fillers.find((x) => /드링크/.test(x.name)) || s.fillers[0]).id;
    const fillerId = init.fillerId || (presetDrink ? drinkFiller : (s.fillers[0]?.id || ''));
    return { id: uid(), date: init.date || date, fillerId, mixType: init.mixType || (presetDrink ? '드링크' : ''), batchNo: '', moveIds: init.moveIds || [],
      drinks: presets.map((p) => ({ cultureId: p.c.id, kind: 'drink', liters: String(p.stock.drinkRemainingL), kg: Math.round(p.stock.drinkRemainingL * density * 10) / 10 })),
      ingredientKg: '', ingredientTouched: false, inputKg: '', wasteKg: '', goodEa: '', defectEa: '', goodKg: '', startTime: '', endTime: '', breakMin: '', crew: defaultCrew(fillerId), crewTouched: false, note: '' };
  });
  // 설비별 기본 작업자 (기준정보) → 쉼표 문자열. 작업자를 직접 고치기 전까지는 설비를 바꾸면 따라 바뀜
  function defaultCrew(fillerId) { const c = (s.fillers.find((x) => x.id === fillerId) || {}).crew || {}; return { fill: (c.fill || []).join(', '), cap: (c.cap || []).join(', '), pack: (c.pack || []).join(', ') }; }
  const set = (k, v) => setF((x) => (k === 'fillerId' && !x.crewTouched ? { ...x, fillerId: v, crew: defaultCrew(v) } : { ...x, [k]: v }));
  const selectedMoves = moves.filter((m) => f.moveIds.includes(m.id));
  // 드링크 원액 칸은 드링크 설비에서만 (다른 설비는 면포 반출만 사용)
  const isDrinkFiller = /드링크/.test((s.fillers.find((x) => x.id === f.fillerId) || {}).name || '');
  // 새 배치인데 11월 이후 1~4호기·로타리·반자동이면 여기서 등록하지 않고 충진일지 등록으로 (기존 배치 수정은 가능)
  const toJournal = !rec && journalOnly(state, f.fillerId, f.date);
  // ---- 충진 = 포장: 제품·소비기한별 양품 줄 (저장 시 줄마다 포장 내역/제품 LOT 생성) ----
  const existingPacks = rec ? state.packs.filter((p) => p.batchId === rec.id && p.kind !== 'repack') : [];
  // 배치 등록 제품 선택: 기준정보에서 '충진 목록'으로 표시한 제품만, 표시 순서대로 (이미 저장된 줄의 제품은 목록에서 빠져도 유지)
  const products = state.products.filter((p) => p.fillList || existingPacks.some((x) => x.productCode === p.code));
  const matching = products; // 재공품 유형과 상관없이 충진 목록 전체를 표시 순서대로
  const [lines, setLines] = useState(() => existingPacks.length ? existingPacks.map((p) => ({ packId: p.id, productCode: p.productCode, expiry: p.expiry || '', qty: String(p.qty ?? ''), productLot: p.productLot || '', packLots: p.packLots || [] }))
    : [{ productCode: '', expiry: '', qty: '', productLot: '', packLots: [] }]);
  const setLine = (i, patch) => setLines((o) => { const r = [...o]; r[i] = { ...r[i], ...patch }; return r; });
  const addLine = () => setLines((o) => { const base = o[o.length - 1] || {}; return [...o, { productCode: base.productCode || '', expiry: '', qty: '', productLot: '', packLots: [] }]; });
  const fillerCodeOf = (fid) => (s.fillers.find((x) => x.id === fid) || {}).code || '';
  const expiryOf = (l) => { if (l.expiry) return l.expiry; const p = productOf(state, l.productCode); return p && p.shelfDays ? addDays(f.date, num(p.shelfDays)) : ''; };
  const lotOf = (l) => l.productLot || productLot(s.productLotDateBase === 'fill' ? f.date : expiryOf(l), f.date, fillerCodeOf(f.fillerId));
  const linesGoodEa = sum(lines, (l) => calc(l.qty));
  const linesGoodKg = Math.round(sum(lines, (l) => { const p = productOf(state, l.productCode); return p ? calc(l.qty) * num(p.weightG) / 1000 : 0; }) * 10) / 10;
  const fermentKg = sum(selectedMoves, (m) => m.kg) + sum(f.drinks, (d) => d.kg);
  const ratio = mixRatio(state, f.mixType);
  // 엑셀 충진 시트 N열과 동일: 부원료 = 계근량 × (1 − 1/비율), 출고량 = 발효유(면포 × 포당 무게 합) + 부원료
  // 드링크 설비 계근량: 비우면 Σ(양품 ea × 용량 L) × 비중(1.03). 1.8L → ea × 1.03 × 1.8, 750ml → ea × 1.03 × 0.75 (용량은 제품 단위중량 g ÷ 1000)
  const milkDensity = state.settings.milkDensity || 1.03;
  const drinkAutoKg = isDrinkFiller ? Math.round(sum(lines, (l) => { const p = productOf(state, l.productCode); return p ? calc(l.qty) * num(p.weightG) / 1000 * milkDensity : 0; }) * 10) / 10 : 0;
  const inputAuto = isDrinkFiller && (f.inputKg === '' || f.inputKg == null);
  const inputKgV = inputAuto ? drinkAutoKg : calc(f.inputKg), wasteKgV = calc(f.wasteKg), defectEaV = calc(f.defectEa);
  const goodEaV = linesGoodEa;                                   // 양품 = 제품·소비기한 줄 합계
  const goodKgV = f.goodKg === '' || f.goodKg == null ? linesGoodKg : calc(f.goodKg); // 양품 kg: 직접 입력 없으면 줄 합계(수량 × 규격)
  const ingredientKg = ratio > 1 ? Math.round(inputKgV * (1 - 1 / ratio) * 10) / 10 : 0;
  const outKg = Math.round((fermentKg + ingredientKg) * 10) / 10;
  const netInput = Math.max(0, inputKgV - wasteKgV);
  const mixYield = outKg > 0 && inputKgV > 0 ? inputKgV / outKg * 100 : null;
  const fillYield = netInput > 0 && goodKgV > 0 ? goodKgV / netInput * 100 : null;
  const lossKg = inputKgV > 0 ? Math.round((netInput - goodKgV) * 10) / 10 : 0; // LOSS = 계근량 − 폐기 − 양품 kg (자동)
  const lossPct = netInput > 0 ? lossKg / netInput * 100 : null;
  const runMin = batchRunMin({ startTime: f.startTime, endTime: f.endTime, breakMin: f.breakMin });
  const persons = ROLES.reduce((a, [k]) => a + splitNames(f.crew[k]).length, 0);
  const fillerName = fillerOf(state, f.fillerId).name;
  const autoNo = () => { const seq = state.batches.filter((b) => b.date === f.date && b.fillerId === f.fillerId && b.id !== f.id).length + 1; return batchNo(f.date, fillerName, seq, f.mixType); };
  // 설비가 정해진 반출은 해당 설비에서만, '대기'(설비 미정) 반출은 어느 설비에서든 선택 가능.
  // 기본은 충진일에 반출된 면포만 보이고, 다른 날 반출은 버튼으로 펼침 (이미 선택된 반출은 항상 보임)
  const [showOtherDates, setShowOtherDates] = useState(false);
  const onDate = (m) => (m.fillDate || m.date) === f.date || f.moveIds.includes(m.id);
  const otherDateMoves = moves.filter((m) => !onDate(m) && (!m.fillerId || m.fillerId === f.fillerId));
  const visibleMoves = moves.filter((m) => (!m.fillerId || m.fillerId === f.fillerId || f.moveIds.includes(m.id)) && (showOtherDates || onDate(m)));
  const otherMoves = moves.filter((m) => m.fillerId && m.fillerId !== f.fillerId && !f.moveIds.includes(m.id));
  const [showOthers, setShowOthers] = useState(false);
  // 목록이 길어서 기본은 선택한 반출만 보여주고, 아무것도 안 골랐을 때만 펼쳐 둠
  const [expanded, setExpanded] = useState(() => f.moveIds.length === 0);
  const hiddenMoves = expanded ? [] : visibleMoves.filter((m) => !f.moveIds.includes(m.id));
  const shownMoves = expanded ? visibleMoves : visibleMoves.filter((m) => f.moveIds.includes(m.id));
  const toggleMove = (id) => setF((o) => ({ ...o, moveIds: o.moveIds.includes(id) ? o.moveIds.filter((x) => x !== id) : [...o.moveIds, id] }));
  const availableL = (cultureId) => { const o = stockOf(cultureId); if (!o) return 0; const was = rec ? num((rec.sources || []).find((x) => x.cultureId === cultureId && x.kind === 'drink')?.liters) : 0; return o.stock.drinkRemainingL + was; };
  const drinkOptions = stocks.filter(({ c }) => availableL(c.id) > 0 || f.drinks.some((d) => d.cultureId === c.id)).sort((a, b) => b.c.date.localeCompare(a.c.date));
  const setDrink = (i, patch) => setF((o) => { const r = [...o.drinks]; r[i] = { ...r[i], ...patch }; return { ...o, drinks: r }; });
  const allNames = useMemo(() => [...new Set([...(s.workers || []), ...s.fillers.flatMap((x) => crewNames({ crew: x.crew })), ...state.batches.flatMap((b) => crewNames(b))])], [state]);

  const submit = async () => {
    const sources = [
      ...selectedMoves.map((m) => ({ moveId: m.id, cultureId: m.cultureId, kind: 'cloth', cloths: num(m.cloths), liters: 0, kg: num(m.kg) })),
      ...f.drinks.filter((d) => d.cultureId && num(d.liters) > 0).map((d) => ({ cultureId: d.cultureId, kind: 'drink', cloths: 0, liters: num(d.liters), kg: num(d.kg) })),
    ];
    // 전산 임시 배치(전산 대조에서 미리 등록)는 면포·계근 없이도 저장 가능 — 둘 다 채워지면 정식 배치가 됨
    const draft = !!(rec && rec.erpDraft);
    const fromErp = draft || !!(rec && rec.erpImportedAt); // 전산에서 미리 잡은 배치는 정식이 된 뒤에도 면포 없이 저장 가능
    if (!sources.length && !fromErp) { toast('반출 면포를 선택하거나 드링크 원액을 입력하세요.', 'bad'); return; }
    for (const d of sources.filter((x) => x.kind === 'drink')) if (d.liters > availableL(d.cultureId) + 0.5) { toast(`${(state.cultures.find((c) => c.id === d.cultureId) || {}).lot} 드링크 이동량(${n(availableL(d.cultureId))} L)을 초과했습니다.`, 'bad'); return; }
    if (!f.mixType) { toast('재공품 유형을 선택하세요.', 'bad'); return; }
    if (inputKgV <= 0 && !draft) { toast('계근량을 입력하세요.', 'bad'); return; }
    // 임시 → 정식 전환 조건: 계근량 또는 작업시간(시작·종료)을 넣으면 정식. 면포(배양·유청분리) 연결은 조건이 아님 (사용자 요청)
    const hasTimes = !!(f.startTime && f.endTime);
    const stillDraft = draft && inputKgV <= 0 && !hasTimes;
    const validLines = lines.filter((l) => l.productCode && calc(l.qty) > 0);
    for (const l of validLines) if (!expiryOf(l)) { toast(`${(productOf(state, l.productCode) || {}).name || '제품'}의 소비기한을 입력하세요.`, 'bad'); return; }
    const crew = { fill: splitNames(f.crew.fill), cap: splitNames(f.crew.cap), pack: splitNames(f.crew.pack) };
    const doc = { id: f.id, date: f.date, fillerId: f.fillerId, mixType: f.mixType, batchNo: (f.batchNo || '').trim() || autoNo(), sources,
      fermentKg: Math.round(fermentKg * 10) / 10, ingredientKg, outKg, inputKg: inputKgV, wasteKg: wasteKgV, goodEa: goodEaV, defectEa: defectEaV, goodKg: f.goodKg === '' || f.goodKg == null ? null : goodKgV, lossKg,
      startTime: f.startTime, endTime: f.endTime, breakMin: num(f.breakMin), runMin, crew, workers: persons, hours: Math.round(runMin / 60 * 100) / 100, note: f.note || '',
      ...(fromErp ? { erpDraft: stillDraft, erpImportedAt: rec.erpImportedAt || '' } : {}) };
    await save('batches', doc);
    // 정식 배치면 같은 날·설비의 전산 임시 배치에서 같은 제품 줄을 빼고(줄이 안 남으면 임시 배치 삭제) → 분석에 이중 집계되지 않음
    const absorbed = doc.erpDraft ? null : await absorbErpDrafts(doc, validLines.map((l) => l.productCode));
    // 제품·소비기한 줄 → 포장 내역(제품 LOT) 동기화: 있던 줄은 수정, 지운 줄은 삭제, 새 줄은 생성
    const keep = new Set();
    for (const l of validLines) {
      const qty = calc(l.qty); const expiry = expiryOf(l);
      const prev = l.packId ? existingPacks.find((p) => p.id === l.packId) : null;
      const prevLots = (l.packLots || []).filter((x) => x.lotId);
      const packLots = bomRequirements(state, l.productCode, qty).map((r) => { const kept = prevLots.find((x) => x.materialCode === r.materialCode); const lot = kept ? null : pickMaterialLot(state, r.materialCode); return { materialCode: r.materialCode, lotId: kept ? kept.lotId : (lot ? lot.id : ''), qty: Math.round(r.total * 1000) / 1000 }; });
      const id = prev ? prev.id : uid(); keep.add(id);
      await save('packs', { ...(prev || {}), id, batchId: doc.id, date: doc.date, kind: 'normal', productCode: l.productCode, productLot: (l.productLot || '').trim() || lotOf(l), expiry, qty, usedKg: null, workers: 0, hours: 0, packLots, note: prev ? prev.note || '' : '' });
    }
    for (const p of existingPacks) if (!keep.has(p.id)) await remove('packs', p.id);
    // 반출 기록 배정/해제 · '대기' 반출은 이 배치의 설비로 확정
    for (const m of moves) {
      const want = f.moveIds.includes(m.id);
      if (want && (m.batchId !== doc.id || m.fillerId !== doc.fillerId)) await save('separations', { ...m, culture: undefined, batchId: doc.id, fillerId: doc.fillerId });
      else if (!want && m.batchId === doc.id) await save('separations', { ...m, culture: undefined, batchId: null });
    }
    const absorbMsg = absorbed && (absorbed.removed || absorbed.trimmed) ? ` 전산 임시 배치 ${[absorbed.removed ? `${absorbed.removed}건 자동 삭제` : '', absorbed.trimmed ? `${absorbed.trimmed}건에서 같은 제품 줄 제거` : ''].filter(Boolean).join(' · ')}.` : '';
    toast((rec ? (draft && !stillDraft ? '계근량·작업시간이 들어가 정식 배치가 됐습니다.' : '수정했습니다.') : `배치 ${doc.batchNo}를 등록했습니다.`) + absorbMsg); onClose();
  };

  return html`<${Modal} title=${rec ? `충진 배치 수정 · ${rec.batchNo}` : '충진 배치 등록'} onClose=${onClose} footer=${html`${rec && rec.erpDraft ? html`<span class="left note" style="margin:0"><${Chip} tone="warn" dot>전산 임시<//> 계근량이나 작업시간(시작·종료)을 넣으면 정식 배치가 됩니다</span>` : ''}<button class="btn" onClick=${onClose}>취소</button><button class="btn primary" disabled=${toJournal} title=${toJournal ? '11월부터 이 설비는 충진일지 등록에서 입력합니다' : ''} onClick=${submit}>${rec ? '저장' : '등록'}</button>`}>
    ${toJournal && html`<div class="banner warn" style="font-size:12.5px"><${Icon} name="alert" /><span><b>11월부터 ${fillerName} 충진 실적은 충진일지 등록에서 입력합니다.</b> 유청분리에서 반출한 면포가 일지 저장 때 자동으로 연결됩니다. 벌크·드링크만 여기서 등록하세요.</span></div>`}
    <div class="form-grid sticky-head">
      <${Field} label="충진일"><input type="date" value=${f.date} onInput=${(e) => set('date', e.target.value)} /><//>
      <${Field} label="충진설비"><select value=${f.fillerId} onChange=${(e) => set('fillerId', e.target.value)}>${s.fillers.map((x) => html`<option key=${x.id} value=${x.id}>${x.name}${x.code ? ` (${x.code})` : ''}</option>`)}</select><//>
      <${Field} label="재공품 유형" hint=${ratio !== 1 ? `부재료 비율 ${ratio}` : ''}><select value=${f.mixType} onChange=${(e) => set('mixType', e.target.value)}><option value="">선택</option>${(s.mixTypes || []).map((m) => html`<option key=${m.name} value=${m.name}>${m.name}</option>`)}</select><//>
      <${Field} label="배치번호" hint=${`비우면 자동: ${autoNo()}`}><input value=${f.batchNo} placeholder=${autoNo()} onInput=${(e) => set('batchNo', e.target.value)} /><//>
    </div>

    <div class="fieldset"><div class="legend" style="display:flex;align-items:center;gap:10px"><span>반출된 면포 선택 (유청분리팀 기록) · 선택 ${selectedMoves.length}건 · 발효유 ${n(sum(selectedMoves, (m) => m.kg), 1)} kg</span>
        ${visibleMoves.length > 0 && html`<button class="btn sm ghost" style="margin-left:auto" onClick=${() => setExpanded(!expanded)}><${Icon} name=${expanded ? 'up' : 'down'} />${expanded ? '접기' : (hiddenMoves.length ? `${hiddenMoves.length}건 더 보기` : '펼치기')}</button>`}</div>
      ${visibleMoves.length === 0 && html`<div class="note">${fmtDate(f.date)}에 ${fillerName}로 반출됐거나 설비 미정(대기)인 면포가 없습니다.${otherDateMoves.length ? ` 다른 날 반출된 면포 ${otherDateMoves.length}건은 아래 버튼으로 볼 수 있습니다.` : ' 유청분리 화면에서 먼저 반출을 기록하세요.'}</div>`}
      ${otherDateMoves.length > 0 && html`<div><button class="btn sm ghost" onClick=${() => setShowOtherDates(!showOtherDates)}><${Icon} name=${showOtherDates ? 'x' : 'eye'} />${showOtherDates ? '다른 날 반출 숨기기' : `다른 날 반출된 ${otherDateMoves.length}건 보기`}</button></div>`}
      ${shownMoves.map((m) => html`<label key=${m.id} class="pick ${f.moveIds.includes(m.id) ? 'on' : ''}"><input type="checkbox" checked=${f.moveIds.includes(m.id)} onChange=${() => toggleMove(m.id)} />
        <span class="lot">${m.culture ? m.culture.lot : m.cultureId}</span><span>${fmtDate(m.date)} 반출 · ${m.mixType || '유형 없음'}${m.source === 'press' ? ' · 필터프레스' : ''}${m.mixType && f.mixType && m.mixType !== f.mixType ? ' (유형 다름)' : ''}${m.fillerId ? '' : ' · 설비 대기'}</span><span class="tnum" style="margin-left:auto">${n(m.cloths)}포 · ${n(m.kg, 1)} kg</span></label>`)}
      ${!expanded && hiddenMoves.length > 0 && html`<div class="note" style="margin:0">선택하지 않은 반출 ${hiddenMoves.length}건은 접혀 있습니다. 더 고르려면 위의 "더 보기"를 누르세요.</div>`}
      ${expanded && otherMoves.length > 0 && html`<div><button class="btn sm ghost" onClick=${() => setShowOthers(!showOthers)}>${showOthers ? '다른 설비 반출 숨기기' : `다른 설비로 반출된 ${otherMoves.length}건 보기`}</button></div>`}
      ${expanded && showOthers && otherMoves.map((m) => html`<label key=${m.id} class="pick"><input type="checkbox" checked=${false} onChange=${() => toggleMove(m.id)} /><span class="lot">${m.culture ? m.culture.lot : m.cultureId}</span><span>${fmtDate(m.date)} · ${fillerOf(state, m.fillerId).name} · ${m.mixType || ''}${m.source === 'press' ? ' · 필터프레스' : ''}</span><span class="tnum" style="margin-left:auto">${n(m.cloths)}포 · ${n(m.kg, 1)} kg</span></label>`)}
    </div>

    ${(isDrinkFiller || f.drinks.length > 0) && html`<div class="fieldset"><div class="legend">드링크 원액 (배양 당일 직송 · 소분 없음)</div>
      ${f.drinks.map((d, i) => html`<div key=${i} class="src-row">
        <${Field} label="배양 LOT"><select value=${d.cultureId} onChange=${(e) => setDrink(i, { cultureId: e.target.value, liters: '', kg: '' })}><option value="">선택</option>${drinkOptions.map(({ c }) => html`<option key=${c.id} value=${c.id}>${c.lot} · ${c.tankId.replace('T', '')}번 · 가능 ${n(availableL(c.id))} L</option>`)}</select><//>
        <${Field} label="드링크 (L)"><input type="number" min="0" step="1" value=${d.liters} onInput=${(e) => setDrink(i, { liters: e.target.value, kg: Math.round(num(e.target.value) * density * 10) / 10 })} /><//>
        <${Field} label="kg"><input type="number" min="0" step="0.1" value=${d.kg} onInput=${(e) => setDrink(i, { kg: e.target.value })} /><//>
        <button class="icon-btn danger" aria-label="제거" onClick=${() => setF((o) => ({ ...o, drinks: o.drinks.filter((_, j) => j !== i) }))}><${Icon} name="x" /></button>
      </div>`)}
      <div><button class="btn sm" onClick=${() => setF((o) => ({ ...o, drinks: [...o.drinks, { cultureId: '', kind: 'drink', liters: '', kg: '' }] }))}><${Icon} name="plus" />드링크 LOT 추가</button></div>
    </div>`}

    <div class="form-grid">
      <${Field} label="계근량 (kg)" hint=${inputAuto ? `비우면 자동: 양품 ${n(goodEaV)} ea × ${milkDensity} × 용량(L) = ${n(drinkAutoKg, 1)} kg` : isExpr(f.inputKg) ? `= ${n(inputKgV, 1)}` : mixYield != null ? `재공품 수율 ${pct(mixYield)}` : ''}><${NumInput} value=${f.inputKg} placeholder=${inputAuto ? n(drinkAutoKg, 1) : ''} onChange=${(v) => set('inputKg', v)} /><//>
      <${Field} label="버퍼탱크 폐기 (kg)" hint=${isExpr(f.wasteKg) ? `= ${n(wasteKgV, 1)}` : ''}><${NumInput} value=${f.wasteKg} onChange=${(v) => set('wasteKg', v)} /><//>
      <${Field} label="발효유 출고 (kg)" hint="면포 × 포당 무게 합 (자동)"><input type="number" value=${n(fermentKg, 1).replace(/,/g, '')} readonly /><//>
      <${Field} label="소요자재 출고량 (kg)" hint=${ratio > 1 ? `발효유 + 부원료 ${n(ingredientKg, 1)} (계근 × (1 − 1/${ratio}))` : '발효유 (부원료 없음)'}><input type="number" value=${outKg} readonly /><//>
      <${Field} label="양품 (ea)" hint="아래 제품·소비기한 줄의 합계"><input type="number" value=${goodEaV} readonly /><//>
      <${Field} label="불량 (ea)" hint=${isExpr(f.defectEa) ? `= ${n(defectEaV)}` : ''}><${NumInput} value=${f.defectEa} onChange=${(v) => set('defectEa', v)} /><//>
      <${Field} label="양품 (kg)" hint=${isExpr(f.goodKg) ? `= ${n(goodKgV, 1)}` : (fillYield != null ? `충진 수율 ${pct(fillYield)} · ` : '') + (f.goodKg === '' || f.goodKg == null ? `자동 ${n(linesGoodKg, 1)} (수량 × 규격)` : '직접 입력')}><${NumInput} value=${f.goodKg ?? ''} onChange=${(v) => set('goodKg', v)} placeholder=${n(linesGoodKg, 1)} /><//>
      <${Field} label="LOSS (kg)" hint=${inputKgV > 0 ? `계근 ${n(inputKgV, 1)} − 폐기 ${n(wasteKgV, 1)} − 양품 ${n(goodKgV, 1)}${lossPct != null ? ` · ${pct(lossPct)}` : ''}` : '계근량 − 폐기 − 양품 kg (자동)'}><input type="number" value=${lossKg} readonly style=${lossKg < 0 ? 'color:var(--bad)' : ''} /><//>
    </div>

    <div class="fieldset"><div class="legend">제품 · 소비기한별 양품 수량 · 합계 ${n(goodEaV)} ea · 줄마다 제품 LOT가 생깁니다</div>
      ${lines.map((l, i) => { const p = productOf(state, l.productCode); return html`<div key=${i} class="src-row" style="grid-template-columns:minmax(0,1.4fr) 150px 110px minmax(0,1fr) 36px">
        <${Field} label=${i === 0 ? '제품' : ''}><select value=${l.productCode} onChange=${(e) => setLine(i, { productCode: e.target.value })}><option value="">선택</option>${matching.map((x) => html`<option key=${x.code} value=${x.code}>${x.name.replace(/^충진[-_]\s*/, '')}</option>`)}</select><//>
        <${Field} label=${i === 0 ? '소비기한' : ''}><${DateInput} value=${l.expiry || expiryOf(l)} onChange=${(v) => setLine(i, { expiry: v })} /><//>
        <${Field} label=${i === 0 ? `양품 (${p ? p.unit : 'ea'})` : ''}><${NumInput} value=${l.qty} onChange=${(v) => setLine(i, { qty: v })} /><//>
        <${Field} label=${i === 0 ? '제품 LOT' : ''}><input value=${l.productLot} placeholder=${l.productCode ? lotOf(l) : ''} onInput=${(e) => setLine(i, { productLot: e.target.value })} /><//>
        <button class="icon-btn danger" aria-label="제거" disabled=${lines.length === 1} onClick=${() => setLines((o) => o.filter((_, j) => j !== i))}><${Icon} name="x" /></button>
      </div>`; })}
      <div class="row"><button class="btn sm" onClick=${addLine}><${Icon} name="plus" />소비기한 추가</button></div>
    </div>

    <div class="fieldset"><div class="legend">작업 시간과 작업자 · 가동 ${n(runMin)}분${autoBreakDetail(f.startTime, f.endTime).length ? ` (${autoBreakDetail(f.startTime, f.endTime).map((x) => `${x.label} ${x.min}분`).join(' · ')} 자동 차감)` : ''} · ${persons}명 · ${n(persons * runMin / 60, 1)} 인시${runMin > 0 && goodEaV > 0 ? ` · ${n(bpmOf(goodEaV, runMin), 1)} BPM (양품 ÷ 가동 분${fillerStdBpm(state, f.fillerId) ? ` · 기준 ${n(fillerStdBpm(state, f.fillerId), 1)} → 달성 ${pct(bpmPct(bpmOf(goodEaV, runMin), fillerStdBpm(state, f.fillerId)), 0)}` : ''})` : ''}</div>
      <div class="form-grid">
        <${Field} label="시작 (24시간)" hint="0735, 7:35처럼 입력"><${TimeInput} value=${f.startTime} onChange=${(v) => set('startTime', v)} /><//>
        <${Field} label="종료 (24시간)" hint="1830, 18:30 · 자정은 24:00"><${TimeInput} value=${f.endTime} onChange=${(v) => set('endTime', v)} /><//>
        <${Field} label="추가 휴게 (분)" hint="점심·오전 휴게는 시간대로 자동 차감 · 그 외 멈춘 시간만"><input type="number" min="0" value=${f.breakMin} onInput=${(e) => set('breakMin', e.target.value)} /><//>
      </div>
      <div class="form-grid">
        ${ROLES.map(([k, label]) => html`<${Field} key=${k} label=${`${label} 작업자`} hint="쉼표로 구분 · 설비 기본값이 채워짐"><input list="worker-names" value=${f.crew[k]} onInput=${(e) => setF((o) => ({ ...o, crewTouched: true, crew: { ...o.crew, [k]: e.target.value } }))} /><//>`)}
      </div>
      <datalist id="worker-names">${allNames.map((nm) => html`<option key=${nm} value=${nm} />`)}</datalist>
    </div>
    <${Field} label="비고"><input value=${f.note || ''} onInput=${(e) => set('note', e.target.value)} /><//>
  <//>`;
}

function PackModal({ state, date, init, onClose }) {
  const s = state.settings;
  const rec = init.rec;
  const batch0 = init.batchId ? state.batches.find((b) => b.id === init.batchId) : null;
  const [f, setF] = useState(() => rec ? { ...rec, packAuto: null, packLots: (rec.packLots || []).map((x) => ({ ...x })) } : {
    id: uid(), batchId: batch0 ? batch0.id : '', date: batch0 ? batch0.date : date, kind: 'normal', productCode: '', productLot: '', expiry: '', qty: batch0 ? batch0.goodEa : '', usedKg: '', workers: '', hours: '', packLots: [], packAuto: true, note: '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const batch = state.batches.find((b) => b.id === f.batchId);
  const product = productOf(state, f.productCode);
  const products = [...state.products].sort((a, b) => (a.mixType || '').localeCompare(b.mixType || '') || a.name.localeCompare(b.name));
  const matching = batch && batch.mixType ? products.filter((p) => !p.mixType || p.mixType === batch.mixType) : products;
  const mat = useMemo(() => materialStock(state), [state]);
  const packMats = mat.lots.filter((l) => l.material.kind === 'pack' && (l.remaining > 0 || f.packLots.some((x) => x.lotId === l.id)));
  const recentBatches = state.batches.filter((b) => b.date >= addDays(f.date, -7) && b.date <= addDays(f.date, 1) || b.id === f.batchId).sort((a, b) => b.date.localeCompare(a.date));
  const autoExpiry = () => product && product.shelfDays ? addDays(f.date, num(product.shelfDays)) : '';
  const expiry = f.expiry || autoExpiry();
  const fillerCode = batch ? fillerOf(state, batch.fillerId).code || '' : '';
  const autoLot = () => productLot(s.productLotDateBase === 'fill' ? f.date : expiry, f.date, fillerCode);
  // BOM 기준 포장재 소요량: 제품·수량이 바뀌면 자동으로 채움 (사용자가 직접 고친 뒤에는 유지)
  const reqs = useMemo(() => bomRequirements(state, f.productCode, num(f.qty)), [state, f.productCode, f.qty]);
  const fillFromBom = () => setF((o) => ({ ...o, packAuto: true, packLots: bomRequirements(state, o.productCode, num(o.qty)).map((r) => { const prev = o.packLots.find((x) => x.materialCode === r.materialCode); const lot = prev && prev.lotId ? null : pickMaterialLot(state, r.materialCode); return { materialCode: r.materialCode, lotId: prev && prev.lotId ? prev.lotId : (lot ? lot.id : ''), qty: Math.round(r.total * 1000) / 1000, perUnit: r.qty, unit: r.unit, name: r.material.name }; }) }));
  useEffect(() => { if (rec && f.packAuto == null) return; if (f.packAuto === false) return; if (!f.productCode || reqs.length === 0) return; fillFromBom(); }, [f.productCode, f.qty, reqs.length]);
  const matName = (code) => (state.materials.find((m) => m.code === code) || {}).name || code;
  const lotsFor = (code) => code ? mat.lots.filter((l) => l.materialCode === code && (l.remaining > 0 || f.packLots.some((x) => x.lotId === l.id))) : packMats;
  const submit = async () => {
    if (!f.productCode) { toast('제품을 선택하세요.', 'bad'); return; }
    if (num(f.qty) <= 0) { toast('포장 수량을 입력하세요.', 'bad'); return; }
    if (f.kind === 'normal' && !f.batchId) { toast('일반 포장은 충진 배치를 연결해야 합니다.', 'bad'); return; }
    if (!expiry) { toast('소비기한을 입력하세요. (제품에 소비기한 일수가 있으면 자동)', 'bad'); return; }
    const doc = { ...f, packAuto: undefined, productLot: (f.productLot || '').trim() || autoLot(), expiry, qty: num(f.qty), usedKg: f.usedKg === '' || f.usedKg == null ? null : num(f.usedKg), workers: num(f.workers), hours: num(f.hours),
      packLots: f.packLots.filter((x) => x.lotId || x.materialCode).map((x) => ({ lotId: x.lotId || '', materialCode: x.materialCode || (state.materialLots.find((l) => l.id === x.lotId) || {}).materialCode || '', qty: num(x.qty) })) };
    await save('packs', doc); toast(rec ? '수정했습니다.' : `제품 LOT ${doc.productLot}을 등록했습니다.`); onClose();
  };
  return html`<${Modal} title=${rec ? `포장 내역 수정 · ${rec.productLot}` : '포장 내역 등록'} onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>취소</button><button class="btn primary" onClick=${submit}>${rec ? '저장' : '등록'}</button>`}>
    <div class="form-grid">
      <${Field} label="포장일 (충진일)"><input type="date" value=${f.date} onInput=${(e) => set('date', e.target.value)} /><//>
      <${Field} label="충진 배치" hint=${batch ? `${fillerOf(state, batch.fillerId).name} · ${batch.mixType || ''}` : ''}><select value=${f.batchId} onChange=${(e) => { const b = state.batches.find((x) => x.id === e.target.value); setF((o) => ({ ...o, batchId: e.target.value, date: b ? b.date : o.date, qty: o.qty === '' && b ? b.goodEa : o.qty })); }}><option value="">선택</option>${recentBatches.map((b) => html`<option key=${b.id} value=${b.id}>${b.batchNo} · 양품 ${n(b.goodEa)} ea</option>`)}</select><//>
      <${Field} label="제품"><select value=${f.productCode} onChange=${(e) => set('productCode', e.target.value)}><option value="">선택</option>${matching.map((p) => html`<option key=${p.code} value=${p.code}>${p.name}${p.mixType ? ` (${p.mixType})` : ''}</option>`)}</select><//>
      <${Field} label="소비기한" hint=${autoExpiry() ? `비우면 자동: ${autoExpiry()}` : '제품에 소비기한 일수를 넣으면 자동'}><${DateInput} value=${f.expiry} onChange=${(v) => set('expiry', v)} /><//>
      <${Field} label="제품 LOT" hint=${`비우면 자동: ${autoLot() || '(소비기한·배치 필요)'}`}><input value=${f.productLot} placeholder=${autoLot()} onInput=${(e) => set('productLot', e.target.value)} /><//>
      <${Field} label=${`포장 수량 (${product ? product.unit : 'ea'})`}><input type="number" min="0" value=${f.qty} onInput=${(e) => set('qty', e.target.value)} /><//>
      <${Field} label="사용 중량 (kg)" hint=${product ? `비우면 수량 × ${product.weightG} g` : ''}><input type="number" min="0" step="0.1" value=${f.usedKg ?? ''} onInput=${(e) => set('usedKg', e.target.value)} /><//>
      ${f.kind === 'repack' && html`<${Field} label="작업인원 (명)"><input type="number" min="0" value=${f.workers} onInput=${(e) => set('workers', e.target.value)} /><//>
        <${Field} label="근로시간 (h)"><input type="number" min="0" step="0.1" value=${f.hours} onInput=${(e) => set('hours', e.target.value)} /><//>`}
      <${Field} label="비고" class="span-all"><input value=${f.note || ''} onInput=${(e) => set('note', e.target.value)} /><//>
    </div>
    <div class="fieldset"><div class="legend">포장재 소요량 · ${reqs.length ? `BOM 기준 자동 계산 (${reqs.length}개 자재)` : '이 제품의 BOM이 없어 직접 입력'}</div>
      ${f.packLots.map((x, i) => { const lots = lotsFor(x.materialCode); return html`<div key=${i} class="src-row" style="grid-template-columns:1fr 1fr 110px 36px">
        <${Field} label="자재" hint=${x.perUnit != null ? `단위소요량 ${x.perUnit} ${x.unit || ''}` : ''}><input value=${x.materialCode ? matName(x.materialCode) : '(LOT에서 선택)'} readonly /><//>
        <${Field} label="LOT" hint=${x.materialCode && !lots.length ? '등록된 LOT 없음' : ''}><select value=${x.lotId} onChange=${(e) => setF((o) => { const r = [...o.packLots]; const l = state.materialLots.find((m) => m.id === e.target.value); r[i] = { ...r[i], lotId: e.target.value, materialCode: r[i].materialCode || (l ? l.materialCode : '') }; return { ...o, packLots: r, packAuto: false }; })}><option value="">${x.materialCode ? 'LOT 미지정' : '선택'}</option>${lots.map((l) => html`<option key=${l.id} value=${l.id}>${l.lot} · ${x.materialCode ? '' : l.material.name + ' · '}잔량 ${n(l.remaining)}</option>`)}</select><//>
        <${Field} label=${`사용량 (${x.unit || (state.materials.find((m) => m.code === x.materialCode) || {}).unit || ''})`}><input type="number" min="0" step="any" value=${x.qty} onInput=${(e) => setF((o) => { const r = [...o.packLots]; r[i] = { ...r[i], qty: e.target.value }; return { ...o, packLots: r, packAuto: false }; })} /><//>
        <button class="icon-btn danger" aria-label="제거" onClick=${() => setF((o) => ({ ...o, packLots: o.packLots.filter((_, j) => j !== i), packAuto: false }))}><${Icon} name="x" /></button>
      </div>`; })}
      <div class="row"><button class="btn sm" onClick=${() => setF((o) => ({ ...o, packLots: [...o.packLots, { materialCode: '', lotId: '', qty: o.qty }], packAuto: false }))}><${Icon} name="plus" />자재 추가</button>${reqs.length > 0 && html`<button class="btn sm ghost" onClick=${fillFromBom}>BOM으로 다시 계산</button>`}</div>
    </div>
  <//>`;
}
