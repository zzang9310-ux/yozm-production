// 배양팀 실적: 배관별 탱크 원유량 입력 → 배양 LOT 자동 생성. 드링크 배출은 당일 충진으로 직송(소분 없음).
import { html, useState, useEffect, useMemo, Card, Chip, Icon, Field, Modal, DataTable, toast, confirmAsync, exportCSV } from '../ui.js';
import { save, remove } from '../store.js';
import { cultureStock, materialStock, STATUS, tankOf, tankLines, isDrinkType, isPressType, canPress, canDrink, cultureTypesFor, pressMaxL, pressEstimate, defaultStarterBags } from '../model.js';
import { n, fmtDate, dow, addDays, today, uid, cultureLot, dischargeDate, tankNo, monthRange, num } from '../util.js';

export function CulturePage({ state, params, go }) {
  const [date, setDate] = useState(params.date || addDays(today(), -1)); // 실적 입력은 전일 기준으로 시작 (전날 실적을 다음 날 입력)
  useEffect(() => { if (params.date) setDate(params.date); }, [params.date]);
  const [draft, setDraft] = useState({});
  const [edit, setEdit] = useState(null);
  const s = state.settings;
  const density = s.milkDensity || 1.03;
  const lines = useMemo(() => tankLines(state), [state.settings]);

  const dayRecords = useMemo(() => state.cultures.filter((c) => c.date === date), [state, date]);
  useEffect(() => { setDraft({}); }, [date]);
  const recOf = (tankId) => dayRecords.find((c) => c.tankId === tankId && (c.seq || 1) === 1);
  const get = (tankId, key) => {
    const d = draft[tankId]; if (d && key in d) return d[key];
    const rec = recOf(tankId);
    if (rec) return rec[key] ?? '';
    return key === 'type' ? s.cultureTypes[0] : '';
  };
  const setD = (tankId, key, v) => setDraft((d) => ({ ...d, [tankId]: { ...(d[tankId] || {}), [key]: v } }));

  const saveAll = async () => {
    let count = 0;
    for (const tank of s.tanks) {
      const d = draft[tank.id]; if (!d) continue;
      const rec = recOf(tank.id);
      const rawL = num(get(tank.id, 'rawL'));
      if (!rec && rawL <= 0) continue;
      const rawKg = Math.round(rawL * density);
      const type = get(tank.id, 'type');
      const drinkOk = isDrinkType(type) && canDrink(state, tank.id);
      let drinkL = drinkOk ? num(get(tank.id, 'drinkL')) : 0;
      if (drinkOk && drinkL <= 0) drinkL = rawL;
      if (drinkL > rawL) { toast(`${tank.name}: 드링크 이동량이 원유량보다 많습니다.`, 'bad'); return; }
      // 필터프레스 배출(1~4번 탱크): 비우면 최대치(원유량과 2,000 L 중 작은 값), 나머지는 유청분리실
      const press = isPressType(type) && canPress(state, tank.id);
      let pressL = press ? num(get(tank.id, 'pressL')) : 0;
      if (press && pressL <= 0) pressL = Math.min(rawL - drinkL, pressMaxL(state));
      if (pressL > pressMaxL(state)) { toast(`${tank.name}: 필터프레스는 최대 ${n(pressMaxL(state))} L까지 받을 수 있습니다.`, 'bad'); return; }
      if (drinkL + pressL > rawL) { toast(`${tank.name}: 필터프레스 이동량이 원유량보다 많습니다.`, 'bad'); return; }
      const lots = rec ? (rec.rawLots || []).map((r) => ({ ...r })) : [];
      for (const r of lots) { const ml = state.materialLots.find((x) => x.id === r.lotId); const m = ml && state.materials.find((x) => x.code === ml.materialCode); if (m && (m.unit === 'kg' || m.unit === 'L')) r.qty = rawKg; }
      const starterRaw = get(tank.id, 'starterBags');
      const starterBags = starterRaw === '' ? defaultStarterBags(tank) : Math.round(num(starterRaw));
      const doc = { id: rec ? rec.id : uid(), date, tankId: tank.id, seq: 1, lot: rec ? rec.lot : cultureLot(date, tank.id, 1, s.lotDateOffset, s.offDays), rawL, rawKg, starterBags, type,
        drinkL, drinkKg: Math.round(drinkL * density), pressL, pressKg: Math.round(pressL * density), rawLots: lots, note: rec ? rec.note || '' : '', createdAt: rec ? rec.createdAt : new Date().toISOString() };
      await save('cultures', doc); count++;
    }
    setDraft({});
    toast(count ? `${count}개 탱크 실적을 저장했습니다.` : '변경된 내용이 없습니다.');
  };

  const month = monthRange(date.slice(0, 7));
  const [scope, setScope] = useState('open'); // open: 충진 완료·전량 폐기 LOT 숨김
  const allMonthRows = useMemo(() => state.cultures.filter((c) => c.date >= month.from && c.date <= month.to).map((c) => ({ c, stock: cultureStock(state, c.id), tank: tankOf(state, c.tankId) })).sort((a, b) => b.c.date.localeCompare(a.c.date) || a.c.tankId.localeCompare(b.c.tankId)), [state, month.from]);
  const doneCount = allMonthRows.filter((r) => r.stock.status === 'done' || r.stock.status === 'disposed').length;
  const monthRows = scope === 'open' ? allMonthRows.filter((r) => r.stock.status !== 'done' && r.stock.status !== 'disposed') : allMonthRows;
  // 배양 실적 삭제 = 연결된 소분·반출·폐기, 이 LOT만 쓴 충진 배치(+포장 내역)까지 연쇄 삭제. 다른 LOT와 섞인 배치는 이 LOT 사용분만 빼고 유지.
  const del = async (c) => {
    const seps = state.separations.filter((s) => s.cultureId === c.id);
    const uses = (b) => (b.sources || []).filter((s) => s.cultureId === c.id);
    const owned = state.batches.filter((b) => uses(b).length > 0 && uses(b).length === (b.sources || []).length);
    const ownedIds = new Set(owned.map((b) => b.id));
    const mixed = state.batches.filter((b) => uses(b).length > 0 && !ownedIds.has(b.id));
    const packs = state.packs.filter((p) => ownedIds.has(p.batchId));
    const parts = [];
    if (seps.length) parts.push(`소분·반출 ${seps.length}건`);
    if (owned.length) parts.push(`충진 배치 ${owned.length}건${packs.length ? ` + 포장 내역(제품 LOT) ${packs.length}건` : ''}`);
    if (mixed.length) parts.push(`혼합 배치 ${mixed.map((b) => b.batchNo).join(', ')}에서는 이 LOT 사용분만 제외`);
    const msg = `${c.lot} 배양 실적을 삭제할까요?${parts.length ? ` 연결된 기록도 함께 삭제됩니다: ${parts.join(' · ')}` : ''}`;
    if (!(await confirmAsync(msg))) return;
    for (const p of packs) await remove('packs', p.id);
    for (const b of owned) await remove('batches', b.id);
    for (const b of mixed) await save('batches', { ...b, sources: (b.sources || []).filter((s) => s.cultureId !== c.id) });
    for (const s of seps) await remove('separations', s.id);
    await remove('cultures', c.id);
    const removed = seps.length + owned.length + packs.length;
    toast(parts.length ? `배양 실적 삭제${removed ? ` · 연결 기록 ${removed}건 삭제` : ''}${mixed.length ? ` · 혼합 배치 ${mixed.length}건에서 제외` : ''}` : '삭제했습니다.');
  };
  const dirty = Object.keys(draft).length > 0;

  // 컴포넌트가 아닌 일반 함수로 렌더링 (매 렌더마다 새 컴포넌트 타입이 되어 입력 포커스를 잃는 것을 방지)
  const tankCard = (tank) => {
    const rec = recOf(tank.id); const rawL = num(get(tank.id, 'rawL')); const type = get(tank.id, 'type'); const drink = isDrinkType(type) && canDrink(state, tank.id);
    const drinkL = drink ? (get(tank.id, 'drinkL') === '' ? rawL : num(get(tank.id, 'drinkL'))) : 0;
    const pressOk = canPress(state, tank.id); const press = isPressType(type) && pressOk; const maxP = pressMaxL(state);
    const pressL = press ? (get(tank.id, 'pressL') === '' ? Math.min(rawL, maxP) : num(get(tank.id, 'pressL'))) : 0;
    const est = press ? pressEstimate(state, pressL) : null;
    const typeOptions = cultureTypesFor(state, tank.id);
    if (type && !typeOptions.includes(type)) typeOptions.push(type); // 저장된 값은 목록에 없어도 유지
    const st = rec ? cultureStock(state, rec.id) : null;
    return html`<div key=${tank.id} class="tank ${rec || draft[tank.id] ? 'active' : ''}" style="gap:6px;padding:10px 12px">
      <div class="n"><span>${tank.name} <small>${tank.capT}T</small></span>${rec ? html`<${Chip} tone=${STATUS[st.status].tone}>${STATUS[st.status].label}<//>` : html`<small>미입력</small>`}</div>
      <div class="l" style="font-size:13px">${rec ? rec.lot : cultureLot(date, tank.id, 1, s.lotDateOffset, s.offDays)}</div>
      <${Field} label="원유량 (L)"><input type="number" min="0" step="1" inputmode="decimal" placeholder="숫자 입력" value=${get(tank.id, 'rawL')} onInput=${(e) => setD(tank.id, 'rawL', e.target.value)} /><//>
      <div class="row" style="gap:6px;flex-wrap:nowrap"><${Field} label="유산균 (봉)"><input type="number" min="0" step="1" inputmode="numeric" style="width:70px" placeholder=${defaultStarterBags(tank)} value=${get(tank.id, 'starterBags')} onInput=${(e) => setD(tank.id, 'starterBags', e.target.value)} /><//>
        <${Field} label="배출 구분"><select value=${type} onChange=${(e) => setD(tank.id, 'type', e.target.value)}>${typeOptions.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}</select><//></div>
      ${drink && html`<${Field} label="드링크 이동 (L)" hint=${rawL > 0 && drinkL < rawL ? `나머지 ${n(rawL - drinkL)} L는 유청분리` : '비우면 전량 · 당일 충진 가능'}><input type="number" min="0" max=${rawL || undefined} step="1" placeholder=${rawL || ''} value=${get(tank.id, 'drinkL')} onInput=${(e) => setD(tank.id, 'drinkL', e.target.value)} /><//>`}
      ${press && html`<${Field} label="필터프레스 이동 (L)" hint=${`최대 ${n(maxP)} L · 예상 면포 약 ${n(est.cloths, 1)}포${rawL > pressL ? ` · 나머지 ${n(rawL - pressL)} L는 유청분리실` : ''}`}><input type="number" min="0" max=${Math.min(rawL || maxP, maxP)} step="1" placeholder=${Math.min(rawL, maxP) || ''} value=${get(tank.id, 'pressL')} onInput=${(e) => setD(tank.id, 'pressL', e.target.value)} /><//>`}
      <div class="s">${rawL > 0 ? `${n(Math.round(rawL * density))} kg · 유산균 ${get(tank.id, 'starterBags') === '' ? defaultStarterBags(tank) : Math.round(num(get(tank.id, 'starterBags')))}봉` : '—'}${rec ? html` · <button class="linkish" style="font-weight:500" onClick=${() => setEdit(rec)}>상세</button>` : ''}</div>
    </div>`;
  };

  return html`
    <div class="page-head"><div><div class="eyebrow">배양팀</div><h1>배양 실적</h1></div>
      <div class="actions"><button class="btn" onClick=${() => exportCSV(`배양실적_${month.from.slice(0, 7)}.csv`, ['배양일', '탱크', '배양 LOT', '구분', '원유 L', '원유 kg', '드링크 이동 L', '필터프레스 L', '예상 면포', '유산균 봉', '상태', '비고'], allMonthRows.map((r) => [r.c.date, r.tank.name, r.c.lot, r.c.type, r.c.rawL, r.c.rawKg, r.c.drinkL || '', r.c.pressL || '', r.stock.hasPress ? n(r.stock.pressClothsEst, 1) : '', r.c.starterBags, STATUS[r.stock.status].label, r.c.note]))}><${Icon} name="download" />월 CSV</button></div></div>

    <${Card} title="배관별 배양 실적" desc=${`${fmtDate(date)}(${dow(date)})`} actions=${html`<button class="btn primary" disabled=${!dirty || !state.canWrite} onClick=${saveAll}><${Icon} name="check" />입력한 탱크 저장</button>`}>
      <div class="filters" style="margin-bottom:14px">
        <${Field} label="작업일자"><div class="row" style="flex-wrap:nowrap"><button class="btn sm" aria-label="이전 날" onClick=${() => setDate(addDays(date, -1))}><${Icon} name="left" /></button><input id="cu-date" type="date" class="input" style="width:150px" value=${date} onInput=${(e) => e.target.value && setDate(e.target.value)} /><button class="btn sm" aria-label="다음 날" onClick=${() => setDate(addDays(date, 1))}><${Icon} name="right" /></button></div><//>
      </div>
      <div class="stack" style="gap:16px">
        ${lines.map((line) => html`<section key=${line.id} class="line">
          <div class="line-head"><span class="line-name">${line.name}</span><span class="line-tanks">${line.tanks.map((t) => t.name.replace(' 탱크', '')).join(' · ')}</span>${line.dest && html`<span class="line-dest"><${Icon} name="right" size="14" />${line.dest}</span>`}</div>
          <div class="tanks" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">${line.tanks.map(tankCard)}</div>
        </section>`)}
      </div>
    <//>

    <${Card} title="배양 내역" count=${monthRows.length} desc=${`${date.slice(0, 7)} 월${scope === 'open' && doneCount ? ` · 충진 완료 ${n(doneCount)}건 숨김` : ' 전체'}`} actions=${html`<div class="seg"><button class=${scope === 'open' ? 'active' : ''} onClick=${() => setScope('open')}>진행 중</button><button class=${scope === 'all' ? 'active' : ''} onClick=${() => setScope('all')}>전체 (충진 완료 포함)</button></div>`} flush>
      <${DataTable} rows=${monthRows} keyFn=${(r) => r.c.id} cols=${[
        { key: 'date', label: '배양일', render: (r) => `${fmtDate(r.c.date)} (${dow(r.c.date)})` }, { key: 'tank', label: '탱크', render: (r) => r.tank.name },
        { key: 'lot', label: '배양 LOT', render: (r) => html`<button class="linkish" onClick=${() => go('trace', { cultureId: r.c.id })}>${r.c.lot}</button>` }, { key: 'type', label: '구분', render: (r) => r.c.type },
        { key: 'rawL', label: '원유 (L)', num: true, render: (r) => n(r.c.rawL) }, { key: 'rawKg', label: '원유 (kg)', num: true, render: (r) => n(r.c.rawKg) },
        { key: 'drink', label: '드링크 · 필터프레스', num: true, render: (r) => r.stock.hasDrink ? `드링크 ${n(r.c.drinkL)} L` : r.stock.hasPress ? html`<span class="chip accent" style="margin-right:4px">필터프레스</span>${n(r.c.pressL)} L` : '—', sub: (r) => r.stock.hasPress ? `예상 약 ${n(r.stock.pressClothsEst, 1)}포${r.stock.wheyRoomKg > 0 ? ` · 유청분리실 ${n(r.stock.wheyRoomKg)} kg` : ''}` : r.stock.hasDrink && r.stock.hasWhey ? `유청분리 ${n(r.stock.wheyKg)} kg` : '' },
        { key: 'starter', label: '유산균', num: true, render: (r) => n(r.c.starterBags) },
        { key: 'status', label: '상태', render: (r) => html`<${Chip} tone=${STATUS[r.stock.status].tone} dot>${STATUS[r.stock.status].label}<//>` },
        { key: 'act', label: '', render: (r) => html`<div class="row-actions"><button class="icon-btn" aria-label="수정" onClick=${() => setEdit(r.c)}><${Icon} name="edit" /></button><button class="icon-btn danger" aria-label="삭제" disabled=${!state.canWrite} onClick=${() => del(r.c)}><${Icon} name="trash" /></button></div>` },
      ]} empty=${html`<div class="empty"><b>이 달에 저장된 배양 실적이 없습니다</b>위에서 탱크 원유량을 입력하고 저장하세요.</div>`} />
    <//>
    ${edit && html`<${CultureModal} state=${state} rec=${edit} onClose=${() => setEdit(null)} />`}`;
}

function CultureModal({ state, rec, onClose }) {
  const s = state.settings;
  const density = s.milkDensity || 1.03;
  const [f, setF] = useState({ ...rec, drinkL: rec.drinkL || '', pressL: rec.pressL || '', rawLots: (rec.rawLots || []).map((x) => ({ ...x })) });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const mat = useMemo(() => materialStock(state), [state]);
  const lots = mat.lots.filter((l) => l.material.kind === 'raw');
  const drink = isDrinkType(f.type) && canDrink(state, f.tankId);
  const pressOk = canPress(state, f.tankId); const press = isPressType(f.type) && pressOk; const maxP = pressMaxL(state);
  const typeOptions = cultureTypesFor(state, f.tankId);
  if (f.type && !typeOptions.includes(f.type)) typeOptions.push(f.type);
  // 배출일: 규칙(배양일+1, 휴무면 다음 가동일)과 다르게 실제로 배출한 날. 바꾸면 LOT 앞 6자리가 그 날짜로 다시 만들어짐
  const ruleDate = dischargeDate(f.date, s.lotDateOffset, s.offDays);
  const outDate = f.dischargeDate || ruleDate;
  const lotFor = (d) => `${d.slice(2).replace(/-/g, '')}T${tankNo(f.tankId).padStart(2, '0')}-${String(num(f.seq) || 1).padStart(2, '0')}`;
  const setOut = (d) => { if (!d) return; setF((x) => ({ ...x, dischargeDate: d === dischargeDate(x.date, s.lotDateOffset, s.offDays) ? '' : d, lot: `${d.slice(2).replace(/-/g, '')}T${tankNo(x.tankId).padStart(2, '0')}-${String(num(x.seq) || 1).padStart(2, '0')}` })); };
  const dupLot = state.cultures.find((c) => c.id !== rec.id && c.lot === (f.lot || '').trim());
  const submit = async () => {
    const rawL = num(f.rawL); if (rawL <= 0) { toast('원유량을 입력하세요.', 'bad'); return; }
    if (!(f.lot || '').trim()) { toast('배양 LOT를 입력하세요.', 'bad'); return; }
    if (dupLot) { toast(`배양 LOT ${f.lot}은 이미 ${fmtDate(dupLot.date)} ${tankOf(state, dupLot.tankId).name} 배양에 쓰였습니다. 순번을 올려 주세요.`, 'bad'); return; }
    let drinkL = drink ? num(f.drinkL) : 0; if (drink && drinkL <= 0) drinkL = rawL;
    if (drinkL > rawL) { toast('드링크 이동량이 원유량보다 많습니다.', 'bad'); return; }
    let pressL = press ? num(f.pressL) : 0; if (press && pressL <= 0) pressL = Math.min(rawL - drinkL, maxP);
    if (pressL > maxP) { toast(`필터프레스는 최대 ${n(maxP)} L까지 받을 수 있습니다.`, 'bad'); return; }
    if (drinkL + pressL > rawL) { toast('필터프레스 이동량이 원유량보다 많습니다.', 'bad'); return; }
    const starterBags = f.starterBags === '' || f.starterBags == null ? defaultStarterBags(s.tanks.find((t) => t.id === f.tankId)) : Math.round(num(f.starterBags));
    const doc = { ...f, lot: f.lot.trim(), dischargeDate: f.dischargeDate || '', rawL, rawKg: num(f.rawKg) || Math.round(rawL * density), starterBags, seq: num(f.seq) || 1, drinkL, drinkKg: Math.round(drinkL * density), pressL, pressKg: Math.round(pressL * density), rawLots: f.rawLots.filter((x) => x.lotId).map((x) => ({ lotId: x.lotId, qty: num(x.qty) })) };
    await save('cultures', doc); toast('저장했습니다.'); onClose();
  };
  const addSeq = async () => {
    const seqs = state.cultures.filter((c) => c.date === rec.date && c.tankId === rec.tankId).map((c) => c.seq || 1);
    const seq = Math.max(0, ...seqs) + 1;
    await save('cultures', { id: uid(), date: rec.date, tankId: rec.tankId, seq, lot: cultureLot(rec.date, rec.tankId, seq, s.lotDateOffset, s.offDays), rawL: 0, rawKg: 0, starterBags: 0, type: rec.type, drinkL: 0, drinkKg: 0, rawLots: [], note: '', createdAt: new Date().toISOString() });
    toast(`순번 ${seq} 배양을 추가했습니다. 내역에서 원유량을 입력하세요.`); onClose();
  };
  return html`<${Modal} title=${`배양 실적 상세 · ${rec.lot}`} onClose=${onClose} footer=${html`<button class="btn left" onClick=${addSeq} disabled=${!state.canWrite}><${Icon} name="plus" />같은 탱크 추가 배양</button><button class="btn" onClick=${onClose}>취소</button><button class="btn primary" onClick=${submit} disabled=${!state.canWrite}>저장</button>`}>
    <div class="form-grid">
      <${Field} label="배양일"><input type="date" value=${f.date} onInput=${(e) => set('date', e.target.value)} /><//>
      <${Field} label="배출일" hint=${f.dischargeDate ? `규칙상 ${fmtDate(ruleDate)}(${dow(ruleDate)}) · 실제 배출일로 LOT 생성` : `규칙: 배양일 다음 가동일 · 다른 날 배출했으면 바꾸세요`}><input type="date" value=${outDate} onInput=${(e) => setOut(e.target.value)} /><//>
      <${Field} label="탱크"><select value=${f.tankId} onChange=${(e) => set('tankId', e.target.value)}>${s.tanks.map((t) => html`<option key=${t.id} value=${t.id}>${t.name}</option>`)}</select><//>
      <${Field} label="순번"><input type="number" min="1" value=${f.seq || 1} onInput=${(e) => set('seq', e.target.value)} /><//>
      <${Field} label="배양 LOT" hint=${dupLot ? '⚠ 이미 쓰인 LOT' : f.lot !== lotFor(outDate) ? `규칙대로면 ${lotFor(outDate)} · 비우면 다시 생성` : '배출일 기준 자동 생성'}><input style=${dupLot ? 'border-color:var(--bad)' : ''} value=${f.lot} onInput=${(e) => set('lot', e.target.value)} onBlur=${(e) => { if (!e.target.value.trim()) set('lot', lotFor(outDate)); }} /><//>
      <${Field} label="원유량 (L)"><input type="number" min="0" value=${f.rawL} onInput=${(e) => { set('rawL', e.target.value); set('rawKg', Math.round(num(e.target.value) * density)); }} /><//>
      <${Field} label="원유 (kg)"><input type="number" min="0" value=${f.rawKg} onInput=${(e) => set('rawKg', e.target.value)} /><//>
      <${Field} label="유산균 (봉)" hint="비우면 탱크 용량 기준 자동"><input type="number" min="0" step="1" placeholder=${defaultStarterBags(s.tanks.find((t) => t.id === f.tankId))} value=${f.starterBags} onInput=${(e) => set('starterBags', e.target.value)} /><//>
      <${Field} label="배출 구분"><select value=${f.type} onChange=${(e) => set('type', e.target.value)}>${typeOptions.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}</select><//>
      ${drink && html`<${Field} label="드링크 이동 (L)" hint="비우면 전량 · 나머지는 유청분리"><input type="number" min="0" value=${f.drinkL} placeholder=${f.rawL} onInput=${(e) => set('drinkL', e.target.value)} /><//>`}
      ${press && html`<${Field} label="필터프레스 이동 (L)" hint=${`최대 ${n(maxP)} L · 비우면 최대치 · 예상 면포 약 ${n(pressEstimate(state, f.pressL === '' ? Math.min(num(f.rawL), maxP) : f.pressL).cloths, 1)}포`}><input type="number" min="0" max=${maxP} value=${f.pressL} placeholder=${Math.min(num(f.rawL), maxP)} onInput=${(e) => set('pressL', e.target.value)} /><//>`}
      <${Field} label="비고" class="span-all"><input value=${f.note || ''} onInput=${(e) => set('note', e.target.value)} /><//>
    </div>
    <div class="fieldset"><div class="legend">투입 자재 LOT (역추적용 · 선택)</div>
      ${f.rawLots.map((x, i) => html`<div key=${i} class="src-row" style="grid-template-columns:1fr 120px 36px">
        <${Field} label="자재 LOT"><select value=${x.lotId} onChange=${(e) => setF((o) => { const r = [...o.rawLots]; r[i] = { ...r[i], lotId: e.target.value }; return { ...o, rawLots: r }; })}><option value="">선택</option>${lots.map((l) => html`<option key=${l.id} value=${l.id}>${l.lot} · ${l.material.name} (잔량 ${n(l.remaining)})</option>`)}</select><//>
        <${Field} label="사용량"><input type="number" min="0" value=${x.qty} onInput=${(e) => setF((o) => { const r = [...o.rawLots]; r[i] = { ...r[i], qty: e.target.value }; return { ...o, rawLots: r }; })} /><//>
        <button class="icon-btn danger" aria-label="제거" onClick=${() => setF((o) => ({ ...o, rawLots: o.rawLots.filter((_, j) => j !== i) }))}><${Icon} name="x" /></button>
      </div>`)}
      <div><button class="btn sm" onClick=${() => setF((o) => ({ ...o, rawLots: [...o.rawLots, { lotId: '', qty: '' }] }))}><${Icon} name="plus" />자재 LOT 추가</button></div>
    </div>
  <//>`;
}
