// 유청분리팀 실적: 배양 LOT별 면포 소분, 충진설비로 반출(Flow), 폐기, 재고
import { html, useState, useEffect, useMemo, Card, Chip, Icon, Field, Modal, DataTable, Empty, toast, confirmAsync, exportCSV } from '../ui.js';
import { save, remove } from '../store.js';
import { cultureStock, STATUS, tankOf, fillerOf, canPress } from '../model.js';

// 반출 면포 출처 (1~4번 탱크만 선택): 유청분리실에서 소분한 면포인지, 필터프레스에서 작업한 면포인지
const SOURCE_OPTS = [['room', '유청분리실'], ['press', '필터프레스']];
// 충진설비 선택 칸의 '폐기' 항목 값: 이 값을 고른 줄은 반출(move)이 아니라 폐기(dispose) 기록으로 저장됨
const DISPOSE = '__dispose__';
export const sourceLabel = (m) => m && m.source === 'press' ? '필터프레스' : m && m.source === 'room' ? '유청분리실' : '';
import { n, fmtDate, dow, addDays, today, uid, num, monthRange, groupBy } from '../util.js';

export function SeparationPage({ state, params, go }) {
  const [date, setDate] = useState(params.date || addDays(today(), -1)); // 실적 입력은 전일 기준으로 시작
  const [draft, setDraft] = useState({});
  const [dispose, setDispose] = useState(null);
  const [move, setMove] = useState(null);
  const [editMove, setEditMove] = useState(null);
  const [scope, setScope] = useState('open');
  useEffect(() => { if (params.date) setDate(params.date); }, [params.date]);

  const rows = useMemo(() => {
    let list = state.cultures.filter((c) => c.date <= date && c.date >= addDays(date, -14)).map((c) => ({ c, stock: cultureStock(state, c.id), tank: tankOf(state, c.tankId) })).filter((r) => r.stock.hasWhey);
    // 기본 보기: 충진 완료·전량 폐기 LOT와, 소분 후 전부 반출·폐기되어 재고 0포가 된 LOT는 숨김.
    // 단, 재고 0이어도 충진 설비가 아직 정해지지 않은(설비 대기) 반출이 남아 있으면 계속 표시. 설비가 지정된 반출만 남았으면 숨김 (전체 보기에서는 모두 확인 가능)
    const hasUnassigned = (r) => r.stock.pendingMoves.some((m) => !m.fillerId);
    if (scope === 'open') list = list.filter((r) => r.stock.wheyStatus !== 'done' && r.stock.wheyStatus !== 'disposed' && !(r.stock.splits.length > 0 && r.stock.remaining <= 0 && !hasUnassigned(r)));
    if (params.cultureId && !list.some((r) => r.c.id === params.cultureId)) { const c = state.cultures.find((x) => x.id === params.cultureId); if (c) list.unshift({ c, stock: cultureStock(state, c.id), tank: tankOf(state, c.tankId) }); }
    return list.sort((a, b) => b.c.date.localeCompare(a.c.date) || a.c.tankId.localeCompare(b.c.tankId));
  }, [state, date, scope, params.cultureId]);

  const get = (r, key) => { const d = draft[r.c.id]; if (d && key in d) return d[key]; const sp = r.stock.splits[0]; return sp ? sp[key] ?? '' : ''; };
  const setD = (id, key, v) => setDraft((d) => ({ ...d, [id]: { ...(d[id] || {}), [key]: v } }));
  // 필터프레스 LOT: 처음 입력하는 값은 유청분리실에서 소분한 포 수이고, 입력을 마치면 필터프레스 예상 포 수를 더해 전체 면포 수로 바꿈.
  // 한 번 합쳐진 뒤(또는 이미 소분 기록이 있으면)에는 전체 수를 직접 고치는 것으로 봄.
  const pressCloths = (r) => Math.round(r.stock.pressClothsEst);
  const combineDraft = (r, d) => {
    if (!d || d.combined || !r.stock.hasPress || r.stock.splits.length) return d;
    const room = num(d.cloths); if (room <= 0) return d;
    const pc = pressCloths(r);
    return { ...d, cloths: String(room + pc), roomCloths: room, pressCloths: pc, combined: true };
  };
  const combinePress = (r) => {
    const d = draft[r.c.id]; const nd = combineDraft(r, d);
    if (nd === d) return;
    setDraft((o) => ({ ...o, [r.c.id]: nd }));
    toast(`${r.c.lot}: 유청분리실 ${n(nd.roomCloths)}포 + 필터프레스 ${n(nd.pressCloths)}포 = ${n(num(nd.cloths))}포`);
  };
  // 입력 칸 아래 설명: 유청분리실 N + 필터프레스 M
  const splitHint = (r) => {
    const d = draft[r.c.id]; const sp = r.stock.splits[0];
    if (d && d.combined) return `유청분리실 ${n(d.roomCloths)} + 필터프레스 ${n(d.pressCloths)}`;
    if (!d && sp && sp.pressCloths != null) return `유청분리실 ${n(sp.roomCloths)} + 필터프레스 ${n(sp.pressCloths)}`;
    if (r.stock.hasPress && !sp) return `입력 후 필터프레스 약 ${n(pressCloths(r))}포가 더해집니다`;
    return '';
  };
  // 필터프레스 LOT인데 합산 전에 저장된 소분 기록: 버튼으로 필터프레스 예상 포 수를 더해 줌
  const addPressToSaved = (r) => {
    const sp = r.stock.splits[0]; if (!sp) return;
    const pc = pressCloths(r); const room = num(sp.cloths);
    setDraft((o) => ({ ...o, [r.c.id]: { cloths: String(room + pc), roomCloths: room, pressCloths: pc, combined: true } }));
    toast(`${r.c.lot}: 유청분리실 ${n(room)}포 + 필터프레스 ${n(pc)}포 = ${n(room + pc)}포 · 저장을 눌러 확정하세요`);
  };
  const saveAll = async () => {
    let count = 0;
    for (const r of rows) {
      const d0 = draft[r.c.id]; if (!d0) continue;
      const d = combineDraft(r, d0);
      const cloths = num(d.cloths);
      if (cloths <= 0) continue;
      // 포당 무게는 입력받지 않고 엑셀처럼 유청분리 대상 kg ÷ 면포 수로 계산 (물량 수지용)
      const kgPer = Math.floor(r.stock.wheyKg / cloths * 1e6) / 1e6;
      const sp = r.stock.splits[0];
      const pc = d.pressCloths ?? (sp && sp.pressCloths != null ? sp.pressCloths : null);
      const extra = r.stock.hasPress && pc != null ? { pressCloths: pc, roomCloths: Math.max(0, cloths - pc) } : {};
      await save('separations', { id: sp ? sp.id : uid(), cultureId: r.c.id, kind: 'split', date: sp ? sp.date : date, cloths, kgPerCloth: kgPer, kg: Math.round(cloths * kgPer * 10) / 10, note: sp ? sp.note || '' : '', ...extra });
      count++;
    }
    setDraft({}); toast(count ? `${count}건 소분 실적을 저장했습니다.` : '변경된 내용이 없습니다.');
  };
  const month = monthRange(date.slice(0, 7));
  const log = useMemo(() => state.separations.filter((s) => s.date >= month.from && s.date <= month.to).map((s) => ({ s, c: state.cultures.find((c) => c.id === s.cultureId), batch: s.batchId ? state.batches.find((b) => b.id === s.batchId) : null })).sort((a, b) => b.s.date.localeCompare(a.s.date) || (a.c?.tankId || '').localeCompare(b.c?.tankId || '')), [state, month.from]);
  const moves = log.filter((r) => r.s.kind === 'move');
  const others = log.filter((r) => r.s.kind !== 'move');
  const del = async (s) => { if (s.kind === 'move' && s.batchId) { toast('충진 배치에 배정된 반출은 배치에서 먼저 제외하세요.', 'bad'); return; } if (await confirmAsync('이 기록을 삭제할까요?')) { await remove('separations', s.id); toast('삭제했습니다.'); } };
  const dirty = Object.keys(draft).length > 0;
  const totalStock = rows.reduce((a, r) => a + Math.max(0, r.stock.remaining), 0);
  const pendingMoves = moves.filter((r) => !r.batch);

  return html`
    <div class="page-head"><div><div class="eyebrow">유청분리팀</div><h1>유청분리 · 면포 소분 · 반출</h1></div>
      <div class="actions"><button class="btn" onClick=${() => exportCSV(`면포재고_${date}.csv`, ['배양일', '탱크', '배양 LOT', '소분일', '소분 면포', '포당 kg', '총 kg', '반출', '폐기', '재고', '상태'], rows.map((r) => [r.c.date, r.tank.name, r.c.lot, r.stock.splits[0]?.date || '', r.stock.splitCloths, r.stock.kgPerCloth != null ? n(r.stock.kgPerCloth, 2) : '', n(r.stock.splitKg, 1), r.stock.usedCloths, r.stock.disposedCloths, r.stock.remaining, STATUS[r.stock.wheyStatus].label]))}><${Icon} name="download" />CSV</button></div></div>

    <${Card} title="탱크별 면포 재고" count=${rows.length} desc=${`재고 합계 ${n(totalStock)}포 · 최근 14일 배양 LOT · 충진 배정 대기 반출 ${pendingMoves.length}건`} actions=${html`
        <div class="seg"><button class=${scope === 'open' ? 'active' : ''} onClick=${() => setScope('open')}>남은 재고·소분 대기·설비 미정</button><button class=${scope === 'all' ? 'active' : ''} onClick=${() => setScope('all')}>전체 (반출 완료 포함)</button></div>
        <button class="btn primary" disabled=${!dirty || !state.canWrite} onClick=${saveAll}><${Icon} name="check" />면포 수량 저장</button>`} flush>
      <div class="filters" style="padding:12px 18px 4px"><${Field} label="소분일 (새 기록에 적용)"><div class="row" style="flex-wrap:nowrap"><button class="btn sm" onClick=${() => setDate(addDays(date, -1))} aria-label="이전 날"><${Icon} name="left" /></button><input id="sep-date" type="date" class="input" style="width:150px" value=${date} onInput=${(e) => e.target.value && setDate(e.target.value)} /><button class="btn sm" onClick=${() => setDate(addDays(date, 1))} aria-label="다음 날"><${Icon} name="right" /></button></div><//></div>
      ${rows.length === 0 ? html`<${Empty} title="소분할 배양 LOT가 없습니다">배양팀에서 원유량을 저장하면 여기에 표시됩니다.<//>`
        : [...groupBy(rows, (r) => r.c.date)].map(([d, list]) => html`<div key=${'g' + d} class="table-wrap">
          <div class="group-head">${fmtDate(d)} (${dow(d)}) 배양 · ${list.length} LOT · 재고 ${n(list.reduce((a, r) => a + Math.max(0, r.stock.remaining), 0))}포 · 배정 대기 반출 ${list.reduce((a, r) => a + r.stock.pendingMoves.length, 0)}건</div>
          <table class="tbl stock">
          <thead><tr><th style="width:70px">탱크</th><th>배양 LOT</th><th class="num" style="width:110px">소분 면포</th><th>반출 · 폐기 내역</th><th class="num" style="width:80px">재고</th><th style="width:120px">상태</th><th style="width:130px"></th></tr></thead>
          <tbody>
            ${list.map((r) => html`<tr key=${r.c.id}>
              <td><b>${r.tank.name.replace(' 탱크', '')}</b></td>
              <td><button class="linkish" onClick=${() => go('trace', { cultureId: r.c.id })}>${r.c.lot}</button><span class="sub">${r.stock.hasPress ? html`<span class="chip accent" style="margin-right:4px">필터프레스</span>${n(r.c.pressL)} L → 예상 약 ${n(r.stock.pressClothsEst, 1)}포${r.stock.wheyRoomKg > 0 ? ` · 유청분리실 ${n(r.stock.wheyRoomKg)} kg` : ''}` : r.stock.hasDrink ? `유청분리 ${n(r.stock.wheyKg)} kg (드링크 ${n(r.c.drinkL)} L 제외)` : `원유 ${n(r.c.rawKg)} kg`}</span></td>
              <td class="num"><input type="number" min="0" class="input" style="width:90px;text-align:right;min-height:32px;padding:4px 8px" value=${get(r, 'cloths')} placeholder="0" title=${r.stock.hasPress && !r.stock.splits.length ? '유청분리실에서 소분한 포 수를 입력하면 필터프레스 예상 포 수가 자동으로 더해집니다.' : ''} onInput=${(e) => setD(r.c.id, 'cloths', e.target.value)} onBlur=${() => combinePress(r)} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />${splitHint(r) && html`<div class="sub" style="font-size:11px;margin-top:3px;white-space:nowrap">${splitHint(r)}</div>`}${r.stock.hasPress && r.stock.splits.length > 0 && r.stock.splits[0].pressCloths == null && !draft[r.c.id] && html`<button class="linkish" style="font-size:11px;margin-top:3px;white-space:nowrap" title="저장된 소분 수가 유청분리실 분만이라면 필터프레스 예상 포 수를 더합니다" onClick=${() => addPressToSaved(r)}>+ 필터프레스 ${n(pressCloths(r))}포 더하기</button>`}</td>
              <td><div class="chips">
                ${r.stock.moves.map((m) => html`<span key=${m.id} class="chip ${m.batch ? 'good' : m.fillerId ? 'info' : 'bad'} clickable" style=${m.fillerId ? '' : 'font-weight:700'} title=${(m.batch ? `${m.batch.batchNo} 배정` : m.fillerId ? '충진 배정 대기' : '충진 설비 미정 · 클릭해서 설비를 정하세요') + ' · 클릭하면 수정'} onClick=${() => setEditMove({ m, r })}>${m.source === 'press' ? html`<b style="margin-right:3px">FP</b>` : ''}${m.fillerId ? fillerOf(state, m.fillerId).name : '설비 미정'} ${m.mixType || ''} <b>${n(m.cloths)}포</b>${m.batch ? '' : html`<button class="chip-x" aria-label="반출 취소" title="반출 취소" disabled=${!state.canWrite} onClick=${(e) => { e.stopPropagation(); del(m); }}>×</button>`}</span>`)}
                ${r.stock.disposes.map((s) => html`<span key=${s.id} class="chip bad" title=${(s.source === 'press' ? '필터프레스 면포 폐기' : '폐기') + (s.note ? ' · ' + s.note : '')}>${s.source === 'press' ? html`<b style="margin-right:3px">FP</b>` : ''}폐기 <b>${n(s.cloths)}포</b></span>`)}
                ${!r.stock.moves.length && !r.stock.disposes.length && html`<span class="muted">—</span>`}
              </div></td>
              <td class="num">${r.stock.splits.length ? html`<b>${n(r.stock.remaining)}</b>포` : '—'}</td>
              <td><${Chip} tone=${STATUS[r.stock.wheyStatus].tone} dot>${STATUS[r.stock.wheyStatus].label}<//></td>
              <td><div class="row-actions"><button class="btn sm primary" disabled=${!r.stock.splits.length || r.stock.remaining <= 0 || !state.canWrite} onClick=${() => setMove(r)}>반출</button><button class="btn sm" disabled=${!r.stock.splits.length || r.stock.remaining <= 0 || !state.canWrite} onClick=${() => setDispose(r)}>폐기</button></div></td>
            </tr>`)}</tbody>
        </table></div>`)}
    <//>

    <details class="formula"><summary>이 달의 반출 · 소분 · 폐기 기록 전체 (${log.length}건)</summary><div class="inner" style="gap:14px">
    <${Card} title="반출 기록 (유청분리 → 충진설비)" count=${moves.length} desc=${`${date.slice(0, 7)} 월 전체`} flush>
      <${DataTable} rows=${moves} keyFn=${(r) => r.s.id} cols=${[
        { key: 'date', label: '반출일', render: (r) => fmtDate(r.s.date) },
        { key: 'lot', label: '배양 LOT', render: (r) => r.c ? html`<button class="linkish" onClick=${() => go('trace', { cultureId: r.c.id })}>${r.c.lot}</button>` : '(삭제된 배양)' },
        { key: 'filler', label: '받는 설비', render: (r) => r.s.fillerId ? fillerOf(state, r.s.fillerId).name : html`<${Chip}>대기<//>` }, { key: 'mix', label: '재공품 유형', render: (r) => r.s.mixType || '—' },
        { key: 'source', label: '면포 출처', render: (r) => r.s.source === 'press' ? html`<${Chip} tone="accent">필터프레스<//>` : r.s.source === 'room' ? '유청분리실' : html`<span class="muted">—</span>` },
        { key: 'cloths', label: '면포 (포)', num: true, render: (r) => n(r.s.cloths) },
        { key: 'status', label: '충진 배정', render: (r) => r.batch ? html`<${Chip} tone="good">${r.batch.batchNo}<//>` : html`<${Chip} tone="info" dot>배정 대기<//>` },
        { key: 'note', label: '비고', render: (r) => r.s.note || '' },
        { key: 'act', label: '', render: (r) => html`<div class="row-actions"><button class="icon-btn" aria-label="수정" title="수정" onClick=${() => { if (r.c) setEditMove({ m: { ...r.s, batch: r.batch }, r: { c: r.c, stock: cultureStock(state, r.c.id) } }); }}><${Icon} name="edit" /></button><button class="icon-btn danger" aria-label="삭제" disabled=${!state.canWrite || !!r.batch} onClick=${() => del(r.s)}><${Icon} name="trash" /></button></div>` },
      ]} empty=${html`<${Empty} title="이 달의 반출 기록이 없습니다">위 표에서 LOT의 '반출' 버튼으로 충진설비에 보낸 면포를 등록하세요.<//>`} />
    <//>

    <${Card} title="소분 · 폐기 기록" count=${others.length} desc=${`${date.slice(0, 7)} 월 전체`} flush>
      <${DataTable} rows=${others} keyFn=${(r) => r.s.id} cols=${[
        { key: 'date', label: '일자', render: (r) => fmtDate(r.s.date) }, { key: 'kind', label: '구분', render: (r) => r.s.kind === 'split' ? html`<${Chip} tone="accent">소분<//>` : html`<${Chip} tone="bad">${r.s.source === 'press' ? 'FP 폐기' : '폐기'}<//>` },
        { key: 'lot', label: '배양 LOT', render: (r) => r.c ? html`<button class="linkish" onClick=${() => go('trace', { cultureId: r.c.id })}>${r.c.lot}</button>` : '(삭제된 배양)' },
        { key: 'cloths', label: '면포 (포)', num: true, render: (r) => n(r.s.cloths) },
        { key: 'note', label: '비고', render: (r) => r.s.note || '' },
        { key: 'act', label: '', render: (r) => html`<div class="row-actions"><button class="icon-btn danger" aria-label="삭제" disabled=${!state.canWrite} onClick=${() => del(r.s)}><${Icon} name="trash" /></button></div>` },
      ]} empty=${html`<div class="empty">이 달의 소분 기록이 없습니다.</div>`} />
    <//>
    </div></details>

    ${move && html`<${MoveModal} state=${state} r=${move} date=${date} onClose=${() => setMove(null)} />`}
    ${editMove && html`<${MoveEditModal} state=${state} m=${editMove.m} r=${editMove.r} onClose=${() => setEditMove(null)} />`}
    ${dispose && html`<${DisposeModal} state=${state} r=${dispose} date=${date} onClose=${() => setDispose(null)} />`}`;
}

function MoveModal({ state, r, date, onClose }) {
  const s = state.settings;
  const kgPer = r.stock.kgPerCloth || 0;
  // 드링크는 배양에서 드링크 충진설비로 바로 가므로 유청분리 반출에서는 제외
  const mixNames = (s.mixTypes || []).map((m) => m.name).filter((m) => m !== '드링크');
  const defaultMix = mixNames.includes('플레인') ? '플레인' : mixNames[0] || '';
  const pressTank = canPress(state, r.c.tankId);
  const defaultSource = r.stock.hasPress && r.stock.wheyRoomKg <= 0 ? 'press' : 'room';
  const newRow = () => ({ fillerId: '', mixType: defaultMix, cloths: '', source: defaultSource, note: '' });
  const [f, setF] = useState({ date, rows: [newRow()] });
  const setRow = (i, patch) => setF((o) => { const rows = [...o.rows]; rows[i] = { ...rows[i], ...patch }; return { ...o, rows }; });
  const total = f.rows.reduce((a, x) => a + num(x.cloths), 0);
  const left = r.stock.remaining - total;
  // 충진설비 칸에서 '폐기'를 고른 줄은 반출이 아니라 폐기 기록으로 저장 (재고에서 빠지고 어느 설비로도 가지 않음)
  const disposeRows = f.rows.filter((x) => x.fillerId === DISPOSE && num(x.cloths) > 0);
  const disposeTotal = disposeRows.reduce((a, x) => a + num(x.cloths), 0);
  const submit = async () => {
    const rows = f.rows.filter((x) => num(x.cloths) > 0);
    if (!rows.length) { toast('반출 면포 수를 입력하세요.', 'bad'); return; }
    if (total > r.stock.remaining) { toast(`재고(${r.stock.remaining}포)보다 많이 반출할 수 없습니다. (합계 ${total}포)`, 'bad'); return; }
    let nMove = 0, nDisp = 0;
    for (const x of rows) {
      const cloths = num(x.cloths);
      const kg = Math.round(cloths * kgPer * 10) / 10;
      if (x.fillerId === DISPOSE) { nDisp++; await save('separations', { id: uid(), cultureId: r.c.id, kind: 'dispose', date: f.date, cloths, kg, source: pressTank ? x.source || 'room' : '', note: (x.note || '').trim() }); continue; }
      nMove++;
      await save('separations', { id: uid(), cultureId: r.c.id, kind: 'move', date: f.date, fillDate: f.date, fillerId: x.fillerId, mixType: x.mixType, cloths, kg, batchId: null, source: pressTank ? x.source || 'room' : '', note: (x.note || '').trim() });
    }
    const parts = [nMove ? `반출 ${nMove}건(${n(total - disposeTotal)}포)` : '', nDisp ? `폐기 ${nDisp}건(${n(disposeTotal)}포)` : ''].filter(Boolean);
    toast(`${r.c.lot} ${parts.join(' · ')}을 기록했습니다.`); onClose();
  };
  const cols = pressTank ? '1fr 1fr 84px 112px 1fr 36px' : '1fr 1fr 100px 1.2fr 36px';
  return html`<${Modal} title=${`면포 반출 · ${r.c.lot}`} onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>취소</button><button class="btn primary" onClick=${submit}>${disposeTotal > 0 && disposeTotal === total ? '폐기 기록' : disposeTotal > 0 ? '반출 · 폐기 기록' : '반출 기록'}</button>`}>
    <div class="form-grid">
      <${Field} label="반출일"><input type="date" value=${f.date} onInput=${(e) => setF({ ...f, date: e.target.value })} /><//>
    </div>
    <div class="fieldset"><div class="legend">반출 면포 · 재고 ${n(r.stock.remaining)}포 중 ${n(total - disposeTotal)}포 반출${disposeTotal > 0 ? ` · ${n(disposeTotal)}포 폐기` : ''} · ${left >= 0 ? `남는 재고 ${n(left)}포` : html`<span style="color:var(--bad)">재고 초과 ${n(-left)}포</span>`}</div>
      ${f.rows.map((x, i) => html`<div key=${i} class="src-row" style=${`grid-template-columns:${cols}`}>
        <${Field} label=${i === 0 ? '충진설비' : ''}><select value=${x.fillerId} style=${x.fillerId === DISPOSE ? 'color:var(--bad);font-weight:700' : ''} onChange=${(e) => setRow(i, { fillerId: e.target.value })}><option value="">대기 (설비 미정)</option>${s.fillers.filter((o) => !/드링크/.test(o.name)).map((o) => html`<option key=${o.id} value=${o.id}>${o.name}</option>`)}<option value=${DISPOSE}>폐기 (설비로 보내지 않음)</option></select><//>
        <${Field} label=${i === 0 ? '재공품 유형' : ''}>${x.fillerId === DISPOSE ? html`<div class="input muted" style="display:flex;align-items:center">—</div>` : html`<select value=${x.mixType} onChange=${(e) => setRow(i, { mixType: e.target.value })}>${mixNames.map((m) => html`<option key=${m} value=${m}>${m}</option>`)}</select>`}<//>
        <${Field} label=${i === 0 ? '면포 (포)' : ''}><input type="number" min="0" value=${x.cloths} onInput=${(e) => setRow(i, { cloths: e.target.value })} /><//>
        ${pressTank && html`<${Field} label=${i === 0 ? '면포 출처' : ''}><select value=${x.source} onChange=${(e) => setRow(i, { source: e.target.value })}>${SOURCE_OPTS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select><//>`}
        <${Field} label=${i === 0 ? '비고' : ''}><input value=${x.note} placeholder=${x.fillerId === DISPOSE ? '폐기 사유 (예: 면포 파손)' : ''} onInput=${(e) => setRow(i, { note: e.target.value })} /><//>
        <button class="icon-btn danger" aria-label="제거" disabled=${f.rows.length === 1} onClick=${() => setF((o) => ({ ...o, rows: o.rows.filter((_, j) => j !== i) }))}><${Icon} name="x" /></button>
      </div>`)}
      <div><button class="btn sm" onClick=${() => setF((o) => ({ ...o, rows: [...o.rows, newRow()] }))}><${Icon} name="plus" />줄 추가</button></div>
    </div>
  <//>`;
}

