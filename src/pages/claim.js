// 클레임 LOT: 클레임 접수 엑셀(제품명 · 소비기한 [· LOT])을 올리면 제품 LOT → 충진 배치 → 반출·유청분리 → 배양 LOT까지 한 번에 추적해 표로 보여주고 엑셀·PDF로 저장
import { html, useState, useMemo, useEffect, Card, Chip, Icon, Field, Stat, saveFile, toast, confirmAsync } from '../ui.js';
import { productOf, fillerOf, tankOf, cultureStock, allPacks, allBatches, dischargeCandidates, lot7, moveAge, clothAgeTitle, ageCls } from '../model.js';
import { loadXLSX, erpLotToApp } from '../excel.js';
import { save, remove, saveSettings } from '../store.js';
import { n, num, fmtDate, dow, today, buildPdf, uid } from '../util.js';

// 이름 별칭: 클레임 제품명에 이 글자가 들어 있으면 무조건 이 품목으로 (기준정보 settings.claimAliases [{name, code}]가 우선, 아래는 기본값 · 품목명으로 찾음)
// 블루베리 콩포트(플레인 블루베리 130g = 플콩 + 블루베리 콩포트)도 플콩 100g으로 충진 (v263: '충진-블루베리 100g'으로 잘못 잡히던 것)
const DEFAULT_ALIASES = [{ name: '블루베리 130', productName: '플콩 100g' }, { name: '블루베리 콩포트', productName: '플콩 100g' },
  // 품질팀 자사검사 엑셀의 완제품명 (v271): 드링크·한정선은 LOT 글자가 충진 LOT와 달라 이름으로 품목을 정함
  { name: '한정선', productName: '한정선 5kg' }, { name: '더 진한 플레인 요거트 락토프리', productName: '서울 락토프리 1.8L' }, { name: '마시는 그릭요거트 스타터', productName: '마시는그릭 1.8L' }];

const PDF_LINES = 52; // PDF 한 장에 넣는 줄 수(한 줄 ≈ 24px). 배양 LOT 하나가 2줄, 충진 칸이 3줄
const shortName = (s) => String(s || '').replace(/^충진[-_]\s*/, '');
const norm = (s) => String(s || '').toLowerCase().replace(/^충진[-_]\s*/, '').replace(/[\s\-_·,./()]+/g, '');
const normLot = (s) => lot7(s).toLowerCase().replace(/\s+/g, ''); // 띄어쓰기 전부 무시, 요일 0=7로 보고 비교
const yy = (iso) => iso ? fmtDate(iso).replace(/^20(\d{2})/, '$1') : '—';
const SRC_LABEL = { press: '필터프레스', room: '면포', drink: '드링크', '': '출처 미입력' };
/** 추적 완료로 보는 상태 (카드 숫자·현황 '배양 LOT까지 추적'에 같이 씀) */
export const TRACED_ST = new Set(['ok', 'lotTime', 'lotWd', 'lotDay']);
const STATUS = {
  ok: { label: '추적 완료', tone: 'good' },
  lotTime: { label: '추적 완료 · LOT·제조시간', tone: 'good' },
  lotWd: { label: '추적 완료 · 소비기한·충진 요일', tone: 'good' },
  lotDay: { label: '추적 완료 · LOT (그날 설비 전체)', tone: 'good' },
  partial: { label: '일부 면포 미연결', tone: 'warn' },
  noTrace: { label: '면포 미연결', tone: 'warn' },
  legacy: { label: '전산 백데이터 · 배양 LOT 참고만', tone: 'warn' },
  lotOnly: { label: 'LOT로만 일치 · 품목 확인', tone: 'info' },
  lotMiss: { label: 'LOT 불일치 · 소비기한으로 찾음', tone: 'warn' },
  multi: { label: '품목 후보 여러 개 · 골라 주세요', tone: 'info' },
  noPack: { label: '제품 LOT 없음', tone: 'bad' },
  noProduct: { label: '품목 미확인', tone: 'bad' },
  empty: { label: '소비기한·LOT 없음', tone: 'bad' },
};

/** 소비기한 칸 → ISO. 엑셀 날짜값, "2026.11.10", "26.11.10", "2026-11-10", "20261110", "2026년 11월 10일" */
export function parseExpiry(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') { if (v < 20000 || v > 80000) return ''; return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/(\d{4}|\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (!m) m = s.match(/^(\d{4}|\d{2})(\d{2})(\d{2})$/);
  if (!m) return '';
  const y = m[1].length === 2 ? '20' + m[1] : m[1]; const mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** 제조 시간 칸 → "HH:MM". 엑셀 시간값(0.354…), "08:30", "8:30", "0830", "8시 30분", "오후 2:30" */
const hhmm = (h, m) => (h >= 0 && h < 24 && m >= 0 && m < 60) ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : '';
export function parseTime(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') { const f = v - Math.floor(v); if (v < 0 || (v >= 1 && f === 0)) return ''; const mins = Math.round(f * 1440) % 1440; return hhmm(Math.floor(mins / 60), mins % 60); }
  const s = String(v).trim(); if (!s) return '';
  const pm = /오후|pm/i.test(s), am = /오전|am/i.test(s);
  const m = s.match(/(\d{1,2})\s*:\s*(\d{2})/) || s.match(/(\d{1,2})\s*시\s*(\d{1,2})?/) || s.match(/^(\d{1,2})(\d{2})$/);
  if (!m) return '';
  let h = +m[1]; const mi = m[2] != null ? +m[2] : 0;
  if (pm && h < 12) h += 12; if (am && h === 12) h = 0;
  return hhmm(h, mi);
}
/** 제품 LOT "26-1110 C5"의 날짜 부분 → "2026-11-10" (제품 LOT의 기준일 = 소비기한) */
export function lotExpiry(lot) { const m = String(lot || '').match(/^(\d{2})-(\d{2})(\d{2})/); return m ? `20${m[1]}-${m[2]}-${m[3]}` : ''; }

// 자사검사(품질팀 검사 엑셀) 열: 효모 = "효모 (5일차)"·"효모/곰팡이 (4일차)" 등 (일차가 큰 열 우선), 곰팡이 = "곰팡이" 단독 열
export const isYeastHead = (h) => /효모/.test(String(h || ''));
export const isMoldHead = (h) => /곰팡이/.test(String(h || '')) && !/효모/.test(String(h || ''));
/** 균수 칸 → 숫자. "<10" = 0(10 이하·불검출, 화면엔 <10), "170 / M:20" = 170, TNTC(셀 수 없이 많음) = TNTC_COUNT, "-"·빈칸·"11월 7일 예정" = null */
export const TNTC_COUNT = 10000000;
export const parseCount = (v) => { const s = String(v ?? '').trim(); if (!s || /^[-–—]$/.test(s) || /예정/.test(s)) return null; if (/TNTC/i.test(s)) return TNTC_COUNT; if (/^<\s*\d/.test(s)) return 0; const m = s.match(/\d[\d,]*/); return m ? Number(m[0].replace(/,/g, '')) : null; };
/** 소비기한 칸에 시간·LOT가 함께 적힌 경우: "2026.10.13 17:10 B3 E" · "2026.11.17 11:42 A4S" → { lot: '26-1013 B3', time: '17:10', stage: '말' }
 *  LOT 뒤 S·M·E = 초·중·말 (품질팀 표기, v271) */
export const lotFromExpiryCell = (v) => {
  // v283: 시간 오타도 LOT는 읽음 — "10;21"(세미콜론)은 10:21, "15:4"(분 한 자리)는 시간을 알 수 없어 비움
  const m = String(v ?? '').match(/(\d{4}|\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s+(\d{1,2})\s*[:;]\s*(\d{1,2})\s+([A-Z]{1,2}\d{1,2})(?:\s*([SME]))?\b/);
  if (!m) return null;
  const yy = m[1].slice(-2), mm = String(+m[2]).padStart(2, '0'), dd = String(+m[3]).padStart(2, '0');
  return { lot: `${yy}-${mm}${dd} ${m[6]}`, time: m[5].length === 2 ? `${String(+m[4]).padStart(2, '0')}:${m[5]}` : '', stage: m[7] ? { S: '초', M: '중', E: '말' }[m[7]] : '' };
};

/** 클레임 접수 엑셀 읽기: 머리글 줄에서 제품명·소비기한·LOT·수량·제조시간 열을 찾고, 나머지 열은 그대로 가져감(클레임 내용·접수일 등) */
// v309: 개인정보·담당자 열은 가져오지 않음 (공유 저장소에 남지 않게): 성명·연락처·전화·주소·이메일·접수자·담당자
const isPrivateHead = (h) => /성명|이름|연락처|전화|휴대|핸드폰|주소|이메일|e-?mail|접수자|담당자/i.test(String(h || ''));
// v309: 월별 시트(2026.01 … 2026.11)가 여러 개면 이번 달 시트, 없으면 가장 늦은 달 시트를 먼저 고름
const monthSheet = (s) => { const m = String(s).trim().match(/^(\d{4})\s*[.\-_년]\s*(\d{1,2})\s*월?$/); return m ? `${m[1]}-${m[2].padStart(2, '0')}` : ''; };
export function defaultSheet(names) {
  const ms = names.map((s) => ({ s, ym: monthSheet(s) })).filter((x) => x.ym);
  if (!ms.length) return names[0];
  const cur = today().slice(0, 7);
  return (ms.find((x) => x.ym === cur) || ms.sort((a, b) => a.ym.localeCompare(b.ym))[ms.length - 1]).s;
}
// v309: 클레임 관리대장 양식 (날짜·접수자·인입경로·성명·연락처·구매사이트·클레임제품명·문제유형·클레임유형·세부유형·소비기한·라인 …)
//  소비기한 칸 = "2026.10.30 16:19"(제조시간 포함), 라인 칸 = 제품 LOT 뒷부분 "A7S"(S·M·E = 초·중·말) → 제품 LOT 26-1030 A7
//  문제유형 '서비스'(배송·파손 등)는 생산 추적 대상이 아니라 건너뜀. 함께 가져오는 열은 아래 순서·이름으로만
const LEDGER_EXTRAS = [[/^날짜$|^접수\s*일/, '접수일'], [/^세부\s*유형$/, '클레임 내용'], [/^클레임\s*유형$/, '클레임 유형'], [/^구매\s*(사이트|처)$/, '구매처'], [/^인입\s*경로$/, '인입경로'], [/^처\s*리\s*구\s*분/, '처리']];
export async function parseClaimXlsx(buf, sheetName) {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : defaultSheet(wb.SheetNames);
  const ws = wb.Sheets[sheet];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const isName = (h) => /제품명|품목명|상품명|품명|^품목$|^제품$|^상품$/.test(h);
  const isExp = (h) => /소비\s*기한|유통\s*기한|^기한$/.test(h);
  const isLot = (h) => /lot|로트|제조번호/i.test(h);
  const isQty = (h) => /수량|개수|^qty$/i.test(h);
  // 제조 시간: 제품에 LOT와 함께 찍힌 시간. 있으면 그 시간에 충진 중이던 버퍼만 추적
  const isTime = (h) => /제조\s*시[간각]|생산\s*시[간각]|충진\s*시[간각]|^시간$|^time$/i.test(h);
  let hi = -1, best = 0;
  for (let i = 0; i < Math.min(aoa.length, 30); i++) {
    const hs = aoa[i].map((c) => String(c).trim());
    const sc = (hs.some(isName) ? 1 : 0) + (hs.some(isExp) ? 1 : 0) + (hs.some(isLot) ? 1 : 0);
    if (sc > best) { best = sc; hi = i; }
  }
  if (hi < 0) throw new Error(`제품명 · 소비기한(또는 LOT) 열이 있는 머리글 줄을 찾지 못했습니다. "${sheet}" 시트의 머리글에 "제품명", "소비기한" 열이 있어야 합니다.`);
  const head = aoa[hi].map((c) => String(c).trim().replace(/\s+/g, ' '));
  // 같은 이름 머리글(예: "구분" 두 개)은 따로 읽히게: 값이 면포/필터프레스뿐이면 "면포/필터프레스", 아니면 "구분 (2)"
  const seenH = new Map();
  head.forEach((h, i) => {
    if (!h) return; const k = seenH.get(h) || 0; seenH.set(h, k + 1); if (!k) return;
    const vals = aoa.slice(hi + 1).map((r) => String(r[i] ?? '').trim()).filter(Boolean);
    head[i] = vals.length && vals.every((v) => /면포|필터|프레스|^FP$/i.test(v)) ? '면포/필터프레스' : `${h} (${k + 1})`;
  });
  const isWeight = (h) => /중량|용량/.test(h);
  const C = { name: head.findIndex(isName), exp: head.findIndex(isExp), lot: head.findIndex(isLot), qty: head.findIndex(isQty), time: head.findIndex(isTime), weight: head.findIndex(isWeight), mold: head.findIndex(isMoldHead) };
  if (C.exp < 0 && C.lot < 0) throw new Error('소비기한 또는 LOT 열이 없습니다. 제품 LOT를 찾으려면 소비기한이 꼭 필요합니다.');
  // 효모 열: 일차가 큰 것부터 (5일차 → 4일차 → 3일차), 줄마다 값이 있는 첫 열을 씀
  const dayOf = (h) => { const m = h.match(/(\d+)\s*일차/); return m ? +m[1] : 0; };
  const yeastCols = head.map((h, i) => ({ h, i })).filter((x) => isYeastHead(x.h)).sort((a, b) => dayOf(b.h) - dayOf(a.h));
  // 관리대장 양식: '라인' 열(제품 LOT 뒷부분) + '세부유형' 또는 '클레임유형' 열이 있으면
  C.line = C.lot < 0 ? head.findIndex((h) => /^라인$/.test(h)) : -1;
  const ledger = C.line >= 0 && head.some((h) => /^(세부|클레임)\s*유형$/.test(h));
  C.problem = ledger ? head.findIndex((h) => /^문제\s*유형$/.test(h)) : -1;
  const extraCols = ledger
    ? LEDGER_EXTRAS.map(([re, h]) => ({ h, i: head.findIndex((x) => re.test(x)) })).filter((x) => x.i >= 0)
    : head.map((h, i) => ({ h, i })).filter((x) => x.h && !isPrivateHead(x.h) && ![C.name, C.exp, C.lot, C.qty, C.time, C.weight].includes(x.i));
  let skipped = 0;
  const cell = (h, v) => { if (v == null || v === '') return ''; if (typeof v === 'number' && /일|날짜|date/i.test(h) && v > 20000 && v < 80000) return fmtDate(parseExpiry(v)); return String(v).trim(); };
  // 검사일자·접수일처럼 묶음 첫 줄에만 적힌 날짜 열은 아래 빈 줄에 이어서 채움
  const fillDown = extraCols.filter((x) => isReceipt(x.h)).map((x) => x.i); const last = {};
  const rows = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i];
    let name = C.name >= 0 ? String(r[C.name] || '').trim().replace(/\s+/g, ' ') : '';
    let lotRaw = C.lot >= 0 ? String(r[C.lot] || '').trim() : '';
    const expRaw = C.exp >= 0 ? r[C.exp] : '';
    for (const ci of fillDown) { if (r[ci] !== '' && r[ci] != null) last[ci] = r[ci]; }
    if (!name && !lotRaw && (expRaw === '' || expRaw == null)) continue;
    if (ledger && C.problem >= 0 && /서비스/.test(String(r[C.problem] || ''))) { skipped++; continue; }
    // 관리대장: 소비기한 날짜 + 라인 "A7S" → 26-1030 A7, 소비기한 칸의 시간 = 제조시간
    let ledgerTime = '';
    if (ledger) {
      const e = parseExpiry(expRaw); const code = String(r[C.line] || '').trim().toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{1,2}\d{1,2})([SME])?$/);
      if (e && code) lotRaw = `${e.slice(2, 4)}-${e.slice(5, 7)}${e.slice(8, 10)} ${code[1]}`;
      if (typeof expRaw === 'number') ledgerTime = parseTime(expRaw);
      else { const tm = String(expRaw || '').match(/\d\s+(\d{1,2})\s*[:;]\s*(\d{2})\b/); if (tm) ledgerTime = hhmm(+tm[1], +tm[2]); }
    }
    // 품질팀 엑셀처럼 소비기한 칸에 "2026.10.13 17:10 B3 E"(제조시간·LOT)가 함께 있으면 거기서 LOT·제조시간을 꺼냄
    const fromExp = !lotRaw && !ledger ? lotFromExpiryCell(expRaw) : null;
    if (fromExp) lotRaw = fromExp.lot;
    // 중량 열이 따로 있으면 품목명 뒤에 붙여 품목을 좁힘 (요즘 플레인 그릭요거트 + 100 → … 100g)
    const w = C.weight >= 0 ? num(r[C.weight]) : 0;
    if (w > 0 && !/\d+(\.\d+)?\s*(g|kg|ml|l)\b/i.test(name)) name = `${name} ${w}g`;
    const lot = lotRaw ? erpLotToApp(lotRaw) : '';
    let yeastRaw = ''; for (const y of yeastCols) { const v = String(r[y.i] ?? '').trim(); if (v && parseCount(v) != null) { yeastRaw = v; break; } }
    const moldRaw = C.mold >= 0 ? String(r[C.mold] ?? '').trim() : '';
    rows.push({ row: i + 1, name, lotRaw, lot, expiry: parseExpiry(expRaw) || lotExpiry(lot), expRaw: expRaw === '' ? '' : String(expRaw).trim(), qty: C.qty >= 0 ? num(r[C.qty]) : ledger ? 1 : 0,
      time: C.time >= 0 ? parseTime(r[C.time]) : fromExp ? fromExp.time : ledgerTime,
      yeast: yeastRaw ? parseCount(yeastRaw) : null, yeastRaw, mold: moldRaw ? parseCount(moldRaw) : null, moldRaw,
      extras: (() => { const ex = extraCols.map(({ h, i: ci }) => [h, cell(h, fillDown.includes(ci) && (r[ci] === '' || r[ci] == null) ? last[ci] : r[ci])]).filter(([, v]) => v !== '');
        // 소비기한 칸 끝 S·M·E가 있으면 그것이 초·중·말 (구분 열보다 우선, v271)
        if (fromExp && fromExp.stage) { const k = ex.findIndex(([h]) => h === '구분'); if (k >= 0) ex[k] = ['구분', fromExp.stage]; else ex.push(['구분', fromExp.stage]); }
        return ex; })() });
  }
  const colName = (i) => (i >= 0 ? head[i] : '');
  const inExp = C.lot < 0 && rows.some((x) => x.lotRaw) ? `${colName(C.exp)} 칸에서` : '';
  return { rows, sheet, sheets: wb.SheetNames, ledger, skipped, head, extraHeads: extraCols.map((x) => x.h), cols: { name: colName(C.name), exp: colName(C.exp), lot: ledger ? `${colName(C.exp)} 날짜 + ${colName(C.line)}` : colName(C.lot) || inExp, qty: colName(C.qty), time: ledger ? (rows.some((x) => x.time) ? `${colName(C.exp)} 칸의 시간` : '') : colName(C.time) || (inExp && rows.some((x) => x.time) ? inExp : ''), yeast: yeastCols.map((y) => y.h).join(' → '), mold: colName(C.mold) } };
}

