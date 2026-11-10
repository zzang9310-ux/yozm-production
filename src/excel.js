// 월별 엑셀(xlsx) 내보내기 + 반기 보관 정리
//  - 엑셀 생성은 SheetJS(xlsx)를 버튼을 누를 때만 CDN에서 불러옵니다 (첫 화면 로딩에 영향 없음).
//  - 보관 정리 규칙: 매년 1월 → 전년 1~6월 실적 삭제, 7월 → 전년 7~12월 실적 삭제.
//    = 오늘이 1~6월이면 "전년 7월 1일" 이전, 7~12월이면 "올해 1월 1일" 이전 기록이 보관 기간 종료.
import { cultureStock, batchGoodKg, batchNetInputKg, batchRunMin, batchPersons, batchBpm, autoBreakMin, fillerOf, tankOf, productOf, packKg, STATUS } from './model.js';
import { fmtDate, dow, num, sum, monthRange, today } from './util.js';
import { remove, saveSettings } from './store.js';
import { saveFile, toast } from './ui.js';

const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
let xlsxLoading = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxLoading) xlsxLoading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = XLSX_URL; s.async = true;
    s.onload = () => res(window.XLSX); s.onerror = () => { xlsxLoading = null; rej(new Error('xlsx 라이브러리를 불러오지 못했습니다')); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

export { loadXLSX };

// ---------- 전산(ERP) 충진실적 엑셀 읽기 ----------
// "생산실적 현황 (날짜).xlsx": 1~2행 헤더, 열 A 시작일(엑셀 날짜값) · I 생산설비("100g 2호기(B)") · J 품목코드 · K 품목명
// · M LOT번호("2026.11.09 B3") · N 공정투입 · O 양품수량 · P 불량수량 · Z 작업시간(분). 품목코드가 없는 줄(합계)은 건너뜀.
function excelSerialToISO(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return d.toISOString().slice(0, 10); }
  const s = String(v).trim(); const m = s.match(/^(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}
/** ERP LOT "2026.11.09 B3" → 앱 제품 LOT "26-1109 B3". 띄어쓰기·구분자가 들쭉날쭉해도 읽음: "2026. 10.16J5" · "26 - 10 - 16 j 5" · "20261016J5" → "26-1016 J5" */
export function erpLotToApp(v) {
  const s = String(v || '').trim();
  const out = (yy, mm, dd, rest) => { const r = String(rest || '').replace(/\s+/g, '').toUpperCase(); return `${yy}-${mm.padStart(2, '0')}${dd.padStart(2, '0')}${r ? ' ' + r : ''}`; };
  let m;
  // ① 앱 표기 "26-1016 J5"
  if ((m = s.match(/^(\d{2})-(\d{2})(\d{2})\s*(.*)$/))) return out(m[1], m[2], m[3], m[4]);
  // ② 구분자 있는 날짜: "2026.11.17 A3" · "2026. 10.16J5" · "2026.11.1 F2"(한 자리) · "26 -10- 27 b 4"
  if ((m = s.match(/^(?:20)?(\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?!\d)\s*\.?\s*(.*)$/))) return out(m[1], m[2], m[3], m[4]);
  // ③ 구분자 없는 날짜: "20261016J5" · "261016 J5"
  if ((m = s.match(/^(?:20)?(\d{2})(\d{2})(\d{2})\s*(.*)$/))) return out(m[1], m[2], m[3], m[4]);
  return s;
}
export async function parseErpFillXlsx(buf) {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const hi = aoa.findIndex((r) => r.some((c) => String(c).includes('품목코드')));
  if (hi < 0) throw new Error('품목코드 열을 찾지 못했습니다. 전산의 "생산실적 현황" 엑셀인지 확인하세요.');
  const head = aoa[hi].map((c) => String(c).trim());
  const col = (name, fallback) => { const i = head.findIndex((h) => h.replace(/\s/g, '') === name); return i >= 0 ? i : fallback; };
  const C = { date: col('시작일', 0), time: col('시작시간', 1), endTime: 3, filler: col('생산설비', 8), code: col('품목코드', 9), name: col('품목명', 10), lot: col('LOT번호', 12), input: col('공정투입', 13), good: col('완성실적', 14), defect: 15, runMin: col('가동시간(분)', 25) };
  // 2행 헤더: 시작일 아래 시작시간, 완성일 아래 완성시간, 완성실적 아래 양품수량/불량수량, 가동시간 아래 작업시간(분)
  const sub = aoa[hi + 1] ? aoa[hi + 1].map((c) => String(c).trim()) : [];
  const subIdx = (name) => sub.findIndex((h) => h.replace(/\s/g, '') === name);
  if (subIdx('시작시간') >= 0) C.time = subIdx('시작시간');
  if (subIdx('완성시간') >= 0) C.endTime = subIdx('완성시간');
  if (subIdx('양품수량') >= 0) C.good = subIdx('양품수량');
  if (subIdx('불량수량') >= 0) C.defect = subIdx('불량수량');
  if (subIdx('작업시간(분)') >= 0) C.runMin = subIdx('작업시간(분)');
  // 시각 칸: 엑셀 시간(0~1 소수) 또는 "HH:MM[:SS]" 문자열 → "HH:MM"
  const hhmm = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number') { const m = Math.round((v % 1) * 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
    const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
  };
  const rows = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i]; const code = String(r[C.code] || '').trim(); const lotRaw = String(r[C.lot] || '').trim();
    if (!code || !lotRaw) continue;
    const fillerStr = String(r[C.filler] || '').trim(); const cm = fillerStr.match(/\(([A-Za-z]*)\)\s*$/);
    const em = lotRaw.match(/^(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/); // LOT 앞의 날짜 = 소비기한
    rows.push({ row: i + 1, date: excelSerialToISO(r[C.date]), time: hhmm(r[C.time]), endTime: hhmm(r[C.endTime]), fillerStr, fillerCode: cm ? cm[1].toUpperCase() : '', productCode: code, productName: String(r[C.name] || '').trim(),
      lotRaw, lot: erpLotToApp(lotRaw), expiry: em ? `${em[1]}-${em[2]}-${em[3]}` : '', inputEa: num(r[C.input]), goodEa: num(r[C.good]), defectEa: num(r[C.defect]), runMin: num(r[C.runMin]) });
  }
  return { rows, dates: [...new Set(rows.map((x) => x.date).filter(Boolean))].sort(), sheet: wb.SheetNames[0] };
}
const r1 = (v) => Math.round(num(v) * 10) / 10;
const inRange = (d, from, to) => d && d >= from && d <= to;
const crewStr = (b, k) => ((b.crew || {})[k] || []).join(', ');

