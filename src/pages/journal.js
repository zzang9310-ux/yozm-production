// 생산일지 입력: 종이 생산일지(충진 N호기)와 같은 모양으로 설비·날짜를 고르고 열(버퍼)마다
//   유청 사용 LOT(탱크·배출일 → 배양 LOT, 면포 수) / 충진 시간 / 품목·소비기한·수량 / 계근·폐기·불량 을 적어 저장.
//   저장하면 열마다 충진 배치 1건 + 반출 기록(면포) + 포장 내역(제품 LOT)이 한꺼번에 만들어지고,
//   같은 날·설비의 전산 임시 배치에서 같은 제품 줄은 자동으로 빠진다(fill.absorbErpDrafts). → 제품 LOT마다 어느 탱크 면포가 들어갔는지 정확히 추적됨
import { html, useState, useMemo, useEffect, useRef, Card, Chip, Icon, Field, toast, confirmAsync } from '../ui.js';
import { save, remove, getState } from '../store.js';
import { cultureStock, mixRatio, fillerOf, tankOf, productOf, bomRequirements, pickMaterialLot, batchRunMin, canPress, crewNames, isJournalFiller, journalOnly, JOURNAL_ALL_FROM } from '../model.js';
import { absorbErpDrafts, NumInput, TimeInput, DateInput, normTime } from './fill.js';
import { matchProducts } from './claim.js';
import { n, fmtDate, fmtMD, dow, addDays, today, uid, num, calc, batchNo, productLot, sum } from '../util.js';

const yymmdd = (iso) => iso ? `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}` : '';
const shortName = (s) => String(s || '').replace(/^충진[-_]\s*/, '');
// 유청 사용 LOT 한 줄: 탱크 면포(cloths 포) 또는 필터프레스(tankId 'PRESS' · 면포 포 수 — 기본값은 유청분리에서 필터프레스로 반출한 면포.
// 예전 줄처럼 kg만 있으면 포당 kg로 환산해 읽음)
const PRESS = 'PRESS';
const newWhey = () => ({ tankId: '', cultureId: '', cloths: '', kg: '' });
const newLine = () => ({ productCode: '', expiry: '', qty: '' });
const newCol = () => ({ key: uid(), whey: [newWhey(), newWhey()], startTime: '', endTime: '', lines: [newLine(), newLine(), newLine()], inputKg: '', wasteKg: '', defectEa: '', mixType: '', crew: null }); // crew: 작업자 {fill,cap,pack} 쉼표 문자열. null이면 기준정보의 설비 기본 작업자