// ---------- 충진일지 배치(버퍼) 정리: 제조 시간으로 버퍼 고르기 + 같은 탱크·같은 품목의 잇따른 버퍼 합치기 ----------
const timeMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
const bufferNo = (b) => { const m = /버퍼\s*(\d+)/.exec((b && b.batchNo) || ''); return m ? +m[1] : null; };
export const bufferLabel = (batches) => { const nos = (batches || []).map(bufferNo).filter((v) => v != null); return !nos.length ? '' : nos.length > 1 ? `버퍼 ${Math.min(...nos)}~${Math.max(...nos)}` : `버퍼 ${nos[0]}`; };
export const spanText = (batches) => { const bs = batches || []; const s = bs.length ? bs[0].startTime : '', e = bs.length ? bs[bs.length - 1].endTime : ''; return s || e ? `${s || '?'}~${e || '?'}` : ''; };
/** 제조 시간이 있으면 (충진일·설비별로) 그 시간에 충진 중이던 버퍼(시작~종료 사이)만 남김. 없으면 그 시간 직전에 시작한 버퍼. 시간이 없는 배치는 판단할 수 없어 그대로 둠 */
function pickByTime(entries, time) {
  const tm = timeMin(time); if (tm == null) return { entries, note: '' };
  const st = (e) => e.batch ? timeMin(e.batch.startTime) : null, en = (e) => e.batch ? timeMin(e.batch.endTime) : null;
  const groups = new Map();
  for (const e of entries) { const k = e.batch ? `${e.batch.date}|${e.batch.fillerId}` : '-'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const out = []; const notes = new Set();
  for (const list of groups.values()) {
    const timed = list.filter((e) => st(e) != null && en(e) != null);
    const rest = list.filter((e) => !timed.includes(e));
    if (!timed.length) { out.push(...list); notes.add('충진 시간이 입력된 버퍼가 없어 전체 표시'); continue; }
    const covering = timed.filter((e) => st(e) <= tm && tm <= en(e));
    if (covering.length) { out.push(...covering, ...rest); notes.add('이 시간에 충진 중이던 버퍼만'); continue; }
    const before = timed.filter((e) => st(e) <= tm);
    if (before.length) { out.push(before[before.length - 1], ...rest); notes.add('이 시간에 충진 중인 버퍼가 없어 바로 앞 버퍼'); }
    else { out.push(...list); notes.add('첫 버퍼 시작 전 시간이라 전체 표시'); }
  }
  return { entries: out, note: `제조 ${time} · ${[...notes].join(' · ')}` };
}
/** 잇따른 버퍼가 같은 충진일·설비·품목·제품 LOT이고 면포 출처(탱크·종류)가 같으면 한 줄로: 수량·양품·계근·포수 합산 */
function mergeBuffers(entries) {
  const tankKey = (e) => e.cultures.map((x) => `${x.c.tankId}|${x.kind}|${x.source}`).sort().join(',');
  const out = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.batch && e.batch && last.batch.date === e.batch.date && last.batch.fillerId === e.batch.fillerId && last.p.productCode === e.p.productCode && normLot(last.p.productLot) === normLot(e.p.productLot) && last.cultures.length && e.cultures.length && tankKey(last) === tankKey(e)) {
      last.batches.push(e.batch); last.packs.push(e.p); last.qty += e.qty; last.goodEa += e.goodEa; last.inputKg += e.inputKg;
      for (const x of e.cultures) { const t = last.cultures.find((y) => y.c.id === x.c.id && y.kind === x.kind && y.source === x.source); if (t) { t.cloths += x.cloths; t.kg += x.kg; t.liters += x.liters; } else last.cultures.push(x); }
    } else out.push(e);
  }
  return out;
}
/** 충진 칸 둘째 줄: 버퍼 1~2 · 07:42~08:57 (버퍼 2개 합침) */
export const bufferText = (pk) => { const l = bufferLabel(pk.batches), s = spanText(pk.batches); const t = [l, s].filter(Boolean).join(' · '); return t ? `${t}${(pk.batches || []).length > 1 ? ` (버퍼 ${pk.batches.length}개 합침)` : ''}` : ''; };

