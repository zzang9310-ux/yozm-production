// 도메인 계산: 면포 재고, LOT 추적 체인, 생산실적 KPI, 자재 재고
import { num, sum, div, groupBy, daysBetween, addDays, today } from './util.js';

export const STATUS = {
  wait_split: { label: '소분 대기', tone: '' },
  wait_move: { label: '반출 대기', tone: 'info' },
  partial: { label: '일부 반출', tone: 'warn' },
  wait_fill: { label: '충진 배정 대기', tone: 'info' },
  wait_drink: { label: '드링크 충진 대기', tone: 'info' },
  done: { label: '충진 완료', tone: 'good' },
  disposed: { label: '전량 폐기', tone: 'bad' },
};
export const OPEN_STATUSES = ['wait_split', 'wait_move', 'partial', 'wait_fill', 'wait_drink'];
export function mixRatio(state, mixType) { const m = (state.settings.mixTypes || []).find((x) => x.name === mixType); return m ? num(m.ratio) || 1 : 1; }
// 휴게 자동 차감 규칙(엑셀 생산_백데이타 충진!T열과 동일): 시작이 startBefore 이전이고 종료가 endAfter 이후면 min 분을 뺀다.
export const DEFAULT_BREAKS = [
  { label: '점심', startBefore: '13:00', endAfter: '14:00', min: 70 },
  { label: '오전 휴게', startBefore: '10:20', endAfter: '11:00', min: 40 },
];
let activeBreaks = DEFAULT_BREAKS;
/** 기준정보(settings.autoBreaks)가 바뀔 때 store가 호출 */
export function configureBreaks(list) { activeBreaks = Array.isArray(list) && list.length ? list.filter((x) => x && x.startBefore && x.endAfter) : DEFAULT_BREAKS; }
export function activeBreakRules() { return activeBreaks; }
const toMin = (t) => { const [h, m] = String(t || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
/** 시작~종료에 자동으로 빠지는 휴게 분(점심·오전 휴게). 규칙별 내역은 autoBreakDetail */
export function autoBreakDetail(startTime, endTime, breaks = activeBreaks) {
  if (!startTime || !endTime) return [];
  const s = toMin(startTime), e = toMin(endTime);
  return breaks.filter((r) => s <= toMin(r.startBefore) && e >= toMin(r.endAfter) && num(r.min) > 0).map((r) => ({ label: r.label || '휴게', min: num(r.min) }));
}
export function autoBreakMin(startTime, endTime, breaks = activeBreaks) { return sum(autoBreakDetail(startTime, endTime, breaks), (x) => x.min); }
/** 배치의 가동 분 = 종료 − 시작 − 자동 휴게(점심·오전) − 추가 휴게(직접 입력). 시각이 없으면 저장된 runMin */
export function batchRunMin(b) {
  if (b.startTime && b.endTime) { let m = toMin(b.endTime) - toMin(b.startTime); if (m < 0) m += 1440; return Math.max(0, m - autoBreakMin(b.startTime, b.endTime) - num(b.breakMin)); }
  if (b.runMin != null && b.runMin !== '' && num(b.runMin) > 0) return num(b.runMin);
  return 0;
}
export function crewNames(b) { const c = b.crew || {}; return [...(c.fill || []), ...(c.cap || []), ...(c.pack || [])].filter(Boolean); }
export function isDrinkType(t) { return /드링크/.test(t || ''); }
export function isPressType(t) { return /필터\s*프레스/.test(t || ''); }
/** 필터프레스로 보낼 수 있는 탱크: 배관 행선지에 '필터프레스'가 있는 배관(기본 1배관 1~4번) */
export function canPress(state, tankId) {
  const line = lineOf(state, tankId);
  if (line) return /필터\s*프레스/.test(line.dest || '');
  return ['T01', 'T02', 'T03', 'T04'].includes(tankId);
}
export function pressMaxL(state) { return num(state.settings.pressMaxL) || 2000; }
/** 드링크로 배출할 수 있는 탱크: 배관 행선지에 '드링크'가 있는 배관(기본 3배관 9~12번) */
export function canDrink(state, tankId) {
  const line = lineOf(state, tankId);
  if (line) return /드링크/.test(line.dest || '');
  return ['T09', 'T10', 'T11', 'T12'].includes(tankId);
}
/** 탱크에서 고를 수 있는 배출 구분: 드링크는 드링크 배관, 필터프레스는 필터프레스 배관에서만 */
export function cultureTypesFor(state, tankId) {
  return (state.settings.cultureTypes || []).filter((t) => (!isDrinkType(t) || canDrink(state, tankId)) && (!isPressType(t) || canPress(state, tankId)));
}
/** 필터프레스 환산: L × 비중 ÷ 포당 kg(기본 51.5) → 예상 면포 수 (당일에는 실제 포 수를 알 수 없어 추정치로 표시) */
export function pressEstimate(state, pressL) {
  const density = state.settings.milkDensity || 1.03;
  const per = num(state.settings.pressKgPerCloth) || 51.5;
  const kg = Math.round(num(pressL) * density);
  return { kg, per, cloths: per > 0 ? kg / per : 0 };
}
/** 유산균 기본 봉 수: 5T(5,000 L)당 2봉, 2T는 1봉. 소수점 없이 봉 단위로만. */
export function defaultStarterBags(tank) {
  const capT = num(tank && tank.capT);
  if (capT <= 0) return 2;
  return Math.max(1, Math.round(capT / 5 * 2));
}
/** 탱크가 속한 배관(라인) */
export function lineOf(state, tankId) { return (state.settings.lines || []).find((l) => (l.tankIds || []).includes(tankId)); }
/** 배관별 탱크 묶음 (배관에 없는 탱크는 '기타'로) */
export function tankLines(state) {
  const lines = (state.settings.lines || []).map((l) => ({ ...l, tanks: (l.tankIds || []).map((id) => state.settings.tanks.find((t) => t.id === id)).filter(Boolean) }));
  const covered = new Set(lines.flatMap((l) => l.tankIds || []));
  const rest = state.settings.tanks.filter((t) => !covered.has(t.id));
  if (rest.length) lines.push({ id: '_rest', name: '기타', dest: '', tankIds: rest.map((t) => t.id), tanks: rest });
  return lines;
}

export function productOf(state, code) { return state.products.find((p) => p.code === code); }
export function tankOf(state, id) { return state.settings.tanks.find((t) => t.id === id) || { id, name: id }; }
export function fillerOf(state, id) { return state.settings.fillers.find((f) => f.id === id) || { id, name: id || '—' }; }
// 2026년 11월부터 1~4호기·로타리·반자동 충진 실적은 '충진일지 등록'(journal)에서만 입력. 벌크·드링크는 충진/포장 실적에서 그대로 등록
export const JOURNAL_FROM = '2026-10-23';
export const isJournalFiller = (f) => !!f && !/벌크|드링크/.test(f.name || '');
// 1·2호기는 10/23부터 충진일지로 다시 입력. 3·4호기·로타리·반자동은 10/23~11/03을 기존 충진/포장 실적으로 쓰고 11/04부터 충진일지
// (사용자 요청 11/6: 처음엔 11/06부터 → 11/04·11/05 일지 스캔본을 넣으면서 11/04로 당김. 그 이틀은 전산 임시 배치뿐이었음)
export const JOURNAL_ALL_FROM = '2026-11-04';
export const isMainJournalFiller = (f) => !!f && /(^|\s)[12]호기/.test(f.name || '');
export const journalOnly = (state, fillerId, date) => { const d = String(date || ''); const f = fillerOf(state, fillerId); return d >= JOURNAL_FROM && isJournalFiller(f) && (d >= JOURNAL_ALL_FROM || isMainJournalFiller(f)); };
export function packKg(state, pack) {
  if (pack.usedKg != null && pack.usedKg !== '') return num(pack.usedKg);
  if (pack.legacy && pack.kg != null) return num(pack.kg); // 전산 백데이터는 엑셀의 양품무게 그대로
  const p = productOf(state, pack.productCode);
  return p ? num(pack.qty) * num(p.weightG) / 1000 : 0;
}

/** 배양 LOT 하나의 수불 상태: 면포(유청분리 경로)와 드링크 원액(당일 직송 경로) */
export function cultureStock(state, cultureId) {
  const c = state.cultures.find((x) => x.id === cultureId);
  const density = state.settings.milkDensity || 1.03;
  const drinkL = c ? num(c.drinkL) : 0;
  const drinkKg = c && c.drinkKg != null && c.drinkKg !== '' ? num(c.drinkKg) : Math.round(drinkL * density);
  const rawKg = c ? num(c.rawKg) : 0;
  // 필터프레스 배출: 면포 경로의 일부(소분·반출은 같은 LOT로 묶임). 당일에는 예상 면포 수만 표시
  const pressL = c ? num(c.pressL) : 0;
  const pressEst = pressEstimate(state, pressL);
  const pressKg = pressEst.kg;
  const hasPress = pressL > 0;
  const wheyKg = Math.max(0, rawKg - drinkKg);          // 면포 경로 전체 (유청분리실 + 필터프레스)
  const wheyRoomKg = Math.max(0, wheyKg - pressKg);      // 그중 유청분리실로 가는 분
  const hasDrink = drinkL > 0;
  const hasWhey = !hasDrink || wheyKg > 0;

  const seps = state.separations.filter((s) => s.cultureId === cultureId);
  const splits = seps.filter((s) => s.kind === 'split');
  const disposes = seps.filter((s) => s.kind === 'dispose');
  const splitCloths = sum(splits, (s) => s.cloths);
  const splitKg = sum(splits, (s) => s.kg);
  const kgPerCloth = div(splitKg, splitCloths);
  // 반출(Flow): 유청분리팀이 충진설비로 보낸 면포. batchId가 있으면 충진 배치에 배정된 것
  const moves = seps.filter((s) => s.kind === 'move').map((m) => ({ ...m, batch: m.batchId ? state.batches.find((b) => b.id === m.batchId) : null })).sort((a, b) => a.date.localeCompare(b.date));
  const movedCloths = sum(moves, (m) => m.cloths);
  const movedKg = sum(moves, (m) => m.kg);
  const pendingMoves = moves.filter((m) => !m.batch);
  // 배치 소스에는 반출 id만 있으므로, 면포 출처(필터프레스/유청분리실)는 반출 기록에서 가져와 붙임
  const moveById = new Map(moves.map((m) => [m.id, m]));
  const uses = [];
  for (const b of state.batches) for (const src of b.sources || []) if (src.cultureId === cultureId) uses.push({ batch: b, ...src, kind: src.kind || 'cloth', source: src.moveId && moveById.has(src.moveId) ? moveById.get(src.moveId).source || '' : '' });
  const clothUses = uses.filter((u) => u.kind === 'cloth');
  const drinkUses = uses.filter((u) => u.kind === 'drink');
  const directUses = clothUses.filter((u) => !u.moveId); // 반출 기록 없이 배치에 직접 넣은 경우(구버전 호환)
  const usedCloths = movedCloths + sum(directUses, (u) => u.cloths);
  const usedKg = movedKg + sum(directUses, (u) => u.kg);
  const drinkUsedL = sum(drinkUses, (u) => u.liters);
  const drinkUsedKg = sum(drinkUses, (u) => u.kg);
  const drinkRemainingL = Math.max(0, drinkL - drinkUsedL);
  const disposedCloths = sum(disposes, (s) => s.cloths);
  const disposedKg = sum(disposes, (s) => s.kg);
  const remaining = splitCloths - usedCloths - disposedCloths;

  let wheyStatus = null;
  if (hasWhey) {
    wheyStatus = 'wait_split';
    if (splits.length) {
      if (remaining <= 0 && usedCloths === 0 && disposedCloths > 0) wheyStatus = 'disposed';
      else if (remaining <= 0) wheyStatus = pendingMoves.length ? 'wait_fill' : 'done';
      else if (usedCloths > 0) wheyStatus = 'partial';
      else wheyStatus = 'wait_move';
    }
  }
  let drinkStatus = null;
  if (hasDrink) drinkStatus = drinkUsedL <= 0 ? 'wait_drink' : drinkRemainingL > 0.5 ? 'partial' : 'done';
  let status = 'done';
  if (drinkStatus && drinkStatus !== 'done') status = drinkStatus;
  else if (wheyStatus) status = wheyStatus;
  return { culture: c, splits, disposes, moves, pendingMoves, movedCloths, movedKg, uses, clothUses, drinkUses, splitCloths, splitKg, kgPerCloth, usedCloths, usedKg, disposedCloths, disposedKg, remaining, remainingKg: kgPerCloth ? remaining * kgPerCloth : 0,
    drinkL, drinkKg, wheyKg, hasDrink, hasWhey, drinkUsedL, drinkUsedKg, drinkRemainingL, drinkRemainingKg: Math.round(drinkRemainingL * density), wheyStatus, drinkStatus, status,
    pressL, pressKg, hasPress, pressClothsEst: pressEst.cloths, pressKgPerCloth: pressEst.per, wheyRoomKg };
}

/** 배치의 양품 kg: 직접 입력값 우선, 없으면 일반 포장 내역 중량 합 */
export function batchGoodKg(state, batch) {
  if (batch.goodKg != null && batch.goodKg !== '') return num(batch.goodKg);
  const packs = state.packs.filter((p) => p.batchId === batch.id && p.kind !== 'repack');
  return packs.length ? sum(packs, (p) => packKg(state, p)) : 0;
}

/** 배양 LOT 기준 정방향 추적 체인 */
export function traceCulture(state, cultureId) {
  const culture = state.cultures.find((c) => c.id === cultureId);
  if (!culture) return null;
  const stock = cultureStock(state, cultureId);
  const rawLots = (culture.rawLots || []).map((r) => ({ ...r, lot: state.materialLots.find((l) => l.id === r.lotId) }))
    .map((r) => ({ ...r, material: r.lot ? state.materials.find((m) => m.code === r.lot.materialCode) : null }));
  const batches = stock.uses.map((u) => {
    const b = u.batch;
    const totalSrcKg = sum(b.sources || [], (s) => s.kg);
    const share = totalSrcKg > 0 ? num(u.kg) / totalSrcKg : (b.sources || []).length ? 1 / b.sources.length : 1;
    const goodKg = batchGoodKg(state, b);
    const packs = state.packs.filter((p) => p.batchId === b.id).map((p) => ({ ...p, product: productOf(state, p.productCode), kg: packKg(state, p) }));
    const net = batchNetInputKg(b);
    return {
      batch: b, filler: fillerOf(state, b.fillerId), kind: u.kind, source: u.source || '', cloths: num(u.cloths), liters: num(u.liters), kg: num(u.kg), share,
      otherSources: (b.sources || []).filter((s) => s.cultureId !== cultureId).map((s) => ({ ...s, culture: state.cultures.find((c) => c.id === s.cultureId) })),
      goodKg, yieldPct: net > 0 ? goodKg / net * 100 : null,
      allocInputKg: net * share, allocGoodKg: goodKg * share, allocGoodEa: num(b.goodEa) * share,
      packs,
    };
  });
  const allocInputKg = sum(batches, (b) => b.allocInputKg);
  const allocGoodKg = sum(batches, (b) => b.allocGoodKg);
  const allocGoodEa = sum(batches, (b) => b.allocGoodEa);
  const packedKg = sum(batches, (b) => sum(b.packs.filter((p) => p.kind !== 'repack'), (p) => p.kg * b.share));
  return {
    culture, tank: tankOf(state, culture.tankId), stock, rawLots, batches,
    balance: { rawKg: num(culture.rawKg), splitKg: stock.splitKg, drinkKg: stock.drinkUsedKg, usedKg: stock.usedKg + stock.drinkUsedKg, inputKg: allocInputKg, goodKg: allocGoodKg, goodEa: allocGoodEa, packedKg },
  };
}

/**
 * 날짜처럼 쓴 제품 LOT 검색어를 앱의 제품 LOT 표기(yy-MMdd 설비+번호)로 바꿈. 아니면 null.
 * 예) "2026.11.10 C5" · "26.11.10 C5" · "2026-11-10 c5" · "26/11/10" · "20261110 C5" → "26-1110 c5" / "26-1110"
 */
export function productLotQuery(q) {
  const m = String(q || '').trim().toLowerCase().match(/^(?:20)?(\d{2})\s*[.\-/]?\s*(\d{2})\s*[.\-/]?\s*(\d{2})\.?\s*([a-z]\d*)?$/);
  if (!m) return null;
  const mm = +m[2], dd = +m[3];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${m[1]}-${m[2]}${m[3]}${m[4] ? ' ' + m[4] : ''}`;
}
/** 제품 LOT 끝의 요일: 예전 백데이터는 일요일을 0으로 썼고 지금은 7로 통일 → 끝자리 0은 7로 보여주고 비교함 ("26-1009 B0" → "26-1009 B7", 벌크 "26-1012 0" → "26-1012 7") */
export function lot7(lot) { return String(lot || '').replace(/(\s[A-Za-z]?)0$/, '$17'); }
/** 제품 LOT가 검색어와 맞는지: 그대로 포함 또는 날짜형 검색어(2026.11.10 C5 등)를 바꾼 값 포함. 요일 0과 7은 같게 봄 */
export function productLotMatches(lot, q) {
  const l = lot7(lot).toLowerCase(); const s = lot7(String(q || '').trim()).toLowerCase();
  if (!s) return false;
  if (l.includes(s)) return true;
  const alt = productLotQuery(s);
  return !!alt && l.replace(/\s+/g, ' ').includes(lot7(alt));
}

/** 검색어로 LOT/배치/제품 LOT/자재 LOT 찾기 → 관련 배양 id 목록과 적중 정보 */
/** LOT 검색. 쉼표로 여러 검색어를 주면 OR (예: "서울 소프트, 서울 더진한소프트") */
export function searchLots(state, q) {
  const terms = String(q || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  if (terms.length <= 1) return searchOne(state, terms[0] || '');
  const ids = new Set(); const hits = []; const seen = new Set(); let keyword;
  for (const t of terms) {
    const r = searchOne(state, t);
    r.cultureIds.forEach((id) => ids.add(id));
    for (const h of r.hits) { const k = h.type + ':' + h.id; if (!seen.has(k)) { seen.add(k); hits.push(h); } }
    if (r.keyword && !keyword) keyword = r.keyword;
  }
  return keyword ? { cultureIds: [...ids], hits, keyword } : { cultureIds: [...ids], hits };
}
function searchOne(state, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return { cultureIds: [], hits: [] };
  const hits = []; const ids = new Set();
  const add = (id) => { if (id) ids.add(id); };
  // 키워드 검색 '필터프레스'(필터/fp/press): 필터프레스 배출 배양 LOT + 필터프레스 면포를 쓴 충진 배치 + 그 배치의 제품 LOT 전부
  const pressQ = s.length >= 2 && ('필터프레스'.includes(s) || 'press'.includes(s) || s === 'fp');
  if (pressQ) {
    for (const c of state.cultures) if (num(c.pressL) > 0) { add(c.id); hits.push({ type: 'culture', id: c.id, label: c.lot }); }
    const pressMoves = new Set(state.separations.filter((m) => m.kind === 'move' && m.source === 'press').map((m) => m.id));
    for (const b of state.batches) if ((b.sources || []).some((src) => src.moveId && pressMoves.has(src.moveId))) {
      hits.push({ type: 'batch', id: b.id, label: b.batchNo });
      for (const src of b.sources || []) if (src.moveId && pressMoves.has(src.moveId)) add(src.cultureId);
      for (const p of state.packs) if (p.batchId === b.id) hits.push({ type: 'pack', id: p.id, label: p.productLot });
    }
    return { cultureIds: [...ids], hits, keyword: '필터프레스' };
  }
  for (const c of state.cultures) if ((c.lot || '').toLowerCase().includes(s)) { add(c.id); hits.push({ type: 'culture', id: c.id, label: c.lot }); }
  for (const b of state.batches) if ((b.batchNo || '').toLowerCase().includes(s)) { hits.push({ type: 'batch', id: b.id, label: b.batchNo }); for (const src of b.sources || []) add(src.cultureId); }
  // 제품 LOT 또는 품목명(공백 무시, '충진-' 접두 포함 여부 무관)·제품코드로 포장 내역 검색. 예) "소프트 500" → 충진-소프트 500g
  const ns = s.replace(/\s+/g, '');
  const nameHit = new Map();
  for (const pr of state.products) { const nm = String(pr.name || '').toLowerCase().replace(/\s+/g, ''); if ((ns && nm.includes(ns)) || String(pr.code || '').toLowerCase() === s) nameHit.set(pr.code, pr.name); }
  const batchesAll = allBatches(state);
  for (const p of allPacks(state)) if (productLotMatches(p.productLot, s) || nameHit.has(p.productCode)) {
    hits.push({ type: 'pack', id: p.id, label: p.productLot, product: nameHit.get(p.productCode) || '' });
    const b = batchesAll.find((x) => x.id === p.batchId); if (b) for (const src of b.sources || []) add(src.cultureId);
  }
  for (const l of state.materialLots) if ((l.lot || '').toLowerCase().includes(s)) {
    hits.push({ type: 'materialLot', id: l.id, label: l.lot });
    for (const c of state.cultures) if ((c.rawLots || []).some((r) => r.lotId === l.id)) add(c.id);
    for (const p of state.packs) if ((p.packLots || []).some((r) => r.lotId === l.id)) { const b = state.batches.find((x) => x.id === p.batchId); if (b) for (const src of b.sources || []) add(src.cultureId); }
  }
  return { cultureIds: [...ids], hits };
}

/** 제품 LOT(포장 내역) 하나의 면포 출처 요약: 그 배치에 들어간 반출의 source(press/room)를 포 수로 합산.
 *  필터프레스 배출이 없는 배양 LOT의 반출은 유청분리실로 봄. label: 필터프레스 / 유청분리실 / 필터프레스+유청분리실 / 드링크 / 출처 미입력 */
export function packSourceInfo(state, pack, maps) {
  const m = maps || packSourceMaps(state);
  const b = pack.batchId ? m.batches.get(pack.batchId) : null;
  const r = { press: 0, room: 0, unknown: 0, pressKg: 0, roomKg: 0, unknownKg: 0, drinkKg: 0, drink: false, cultures: [], label: '—', batch: b || null };
  if (!b) return r;
  const seen = new Set();
  for (const src of b.sources || []) {
    const c = m.cultures.get(src.cultureId);
    if (c && !seen.has(c.id)) { seen.add(c.id); r.cultures.push(c); }
    if (src.kind === 'drink') { r.drink = true; r.drinkKg += num(src.kg) || Math.round(num(src.liters) * 1.03); continue; }
    const mv = src.moveId ? m.moves.get(src.moveId) : null;
    const cloths = num(src.cloths) || (mv ? num(mv.cloths) : 0);
    const kg = num(src.kg) || (mv ? num(mv.kg) : 0);
    const source = mv ? mv.source || '' : '';
    if (source === 'press') { r.press += cloths; r.pressKg += kg; }
    else if (source === 'room' || !c || !(num(c.pressL) > 0)) { r.room += cloths; r.roomKg += kg; }
    else { r.unknown += cloths; r.unknownKg += kg; }
  }
  const parts = [];
  if (r.press > 0) parts.push('필터프레스');
  if (r.room > 0) parts.push('유청분리실');
  if (r.unknown > 0) parts.push('출처 미입력');
  if (!parts.length && r.drink) parts.push('드링크');
  r.label = parts.length ? parts.join('+') : '—';
  r.isPress = r.press > 0;
  return r;
}
export function packSourceMaps(state) {
  return { batches: new Map(allBatches(state).map((b) => [b.id, b])), moves: new Map(state.separations.map((s) => [s.id, s])), cultures: new Map(state.cultures.map((c) => [c.id, c])) };
}

// ---------- 생산실적 KPI ----------
/** 배치의 투입량 = 계근량 − 버퍼탱크 폐기량 (엑셀과 동일) */
export function batchNetInputKg(b) { return Math.max(0, num(b.inputKg) - num(b.wasteKg)); }
export function batchPersons(b) { const names = crewNames(b); return names.length ? names.length : num(b.workers); }
/** 여러 배치의 실제 인원: 작업자 이름은 중복 없이 세고, 이름 없이 인원 수만 있는 배치는 설비별 최대 인원으로 더함 (1호기 5명이 배치 2건을 해도 5명) */
export function distinctPersons(batches) {
  const names = new Set(); const noName = new Map();
  for (const b of batches) { const ns = crewNames(b); if (ns.length) ns.forEach((x) => names.add(x)); else noName.set(b.fillerId, Math.max(noName.get(b.fillerId) || 0, num(b.workers))); }
  return names.size + sum([...noName.values()]);
}
export function batchHours(b) { if (b.hours != null && b.hours !== '' && num(b.hours) > 0) return num(b.hours); return batchRunMin(b) / 60; }
/** BPM = 설비 기준 분당 양품 ea: 양품 ea ÷ 가동 분 (엑셀 충진!U열과 동일, 인원은 나누지 않음) */
export function bpmOf(goodEa, runMin) { return runMin > 0 ? num(goodEa) / runMin : null; }
export function batchBpm(b) { return bpmOf(b.goodEa, batchRunMin(b)); }
/** 설비의 기준 BPM(기준정보). 없으면 null */
export function fillerStdBpm(state, fillerId) { const f = (state.settings.fillers || []).find((x) => x.id === fillerId); const v = f ? num(f.stdBpm) : 0; return v > 0 ? v : null; }
export function bpmPct(bpm, std) { return bpm != null && std > 0 ? bpm / std * 100 : null; }

/** 월별 총인원(기준정보 → 데이터): 기간이 걸친 달 중 날짜가 가장 많은 달의 총인원. 등록이 없으면 null */
export function headcountFor(state, from, to) {
  const hc = (state.settings && state.settings.headcount) || {};
  if (!from || !to || from > to) return null;
  const count = new Map();
  for (const d of daysBetween(from, to)) { const m = d.slice(0, 7); count.set(m, (count.get(m) || 0) + 1); }
  const ym = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b))[0];
  const v = num(hc[ym]);
  return v > 0 ? { ym, persons: v } : null;
}
/** range({from,to})가 있으면 인원은 그 달의 총인원(기준정보)을 우선 사용. 없으면 배치 작업자 기준 */
function metrics(state, batches, range) {
  const goodEa = sum(batches, (b) => b.goodEa);
  const goodKg = sum(batches, (b) => batchGoodKg(state, b));
  // 수율·LOSS는 계근량을 입력한 배치만으로 계산 (전산에서 수량만 가져온 과거 실적은 제외)
  const weighed = batches.filter((b) => num(b.inputKg) > 0);
  const weighedGoodKg = sum(weighed, (b) => batchGoodKg(state, b));
  const inputKg = sum(batches, (b) => batchNetInputKg(b));
  const outKg = sum(batches, (b) => b.outKg);
  const weighedKg = sum(batches, (b) => b.inputKg);
  const wasteKg = sum(batches, (b) => b.wasteKg);
  const lossKg = Math.round((inputKg - weighedGoodKg) * 10) / 10; // LOSS = 계근 − 폐기 − 양품 kg (배치 등록 창과 동일)
  // 발효유 수율 = 유청분리 후 면포 무게(계근량 + 폐기량) ÷ 발효유 kg(면포 × 포당 kg). 발효유 kg와 계근량이 모두 있는 배치만
  const wheyBatches = weighed.filter((b) => num(b.fermentKg) > 0);
  const fermentKg = Math.round(sum(wheyBatches, (b) => b.fermentKg) * 10) / 10;
  const curdKg = Math.round(sum(wheyBatches, (b) => num(b.inputKg) + num(b.wasteKg)) * 10) / 10;
  const ingredientKg = Math.round(sum(batches, (b) => b.ingredientKg) * 10) / 10; // 부원료 출고량 (생산량 = 발효유 + 부원료)
  const defectEa = sum(batches, (b) => b.defectEa);
  const hc = range && batches.length ? headcountFor(state, range.from, range.to) : null;
  const persons = hc ? hc.persons : distinctPersons(batches); // 인원: 월 총인원(기준정보) 우선, 없으면 같은 사람은 한 번만 (연인원 아님)
  const hours = sum(batches, (b) => batchHours(b));
  const manHours = sum(batches, (b) => batchPersons(b) * batchHours(b));
  const runMin = sum(batches, (b) => batchRunMin(b));
  const bpms = batches.map(batchBpm).filter((v) => v != null && v > 0); // 엑셀 전체보고와 동일: 배치 BPM(>0)의 단순 평균
  return {
    jobs: batches.length, goodEa, goodKg, inputKg, outKg, weighedKg, wasteKg, lossKg, defectEa, persons, hours, manHours, runMin,
    fermentKg, curdKg, ingredientKg, wheyYieldPct: fermentKg > 0 ? curdKg / fermentKg * 100 : null,
    personsSource: hc ? 'headcount' : 'crew', headcountYm: hc ? hc.ym : '', quantityOnly: batches.length - weighed.length,
    yieldPct: inputKg > 0 ? weighedGoodKg / inputKg * 100 : null,
    lossPct: inputKg > 0 ? lossKg / inputKg * 100 : null,
    mixYieldPct: outKg > 0 ? weighedKg / outKg * 100 : null,
    defectPct: goodEa + defectEa > 0 ? defectEa / (goodEa + defectEa) * 100 : null,
    eaPerPerson: div(goodEa, persons), kgPerPerson: div(goodKg, persons),
    eaPerHour: div(goodEa, hours), kgPerHour: div(goodKg, hours),
    eaPerManHour: div(goodEa, manHours), kgPerManHour: div(goodKg, manHours),
    bpm: bpms.length ? sum(bpms) / bpms.length : null, // 배치별 (양품 ea ÷ 가동 분)의 단순 평균
  };
}

/** 전산 백데이터(legacy 컬렉션)의 배치·포장을 평탄화 — 분석 집계 전용 */
export function legacyBatches(state) { return (state.legacy || []).flatMap((d) => d.batches || []); }
export function legacyPacks(state) { return (state.legacy || []).flatMap((d) => d.packs || []); }
/** 생산일지 입력(journal)으로 넣은 배치가 있는 날·설비("date|fillerId"). 그날 그 설비의 전산 백데이터 배치·포장은 분석·추적에서 뺀다(같은 실적이 두 번 잡히지 않게) */
export function journalKeys(state) { return new Set(state.batches.filter((b) => b.journal).map((b) => `${b.date}|${b.fillerId}`)); }
export function legacyBatchesLive(state) { const k = journalKeys(state); return k.size ? legacyBatches(state).filter((b) => !k.has(`${b.date}|${b.fillerId}`)) : legacyBatches(state); }
export function legacyPacksLive(state) {
  const k = journalKeys(state); if (!k.size) return legacyPacks(state);
  const lb = new Map(legacyBatches(state).map((b) => [b.id, b]));
  return legacyPacks(state).filter((p) => { const b = lb.get(p.batchId); return !(b && k.has(`${b.date}|${b.fillerId}`)); });
}
/** 앱 입력 + 전산 백데이터를 합친 포장 내역·충진 배치 (LOT 추적·클레임용). 생산일지로 넣은 제품 LOT가 있으면 같은 LOT·품목의 다른 기록(전산 임시·백데이터)은 숨김 → 생산일지 데이터 우선 */
export function allPacks(state) {
  const jb = new Set(state.batches.filter((b) => b.journal).map((b) => b.id));
  const jk = new Set(state.packs.filter((p) => jb.has(p.batchId)).map((p) => `${p.productLot}|${p.productCode}`));
  const keep = (p) => !jk.has(`${p.productLot}|${p.productCode}`);
  return [...state.packs.filter((p) => jb.has(p.batchId) || keep(p)), ...legacyPacksLive(state).filter(keep)];
}
export function allBatches(state) { return [...state.batches, ...legacyBatchesLive(state)]; }
/** 어떤 날에 배출된(LOT 앞자리 yymmdd = 그 날) 배양 LOT. 반출 기록이 없는 백데이터 충진의 '참고 후보'로 씀 */
export function dischargeCandidates(state, date) {
  const k = date ? `${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}` : '';
  return k ? state.cultures.filter((c) => String(c.lot || '').startsWith(k)).sort((a, b) => String(a.lot).localeCompare(String(b.lot))) : [];
}
export function analyze(state, { from, to, fillerId }) {
  const inRange = (d) => d >= from && d <= to;
  let batches = [...state.batches, ...legacyBatchesLive(state)].filter((b) => inRange(b.date)); // 생산일지로 넣은 날·설비의 백데이터는 제외
  if (fillerId) batches = batches.filter((b) => b.fillerId === fillerId);
  const batchIds = new Set(batches.map((b) => b.id));
  const total = metrics(state, batches, { from, to });
  const byFiller = [...groupBy(batches, (b) => b.fillerId)].map(([id, list]) => { const m = metrics(state, list); const stdBpm = fillerStdBpm(state, id); return { key: id, label: fillerOf(state, id).name, ...m, stdBpm, bpmPct: bpmPct(m.bpm, stdBpm) }; })
    .sort((a, b) => a.key.localeCompare(b.key));
  const byDayMap = groupBy(batches, (b) => b.date);
  const byDay = daysBetween(from, to).map((d) => ({ key: d, label: d, ...metrics(state, byDayMap.get(d) || [], { from: d, to: d }) }));
  const byMix = [...groupBy(batches, (b) => b.mixType || '(미지정)')].map(([k, list]) => ({ key: k, label: k, ...metrics(state, list) })).sort((a, b) => b.goodKg - a.goodKg);
  const packs = [...state.packs, ...legacyPacksLive(state)].filter((p) => inRange(p.date) && (fillerId ? batchIds.has(p.batchId) : true));
  const normalPacks = packs.filter((p) => p.kind !== 'repack');
  const byProduct = [...groupBy(normalPacks, (p) => p.productCode)].map(([code, list]) => {
    const product = productOf(state, code);
    return { key: code, label: String(product ? product.name : code).replace(/^충진[-_]\s*/, ''), mixType: product ? product.mixType : '', qty: sum(list, (p) => p.qty), kg: sum(list, (p) => packKg(state, p)), lots: new Set(list.map((p) => p.productLot)).size, count: list.length };
  }).sort((a, b) => b.kg - a.kg);
  const repacks = packs.filter((p) => p.kind === 'repack').map((p) => ({ ...p, product: productOf(state, p.productCode), batch: state.batches.find((b) => b.id === p.batchId) }));
  const repackTotal = { qty: sum(repacks, (p) => p.qty), persons: sum(repacks, (p) => p.workers), hours: sum(repacks, (p) => p.hours), manHours: sum(repacks, (p) => num(p.workers) * num(p.hours)) };
  // LOT별 종합 수율 (해당 기간 충진에 사용된 배양 LOT)
  const cultureIds = new Set(); for (const b of batches) for (const s of b.sources || []) cultureIds.add(s.cultureId);
  const lots = [...cultureIds].map((id) => traceCulture(state, id)).filter(Boolean)
    .map((t) => ({ id: t.culture.id, lot: t.culture.lot, date: t.culture.date, tank: t.tank.name, tankId: t.tank.id, ...t.balance, type: t.culture.type,
      wheyPct: t.balance.usedKg > 0 ? t.balance.inputKg / t.balance.usedKg * 100 : null,
      fillYield: t.balance.inputKg > 0 ? t.balance.goodKg / t.balance.inputKg * 100 : null,
      overall: t.balance.rawKg > 0 ? t.balance.goodKg / t.balance.rawKg * 100 : null }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.lot.localeCompare(b.lot));
  const lotTotal = { rawKg: sum(lots, (l) => l.rawKg), usedKg: sum(lots, (l) => l.usedKg), inputKg: sum(lots, (l) => l.inputKg), goodKg: sum(lots, (l) => l.goodKg) };
  lotTotal.overall = lotTotal.rawKg > 0 ? lotTotal.goodKg / lotTotal.rawKg * 100 : null;
  // 탱크별 종합 수율: 같은 탱크의 배양 LOT를 합산 (기준정보 탱크 순서)
  const tankOrder = state.settings.tanks.map((t) => t.id);
  const byTank = [...groupBy(lots, (l) => l.tankId)].map(([tankId, list]) => {
    const r = { tankId, tank: list[0].tank, lotCount: list.length, lots: list, rawKg: sum(list, (l) => l.rawKg), usedKg: sum(list, (l) => l.usedKg), inputKg: sum(list, (l) => l.inputKg), goodKg: sum(list, (l) => l.goodKg) };
    r.wheyPct = r.usedKg > 0 ? r.inputKg / r.usedKg * 100 : null;
    r.fillYield = r.inputKg > 0 ? r.goodKg / r.inputKg * 100 : null;
    r.overall = r.rawKg > 0 ? r.goodKg / r.rawKg * 100 : null;
    return r;
  }).sort((a, b) => (tankOrder.indexOf(a.tankId) === -1 ? 99 : tankOrder.indexOf(a.tankId)) - (tankOrder.indexOf(b.tankId) === -1 ? 99 : tankOrder.indexOf(b.tankId)));
  const tankTotal = { ...lotTotal, lotCount: lots.length, wheyPct: lotTotal.usedKg > 0 ? lotTotal.inputKg / lotTotal.usedKg * 100 : null, fillYield: lotTotal.inputKg > 0 ? lotTotal.goodKg / lotTotal.inputKg * 100 : null };
  return { from, to, batches, total, byFiller, byDay, byMix, byProduct, repacks, repackTotal, lots, lotTotal, byTank, tankTotal };
}

// ---------- 자재 재고 ----------
export function materialStock(state) {
  const t = today();
  const used = new Map();
  const bump = (lotId, qty) => used.set(lotId, (used.get(lotId) || 0) + num(qty));
  for (const c of state.cultures) for (const r of c.rawLots || []) bump(r.lotId, r.qty);
  for (const p of state.packs) for (const r of p.packLots || []) bump(r.lotId, r.qty);
  const lots = state.materialLots.map((l) => {
    const material = state.materials.find((m) => m.code === l.materialCode) || { code: l.materialCode, name: l.materialCode, unit: '' };
    const usedQty = used.get(l.id) || 0;
    const remaining = num(l.qty) - usedQty - num(l.disposedQty);
    let status = 'ok';
    if (remaining <= 0) status = 'empty';
    else if (l.expiry && l.expiry < t) status = 'expired';
    else if (l.expiry && l.expiry <= addDays(t, 7)) status = 'soon';
    return { ...l, material, usedQty, remaining, status };
  }).sort((a, b) => (a.materialCode + a.lot).localeCompare(b.materialCode + b.lot));
  const byMaterial = state.materials.map((m) => {
    const mine = lots.filter((l) => l.materialCode === m.code);
    const available = sum(mine.filter((l) => l.status === 'ok' || l.status === 'soon'), (l) => l.remaining);
    return { ...m, lots: mine, available, belowSafety: m.safety != null && m.safety !== '' && available < num(m.safety) };
  });
  return { lots, byMaterial };
}

// ---------- BOM ----------
export function bomOf(state, productCode) { return (state.bom || []).find((b) => b.productCode === productCode || b.id === productCode) || null; }
/** 제품 수량에 대한 포장재 소요량 (BOM 라인 × 수량) */
export function bomRequirements(state, productCode, qty) {
  const b = bomOf(state, productCode); if (!b) return [];
  return (b.lines || []).map((l) => ({ ...l, material: state.materials.find((m) => m.code === l.materialCode) || { code: l.materialCode, name: l.name, unit: l.unit }, total: num(l.qty) * num(qty) }));
}
/** 자재의 사용 가능한 LOT 중 가장 먼저 쓸 것 (기한 빠른 순, 없으면 입고 빠른 순) */
export function pickMaterialLot(state, materialCode) {
  const t = today();
  const lots = state.materialLots.filter((l) => l.materialCode === materialCode && (!l.expiry || l.expiry >= t));
  const stock = materialStock(state);
  const avail = lots.map((l) => stock.lots.find((x) => x.id === l.id)).filter((l) => l && l.remaining > 0)
    .sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999') || (a.receivedDate || '').localeCompare(b.receivedDate || ''));
  return avail[0] || null;
}
/** 생산계획 기준 자재 필요량: Σ(계획수량 × BOM 단위소요량) vs 가용 재고 */
export function planRequirements(state, plans) {
  const need = new Map();
  for (const p of plans) for (const r of bomRequirements(state, p.productCode, p.qty)) { const k = r.materialCode; if (!need.has(k)) need.set(k, { materialCode: k, material: r.material, unit: r.unit, total: 0 }); need.get(k).total += r.total; }
  const stock = materialStock(state);
  return [...need.values()].map((x) => { const m = stock.byMaterial.find((y) => y.code === x.materialCode); const available = m ? m.available : 0; return { ...x, available, shortage: Math.max(0, x.total - available) }; })
    .sort((a, b) => b.shortage - a.shortage || a.material.name.localeCompare(b.material.name));
}

// ---------- 기간별 투입 자재 (원부자재 수불) ----------
const isMilk = (m) => !!m && (m.group === '원유' || /원유/.test(m.name || ''));
const isStarter = (m) => !!m && (m.group === '유산균' || /유산균|스타터/.test(m.name || ''));
/** 제품 1개당 자재 소요량. 포장재는 BOM 라인(앱에서 고칠 수 있는 값), 원유·유산균·부원료는 엑셀 BOM 트리의 원자재 말단.
 *  트리가 없으면 milkKg·starterBags로 원유·유산균을 환산. BOM 자체가 없으면 null */
export function bomUnitMaterials(state, productCode) {
  const b = bomOf(state, productCode); if (!b) return null;
  const out = new Map();
  const add = (code, name, unit, qty, kind) => { if (!code || !(num(qty) > 0)) return; if (!out.has(code)) out.set(code, { materialCode: code, name, unit, kind, qty: 0 }); out.get(code).qty += num(qty); };
  const treeRaw = [], treePack = [];
  const walk = (nodes) => { for (const nd of nodes || []) { if (nd.children && nd.children.length) walk(nd.children); else if (nd.kind === '원자재') treeRaw.push(nd); else if (nd.kind === '부자재') treePack.push(nd); } };
  if (Array.isArray(b.tree)) walk(b.tree);
  const lines = b.lines || [];
  if (lines.length) for (const l of lines) add(l.materialCode, l.name, l.unit, l.qty, 'pack');
  else for (const nd of treePack) add(nd.code, nd.name, nd.unit, nd.qty, 'pack');
  if (treeRaw.length) for (const nd of treeRaw) add(nd.code, nd.name, nd.unit, nd.qty, 'raw');
  else {
    const milk = state.materials.find(isMilk), st = state.materials.find(isStarter);
    if (milk && num(b.milkKg) > 0) add(milk.code, milk.name, milk.unit, b.milkKg, 'raw');
    if (st && num(b.starterBags) > 0) add(st.code, st.name, st.unit, b.starterBags, 'raw');
  }
  return [...out.values()].map((x) => ({ ...x, material: state.materials.find((m) => m.code === x.materialCode) || { code: x.materialCode, name: x.name, unit: x.unit, kind: x.kind, group: '' } }));
}
/** 기간(from~to) 투입 자재.
 *  - 부자재·부원료: 그 기간 포장 수량 × BOM 단위소요량 (basis 'bom')
 *  - 원유·유산균: 그 기간 배양 실적의 원유 kg·스타터 봉 (basis 'culture'); 포장 수량 × BOM 환산값은 bomQty로 같이 돌려줌
 *  missing = BOM이 없어 환산하지 못한 제품 → 포장 수량 */
export function materialUsage(state, { from, to }) {
  const rows = new Map(); const unitCache = new Map(); const missing = new Map();
  const row = (code, fb) => { if (!rows.has(code)) rows.set(code, { materialCode: code, material: state.materials.find((m) => m.code === code) || fb, qty: 0, bomQty: 0, basis: 'bom', byProduct: new Map() }); return rows.get(code); };
  for (const p of state.packs) {
    if (!p.date || p.date < from || p.date > to) continue;
    const qty = num(p.qty); if (qty <= 0) continue;
    if (!unitCache.has(p.productCode)) unitCache.set(p.productCode, bomUnitMaterials(state, p.productCode));
    const unit = unitCache.get(p.productCode);
    if (!unit) { missing.set(p.productCode, (missing.get(p.productCode) || 0) + qty); continue; }
    for (const u of unit) { const r = row(u.materialCode, u.material); r.bomQty += u.qty * qty; r.byProduct.set(p.productCode, (r.byProduct.get(p.productCode) || 0) + qty); }
  }
  const milk = state.materials.find(isMilk), st = state.materials.find(isStarter);
  let cultures = 0;
  for (const c of state.cultures) {
    if (!c.date || c.date < from || c.date > to) continue;
    cultures++;
    if (milk && num(c.rawKg) > 0) row(milk.code, milk).qty += num(c.rawKg);
    if (st && num(c.starterBags) > 0) row(st.code, st).qty += num(c.starterBags);
  }
  for (const r of rows.values()) { if (isMilk(r.material) || isStarter(r.material)) r.basis = 'culture'; else r.qty = r.bomQty; }
  return { rows: [...rows.values()].filter((r) => r.qty > 0 || r.bomQty > 0), missing, cultures };
}

// ---------- 면포 경과일 (v269): 배양 LOT 앞 6자리 = 배양탱크 배출일(유청분리실에서 면포를 만든 날) → 반출일까지 4일 이상이면 빨간 LOT (사용자: 4일째도 안 됨) ----------
// LOT 추적 · 클레임 LOT · 자사검사에서만 씀
export const CLOTH_AGE_LIMIT = 4;
export const lotOutDate = (lot) => { const m = /^(\d{2})(\d{2})(\d{2})/.exec(String(lot || '')); return m ? `20${m[1]}-${m[2]}-${m[3]}` : ''; };
// v336에 넣었던 필터프레스(FP) +1일은 v337에서 뺌 (사용자 요청) — 다시 쓰려면 1로
export const FP_AGE_EXTRA = 0;
export const isPressMove = (m) => !!(m && m.source === 'press');
export function clothAgeDays(lot, moveDate, press = false) {
  const d0 = lotOutDate(lot); if (!d0 || !moveDate) return null;
  const d = Math.round((Date.parse(moveDate) - Date.parse(d0)) / 86400000) + (press ? FP_AGE_EXTRA : 0);
  return Number.isFinite(d) ? d : null;
}
const movesCache = new WeakMap();
function movesByCulture(state) {
  let m = movesCache.get(state.separations);
  if (!m) { m = new Map(); for (const s of state.separations) if (s.kind === 'move') { if (!m.has(s.cultureId)) m.set(s.cultureId, []); m.get(s.cultureId).push(s); } movesCache.set(state.separations, m); }
  return m;
}
/** 배양 LOT의 반출 중 배출일에서 가장 오래 지난 것 → { days, date, out, old } | null. keep(m)으로 볼 반출을 고름 (예: 그 제품 배치에 들어간 반출만) */
export function clothAge(state, c, keep) {
  if (!c) return null;
  let best = null;
  for (const m of movesByCulture(state).get(c.id) || []) {
    if (keep && !keep(m)) continue;
    const d = clothAgeDays(c.lot, m.date, isPressMove(m));
    if (d != null && (!best || d > best.days)) best = { days: d, date: m.date, press: isPressMove(m) };
  }
  return best ? { ...best, out: lotOutDate(c.lot), old: best.days >= CLOTH_AGE_LIMIT } : null;
}
/** 반출 하나의 경과일 → { days, date, out, old, press } | null (FP 반출은 +1일) */
export function moveAge(c, m) {
  if (!c || !m) return null; const d = clothAgeDays(c.lot, m.date, isPressMove(m));
  return d == null ? null : { days: d, date: m.date, out: lotOutDate(c.lot), old: d >= CLOTH_AGE_LIMIT, press: isPressMove(m) };
}
/** LOT 글자색 class: 2일 이하 초록(lot-fresh) · 3일 파랑(lot-mid) · 4일 이상 빨강(lot-old). 반출 기록이 없으면 '' (사용자 요청 11/9) */
export const ageCls = (a, pre = '') => a ? pre + (a.days >= CLOTH_AGE_LIMIT ? 'lot-old' : a.days >= 3 ? 'lot-mid' : 'lot-fresh') : '';
export const clothAgeTitle = (a) => a ? `배출 ${a.out.replace(/-/g, '.')} → 반출 ${String(a.date).replace(/-/g, '.')} · ${a.days}일${a.press && FP_AGE_EXTRA ? ` (FP +${FP_AGE_EXTRA}일 포함)` : ''}${a.old ? ` (${CLOTH_AGE_LIMIT}일 이상)` : ''}` : '';

/** 대시보드: 탱크별 최근 배양 상태 */
export function tankBoard(state, date) {
  return state.settings.tanks.map((tank) => {
    const list = state.cultures.filter((c) => c.tankId === tank.id && c.date <= date).sort((a, b) => b.date.localeCompare(a.date) || (b.seq || 0) - (a.seq || 0));
    const c = list[0];
    const stock = c ? cultureStock(state, c.id) : null;
    return { tank, culture: c, stock };
  });
}