// ---------- 일지 사진 → 초안 (sample 기능: 보는 사람의 Claude로 사진을 읽음) ----------
/** "11.2", "11/16", "2026.11.16", "16" 같은 일지 날짜를 충진일 기준으로 ISO로. 월이 없으면 충진일의 월. 미래 월(소비기한)은 다음 해, 과거 월(배출일)은 지난 해로 */
export function journalDate(v, fillDate, kind) {
  const s = String(v == null ? '' : v).trim(); if (!s) return '';
  const fy = +fillDate.slice(0, 4), fm = +fillDate.slice(5, 7);
  let m = s.match(/^(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/);
  if (m) return `20${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\s*[.\-/]\s*(\d{1,2})/);
  let mm, dd;
  if (m) { mm = +m[1]; dd = +m[2]; } else { const d = s.match(/^(\d{1,2})$/); if (!d) return ''; mm = fm; dd = +d[1]; }
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  let y = fy;
  if (kind === 'expiry' && mm < fm - 1) y = fy + 1;      // 소비기한이 충진 달보다 한참 앞 → 해 넘김
  if (kind === 'discharge' && mm > fm + 1) y = fy - 1;   // 배출일이 충진 달보다 한참 뒤 → 지난 해
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
/** 사진에서 읽은 JSON 초안 → 입력 열. notes에 못 맞춘 항목을 적어 돌려줌 */
export function draftToCols(state, draft, fillDate, fillerId) {
  const notes = [];
  const tanks = state.settings.tanks || [];
  // 배양 LOT 후보는 충진일까지 배출된 것만 (LOT 앞 6자리 = 배출일). 예전엔 배양 시작일로 걸러 충진일 뒤에 배출된 LOT가 들어가기도 했음 (v242)
  const fillDay = yymmdd(fillDate);
  const stocks = state.cultures.filter((c) => c.date <= fillDate && String(c.lot || '').slice(0, 6) <= fillDay).map((c) => ({ c, stock: cultureStock(state, c.id) }));
  const cols = [];
  for (const [ci, col] of (Array.isArray(draft.columns) ? draft.columns : []).entries()) {
    const out = newCol(); out.whey = []; out.lines = [];
    for (const w of Array.isArray(col.whey) ? col.whey : []) {
      const tankRaw = String(w.tank == null ? '' : w.tank);
      const dis = journalDate(w.dischargeDate, fillDate, 'discharge');
      // 필터프레스 줄: 탱크 대신 "필터"라고 적힘. 그 배출일에 필터프레스로 배출한 배양 LOT 중 하나 (여러 탱크면 첫째 — 확인 필요)
      if (/필터|press|fp/i.test(tankRaw)) {
        const cands = stocks.filter((x) => num(x.c.pressL) > 0 && x.c.date <= fillDate).sort((a, b) => String(b.c.lot).localeCompare(String(a.c.lot)));
        const same = dis ? cands.filter((x) => String(x.c.lot).startsWith(yymmdd(dis))) : [];
        const hit = same[0] || cands[0];
        if (!hit) notes.push(`버퍼 ${ci + 1}: 필터프레스 배출 배양 LOT가 없음`);
        else if (!same.length) notes.push(`버퍼 ${ci + 1}: ${w.dischargeDate || ''} 필터프레스 배출 LOT가 없어 가장 최근 ${hit.c.lot}로 넣음 — 확인`);
        else if (same.length > 1) notes.push(`버퍼 ${ci + 1}: ${w.dischargeDate} 필터프레스 배출 LOT가 ${same.length}개(${same.map((x) => x.c.lot).join(', ')}) — ${hit.c.lot}로 넣었으니 탱크를 확인`);
        // 일지에 적힌 필터프레스 kg는 유청분리 후 무게 → 포당 약 14 kg로 면포 수 추정 (유청분리 반출 면포로 확인)
        const pk = w.kg != null ? num(w.kg) : 0;
        const pc = w.cloths != null ? num(w.cloths) : pk > 0 ? Math.max(1, Math.round(pk / 14)) : 0;
        if (w.cloths == null && pk > 0) notes.push(`버퍼 ${ci + 1}: 필터프레스 ${n(pk)}kg로 적힘 → 약 ${n(pc)}포로 넣음 (유청분리 반출 면포로 확인)`);
        out.whey.push({ tankId: PRESS, cultureId: hit ? hit.c.id : '', cloths: pc > 0 ? String(pc) : '', kg: '' });
        continue;
      }
      const tn = tankRaw.replace(/\D/g, '');
      const tank = tanks.find((t) => String(t.id).replace(/\D/g, '') === tn || t.name.replace(/\D/g, '') === tn && tn);
      if (!tank) { if (tn || w.cloths) notes.push(`버퍼 ${ci + 1}: 탱크 "${w.tank}"를 못 찾음`); continue; }
      const pref = dis ? yymmdd(dis) + tank.id : '';
      const cands = stocks.filter((x) => x.c.tankId === tank.id && x.c.date <= fillDate).sort((a, b) => String(b.c.lot).localeCompare(String(a.c.lot)));
      let hit = pref ? cands.find((x) => String(x.c.lot).startsWith(pref)) : null;
      if (!hit) { hit = cands[0]; if (hit) notes.push(`버퍼 ${ci + 1}: ${tank.name} ${w.dischargeDate || ''} 배출 LOT가 없어 가장 최근 ${hit.c.lot}로 넣음 — 확인`); else notes.push(`버퍼 ${ci + 1}: ${tank.name}의 배양 LOT가 없음`); }
      out.whey.push({ tankId: tank.id, cultureId: hit ? hit.c.id : '', cloths: w.cloths == null ? '' : String(num(w.cloths)), kg: '' });
    }
    for (const l of Array.isArray(col.lines) ? col.lines : []) {
      const name = String(l.product || '').trim();
      const ms = name ? matchProducts(state, name).filter((m) => m.product.fillList !== false) : [];
      const p = ms.length ? ms[0].product : null;
      if (!p) { if (name || l.qty) notes.push(`버퍼 ${ci + 1}: 품목 "${name}"을 못 찾음 — 직접 고르세요`); }
      else if (ms.length > 1) notes.push(`버퍼 ${ci + 1}: "${name}" → ${shortName(p.name)} (후보 ${ms.length}개 중 첫째)`);
      out.lines.push({ productCode: p ? p.code : '', expiry: journalDate(l.expiry, fillDate, 'expiry'), qty: l.qty == null ? '' : String(num(l.qty)), hint: !p && name ? name : '' });
    }
    if (!out.whey.length) out.whey = [newWhey(), newWhey()];
    if (!out.lines.length) out.lines = [newLine(), newLine(), newLine()];
    out.startTime = normTime(col.start) || ''; out.endTime = normTime(col.end) || '';
    out.inputKg = col.inputKg == null ? '' : String(num(col.inputKg)); out.wasteKg = col.wasteKg == null ? '' : String(num(col.wasteKg)); out.defectEa = col.defectEa == null ? '' : String(num(col.defectEa));
    cols.push(out);
  }
  return { cols: cols.length ? cols : [newCol()], notes };
}
// ---------- 수기 일지 초안을 ERP 충진실적(전산 대조로 먼저 넣은 실적)에 맞춤 ----------
// 손글씨가 애매해 전산과 다른 숫자·소비기한을 전산 기준으로 고치고, 고친 내용은 모두 확인 사항(notes)으로 남김 — 사람이 다시 검수
/** 그 날·설비의 ERP 충진실적: 품목코드|소비기한 → 수량 (전산 임시 배치 + 전산 대조로 들어와 정식이 된 배치. 일지 배치는 제외) */
export function erpQtyMap(state, date, fillerId) {
  const ids = new Set(state.batches.filter((b) => b.date === date && b.fillerId === fillerId && !b.journal && (b.erpDraft || b.erpImportedAt)).map((b) => b.id));
  const m = new Map();
  for (const p of state.packs) if (ids.has(p.batchId) && p.kind !== 'repack') { const k = `${p.productCode}|${p.expiry || ''}`; m.set(k, (m.get(k) || 0) + num(p.qty)); }
  return m;
}
/** a에서 숫자 한 자리를 지우거나 넣으면 b가 되는지 (4492 ↔ 492) */
const digitInsDel = (a, b) => { const x = String(Math.round(a)), y = String(Math.round(b)); if (Math.abs(x.length - y.length) !== 1 || !(b > 0)) return false; const [L, S] = x.length > y.length ? [x, y] : [y, x]; for (let i = 0; i < L.length; i++) if (L.slice(0, i) + L.slice(i + 1) === S) return true; return false; };
const digitDiff = (a, b) => { const x = String(Math.round(a)), y = String(Math.round(b)); if (x.length !== y.length) return 9; let d = 0; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) d++; return d; };
/** cols(초안 열)를 ERP 수량에 맞춤 → { cols, notes }. ERP 실적이 없으면 그대로 */
export function erpAdjustCols(state, cols, date, fillerId) {
  const erp = erpQtyMap(state, date, fillerId);
  if (!erp.size) return { cols, notes: [] };
  const notes = [];
  const out = cols.map((c) => ({ ...c, lines: c.lines.map((l) => ({ ...l })) }));
  const nm = (code) => { const p = productOf(state, code); return shortName(p ? p.name : code); };
  const md = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : '?');
  const refs = () => out.flatMap((c, ci) => c.lines.map((l, li) => ({ ci, li, l })).filter((x) => x.l.productCode && num(x.l.qty) > 0));
  const jrMap = () => { const m = new Map(); for (const x of refs()) { const k = `${x.l.productCode}|${x.l.expiry || ''}`; m.set(k, (m.get(k) || 0) + num(x.l.qty)); } return m; };
  // 1) 소비기한: 전산에 없는 품목·소비기한 줄 → 같은 품목 중 일지가 모자란 소비기한이 하나뿐이면 그쪽으로
  for (const x of refs()) {
    const k = `${x.l.productCode}|${x.l.expiry || ''}`; if (erp.has(k)) continue;
    const jr = jrMap();
    const cands = [...erp.keys()].filter((e) => e.startsWith(x.l.productCode + '|') && erp.get(e) - (jr.get(e) || 0) > 0);
    if (cands.length === 1) { const to = cands[0].split('|')[1]; notes.push(`버퍼 ${x.ci + 1}: ${nm(x.l.productCode)} ${n(num(x.l.qty))}개 소비기한 ${md(x.l.expiry)} → ${md(to)} (전산 실적 기준 · 글씨 확인)`); out[x.ci].lines[x.li].expiry = to; }
    else notes.push(`버퍼 ${x.ci + 1}: ${nm(x.l.productCode)} ${md(x.l.expiry)} ${n(num(x.l.qty))}개는 전산 실적에 없음 — 품목·소비기한 확인`);
  }
  // 1-2) 소비기한이 넘치는데 넘친 분량과 수량이 같은 줄이 있고, 같은 품목에 모자란 소비기한이 있으면 그 줄을 옮김 (예: 11/16에 746개가 더 있고 11/15가 모자람)
  {
    const jr0 = jrMap();
    for (const [k, e] of erp) {
      const over = (jr0.get(k) || 0) - e; if (over <= Math.max(5, e * 0.2)) continue;
      const code = k.split('|')[0];
      const x = refs().find((r) => `${r.l.productCode}|${r.l.expiry || ''}` === k && Math.abs(num(r.l.qty) - over) <= Math.max(5, over * 0.02));
      if (!x) continue;
      const short = [...erp.keys()].filter((e2) => e2 !== k && e2.startsWith(code + '|')).map((e2) => ({ e2, d: erp.get(e2) - (jr0.get(e2) || 0) })).filter((y) => y.d > 0).sort((a, b) => b.d - a.d)[0];
      if (!short) continue;
      const to = short.e2.split('|')[1];
      notes.push(`버퍼 ${x.ci + 1}: ${nm(code)} ${n(num(x.l.qty))}개 소비기한 ${md(x.l.expiry)} → ${md(to)} (${md(x.l.expiry)} 전산 합계 ${n(e)}보다 많아서 · 글씨 확인)`);
      out[x.ci].lines[x.li].expiry = to; out[x.ci].lines[x.li]._moved = true; // 수량이 넘친 분량과 같아서 옮긴 줄 → 수량은 맞는 것으로 보고 아래 수량 조정에서 뺌
      jr0.set(k, (jr0.get(k) || 0) - num(x.l.qty)); jr0.set(short.e2, (jr0.get(short.e2) || 0) + num(x.l.qty));
    }
  }
  // 2) 수량: 품목·소비기한 합계가 전산과 다르면(전산의 20% 이내) 숫자를 가장 적게 바꾸는 줄 하나를 고침
  const jr = jrMap();
  for (const [k, e] of erp) {
    const j = jr.get(k) || 0; const [code, exp] = k.split('|');
    if (!j) { notes.push(`전산에만 있음: ${nm(code)} ${md(exp)} ${n(e)}개 — 일지에 줄이 빠졌는지 확인`); continue; }
    const diff = j - e; if (Math.abs(diff) < 0.5) continue;
    const all = refs().filter((x) => `${x.l.productCode}|${x.l.expiry || ''}` === k && num(x.l.qty) - diff > 0);
    const xs = all.filter((x) => !x.l._moved).length ? all.filter((x) => !x.l._moved) : all;
    // 자릿수를 하나 더/덜 읽은 숫자(예: 492를 4492로)는 한 자리만 지우거나 넣으면 전산 합계와 딱 맞을 때 고침 (v242)
    const one = xs.find((x) => digitInsDel(num(x.l.qty), num(x.l.qty) - diff));
    if (one && Math.abs(diff) > Math.max(5, e * 0.2)) { const from = num(one.l.qty); out[one.ci].lines[one.li].qty = String(from - diff); notes.push(`버퍼 ${one.ci + 1}: ${nm(code)} ${md(exp)} ${n(from)} → ${n(from - diff)} (자릿수 하나 차이 · 전산 합계 ${n(e)} 기준 · 글씨 확인)`); continue; }
    if (Math.abs(diff) > Math.max(5, e * 0.2) || !xs.length) { notes.push(`${nm(code)} ${md(exp)}: 일지 ${n(j)} / 전산 ${n(e)} (${diff > 0 ? '+' : ''}${n(diff)}) — 차이가 커서 그대로 둠, 확인`); continue; }
    const dd = (x) => digitDiff(num(x.l.qty), num(x.l.qty) - diff);
    xs.sort((a, b) => dd(a) - dd(b) || num(b.l.qty) - num(a.l.qty)); // 숫자를 가장 적게 바꾸는 줄, 같으면 큰 줄
    const x = xs[0]; const from = num(x.l.qty); const to = from - diff;
    const others = xs.slice(1).filter((y) => dd(y) === dd(x)).map((y) => `버퍼 ${y.ci + 1} ${n(num(y.l.qty))}`);
    out[x.ci].lines[x.li].qty = String(to);
    notes.push(`버퍼 ${x.ci + 1}: ${nm(code)} ${md(exp)} ${n(from)} → ${n(to)} (전산 합계 ${n(e)} 기준 · 글씨 확인${others.length ? ` · 다른 후보: ${others.join(', ')}` : ''})`);
  }
  for (const c of out) for (const l of c.lines) delete l._moved;
  return { cols: out, notes };
}
// ---------- 수기 일지 초안의 유청 사용 LOT·면포를 그 날 유청분리 반출에 맞춤 (v242) ----------
/** 그 날 그 설비로 유청분리에서 반출한 배정 대기 면포 (먼저 등록된 정식 배치에 붙은 반출 포함 — 최종 저장 때 일지로 다시 연결됨) */
export function pendingMovesOf(state, date, fillerId) {
  const repl = new Set(state.batches.filter((b) => b.date === date && b.fillerId === fillerId && !b.journal && !b.erpDraft).map((b) => b.id));
  return state.separations.filter((m) => m.kind === 'move' && m.fillerId === fillerId && m.date === date && (!m.batchId || repl.has(m.batchId)));
}
/** cols의 유청 LOT·면포 수를 반출 기준으로 고침 → { cols, notes }. 반출이 없으면 그대로.
 *  1) 반출이 없는 LOT 줄 → 같은 탱크에 남은 반출 LOT가 하나면 그쪽, 없으면 남은 면포 수가 같은 반출 LOT가 하나뿐일 때 그쪽 (탱크 번호 오독)
 *  2) LOT별 면포 합계가 반출과 다르면: 빈 칸 하나에 남은 분량을 넣거나, 차이가 작으면(2포 또는 25% 이내) 숫자를 가장 적게 바꾸는 줄 하나를 고침 */
export function wheyAdjustCols(state, cols, date, fillerId) {
  const mv = pendingMovesOf(state, date, fillerId);
  if (!mv.length) return { cols, notes: [] };
  const notes = [];
  const out = cols.map((c) => ({ ...c, whey: c.whey.map((w) => ({ ...w })) }));
  const cul = (id) => state.cultures.find((x) => x.id === id);
  const lotOf = (id) => { const c = cul(id); return c ? c.lot : id; };
  const tankName = (tid) => { const t = (state.settings.tanks || []).find((x) => x.id === tid); return t ? t.name : tid === PRESS ? '필터프레스' : tid; };
  const moved = new Map(); const pressIds = new Set();
  for (const m of mv) { moved.set(m.cultureId, (moved.get(m.cultureId) || 0) + num(m.cloths)); if (m.source === 'press') pressIds.add(m.cultureId); }
  // 탱크·LOT·면포 중 하나라도 적힌 줄 (탱크 빈칸에 면포만 적힌 줄도 포함)
  const rows = () => out.flatMap((c, ci) => c.whey.map((w, wi) => ({ ci, wi, w })).filter((x) => x.w.cultureId || x.w.tankId || num(x.w.cloths) > 0));
  const usedMap = () => { const m = new Map(); for (const x of rows()) if (x.w.cultureId) m.set(x.w.cultureId, (m.get(x.w.cultureId) || 0) + num(x.w.cloths)); return m; };
  const leftOf = (cid, u) => Math.round((moved.get(cid) - (u.get(cid) || 0)) * 10) / 10;
  const fmt = (v) => n(v, Number.isInteger(v) ? 0 : 1);
  const label = (w) => (w.cultureId ? lotOf(w.cultureId) : w.tankId ? `${tankName(w.tankId)} (LOT 없음)` : '탱크 빈칸');
  const setLot = (x, to, why) => { const c = cul(to); const from = label(x.w); out[x.ci].whey[x.wi].cultureId = to; if (x.w.tankId !== PRESS && c) out[x.ci].whey[x.wi].tankId = c.tankId; notes.push(`버퍼 ${x.ci + 1}: ${from} → ${lotOf(to)} (이 날 유청분리 반출 기준 · ${why} 확인)`); };
  // 1) 반출이 없는 LOT 줄: 같은 탱크에 남은 반출 LOT가 하나 → 그쪽 / 아니면 남은 면포 수가 줄의 면포 수와 같은 LOT가 하나 → 그쪽(탱크 번호 오독)
  const unmatched = [];
  for (const x of rows()) {
    if (x.w.cultureId && moved.has(x.w.cultureId)) continue;
    const u = usedMap(); const isP = x.w.tankId === PRESS;
    const left = [...moved.keys()].filter((cid) => leftOf(cid, u) > 0.05 && (isP ? pressIds.has(cid) : true));
    const same = isP ? left : x.w.tankId ? left.filter((cid) => { const c = cul(cid); return c && c.tankId === x.w.tankId; }) : [];
    if (same.length === 1) { setLot(x, same[0], isP ? '필터프레스 반출' : '같은 탱크'); continue; }
    const q = num(x.w.cloths);
    const fit = q > 0 ? left.filter((cid) => Math.abs(leftOf(cid, u) - q) < 0.5) : [];
    if (!same.length && fit.length === 1) { setLot(x, fit[0], x.w.tankId ? '탱크 번호 글씨' : '탱크 빈칸'); continue; }
    unmatched.push(x);
  }
  // 1-2) LOT 사이 오독(예: 11번 탱크를 1번으로): 반출보다 많이 적은 LOT의 줄 중 면포 수가 넘친 분량과 같고, 같은 분량이 모자란 LOT가 하나면 그 줄을 옮김
  {
    const u = usedMap();
    for (const cid of [...moved.keys()]) {
      const over = -leftOf(cid, u); if (over < 0.5) continue;
      const short = [...moved.keys()].filter((c2) => c2 !== cid && Math.abs(leftOf(c2, u) - over) < 0.5);
      const xs = rows().filter((x) => x.w.cultureId === cid && Math.abs(num(x.w.cloths) - over) < 0.5);
      if (short.length === 1 && xs.length >= 1) { setLot(xs[xs.length - 1], short[0], '탱크 번호 글씨'); u.set(cid, (u.get(cid) || 0) - over); u.set(short[0], (u.get(short[0]) || 0) + over); }
    }
  }
  // 1-3) 아직 반출에 없는 줄이 남았는데, 면포가 남은 반출 LOT가 딱 하나면 그쪽으로
  for (const x of unmatched) {
    if (x.w.cultureId && moved.has(x.w.cultureId)) continue;
    const u = usedMap(); const isP = x.w.tankId === PRESS;
    const left = [...moved.keys()].filter((cid) => leftOf(cid, u) > 0.05 && (isP ? pressIds.has(cid) : true));
    if (left.length === 1) setLot(x, left[0], '남은 반출이 이 LOT뿐 · 탱크·배출일');
    else notes.push(`버퍼 ${x.ci + 1}: ${label(x.w)}는 이 날 유청분리 반출에 없음 — 탱크·배출일 확인`);
  }
  // 2) 면포 수: 최종 저장은 LOT별 합계가 반출과 같아야 하므로 합계를 반출에 맞춤
  //    줄이 하나뿐 → 반출 수 / 빈칸 하나 → 남은 수 / 여러 줄 → 숫자 한 자리만 바꾸면 되는 줄이 하나뿐일 때만 고침 (아니면 후보만 적음)
  const u = usedMap();
  for (const [cid, m] of moved) {
    const xs = rows().filter((x) => x.w.cultureId === cid);
    if (!xs.length) { notes.push(`유청분리 반출에만 있음: ${lotOf(cid)} ${fmt(m)}포 — 일지에 줄이 빠졌는지 확인`); continue; }
    const j = u.get(cid) || 0; const diff = Math.round((m - j) * 10) / 10; if (Math.abs(diff) < 0.05) continue;
    const blanks = xs.filter((x) => !num(x.w.cloths));
    // 줄이 하나뿐이어도 빈칸이거나, 한 자리만 다르거나(17↔13), 한 자리를 빼먹은 듯하거나(4↔45), 차이가 작을 때만 고침 (6→38처럼 크게 다르면 줄 자체가 잘못일 수 있어 그대로)
    const plausible = (a) => !a || digitDiff(a, m) === 1 || digitInsDel(a, m) || Math.abs(m - a) <= Math.max(2, m * 0.25);
    if (xs.length === 1 && plausible(num(xs[0].w.cloths))) { const x = xs[0]; const from = num(x.w.cloths); out[x.ci].whey[x.wi].cloths = String(m); notes.push(`버퍼 ${x.ci + 1}: ${lotOf(cid)} 면포 ${from ? fmt(from) : '빈칸'} → ${fmt(m)}포 (이 LOT 반출 ${fmt(m)}포 기준 · 글씨 확인)`); continue; }
    if (blanks.length === 1 && diff > 0) { out[blanks[0].ci].whey[blanks[0].wi].cloths = String(diff); notes.push(`버퍼 ${blanks[0].ci + 1}: ${lotOf(cid)} 면포 빈칸 → ${fmt(diff)}포 (반출 ${fmt(m)}포 중 남은 분량 · 확인)`); continue; }
    const where = xs.map((x) => `버퍼 ${x.ci + 1} ${num(x.w.cloths) ? fmt(num(x.w.cloths)) : '빈칸'}`).join(', ');
    const cand = blanks.length ? [] : xs.filter((x) => num(x.w.cloths) + diff > 0 && digitDiff(num(x.w.cloths), num(x.w.cloths) + diff) === 1);
    if (cand.length === 1 && Math.abs(diff) <= Math.max(2, m * 0.25)) {
      const x = cand[0]; const from = num(x.w.cloths); const to = Math.round((from + diff) * 10) / 10;
      out[x.ci].whey[x.wi].cloths = String(to);
      notes.push(`버퍼 ${x.ci + 1}: ${lotOf(cid)} 면포 ${fmt(from)} → ${fmt(to)}포 (반출 합계 ${fmt(m)}포 기준 · 글씨 확인)`);
    } else notes.push(`${lotOf(cid)} 면포: 일지 ${fmt(j)}포 / 반출 ${fmt(m)}포 (${diff > 0 ? '-' : '+'}${fmt(Math.abs(diff))}) — 어느 줄인지 몰라 그대로 둠 (${where})`);
  }
  return { cols: out, notes };
}
/** 사진 읽기 프롬프트에 넣을 참고값 (한 장 읽기처럼 설비·날짜를 미리 알 때): ERP 충진실적 + 유청분리 반출 */
function erpHintText(state, date, fillerId) {
  let s = '';
  const erp = erpQtyMap(state, date, fillerId);
  if (erp.size) {
    const rows = [...erp].map(([k, q]) => { const [code, exp] = k.split('|'); const p = productOf(state, code); return `${shortName(p ? p.name : code)} 소비기한 ${exp ? `${+exp.slice(5, 7)}.${+exp.slice(8, 10)}` : '?'} 합계 ${q}`; });
    s += `\n- 참고: 이 날 이 설비의 전산(ERP) 충진실적 합계입니다. 손글씨 숫자·소비기한이 애매하면 이 합계와 맞는 쪽으로 읽으세요. 단, 일지에 없는 줄을 만들지 말고 적힌 줄만 읽으세요: ${rows.join(' / ')}`;
  }
  const mv = pendingMovesOf(state, date, fillerId);
  if (mv.length) {
    const g = new Map();
    for (const m of mv) { const c = state.cultures.find((x) => x.id === m.cultureId); if (!c) continue; const t = (state.settings.tanks || []).find((x) => x.id === c.tankId); const lot = String(c.lot); const k = `${m.source === 'press' ? '필터프레스' : `${t ? t.name.replace(/\D/g, '') : c.tankId}번 탱크`} 배출일 ${+lot.slice(2, 4)}.${+lot.slice(4, 6)}`; g.set(k, (g.get(k) || 0) + num(m.cloths)); }
    s += `\n- 참고: 이 날 이 설비로 유청분리에서 반출한 면포입니다. 탱크 번호·배출일·면포 수가 애매하면 이 목록과 맞는 쪽으로 읽으세요(면포 칸이 비어 있으면 null): ${[...g].map(([k, q]) => `${k} 면포 ${q}포`).join(' / ')}`;
  }
  return s;
}
const DRAFT_PROMPT = (state, fillDate, hint = '') => `다음 사진은 요거트 공장의 손글씨 "생산일지 충진 N호기" 양식입니다(여러 장이면 왼쪽부터, 1장→2장 순서). 양식 구조:
- 맨 위: "생산일지 충진 2호기 - (1)" 처럼 설비 이름과 장 번호, 오른쪽에 "2026 년 11 월 4 일" 생산일.
- 표는 세로로 3개의 열(버퍼)이 나란히 있고, 각 열은 위에서 아래로: [유청 사용 LOT: 발효탱크 번호(예 4T·6T) · 발효실 배출일자(예 11.2) · 면포 수] 여러 줄 → [충진 시간: 시작시간, 종료시간] → [품목·소비기한·수량: 품목명, 소비기한(예 11.16), 수량 ea] 여러 줄 → [중량: 계근량, 폐기량] → [불량 수량].
- 품목 줄의 "ㄱ", "〃", "''" 같은 표시는 바로 위 줄과 같은 품목이라는 뜻입니다. 빈 열(아무것도 안 적힌 열)은 빼세요. "/"만 그어진 칸은 빈 칸입니다.
- 유청 사용 LOT 줄에 발효탱크 대신 "필터", "필터T", "필터프레스"라고 적혀 있으면 tank를 "필터프레스"로 쓰고, 그 줄의 숫자는 면포 수가 아니라 kg이므로 "kg" 필드에 넣으세요(예: 필터T 10/27 222kg → {"tank":"필터프레스","dischargeDate":"10.27","kg":222}).
- 품목명은 아래 목록 중 가장 가까운 것으로 적으세요: ${state.products.filter((p) => p.fillList).map((p) => shortName(p.name)).join(', ')}
- 손글씨 줄임말: "플.서"·"플서" = 서울 플레인 100g, "플.콩"·"플콩" = 플콩 100g, "배민" = 배민 플레인 100g, "곰곰" = 곰곰 플콩 100g, "소.서" = 서울 소프트 100g, "소콩" = 소콩 100g, "알룰" = 알룰로스 100g, "서울 더진한" = 서울 더진한 450g. 용량이 안 적혀 있으면 1~4호기·로타리·반자동은 100g, 3호기 플레인/소프트는 450g·500g 중 적힌 대로.
- 발효탱크 번호는 숫자만(4T → 4). 날짜는 적힌 그대로("11.2", "11.16"). 시간은 "07:40" 형식. 숫자는 숫자로, 못 읽는 값은 null.${hint}
생산일은 ${fillDate} 입니다(사진의 날짜가 다르면 "date"에 사진 날짜를 YYYY-MM-DD로). 제목의 "(1)", "(2)" 또는 "4-2" 같은 장 번호는 "page"에 숫자로(없으면 1). "filler"는 제목의 설비 이름(1호기·2호기·3호기·4호기·로타리·반자동 등).
다음 JSON 객체 하나만 답하세요(설명 없이). 사진이 여러 장이어도 배열이 아니라 객체 하나로 답하고, 모든 장의 열을 "columns"에 장 순서대로 이어 넣으세요(page는 첫 장 번호):
{"filler":"2호기","date":"${fillDate}","page":1,"columns":[{"whey":[{"tank":4,"dischargeDate":"11.2","cloths":4}],"start":"07:40","end":"09:22","lines":[{"product":"배민 플레인 100g","expiry":"11.16","qty":2520}],"inputKg":984,"wasteKg":160,"defectEa":10}]}`;
/** Claude 답(원문)에서 JSON 하나를 최대한 건져냄: 코드펜스·앞뒤 설명 제거, 꼬리 쉼표 제거, 잘린 답은 괄호를 닫아 봄. 실패하면 null */
export function parseDraftText(text) {
  let t = String(text || '').trim();
  if (!t) return null;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1];
  const a = t.indexOf('{'); if (a < 0) return null;
  const b = t.lastIndexOf('}');
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  const clean = (s) => s.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"');
  let v = b > a ? tryParse(clean(t.slice(a, b + 1))) : null;
  if (v) return v;
  // 잘린 답: 열린 문자열·괄호를 닫아서 다시
  let s = t.slice(a).replace(/,\s*$/, '');
  const stack = []; let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']'); else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) s += '"';
  s = s.replace(/[,:]\s*$/, (m) => m[0] === ':' ? ':null' : '');
  s += stack.reverse().join('');
  return tryParse(clean(s));
}
/** Claude 답을 {filler, date, page, columns[]} 한 개로 맞춤.
 *  여러 장을 올리면 장별 객체 배열([{page:1,columns:[..]}, ..])이나 {"pages":[..]}, 열 배열만, 한 겹 더 싸인 {"result":{..}} 꼴로 오기도 해서
 *  모두 받아 열을 장 순서대로 합침. 표를 못 찾으면 null */
export function normalizeDraft(v) {
  if (typeof v === 'string') v = parseDraftText(v);
  if (!v || typeof v !== 'object') return null;
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  let list = Array.isArray(v) ? v : Array.isArray(v.pages) ? v.pages : Array.isArray(v.columns) ? [v] : null;
  if (!list) {
    const inner = Object.values(v).find((x) => Array.isArray(x) || (isObj(x) && (Array.isArray(x.columns) || Array.isArray(x.pages))));
    return inner ? normalizeDraft(inner) : null;
  }
  const pages = list.filter(isObj);
  if (!pages.length) return null;
  const sorted = pages.every((p) => p.page != null && p.columns) ? [...pages].sort((a, b) => num(a.page) - num(b.page)) : pages;
  let columns = sorted.flatMap((p) => Array.isArray(p.columns) ? p.columns : []);
  if (!columns.length && sorted.some((p) => p.whey || p.lines)) columns = sorted; // columns 없이 열만 배열로 온 경우
  const head = sorted.find((p) => p.filler || p.date) || sorted[0];
  return { filler: isObj(v) && v.filler != null ? v.filler : head.filler, date: isObj(v) && v.date ? v.date : head.date, page: isObj(v) && v.page != null ? v.page : head.page, columns: columns.filter(isObj) };
}
/** 사진 초안 진행·실패를 공유 저장소(logs)에 남김 — 사용자가 오류를 못 옮겨 적어도 개발자가 볼 수 있게. 실패해도 조용히 넘어감 */
async function logEvent(kind, data) {
  try { await save('logs', { id: uid(), at: new Date().toISOString(), kind, ua: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 160) : '', ...data }); } catch { /* 기록 실패는 무시 */ }
}
/** 사진 읽기 실패 사유를 사용자 문구로 */
export function sampleErrorText(e) {
  const code = e && e.code;
  if (code === 'not_granted' || code === 'sampling_disabled') return '이 화면에서 Claude 사용이 허용되지 않았습니다. 처음 누를 때 뜨는 "Claude 사용 허용" 창에서 허용해야 합니다. (화면 오른쪽 위 공유/권한 메뉴에서 다시 켤 수 있습니다)';
  if (code === 'invalid_json') return '일지는 읽었지만 답을 표로 정리하지 못했습니다. 아래 "원문으로 다시 정리"를 눌러 보거나, 더 밝고 똑바로 찍은 사진으로 다시 시도하세요.';
  if (code === 'image_rejected') return '사진 파일을 쓸 수 없습니다 (형식·크기). JPG/PNG로 다시 저장하거나 다른 사진으로 시도하세요.';
  if (code === 'images_unavailable') return '이 보기에서는 사진을 Claude에 보낼 수 없습니다. claude.ai 안에서 연 페이지인지, 최신 앱인지 확인하세요.';
  if (code === 'rate_limited') return '지금은 Claude 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.';
  if (code === 'session_expired') return 'claude.ai 로그인이 풀렸습니다. 다시 로그인한 뒤 새로고침하세요.';
  if (code === 'refused') return 'Claude가 이 사진 읽기를 거절했습니다. 일지 부분만 나오게 다시 찍어 보세요.';
  if (code === 'empty_completion') return 'Claude가 아무 답도 쓰지 않았습니다. 사진을 한 장씩 올려 보세요.';
  if (code === 'prompt_too_large') return '보내는 내용이 너무 큽니다. 사진 수를 줄여 보세요.';
  if (code === 'no_columns') return 'Claude 답에서 일지 표를 찾지 못했습니다. 아래 원문을 확인하고 "원문으로 다시 정리"를 누르거나, 사진을 1~2장씩 나눠 올려 보세요.';
  if (code === 'upstream_error') return 'Claude 연결이 중간에 끊겼습니다. 잠시 후 다시 시도하세요.';
  return `사진 읽기에 실패했습니다: ${(e && e.message) || e}`;
}
// ---------- PDF 일지 → 장마다 JPEG ----------
// Claude 사진 읽기(sample images)는 JPEG/PNG/WebP/GIF만 받음 → PDF는 브라우저에서 pdf.js로 장마다 그려 JPEG로 바꿔 보냄
// pdf.js는 PDF를 올릴 때만 cdnjs에서 불러옴 (첫 화면 로딩에 영향 없음)
const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsLoading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsLoading) pdfjsLoading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = PDFJS_BASE + 'pdf.min.js'; s.async = true;
    s.onload = () => { const L = window.pdfjsLib; if (!L) { pdfjsLoading = null; rej(new Error('PDF 읽기 라이브러리를 불러오지 못했습니다')); return; } L.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js'; res(L); };
    s.onerror = () => { pdfjsLoading = null; rej(new Error('PDF 읽기 라이브러리를 불러오지 못했습니다 (인터넷 연결 확인)')); };
    document.head.appendChild(s);
  });
  return pdfjsLoading;
}
const isPdf = (f) => !!f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
/** PDF 한 개 → 장마다 JPEG File (긴 변 1600px, 흰 배경). 이름은 "원본 p01.jpg"처럼 장 순서대로 */
async function pdfToImages(file, max = 1600) {
  const L = await loadPdfJs();
  const doc = await L.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const base = String(file.name || 'PDF').replace(/\.pdf$/i, '');
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: max / Math.max(v1.width, v1.height) });
    const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
    // intent 'print': 화면 갱신(requestAnimationFrame)을 기다리지 않고 그림 → 탭이 뒤에 있어도 멈추지 않음
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.88));
    if (blob) out.push(new File([blob], `${base} p${String(i).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
    page.cleanup();
  }
  try { await doc.destroy(); } catch { /* ignore */ }
  return out;
}
/** 올린 파일 중 PDF는 장마다 사진으로 펼침 (사진은 그대로) */
export async function expandPdfs(files) {
  const out = [];
  for (const f of files) { if (isPdf(f)) out.push(...await pdfToImages(f)); else out.push(f); }
  return out;
}

/** 사진을 긴 변 1600px JPEG로 줄여서 보냄 (용량·속도) */
async function shrinkImage(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (sc >= 1 && file.size < 2_000_000) return file;
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return await new Promise((r) => cv.toBlob((b) => r(b || file), 'image/jpeg', 0.88));
  } catch { return file; }
}