/** 이름 후보: 앱 품목명 + BOM의 '사용처(완제품)' 이름(예: 패트와매트 플레인 → 충진-플콩 100g). 완제품 이름으로 적힌 클레임을 충진 품목으로 연결 */
export function productCandidates(state) {
  const out = [];
  for (const p of state.products || []) { out.push({ key: norm(p.name), name: p.name, code: p.code, via: '' }); if (p.code) out.push({ key: String(p.code).toLowerCase(), name: p.code, code: p.code, via: '' }); }
  const has = new Set((state.products || []).map((p) => p.code));
  for (const b of state.bom || []) {
    const code = b.productCode || b.id; if (!has.has(code)) continue;
    for (const u of b.usedIn || []) if (u && u.name) out.push({ key: norm(u.name), name: u.name, code, via: 'BOM' });
  }
  return out.filter((c) => c.key);
}
/** 클레임 제품명 → 앱 품목 후보들. 같음 > 클레임명이 후보명을 포함(긴 쪽 우선) > 후보명이 클레임명을 포함("알룰로스" → 알룰로스 100g·서울 알룰로스 100g 모두) > 후보명 단어가 모두 들어감.
 *  가장 높은 점수의 후보를 전부 돌려줌(품목 코드로 중복 제거). [{ product, via, matchedName }] */
/** 별칭 목록: 설정에 저장한 것 + 기본값. [{ key(norm), name, product }] 긴 이름부터 */
export function claimAliases(state) {
  const out = [];
  for (const a of state.settings.claimAliases || []) { const p = a && a.code ? productOf(state, a.code) : null; if (p && a.name) out.push({ key: norm(a.name), name: a.name, product: p }); }
  for (const a of DEFAULT_ALIASES) { const p = (state.products || []).find((x) => norm(x.name) === norm(a.productName)); if (p && !out.some((o) => o.key === norm(a.name))) out.push({ key: norm(a.name), name: a.name, product: p }); }
  return out.filter((a) => a.key).sort((a, b) => b.key.length - a.key.length);
}
export function matchProducts(state, name) {
  const cn = norm(name); if (!cn) return [];
  // 별칭이 먼저: "블루베리 130"이 들어 있으면 무조건 플콩 100g
  for (const a of claimAliases(state)) if (cn === a.key || cn.includes(a.key)) return [{ product: a.product, via: '별칭', matchedName: a.name }];
  const isSize = (t) => /^\d+(\.\d+)?(g|kg|ml|l)$/.test(t);
  const claimHasSize = /\d+(\.\d+)?\s*(g|kg|ml|l)\b/.test(cn);
  const scored = [];
  for (const c of productCandidates(state)) {
    const pn = c.key; let s = 0;
    if (pn === cn) s = 1000;
    else if (cn.includes(pn)) s = 500 + pn.length;
    else if (pn.includes(cn)) s = 300 + cn.length;
    else {
      // 단어 단위: 후보명의 단어가 모두 클레임명에 들어가면 됨. 클레임에 용량이 없으면 후보의 용량 단어(100g 등)는 빼고 봄 ("서울우유 알룰로스" → 서울 알룰로스 100g)
      let toks = shortName(c.name).toLowerCase().split(/\s+/).map((t) => t.replace(/[^\w가-힣.]/g, '')).filter(Boolean);
      if (!claimHasSize) toks = toks.filter((t) => !isSize(t));
      if (toks.length && toks.every((t) => cn.includes(t))) s = 100 + toks.join('').length;
    }
    if (s > 0) scored.push({ c, s });
  }
  if (!scored.length) return [];
  const top = Math.max(...scored.map((x) => x.s));
  const seen = new Set(); const out = [];
  for (const { c } of scored.filter((x) => x.s === top)) {
    if (seen.has(c.code)) continue; seen.add(c.code);
    const product = productOf(state, c.code); if (product) out.push({ product, via: c.via, matchedName: c.name });
  }
  return out;
}
/** 하위 호환: 첫 후보 하나 */
export function matchProduct(state, name) { const m = matchProducts(state, name); return m.length ? m[0].product : null; }

/** 클레임 줄마다 제품 LOT → 충진 배치 → 배양 LOT까지 추적. overrides[idx] = 사용자가 고른 품목코드 */
export function traceClaims(state, items, overrides = {}) {
  // 앱 입력 + 전산 백데이터(10월 엑셀) 포장 내역을 모두 찾음. 백데이터는 반출 기록이 없어 배양 LOT 대신 '충진일 배출 배양 LOT(참고)'를 붙임
  const batchById = new Map(allBatches(state).map((b) => [b.id, b]));
  const moveById = new Map(state.separations.map((s) => [s.id, s]));
  const cultureById = new Map(state.cultures.map((c) => [c.id, c]));
  const stockCache = new Map(); const stockOf = (id) => { if (!stockCache.has(id)) stockCache.set(id, cultureStock(state, id)); return stockCache.get(id); };
  const packs0 = allPacks(state).filter((p) => p.kind !== 'repack');
  // v271: 자사검사 1,000건 이상도 빠르게 — 제품 LOT·소비기한별 색인 (줄마다 전체 포장 내역을 훑지 않음)
  const byLot = new Map(); const byExp = new Map();
  for (const p of packs0) {
    const l = normLot(p.productLot); if (!byLot.has(l)) byLot.set(l, []); byLot.get(l).push(p);
    const e = p.expiry || lotExpiry(p.productLot); if (e) { if (!byExp.has(e)) byExp.set(e, []); byExp.get(e).push(p); }
  }
  // 자사검사 저장본에서 "정리"로 고른 배양 LOT: 제품 LOT + 제조시간 → 배양 LOT id
  const inspectPick = new Map();
  for (const d of state.claims || []) if ((d.kind || 'claim') === 'inspect') for (const x of d.items || []) if (x.pickCulture && x.lot && x.time) inspectPick.set(`${normLot(x.lot)}|${x.time}`, x.pickCulture);
  return items.map((it0, idx) => {
    // 입력 LOT는 매번 다시 해석 (저장본에 예전 규칙으로 읽힌 값이 남아 있어도 최신 규칙 적용: "2026.10. 27B4" → 26-1027 B4)
    const lot = it0.lotRaw ? erpLotToApp(it0.lotRaw) : (it0.lot || '');
    const it = { ...it0, lot, expiry: it0.expiry || lotExpiry(lot) };
    // 품목 후보: 사용자가 고른 것 > 이름으로 찾은 것(여러 개일 수 있음: "알룰로스" → 알룰로스 100g·서울 알룰로스 100g)
    const matches = overrides[idx] ? (productOf(state, overrides[idx]) ? [{ product: productOf(state, overrides[idx]), via: '선택', matchedName: '' }] : []) : it.name ? matchProducts(state, it.name) : [];
    const codes = new Set(matches.map((m) => m.product.code));
    // LOT로 찾기(띄어쓰기 무시): 같은 LOT, 또는 앞부분만 적은 LOT("26-1116", "26-1116 C")는 앞부분 일치. LOT로 못 찾으면 소비기한으로 다시 찾음(lotMiss)
    const byExpiry = () => it.expiry ? [...(byExp.get(it.expiry) || [])] : [];
    const lotKey = it.lot ? normLot(it.lot) : '';
    let cand = []; let lotMiss = false;
    if (lotKey) {
      cand = [...(byLot.get(lotKey) || [])];
      if (!cand.length) cand = packs0.filter((p) => { const l = normLot(p.productLot); return lotKey.length >= 7 ? l.startsWith(lotKey) : l.includes(lotKey); });
      if (!cand.length) { cand = byExpiry(); lotMiss = cand.length > 0; }
    } else cand = byExpiry();
    let byProduct = codes.size ? cand.filter((p) => codes.has(p.productCode)) : [];
    // v285: 별칭으로 품목이 정해졌는데(드링크·락토프리 등) 같은 LOT 글자가 다른 품목(요거트 충진 LOT)을 가리키면, 소비기한 + 그 품목으로 다시 찾음
    if (!byProduct.length && codes.size && it.lot && matches.some((m) => m.via === '별칭')) { const e = byExpiry().filter((p) => codes.has(p.productCode)); if (e.length) { byProduct = e; lotMiss = true; } }
    let status; let found;
    if (!it.lot && !it.expiry) { status = 'empty'; found = []; }
    else if (codes.size && byProduct.length) { found = byProduct; status = lotMiss ? 'lotMiss' : 'ok'; }
    else if (!codes.size && !it.lot) { status = 'noProduct'; found = []; }
    else if (cand.length && it.lot && !lotMiss) { found = cand; status = 'lotOnly'; }
    else { status = 'noPack'; found = []; }
    // v285: 드링크는 품질팀 LOT 앞 글자가 충진 요일(A=월 … G=일) — 소비기한으로 찾은 것 중 그 요일 충진만 남기면 추적 완료
    if (status === 'lotMiss' && found.length && found.every((p) => /^1DR/.test(p.productCode || ''))) {
      const m = /\s([A-G])\d$/.exec(it.lot || '');
      if (m) { const wd = 'ABCDEFG'.indexOf(m[1]) + 1; const f2 = found.filter((p) => { const b = batchById.get(p.batchId); const d = (b && b.date) || p.date; if (!d) return false; const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return (w === 0 ? 7 : w) === wd; }); if (f2.length) { found = f2; status = 'lotWd'; lotMiss = false; } }
    }
    // 찾은 제품 LOT의 품목이 하나면 그 품목으로 확정, 여럿이면 '품목 후보 여러 개'로 표시하고 사용자가 고르게 함
    const foundCodes = [...new Set(found.map((p) => p.productCode))];
    const product = foundCodes.length === 1 ? productOf(state, foundCodes[0]) || null : matches.length === 1 ? matches[0].product : null;
    const multi = foundCodes.length > 1;
    if (multi && status === 'ok') status = 'multi';
    const match = product ? matches.find((m) => m.product.code === product.code) || null : null;
    // 정렬: 충진일 → 제품 LOT → 설비 → 배치 시작시간 → 버퍼 번호 (버퍼 순서대로 놓여야 잇따른 버퍼를 합칠 수 있음)
    const bkey = (p) => { const b = batchById.get(p.batchId); if (!b) return '~'; const t = /^\d{2}:\d{2}$/.test(b.startTime || '') ? b.startTime : '99:99'; return `${b.fillerId}|${t}|${String(bufferNo(b) || 99).padStart(2, '0')}`; };
    const packs0s = found.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.productLot || '').localeCompare(String(b.productLot || '')) || bkey(a).localeCompare(bkey(b)));
    const packs1 = packs0s.map((p) => {
      const b = batchById.get(p.batchId) || null;
      const cultures = ((b && b.sources) || []).map((src) => {
        const c = cultureById.get(src.cultureId); if (!c) return null;
        const mv = src.moveId ? moveById.get(src.moveId) : null;
        const isPress = num(c.pressL) > 0;
        const source = (src.kind || 'cloth') === 'drink' ? 'drink' : mv && mv.source ? mv.source : isPress ? '' : 'room';
        return { c, tank: tankOf(state, c.tankId), kind: src.kind || 'cloth', cloths: num(src.cloths) || (mv ? num(mv.cloths) : 0), liters: num(src.liters), kg: num(src.kg) || (mv ? num(mv.kg) : 0), source, move: mv, splits: stockOf(c.id).splits };
      }).filter(Boolean).reduce((acc, x) => { // 같은 배양 LOT에서 여러 번 반출한 면포(5포+5포+7포)는 한 줄로 합산 (17포)
        const t = acc.find((y) => y.c.id === x.c.id && y.kind === x.kind && y.source === x.source);
        if (t) { t.cloths += x.cloths; t.kg += x.kg; t.liters += x.liters; } else acc.push(x);
        return acc;
      }, []);
      const legacy = !!(p.legacy || (b && b.legacy));
      const filler = b ? (b.fillerName && !(state.settings.fillers || []).some((f) => f.id === b.fillerId) ? { id: b.fillerId, name: b.fillerName } : fillerOf(state, b.fillerId)) : null;
      return { p, packs: [p], batch: b, batches: b ? [b] : [], qty: num(p.qty), goodEa: b ? num(b.goodEa) : 0, inputKg: b ? num(b.inputKg) : 0, filler, legacy, product: productOf(state, p.productCode) || (p.productName ? { code: p.productCode, name: p.productName, unit: 'ea' } : null), cultures, hintCultures: legacy && b && !cultures.length ? dischargeCandidates(state, b.date) : [] };
    });
    // 충진일지는 버퍼마다 배치를 나눠 저장하므로 제품 LOT 하나가 버퍼 수만큼 나옴 → 제조 시간으로 버퍼를 고르고, 같은 탱크·같은 품목의 잇따른 버퍼는 한 줄로 합침
    const picked = pickByTime(packs1, it.time);
    let packs = mergeBuffers(picked.entries);
    // 배양 LOT를 하나로 지정한 줄(자사검사 정리): 그 LOT가 들어간 제품 LOT만, 그 LOT 하나만 남김.
    // 직접 지정이 없어도 같은 제품 LOT · 같은 제조시간의 자사검사 줄이 고른 배양 LOT가 있으면 그것을 따름 (클레임 ↔ 자사검사 같은 버퍼)
    const pick = it.pickCulture || (it.lot && it.time ? inspectPick.get(`${normLot(it.lot)}|${it.time}`) : '') || '';
    if (pick) {
      const keepP = packs.filter((pk) => pk.cultures.some((x) => x.c.id === pick));
      if (keepP.length) packs = keepP.map((pk) => ({ ...pk, cultures: pk.cultures.filter((x) => x.c.id === pick) }));
    }
    // 품목명으로 못 맞춰 LOT로만 찾았는데(lotOnly), 제조시간으로 고른 버퍼의 품목이 하나뿐이면 그 품목으로 봄 (v263)
    let product2 = product;
    if (status === 'lotOnly' && it.time) { const cs = [...new Set(packs.map((pk) => pk.p.productCode))]; if (cs.length === 1) product2 = productOf(state, cs[0]) || product; }
    // v271: 이름은 못 맞췄어도 제품 LOT가 정확히 같고 제조시간에 충진 중이던 버퍼가 정해졌으면 추적 완료로 봄
    // (품질팀 엑셀의 완제품명 "요즘 플레인 그릭요거트 100g"은 충진 품목 플레인 100g·플콩 100g 어느 쪽도 될 수 있음. 한 버퍼에 여러 품목이 있어도 배양 LOT는 같음)
    if (status === 'lotOnly' && it.time && packs.length && /충진 중이던 버퍼만/.test(picked.note)) status = 'lotTime';
    // v285: 제품 LOT가 정확히 같고 그날 한 설비의 충진뿐이면(버퍼 시간으로 못 좁혀도) 추적 완료 — 그날 그 설비 버퍼의 배양 LOT
    else if (status === 'lotOnly' && lotKey && packs.length && packs.every((pk) => normLot(pk.p.productLot) === lotKey) && new Set(packs.map((pk) => pk.batch ? `${pk.batch.date}|${pk.batch.fillerId}` : '-')).size === 1) status = 'lotDay';
    // v310: 제품명이 짧아("플레인"·"알룰로스") 품목 후보가 여러 개여도, 제품 LOT가 정확히 같고 제조시간으로 버퍼가 정해졌으면(또는 그날 한 설비뿐이면) 추적 완료 — 같은 버퍼면 배양 LOT가 같음
    else if (status === 'multi' && lotKey && packs.length && packs.every((pk) => normLot(pk.p.productLot) === lotKey)) {
      if (it.time && /충진 중이던 버퍼만/.test(picked.note)) status = 'lotTime';
      else if (new Set(packs.map((pk) => pk.batch ? `${pk.batch.date}|${pk.batch.fillerId}` : '-')).size === 1) status = 'lotDay';
      if (status !== 'multi') { const cs = [...new Set(packs.map((pk) => pk.p.productCode))]; if (cs.length === 1) product2 = productOf(state, cs[0]) || product2; }
    }
    if (TRACED_ST.has(status) || status === 'lotOnly' || status === 'lotMiss' || status === 'multi') {
      const none = packs.filter((x) => !x.cultures.length).length;
      if (none === packs.length) status = packs.every((x) => x.legacy) ? 'legacy' : 'noTrace'; else if (none > 0 && TRACED_ST.has(status)) status = 'partial';
    }
    return { idx, it, product: product2, match, matches, multi, packs, status, lotMiss, timeNote: picked.note };
  });
}

