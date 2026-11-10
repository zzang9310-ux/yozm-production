// 공통 유틸: 날짜, 숫자 포맷, ID, LOT 번호 규칙

const z = (n) => String(n).padStart(2, '0');

export function toISO(d) {
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export function today() { return toISO(new Date()); }
export function parseISO(iso) { return new Date(iso + 'T00:00:00'); }
export function addDays(iso, n) {
  const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d);
}
// 영업일: 토·일과 공휴일(대체공휴일 포함)을 뺀 날. 공휴일 표는 해마다 아래에 추가 (음력 명절·선거일은 매년 바뀜)
export const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-01', '2026-03-02', '2026-05-01', '2026-05-05', '2026-05-24', '2026-05-25',
  '2026-06-03', '2026-06-06', '2026-08-15', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28', '2026-10-03', '2026-10-05', '2026-10-09', '2026-12-25',
  // 2027
  '2027-01-01', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-03-01', '2027-03-03', '2027-05-01', '2027-05-05', '2027-05-13',
  '2027-06-06', '2027-08-15', '2027-08-16', '2027-09-14', '2027-09-15', '2027-09-16', '2027-10-03', '2027-10-04', '2027-10-09', '2027-10-11', '2027-12-25',
]);
export function isBusinessDay(iso) { const d = parseISO(iso).getDay(); return d !== 0 && d !== 6 && !HOLIDAYS.has(iso); }
/** 기준일 바로 앞의 영업일 (월요일·연휴 다음 날이면 그 전 금요일/연휴 전날) */
export function prevBusinessDay(iso = today()) {
  let d = addDays(iso, -1);
  for (let i = 0; i < 30 && !isBusinessDay(d); i++) d = addDays(d, -1);
  return d;
}
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${z(d.getMonth() + 1)}`;
}
export function weekRange(iso) { // 일요일 ~ 토요일
  const dow = parseISO(iso).getDay();
  const from = addDays(iso, -dow); return { from, to: addDays(from, 6) };
}
/** 달의 주차(일~토 블록): 1일이 속한 주부터 말일이 속한 주까지. 예) 2026-10 → 1주차 09/27~10/03 … */
export function weeksOfMonth(ym) {
  const { from, to } = monthRange(ym);
  const out = []; let start = weekRange(from).from;
  for (let i = 1; start <= to && i <= 6; i++) { out.push({ n: i, from: start, to: addDays(start, 6) }); start = addDays(start, 7); }
  return out;
}
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${z(last)}` };
}
export function daysBetween(from, to) {
  const out = []; let d = from;
  while (d <= to) { out.push(d); d = addDays(d, 1); if (out.length > 400) break; }
  return out;
}
export function fmtDate(iso) { return iso ? iso.replace(/-/g, '.') : '—'; }
export function fmtMD(iso) { return iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '—'; }
export function dow(iso) { return '일월화수목금토'[parseISO(iso).getDay()]; }
export function ymLabel(ym) { const [y, m] = ym.split('-'); return `${y}년 ${Number(m)}월`; }