export function JournalPage({ state, params, go }) {
  const s = state.settings;
  const fillers = (s.fillers || []).filter(isJournalFiller); // 11월부터 1~4호기·로타리·반자동만 여기서 입력. 벌크·드링크는 충진/포장 실적에서
  const [fillerId, setFillerId] = useState(params.fillerId || (fillers[0] ? fillers[0].id : ''));
  const [date, setDate] = useState(params.date || addDays(today(), -1));
  const [cols, setCols] = useState(() => [newCol()]);
  const [busy, setBusy] = useState(false);
  const filler = fillerOf(state, fillerId);
  // 이 설비·날짜는 기존 충진/포장 실적을 씀 → 최종 저장 막음 (저장하면 기존 배치가 지워지므로)
  const fillDay = !journalOnly(state, fillerId, date);
  const pressByTank = useMemo(() => Object.fromEntries((s.tanks || []).map((t) => [t.id, canPress(state, t.id)])), [state]);

  const stocks = useMemo(() => state.cultures.map((c) => ({ c, stock: cultureStock(state, c.id) })), [state]);
  const stockOf = (id) => stocks.find((x) => x.c.id === id);
  const defaultKgPer = num(s.pressKgPerCloth) || 51.5;
  const kgPerOf = (st) => st.stock.kgPerCloth || (st.stock.hasPress ? st.stock.pressKgPerCloth : 0) || defaultKgPer;
  const pressKgPerOf = (st) => (st.stock.hasPress && st.stock.pressKgPerCloth) || defaultKgPer; // 필터프레스 면포 포당 kg
  // 필터프레스 줄의 면포 수 (예전에 kg로 적은 줄은 포당 kg로 환산)
  const pressClothsOf = (w) => { const c = calc(w.cloths); if (c > 0) return c; const k = calc(w.kg); if (!(k > 0)) return 0; const st = stockOf(w.cultureId); return Math.round(k / (st ? pressKgPerOf(st) : defaultKgPer) * 10) / 10; };
  // 유청분리에서 이 설비로 반출했지만 아직 배치에 안 들어간 면포(배정 대기). 저장할 때 열의 같은 LOT에 자동으로 연결돼 재고가 두 번 빠지지 않음.
  // 충진일에 반출한 것을 먼저, 그 다음 오래된 반출부터
  const moveDay = (m) => m.fillDate || m.date;
  // 그날 그 설비에 충진/포장 실적(또는 엑셀)으로 먼저 넣어 둔 배치: 충진일지를 최종 저장하면 자동으로 삭제되고(제품 LOT 포함),
  // 그 배치에 연결돼 있던 반출은 일지 배치에 다시 연결됨 (남는 분량은 배정 대기로). 그래서 그 반출도 '쓸 수 있는 면포'로 셈
  const replaceable = useMemo(() => state.batches.filter((b) => b.date === date && b.fillerId === fillerId && !b.journal && !b.erpDraft), [state, date, fillerId]);
  const replaceableIds = useMemo(() => new Set(replaceable.map((b) => b.id)), [replaceable]);
  // 이 설비로, 유청분리 반출일이 일지 날짜와 같은 배정 대기분만 (다른 날 반출분은 그 날짜 일지에서 씀)
  const pendingFor = useMemo(() => state.separations.filter((m) => m.kind === 'move' && (!m.batchId || replaceableIds.has(m.batchId)) && m.fillerId === fillerId && m.date === date).map((m) => ({ ...m, culture: state.cultures.find((c) => c.id === m.cultureId) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date))), [state, fillerId, date, replaceableIds]);
  const pendingCloths = (cultureId) => sum(pendingFor.filter((m) => m.cultureId === cultureId), (m) => m.cloths);
  // 이 설비가 쓸 수 있는 면포 = 이 설비로 반출된 대기분 + 아직 반출되지 않은 재고 (다른 설비로 반출된 것은 제외) → 넘으면 저장 안 됨 (면포 재고 연동)
  const availOf = (st) => pendingCloths(st.c.id) + Math.max(0, st.stock.remaining);
  // 예외: 10/29 1호기는 면포 재고와 상관없이 입력·저장 (사용자 요청 11/6)
  const noStockCheck = date === '2026-10-29' && /1호기/.test((filler && filler.name) || '');
  // 배양 LOT 후보: 탱크별로 충진일 이전에 배출됐고 이 설비가 쓸 수 있는 면포가 남은 LOT, 최근 배출 먼저
  // (이미 열에 고른 LOT는 면포가 남지 않았어도 목록에 남김 — 저장 뒤에도 그대로 보이게)
  const pickedIds = new Set(cols.flatMap((c) => c.whey).map((w) => w.cultureId).filter(Boolean));
  const cultureOpts = (tankId) => stocks.filter((x) => (tankId === PRESS ? num(x.c.pressL) > 0 : x.c.tankId === tankId) && x.c.date <= date && (noStockCheck || availOf(x) > 0 || pickedIds.has(x.c.id))).sort((a, b) => String(b.c.lot).localeCompare(String(a.c.lot))).slice(0, 12);
  // 이 화면 안에서 같은 LOT를 여러 열(탱크 줄·필터프레스 줄)에 나눠 쓸 수 있으므로, 재고 검사는 화면 전체 합으로. 필터프레스 줄은 kg→포 환산이라 1포 여유
  const usedAll = (cultureId) => sum(cols.flatMap((c) => c.whey).filter((w) => w.cultureId === cultureId), (w) => (w.tankId === PRESS ? pressClothsOf(w) : calc(w.cloths)));
  const overOf = (cultureId) => { if (savedMode || noStockCheck) return false; const st = stockOf(cultureId); if (!st) return false; return usedAll(cultureId) > availOf(st) + 0.001; };

  const products = useMemo(() => state.products.filter((p) => p.fillList).sort((a, b) => ((a.sort ?? 9999) - (b.sort ?? 9999)) || String(a.name).localeCompare(String(b.name), 'ko')), [state.products]);
  const fillerCode = filler.code || '';
  const expiryOf = (l) => { if (l.expiry) return l.expiry; const p = productOf(state, l.productCode); return p && p.shelfDays ? addDays(date, num(p.shelfDays)) : ''; };
  const lotOf = (l) => l.productCode ? productLot(s.productLotDateBase === 'fill' ? date : expiryOf(l), date, fillerCode) : '';
  const mixOf = (col) => { if (col.mixType) return col.mixType; const p = col.lines.map((l) => productOf(state, l.productCode)).find((x) => x && x.mixType); return p ? p.mixType : '플레인'; };

  // 그날 그 설비에 이미 있는 배치 (정식 / 전산 임시)
  const dayBatches = useMemo(() => state.batches.filter((b) => b.date === date && b.fillerId === fillerId), [state, date, fillerId]);
  const drafts = dayBatches.filter((b) => b.erpDraft);
  const formal = dayBatches.filter((b) => !b.erpDraft);
  const draftPacks = useMemo(() => state.packs.filter((p) => drafts.some((b) => b.id === p.batchId)).map((p) => ({ p, product: productOf(state, p.productCode) })), [state, drafts.map((b) => b.id).join()]);
  // 설비·날짜를 바꾸면 열을 비움. 사진 초안이 설비·날짜까지 바꾼 경우는 그 초안으로 채움
  const pendingCols = useRef(null);
  // 최종 저장된 일지를 보는 중(읽기 전용): 저장해도 내용이 사라지지 않고 그대로 남음. 고치려면 '저장 취소'
  const [savedMode, setSavedMode] = useState(false);
  useEffect(() => {
    if (pendingCols.current) { setCols(pendingCols.current); pendingCols.current = null; setSavedMode(false); return; }
    // 그 설비·날짜의 임시저장본이 있으면 바로 불러옴. 없고 최종 저장된 일지가 있으면 그 내용을 읽기 전용으로 보여줌
    const j = (state.journals || []).find((x) => x.fillerId === fillerId && x.date === date && x.status !== 'saved');
    const sj = !j && (state.journals || []).find((x) => x.fillerId === fillerId && x.date === date && x.status === 'saved' && x.cols && x.cols.length && state.batches.some((b) => b.journal && b.fillerId === fillerId && b.date === date));
    const src = j || sj;
    setCols(src && src.cols && src.cols.length ? src.cols.map((c) => ({ ...newCol(), ...c, key: c.key || uid() })) : [newCol()]);
    setSavedMode(!!sj);
  }, [fillerId, date]);

  // ---- 일지 사진 → 초안: sample(images) 기능이 있는 보기(claude.ai 안)에서만 버튼이 보임 ----
  const [ai, setAi] = useState(null);         // { fn, accept }
  const [aiBusy, setAiBusy] = useState('');   // 진행 문구
  const [aiNotes, setAiNotes] = useState(null); // 초안 확인 사항
  const [aiErr, setAiErr] = useState(null);     // 마지막 실패 { code, message, text, files } — 토스트는 3초면 사라져서 배너로 남김
  const [aiSec, setAiSec] = useState(0);        // 읽는 중 경과 초
  const aiCtl = useRef(null);
  useEffect(() => { if (!aiBusy) { setAiSec(0); return; } const t0 = Date.now(); const id = setInterval(() => setAiSec(Math.round((Date.now() - t0) / 1000)), 1000); return () => clearInterval(id); }, [aiBusy]);
  useEffect(() => { (async () => {
    try { if (!window.claude || typeof window.claude.use !== 'function') return; const fn = await window.claude.use('sample'); if (!fn) return; const lim = await fn.limits().catch(() => null); if (!lim || !lim.images) return; setAi({ fn, accept: lim.images.mediaTypes.join(','), max: lim.images.maxCount }); } catch { /* 없음 */ }
  })(); }, []);
  // ---- 임시저장본(journals): 사진 묶음에서 만든 초안이나 손으로 적다 만 열을 설비·날짜별로 저장해 두고, 검수 후 최종 저장 ----
  const [loadedDraft, setLoadedDraft] = useState(null); // 지금 화면에 불러온 임시저장본 id
  // 기존 충진/포장 실적을 쓰는 설비·기간(3·4호기·로타리·반자동의 10/23~11/05)의 초안은 목록에서 숨김
  const drafts0 = useMemo(() => (state.journals || []).filter((j) => j.status !== 'saved' && journalOnly(state, j.fillerId, j.date)).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.fillerId).localeCompare(String(b.fillerId))), [state.journals]);
  const draftFor = (fid, dt) => (state.journals || []).find((j) => j.fillerId === fid && j.date === dt && j.status !== 'saved');
  const curDraft = draftFor(fillerId, date);
  useEffect(() => { setLoadedDraft(curDraft ? curDraft.id : null); }, [fillerId, date]);
  const stripCols = (cs) => cs.map((c) => ({ key: c.key, whey: c.whey.map((w) => ({ tankId: w.tankId, cultureId: w.cultureId, cloths: w.cloths, kg: w.kg || '' })), startTime: c.startTime, endTime: c.endTime, lines: c.lines.map((l) => ({ productCode: l.productCode, expiry: l.expiry, qty: l.qty, hint: l.hint || '' })), inputKg: c.inputKg, wasteKg: c.wasteKg, defectEa: c.defectEa, mixType: c.mixType, crew: c.crew || null }));
  const saveDraft = async (opts = {}) => {
    const prev = draftFor(fillerId, date);
    const doc = { ...(prev || { id: uid(), createdAt: new Date().toISOString(), source: 'manual', pages: [], notes: [] }), fillerId, date, cols: stripCols(cols), status: 'draft', updatedAt: new Date().toISOString(), ...opts };
    await save('journals', doc); setLoadedDraft(doc.id);
    if (!opts.silent) toast(`${fmtMD(date)} ${filler.name} 일지를 임시저장했습니다. 검수 후 "최종 저장"을 누르세요.`);
  };
  const loadDraft = (j) => {
    const cs = (j.cols || []).map((c) => ({ ...newCol(), ...c, key: c.key || uid() }));
    if (j.fillerId !== fillerId || j.date !== date) { pendingCols.current = cs; if (j.fillerId !== fillerId) setFillerId(j.fillerId); if (j.date !== date) setDate(j.date); }
    else setCols(cs);
    setSavedMode(false); setLoadedDraft(j.id); setAiNotes(j.notes && j.notes.length ? { cols: cs.length, notes: j.notes, filler: fillerOf(state, j.fillerId).name, date: j.date } : null);
  };
  const deleteDraft = async (j) => { if (!(await confirmAsync(`${fmtMD(j.date)} ${fillerOf(state, j.fillerId).name} 임시저장본을 지울까요?`))) return; await remove('journals', j.id); if (loadedDraft === j.id) setLoadedDraft(null); };
  const [showSaved, setShowSaved] = useState(false);
  const savedDrafts = useMemo(() => (state.journals || []).filter((j) => j.status === 'saved').sort((a, b) => String(b.date).localeCompare(String(a.date))), [state.journals]);
  // 최종 저장 취소: 그 설비·날짜에 생산일지로 만든 배치·반출·제품 LOT를 지우고 임시저장본으로 되돌림 (흡수돼 지워진 전산 임시 배치는 돌아오지 않음)
  const journalBatchesOf = (fid, dt) => state.batches.filter((b) => b.journal && b.fillerId === fid && b.date === dt);
  const unsaveJournal = async (fid, dt) => {
    const bs = journalBatchesOf(fid, dt); const j = (state.journals || []).find((x) => x.fillerId === fid && x.date === dt && x.status === 'saved');
    const packs = state.packs.filter((p) => bs.some((b) => b.id === p.batchId)); const moves = state.separations.filter((m) => m.kind === 'move' && bs.some((b) => b.id === m.batchId));
    if (!bs.length && !j) return;
    const own = moves.filter((m) => m.journalMade || /생산일지 입력/.test(m.note || '')); // 일지가 재고에서 직접 만든 반출 → 삭제. 유청분리 반출을 연결한 것은 배정 대기로 되돌림
    if (!(await confirmAsync(`${fmtDate(dt)} ${fillerOf(state, fid).name} 충진일지 저장을 취소할까요?\n충진 배치 ${bs.length}건 · 제품 LOT ${packs.length}줄이 삭제되고${own.length ? `, 일지가 만든 반출 ${own.length}건도 삭제됩니다` : ''}${moves.length - own.length > 0 ? `, 연결했던 유청분리 반출 ${moves.length - own.length}건은 배정 대기로 돌아갑니다` : ''}. 일지는 임시저장본으로 돌아가 다시 고쳐 저장할 수 있습니다. (저장 때 지워진 전산 임시 배치는 돌아오지 않습니다)`, { ok: '저장 취소' }))) return;
    for (const p of packs) await remove('packs', p.id);
    for (const m of moves) { if (own.includes(m)) await remove('separations', m.id); else await save('separations', { ...m, batchId: null }); }
    for (const b of bs) await remove('batches', b.id);
    if (j) await save('journals', { ...j, status: 'draft', unsavedAt: new Date().toISOString() });
    if (fid === fillerId && dt === date) { setSavedMode(false); setLoadedDraft(j ? j.id : null); }
    toast(`${fmtMD(dt)} ${fillerOf(state, fid).name} 저장을 취소했습니다. 내용은 그대로 남아 있으니 고친 뒤 다시 최종 저장하세요.`);
  };
  const curJournalBatches = journalBatchesOf(fillerId, date);
  // 이미 최종 저장된 날짜·설비의 임시저장본(중복 초안)을 연 경우: 그 날 반출 면포는 저장된 일지 배치에 연결돼 있어 이 초안에선 0포로 보임 (v238)
  const dupSaved = !savedMode && curJournalBatches.length > 0;
  const dupCloths = dupSaved ? sum(state.separations.filter((m) => m.kind === 'move' && curJournalBatches.some((b) => b.id === m.batchId)), (m) => num(m.cloths)) : 0;

  // ---- 일지 묶음 올리기: 사진 여러 장(여러 날·여러 설비) → 장마다 읽어 설비·날짜별 임시저장본으로 ----
  const [bulk, setBulk] = useState(null); // { total, done, ok, fail, cur, log: [] }
  const bulkCtl = useRef(null);
  const fillerFromName = (name) => { const fname = String(name || '').replace(/\s/g, ''); if (!fname) return null; return fillers.find((f) => f.name.replace(/\s/g, '') === fname) || fillers.find((f) => fname.replace(/\D/g, '') && f.name.replace(/\D/g, '') === fname.replace(/\D/g, '')) || fillers.find((f) => fname.includes(f.name.replace(/\s/g, ''))) || null; };
  const scanMany = async (files) => {
    if (!ai || !files || !files.length) return;
    let list;
    try {
      const raw = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (raw.some(isPdf)) toast('PDF를 장마다 사진으로 바꾸는 중입니다…');
      list = await expandPdfs(raw);
    } catch (e) { toast(`PDF를 사진으로 바꾸지 못했습니다: ${(e && e.message) || e}`, 'bad'); logEvent('pdf_fail', { date, files: [...files].map((f) => ({ name: f.name, type: f.type, size: f.size })), message: String((e && e.message) || e).slice(0, 500) }); return; }
    if (!list.length) { toast('PDF에서 읽을 장이 없습니다.', 'bad'); return; }
    if (!(await confirmAsync(`사진 ${list.length}장을 한 장씩 Claude로 읽어 설비·날짜별 임시저장본을 만듭니다. 장당 20~60초, 보는 사람의 Claude 사용량을 씁니다. 중간에 멈춰도 읽은 장까지는 임시저장됩니다. 시작할까요?`, { ok: '시작', danger: false }))) return;
    const ctl = new AbortController(); bulkCtl.current = ctl;
    const st0 = { total: list.length, done: 0, ok: 0, fail: 0, cur: '', log: [] };
    setBulk({ ...st0 });
    for (const f of list) {
      if (ctl.signal.aborted) break;
      st0.cur = f.name; setBulk({ ...st0 });
      try {
        const blob = await shrinkImage(f);
        let d;
        try { d = await ai.fn.json(DRAFT_PROMPT(state, date), { images: [blob], modelTier: 'complex', signal: ctl.signal, cache: false }); }
        catch (e) { const fixed = e && e.code === 'invalid_json' && e.text ? parseDraftText(e.text) : null; if (!fixed) throw e; d = fixed; }
        const dd = normalizeDraft(d) || {};
        const fHit = fillerFromName(dd.filler);
        const dt = typeof dd.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dd.date) ? dd.date : '';
        if (!fHit || !dt) throw { code: 'unmatched', message: `설비(${dd.filler || '?'})·날짜(${dd.date || '?'})를 못 읽음` };
        const page = num(dd.page) || 1;
        let { cols: nc, notes } = draftToCols(state, dd, dt, fHit.id);
        { const a = erpAdjustCols(getState(), nc, dt, fHit.id); nc = a.cols; notes = [...notes, ...a.notes]; } // 애매한 손글씨는 ERP 충진실적 기준으로 (확인 사항에 남김)
        { const a = wheyAdjustCols(getState(), nc, dt, fHit.id); nc = a.cols; notes = [...notes, ...a.notes]; } // 탱크·LOT·면포는 유청분리 반출 기준으로 (v242)
        // 같은 설비·날짜 임시저장본에 장 순서대로 열을 합침 (같은 장을 다시 올리면 그 장만 교체)
        const prev = (getState().journals || []).find((x) => x.fillerId === fHit.id && x.date === dt && x.status !== 'saved'); // 루프 중 최신 저장 상태
        const pages = (prev ? prev.pages || [] : []).filter((p) => p.page !== page);
        pages.push({ page, name: f.name, cols: stripCols(nc), notes });
        pages.sort((a, b) => a.page - b.page);
        const doc = { ...(prev || { id: uid(), createdAt: new Date().toISOString() }), fillerId: fHit.id, date: dt, source: 'photo', status: 'draft', pages, cols: pages.flatMap((p) => p.cols), notes: pages.flatMap((p) => (p.notes || []).map((t) => `${p.page}장 ${t}`)), updatedAt: new Date().toISOString() };
        await save('journals', doc);
        st0.ok++; st0.log.push(`✓ ${f.name} → ${fmtMD(dt)} ${fHit.name} ${page}장 · ${nc.length}열`);
      } catch (e) {
        if (e && e.code === 'cancelled') break;
        console.error('[생산일지 묶음 읽기 실패]', f.name, e);
        logEvent('bulk_fail', { date, files: [{ name: f.name, type: f.type, size: f.size }], code: (e && e.code) || 'error', message: String((e && e.message) || e).slice(0, 500), text: String((e && e.text) || '').slice(0, 3000) });
        st0.fail++; st0.log.push(`✗ ${f.name}: ${e && e.code === 'unmatched' ? e.message : sampleErrorText(e)}`);
        if (e && (e.code === 'not_granted' || e.code === 'sampling_disabled' || e.code === 'rate_limited')) { setBulk({ ...st0, cur: '', stopped: true }); bulkCtl.current = null; toast(e.code === 'rate_limited' ? 'Claude 사용량 제한에 걸려 멈췄습니다. 잠시 후 남은 사진만 다시 올리세요.' : 'Claude 사용이 허용되지 않아 멈췄습니다.', 'bad'); return; }
      }
      st0.done++; setBulk({ ...st0 });
    }
    setBulk({ ...st0, cur: '', stopped: true }); bulkCtl.current = null;
    toast(`일지 ${st0.ok}장을 읽어 임시저장했습니다.${st0.fail ? ` ${st0.fail}장 실패.` : ''} 아래 임시저장 목록에서 날짜·설비를 골라 검수하세요.`);
  };

  // Claude가 돌려준 초안(JSON)을 화면 열로 적용. 사진의 설비·날짜가 화면과 다르면 따라감
  const applyDraft = (d0, nPhotos) => {
    const d = normalizeDraft(d0);
    if (!d || !d.columns.length) throw { code: 'no_columns', message: '답에서 표(columns)를 찾지 못함', text: typeof d0 === 'string' ? d0 : JSON.stringify(d0 == null ? null : d0) };
    setSavedMode(false);
    let fid = fillerId, dt = date;
    const fHit = fillerFromName(d.filler);
    if (fHit) fid = fHit.id;
    if (typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) dt = d.date;
    let { cols: nc, notes } = draftToCols(state, d, dt, fid);
    { const a = erpAdjustCols(state, nc, dt, fid); nc = a.cols; notes = [...notes, ...a.notes]; } // 애매한 손글씨는 ERP 충진실적 기준으로 (확인 사항에 남김)
    { const a = wheyAdjustCols(state, nc, dt, fid); nc = a.cols; notes = [...notes, ...a.notes]; } // 탱크·LOT·면포는 유청분리 반출 기준으로 (v242)
    if (fid !== fillerId || dt !== date) { pendingCols.current = nc; if (fid !== fillerId) setFillerId(fid); if (dt !== date) setDate(dt); }
    else setCols(nc);
    setAiNotes({ cols: nc.length, notes, filler: fHit ? fHit.name : '', date: dt });
    setAiErr(null);
    toast(`일지 ${nPhotos}장에서 ${nc.length}열 초안을 만들었습니다. 사진과 비교해 확인한 뒤 저장하세요.`);
  };
  const lastFiles = useRef([]); // "다시 시도"용
  const readPhotos = async (files) => {
    if (!ai || !files || !files.length) return;
    let all;
    try {
      if ([...files].some(isPdf)) setAiBusy('PDF를 사진으로 바꾸는 중…');
      all = await expandPdfs([...files]);
    } catch (e) { setAiBusy(''); toast(`PDF를 사진으로 바꾸지 못했습니다: ${(e && e.message) || e}`, 'bad'); logEvent('pdf_fail', { fillerId, date, files: [...files].map((f) => ({ name: f.name, type: f.type, size: f.size })), message: String((e && e.message) || e).slice(0, 500) }); return; }
    const list = all.slice(0, ai.max || 4);
    if (all.length > list.length) toast(`한 번에 ${list.length}장까지 읽습니다. 앞 ${list.length}장만 읽고, 나머지는 "일지 묶음 올리기"로 올리세요.`);
    lastFiles.current = list;
    setAiBusy('사진 줄이는 중…'); setAiNotes(null); setAiErr(null);
    const ctl = new AbortController(); aiCtl.current = ctl;
    let raw = ''; const t0 = Date.now();
    const fileMeta = list.map((f) => ({ name: f.name, type: f.type, size: f.size }));
    logEvent('photo_start', { fillerId, date, files: fileMeta });
    try {
      const blobs = []; for (const f of list) blobs.push(await shrinkImage(f));
      setAiBusy(`Claude가 일지 ${list.length}장을 읽는 중`);
      const data = await ai.fn.json(DRAFT_PROMPT(state, date, erpHintText(state, date, fillerId)), { images: blobs, modelTier: 'complex', signal: ctl.signal, cache: false, onText: ({ text }) => { raw = text; setAiBusy('초안 정리 중'); } });
      const d = normalizeDraft(data) || { columns: [] };
      applyDraft(data, list.length);
      logEvent('photo_ok', { fillerId, date, files: fileMeta, sec: Math.round((Date.now() - t0) / 1000), cols: d.columns.length, filler: d.filler, photoDate: d.date, shape: Array.isArray(data) ? `array(${data.length})` : data && typeof data === 'object' ? Object.keys(data).slice(0, 10).join(',') : typeof data });
    } catch (e) {
      const code = e && e.code;
      console.error('[생산일지 사진 초안 실패]', e);
      const text = (e && e.text) || raw;
      logEvent('photo_fail', { fillerId, date, files: fileMeta, sec: Math.round((Date.now() - t0) / 1000), code: code || 'error', message: String((e && e.message) || e).slice(0, 500), text: String(text || '').slice(0, 3000) });
      if (code === 'cancelled') toast('읽기를 취소했습니다.');
      else {
        // 답은 왔는데 JSON 정리만 실패한 경우: 원문에서 직접 건져 봄
        const fixed = code === 'invalid_json' && text ? parseDraftText(text) : null;
        if (fixed) { try { applyDraft(fixed, list.length); toast('답이 깔끔하지 않아 원문에서 정리했습니다. 사진과 더 꼼꼼히 비교하세요.'); } catch (e2) { setAiErr({ code: 'apply', message: String(e2 && e2.message || e2), text, files: list.map((f) => f.name) }); } }
        else setAiErr({ code: code || 'error', message: String((e && e.message) || e), text, files: list.map((f) => f.name) });
      }
    }
    setAiBusy(''); aiCtl.current = null;
  };
  const retryFromText = () => { if (!aiErr || !aiErr.text) return; const v = parseDraftText(aiErr.text); if (!v) { toast('원문에서도 표를 만들지 못했습니다. 사진을 다시 올려 주세요.', 'bad'); return; } try { applyDraft(v, lastFiles.current.length || 1); } catch (e) { toast(`정리 실패: ${e.message || e}`, 'bad'); } };

  const setCol = (i, patch) => setCols((o) => { const r = [...o]; r[i] = { ...r[i], ...(typeof patch === 'function' ? patch(r[i]) : patch) }; return r; });
  const setWhey = (i, j, patch) => setCol(i, (c) => { const whey = [...c.whey]; whey[j] = { ...whey[j], ...patch }; return { whey }; });
  const setLine = (i, j, patch) => setCol(i, (c) => { const lines = [...c.lines]; lines[j] = { ...lines[j], ...patch }; return { lines }; });
  // 필터프레스 줄 기본 면포 수 = 유청분리에서 이 설비로 필터프레스 반출한 면포 중 아직 열에 안 적은 분량
  const pressDefault = (cultureId) => { const g = pendLeft.find((x) => x.cultureId === cultureId && x.press); return g && g.left > 0 ? String(g.left) : ''; };
  // 탱크(또는 필터프레스)를 고르면, 이 설비·날짜로 반출 대기 중이고 아직 덜 적은 LOT를 먼저 고름 → 적는 즉시 "열에 넣을 항목" 칩에서 차감됨
  // (예전엔 목록 첫 LOT가 골라져서, 반출된 LOT와 다르면 칩이 줄지 않았음)
  const pickTank = (i, j, tankId) => { const opts = cultureOpts(tankId); const pend = pendLeft.filter((g) => (tankId === PRESS ? g.press : g.tankId === tankId)).sort((a, b) => Number(a.press) - Number(b.press)); // 탱크 줄: 유청분리실 반출 먼저, 없으면 그 탱크의 FP 반출 LOT
    const first = pend.map((g) => opts.find((o) => o.c.id === g.cultureId)).find(Boolean) || opts[0];
    const cur = (cols[i] && cols[i].whey[j]) || {}; const patch = { tankId, cultureId: first ? first.c.id : '' };
    if (tankId === PRESS) { patch.kg = ''; if (!calc(cur.cloths) && first) patch.cloths = pressDefault(first.c.id); }
    setWhey(i, j, patch); };
  const pickCulture = (i, j, cultureId) => { const cur = (cols[i] && cols[i].whey[j]) || {}; const patch = { cultureId };
    if (cur.tankId === PRESS) { patch.kg = ''; if (!calc(cur.cloths)) patch.cloths = pressDefault(cultureId); }
    setWhey(i, j, patch); };
  const addCol = () => setCols((o) => [...o, newCol()]);
  const removeCol = async (i) => { const c = cols[i]; const has = c.whey.some((w) => w.cultureId) || c.lines.some((l) => l.productCode); if (has && !(await confirmAsync(`버퍼 ${i + 1} 열을 지울까요?`, { ok: '지우기' }))) return; setCols((o) => o.filter((_, j) => j !== i)); };
  // 전산 임시 배치의 품목 줄을 열에 가져오기 (제품·소비기한·수량 그대로)
  const [target, setTarget] = useState(0);
  // 품목·소비기한별로 묶고, 열에 이미 적은 수량을 뺀 남은 수량만 칩으로 보임 (다 적은 줄은 사라짐)
  const packLeft = useMemo(() => {
    const groups = new Map();
    for (const { p, product } of draftPacks) { const key = `${p.productCode}|${p.expiry || ''}`; if (!groups.has(key)) groups.set(key, { key, productCode: p.productCode, expiry: p.expiry || '', product, total: 0, n: 0 }); const g = groups.get(key); g.total += num(p.qty); g.n++; }
    return [...groups.values()].map((g) => { const used = sum(cols.flatMap((c) => c.lines).filter((l) => l.productCode === g.productCode && (!g.expiry || (l.expiry || expiryOf(l)) === g.expiry)), (l) => calc(l.qty)); return { ...g, used, left: g.total - used }; }).filter((g) => g.left > 0);
  }, [draftPacks, cols, date]);
  // ---- 전산 대조: 전산 임시 배치(전산 대조로 넣은 충진실적)와 일지 수량을 제품 LOT(품목·소비기한)별로 비교 ----
  // 전산 임시 배치는 최종 저장 때 지워지므로, 저장 때 전산 수량을 일지 문서(erpCompare)에 남겨 두고 저장 후·저장 취소 후에도 그 값으로 비교
  const curJ = useMemo(() => (state.journals || []).find((x) => x.fillerId === fillerId && x.date === date && (savedMode ? x.status === 'saved' : x.status !== 'saved')), [state.journals, fillerId, date, savedMode]);
  const erpCmp = useMemo(() => {
    const m = new Map();
    const row = (code, exp) => { const k = `${code}|${exp || ''}`; if (!m.has(k)) m.set(k, { key: k, productCode: code, expiry: exp || '', erp: 0, jr: 0 }); return m.get(k); };
    let src = '';
    // 전산 기준 = 전산 임시 배치 + 전산 대조로 들어왔다가 정식으로 바뀐 기존 배치(erpImportedAt, 최종 저장하면 일지 배치로 바뀌며 지워짐)
    const erpIds = new Set([...drafts, ...replaceable.filter((b) => b.erpImportedAt)].map((b) => b.id));
    const erpPacks = state.packs.filter((p) => erpIds.has(p.batchId) && p.kind !== 'repack');
    if (erpPacks.length) { src = 'live'; for (const p of erpPacks) row(p.productCode, p.expiry).erp += num(p.qty); }
    else if (curJ && Array.isArray(curJ.erpCompare) && curJ.erpCompare.length) { src = 'saved'; for (const r of curJ.erpCompare) row(r.productCode, r.expiry).erp += num(r.erp); }
    else return null;
    for (const c of cols) for (const l of c.lines) { if (!l.productCode || !(calc(l.qty) > 0)) continue; row(l.productCode, expiryOf(l)).jr += calc(l.qty); }
    const rows = [...m.values()].map((r) => ({ ...r, product: productOf(state, r.productCode), lot: lotOf({ productCode: r.productCode, expiry: r.expiry }), diff: Math.round((r.jr - r.erp) * 1000) / 1000 }))
      .sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)) || String(a.productCode).localeCompare(String(b.productCode)));
    return { src, rows, at: src === 'saved' ? curJ.erpComparedAt : '' };
  }, [state.packs, drafts.map((b) => b.id).join(), replaceable.map((b) => b.id).join(), cols, curJ, date]);
  const erpDiffs = erpCmp ? erpCmp.rows.filter((r) => Math.abs(r.diff) > 0.001) : [];
  const [erpAll, setErpAll] = useState(false); // 일치하는 줄은 기본 숨김 (v236)
  const erpShown = erpCmp ? (erpAll ? erpCmp.rows : erpDiffs) : [];
  // 면포 대조 (v239): 배양 LOT별로 그 날 이 설비로 유청분리 반출한 면포 vs 일지에 적은 면포.
  // 저장 전에는 배정 대기 반출(pendingFor), 저장 후에는 저장된 일지 배치에 연결된 반출과 비교. 필터프레스는 kg→포 환산이라 1포 미만 차이는 같음으로 봄
  // 저장 후에 그 날 이 설비로 새로 반출한 면포(배치 미연결) — 저장된 일지에는 안 들어가 있으므로 대조표·안내에 따로 보임 (v268)
  const lateMoves = useMemo(() => savedMode ? pendingFor.filter((m) => !m.batchId) : [], [savedMode, pendingFor]);
  const clothCmp = useMemo(() => {
    const src = savedMode ? [...state.separations.filter((m) => m.kind === 'move' && curJournalBatches.some((b) => b.id === m.batchId)), ...lateMoves] : pendingFor;
    const map = new Map();
    const row = (cid) => { if (!map.has(cid)) { const c = state.cultures.find((x) => x.id === cid); map.set(cid, { key: cid, cultureId: cid, lot: c ? c.lot : cid, tankId: c ? c.tankId : '', room: 0, press: 0, late: 0, jr: 0, jrPress: 0, mixMv: new Set(), mixJr: new Set() }); } return map.get(cid); };
    for (const m of src) { const r = row(m.cultureId); if (m.source === 'press') r.press += num(m.cloths); else r.room += num(m.cloths); if (savedMode && !m.batchId) r.late += num(m.cloths); if (m.mixType) r.mixMv.add(m.mixType); }
    for (const c of cols) for (const w of c.whey) {
      if (!w.cultureId) continue; const isP = w.tankId === PRESS; const q = isP ? pressClothsOf(w) : calc(w.cloths); if (!(q > 0)) continue;
      const r = row(w.cultureId); r.jr += q; if (isP) r.jrPress += q; r.mixJr.add(mixOf(c));
    }
    // 재공품 유형: 유청분리 반출에 적힌 유형과 일지 열의 유형 (다르면 둘 다 표시)
    const rows = [...map.values()].map((r) => { const moved = r.room + r.press; const diff = Math.round((r.jr - moved) * 10) / 10; const tol = r.press > 0 || r.jrPress > 0 ? 0.999 : 0.05; const mv = [...r.mixMv].join('·'); const jr = [...r.mixJr].join('·'); return { ...r, moved, diff, bad: Math.abs(diff) > tol, mixMvS: mv, mixJrS: jr, mixDiff: !!(mv && jr && mv !== jr) }; })
      .sort((a, b) => String(a.lot).localeCompare(String(b.lot)));
    return rows;
  }, [savedMode, state.separations, state.cultures, curJournalBatches.map((b) => b.id).join(','), pendingFor, lateMoves, cols]);
  const clothDiffs = clothCmp.filter((r) => r.bad);
  const [clothAll, setClothAll] = useState(false);
  const clothShown = clothAll ? clothCmp : clothDiffs;
  const nc = (v) => { const r = Math.round(v * 10) / 10; return n(r, Number.isInteger(r) ? 0 : 1); };
  const erpLine = (r) => `${shortName(r.product ? r.product.name : r.productCode)} ${r.lot || fmtMD(r.expiry)} — 전산 ${n(r.erp)} / 일지 ${n(r.jr)} (${r.diff > 0 ? '+' : ''}${n(r.diff)})`;
  // 넣을 열: 빈 칸이 있는 첫 버퍼 열, 없으면 마지막 열
  const autoTarget = (kind) => { const i = cols.findIndex((c) => kind === 'line' ? c.lines.some((l) => !l.productCode && !calc(l.qty)) : c.whey.some((w) => !w.cultureId && !calc(w.cloths) && !calc(w.kg))); return i >= 0 ? i : cols.length - 1; };
  const importPack = (g) => setCol(autoTarget('line'), (c) => { const empty = c.lines.findIndex((l) => !l.productCode && !calc(l.qty)); const line = { productCode: g.productCode, expiry: g.expiry, qty: String(g.left) }; const lines = [...c.lines]; if (empty >= 0) lines[empty] = line; else lines.push(line); return { lines }; });
  // 배정 대기 반출을 LOT(·필터프레스 여부)별로 묶고, 열에 이미 적은 분량을 뺀 남은 분량만 칩으로 보임 (다 적은 LOT는 사라짐)
  const usedBy = (cultureId, press) => sum(cols.flatMap((c) => c.whey).filter((w) => w.cultureId === cultureId && (w.tankId === PRESS) === press), (w) => (press ? pressClothsOf(w) : calc(w.cloths)));
  const pendLeft = useMemo(() => {
    const groups = new Map();
    for (const m of pendingFor) { const press = m.source === 'press'; const key = `${m.cultureId}|${press ? 'p' : 'r'}`; if (!groups.has(key)) groups.set(key, { key, cultureId: m.cultureId, press, lot: m.culture ? m.culture.lot : m.cultureId, tankId: m.culture ? m.culture.tankId : '', ms: [], total: 0, kg: 0, mixes: new Set(), day: moveDay(m), old: false }); const g = groups.get(key); g.ms.push(m); g.total += m.cloths; g.kg += num(m.kg); if (m.mixType) g.mixes.add(m.mixType); if (m.batchId) g.old = true; }
    // 최종 저장과 같은 규칙으로 차감: 필터프레스 줄은 FP 반출에서만, 탱크 줄은 같은 LOT의 유청분리실 반출을 먼저 쓰고 넘치는 분량은 FP 반출에서
    // (예: FP 261030T03-01 15포를 "3번 탱크" 줄에 10+2+… 로 적어도 칩이 줄고, 저장 때도 그 FP 반출에 연결됨)
    const totalOf = (cid, press) => { const g = groups.get(`${cid}|${press ? 'p' : 'r'}`); return g ? g.total : 0; };
    const usedOf = (g) => {
      if (!g.press) return usedBy(g.cultureId, false);
      const spill = Math.max(0, usedBy(g.cultureId, false) - totalOf(g.cultureId, false)); // 탱크 줄에 적었지만 유청분리실 반출보다 많은 분량
      return usedBy(g.cultureId, true) + spill;
    };
    return [...groups.values()].map((g) => { const used = usedOf(g); const left = Math.round((g.total - used) * 10) / 10; return { ...g, used, left, mix: [...g.mixes].join('·'), kgPer: g.total > 0 ? g.kg / g.total : 0 }; }).filter((g) => g.left > 0.05);
  }, [pendingFor, cols]);
  // 남은 분량을 열의 유청 LOT 줄로 가져오기 (필터프레스 반출은 필터프레스 줄에 면포 수로)
  const importMove = (g) => setCol(autoTarget('whey'), (c) => {
    const row = { tankId: g.press ? PRESS : g.tankId, cultureId: g.cultureId, cloths: String(g.left), kg: '' };
    const empty = c.whey.findIndex((w) => !w.cultureId && !calc(w.cloths) && !calc(w.kg)); const whey = [...c.whey]; if (empty >= 0) whey[empty] = row; else whey.push(row); return { whey };
  });

  // 열 요약(검증 포함)
  const summarize = (col, i) => {
    const whey = col.whey.filter((w) => w.cultureId && (w.tankId === PRESS ? pressClothsOf(w) > 0 : calc(w.cloths) > 0)).map((w) => {
      const st = stockOf(w.cultureId);
      if (w.tankId === PRESS) { const cloths = pressClothsOf(w); const kgPer = st ? pressKgPerOf(st) : defaultKgPer; return { ...w, st, press: true, cloths, kgPer, kg: Math.round(cloths * kgPer * 10) / 10 }; }
      const cloths = calc(w.cloths); const kgPer = st ? kgPerOf(st) : 0; return { ...w, st, press: false, cloths, kgPer, kg: Math.round(cloths * kgPer * 10) / 10 };
    });
    const lines = col.lines.filter((l) => l.productCode && calc(l.qty) > 0).map((l) => ({ ...l, qty: calc(l.qty), expiry: expiryOf(l), lot: lotOf(l), product: productOf(state, l.productCode) }));
    const problems = []; const warns = [];
    for (const w of whey) {
      if (!w.st) { problems.push('배양 LOT 없음'); continue; }
      // 면포 재고 연동: 이 설비로 반출된 대기분 + 남은 재고를 넘으면 저장 불가 (유청분리에서 소분·반출을 먼저 넣어야 함)
      if (overOf(w.cultureId)) { const msg = `${w.st.c.lot} 면포 부족 — 이 설비가 쓸 수 있는 면포 ${n(availOf(w.st), 1)}포 (유청분리 반출 ${n(pendingCloths(w.st.c.id))}포 + 남은 재고 ${n(Math.max(0, w.st.stock.remaining))}포)${dupSaved ? ' · 이 날 반출은 이미 최종 저장된 일지에 연결됨' : ''}`; if (!problems.includes(msg)) problems.push(msg); }
      if (w.press) { if (!(num(w.st.c.pressL) > 0)) warns.push(`${w.st.c.lot}은 필터프레스 배출이 없는 LOT`); continue; }
      if (!(w.st.stock.kgPerCloth || (w.st.stock.hasPress && w.st.stock.pressKgPerCloth))) warns.push(`${w.st.c.lot} 소분 기록 없음 → 포당 ${n(defaultKgPer, 1)} kg로 계산`);
    }
    for (const l of lines) if (!l.expiry) problems.push(`${shortName(l.product ? l.product.name : l.productCode)} 소비기한 없음`);
    const inputKg = calc(col.inputKg), wasteKg = calc(col.wasteKg), defectEa = calc(col.defectEa);
    const mixType = mixOf(col);
    // 발효유 kg = 면포 × 포당 kg (유청분리 전 무게). 유청분리 후 면포 무게 = 계근량 + 폐기량 → 발효유 수율 = (계근+폐기) ÷ 발효유
    const fermentKg = Math.round(sum(whey, (w) => w.kg) * 10) / 10;
    const curdKg = inputKg > 0 ? Math.round((inputKg + wasteKg) * 10) / 10 : 0;
    const wheyYieldPct = curdKg > 0 && fermentKg > 0 ? curdKg / fermentKg * 100 : null;
    const ratio = mixRatio(state, mixType);
    const ingredientKg = ratio > 1 ? Math.round(inputKg * (1 - 1 / ratio) * 10) / 10 : 0;
    const outKg = Math.round((fermentKg + ingredientKg) * 10) / 10;
    const goodEa = sum(lines, (l) => l.qty);
    const goodKg = Math.round(sum(lines, (l) => l.product ? l.qty * num(l.product.weightG) / 1000 : 0) * 10) / 10;
    const active = whey.length > 0 || lines.length > 0 || inputKg > 0;
    if (active && !lines.length) problems.push('품목 줄 없음');
    if (active && !whey.length) problems.push('유청 사용 LOT 없음');
    if (active && inputKg <= 0) problems.push('계근량 없음');
    const runMin = batchRunMin({ startTime: col.startTime, endTime: col.endTime, breakMin: 0 });
    return { i, whey, lines, problems, warns, inputKg, wasteKg, defectEa, mixType, fermentKg, curdKg, wheyYieldPct, ingredientKg, outKg, goodEa, goodKg, active, runMin, yieldPct: inputKg - wasteKg > 0 && goodKg > 0 ? goodKg / (inputKg - wasteKg) * 100 : null };
  };
  const sums = cols.map(summarize);
  const activeSums = sums.filter((x) => x.active);
  // 그 날 이 설비로 반출한 면포를 덜 적으면(남으면) 최종 저장 막음 (사용자 요청 11/8, v237). 많이 적은 경우는 overOf가 이미 막음.
  // 필터프레스 반출은 kg→포 환산이라 1포 미만 남는 것은 허용
  const leftProblems = pendLeft.filter((g) => (g.press ? g.left >= 1 : g.left > 0.05)).map((g) => `면포가 남음: ${g.press ? 'FP ' : ''}${g.lot} ${n(g.left, Number.isInteger(g.left) ? 0 : 1)}포 (반출 ${n(g.total, Number.isInteger(g.total) ? 0 : 1)}포 중 ${n(g.used, 1)}포만 적음) — 반출한 면포를 모두 열에 적어야 저장됩니다`);
  const allProblems = [...(dupSaved ? [`${fmtMD(date)} ${filler.name} 일지는 이미 최종 저장돼 있습니다 — 이 초안은 중복입니다`] : []), ...activeSums.flatMap((x) => x.problems.map((p) => `버퍼 ${x.i + 1}: ${p}`)), ...leftProblems];

  const saveAll = async () => {
    if (!activeSums.length) { toast('입력한 열이 없습니다.', 'bad'); return; }
    if (allProblems.length) { toast(allProblems[0], 'bad'); return; }
    const msg = `${fmtDate(date)}(${dow(date)}) ${filler.name} 충진일지 ${activeSums.length}열을 저장할까요?\n\n${activeSums.map((x) => `버퍼 ${x.i + 1}: 면포 ${x.whey.map((w) => w.press ? `${w.st.c.lot} 필터프레스 ${n(w.cloths, 1)}포` : `${w.st.c.lot} ${n(w.cloths)}포`).join(' + ')} → ${x.lines.map((l) => `${shortName(l.product.name)} ${n(l.qty)}`).join(', ')} · 계근 ${n(x.inputKg)} kg`).join('\n')}${drafts.length ? `\n\n전산 임시 배치 ${drafts.length}건에서 같은 제품 줄은 자동으로 빠집니다.` : ''}`;
    const oldPacks = state.packs.filter((p) => replaceableIds.has(p.batchId) && p.kind !== 'repack');
    const msg2 = replaceable.length ? `\n\n이 날 ${filler.name}에 먼저 등록돼 있던 충진 배치 ${replaceable.length}건(제품 LOT ${oldPacks.length}줄)은 삭제되고, 그 배치의 반출은 일지 배치에 다시 연결됩니다. (삭제된 배치는 저장 취소로도 돌아오지 않습니다)` : '';
    // 전산 대조: 전산 수량과 다른 제품 LOT가 있으면 저장 전에 보여 주고 한 번 더 확인
    const msg3 = erpDiffs.length ? `\n\n⚠ 전산 수량과 다른 제품 LOT ${erpDiffs.length}줄:\n${erpDiffs.slice(0, 12).map((r) => `· ${erpLine(r)}`).join('\n')}${erpDiffs.length > 12 ? `\n· 외 ${erpDiffs.length - 12}줄` : ''}\n그래도 일지 수량으로 저장할까요? (전산 수량은 일지 기록에 남겨 둡니다)` : '';
    if (!(await confirmAsync(msg + msg2 + msg3, { ok: erpDiffs.length ? '일지 수량으로 저장' : '저장', danger: replaceable.length > 0 || erpDiffs.length > 0 }))) return;
    // 저장 때 전산 수량을 일지 문서에 남김 (전산 임시 배치는 저장하면서 지워지므로). 전산 임시 배치가 없으면 예전에 남긴 값 유지
    const erpSnap = erpCmp ? erpCmp.rows.filter((r) => r.erp > 0).map((r) => ({ productCode: r.productCode, expiry: r.expiry, erp: r.erp, journal: r.jr })) : null;
    setBusy(true);
    try {
      // 작업자: 열에 적은 값(쉼표 구분), 없으면 기준정보의 설비 기본 작업자
      const splitNames = (t) => String(t || '').split(/[,،\s]+/).map((v) => v.trim()).filter(Boolean);
      const crewOf = (col) => { const c = col.crew; const d = filler.crew || {}; return c ? { fill: splitNames(c.fill), cap: splitNames(c.cap), pack: splitNames(c.pack) } : { fill: d.fill || [], cap: d.cap || [], pack: d.pack || [] }; };
      let seq = formal.filter((b) => !replaceableIds.has(b.id)).length; let made = 0, absorbedN = 0, linked = 0;
      // 유청분리에서 이 설비로 반출한 대기 면포(복사본, 열을 돌며 소모). 열의 LOT와 같은 반출을 먼저 배치에 붙이고, 반출보다 적게 쓰면 분할, 모자라면 재고에서 새 반출
      const pend = pendingFor.map(({ culture, ...m }) => ({ ...m }));
      const pendWrites = new Map();
      const r1 = (v) => Math.round(v * 10) / 10;
      for (const x of activeSums) {
        seq++;
        const id = uid();
        const moves = [];
        for (const w of x.whey) {
          let need = w.cloths;
          // 필터프레스 줄은 필터프레스 반출만, 탱크 줄은 유청분리실 반출부터(그 다음 필터프레스 반출)
          const cands = pend.filter((m) => m.cultureId === w.cultureId && m.cloths > 0 && (!w.press || m.source === 'press')).sort((a, b) => w.press ? 0 : (a.source === 'press') - (b.source === 'press'));
          for (const m of cands) {
            if (need <= 0.05) break;
            const per = m.cloths > 0 && num(m.kg) > 0 ? num(m.kg) / m.cloths : w.kgPer;
            if (m.cloths <= need + 0.05) { moves.push({ ...m, batchId: id, fillDate: date, mixType: x.mixType }); need -= m.cloths; m.cloths = 0; linked++; }
            else { const take = r1(need); moves.push({ ...m, id: uid(), cloths: take, kg: r1(take * per), batchId: id, fillDate: date, mixType: x.mixType, note: `${m.note ? m.note + ' · ' : ''}충진일지에서 ${n(m.cloths)}포 중 ${n(take)}포 분할` }); m.cloths = r1(m.cloths - take); m.kg = r1(m.cloths * per); pendWrites.set(m.id, m); need = 0; linked++; }
          }
          if (need > 0.05) moves.push({ id: uid(), cultureId: w.cultureId, kind: 'move', date, fillDate: date, fillerId, mixType: x.mixType, cloths: r1(need), kg: r1(need * w.kgPer), batchId: id, journalMade: true,
            source: w.press ? 'press' : pressByTank[w.st.c.tankId] ? (w.st.stock.hasPress && w.st.stock.wheyRoomKg <= 0 ? 'press' : 'room') : '', note: w.press ? `충진일지 등록 · 필터프레스 ${n(r1(need), 1)}포 (유청분리 반출 없이 재고에서)` :'충진일지 등록 (유청분리 반출 없이 재고에서)' });
        }
        const sources = moves.map((m) => ({ moveId: m.id, cultureId: m.cultureId, kind: 'cloth', cloths: m.cloths, liters: 0, kg: m.kg }));
        const col = cols[x.i];
        const crew = crewOf(col);
        const doc = { id, date, fillerId, mixType: x.mixType, batchNo: batchNo(date, filler.name, seq, x.mixType), sources,
          fermentKg: x.fermentKg, ingredientKg: x.ingredientKg, outKg: x.outKg, inputKg: x.inputKg, wasteKg: x.wasteKg, goodEa: x.goodEa, defectEa: x.defectEa, goodKg: null,
          lossKg: x.inputKg > 0 ? Math.round((Math.max(0, x.inputKg - x.wasteKg) - x.goodKg) * 10) / 10 : 0,
          startTime: col.startTime || '', endTime: col.endTime || '', breakMin: 0, runMin: x.runMin, crew, workers: crewNames({ crew }).length, hours: Math.round(x.runMin / 60 * 100) / 100, note: '충진일지 등록', journal: true };
        await save('batches', doc);
        for (const m of moves) await save('separations', m);
        for (const m of pendWrites.values()) if (m.cloths > 0) await save('separations', { ...m, batchId: m.batchId && replaceableIds.has(m.batchId) ? null : m.batchId }); // 분할로 남은 대기분 (기존 배치 것이면 배정 대기로)
        pendWrites.clear();
        for (const l of x.lines) {
          const packLots = bomRequirements(state, l.productCode, l.qty).map((r) => { const lot = pickMaterialLot(state, r.materialCode); return { materialCode: r.materialCode, lotId: lot ? lot.id : '', qty: Math.round(r.total * 1000) / 1000 }; });
          await save('packs', { id: uid(), batchId: id, date, kind: 'normal', productCode: l.productCode, productLot: l.lot, expiry: l.expiry, qty: l.qty, usedKg: null, workers: 0, hours: 0, packLots, note: '' });
        }
        const ab = await absorbErpDrafts(doc, x.lines.map((l) => l.productCode));
        absorbedN += ab.removed + ab.trimmed; made++;
      }
      // 먼저 등록돼 있던 배치 자동 삭제: 제품 LOT도 삭제, 일지 배치에 연결되지 않고 남은 반출은 배정 대기로
      for (const b of replaceable) {
        for (const p of oldPacks.filter((p) => p.batchId === b.id)) await remove('packs', p.id);
        await remove('batches', b.id);
      }
      for (const m of pend) if (m.cloths > 0 && m.batchId && replaceableIds.has(m.batchId)) await save('separations', { ...m, batchId: null });
      toast(`충진 배치 ${made}건(면포 ${n(sum(activeSums, (x) => sum(x.whey, (w) => w.cloths)))}포 · 제품 LOT ${n(sum(activeSums, (x) => x.lines.length))}줄)을 저장했습니다.${linked ? ` 유청분리 반출 ${linked}건을 연결했습니다.` : ''}${replaceable.length ? ` 먼저 등록돼 있던 배치 ${replaceable.length}건을 삭제했습니다.` : ''}${absorbedN ? ` 전산 임시 배치 ${absorbedN}건을 정리했습니다.` : ''}`);
      // 일지 내용을 '최종 저장됨'으로 보관 (임시저장 목록에서 빠지고, 다시 열면 읽기 전용으로 그대로 보임)
      const dj = draftFor(fillerId, date);
      const erpKeep = erpSnap && erpSnap.length ? { erpCompare: erpSnap, erpComparedAt: erpCmp.src === 'live' ? new Date().toISOString() : (erpCmp.at || new Date().toISOString()), erpDiffN: erpDiffs.length } : {};
      await save('journals', { ...(dj || { id: uid(), createdAt: new Date().toISOString(), source: 'manual', pages: [], notes: [] }), fillerId, date, cols: stripCols(cols), status: 'saved', savedAt: new Date().toISOString(), ...erpKeep });
      setLoadedDraft(null); setAiNotes(null);
      setSavedMode(true); // 열은 지우지 않고 그대로 둠
    } catch (e) { toast(`저장 실패: ${e.message || e}`, 'bad'); }
    setBusy(false);
  };

  const tanks = (s.tanks || []);
  // 작업자: 기준정보의 설비별 기본 작업자(충진·캡·포장)가 자동으로 채워지고, 열마다 고칠 수 있음 (저장되는 배치의 작업자)
  const crewDef = filler.crew || {};
  const crewStr = (col) => col.crew || { fill: (crewDef.fill || []).join(', '), cap: (crewDef.cap || []).join(', '), pack: (crewDef.pack || []).join(', ') };
  return html`
    <div class="page-head"><div><div class="eyebrow">충진/포장팀</div><h1>충진일지 등록</h1></div>
      <div class="actions">
        <select class="input" value=${fillerId} onChange=${(e) => setFillerId(e.target.value)}>${fillers.map((f) => html`<option key=${f.id} value=${f.id}>충진 ${f.name}${f.code ? ` (${f.code})` : ''}</option>`)}</select>
        <div class="row" style="flex-wrap:nowrap"><button class="btn sm" onClick=${() => setDate(addDays(date, -1))} aria-label="이전 날"><${Icon} name="left" /></button><input type="date" class="input" style="width:150px" value=${date} onInput=${(e) => e.target.value && setDate(e.target.value)} /><button class="btn sm" onClick=${() => setDate(addDays(date, 1))} aria-label="다음 날"><${Icon} name="right" /></button></div>
        ${ai && (aiBusy ? html`<button class="btn" onClick=${() => aiCtl.current && aiCtl.current.abort()} title="보통 20~90초 걸립니다. 처음이면 'Claude 사용 허용' 창이 뜨니 허용하세요"><${Icon} name="x" />${aiBusy}… ${aiSec}초 · 중지</button>`
          : html`<label class="btn" style="cursor:pointer" title="종이 생산일지를 찍은 사진(여러 장 가능)을 올리면 Claude가 읽어 열을 채웁니다. 반드시 사진과 비교해 확인한 뒤 저장하세요"><${Icon} name="upload" />일지 사진으로 초안<input type="file" accept=${`${ai.accept || 'image/*'},application/pdf,.pdf`} multiple style="display:none" onChange=${(e) => { readPhotos(e.target.files); e.target.value = ''; }} /></label>`)}
        ${ai && !bulk && html`<label class="btn" style="cursor:pointer" title="여러 날·여러 설비의 일지 사진을 한꺼번에 올리면 한 장씩 읽어 설비·날짜별 임시저장본을 만듭니다"><${Icon} name="upload" />일지 묶음 올리기<input type="file" accept=${`${ai.accept || 'image/*'},application/pdf,.pdf`} multiple style="display:none" onChange=${(e) => { scanMany(e.target.files); e.target.value = ''; }} /></label>`}
        <button class="btn" onClick=${addCol}><${Icon} name="plus" />열(버퍼) 추가</button>
        <button class="btn" disabled=${!state.canWrite || busy || !activeSums.length || savedMode} onClick=${() => saveDraft()} title="지금 열을 설비·날짜별 임시저장본으로 보관 (실적에는 아직 반영 안 됨)"><${Icon} name="clipboard" />임시저장</button>
        <button class="btn primary" disabled=${!state.canWrite || busy || !activeSums.length || savedMode || fillDay} onClick=${saveAll} title=${fillDay ? `${filler.name}의 ${fmtMD(JOURNAL_ALL_FROM)} 이전 실적은 충진/포장 실적에 등록된 것을 씁니다` : allProblems.length ? allProblems.join('\n') : '열마다 충진 배치·반출·제품 LOT를 저장 → LOT 추적·클레임에 반영'}><${Icon} name="check" />${busy ? '저장 중…' : `최종 저장 (${activeSums.length}열)`}</button>
      </div></div>

    ${bulk && html`<div class="banner ${bulk.stopped ? 'info' : 'warn'}"><${Icon} name="alert" /><span><b>일지 묶음 읽기 ${bulk.stopped ? '끝' : '진행 중'}</b> · ${bulk.done}/${bulk.total}장 (성공 ${bulk.ok} · 실패 ${bulk.fail})${bulk.cur ? ` · 지금: ${bulk.cur}` : ''}${bulk.log.length ? html`<details style="margin-top:4px"><summary>장별 결과</summary>${bulk.log.map((t, i) => html`<div key=${i} style="font-size:12px">${t}</div>`)}</details>` : ''}</span>${bulk.stopped ? html`<button onClick=${() => setBulk(null)}>닫기</button>` : html`<button onClick=${() => bulkCtl.current && bulkCtl.current.abort()}>중지</button>`}</div>`}

    ${(drafts0.length > 0 || savedDrafts.length > 0) && html`<${Card} title="임시저장 일지" count=${drafts0.length} desc="검수가 필요한 초안 · 누르면 불러옵니다 · 최종 저장하면 목록에서 빠집니다" flush>
      <div style="padding:10px 14px;display:flex;flex-direction:column;gap:6px">
        ${[...new Set(drafts0.map((j) => j.date))].map((dt) => html`<div key=${dt} class="row" style="gap:6px;align-items:center"><span class="muted" style="width:90px;font-size:12.5px">${fmtDate(dt)}(${dow(dt)})</span><div class="chips">${drafts0.filter((j) => j.date === dt).map((j) => html`<span key=${j.id} class="chip clickable ${loadedDraft === j.id ? 'accent' : ''}" onClick=${() => loadDraft(j)} title=${`${(j.cols || []).length}열 · ${j.source === 'photo' ? `사진 ${(j.pages || []).length}장` : '직접 입력'}${j.notes && j.notes.length ? ` · 확인 ${j.notes.length}건` : ''}`}>${fillerOf(state, j.fillerId).name} <b>${(j.cols || []).length}열</b>${j.notes && j.notes.length ? html` <span style="color:var(--warn)">⚠${j.notes.length}</span>` : ''}${journalBatchesOf(j.fillerId, j.date).length > 0 ? html` <span style="color:var(--bad);font-size:11px" title="이 날짜·설비는 이미 최종 저장된 일지가 있습니다 (중복 초안)">저장됨 중복</span>` : ''}<button class="icon-btn danger" style="width:18px;height:18px;margin-left:2px" title="삭제" onClick=${(e) => { e.stopPropagation(); deleteDraft(j); }}><${Icon} name="x" size="11" /></button></span>`)}</div></div>`)}
        ${savedDrafts.length > 0 && html`<div class="note"><button class="linkish" style="font-weight:500" onClick=${() => setShowSaved(!showSaved)}>${showSaved ? '최종 저장된 일지 숨기기' : `최종 저장된 일지 ${savedDrafts.length}건 보기`}</button></div>
          ${showSaved && html`<div class="chips">${savedDrafts.map((j) => html`<span key=${j.id} class="chip good" title=${`${(j.cols || []).length}열 · 저장 ${String(j.savedAt || '').slice(0, 10)}`}>${fmtMD(j.date)} ${fillerOf(state, j.fillerId).name} <b>${journalBatchesOf(j.fillerId, j.date).length}배치</b>${state.canWrite && html`<button class="linkish" style="font-size:11px;margin-left:6px;color:var(--bad)" title="이 날 생산일지로 만든 배치·반출·제품 LOT를 지우고 임시저장으로 되돌림" onClick=${() => unsaveJournal(j.fillerId, j.date)}>저장 취소</button>`}</span>`)}</div>`}`}
      </div>
    <//>`}

    ${aiBusy && html`<div class="banner info"><${Icon} name="alert" /><span><b>Claude가 일지 사진을 읽고 있습니다</b> (${aiSec}초 경과 · 보통 20~90초). 처음 쓸 때는 화면에 <b>"이 아티팩트가 Claude를 사용하도록 허용"</b> 창이 뜹니다 — 허용해야 진행됩니다. 이 화면을 떠나지 마세요.</span></div>`}
    ${aiErr && html`<div class="banner bad"><${Icon} name="alert" /><span><b>사진 초안을 만들지 못했습니다.</b> ${sampleErrorText(aiErr)}<div class="muted" style="font-size:11.5px;margin-top:4px">오류 코드: ${aiErr.code}${aiErr.message ? ` · ${aiErr.message}` : ''}${aiErr.files && aiErr.files.length ? ` · 파일: ${aiErr.files.join(', ')}` : ''}</div>${aiErr.text ? html`<details style="margin-top:4px"><summary>Claude 답 원문 보기</summary><pre style="white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto">${aiErr.text}</pre></details>` : ''}</span>
      ${aiErr.text && html`<button onClick=${retryFromText}>원문으로 다시 정리</button>`}
      <button onClick=${() => setAiErr(null)}>닫기</button></div>`}

    ${false && html`<${Card} title="열에 넣을 항목(v241 삭제 · 유청분리 대조·전산 대조 카드로 대신)" flush>
      ${packLeft.length > 0 && html`<div style="padding:10px 14px"><div class="note" style="margin-bottom:6px">전산 임시 배치의 품목 줄 <b>${packLeft.length}</b>건 · 저장하면 임시 배치에서 그 제품 줄은 자동으로 빠집니다</div>
        <div class="chips">${packLeft.map((g) => html`<button key=${g.key} class="chip clickable" onClick=${() => importPack(g)} title=${`${g.used > 0 ? `열에 ${n(g.used)}개 적음 · ` : ''}누르면 남은 ${n(g.left)}개가 버퍼 열에 들어갑니다`}>${shortName(g.product ? g.product.name : g.productCode)} <span class="muted">${g.expiry ? fmtMD(g.expiry) : ''}</span> <b>${n(g.left)}</b>${g.used > 0 ? html` <span class="muted">${n(g.total)} 중 남음</span>` : ''}</button>`)}</div></div>`}
      ${packLeft.length > 0 && pendLeft.length > 0 && html`<div style="border-top:1px solid var(--line)"></div>`}
      ${pendLeft.length > 0 && html`<div style="padding:10px 14px"><div class="note" style="margin-bottom:6px">유청분리에서 ${filler.name}로 반출한 면포 (배정 대기) <b>${pendLeft.length}</b>건 · 열의 유청 LOT에 적으면 저장할 때 자동으로 연결됩니다${replaceable.length ? html` · <span style="color:var(--warn)">먼저 등록된 배치 ${replaceable.length}건의 반출 포함 — 최종 저장하면 그 배치는 삭제되고 반출은 일지에 다시 연결됩니다</span>` : ''}</div>
        <div class="chips">${pendLeft.map((g) => html`<button key=${g.key} class="chip clickable ${g.press ? 'accent' : ''}" title=${`${g.ms.map((m) => `${fmtDate(m.date)} 반출 ${n(m.cloths)}포`).join(' · ')}${g.used > 0 ? ` · 열에 ${n(g.used, 1)}포 적음` : ''} · 누르면 남은 ${n(g.left, 1)}포가 버퍼 열에 들어갑니다`} onClick=${() => importMove(g)}>${g.press ? html`<b style="margin-right:3px">FP</b>` : ''}${g.lot} <b>${n(g.left, Number.isInteger(g.left) ? 0 : 1)}포</b>${g.used > 0 ? html` <span class="muted">반출 ${n(g.total)}포 중 남음</span>` : ''}${g.mix ? html` <span class="muted">${g.mix}</span>` : ''}${g.day !== date ? html` <span class="muted">${fmtMD(g.day)}</span>` : ''}${g.old ? html` <span style="color:var(--warn)">기존 배치</span>` : ''}</button>`)}</div></div>`}
    <//>`}

    ${erpCmp && erpCmp.rows.length > 0 && html`<${Card} title="전산 대조 · 제품 LOT별 수량" count=${erpDiffs.length || undefined}
        desc=${erpCmp.src === 'live' ? '전산 대조로 넣은 충진실적(전산 임시 배치·먼저 등록된 배치)과 일지에 적은 수량 · 다른 줄은 빨간색' : `최종 저장 때 기록해 둔 전산 수량과 일지 수량${erpCmp.at ? ` (${fmtDate(String(erpCmp.at).slice(0, 10))} 기록)` : ''}`} flush>
      <div style=${`padding:10px 14px ${erpShown.length ? 4 : 10}px`}>${erpDiffs.length
        ? html`<div class="banner bad" style="margin:0"><${Icon} name="alert" /><span><b>전산과 다른 제품 LOT ${erpDiffs.length}줄</b> · 전산 합계 ${n(sum(erpCmp.rows, (r) => r.erp))} / 일지 합계 ${n(sum(erpCmp.rows, (r) => r.jr))} (${sum(erpCmp.rows, (r) => r.diff) > 0 ? '+' : ''}${n(sum(erpCmp.rows, (r) => r.diff))}) — 종이 일지와 전산 중 어느 쪽이 맞는지 확인하세요</span></div>`
        : html`<div class="banner info" style="margin:0"><${Icon} name="check" /><span><b>모든 제품 LOT 수량이 전산과 같습니다</b> · 합계 ${n(sum(erpCmp.rows, (r) => r.erp))}</span></div>`}</div>
      ${erpShown.length > 0 && html`<div class="table-wrap"><table class="tbl compact"><thead><tr><th>품목</th><th>제품 LOT</th><th class="num">전산</th><th class="num">일지</th><th class="num">차이</th></tr></thead><tbody>
        ${erpShown.map((r) => { const bad = Math.abs(r.diff) > 0.001; return html`<tr key=${r.key} class=${bad ? 'row-bad' : ''}><td>${shortName(r.product ? r.product.name : r.productCode)}</td><td>${r.lot || '—'}<span class="sub">소비기한 ${r.expiry ? fmtDate(r.expiry) : '—'}</span></td><td class="num">${r.erp ? n(r.erp) : html`<span class="muted">전산 없음</span>`}</td><td class="num">${r.jr ? n(r.jr) : html`<span class="muted">일지 없음</span>`}</td><td class="num"><b>${bad ? `${r.diff > 0 ? '+' : ''}${n(r.diff)}` : '0'}</b></td></tr>`; })}
      </tbody></table></div>`}
      ${erpCmp.rows.length > erpDiffs.length && html`<div style="padding:${erpShown.length ? '8px' : '0'} 14px 10px"><button class="btn ghost sm" onClick=${() => setErpAll(!erpAll)}>${erpAll ? '일치하는 줄 숨기기' : `일치하는 ${erpCmp.rows.length - erpDiffs.length}줄 보기`}</button></div>`}
    <//>`}

    ${clothCmp.length > 0 && html`<${Card} title="유청분리 대조 · 배양 LOT별 면포" count=${clothDiffs.length || undefined}
        desc=${savedMode ? '저장된 일지 배치에 연결된 유청분리 반출과 일지에 적은 면포 · 다른 줄은 빨간색' : '이 날 이 설비로 유청분리에서 반출한 면포와 일지에 적은 면포 · 다른 줄은 빨간색 (필터프레스는 kg 환산이라 1포 미만 차이는 같음으로 봄)'} flush>
      <div style=${`padding:10px 14px ${clothShown.length ? 4 : 10}px`}>${clothDiffs.length
        ? html`<div class="banner bad" style="margin:0"><${Icon} name="alert" /><span><b>유청분리 반출과 다른 배양 LOT ${clothDiffs.length}줄</b> · 반출 합계 ${nc(sum(clothCmp, (r) => r.moved))}포 / 일지 합계 ${nc(sum(clothCmp, (r) => r.jr))}포 — 남은 면포는 열에 더 적고, 많이 적은 것은 유청분리 반출을 확인하세요</span></div>`
        : html`<div class="banner info" style="margin:0"><${Icon} name="check" /><span><b>모든 면포 수량이 유청분리 반출과 같습니다</b> · 합계 ${nc(sum(clothCmp, (r) => r.moved))}포</span></div>`}</div>
      ${clothShown.length > 0 && html`<div class="table-wrap"><table class="tbl compact"><thead><tr><th>배양 LOT</th><th>재공품 유형</th><th class="num">유청분리 반출</th><th class="num">일지</th><th class="num">차이</th></tr></thead><tbody>
        ${clothShown.map((r) => html`<tr key=${r.key} class=${r.bad ? 'row-bad' : ''}><td>${r.lot}<span class="sub">${r.room > 0 && r.press > 0 ? `유청분리실 ${n(r.room)}포 + FP ${n(r.press)}포` : r.press > 0 ? '필터프레스(FP)' : r.room > 0 ? '유청분리실' : ''}${r.late > 0 ? html` · <b style="color:var(--bad)">저장 뒤 반출 ${nc(r.late)}포</b>` : ''}</span></td><td>${r.mixDiff ? html`${r.mixJrS}<span class="sub" style="color:var(--warn)">반출 기록은 ${r.mixMvS}</span>` : (r.mixJrS || r.mixMvS) || html`<span class="muted">—</span>`}</td><td class="num">${r.moved ? `${nc(r.moved)}포` : html`<span class="muted">반출 없음</span>`}</td><td class="num">${r.jr ? `${nc(r.jr)}포` : html`<span class="muted">일지 없음</span>`}</td><td class="num"><b>${r.bad ? `${r.diff > 0 ? '+' : ''}${nc(r.diff)}` : '0'}</b></td></tr>`)}
      </tbody></table></div>`}
      ${clothCmp.length > clothDiffs.length && html`<div style="padding:${clothShown.length ? '8px' : '0'} 14px 10px"><button class="btn ghost sm" onClick=${() => setClothAll(!clothAll)}>${clothAll ? '일치하는 줄 숨기기' : `일치하는 ${clothCmp.length - clothDiffs.length}줄 보기`}</button></div>`}
    <//>`}

    ${fillDay && !savedMode && html`<div class="banner warn"><${Icon} name="alert" /><span><b>${fmtMD(date)} ${filler.name} 실적은 충진/포장 실적에 등록된 것을 씁니다.</b> 1·2호기는 10/23부터, 3·4호기·로타리·반자동은 ${fmtMD(JOURNAL_ALL_FROM)}부터 충진일지로 입력합니다. 이 날짜는 최종 저장할 수 없습니다.</span></div>`}
    ${dupSaved && html`<div class="banner bad"><${Icon} name="alert" /><span><b>${fmtMD(date)} ${filler.name} 일지는 이미 최종 저장돼 있습니다</b> (충진 배치 ${curJournalBatches.length}건). 그 날 이 설비로 반출된 면포 ${n(dupCloths)}포가 저장된 일지 배치에 연결돼 있어서, 이 임시저장본에서는 쓸 수 있는 면포가 0포로 보입니다. 이 초안은 중복이라 최종 저장할 수 없습니다. 저장된 내용을 이 초안으로 바꾸려면 "최종 저장된 일지 보기"에서 저장 취소를 먼저 누르고, 필요 없으면 이 초안을 지우세요.</span>${state.canWrite && curDraft && html`<button onClick=${() => deleteDraft(curDraft)}>이 초안 지우기</button>`}</div>`}
    ${savedMode && html`<div class="banner info"><${Icon} name="check" /><span><b>${fmtMD(date)} ${filler.name} 충진일지는 최종 저장됐습니다</b> (충진 배치 ${curJournalBatches.length}건). 아래 내용은 저장된 그대로이며 고칠 수 없습니다. 고치려면 저장을 취소한 뒤 다시 저장하세요.</span>${state.canWrite && html`<button onClick=${() => unsaveJournal(fillerId, date)}>저장 취소</button>`}</div>`}
    ${savedMode && lateMoves.length > 0 && html`<div class="banner bad"><${Icon} name="alert" /><span><b>저장한 뒤에 유청분리에서 ${filler.name}로 반출한 면포 ${nc(sum(lateMoves, (m) => num(m.cloths)))}포가 일지에 안 들어가 있습니다</b> — ${[...new Map(lateMoves.map((m) => { const c = state.cultures.find((x) => x.id === m.cultureId); return [m.cultureId, `${c ? c.lot : m.cultureId} ${nc(sum(lateMoves.filter((x) => x.cultureId === m.cultureId), (x) => num(x.cloths)))}포${m.mixType ? ` (${m.mixType})` : ''}`]; })).values()].join(', ')}. 저장된 일지는 고칠 수 없어서, <b>저장 취소</b>를 누르고 그 면포를 열에 적은 뒤 다시 최종 저장하세요.</span>${state.canWrite && html`<button onClick=${() => unsaveJournal(fillerId, date)}>저장 취소</button>`}</div>`}

    <div class="journal">
      ${cols.map((col, i) => { const sm = sums[i]; return html`<section key=${col.key} class="jcol ${sm.active ? 'on' : ''}" style=${savedMode ? 'pointer-events:none;opacity:.85' : ''}>
        <div class="jhead"><b>버퍼 ${i + 1}</b><span class="muted">${filler.name} · ${fmtMD(date)}(${dow(date)})</span>${cols.length > 1 && html`<button class="icon-btn danger" style="margin-left:auto" title="열 지우기" onClick=${() => removeCol(i)}><${Icon} name="x" size="14" /></button>`}</div>

        <div class="jsec"><div class="jlabel">유청 사용 LOT <span class="muted">발효탱크 · 배출일 → 배양 LOT · 면포</span></div>
          ${col.whey.map((w, j) => { const opts = w.tankId ? cultureOpts(w.tankId) : []; const st = w.cultureId ? stockOf(w.cultureId) : null; const isP = w.tankId === PRESS; const over = !!st && overOf(w.cultureId); const pendN = st ? pendingCloths(st.c.id) : 0; return html`<div key=${j} class="jrow whey">
            <select class="input" value=${w.tankId} onChange=${(e) => pickTank(i, j, e.target.value)}><option value="">탱크</option>${tanks.map((t) => html`<option key=${t.id} value=${t.id}>${t.name}</option>`)}<option value=${PRESS}>필터프레스</option></select>
            <select class="input" value=${w.cultureId} disabled=${!w.tankId} onChange=${(e) => pickCulture(i, j, e.target.value)} title=${isP ? '그 배출일에 필터프레스로 배출한 배양 LOT (탱크 확인)' : '배출일(LOT 앞 6자리) · 남은 면포'}>${!opts.length && html`<option value="">${w.tankId ? (isP ? '필터프레스 배출 LOT 없음' : '배양 LOT 없음') : ''}</option>`}${opts.map((x) => { const m = String(x.c.lot || '').match(/^\d{2}(\d{2})(\d{2})/); const pn = pendingCloths(x.c.id); return html`<option key=${x.c.id} value=${x.c.id}>${m ? `${+m[1]}/${+m[2]} 배출 · ` : ''}${x.c.lot}${isP ? ` · ${tankOf(state, x.c.tankId).name} · ${n(x.c.pressL)}L` : ''}${pn > 0 ? ` · 반출 ${n(pn)}포` : ''}${x.stock.remaining > 0 ? ` · 재고 ${n(x.stock.remaining)}포` : ''}</option>`; })}</select>
            <div style=${over ? 'outline:2px solid var(--bad);border-radius:8px' : ''} title=${over ? `이 설비가 쓸 수 있는 면포(유청분리 반출 ${n(pendN)}포 + 재고 ${n(Math.max(0, st.stock.remaining))}포 = ${n(availOf(st), 1)}포)를 넘어 저장할 수 없습니다. 유청분리 실적에서 소분·반출을 먼저 넣으세요` : st ? (pendN > 0 ? `유청분리에서 이 설비로 반출한 ${n(pendN)}포가 저장할 때 연결됩니다 · 가능 ${n(availOf(st), 1)}포` : `가능 ${n(availOf(st), 1)}포`) : ''}>${isP ? html`<${NumInput} value=${calc(w.cloths) > 0 || !(calc(w.kg) > 0) ? w.cloths : String(pressClothsOf(w))} onChange=${(v) => setWhey(i, j, { cloths: v, kg: '' })} placeholder="FP 면포" />` : html`<${NumInput} value=${w.cloths} onChange=${(v) => setWhey(i, j, { cloths: v })} placeholder="면포" />`}</div>
            <button class="icon-btn danger" style="width:22px;height:22px" title="이 줄 삭제" aria-label="유청 LOT 줄 삭제" onClick=${() => setCol(i, (c) => { const whey = c.whey.filter((_, k) => k !== j); return { whey: whey.length ? whey : [newWhey()] }; })}><${Icon} name="x" size="13" /></button>
          </div>`; })}
          <button class="linkish" style="font-size:12px" onClick=${() => setCol(i, (c) => ({ whey: [...c.whey, newWhey()] }))}>+ LOT 줄</button>
        </div>

        <div class="jsec"><div class="jlabel">충진 시간</div>
          <div class="jrow time"><${TimeInput} value=${col.startTime} onChange=${(v) => setCol(i, { startTime: v })} /><span>~</span><${TimeInput} value=${col.endTime} onChange=${(v) => setCol(i, { endTime: v })} /><span class="muted">${sm.runMin ? `${n(sm.runMin)}분` : ''}</span></div>
        </div>

        <div class="jsec"><div class="jlabel">품목 · 소비기한 · 수량 <span class="muted">줄마다 제품 LOT</span></div>
          ${col.lines.map((l, j) => html`<div key=${j} class="jrow jline">
            <select class="input" value=${l.productCode} style=${l.hint && !l.productCode ? 'border-color:var(--warn)' : ''} title=${l.hint && !l.productCode ? `사진에서 "${l.hint}"로 읽었지만 품목을 못 찾음` : ''} onChange=${(e) => setLine(i, j, { productCode: e.target.value })}><option value="">${l.hint && !l.productCode ? `"${l.hint}"?` : '품목'}</option>${products.map((p) => html`<option key=${p.code} value=${p.code}>${shortName(p.name)}</option>`)}</select>
            <div style="display:flex;flex-direction:column;gap:1px;min-width:0"><${DateInput} value=${l.expiry || expiryOf(l)} onChange=${(v) => setLine(i, j, { expiry: v })} placeholder="소비기한" /><span class="muted lot" style="font-size:11px;line-height:1.2;padding-left:2px">${l.productCode && expiryOf(l) ? lotOf(l) : ''}</span></div>
            <${NumInput} value=${l.qty} onChange=${(v) => setLine(i, j, { qty: v })} placeholder="ea" />
          </div>`)}
          <button class="linkish" style="font-size:12px" onClick=${() => setCol(i, (c) => ({ lines: [...c.lines, newLine()] }))}>+ 품목 줄</button>
        </div>

        <div class="jsec"><div class="jrow kg">
          <${Field} label="계근량 (kg)"><${NumInput} value=${col.inputKg} onChange=${(v) => setCol(i, { inputKg: v })} /><//>
          <${Field} label="폐기량 (kg)"><${NumInput} value=${col.wasteKg} onChange=${(v) => setCol(i, { wasteKg: v })} /><//>
          <${Field} label="불량 (ea)"><${NumInput} value=${col.defectEa} onChange=${(v) => setCol(i, { defectEa: v })} /><//>
          <${Field} label="재공품 유형"><select class="input" value=${col.mixType} onChange=${(e) => setCol(i, { mixType: e.target.value })}><option value="">${mixOf(col)}</option>${(s.mixTypes || []).map((m) => html`<option key=${m.name} value=${m.name}>${m.name}</option>`)}</select><//>
        </div></div>

        <div class="jsec"><div class="jlabel">작업자 <span class="muted">기준정보 기본값 · 쉼표로 구분, 고칠 수 있음</span></div>
          <div class="jrow" style="grid-template-columns:1fr 1fr 1fr">
            ${[['fill', '충진'], ['cap', '캡'], ['pack', '포장']].map(([k, label]) => html`<${Field} key=${k} label=${label}><input class="input" value=${crewStr(col)[k]} onInput=${(e) => setCol(i, (c) => ({ crew: { ...crewStr(c), [k]: e.target.value } }))} /><//>`)}
          </div>
        </div>

        <div class="jsum">${sm.active ? html`
          <div>면포 <b>${n(sum(sm.whey.filter((w) => !w.press), (w) => w.cloths))}</b>포${sm.whey.some((w) => w.press) ? ` + FP ${n(sum(sm.whey.filter((w) => w.press), (w) => w.cloths), 1)}포` : ''} · 발효유 ${n(sm.fermentKg)} kg${sm.curdKg > 0 ? html` → 유청분리 후 <b>${n(sm.curdKg)} kg</b> (계근+폐기)${sm.wheyYieldPct != null ? ` · 발효유 수율 ${n(sm.wheyYieldPct, 1)}%` : ''}` : ''}</div>
          <div class="muted">${sm.ingredientKg ? `부원료 ${n(sm.ingredientKg)} kg · ` : ''}출고 ${n(sm.outKg)} kg</div>
          <div>양품 <b>${n(sm.goodEa)}</b> ea · ${n(sm.goodKg)} kg${sm.yieldPct != null ? ` · 충진 수율 ${n(sm.yieldPct, 1)}%` : ''}</div>
          ${sm.warns.length ? html`<div style="color:var(--warn)">${sm.warns.map((t, k) => html`<div key=${k}>⚠ ${t}</div>`)}</div>` : ''}
          ${savedMode ? html`<div style="color:var(--good)"><${Chip} tone="good" dot>저장됨<//></div>` : sm.problems.length ? html`<div style="color:var(--bad)">${sm.problems.join(' · ')}</div>` : html`<div style="color:var(--good)"><${Chip} tone="good" dot>저장 가능<//> ${batchNo(date, filler.name, formal.length + activeSums.findIndex((x) => x.i === i) + 1, sm.mixType)}</div>`}` : html`<span class="muted">비어 있는 열</span>`}</div>
      </section>`; })}
    </div>
    ${aiNotes && html`<div class="banner ${aiNotes.notes.length ? 'warn' : 'info'}" style="margin-top:14px"><${Icon} name="alert" /><span><b>사진으로 만든 초안입니다 (${aiNotes.cols}열${aiNotes.filler ? ` · ${aiNotes.filler}` : ''} · ${fmtDate(aiNotes.date)}).</b> 손글씨 인식이라 틀릴 수 있으니 사진과 비교해 숫자·품목·탱크를 확인한 뒤 저장하세요.${aiNotes.notes.length ? html`<br />${aiNotes.notes.map((t, i) => html`<span key=${i}>· ${t}<br /></span>`)}` : ''}</span><button onClick=${() => setAiNotes(null)}>닫기</button></div>`}`;
}