/** 기간의 실적을 시트별 2차원 배열로 */
export function buildSheets(state, from, to) {
  const cultures = state.cultures.filter((c) => inRange(c.date, from, to)).sort((a, b) => a.date.localeCompare(b.date) || a.tankId.localeCompare(b.tankId));
  const seps = state.separations.filter((s) => inRange(s.date, from, to)).sort((a, b) => a.date.localeCompare(b.date));
  const batches = state.batches.filter((b) => inRange(b.date, from, to)).sort((a, b) => a.date.localeCompare(b.date) || (a.batchNo || '').localeCompare(b.batchNo || ''));
  const packs = state.packs.filter((p) => inRange(p.date, from, to)).sort((a, b) => a.date.localeCompare(b.date));
  const lots = state.materialLots.filter((l) => inRange(l.receivedDate, from, to)).sort((a, b) => a.receivedDate.localeCompare(b.receivedDate));
  const cultureOf = (id) => state.cultures.find((c) => c.id === id);
  const batchOf = (id) => state.batches.find((b) => b.id === id);

  // 시트 설계: 한 줄 = 배양 LOT 하나(배양·유청분리) / 충진 배치 하나 / 제품 LOT 하나. 날짜는 "10-28 (수)"로 한 칸, 작업자는 한 칸.
  // widths 는 열 폭(문자 수), fmt 는 열 서식 키(int: #,##0 · kg: #,##0.0 · pct: 0.0% 표시용 숫자). 헤더에 단위를 적어 설명 없이 읽히게 함.
  const D = (d) => d ? `${d.slice(5, 7)}-${d.slice(8, 10)} (${dow(d)})` : '';
  const shortName = (s) => String(s || '').replace(/^충진[-_]\s*/, '');
  const blank = (v) => v == null || v === 0 || v === '' ? '' : v;
  const sheets = [];

  // 1) 배양: 탱크 원유 투입 → 배출 → 소분 결과까지 LOT당 한 줄
  sheets.push({ name: '배양', widths: [11, 8, 14, 11, 9, 9, 8, 9, 9, 11, 9, 9, 9, 9, 8, 8, 8, 12, 20], fmt: ['', '', '', '', 'int', 'int', 'int', 'int', 'kg', 'int', 'kg', 'int', 'kg2', 'int', 'int', 'int', '', '', ''],
    rows: [['배양일', '탱크', '배양 LOT', '배출 구분', '원유 L', '원유 kg', '유산균 봉', '드링크 L', '드링크 kg', '필터프레스 L', '유청분리 kg', '소분 면포', '포당 kg', '반출 포', '폐기 포', '재고 포', '상태', '비고'],
      ...cultures.map((c) => { const st = cultureStock(state, c.id); return [D(c.date), tankOf(state, c.tankId).name, c.lot, c.type || '', num(c.rawL), num(c.rawKg), num(c.starterBags), blank(st.drinkL), blank(st.drinkKg), st.hasPress ? st.pressL : '', st.wheyKg, blank(st.splitCloths), st.kgPerCloth != null ? Math.round(st.kgPerCloth * 100) / 100 : '', blank(st.usedCloths), blank(st.disposedCloths), st.splitCloths ? st.remaining : '', (STATUS[st.status] || {}).label || '', c.note || '']; })] });

  // 2) 유청분리·소분: LOT당 한 줄 — 소분 결과와 반출·폐기 요약, 재고, 상태
  const sepOf = (cid) => state.separations.filter((s) => s.cultureId === cid);
  const splitRows = cultures.map((c) => ({ c, st: cultureStock(state, c.id), seps: sepOf(c.id) })).filter((r) => r.st.hasWhey && (r.seps.length || inRange(r.c.date, from, to)));
  sheets.push({ name: '유청분리·소분', widths: [11, 8, 14, 11, 10, 11, 11, 9, 9, 44, 8, 8, 8, 12, 20], fmt: ['', '', '', '', 'int', 'int', 'int', 'kg2', 'kg', '', 'int', 'int', 'int', '', ''],
    rows: [['배양일', '탱크', '배양 LOT', '소분일', '소분 면포', '유청분리실 포', '필터프레스 포', '포당 kg', '총 kg', '반출 내역 (설비 · 유형 · 포)', '반출 포', '폐기 포', '재고 포', '상태', '비고'],
      ...splitRows.map(({ c, st, seps }) => {
        const sp = seps.find((s) => s.kind === 'split');
        const moves = seps.filter((s) => s.kind === 'move').map((m) => `${m.fillerId ? fillerOf(state, m.fillerId).name : '설비 미정'} ${m.mixType || ''} ${num(m.cloths)}포${m.source === 'press' ? '(FP)' : ''}${m.batchId ? '' : ' *배정대기'}`);
        const disposes = seps.filter((s) => s.kind === 'dispose').map((d) => `폐기 ${num(d.cloths)}포`);
        return [D(c.date), tankOf(state, c.tankId).name, c.lot, sp ? D(sp.date) : '', blank(st.splitCloths), sp && sp.roomCloths != null ? sp.roomCloths : (st.hasPress ? '' : blank(st.splitCloths)), sp && sp.pressCloths != null ? sp.pressCloths : (st.hasPress ? Math.round(st.pressClothsEst) : ''), st.kgPerCloth != null ? Math.round(st.kgPerCloth * 100) / 100 : '', blank(r1(st.splitKg)), [...moves, ...disposes].join(' / '), blank(st.usedCloths), blank(st.disposedCloths), st.splitCloths ? st.remaining : '', (STATUS[st.wheyStatus] || {}).label || '', seps.map((s) => s.note).filter(Boolean).join(' / ')];
      })] });

  // 3) 면포 반출·폐기 상세: 반출/폐기 기록 한 건당 한 줄 (충진 배치 연결 포함)
  const moveRows = seps.filter((s) => s.kind !== 'split');
  sheets.push({ name: '면포 반출', widths: [11, 6, 14, 8, 10, 10, 10, 8, 9, 26, 20], fmt: ['', '', '', '', '', '', '', 'int', 'kg', '', ''],
    rows: [['반출일', '구분', '배양 LOT', '탱크', '받는 설비', '재공품 유형', '면포 출처', '면포', 'kg', '배정 충진 배치', '비고'],
      ...moveRows.map((s) => { const c = cultureOf(s.cultureId); const b = s.batchId ? batchOf(s.batchId) : null; return [D(s.date), s.kind === 'move' ? '반출' : '폐기', c ? c.lot : '', c ? tankOf(state, c.tankId).name : '', s.kind === 'move' ? (s.fillerId ? fillerOf(state, s.fillerId).name : '설비 미정') : '', s.mixType || '', s.source === 'press' ? '필터프레스' : s.source === 'room' ? '유청분리실' : '', num(s.cloths), r1(s.kg), b ? b.batchNo : (s.kind === 'move' ? '배정 대기' : ''), s.note || '']; })] });

  // 4) 충진: 배치당 한 줄 — 투입(출고·계근·폐기·LOSS) → 산출(양품·불량·수율) → 시간·인원·BPM
  sheets.push({ name: '충진', widths: [11, 8, 24, 10, 30, 7, 10, 10, 9, 8, 8, 10, 8, 10, 9, 13, 7, 5, 6, 30, 20], fmt: ['', '', '', '', '', 'int', 'kg', 'kg', 'kg', 'kg', 'kg', 'int', 'int', 'kg', 'pct', '', 'int', 'int', 'kg', '', ''],
    rows: [['충진일', '설비', '배치번호', '재공품 유형', '사용 배양 LOT (면포/L)', '면포', '발효유 kg', '출고량 kg', '계근 kg', '폐기 kg', 'LOSS kg', '양품 ea', '불량 ea', '양품 kg', '충진 수율 %', '시간 (시작~종료)', '가동 분', '인원', 'BPM', '작업자', '비고'],
      ...batches.map((b) => {
        const srcs = b.sources || [];
        const ferment = sum(srcs, (s) => s.kg); const net = batchNetInputKg(b); const goodKg = batchGoodKg(state, b);
        const crew = [crewStr(b, 'fill'), crewStr(b, 'cap') && `캡 ${crewStr(b, 'cap')}`, crewStr(b, 'pack') && `포장 ${crewStr(b, 'pack')}`].filter(Boolean).join(' · ');
        return [D(b.date), fillerOf(state, b.fillerId).name, b.batchNo || '', b.mixType || '', srcs.map((s) => { const c = cultureOf(s.cultureId); return `${c ? c.lot : '?'} ${s.kind === 'drink' ? `${num(s.liters)}L` : `${num(s.cloths)}포`}`; }).join(' / '),
          blank(sum(srcs.filter((s) => s.kind !== 'drink'), (s) => s.cloths)), r1(ferment), r1(b.outKg), num(b.inputKg), blank(num(b.wasteKg)), r1(net - goodKg), num(b.goodEa), blank(num(b.defectEa)), r1(goodKg), net > 0 ? Math.round(goodKg / net * 1000) / 10 : '',
          b.startTime || b.endTime ? `${b.startTime || ''}~${b.endTime || ''}${autoBreakMin(b.startTime, b.endTime) + num(b.breakMin) ? ` (휴게 ${autoBreakMin(b.startTime, b.endTime) + num(b.breakMin)}분)` : ''}` : '', batchRunMin(b), batchPersons(b), batchRunMin(b) ? Math.round(batchBpm(b) * 10) / 10 : '', crew, b.note || ''];
      })] });

  // 5) 포장: 제품 LOT당 한 줄
  sheets.push({ name: '포장', widths: [11, 8, 24, 22, 14, 14, 12, 10, 9, 20], fmt: ['', '', '', '', '', '', '', 'int', 'kg', ''],
    rows: [['포장일', '설비', '충진 배치', '품목명', '품목코드', '제품 LOT', '소비기한', '수량 ea', 'kg', '비고'],
      ...packs.map((p) => { const b = p.batchId ? batchOf(p.batchId) : null; const pr = productOf(state, p.productCode); return [D(p.date), b ? fillerOf(state, b.fillerId).name : '', b ? b.batchNo : '', pr ? shortName(pr.name) : p.productCode, p.productCode, p.productLot || '', p.expiry || '', num(p.qty), r1(packKg(state, p)), p.note || '']; })] });

  // 6) 포장재 사용: 제품 LOT × 자재 한 줄 (BOM 자동 계산)
  const matRows = [];
  for (const p of packs) { const b = p.batchId ? batchOf(p.batchId) : null; const pr = productOf(state, p.productCode); for (const x of p.packLots || []) { const m = state.materials.find((mm) => mm.code === x.materialCode); matRows.push([D(p.date), b ? fillerOf(state, b.fillerId).name : '', pr ? shortName(pr.name) : p.productCode, p.productLot || '', x.materialCode, m ? m.name : '', num(x.qty), m ? m.unit || '' : '']); } }
  if (matRows.length) sheets.push({ name: '포장재 사용', widths: [11, 8, 22, 14, 14, 26, 10, 6], fmt: ['', '', '', '', '', '', 'kg', ''],
    rows: [['포장일', '설비', '품목명', '제품 LOT', '자재코드', '자재명', '사용량', '단위'], ...matRows] });

  // 7) 일별 요약 + 설비별 요약
  const days = [...new Set(batches.map((b) => b.date))].sort();
  const sumRow = (label, bs) => { const good = sum(bs, (b) => batchGoodKg(state, b)); const net = sum(bs, batchNetInputKg); return [label, bs.length, r1(sum(bs, (b) => sum(b.sources || [], (s) => s.kg))), num(sum(bs, (b) => b.inputKg)), r1(net - good), sum(bs, (b) => b.goodEa), r1(good), sum(bs, (b) => b.defectEa), net > 0 ? Math.round(good / net * 1000) / 10 : '']; };
  const sumHead = ['배치 수', '발효유 kg', '계근 kg', 'LOSS kg', '양품 ea', '양품 kg', '불량 ea', '충진 수율 %'];
  const fillerIds = [...new Set(batches.map((b) => b.fillerId))];
  sheets.push({ name: '요약', noFilter: true, widths: [16, 8, 11, 10, 9, 10, 10, 8, 11], fmt: ['', 'int', 'kg', 'kg', 'kg', 'int', 'kg', 'int', 'pct'],
    rows: [['일자', ...sumHead], ...days.map((d) => sumRow(D(d), batches.filter((b) => b.date === d))), sumRow('합계', batches), [],
      ['설비', ...sumHead], ...fillerIds.map((f) => sumRow(fillerOf(state, f).name, batches.filter((b) => b.fillerId === f)))] });

  if (lots.length) sheets.push({ name: '자재 입고', widths: [11, 14, 24, 14, 9, 12, 11, 20], fmt: ['', '', '', '', 'kg', '', '', ''],
    rows: [['입고일', '자재코드', '자재명', 'LOT', '수량', '공급사', '기한', '비고'], ...lots.map((l) => { const m = state.materials.find((x) => x.code === l.materialCode); return [D(l.receivedDate), l.materialCode, m ? m.name : '', l.lot, num(l.qty), l.supplier || '', l.expiry || '', l.note || '']; })] });

  return { sheets, counts: { cultures: cultures.length, separations: seps.length, batches: batches.length, packs: packs.length } };
}