/** 반출 기록 수정. 충진 배치에 배정된 반출은 면포 수·설비를 잠그고 날짜·유형·비고만 수정 */
function MoveEditModal({ state, m, r, onClose }) {
  const s = state.settings;
  const kgPer = r.stock.kgPerCloth || 0;
  const locked = !!m.batch;
  const mixNames = (s.mixTypes || []).map((x) => x.name).filter((x) => x !== '드링크' || x === m.mixType);
  const pressTank = canPress(state, r.c.tankId);
  const [f, setF] = useState({ date: m.date, fillerId: m.fillerId || '', mixType: m.mixType || '', cloths: String(m.cloths ?? ''), source: m.source || 'room', note: m.note || '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const maxCloths = r.stock.remaining + num(m.cloths);
  const submit = async () => {
    const cloths = locked ? num(m.cloths) : num(f.cloths);
    if (cloths <= 0) { toast('반출 면포 수를 입력하세요.', 'bad'); return; }
    if (cloths > maxCloths) { toast(`재고를 넘습니다. 이 반출을 포함해 최대 ${maxCloths}포까지 가능합니다.`, 'bad'); return; }
    const { batch, culture, ...rest } = m;
    const kg = Math.round(cloths * kgPer * 10) / 10;
    const source = pressTank ? f.source || 'room' : (rest.source || '');
    if (!locked && f.fillerId === DISPOSE) {
      // 설비 대신 '폐기'를 고르면 이 반출 기록을 폐기 기록으로 바꿈 (같은 id, 설비·유형·배치 정보는 지움)
      await save('separations', { id: m.id, cultureId: m.cultureId, kind: 'dispose', date: f.date, cloths, kg, source, note: (f.note || '').trim() });
      toast(`${r.c.lot} 반출 ${n(cloths)}포를 폐기로 바꿨습니다.`); onClose(); return;
    }
    await save('separations', { ...rest, date: f.date, fillDate: f.date, fillerId: locked ? m.fillerId : f.fillerId, mixType: f.mixType, cloths, kg, source, note: (f.note || '').trim() });
    toast('반출 기록을 수정했습니다.'); onClose();
  };
  const toDispose = !locked && f.fillerId === DISPOSE;
  return html`<${Modal} title=${`반출 수정 · ${r.c.lot}`} onClose=${onClose} narrow footer=${html`<button class="btn" onClick=${onClose}>취소</button><button class="btn ${toDispose ? 'danger' : 'primary'}" disabled=${!state.canWrite} onClick=${submit}>${toDispose ? '폐기로 저장' : '저장'}</button>`}>
    ${locked && html`<div class="banner info" style="font-size:12.5px"><${Icon} name="alert" /><span>충진 배치 ${m.batch.batchNo}에 배정된 반출입니다. 면포 수와 설비를 바꾸려면 배치 수정에서 이 반출을 제외한 뒤 고치세요.</span></div>`}
    ${toDispose && html`<div class="banner warn" style="font-size:12.5px"><${Icon} name="alert" /><span>이 반출 ${n(num(f.cloths))}포를 폐기 기록으로 바꿉니다. 어느 설비로도 가지 않고 재고에서만 빠집니다.</span></div>`}
    <div class="form-grid">
      <${Field} label=${toDispose ? '폐기일' : '반출일'}><input type="date" value=${f.date} onInput=${(e) => set('date', e.target.value)} /><//>
      <${Field} label="충진설비"><select value=${f.fillerId} disabled=${locked} style=${toDispose ? 'color:var(--bad);font-weight:700' : ''} onChange=${(e) => set('fillerId', e.target.value)}><option value="">대기 (설비 미정)</option>${s.fillers.filter((o) => !/드링크/.test(o.name) || o.id === m.fillerId).map((o) => html`<option key=${o.id} value=${o.id}>${o.name}</option>`)}${!locked && html`<option value=${DISPOSE}>폐기 (설비로 보내지 않음)</option>`}</select><//>
      ${!toDispose && html`<${Field} label="재공품 유형"><select value=${f.mixType} onChange=${(e) => set('mixType', e.target.value)}>${mixNames.map((x) => html`<option key=${x} value=${x}>${x}</option>`)}</select><//>`}
      <${Field} label="면포 (포)" hint=${locked ? '' : `이 반출 포함 최대 ${n(maxCloths)}포`}><input type="number" min="1" max=${maxCloths} value=${f.cloths} readonly=${locked} onInput=${(e) => set('cloths', e.target.value)} /><//>
      ${pressTank && html`<${Field} label="면포 출처" hint="유청분리실 소분 면포인지 필터프레스 작업 면포인지"><select value=${f.source} onChange=${(e) => set('source', e.target.value)}>${SOURCE_OPTS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select><//>`}
      <${Field} label=${toDispose ? '폐기 사유' : '비고'} class="span-all"><input value=${f.note} placeholder=${toDispose ? '예) 면포 파손, 품질 이상' : ''} onInput=${(e) => set('note', e.target.value)} /><//>
    </div>
  <//>`;
}

function DisposeModal({ state, r, date, onClose }) {
  // 필터프레스 탱크(1~4번)면 폐기 면포 출처도 받음 → 'FP 폐기'로 표시되고 필터프레스 집계에서 구분됨
  const pressTank = canPress(state, r.c.tankId);
  const defaultSource = r.stock.hasPress && r.stock.wheyRoomKg <= 0 ? 'press' : 'room';
  const [f, setF] = useState({ date, cloths: '', note: '', source: defaultSource });
  const kgPer = r.stock.kgPerCloth || 0;
  const submit = async () => {
    const cloths = num(f.cloths); if (cloths <= 0) { toast('폐기 면포 수를 입력하세요.', 'bad'); return; }
    if (cloths > r.stock.remaining) { toast(`재고(${r.stock.remaining}포)보다 많이 폐기할 수 없습니다.`, 'bad'); return; }
    await save('separations', { id: uid(), cultureId: r.c.id, kind: 'dispose', date: f.date, cloths, kg: Math.round(cloths * kgPer * 10) / 10, source: pressTank ? f.source || 'room' : '', note: f.note });
    toast('폐기를 기록했습니다.'); onClose();
  };
  return html`<${Modal} title=${`면포 폐기 · ${r.c.lot}`} onClose=${onClose} narrow footer=${html`<button class="btn" onClick=${onClose}>취소</button><button class="btn danger" onClick=${submit}>폐기 기록</button>`}>
    <div class="note">현재 재고 ${n(r.stock.remaining)}포 · 포당 ${n(kgPer, 2)} kg</div>
    <div class="form-grid">
      <${Field} label="폐기일"><input type="date" value=${f.date} onInput=${(e) => setF({ ...f, date: e.target.value })} /><//>
      <${Field} label="폐기 면포 (포)"><input type="number" min="1" max=${r.stock.remaining} value=${f.cloths} onInput=${(e) => setF({ ...f, cloths: e.target.value })} /><//>
      ${pressTank && html`<${Field} label="면포 출처" class="span-all" hint="필터프레스 면포 폐기는 'FP 폐기'로 표시됩니다"><select value=${f.source} onChange=${(e) => { const v = e.target.value; setF((o) => ({ ...o, source: v })); }}>${SOURCE_OPTS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select><//>`}
      <${Field} label="사유" class="span-all"><input value=${f.note} placeholder="예) 면포 파손, 품질 이상" onInput=${(e) => setF({ ...f, note: e.target.value })} /><//>
    </div>
  <//>`;
}