export function n(v, d = 0) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function pct(v, d = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return n(v, d) + '%';
}
export function num(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
/** 엑셀처럼 "10+10+10" 같은 간단한 식을 계산. 숫자·사칙연산·괄호만 허용, 아니면 0 */
export function calc(v) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/,/g, '').replace(/^=/, '').trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (!/^[\d\s+\-*/().]+$/.test(s) || /[+\-*/.]$/.test(s)) return num(s);
  try { const r = Function(`"use strict"; return (${s});`)(); return Number.isFinite(r) ? Math.round(r * 1000) / 1000 : 0; } catch { return 0; }
}
export function isExpr(v) { return /[+\-*/]/.test(String(v || '').replace(/^-/, '')); }
export function div(a, b) { return b > 0 ? a / b : null; }
export function sum(arr, f) { return arr.reduce((s, x) => s + num(f ? f(x) : x), 0); }
export function groupBy(arr, f) {
  const m = new Map();
  for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
export function tankNo(tankId) { return String(tankId || '').replace(/\D/g, ''); }

/** 배출(유청분리)일: 배양일 + offset, 공장 휴무 요일(기본 토요일)이면 다음 가동일로 미룸. 예) 금요일 배양 → 일요일 배출 */
export function dischargeDate(date, offset = 1, offDays = [6]) {
  let d = addDays(date, offset);
  const off = (offDays || []).map(Number);
  for (let i = 0; i < 7 && off.includes(new Date(d + 'T00:00:00').getDay()); i++) d = addDays(d, 1);
  return d;
}
/** 배양 LOT: YYMMDD(배출일) + T + 탱크번호 2자리 + '-' + 순번 2자리  예) 261023T01-01 */
export function cultureLot(date, tankId, seq, offset = 1, offDays = [6]) {
  const d = dischargeDate(date, offset, offDays).slice(2).replace(/-/g, '');
  return `${d}T${tankNo(tankId).padStart(2, '0')}-${z(seq || 1)}`;
}
/** 충진 배치번호 (엑셀 버퍼 배치 형식): "{설비} 버퍼{순번} {yy.MM.dd}{재공품 유형}" 예) 3호기 버퍼1 26.10.01플레인 */
export function batchNo(date, fillerName, seq, mixType) {
  const d = date ? `${date.slice(2, 4)}.${date.slice(5, 7)}.${date.slice(8, 10)}` : '';
  return `${fillerName || ''} 버퍼${seq || 1} ${d}${mixType || ''}`.trim();
}
/** 요일 숫자: 월=1 … 일=7 */
export function dowNum(iso) { const d = parseISO(iso).getDay(); return d === 0 ? 7 : d; }
/** 제품 LOT: "{기준일 yy-MMdd} {설비코드}{요일}" 예) 26-1108 A1 (기준일은 소비기한 또는 충진일, 요일은 충진일 기준) */
export function productLot(baseDate, fillDate, fillerCode) {
  const d = baseDate ? `${baseDate.slice(2, 4)}-${baseDate.slice(5, 7)}${baseDate.slice(8, 10)}` : '';
  return `${d} ${fillerCode || ''}${fillDate ? dowNum(fillDate) : ''}`.trim();
}
/** "HH:MM" 두 시각의 차이(분). 종료가 더 이르면 자정을 넘긴 것으로 봄 */
export function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number); const [eh, em] = end.split(':').map(Number);
  let m = (eh * 60 + em) - (sh * 60 + sm); if (m < 0) m += 24 * 60; return m;
}

// ---------- PDF (JPEG 이미지 한 장 = 한 페이지, A4 세로) ----------
/** images = [{ jpeg: Uint8Array, w, h }] → PDF Blob. 각 이미지를 A4(595×842pt) 안에 맞춰 위쪽 가운데에 놓음. 위 여백은 펀치 구멍 자리로 48pt(약 17mm), 나머지 20pt. 라이브러리 없이 최소 구조(DCTDecode)만 사용 */
export function buildPdf(images) {
  const W = 595.28, H = 841.89, M = 20, MT = 48;
  const enc = new TextEncoder(); const chunks = []; const offsets = []; let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const obj = (num, body) => { offsets[num] = len; push(`${num} 0 obj\n`); for (const b of Array.isArray(body) ? body : [body]) push(b); push('\nendobj\n'); };
  push('%PDF-1.4\n'); push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const n = images.length;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${images.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${n} >>`);
  images.forEach((im, i) => {
    const p = 3 + i * 3, c = p + 1, x = p + 2;
    const s = Math.min((W - 2 * M) / im.w, (H - MT - M) / im.h); const w = im.w * s, h = im.h * s; const x0 = (W - w) / 2, y0 = H - MT - h;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${x} 0 R >> >> /Contents ${c} 0 R >>`);
    const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x0.toFixed(2)} ${y0.toFixed(2)} cm /Im${i} Do Q`;
    obj(c, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`);
    obj(x, [`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`, im.jpeg, '\nendstream']);
  });
  const xref = len, total = 3 + n * 3;
  let t = `xref\n0 ${total}\n0000000000 65535 f \n`; for (let i = 1; i < total; i++) t += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(t); push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

export function toCSV(headers, rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}