// 표·엑셀·PDF 공용 문구 (짧게: 배양 LOT 2줄, 충진 2줄)
//  배양 1줄: 260930T03-01 (26.09.29 배양) 원유 5,000L (필터프레스 705L 사용)   2줄: 반출 26.10.01 14포
const cultureLine1 = (x) => `${x.c.lot} (${yy(x.c.date)} 배양)${num(x.c.rawL) ? ` 원유 ${n(x.c.rawL)}L` : ''}${num(x.c.pressL) > 0 && x.source === 'press' ? ` (필터프레스 ${n(x.c.pressL)}L 사용)` : ''}${num(x.c.drinkL) > 0 ? ` (드링크 ${n(x.c.drinkL)}L)` : ''}`;
const cultureLine2 = (x) => x.kind === 'drink' ? `드링크 원액 ${n(x.liters)}L` : `${x.move ? `반출 ${yy(x.move.date)} ` : '배치에 직접 '}${x.source === 'press' && x.kg ? `필터프레스 ${n(x.kg, 1)}kg (≈${n(x.cloths, 1)}포)` : `${n(x.cloths)}포`}`;
const UNIT = (u) => String(u || 'ea').toUpperCase();
// 첫 열은 접수일: 엑셀에서 가져온 열 중 '접수'가 들어간 열(접수일·접수 날짜 …)의 값. 없으면 번호
// 자사검사는 '검사일' 열이 접수일 역할
// 저장본 이름 비교: 내려받기 번호 "(1)"·대소문자·띄어쓰기는 무시 ("클레임 관리대장_2026 (1).xlsx · 2026.11" = "클레임 관리대장_2026.xlsx · 2026.11")
const sameDocName = (a, b) => { const k = (s) => String(s || '').toLowerCase().replace(/\s*\(\d+\)(?=\.\w+)/g, '').replace(/\s+/g, ''); return !!a && k(a) === k(b); };
export const isReceipt = (k) => /접수(?!\s*(자|처|경로|채널|내용))|검사\s*일|검사\s*날짜/.test(String(k || '')); // v309: 접수자(사람 이름)는 날짜 아님
export const receiptOf = (r) => { const f = (r.it.extras || []).find(([k]) => isReceipt(k)); return f ? f[1] : ''; };
/** 부적합 종류: claim = 클레임(고객 접수), inspect = 자사검사. 저장본은 같은 claims 모음에 kind로 구분 (kind 없는 예전 저장본 = 클레임) */
export const NCR_KINDS = { claim: { word: '클레임', date: '접수일' }, inspect: { word: '자사검사', date: '검사일' } };
export const kindOf = (doc) => (doc && doc.kind) || 'claim';
//  충진 1줄: 2호기 2026.10.01(목)   2줄: 양품 31,904 EA, 계근 3,575 KG
const fillText = (r) => r.batch ? `${r.filler.name} ${fmtDate(r.batch.date)}(${dow(r.batch.date)})` : '충진 배치 없음';
const fillText2 = (r) => r.batch ? `양품 ${n(r.goodEa)} EA${num(r.inputKg) ? `, 계근 ${n(r.inputKg)} KG` : ''}` : '';