/** 기간 실적을 xlsx 파일로 저장. 저장 요청이 받아들여지면 settings.exports에 해당 월을 기록 */
export async function exportXlsx(state, from, to, filename) {
  const XLSX = await loadXLSX();
  const { sheets, counts } = buildSheets(state, from, to);
  const wb = XLSX.utils.book_new();
  const FMT = { int: '#,##0', kg: '#,##0.0', kg2: '#,##0.00', pct: '0.0' };
  for (const sh of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sh.rows);
    ws['!cols'] = sh.widths.map((w) => ({ wch: w }));
    // 숫자 서식(천 단위 구분, 소수 자리) + 헤더 행 자동 필터 (엑셀에서 바로 정렬·필터)
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let R = 1; R <= range.e.r; R++) for (let C = 0; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      const f = (sh.fmt || [])[C];
      if (cell && cell.t === 'n' && f && FMT[f]) cell.z = FMT[f];
    }
    if (sh.rows.length > 1 && !sh.noFilter) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: range.e.r, c: range.e.c } }) };
    XLSX.utils.book_append_sheet(wb, ws, sh.name);
  }
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const ok = await saveFile(filename, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  if (ok) {
    const months = new Set(); for (let d = from.slice(0, 7); d <= to.slice(0, 7); d = nextMonth(d)) months.add(d);
    const exports = { ...(state.settings.exports || {}) }; for (const m of months) exports[m] = today();
    await saveSettings({ exports });
  }
  return { ok, counts };
}
export function exportMonthXlsx(state, ym) { const r = monthRange(ym); return exportXlsx(state, r.from, r.to, `생산실적_${ym}.xlsx`); }
function nextMonth(ym) { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }

// ---------- 반기 보관 정리 ----------
const RETENTION_COLS = ['cultures', 'separations', 'batches', 'packs', 'plans'];
/** 이 날짜 이전 기록은 보관 기간이 끝난 것 (1~6월: 전년 7/1, 7~12월: 올해 1/1) */
export function retentionCutoff(d = new Date()) { const y = d.getFullYear(); return d.getMonth() + 1 >= 7 ? `${y}-01-01` : `${y - 1}-07-01`; }
export function retentionCandidates(state) {
  const cutoff = retentionCutoff();
  const items = [];
  for (const c of RETENTION_COLS) for (const doc of state[c] || []) if (doc.date && doc.date < cutoff) items.push({ col: c, doc });
  const months = [...new Set(items.map((x) => x.doc.date.slice(0, 7)))].sort();
  const exports = state.settings.exports || {};
  const notExported = months.filter((m) => !exports[m]);
  return { cutoff, items, months, notExported, from: months[0] ? `${months[0]}-01` : '', to: cutoff };
}
export async function purgeRetention(state) {
  const { items } = retentionCandidates(state);
  let n = 0;
  for (const { col, doc } of items) { await remove(col, doc.id); n++; }
  await saveSettings({ lastPurge: today(), lastPurgeCount: n });
  return n;
}
