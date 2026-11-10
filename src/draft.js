// 전산 임시 배치(erpDraft)와 배정 대기 면포(반출) 합치기
import { save } from './store.js';
import { mixRatio } from './model.js';
import { sum, num } from './util.js';

/** 그날 그 설비·재공품 유형의 전산 임시 배치 (없으면 undefined) */
export function draftFor(state, date, fillerId, mixType) {
  return state.batches.find((b) => b.erpDraft && b.date === date && b.fillerId === fillerId && (b.mixType || '') === (mixType || ''));
}

/** 그날(반출일 기준) 그 설비·유형으로 반출됐지만 아직 배치에 안 들어간 면포 */
export function pendingMovesFor(state, date, fillerId, mixType) {
  return state.separations.filter((m) => m.kind === 'move' && !m.batchId && (m.fillDate || m.date) === date && m.fillerId === fillerId && (m.mixType || '') === (mixType || ''));
}

/**
 * 반출 면포를 임시 배치의 배양 LOT(sources)로 붙이고 발효유 출고·출고량을 다시 계산해 저장.
 * 계근량·작업시간은 그대로(임시 상태 유지). 반출 기록에는 batchId·설비를 적어 배정 대기에서 빠지게 함.
 */
export async function attachMovesToDraft(state, draft, moves) {
  const fresh = moves.filter((m) => !(draft.sources || []).some((s) => s.moveId === m.id));
  if (!fresh.length) return 0;
  const sources = [...(draft.sources || []), ...fresh.map((m) => ({ moveId: m.id, cultureId: m.cultureId, kind: 'cloth', cloths: num(m.cloths), liters: 0, kg: num(m.kg) }))];
  const fermentKg = Math.round(sum(sources, (s) => s.kg) * 10) / 10;
  const ratio = mixRatio(state, draft.mixType);
  const ingredientKg = ratio > 1 ? Math.round(num(draft.inputKg) * (1 - 1 / ratio) * 10) / 10 : 0;
  await save('batches', { ...draft, sources, fermentKg, ingredientKg, outKg: Math.round((fermentKg + ingredientKg) * 10) / 10 });
  for (const m of fresh) await save('separations', { ...m, culture: undefined, batchId: draft.id, fillerId: draft.fillerId });
  return fresh.length;
}

/** 그날 그 설비의 전산 임시 배치 (드링크처럼 설비당 하나인 경우 — 유형이 같은 것을 먼저) */
export function draftForFiller(state, date, fillerId, mixType) {
  const ds = state.batches.filter((b) => b.erpDraft && b.date === date && b.fillerId === fillerId);
  return ds.find((b) => (b.mixType || '') === (mixType || '')) || ds[0];
}

/**
 * 드링크 원액(배양 당일 직송)을 임시 배치의 배양 LOT로 붙인다: items = [{ cultureId, liters }].
 * 이미 붙어 있는 LOT는 리터를 더하고, 발효유(kg = L × 비중)·출고량을 다시 계산. 계근량·작업시간은 그대로.
 */
export async function attachDrinkToDraft(state, draft, items, density = 1.03) {
  const sources = [...(draft.sources || [])].map((s) => ({ ...s }));
  let cnt = 0;
  for (const it of items) {
    const liters = num(it.liters);
    if (!it.cultureId || liters <= 0) continue;
    const kg = Math.round(liters * density * 10) / 10;
    const ex = sources.find((s) => s.kind === 'drink' && s.cultureId === it.cultureId);
    if (ex) { ex.liters = Math.round((num(ex.liters) + liters) * 10) / 10; ex.kg = Math.round((num(ex.kg) + kg) * 10) / 10; }
    else sources.push({ cultureId: it.cultureId, kind: 'drink', cloths: 0, liters, kg });
    cnt++;
  }
  if (!cnt) return 0;
  const fermentKg = Math.round(sum(sources, (s) => s.kg) * 10) / 10;
  const ratio = mixRatio(state, draft.mixType);
  const ingredientKg = ratio > 1 ? Math.round(num(draft.inputKg) * (1 - 1 / ratio) * 10) / 10 : 0;
  await save('batches', { ...draft, sources, fermentKg, ingredientKg, outKg: Math.round((fermentKg + ingredientKg) * 10) / 10 });
  return cnt;
}