export function ClaimPage({ state, go, kind = 'claim' }) {
  const W = NCR_KINDS[kind].word, RD = NCR_KINDS[kind].date; // 화면 문구: 클레임 / 자사검사, 접수일 / 검사일
  const [file, setFile] = useState(null);
  const [items, setItems] = useState([]);
  const [extraHeads, setExtraHeads] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [cols, setCols] = useState(null); // 올린 엑셀에서 어떤 머리글을 제품명·소비기한·LOT·수량으로 읽었는지
  // 저장본(공유 저장소 claims): 올린 목록을 저장해 두면 새로고침해도 남고, 다른 사람도 같은 목록을 봄
  const [loadedId, setLoadedId] = useState(null); // 지금 화면이 어느 저장본에서 왔는지
  const [dirty, setDirty] = useState(false);      // 저장본과 달라졌는지
  const savedSets = useMemo(() => [...(state.claims || [])].filter((d) => kindOf(d) === kind).sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || ''))), [state.claims]);
  const [loadedAt, setLoadedAt] = useState(''); // 불러온 저장본의 savedAt (v279: 저장본이 바뀌면 다시 불러오려고)
  const loadSet = (doc) => { if (!doc) return; setItems(doc.items || []); setOverrides(doc.overrides || {}); setExtraHeads(doc.extraHeads || []); setFile(null); setCols(null); setErr(''); setLoadedId(doc.id); setLoadedAt(doc.savedAt || ''); setDirty(false); };
  // 페이지를 열었을 때 화면이 비어 있으면 가장 최근 저장본을 자동으로 불러옴
  useEffect(() => { if (!items.length && !loadedId && savedSets.length) loadSet(savedSets[0]); }, [savedSets.length]);
  // 불러온 저장본이 다른 곳에서 바뀌었고(저장 시각이 다름) 이 화면에 저장 안 한 수정이 없으면 새 내용으로 다시 불러옴
  const loadedDoc = loadedId ? savedSets.find((s) => s.id === loadedId) : null;
  useEffect(() => { if (loadedDoc && !dirty && (loadedDoc.savedAt || '') !== loadedAt) loadSet(loadedDoc); }, [loadedDoc && loadedDoc.savedAt, loadedDoc && (loadedDoc.items || []).length]);
  const saveSet = async () => {
    if (!items.length) return;
    const prev = loadedId ? savedSets.find((s) => s.id === loadedId) : null;
    // v309: 같은 파일·같은 시트(예: 관리대장 · 2026.11)를 다시 올려 저장하면 새 저장본을 만들지 않고 예전 것을 바꿈 (현황에 두 번 세지 않게)
    const same = !loadedId && file ? savedSets.find((s) => sameDocName(s.name, fileDocName())) : null;
    if (same && !(await confirmAsync(`같은 엑셀·시트의 저장본 "${same.name}" (${n((same.items || []).length)}건)이 있습니다. 새로 올린 ${n(items.length)}건으로 바꿀까요? (그 저장본에서 고른 품목 선택은 없어집니다)`, { ok: '바꿔 저장' }))) return;
    const doc = { id: loadedId || (same && same.id) || uid(), kind, name: file ? fileDocName() : prev ? prev.name : `${W} ${fmtDate(today())}`, savedAt: new Date().toISOString(), items, overrides, extraHeads };
    try { await save('claims', doc); setLoadedId(doc.id); setLoadedAt(doc.savedAt); setDirty(false); toast(`"${doc.name}" ${n(items.length)}건을 저장했습니다.`); }
    catch (e) { toast(`저장 실패: ${e.message || e}`, 'bad'); }
  };
  const deleteSet = async () => {
    const cur = savedSets.find((s) => s.id === loadedId); if (!cur) return;
    if (!(await confirmAsync(`저장본 "${cur.name}" (${n((cur.items || []).length)}건)을 지울까요?`))) return;
    await remove('claims', cur.id); setLoadedId(null); setItems([]); setOverrides({}); setExtraHeads([]); setDirty(false);
  };
  // 품목 선택을 별칭으로 기억: 이 클레임 제품명은 앞으로 항상 그 품목으로
  const rememberAlias = async (name, code) => {
    if (!name || !code) return;
    const list = (state.settings.claimAliases || []).filter((a) => norm(a.name) !== norm(name)).concat([{ name: String(name).trim(), code }]);
    await saveSettings({ claimAliases: list });
    toast(`"${name}" → ${shortName((productOf(state, code) || {}).name || code)} 으로 기억했습니다.`);
  };
  const setOverride = (idx, code) => { setOverrides({ ...overrides, [idx]: code }); setDirty(true); };
  // 직접 입력(엑셀 없이 한두 건 확인용)
  const [mName, setMName] = useState('');
  const [mExp, setMExp] = useState('');
  const [mLot, setMLot] = useState('');
  const [mTime, setMTime] = useState('');

  // 클레임 접수 엑셀 양식: 읽을 수 있는 머리글 + 예시 한 줄. 접수일·클레임 내용처럼 머리글에 없는 열은 그대로 표에 따라옴
  const saveTemplate = async () => {
    try {
      const XLSX = await loadXLSX();
      const head = [RD, '제품명', '소비기한', 'LOT', '제조시간', '수량', `${W} 내용`];
      const sample = [fmtDate(today()), '서울 플레인 100g', '2026.11.17', '26-1117 A3', '08:30', 1, '예시 줄입니다 · 지우고 쓰세요'];
      const ws = XLSX.utils.aoa_to_sheet([head, sample]);
      ws['!cols'] = [12, 24, 12, 13, 9, 7, 40].map((w) => ({ wch: w }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, W);
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      await saveFile(kind === 'inspect' ? '자사검사_양식.xlsx' : '클레임_접수_양식.xlsx', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) { toast(`양식 저장 실패: ${e.message || e}`, 'bad'); }
  };
  // v309: 시트가 여러 개(월별 관리대장)면 시트를 골라 다시 읽음
  const [fileBuf, setFileBuf] = useState(null);
  const [sheetInfo, setSheetInfo] = useState(null); // { sheet, sheets[], skipped, ledger }
  const onFile = async (f, sheetName, buf0) => {
    if (!f) return;
    setBusy(true); setErr(''); setFile(f);
    try {
      const buf = buf0 || await f.arrayBuffer(); setFileBuf(buf);
      const res = await parseClaimXlsx(buf, sheetName);
      setSheetInfo({ sheet: res.sheet, sheets: res.sheets, skipped: res.skipped, ledger: res.ledger });
      if (!res.rows.length) throw new Error(`"${res.sheet}" 시트에 읽을 수 있는 ${W} 줄이 없습니다. 머리글 아래에 제품명·소비기한이 적힌 줄이 있어야 합니다.`);
      setItems(res.rows); setExtraHeads(res.extraHeads); setOverrides({}); setCols(res.cols); setLoadedId(null); setDirty(true);
      toast(`${res.sheets.length > 1 ? `"${res.sheet}" 시트 ` : ''}${W} ${n(res.rows.length)}건을 읽었습니다.${res.skipped ? ` (서비스 클레임 ${n(res.skipped)}건 제외)` : ''} "저장"을 누르면 새로고침해도 남습니다.`);
    } catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
  };
  const fileDocName = () => file ? (sheetInfo && sheetInfo.sheets.length > 1 ? `${file.name} · ${sheetInfo.sheet}` : file.name) : '';
  const addManual = () => {
    const p = mName ? productOf(state, mName) : null;
    const lot = mLot.trim() ? erpLotToApp(mLot.trim()) : '';
    const expiry = mExp || lotExpiry(lot);
    if (!p && !lot) { toast('품목을 고르거나 LOT를 입력하세요.', 'bad'); return; }
    if (!expiry && !lot) { toast('소비기한을 입력하세요.', 'bad'); return; }
    setItems([...items, { row: 0, name: p ? shortName(p.name) : '', lotRaw: mLot.trim(), lot, expiry, expRaw: mExp, qty: 0, time: parseTime(mTime), extras: [], manual: true }]);
    if (p) setOverrides({ ...overrides, [items.length]: p.code });
    setMLot(''); setMExp(''); setMTime(''); setDirty(true);
  };
  const clearAll = () => { setItems([]); setOverrides({}); setFile(null); setFileBuf(null); setSheetInfo(null); setExtraHeads([]); setErr(''); setCols(null); setLoadedId(null); setDirty(false); };
  const removeItem = (idx) => { setItems(items.filter((_, i) => i !== idx)); const o = {}; Object.entries(overrides).forEach(([k, v]) => { const i = +k; if (i < idx) o[i] = v; else if (i > idx) o[i - 1] = v; }); setOverrides(o); setDirty(true); };

  const results = useMemo(() => traceClaims(state, items, overrides), [state, items, overrides]);
  const counts = useMemo(() => { const c = { ok: 0, warn: 0, bad: 0 }; for (const r of results) { if (TRACED_ST.has(r.status)) c.ok++; else if (['partial', 'noTrace', 'lotOnly', 'lotMiss', 'multi', 'legacy'].includes(r.status)) c.warn++; else c.bad++; } return c; }, [results]); // groupOf와 같은 기준
  const products = useMemo(() => [...(state.products || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko')), [state.products]);

  // 상태 카드를 누르면 그 상태만 표시(표·PDF·엑셀 모두): all · ok(추적 완료) · warn(확인 필요) · bad(확인 불가)
  const [filter, setFilter] = useState('all');
  const groupOf = (r) => TRACED_ST.has(r.status) ? 'ok' : ['partial', 'noTrace', 'lotOnly', 'lotMiss', 'multi', 'legacy'].includes(r.status) ? 'warn' : 'bad';
  const shown = useMemo(() => filter === 'all' ? results : results.filter((r) => groupOf(r) === filter), [results, filter]);

  // 정리: 확인 필요 줄은 지우고, 추적 완료 줄 중 배양 LOT가 여러 개면 "면포/필터프레스" 열(T열)과 출처가 같은 LOT 중
  // 그 버퍼에 가장 많이 들어간 것(면포 포 수, 필터프레스는 kg) 하나만 남김. 저장본에 바로 저장
  const srcOfItem = (it) => { const f = (it.extras || []).find(([k]) => /면포\s*\/\s*필터프레스/.test(k)); return f ? String(f[1]).trim() : ''; };
  const tidyPlan = useMemo(() => {
    let drop = 0, multi = 0;
    for (const r of results) {
      if (groupOf(r) === 'warn') { drop++; continue; }
      if (r.it.pickCulture) continue;
      if (new Set(r.packs.flatMap((pk) => pk.cultures.map((x) => x.c.id))).size > 1) multi++;
    }
    return { drop, multi };
  }, [results]);
  const tidy = async () => {
    if (!(await confirmAsync(`확인 필요 ${n(tidyPlan.drop)}건을 지우고, 배양 LOT가 여러 개인 추적 완료 ${n(tidyPlan.multi)}건은 면포/필터프레스 열 기준으로 배양 LOT 1개만 남깁니다. 저장본에 바로 저장할까요?`, { ok: '정리 후 저장', danger: tidyPlan.drop > 0 }))) return;
    const keep = []; const ov = {}; let picked = 0, noMatch = 0;
    for (const r of results) {
      if (groupOf(r) === 'warn') continue;
      const it = { ...items[r.idx] };
      const acc = new Map();
      for (const pk of r.packs) for (const x of pk.cultures) { const t = acc.get(x.c.id) || { x, cloths: 0, kg: 0 }; t.cloths += num(x.cloths); t.kg += num(x.kg); acc.set(x.c.id, t); }
      if (!it.pickCulture && acc.size > 1) {
        const src = srcOfItem(it); const wantPress = /필터|프레스|FP/i.test(src);
        const all = [...acc.values()];
        const exact = all.filter((t) => (wantPress ? t.x.source === 'press' : t.x.source === 'room'));
        const loose = all.filter((t) => t.x.source === '' && (wantPress ? num(t.x.c.pressL) > 0 : true));
        let cand = exact.length ? exact : loose.length ? loose : all; if (!exact.length && !loose.length) noMatch++;
        const best = cand.sort((a, b) => (wantPress ? b.kg - a.kg : b.cloths - a.cloths) || String(a.x.c.lot).localeCompare(String(b.x.c.lot)))[0];
        it.pickCulture = best.x.c.id; it.pickNote = `${src || '구분 없음'} 기준 · 배양 LOT ${acc.size}개 중 1개`; picked++;
      }
      if (overrides[r.idx]) ov[keep.length] = overrides[r.idx];
      keep.push(it);
    }
    const prev = loadedId ? savedSets.find((s) => s.id === loadedId) : null;
    const doc = { id: loadedId || uid(), kind, name: file ? fileDocName() : prev ? prev.name : `${W} ${fmtDate(today())}`, savedAt: new Date().toISOString(), items: keep, overrides: ov, extraHeads };
    try { await save('claims', doc); setItems(keep); setOverrides(ov); setLoadedId(doc.id); setLoadedAt(doc.savedAt); setDirty(false); setFilter('all');
      toast(`${n(results.length - keep.length)}건을 지우고 ${n(picked)}건을 배양 LOT 1개로 정리해 저장했습니다.${noMatch ? ` (출처가 맞는 LOT가 없어 전체 중에서 고른 건 ${n(noMatch)}건)` : ''}`); }
    catch (e) { toast(`저장 실패: ${e.message || e}`, 'bad'); }
  };
  // 표 한 줄 = 클레임 × 제품 LOT (제품 LOT가 없으면 클레임만 한 줄)
  // v274 자사검사: 같은 제품 LOT의 검사(초·중·말)를 한 묶음으로 봄. 효모·곰팡이가 모두 <10(0)인 묶음은 표 맨 아래로 내리고 접어 둠.
  // 묶음 안 어느 단계라도 검출(효모·곰팡이 10 이상·TNTC)이 있으면 묶음 전체를 위에 남김. 결과 대기 줄은 숨기지 않음
  const probOf = (r) => (r.it.yeast != null && r.it.yeast > 0) || (r.it.mold != null && r.it.mold > 0);
  const gkeyOf = (r) => r.it.lot ? `${normLot(r.it.lot)}|${norm(r.it.name)}` : `${r.it.expiry || ''}|${norm(r.it.name)}|${receiptOf(r) || ''}`; // 제품 LOT + 제품명 (한 LOT에 여러 품목이 있으므로)
  const grouping = useMemo(() => { const bad = new Set(), all = new Map(); for (const r of results) { const k = gkeyOf(r); if (!all.has(k)) all.set(k, []); all.get(k).push(r); if (probOf(r)) bad.add(k); } return { bad, all }; }, [results]);
  const isClean = (r) => kind === 'inspect' && r.it.yeast != null && !grouping.bad.has(gkeyOf(r));
  const ordered = useMemo(() => {
    if (kind !== 'inspect') return { vis: shown, hid: [] };
    const first = new Map(); shown.forEach((r, i) => { const k = gkeyOf(r); if (!first.has(k)) first.set(k, i); });
    const byGroup = (a, b) => first.get(gkeyOf(a)) - first.get(gkeyOf(b)) || a.idx - b.idx; // 같은 LOT 묶음끼리 붙여 놓음
    const vis = shown.filter((r) => !isClean(r)).sort(byGroup), hid = shown.filter(isClean).sort(byGroup);
    return { vis, hid };
  }, [shown, grouping, kind]);
  const [showHidden, setShowHidden] = useState(false);
  // 표 한 줄 = 검사 × 제품 LOT. 배양 LOT 연결이 없는 제품 LOT 줄(전산 백데이터 없음)은 같은 검사에 연결된 다른 줄이 있으면 뺌 (v274)
  const toFlat = (list) => { let prev = null; return list.flatMap((r) => { const k = gkeyOf(r); const gFirst = k !== prev; prev = k;
    const pks = r.packs.filter((pk) => pk.cultures.length); const use = pks.length ? pks : r.packs;
    return use.length ? use.map((pk, j) => ({ r, pk, first: j === 0, gFirst: gFirst && j === 0, lines: Math.max(3, pk.cultures.length * 2 || (pk.legacy ? 3 : 1)) })) : [{ r, pk: null, first: true, gFirst, lines: 2 }]; }); };
  const flat = useMemo(() => toFlat(ordered.vis), [ordered]);
  // ---------- v275 자사검사 표: 같은 제품 LOT·제품의 초·중·말을 한 줄로, 검사 항목을 칸으로 (사용자 그림대로) ----------
  // 칸 값이 단계마다 같으면 하나만, 다르면 "초 : <10 / 중 : <10 / 말 : 1,000"처럼 세로로. 검출(10 이상·TNTC·양성) 단계는 빨강 굵게
  const TESTS = [['대장균', '대장균군'], ['일반세균', '일반세균'], ['살모넬라', '살모넬라'], ['황색포도\n상구균', '황색포도상구균'], ['효모\n(3일차)', '효모/곰팡이 (3일차)'], ['효모\n(4일차)', '효모/곰팡이 (4일차)'], ['효모\n(5일차)', '효모 (5일차)'], ['곰팡이', '곰팡이']];
  const exv = (r, h) => { const f = (r.it.extras || []).find(([k]) => k === h); return f ? String(f[1]).trim() : ''; };
  const stOf = (r) => { const s = exv(r, '구분'); return ['초', '중', '말'].includes(s) ? s : '기타'; };
  const normV = (v) => { const ps = String(v).split('/').map((s) => s.trim()).filter(Boolean); return new Set(ps).size === 1 ? ps[0] : ps.join(' / '); };
  const badV = (v) => /양성/.test(v) || (!/예정/.test(v) && (parseCount(v) ?? 0) > 0);
  const fmtV = (v) => /^\d[\d,]*$/.test(v) ? n(Number(v.replace(/,/g, ''))) : /예정/.test(v) ? v.replace(/(\d+)월\s*(\d+)일\s*예정/, '$1/$2 예정') : v;
  const RED = 'color:var(--bad);font-weight:700';
  // v281: 일반세균·살모넬라·황색포도상구균은 양성이거나 검출 수치(10 이상)가 있을 때만 — 칸도 표 안에 그런 값이 있을 때만 보임
  const OPTIONAL = new Set(['일반세균', '살모넬라', '황색포도상구균']);
  const shownTests = (groups) => TESTS.filter(([, h]) => !OPTIONAL.has(h) || groups.some((g) => g.rs.some((r) => badV(normV(exv(r, h))))));
  const testCell = (rs, h) => {
    const vals = rs.map((r) => ({ st: stOf(r), v: normV(exv(r, h)) })).filter((x) => x.v && !/^[-–—]$/.test(x.v) && (!OPTIONAL.has(h) || badV(x.v)));
    if (!vals.length) return '';
    // 묶음의 모든 검사가 같은 값일 때만 하나로 (일부 검사에만 값이 있으면 어느 단계 값인지 보이게 단계를 붙임)
    if (new Set(vals.map((x) => x.v)).size === 1 && (vals.length === rs.length || new Set(rs.map(stOf)).size === 1)) { const v = vals[0].v; return html`<span style=${badV(v) ? RED : /예정/.test(v) ? 'color:var(--fg-3)' : ''}>${fmtV(v)}</span>`; }
    return html`${['초', '중', '말', '기타'].map((s) => { const xs = vals.filter((x) => x.st === s); if (!xs.length) return '';
      // v282: 검출된 값만 나열하고 <10은 감춤. 그 단계가 전부 <10(검출 없음)이면 <10을 한 번만
      const det = xs.filter((x) => badV(x.v)); const list = det.length ? det.map((x) => x.v) : [...new Set(xs.map((x) => x.v))];
      return html`<div key=${s} style=${det.length ? RED : ''}>${s === '기타' ? '' : `${s} : `}${list.map(fmtV).join(', ')}</div>`; })}`;
  };
  // 연속된 같은 묶음끼리 모음 (ordered에서 이미 붙어 있음)
  const toGroups = (list) => { const out = []; for (const r of list) { const k = gkeyOf(r); const last = out[out.length - 1]; if (last && last.key === k) last.rs.push(r); else out.push({ key: k, rs: [r] }); } return out; };
  const groupsVis = useMemo(() => toGroups(ordered.vis), [ordered]);
  const groupsHid = useMemo(() => toGroups(ordered.hid), [ordered]);
  // v283: 묶음의 제품 LOT와 정확히 같은 포장 내역만 (LOT가 안 맞아 소비기한으로 찾은 다른 날·다른 호기 충진은 뺌). 같은 게 없으면 전부
  // v284: 같은 LOT가 없으면(드링크처럼 품질팀 LOT 글자가 사이트와 다름) 요일로 거름 — 품질팀 드링크 LOT "A1"은 앞 글자가 요일(A=월 … G=일),
  //        그 밖에는 LOT 끝 숫자가 요일(1=월 … 7=일). 충진일 요일이 맞는 포장 내역만 남김
  const wdOf = (iso) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
  const groupPacks = (rs) => {
    const all = rs.flatMap((r) => r.packs); const lot = rs[0] && rs[0].it.lot ? rs[0].it.lot : ''; const lk = lot ? normLot(lot) : '';
    const same = lk ? all.filter((pk) => normLot(pk.p.productLot) === lk) : []; if (same.length) return same;
    const m = /\s([A-Z])(\d)$/.exec(lot || '');
    if (m) {
      const isDrink = all.some((pk) => /^1DR/.test(pk.p.productCode || '') || (pk.filler && /드링크/.test(pk.filler.name || '')));
      const wd = isDrink && m[1] <= 'G' ? 'ABCDEFG'.indexOf(m[1]) + 1 : +m[2];
      const byWd = all.filter((pk) => { const d = pk.batch ? pk.batch.date : pk.p.date; return d && wdOf(d) === wd; });
      if (byWd.length) return byWd;
    }
    return all;
  };
  const fillDays = (rs) => { const m = new Map(); for (const pk of groupPacks(rs)) { const d = pk.batch ? pk.batch.date : pk.p.date; if (!d) continue; const k = `${d}|${pk.filler ? pk.filler.name : ''}`; if (!m.has(k)) m.set(k, { d, f: pk.filler ? pk.filler.name : '' }); } return [...m.values()].sort((a, b) => a.d.localeCompare(b.d)); };
  const inspectTable = (groups, pdf, T = shownTests(groups)) => html`<table class="tbl claim-tbl insp-tbl ${pdf ? 'pdf-tbl' : ''}">
    <colgroup><col style="width:6%" /><col style="width:18%" /><col style="width:11%" /><col style="width:9%" />${T.map(([l]) => html`<col key=${l} style=${`width:${(56 / T.length).toFixed(2)}%`} />`)}</colgroup>
    <thead><tr class="r1"><th rowSpan="2">${RD}</th><th rowSpan="2">${W} 제품 · 소비기한</th><th rowSpan="2">제품 LOT · 품목</th><th rowSpan="2">충진일</th><th colSpan=${T.length} style="text-align:center;border-bottom:1px solid var(--line)">자사 검사</th></tr>
      <tr class="r2">${T.map(([l]) => html`<th key=${l} class="t">${l}</th>`)}</tr></thead>
    <tbody>${groups.map((g) => { const r0 = g.rs[0]; const it = r0.it; const dates = [...new Set(g.rs.map((r) => receiptOf(r)).filter(Boolean))];
      const times = [...new Set(g.rs.map((r) => r.it.time).filter(Boolean))].sort();
      const gp = groupPacks(g.rs); const pk0 = gp[0] || null; const pnames = [...new Set(gp.map((pk) => pk.product ? shortName(pk.product.name) : pk.p.productCode))];
      // v286: 품목마다 그 포장 내역(제품 LOT + 품목) 하나 — 누르면 LOT 추적에서 그 LOT·품목을 바로 고름
      const pkByName = []; { const seen = new Set(); for (const pk of gp) { const nm = pk.product ? shortName(pk.product.name) : pk.p.productCode; const k = `${pk.p.productLot}|${pk.p.productCode}`; if (seen.has(k)) continue; seen.add(k); pkByName.push({ nm, pk }); } }
      const fd = fillDays(g.rs);
      return html`<tr key=${g.key}>
        <td class="c-date">${dates.length ? html`${String(dates[0]).replace(/^\d{4}\./, '')}${dates.length > 1 ? html`<div class="l2 muted">외 ${dates.length - 1}일</div>` : ''}` : html`<span class="muted">—</span>`}</td>
        <td class="wrap c-prod"><b>${it.name || '(제품명 없음)'}</b><div class="l2">소비기한 ${it.expiry ? `${fmtDate(it.expiry).slice(2)}(${dow(it.expiry)})` : it.expRaw || '—'}</div>${times.length ? html`<div class="l2 muted">제조 ${times.join(' · ')}</div>` : ''}${g.rs.length > 1 ? html`<div class="l2 muted">검사 ${g.rs.length}건</div>` : ''}</td>
        <td class="wrap c-lot">${pk0 ? html`${pdf ? html`<b class="lot">${lot7(pk0.p.productLot)}</b>` : html`<button class="linkish" style="font-weight:700" title="LOT 추적에서 이 제품 LOT·품목 열기" onClick=${() => openPack(pk0)}>${lot7(pk0.p.productLot)}</button>`}<div class="l2" title=${pnames.join(', ')}>${pdf ? html`${pnames.slice(0, 2).join(', ')}${pnames.length > 2 ? html` <span class="muted">외 ${pnames.length - 2}</span>` : ''}` : html`${pkByName.slice(0, 2).map((x, i) => html`${i ? ', ' : ''}<button key=${i} class="linkish" style="color:inherit" title=${`LOT 추적에서 ${lot7(x.pk.p.productLot)} · ${x.nm} 열기`} onClick=${() => openPack(x.pk)}>${x.nm}</button>`)}${pkByName.length > 2 ? html` <span class="muted" title=${pkByName.slice(2).map((x) => x.nm).join(', ')}>외 ${pkByName.length - 2}</span>` : ''}`}</div>` : html`<b>${it.lot || '—'}</b><div class="l2 muted">제품 LOT 못 찾음</div>`}</td>
        <td class="c-fill">${fd.length ? fd.map((x, i) => html`<div key=${i}>${fmtDate(x.d).slice(5)}(${dow(x.d)})${x.f ? html` <span class="muted">${x.f}</span>` : ''}</div>`) : html`<span class="muted">—</span>`}</td>
        ${T.map(([l, h]) => html`<td key=${l} class="t">${testCell(g.rs, h)}</td>`)}
      </tr>`; })}</tbody></table>`;
  const pdfPages = []; { const src = kind === 'inspect' ? groupsVis.map((g) => ({ g, lines: Math.max(2, new Set(g.rs.map(stOf)).size) + 1 })) : flat; let cur = [], lines = 0; for (const x of src) { if (cur.length && lines + x.lines > PDF_LINES) { pdfPages.push(cur); cur = []; lines = 0; } cur.push(kind === 'inspect' ? x.g : x); lines += x.lines; } if (cur.length) pdfPages.push(cur); }

  // ---------- 엑셀 저장: 시트1 = 클레임 × 제품 LOT × 배양 LOT 한 줄씩(필터·정렬용), 시트2 = 올린 클레임 줄과 확인 결과 ----------
  const saveXlsx = async () => {
    if (!results.length) return;
    try {
      const XLSX = await loadXLSX();
      // 화면 표와 같은 항목만: 클레임(제품명·소비기한·가져온 열) / 제품 LOT·품목·수량 / 설비·충진일·양품·계근 / 배양 LOT·배양일·원유·필터프레스·반출
      const head1 = [RD, `${W} 제품명`, '소비기한', '제조시간', ...extraHeads, '확인 결과', '제품 LOT', '품목', '수량', '설비', '버퍼 · 시간', '충진일', '양품 (EA)', '계근 (KG)', '배양 LOT', '배양일', '원유 (L)', '필터프레스 (L)', '반출일', '반출 포수'];
      const rows1 = [];
      for (const r of shown) {
        const ex = extraHeads.map((h) => { const f = r.it.extras.find(([k]) => k === h); return f ? f[1] : ''; });
        const base = [receiptOf(r) || r.idx + 1, r.it.name, r.it.expiry ? fmtDate(r.it.expiry) : r.it.expRaw, r.it.time || '', ...ex, STATUS[r.status].label];
        if (!r.packs.length) { rows1.push([...base, '', '', '', '', '', '', '', '', '', '', '', '', '', '']); continue; }
        for (const pk of r.packs) {
          const pb = [lot7(pk.p.productLot), pk.product ? shortName(pk.product.name) : pk.p.productCode, pk.qty, pk.filler ? pk.filler.name : '', bufferText(pk), pk.batch ? fmtDate(pk.batch.date) : fmtDate(pk.p.date), pk.batch ? pk.goodEa : '', pk.batch && pk.inputKg ? pk.inputKg : ''];
          if (!pk.cultures.length) { rows1.push([...base, ...pb, pk.legacy ? (pk.hintCultures.length ? `(참고) 충진일 배출: ${pk.hintCultures.map((c) => c.lot).join(', ')}` : '전산 백데이터 · 반출 기록 없음') : '면포 미연결', '', '', '', '', '']); continue; }
          for (const x of pk.cultures) rows1.push([...base, ...pb, x.c.lot, fmtDate(x.c.date), num(x.c.rawL), num(x.c.pressL) > 0 ? num(x.c.pressL) : '', x.kind === 'drink' ? '드링크 원액' : x.move ? fmtDate(x.move.date) : '직접', x.kind === 'drink' ? `${n(x.liters)}L` : num(x.cloths)]);
        }
      }
      const head2 = [RD, `${W} 제품명`, '소비기한', '제조시간', ...extraHeads, '확인 결과', '제품 LOT', '배양 LOT'];
      const rows2 = shown.map((r) => [receiptOf(r) || r.idx + 1, r.it.name, r.it.expiry ? fmtDate(r.it.expiry) : r.it.expRaw, r.it.time || '', ...extraHeads.map((h) => { const f = r.it.extras.find(([k]) => k === h); return f ? f[1] : ''; }), STATUS[r.status].label, [...new Set(r.packs.map((pk) => lot7(pk.p.productLot)))].join(', '), [...new Set(r.packs.flatMap((pk) => pk.cultures.map((x) => x.c.lot)))].join(', ')]);
      const wb = XLSX.utils.book_new();
      const mk = (name, head, rows, widths) => { const ws = XLSX.utils.aoa_to_sheet([head, ...rows]); ws['!cols'] = head.map((h, i) => ({ wch: widths[i] || 14 })); if (rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: head.length - 1 } }) }; XLSX.utils.book_append_sheet(wb, ws, name); };
      const exW = extraHeads.map(() => 16);
      mk(`${W} LOT 추적`, head1, rows1, [5, 24, 12, 9, ...exW, 18, 13, 16, 9, 8, 22, 14, 10, 10, 16, 12, 9, 12, 12, 9]);
      mk(`${W} 목록`, head2, rows2, [5, 24, 12, 9, ...exW, 18, 28, 40]);
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      await saveFile(`${W}LOT_${today()}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) { toast(`엑셀 저장 실패: ${e.message || e}`, 'bad'); }
  };

  // ---------- PDF: 캡처 중(shooting)에만 화면 아래에 A4 페이지를 그려 html2canvas로 찍음 ----------
  const [shooting, setShooting] = useState(false);
  const savePdf = async () => {
    if (shooting || !flat.length) return;
    setShooting(true);
    try {
      const mod = await import('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.esm.js');
      const h2c = mod.default || window.html2canvas;
      await new Promise((r) => setTimeout(r, 150));
      const bg = getComputedStyle(document.body).backgroundColor;
      const images = [];
      for (let i = 0; i < pdfPages.length; i++) {
        const el = document.getElementById(`claim-pdf-${i}`); if (!el) continue;
        const canvas = await h2c(el, { scale: 2, backgroundColor: bg, useCORS: true, logging: false });
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
        if (!blob) throw new Error(`${i + 1}장 이미지를 만들지 못했습니다`);
        images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height });
      }
      if (images.length && await saveFile(`${W}LOT_${today()}.pdf`, buildPdf(images))) toast(`PDF ${images.length}페이지를 저장했습니다.`);
    } catch (e) { toast(`PDF 저장 실패: ${e.message || e}`, 'bad'); }
    setShooting(false);
  };

  // 표 셀 (화면·PDF 공용). pdf=true면 버튼 대신 글자만
  // 클레임 칸: 제품명 / 소비기한 / 함께 가져온 열(접수일·클레임 내용 …) 한 줄씩. 입력 LOT·수량·품목 연결 근거는 표시하지 않음(상태 칩으로만)
  const claimCell = (r, pdf) => html`<div><b>${r.it.name || (r.product ? shortName(r.product.name) : '(제품명 없음)')}</b></div>
    <div class="l2">소비기한 ${r.it.expiry ? `${fmtDate(r.it.expiry)}(${dow(r.it.expiry)})` : r.it.expRaw ? html`<span class="muted">${r.it.expRaw} (날짜로 못 읽음)</span>` : r.it.lotRaw ? `LOT ${r.it.lotRaw}` : '—'}${r.it.time ? ` · 제조 ${r.it.time}` : ''}</div>
    ${r.timeNote && r.packs.length ? html`<div class="l2 x muted">${r.timeNote}</div>` : ''}
    ${r.it.pickNote ? html`<div class="l2 x muted">${r.it.pickNote}</div>` : ''}
    ${r.it.yeast != null && html`<div class="l2"><${Chip} tone=${r.it.yeast >= 1000 ? 'bad' : r.it.yeast >= 500 ? 'warn' : 'good'}>효모 ${r.it.yeastRaw}<//>${r.it.moldRaw && r.it.moldRaw !== '-' ? html` <span class=${r.it.mold > 0 ? '' : 'muted'} style="font-size:12px;margin-left:4px">곰팡이 ${r.it.moldRaw}</span>` : ''}</div>`}
    ${(() => { // 가져온 열: 효모·곰팡이는 위 칩으로, "-"는 빼고. 열이 많으면(품질팀 검사표) 한 줄로 이어 씀
      const ex = r.it.extras.filter(([k, v]) => !isReceipt(k) && !isYeastHead(k) && !isMoldHead(k) && !/^[-–—]$/.test(String(v).trim()));
      return ex.length > 3 ? html`<div class="l2 x">${ex.map(([k, v]) => `${k} ${v}`).join(' · ')}</div>` : ex.map(([k, v]) => html`<div key=${k} class="l2 x">${k} : ${v}</div>`); })()}
    ${r.lotMiss && html`<div class="l2"><${Chip} tone="warn">LOT ${r.it.lotRaw} 불일치 · 소비기한으로 찾음<//></div>`}
    ${!r.product && r.matches.length > 1 && html`<div class="l2 x muted">품목 후보: ${r.matches.map((m) => shortName(m.product.name)).join(' · ')}</div>`}
    ${!pdf && (r.status === 'noProduct' || r.status === 'lotOnly' || r.status === 'noPack' || r.status === 'lotMiss' || r.status === 'multi' || r.multi || overrides[r.idx]) && html`<div class="l2 row" style="gap:6px"><select class="input sm" value=${overrides[r.idx] || (r.product ? r.product.code : '')} onChange=${(e) => setOverride(r.idx, e.target.value)} title="앱 품목을 직접 골라 다시 찾기"><option value="">품목 고르기…</option>${products.map((p) => html`<option key=${p.code} value=${p.code}>${shortName(p.name)}</option>`)}</select>${overrides[r.idx] && r.it.name && state.canWrite && html`<button class="btn sm ghost" title=${`"${r.it.name}"이 들어간 클레임 제품명은 앞으로 항상 이 품목으로 찾습니다 (기준정보에 저장)`} onClick=${() => rememberAlias(r.it.name, overrides[r.idx])}>항상 이 품목으로</button>`}</div>`}`;
  // 제품 LOT·품목명 어느 쪽을 눌러도 LOT 추적에서 그 제품 LOT + 품목을 바로 고름 (v266)
  const openPack = (pk) => go('trace', { q: lot7(pk.p.productLot), mode: 'product', packKey: `${pk.p.productLot}|${pk.p.productCode}` });
  const packCell = (pk, r, pdf) => pk ? html`<div>${pdf ? html`<b class="lot">${lot7(pk.p.productLot)}</b>` : html`<button class="linkish" style="font-weight:700" title="LOT 추적에서 이 제품 LOT·품목 열기" onClick=${() => openPack(pk)}>${lot7(pk.p.productLot)}</button>`}</div>
    <div class="l2">${pdf ? (pk.product ? shortName(pk.product.name) : pk.p.productCode) : html`<button class="linkish" style="color:inherit" title="LOT 추적에서 이 제품 LOT·품목 열기" onClick=${() => openPack(pk)}>${pk.product ? shortName(pk.product.name) : pk.p.productCode}</button>`}${r.product && pk.product && pk.product.code !== r.product.code ? html` <${Chip} tone="warn">품목 다름<//>` : r.multi && !pdf ? html` <button class="linkish" style="font-size:12px" onClick=${() => setOverride(r.idx, pk.p.productCode)}>이 품목으로</button>` : ''}</div>
    <div class="l2">${n(pk.qty)} ${UNIT(pk.product && pk.product.unit)}</div>` : html`<span class="muted">—</span>`;
  const fillCell = (pk) => pk ? html`<div><b>${fillText(pk)}</b></div>${pk.batch && bufferText(pk) ? html`<div class="l2">${bufferText(pk)}</div>` : ''}${pk.batch ? html`<div class="l2">${fillText2(pk)}</div>` : ''}` : html`<span class="muted">—</span>`;
  const cultureCell = (pk, pdf) => !pk ? html`<span class="muted">—</span>`
    : !pk.cultures.length && pk.legacy ? html`<div class="muted">전산 백데이터 충진 · 반출 기록이 없어 배양 LOT 연결 없음</div>${pk.hintCultures.length ? html`<div class="l2">충진일(${yy(pk.batch.date)}) 배출 배양 LOT <span class="muted">(참고)</span>: ${pk.hintCultures.map((c, i) => html`${i ? ', ' : ''}${pdf ? c.lot : html`<button key=${c.id} class="linkish" onClick=${() => go('trace', { cultureId: c.id, q: c.lot })}>${c.lot}</button>`}`)}</div>` : html`<div class="l2 muted">그날 배출된 배양 LOT 기록 없음</div>`}`
    : !pk.cultures.length ? html`<span class="muted">충진 배치에 면포(배양 LOT)가 연결돼 있지 않습니다${pdf ? '' : html` · <button class="linkish" onClick=${() => go('fill', { date: pk.batch ? pk.batch.date : pk.p.date })}>충진/포장 실적에서 연결</button>`}</span>`
    : pk.cultures.map((x, i) => { const age = x.kind === 'drink' ? null : moveAge(x.c, x.move); const old = !!(age && age.old); // v269: 배출 → 반출 4일 이상이면 빨간 LOT
      return html`<div key=${i} class="cul"><div>${pdf ? html`<b class=${ageCls(age)}>${x.c.lot}</b>` : html`<button class=${`linkish${ageCls(age, ' ')}`} style="font-weight:700" title=${`LOT 추적에서 열기${age ? ` · ${clothAgeTitle(age)}` : ''}`} onClick=${() => go('trace', { cultureId: x.c.id, q: x.c.lot })}>${x.c.lot}</button>`}${cultureLine1(x).slice(x.c.lot.length)}</div><div class="l2">${cultureLine2(x)}${old ? html` <span class="age-old">· 배출 후 ${age.days}일</span>` : ''}</div></div>`; });

  const table = (list, pdf) => html`<table class="tbl claim-tbl ${pdf ? 'pdf-tbl' : ''}">
    ${pdf && html`<colgroup><col style="width:84px" /><col style="width:230px" /><col style="width:120px" /><col style="width:195px" /><col /></colgroup>`}
    <thead><tr><th>${RD}</th><th>${W} 제품 · 소비기한</th><th>제품 LOT · 품목</th><th>충진</th><th>배양 LOT → 유청분리 → 반출</th>${!pdf && html`<th></th>`}</tr></thead>
    <tbody>${list.map((x, i) => html`<tr key=${i} class=${STATUS[x.r.status].tone === 'bad' ? 'row-bad' : ''}>
      <td class="rcpt">${x.first ? (receiptOf(x.r) || html`<span class="muted">${x.r.idx + 1}</span>`) : ''}</td>
      <td class="wrap claim">${x.first ? html`${claimCell(x.r, pdf)}<div class="l2"><${Chip} tone=${STATUS[x.r.status].tone} dot>${STATUS[x.r.status].label}<//>${x.r.packs.length > 1 ? html` <span class="muted">제품 LOT ${x.r.packs.length}건</span>` : ''}</div>` : html`<span class="muted">〃</span>`}</td>
      <td class="wrap">${packCell(x.pk, x.r, pdf)}</td>
      <td class="wrap fill">${fillCell(x.pk)}</td>
      <td class="wrap">${cultureCell(x.pk, pdf)}</td>
      ${!pdf && html`<td>${x.first && html`<button class="icon-btn" title="이 줄 빼기" onClick=${() => removeItem(x.r.idx)}><${Icon} name="x" size="14" /></button>`}</td>`}
    </tr>`)}</tbody></table>`;

  const pdfBlock = html`<div class="pdf-pages">${pdfPages.map((page, i) => html`<div key=${i} id=${`claim-pdf-${i}`} class="pdf-page">
    <div class="shot-head"><b>${W} LOT 추적</b><span>${state.settings.companyName} · ${i + 1}/${pdfPages.length} · ${fmtDate(today())} 출력</span></div>
    <div class="pdf-sum">${file ? `${file.name} · ` : ''}${W} ${n(results.length)}건 · 추적 완료 ${n(counts.ok)}건 · 확인 필요 ${n(counts.warn)}건 · 확인 불가 ${n(counts.bad)}건${filter !== 'all' ? ` · ${{ ok: '추적 완료', warn: '확인 필요', bad: '확인 불가' }[filter]}만 ${n(shown.length)}건 표시` : ''}</div>
    ${kind === 'inspect' ? inspectTable(page, true) : table(page, true)}
  </div>`)}</div>`;

  return html`
    <div class="page-head"><div><div class="eyebrow">Nonconformance · Traceability</div><h1>${W === '클레임' ? '클레임 LOT' : '자사검사'}</h1></div>
      <div class="actions">
        <button class="btn" onClick=${saveTemplate} title=${`${W} 엑셀 양식(.xlsx) 저장: ${RD} · 제품명 · 소비기한 · LOT · 제조시간 · 수량 · ${W} 내용 머리글과 예시 한 줄`}><${Icon} name="download" />엑셀 양식</button>
        <label class="btn ${items.length ? '' : 'primary'}" style="cursor:pointer" title="${W} 엑셀(.xlsx): 머리글에 제품명 · 소비기한 열이 있으면 됩니다. LOT 열이 있으면 LOT로 바로 찾고, 제조시간 열이 있으면 그 시간에 충진 중이던 버퍼만 추적합니다. 파일은 브라우저에서만 읽습니다"><${Icon} name="upload" />${busy ? '읽는 중…' : `${W} 엑셀 올리기`}<input type="file" accept=".xlsx,.xls,.xlsm,.csv" style="display:none" disabled=${busy} onChange=${(e) => { onFile(e.target.files && e.target.files[0]); e.target.value = ''; }} /></label>
        <button class="btn ${dirty && items.length ? 'primary' : ''}" disabled=${!items.length || !state.canWrite || (!dirty && loadedId)} onClick=${saveSet} title=${!state.canWrite ? '읽기 전용이라 저장할 수 없습니다' : `이 ${W} 목록(품목 선택 포함)을 공유 저장소에 저장 — 새로고침해도 남고 다른 사람도 봅니다`}><${Icon} name="check" />${loadedId && !dirty ? '저장됨' : '저장'}</button>
        ${kind === 'inspect' && (tidyPlan.drop > 0 || tidyPlan.multi > 0) && html`<button class="btn" disabled=${!state.canWrite} onClick=${tidy} title="확인 필요 줄 삭제 + 배양 LOT가 여러 개인 줄은 면포/필터프레스 열 기준으로 1개만 남기고 저장"><${Icon} name="check" />정리 (확인 필요 ${n(tidyPlan.drop)} · LOT 여러 개 ${n(tidyPlan.multi)})</button>`}
        ${items.length > 0 && html`<button class="btn ghost" onClick=${clearAll}><${Icon} name="x" />비우기</button>`}
      </div></div>

    <${Card}>
      <div class="filters">
        <${Field} label="직접 입력" hint="엑셀 없이 한두 건 확인할 때"><div class="row" style="flex-wrap:nowrap">
          <select class="input" style="min-width:180px" value=${mName} onChange=${(e) => setMName(e.target.value)}><option value="">품목…</option>${products.map((p) => html`<option key=${p.code} value=${p.code}>${shortName(p.name)}</option>`)}</select>
          <input type="date" class="input" style="width:150px" value=${mExp} onInput=${(e) => setMExp(e.target.value)} title="소비기한" />
          <input class="input" style="width:130px" placeholder="LOT (선택)" value=${mLot} onInput=${(e) => setMLot(e.target.value)} title="제품 LOT: 26-1110 C5 · 2026.11.10 C5" onKeyDown=${(e) => e.key === 'Enter' && addManual()} />
          <input class="input" style="width:118px" placeholder="제조시간 (선택)" value=${mTime} onInput=${(e) => setMTime(e.target.value)} title="제품에 찍힌 제조 시간 (예: 08:30). 넣으면 그 시간에 충진 중이던 버퍼만 추적합니다" onKeyDown=${(e) => e.key === 'Enter' && addManual()} />
          <button class="btn sm" onClick=${addManual}>추가</button></div><//>
        ${file && html`<${Field} label="올린 엑셀"><div class="note" style="line-height:1.5;padding:4px 0">${file.name}${sheetInfo && sheetInfo.sheets.length > 1 ? html` · 시트 <select class="input sm" style="width:auto;display:inline-block" value=${sheetInfo.sheet} disabled=${busy} onChange=${(e) => onFile(file, e.target.value, fileBuf)}>${sheetInfo.sheets.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}</select>` : ''} · ${n(items.filter((x) => !x.manual).length)}건${sheetInfo && sheetInfo.skipped ? ` (서비스 클레임 ${n(sheetInfo.skipped)}건 제외)` : ''}${extraHeads.length ? ` · 함께 가져온 열: ${extraHeads.join(', ')}` : ''}${sheetInfo && sheetInfo.ledger ? html`<div class="muted">클레임 관리대장 양식 · 성명·연락처·접수자·담당자 열은 저장하지 않음</div>` : ''}
          ${cols && html`<div>읽은 열 — 제품명: <b>${cols.name || '없음'}</b> · 소비기한: <b>${cols.exp || '없음'}</b> · LOT: <b>${cols.lot || '없음'}</b> · 수량: <b>${cols.qty || '없음'}</b> · 제조시간: <b>${cols.time || '없음'}</b>${cols.yeast ? html` · 효모: <b>${cols.yeast}</b>` : ''}${cols.mold ? html` · 곰팡이: <b>${cols.mold}</b>` : ''}</div>`}</div><//>`}
        ${savedSets.length > 0 && html`<${Field} label=${`저장된 ${W}`} hint=${loadedId ? (dirty ? '바뀐 내용이 있습니다 · 저장을 누르세요' : `${fmtDate((savedSets.find((s) => s.id === loadedId) || {}).savedAt || '').slice(0, 10) || ''} 저장본`) : '고르면 불러옵니다'}><div class="row" style="flex-wrap:nowrap">
          <select class="input" style="min-width:220px" value=${loadedId || ''} onChange=${(e) => { const d = savedSets.find((s) => s.id === e.target.value); if (d) loadSet(d); }}><option value="">${items.length ? '(지금 올린 목록)' : '저장본 고르기…'}</option>${savedSets.map((s) => html`<option key=${s.id} value=${s.id}>${s.name} · ${n((s.items || []).length)}건 · ${String(s.savedAt || '').slice(0, 10)}</option>`)}</select>
          ${loadedId && state.canWrite && html`<button class="btn sm ghost" onClick=${deleteSet} title="이 저장본 삭제"><${Icon} name="x" />삭제</button>`}</div><//>`}
      </div>
      ${err && html`<div class="banner bad" style="margin-top:10px"><${Icon} name="alert" /><span>${err}</span></div>`}
    <//>

    ${results.length > 0 && html`<div class="stats">
      ${[['all', W, results.length, `제품 LOT ${n(flat.filter((x) => x.pk).length)}건 · 배양 LOT ${n(new Set(flat.flatMap((x) => x.pk ? x.pk.cultures.map((c) => c.c.id) : [])).size)}건`, true],
         ['ok', '추적 완료', counts.ok, '배양 LOT까지 연결됨'], ['warn', '확인 필요', counts.warn, '면포 미연결 · 품목 확인'], ['bad', '확인 불가', counts.bad, '제품 LOT 없음 · 품목 미확인']]
        .map(([key, k, v, s, hero]) => html`<button key=${key} class="stat clickable ${hero ? 'hero' : ''} ${filter === key ? 'active' : ''}" onClick=${() => setFilter(filter === key && key !== 'all' ? 'all' : key)} title=${key === 'all' ? '전체 보기' : `${k}만 보기 (다시 누르면 전체)`}><div class="k">${k}</div><div class="v">${n(v)}<small>건</small></div><div class="s">${s}</div></button>`)}
    </div>`}

    ${results.length > 0 && html`<${Card} title=${filter === 'all' ? `${W} LOT 추적` : `${W} LOT 추적 · ${{ ok: '추적 완료', warn: '확인 필요', bad: '확인 불가' }[filter]}만`} count=${shown.length} desc=${filter === 'all' ? `${W} 제품명 · 소비기한으로 제품 LOT를 찾고, 그 충진 배치에 들어간 면포(반출 → 소분)를 따라 배양 LOT까지 연결합니다. 제품 LOT · 배양 LOT를 누르면 LOT 추적에서 상세 이력을 봅니다` : `위 카드를 다시 누르거나 "${W}" 카드를 누르면 전체(${n(results.length)}건)로 돌아갑니다 · PDF·엑셀도 보이는 줄만 저장됩니다`}
      actions=${html`<div class="row" style="gap:6px"><button class="btn sm primary" disabled=${shooting || !flat.length} onClick=${savePdf} title=${`지금 보이는 ${W} LOT 추적 표를 A4 세로 PDF로 저장 (${pdfPages.length}장)`}><${Icon} name="download" />${shooting ? 'PDF 만드는 중…' : `PDF 저장 (${pdfPages.length}장)`}</button><button class="btn sm" disabled=${!shown.length} onClick=${saveXlsx} title="지금 보이는 줄을 엑셀(.xlsx)로 저장"><${Icon} name="download" />엑셀 저장</button></div>`} flush>
      <div class=${kind === 'inspect' ? 'table-wrap insp-wrap' : 'table-wrap'}>${kind === 'inspect' ? inspectTable(groupsVis, false) : table(flat, false)}</div>
      ${ordered.hid.length > 0 && html`<div style="padding:10px 14px;border-top:1px solid var(--line)"><button class="btn sm ghost" onClick=${() => setShowHidden(!showHidden)}><${Icon} name=${showHidden ? 'x' : 'eye'} />${showHidden ? '접기' : `문제 없는 검사 ${n(ordered.hid.length)}건 (${n(groupsHid.length)}줄) 펼치기`}</button> <span class="muted" style="font-size:12px">같은 제품 LOT의 초·중·말 효모·곰팡이가 모두 ${'<10'}인 검사 · PDF에는 빠짐</span></div>
        ${showHidden && html`<div class="table-wrap insp-wrap">${inspectTable(groupsHid, false)}</div>`}`}
    <//>`}
    ${shooting && pdfBlock}`;
}
