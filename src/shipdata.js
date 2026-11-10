// 출고현황: 전산 "출하현황 (날짜).xlsx"를 읽어 월별 요약 문서로 저장 (원본 2만여 줄을 그대로 두지 않음)
//  · 거래처 = 집계 거래처 → 없으면 손익채널 → 둘 다 없으면 납품처('요즘_폐기' 같은 사내 출고는 '사내 · 폐기')
//  · 줄 유형 r: 0 판매(공급가 있음) · 1 무상(공급가 0: 폐기·CS·샘플·광고 등) · 2 반품(출고량 음수)
//  · shipments 모음에 달마다 2건: {id:'YYYY-MM', kind:'month'} 요약 + {id:'YYYY-MM-lots', kind:'lots'} 제품 LOT별 출고처
//  · 표 데이터는 Firestore에서도 저장되도록 "쉼표·줄바꿈 문자열"로 압축 (배열 안 배열을 쓰지 않음)
import { loadXLSX, erpLotToApp } from './excel.js';
import { lot7 } from './model.js';

const serialToISO = (v) => {
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  const m = String(v || '').trim().match(/^(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
};
const num = (v) => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
const clean = (s) => String(s ?? '').trim();
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/** 거래처 이름 정하기 (집계 거래처 우선) */
function custOf(agg, pl, dest) {
  if (agg) return { n: agg, internal: false };
  if (pl) return { n: pl, internal: false };
  if (/^요즘_/.test(dest)) return { n: `사내 · ${dest.replace(/^요즘_/, '')}`, internal: true };
  return { n: dest || '기타', internal: false };
}

/** 출하현황 엑셀(ArrayBuffer) → 달별 {month, lots} 문서 배열 */
export async function parseShipXlsx(buf, fileName = '') {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const hi = aoa.findIndex((r) => r.some((c) => clean(c) === '출하일자') && r.some((c) => clean(c) === '품목코드'));
  if (hi < 0) throw new Error('출하일자·품목코드 열을 찾지 못했습니다. 전산의 "출하현황" 엑셀인지 확인하세요.');
  const head = aoa[hi].map((c) => clean(c).replace(/\s/g, ''));
  const col = (...names) => { for (const nm of names) { const i = head.indexOf(nm); if (i >= 0) return i; } return -1; };
  const C = {
    date: col('출하일자'), dest: col('납품처'), pl: col('손익채널'), agg: col('집계거래처'), code: col('품목코드'), name: col('품목명'),
    bizBig: col('업체대분류'), bizSub: col('업체소분류'), ch: col('채널구분'), kind: col('품목구분'), grp: col('품목군'), big: col('품목대분류'), mid: col('품목중분류'),
    rep: col('매출(영업)담당', '영업담당', '매출담당'), lot: col('LOT번호'), ea: col('출고량'), kg: col('출고중량(kg)', '출고중량'), sales: col('공급가'), move: col('이동구분'),
  };
  for (const k of ['date', 'code', 'ea']) if (C[k] < 0) throw new Error(`필수 열(${k === 'date' ? '출하일자' : k === 'code' ? '품목코드' : '출고량'})이 없습니다.`);
  const g = (r, k) => (C[k] >= 0 ? r[C[k]] : '');

  const months = new Map(); // ym → 누적 상태
  const M = (ym) => {
    if (!months.has(ym)) months.set(ym, { ym, rows: 0, from: '', to: '', custs: [], custIx: new Map(), items: [], itemIx: new Map(), reps: [], repIx: new Map(), f: new Map(), fresh: new Map(), lots: new Map() });
    return months.get(ym);
  };
  const ix = (m, list, map, key, make) => { let i = map.get(key); if (i == null) { i = list.length; list.push(make()); map.set(key, i); } return i; };

  for (let r = hi + 1; r < aoa.length; r++) {
    const row = aoa[r];
    const date = serialToISO(g(row, 'date'));
    const code = clean(g(row, 'code'));
    if (!date || !code) continue; // 2행 머리글·합계 줄
    const m = M(date.slice(0, 7));
    m.rows++; if (!m.from || date < m.from) m.from = date; if (!m.to || date > m.to) m.to = date;
    const dest = clean(g(row, 'dest')); const agg = clean(g(row, 'agg')); const pl = clean(g(row, 'pl'));
    const cu = custOf(agg, pl, dest);
    const c = ix(m, m.custs, m.custIx, cu.n, () => ({ n: cu.n, ch: clean(g(row, 'ch')) || (cu.internal ? '사내' : '기타'), sub: clean(g(row, 'bizSub')), biz: clean(g(row, 'bizBig')), pl, internal: cu.internal }));
    const i = ix(m, m.items, m.itemIx, code, () => ({ code, n: clean(g(row, 'name')), grp: clean(g(row, 'grp')) || '기타', big: clean(g(row, 'big')), mid: clean(g(row, 'mid')), kind: clean(g(row, 'kind')) }));
    const repName = clean(g(row, 'rep')) || '(없음)';
    const p = ix(m, m.reps, m.repIx, repName, () => repName);
    const ea = num(g(row, 'ea')); const kg = num(g(row, 'kg')); const sales = num(g(row, 'sales'));
    const t = ea < 0 ? 2 : sales === 0 ? 1 : 0;
    const day = Number(date.slice(8, 10));
    const fk = `${day},${c},${i},${p},${t}`;
    const fv = m.f.get(fk) || { ea: 0, kg: 0, sales: 0, lines: 0 };
    fv.ea += ea; fv.kg += kg; fv.sales += sales; fv.lines += 1; m.f.set(fk, fv);
    // 제품 LOT("2026.09.15 B3" = 소비기한 + 설비코드요일)
    const lotRaw = clean(g(row, 'lot'));
    const lm = lotRaw.match(/^(\d{4})\.(\d{2})\.(\d{2})\s*([A-Za-z]\d)$/);
    if (lm) {
      const lot = lot7(erpLotToApp(lotRaw));
      const lk = `${lot}|${i}|${c}|${day}`; m.lots.set(lk, (m.lots.get(lk) || 0) + ea); // 출고일(일)까지 (v246: LOT 추적에 출고일 표시)
      if (t === 0) { // 출고 시점 남은 소비기한 (판매 출고만)
        const left = dayDiff(date, `${lm[1]}-${lm[2]}-${lm[3]}`);
        if (left > -30 && left < 120) { const rk = `${c},${i},${left}`; m.fresh.set(rk, (m.fresh.get(rk) || 0) + ea); }
      }
    }
  }
  if (!months.size) throw new Error('출하 줄을 하나도 읽지 못했습니다.');
  const r2 = (x) => Math.round(x * 100) / 100;
  const now = new Date().toISOString();
  const docs = [];
  for (const m of months.values()) {
    const f = [...m.f.entries()].map(([k, v]) => `${k},${r2(v.ea)},${r2(v.kg)},${Math.round(v.sales)},${v.lines}`).join('\n');
    const fresh = [...m.fresh.entries()].map(([k, v]) => `${k},${r2(v)}`).join('\n');
    const lots = [...m.lots.entries()].filter(([, v]) => v !== 0).map(([k, v]) => { const [lot, i, c, day] = k.split('|'); return `${lot},${i},${c},${r2(v)},${day}`; }).join('\n');
    docs.push({ id: m.ym, kind: 'month', ym: m.ym, file: fileName, uploadedAt: now, rows: m.rows, from: m.from, to: m.to, custs: m.custs, items: m.items, reps: m.reps, f, fresh });
    docs.push({ id: `${m.ym}-lots`, kind: 'lots', ym: m.ym, file: fileName, uploadedAt: now, custs: m.custs.map((x) => x.n), items: m.items.map((x) => ({ code: x.code, n: x.n })), lots });
  }
  return docs.sort((a, b) => a.id.localeCompare(b.id));
}

/** 월 요약 문서 → 계산하기 쉬운 형태 */
export function decodeMonth(doc) {
  if (!doc) return null;
  const f = String(doc.f || '').split('\n').filter(Boolean).map((s) => { const a = s.split(','); return { day: +a[0], c: +a[1], i: +a[2], p: +a[3], t: +a[4], ea: +a[5], kg: +a[6], sales: +a[7], lines: +a[8] }; });
  const fresh = String(doc.fresh || '').split('\n').filter(Boolean).map((s) => { const a = s.split(','); return { c: +a[0], i: +a[1], left: +a[2], ea: +a[3] }; });
  return { ...doc, f, fresh };
}

/** 제품 LOT로 출고처 찾기: [{item, cust, ea, ym, date}] (모든 달). date는 v246 이후 올린 파일에만 있음 (예전 파일은 '') */
export function shipmentsForLot(state, productLot) {
  const key = lot7(productLot || '').trim();
  if (!key) return [];
  const out = [];
  // v316: 출고현황(shipments)은 주인만 읽음 → 다른 사람은 모두 읽는 사본(shiplots)으로. 같은 달이 둘 다 있으면 shipments 쪽
  const docs = new Map();
  for (const d of state.shiplots || []) if (d && d.id) docs.set(d.id, d);
  for (const d of state.shipments || []) if (d && d.id && d.kind === 'lots') docs.set(d.id, d);
  for (const d of docs.values()) {
    if (d.kind !== 'lots' || !d.lots) continue;
    if (!String(d.lots).includes(key)) continue; // 빠른 거르기
    for (const s of String(d.lots).split('\n')) {
      if (!s.startsWith(key + ',')) continue;
      const a = s.split(',');
      const it = d.items[+a[1]] || {}; out.push({ ym: d.ym, item: it.n || it.code || '', code: it.code || '', cust: d.custs[+a[2]] || '', ea: +a[3], date: a[4] ? `${d.ym}-${String(a[4]).padStart(2, '0')}` : '' });
    }
  }
  return out;
}
