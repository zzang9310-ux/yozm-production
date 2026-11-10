// LOT 추적: 원유 LOT → 배양 LOT → 유청분리(면포) → 충진 배치 → 제품 LOT
import { html, useState, useEffect, useMemo, Card, Chip, Icon, Empty, Field, Segmented, exportCSV, saveFile, toast } from '../ui.js';
import { cultureStock, traceCulture, searchLots, STATUS, OPEN_STATUSES, tankOf, fillerOf, productOf, batchPersons, batchRunMin, crewNames, packSourceInfo, packSourceMaps, productLotMatches, allPacks, dischargeCandidates, lot7, clothAge, moveAge, clothAgeTitle, ageCls } from '../model.js';
import { n, num, pct, fmtDate, dow, today, buildPdf, sum } from '../util.js';
import { shipmentsForLot } from '../shipdata.js';

/** 충진 품목(예: 충진-서울 알룰로스 100g)과 출하현황 품목(예: 서울우유 알룰로스 100g*8)이 같은 제품인지 — 브랜드·용량·맛이 모두 맞을 때만 (v243)
 *  출하 품목코드는 충진 품목코드와 체계가 달라서 이름으로 맞춤 */
const SHIP_BRANDS = [['서울', /서울/], ['곰곰', /곰곰/], ['배민', /배민/], ['홈플', /홈플/], ['요아정', /요아정/], ['춘식', /춘식/], ['수출', /수출/]];
const SHIP_CORE = { 플콩: '플레인', 소콩: '소프트', 아사이볼: '아사이', 우베코코넛: '우베', 카페라떼: '카페' };
export function shipItemMatches(productName, item) {
  const p = String(productName || '').replace(/^충진[-_]\s*/, '').replace(/\s/g, ''); const it = String(item || '').replace(/\s/g, '');
  if (!p || !it) return false;
  const brand = (s) => (SHIP_BRANDS.find(([, re]) => re.test(s)) || [''])[0];
  const pb = brand(p); if (pb !== brand(it)) return false;
  const size = (s) => { const m = s.match(/(\d+(?:\.\d+)?)(kg|g|ml|l)?/i); if (!m) return 0; const v = +m[1]; const u = (m[2] || 'g').toLowerCase(); return u === 'kg' || u === 'l' ? v * 1000 : v; };
  const ps = size(p); if (ps && ps !== size(it)) return false;
  let core = p.replace(pb, '').replace(/\d+(?:\.\d+)?(kg|g|ml|l)?/i, '');
  core = SHIP_CORE[core] || core;
  if (!core || !it.includes(core)) return false;
  if (core === '더진한' && /소프트/.test(it)) return false;
  return true;
}
/** 제품 LOT의 출고처(출고현황에 올린 출하현황 기준): "거래처 수량" 한 줄. 출고 기록이 없으면 null
 *  같은 날·같은 설비 제품은 LOT가 같아서(소비기한+설비코드+요일) 다른 품목도 함께 잡힘 → 보고 있는 제품과 같은 품목만 (v243) */
export function shipLines(state, productLot, productName = '', productCode = '') {
  const all = shipmentsForLot(state, productLot);
  if (!all.length) return null;
  // 충진 반제품 → 완제품: 기준정보 BOM의 '사용 완제품' 코드가 출하현황 품목코드와 같음 (예: 플콩 100g → 플레인 블루베리 130g·패트와매트 플레인…) (v248)
  // BOM이 없는 품목만 이름으로 맞춤
  const bom = productCode ? (state.bom || []).find((b) => (b.productCode || b.id) === productCode) : null;
  const tops = new Set((bom && bom.usedIn || []).map((u) => u && u.code).filter(Boolean));
  const rows = tops.size ? all.filter((r) => tops.has(r.code)) : productName ? all.filter((r) => shipItemMatches(productName, r.item)) : all;
  if (!rows.length) return [html`<span class="muted">출고현황에 이 품목의 출고 기록이 없습니다 (같은 제품 LOT의 다른 품목 출고만 있음)</span>`];
  // 표: 출고일 · 거래처 · (품목) · 수량 — 출고일 순, 같은 날은 수량 큰 순, 맨 아래 합계 (v247 사용자 요청: 표로 깔끔하게)
  const acc = new Map();
  for (const r of rows) { const k = `${r.date}|${r.cust}|${r.item}`; const x = acc.get(k) || { date: r.date, cust: r.cust, item: r.item, ea: 0 }; x.ea += r.ea; acc.set(k, x); }
  const list = [...acc.values()].filter((x) => x.ea !== 0).sort((a, b) => String(a.date).localeCompare(String(b.date)) || b.ea - a.ea);
  if (!list.length) return null;
  const many = true; // 완제품명은 항상 보여줌 (충진 품목명과 출하 품목명이 다른 경우가 많음 — 예: 플콩 → 플레인 블루베리 130g)
  const total = sum(list, (x) => x.ea);
  const custN = new Set(list.map((x) => x.cust)).size;
  const md = (iso) => (iso ? `${iso.slice(2, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)} (${dow(iso)})` : '—');
  return [html`<div class="box same-day ship-lot" style="border:1px solid var(--line);border-radius:8px"><table class="tbl"><thead><tr><th>출고일</th><th>거래처</th>${many ? html`<th>완제품</th>` : ''}<th class="num">수량</th></tr></thead><tbody>
    ${list.map((x, i) => { const first = i === 0 || list[i - 1].date !== x.date; return html`<tr key=${i} class=${first && i ? 'day-start' : ''}><td>${first ? md(x.date) : ''}</td><td>${x.cust}</td>${many ? html`<td class="nm">${x.item}</td>` : ''}<td class="num"><b>${n(x.ea)}</b> EA</td></tr>`; })}
    <tr class="total"><td>합계</td><td>${n(custN)}곳</td>${many ? html`<td></td>` : ''}<td class="num"><b>${n(total)}</b> EA</td></tr>
  </tbody></table></div>`];
}

const PDF_ROWS = 56; // 제품 LOT PDF 한 장에 넣는 줄 수(한 줄 ≈ 24px; 배양 LOT 2개당 1줄·출처 종류당 1줄로 어림) — 페이지 높이 1,533px(index.html .pdf-page)에서 머리글 약 110px을 뺀 안에 들어가는 값(48줄일 때 표 아래 1,250px 확인)
const shortName = (r) => String(r.product ? r.product.name : r.pk.productCode || '').replace(/^충진[-_]\s*/, '');
// 배양 LOT 목록 둘째 줄: 필터프레스·드링크로 배출한 양만 (일반 배양은 표시 안 함). 예) 필터프레스 배출 (2,000L)
const cultureOutLine = (c) => {
  const t = String(c.type || ''); const out = [];
  // v346: 배출 구분이 '필터프레스 1호기/2호기'면 호기까지 표시
  const fpName = /필터\s*프레스\s*\d\s*호기/.test(t) ? t.match(/필터\s*프레스\s*\d\s*호기/)[0] : '필터프레스';
  if (num(c.pressL) > 0) out.push(`${fpName} 배출 (${n(c.pressL)}L)`); else if (/필터/.test(t)) out.push(`${fpName} 배출`);
  if (num(c.drinkL) > 0) out.push(`드링크 배출 (${n(c.drinkL)}L)`); else if (/드링크/.test(t)) out.push('드링크 배출');
  return out.join(' · ');
};

const STATUS_FILTERS = [{ value: 'all', label: '전체' }, { value: 'open', label: '처리 중' }, { value: 'wait_split', label: '소분 대기' }, { value: 'wait_move', label: '반출 대기' }, { value: 'partial', label: '일부 반출' }, { value: 'wait_fill', label: '충진 배정 대기' }, { value: 'wait_drink', label: '드링크 대기' }, { value: 'done', label: '완료' }];
// 검색 기준: 배양 LOT(탱크에서 나온 원유가 어디로 갔는지) / 제품 LOT(제품이 어느 탱크·면포로 만들어졌는지)
const MODES = [{ value: 'culture', label: '배양 LOT' }, { value: 'product', label: '제품 LOT' }];
const isProductLotQuery = (s) => /^\d{2}-\d{4}/.test(String(s || '').trim());

/** 같은 날 같은 설비에서 충진한 제품 LOT 전부를 충진 순서대로 (배치 시작시간 → 전산 입력 시각 → 버퍼 번호 → 입력 순) */
export function sameDayPacks(state, date, fillerId) {
  const bs = state.batches.filter((b) => b.date === date && b.fillerId === fillerId);
  const ids = new Set(bs.map((b) => b.id));
  // 충진일지로 등록한 배치(열마다 배치 하나)는 그 열에 넣은 면포를 "2번 탱크 면포 19포"로 표시
  // 같은 탱크·같은 종류(면포/FP/드링크)는 한 줄로 합산. 예) 5번 탱크 9포 + 5번 탱크 8포 → "5번 탱크 면포 17포"
  // v305: 충진일지로 등록한 배치만이 아니라 반출 면포가 연결된 배치는 모두 (충진 배치 수정으로 고른 FP 면포가 안 보이던 문제)
  const clothOf = (b) => {
    if (!b || !(b.sources || []).length) return [];
    const acc = new Map();
    for (const s of b.sources || []) {
      const c = state.cultures.find((x) => x.id === s.cultureId); const tn = c ? tankOf(state, c.tankId).name : '?';
      const mv = s.moveId ? state.separations.find((m) => m.id === s.moveId) : null;
      const kind = s.kind === 'drink' ? '드링크' : mv && mv.source === 'press' ? 'FP' : '면포'; // 필터프레스 면포는 FP
      // v345: 탱크가 아니라 배양 LOT별로 묶고, 반출일 기준 경과일(가장 오래된 반출)로 색
      const key = `${c ? c.id : tn}|${kind}`;
      const u = acc.get(key) || { tn, kind, cloths: 0, liters: 0, lots: [], lot: c ? c.lot : '?', cid: c ? c.id : '', age: null };
      if (kind === '드링크') u.liters += num(s.liters); else u.cloths += num(s.cloths) || (mv ? num(mv.cloths) : 0);
      if (c && !u.lots.includes(c.lot)) u.lots.push(c.lot);
      const a = c && mv ? moveAge(c, mv) : null; if (a && (!u.age || a.days > u.age.days)) u.age = a;
      acc.set(key, u);
    }
    return [...acc.values()].map((u) => ({ press: u.kind === 'FP', drink: u.kind === '드링크', tn: u.tn, cloths: u.cloths, liters: u.liters, lots: u.lots, lot: u.lot, cid: u.cid, age: u.age,
      text: u.kind === '드링크' ? `${u.tn} 드링크 ${n(u.liters)} L` : u.kind === 'FP' ? `${u.tn} ${n(u.cloths)}포` : `${u.tn} ${u.kind} ${n(u.cloths)}포` }));
  };
  const packs = state.packs.filter((pk) => ids.has(pk.batchId) && pk.kind !== 'repack').map((pk) => {
    const pr = productOf(state, pk.productCode); const batch = bs.find((b) => b.id === pk.batchId);
    return { p: pk, batch, cloth: clothOf(batch), name: String(pr ? pr.name : pk.productCode || '').replace(/^충진[-_]\s*/, ''), unit: pr ? pr.unit || 'ea' : 'ea' };
  });
  const batchKey = (b) => { const t = b.startTime || (b.erpSpan || '').slice(0, 5); const seq = +((/버퍼(\d+)/.exec(b.batchNo || '') || [])[1] || 99); return `${/^\d{2}:\d{2}$/.test(t) ? t : '99:99'}|${String(seq).padStart(2, '0')}`; };
  packs.sort((a, b) => batchKey(a.batch).localeCompare(batchKey(b.batch)) || String(a.p.erpTime || '99:99').localeCompare(String(b.p.erpTime || '99:99')) || String(a.p.id).localeCompare(String(b.p.id)));
  // 한 배치(버퍼)에서 여러 품목을 충진했으면 품목마다 면포 몫을 배치 안 수량 비율로 어림 (v245 사용자 요청: 충진 표 품목 옆에 면포로만)
  for (const x of packs) {
    const sib = packs.filter((y) => y.batch === x.batch);
    const tot = sum(sib, (y) => num(y.p.qty));
    const bc = sum((x.batch.sources || []).filter((s) => s.kind !== 'drink'), (s) => { const mv = s.moveId ? state.separations.find((m) => m.id === s.moveId) : null; return num(s.cloths) || (mv ? num(mv.cloths) : 0); });
    if (sib.length > 1 && tot > 0 && bc > 0) { x.sharePct = num(x.p.qty) / tot * 100; x.shareCloths = bc * num(x.p.qty) / tot; x.batchCloths = bc; }
  }
  packs.forEach((x, i) => { x.seq = i + 1; x.basis = x.batch.startTime ? `배치 시작 ${x.batch.startTime}` : x.batch.erpSpan ? `전산 입력 ${x.batch.erpSpan}` : `버퍼 번호`; if (x.p.erpTime) x.basis += ` · 전산 ${x.p.erpTime}`; });
  return { key: date + fillerId, date, fillerId, filler: fillerOf(state, fillerId), packs };
}
/** 같은 날 같은 설비 충진 제품 표 (hitIds: 강조할 포장 내역 id) */
function SameDayTable({ g, hitIds, inline }) {
  if (!g.packs.length) return html`<div class="pending">이 날 이 설비의 포장 내역(제품 LOT)이 아직 없습니다.</div>`;
  // 충진일지로 등록한 배치(버퍼)는 제품 줄들 위에 제목 줄 하나: "버퍼 6 · 9번 탱크 면포 16포, 2번 탱크 면포 1포 · 11:35~12:16". 제품 줄에는 면포를 적지 않음
  const bufferLabel = (b) => { const m = /버퍼\s*(\d+)/.exec(b.batchNo || ''); return m ? `버퍼 ${m[1]}` : (b.batchNo || '배치'); };
  const rows = [];
  for (let i = 0; i < g.packs.length; i++) {
    const x = g.packs[i]; const prev = g.packs[i - 1];
    // 필터프레스(FP) 면포는 진한 FP 배지 + 굵은 글씨, 그 버퍼 줄 왼쪽에 초록 띠로 눈에 띄게
    // v327: 버퍼 제목 줄을 눈에 띄게 — [버퍼 1] 시간 · 면포 합계, 그 아래 탱크별 칩("2번 탱크 31포", FP는 초록 칩). 칩에 마우스를 올리면 배양 LOT
    if (x.cloth && x.cloth.length && (!prev || prev.batch !== x.batch)) {
      const tot = sum(x.cloth.filter((c) => !c.drink), (c) => c.cloths);
      const span = x.batch.startTime || x.batch.endTime ? `${x.batch.startTime || '?'}~${x.batch.endTime || '?'}` : '';
      rows.push(html`<tr key=${'h' + x.batch.id} class="buf-head"><td colspan="5">
        <div class="buf-title"><span class="buf-no">${bufferLabel(x.batch)}</span>${span ? html`<span class="buf-time">${span}</span>` : ''}${tot > 0 ? html`<span class="buf-sum">면포 합계 <b>${n(tot)}포</b></span>` : ''}</div>
        <div class="buf-chips">${x.cloth.map((c, ci) => html`<span key=${ci} class=${`buf-chip${c.press ? ' fp' : ''}`} title=${[c.tn, c.age ? clothAgeTitle(c.age) : ''].filter(Boolean).join(' · ')}>${c.press ? html`<b class="fp-tag">FP</b>` : ''}<b class=${ageCls(c.age)}>${c.lot}</b>${c.drink ? html` 드링크 <b>${n(c.liters)} L</b>` : html` <b>${n(c.cloths)}포</b>`}</span>`)}</div>
      </td></tr>`);
    }
    rows.push(html`<tr key=${x.p.id} class=${hitIds && hitIds.has(x.p.id) ? 'mine' : ''} title=${`충진 배치 ${x.batch.batchNo}${x.batch.erpDraft ? ' (전산 임시)' : ''} · 순서 기준: ${x.basis}`}><td class="seq">${x.seq}</td><td><b>${lot7(x.p.productLot)}</b></td><td class="nm">${x.name}${x.shareCloths != null ? html` <span class="muted" style="font-weight:400;font-size:12px" title=${`같은 배치 면포 ${n(x.batchCloths)}포를 품목 수량 비율로 나눈 어림값`}>· 면포 약 ${n(x.shareCloths, x.shareCloths < 10 ? 1 : 0)}포 (${n(x.sharePct, 0)}%)</span>` : ''}</td><td class="num">${n(x.p.qty)} ${x.unit}</td><td class="num">${x.p.expiry ? fmtDate(x.p.expiry).replace(/^20(\d{2})/, '$1') : '—'}</td></tr>`);
  }
  return html`<div class="box same-day" style=${inline ? 'margin-top:6px;border:1px solid var(--line);border-radius:8px' : ''}><table class="tbl"><thead><tr><th class="seq" title="충진 순서: 배치 시작시간 → 전산 입력 시각 → 버퍼 번호 → 입력 순">충진순서</th><th>제품 LOT</th><th>품목</th><th class="num">수량</th><th class="num">소비기한</th></tr></thead><tbody>
    ${rows}
  </tbody></table></div>`;
}

export function TracePage({ state, params, go }) {
  const [q, setQ] = useState(params.q || '');
  const status = 'all';
  const [selected, setSelected] = useState(params.cultureId || null);
  // 검색 기준: 다른 화면에서 제품 LOT(26-1020 A4 형식)로 넘어오면 제품 LOT 기준, 그 외는 배양 LOT 기준
  const [mode, setMode] = useState(params.mode || (isProductLotQuery(params.q) ? 'product' : 'culture'));
  useEffect(() => { if (params.q != null) setQ(params.q); if (params.cultureId) setSelected(params.cultureId); if (params.mode) setMode(params.mode); else if (params.q) setMode(isProductLotQuery(params.q) ? 'product' : 'culture'); }, [params.q, params.cultureId, params.mode]);

  // 충진일 검색: 날짜만 고르면 검색어 없이도 그날 충진한 제품 LOT 전부와 그날 쓰인 발효탱크(배양 LOT)가 나옴
  const [day, setDay] = useState(params.day || '');
  const hasQ = !!q.trim();
  const active = hasQ || !!day;
  const search = useMemo(() => searchLots(state, q), [state, q]);
  const rows = useMemo(() => {
    let list = state.cultures.map((c) => ({ c, stock: cultureStock(state, c.id), tank: tankOf(state, c.tankId) }));
    if (hasQ) { const ids = new Set(search.cultureIds); list = list.filter((r) => ids.has(r.c.id)); }
    else if (day) {
      // 그날 충진 배치에 들어간 배양 LOT + 그날 배양 시작·배출(LOT 앞 6자리)한 배양 LOT
      const ids = new Set(); const k = `${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}`;
      for (const b of state.batches) if (b.date === day) for (const src of b.sources || []) ids.add(src.cultureId);
      for (const c of state.cultures) if (c.date === day || String(c.lot || '').startsWith(k)) ids.add(c.id);
      list = list.filter((r) => ids.has(r.c.id));
    }
    if (status === 'open') list = list.filter((r) => OPEN_STATUSES.includes(r.stock.status));
    else if (status !== 'all') list = list.filter((r) => r.stock.status === status);
    // 최신 LOT부터: LOT 번호(배출일 yymmdd + 탱크 + 순번) 내림차순, 같으면 배양일 내림차순
    return list.sort((a, b) => String(b.c.lot || '').localeCompare(String(a.c.lot || '')) || b.c.date.localeCompare(a.c.date));
  }, [state, q, status, search, day]);

  useEffect(() => { if (rows.length && !rows.some((r) => r.c.id === selected)) setSelected(rows[0].c.id); }, [rows, mode]); // 검색 기준을 바꿔도 첫 배양 LOT를 자동 선택
  const trace = useMemo(() => selected ? traceCulture(state, selected) : null, [state, selected]);

  // 제품 LOT 목록: 검색어와 직접 일치하는 제품 LOT + 왼쪽 배양 LOT 목록에서 만들어진 제품 LOT
  const [focusPack, setFocusPack] = useState(null);
  // 충진 월 필터('' = 전체): 제품 LOT 목록과 PDF에만 적용
  const [ym, setYm] = useState(params.ym || '');
  const packRows = useMemo(() => {
    if (!active) return [];
    const s = q.trim().toLowerCase();
    const cultureIds = new Set(rows.map((r) => r.c.id));
    // 검색에서 찍어 준 제품 LOT(제품 LOT·품목명 일치, 또는 필터프레스 면포를 쓴 배치의 제품)를 '검색 일치'로
    const hitPacks = new Set(search.hits.filter((h) => h.type === 'pack').map((h) => h.id));
    const maps = packSourceMaps(state);
    const list = [];
    for (const pk of allPacks(state)) {
      if (ym && !String(pk.date || '').startsWith(ym)) continue;
      if (day && pk.date !== day) continue; // 충진일 검색: 그날 충진한 것만
      const batch = maps.batches.get(pk.batchId);
      const srcIds = (batch && batch.sources ? batch.sources : []).map((x) => x.cultureId).filter((id) => cultureIds.has(id));
      const direct = hasQ ? (hitPacks.has(pk.id) || productLotMatches(pk.productLot, s)) : true; // 검색어 없이 날짜만이면 그날 제품 전부
      if (!direct && !srcIds.length) continue;
      list.push({ pk, batch, product: productOf(state, pk.productCode), filler: batch ? fillerOf(state, batch.fillerId) : null, srcIds, direct, src: packSourceInfo(state, pk, maps) });
    }
    // 품목명·제품 LOT·필터프레스로 찾아 일치한 제품이 있으면 그 제품만 (같은 배양 LOT로 만든 다른 제품은 섞지 않음).
    // 배양 LOT·배치번호·자재 LOT로 찾았을 때만 그 LOT로 만든 제품 전체를 보여줌. 제품 LOT 기준 검색은 항상 검색어와 맞는 제품만
    const only = mode === 'product' ? list.filter((r) => r.direct) : list.some((r) => r.direct) ? list.filter((r) => r.direct) : list;
    // 같은 제품 LOT·품목은 한 줄로 묶음: 충진일지는 열(버퍼)마다 배치를 나눠 저장하므로 같은 제품 LOT의 포장 내역이 여러 건 생김 → 수량 합계, 배치·배양 LOT·면포 출처는 합집합
    const groups = new Map();
    for (const r of only) {
      const key = `${r.pk.productLot || r.pk.id}|${r.pk.productCode}`;
      if (!groups.has(key)) groups.set(key, { key, pk: r.pk, product: r.product, packs: [], batches: [], fillers: [], srcIds: [], direct: false, qty: 0, src: { press: 0, room: 0, unknown: 0, pressKg: 0, roomKg: 0, unknownKg: 0, drinkKg: 0, drink: false, cultures: [] } });
      const g = groups.get(key);
      g.packs.push(r.pk); g.qty += num(r.pk.qty); g.direct = g.direct || r.direct;
      if (r.batch && !g.batches.some((b) => b.id === r.batch.id)) { g.batches.push(r.batch); for (const k of ['press', 'room', 'unknown', 'pressKg', 'roomKg', 'unknownKg', 'drinkKg']) g.src[k] += r.src[k]; g.src.drink = g.src.drink || r.src.drink; for (const c of r.src.cultures) if (!g.src.cultures.some((x) => x.id === c.id)) g.src.cultures.push(c); }
      if (r.filler && !g.fillers.some((f) => f.id === r.filler.id)) g.fillers.push(r.filler);
      for (const id of r.srcIds) if (!g.srcIds.includes(id)) g.srcIds.push(id);
      if (r.pk.date && (!g.pk.date || r.pk.date < g.pk.date)) g.pk = r.pk; // 대표 포장 내역: 가장 이른 충진일
    }
    const merged = [...groups.values()].map((g) => {
      const parts = []; if (g.src.press > 0) parts.push('필터프레스'); if (g.src.room > 0) parts.push('유청분리실'); if (g.src.unknown > 0) parts.push('출처 미입력'); if (!parts.length && g.src.drink) parts.push('드링크');
      g.src.label = parts.length ? parts.join('+') : '—'; g.src.isPress = g.src.press > 0; g.filler = g.fillers[0] || null; g.batch = g.batches[0] || null; return g;
    });
    // 최신 제품 LOT부터 한 줄로(LOT 번호 yy-MMdd 내림차순 → 포장일 내림차순 → 검색 일치 먼저). 검색 일치는 칩 색으로만 구분 (묶어서 정렬하면 사이에 끼어 보임)
    return merged.sort((a, b) => String(b.pk.productLot || '').localeCompare(String(a.pk.productLot || '')) || String(b.pk.date || '').localeCompare(String(a.pk.date || '')) || (Number(b.direct) - Number(a.direct)));
  }, [state, q, rows, search, ym, mode, day]);
  const directPacks = packRows.filter((r) => r.direct).length;
  const pressPacks = packRows.filter((r) => r.src.isPress).length;

  // 제품 LOT 표 PDF: 충진일 오름차순, 한 장에 PDF_ROWS줄. 캡처 중(shooting)에만 화면 아래에 페이지를 그려 html2canvas로 찍음
  const [shooting, setShooting] = useState(false);
  const pdfRows = useMemo(() => [...packRows].sort((a, b) => String(a.pk.date || '').localeCompare(String(b.pk.date || '')) || String(a.pk.productLot || '').localeCompare(String(b.pk.productLot || ''))), [packRows]);
  // 배양 LOT는 한 줄에 2개씩 줄바꿈, 면포 출처는 종류마다 한 줄 → 행마다 줄 수를 어림해 한 장에 PDF_ROWS줄 분량만 넣음
  const srcParts = (r) => [r.src.pressKg > 0, r.src.roomKg > 0, r.src.unknownKg > 0, r.src.drink].filter(Boolean).length;
  const rowLines = (r) => Math.max(1, Math.ceil(r.src.cultures.length / 2), srcParts(r));
  // 배양 LOT 2개씩 한 줄. 이 제품 배치에 들어간 반출이 배출 후 4일 넘었으면 빨간 LOT (v269)
  const lotPairs = (r) => {
    const bids = new Set(r.batches.map((b) => b.id));
    const items = r.src.cultures.map((c) => { const a = clothAge(state, c, (m) => bids.has(m.batchId)); return html`<span class=${ageCls(a)} title=${clothAgeTitle(a)}>${c.lot}</span>`; });
    const out = []; for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2).map((x, k) => html`${k ? ', ' : ''}${x}`)); return out;
  };
  const pdfPages = []; { let cur = [], lines = 0; for (const r of pdfRows) { const l = rowLines(r); if (cur.length && lines + l > PDF_ROWS) { pdfPages.push(cur); cur = []; lines = 0; } cur.push(r); lines += l; } if (cur.length) pdfPages.push(cur); }
  const pdfNo = (pi, j) => pdfPages.slice(0, pi).reduce((s, p) => s + p.length, 0) + j + 1;
  const pdfNames = [...new Set(pdfRows.map(shortName))];
  const pdfTitle = `${pdfNames.slice(0, 3).join(', ')}${pdfNames.length > 3 ? ` 외 ${pdfNames.length - 3}종` : ''} 제품 LOT 추적`;
  const pdfPeriod = ym ? `${ym.slice(0, 4)}년 ${Number(ym.slice(5))}월 충진분` : '전체 기간';
  const pdfCounts = { press: pdfRows.filter((r) => r.src.isPress).length, room: pdfRows.filter((r) => !r.src.isPress && r.src.room > 0 && r.src.unknown === 0).length, unknown: pdfRows.filter((r) => !r.src.isPress && r.src.unknown > 0).length };
  const savePdf = async () => {
    if (shooting || !pdfRows.length) return;
    setShooting(true);
    try {
      const mod = await import('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.esm.js');
      const h2c = mod.default || window.html2canvas;
      await new Promise((r) => setTimeout(r, 150)); // 페이지가 그려질 시간
      const bg = getComputedStyle(document.body).backgroundColor;
      const images = [];
      for (let i = 0; i < pdfPages.length; i++) {
        const el = document.getElementById(`trace-pdf-${i}`); if (!el) continue;
        const canvas = await h2c(el, { scale: 2, backgroundColor: bg, useCORS: true, logging: false });
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
        if (!blob) throw new Error(`${i + 1}장 이미지를 만들지 못했습니다`);
        images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height });
      }
      const name = `LOT추적_${q.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/[,，]+/g, '+').slice(0, 40) || (day ? `충진 ${day}` : '검색')}${ym ? '_' + ym : ''}.pdf`;
      if (images.length && await saveFile(name, buildPdf(images))) toast(`PDF ${images.length}페이지를 저장했습니다.`);
    } catch (e) { toast(`PDF 저장 실패: ${e.message || e}`, 'bad'); }
    setShooting(false);
  };
  // 면포 출처 칸: 반출 kg로 표시(배치에 들어간 반출 합계). 필터프레스 xx kg / 면포 xx kg(유청분리실) / 출처 미입력 xx kg / 드링크 xx kg, 종류마다 한 줄
  const srcCell = (r) => {
    const s = r.src; const lines = [];
    if (s.pressKg > 0 || s.press > 0) lines.push(html`<div key="p"><span class="chip accent">필터프레스 ${n(s.pressKg)} kg</span></div>`);
    if (s.roomKg > 0 || s.room > 0) lines.push(html`<div key="r"><span class="chip sky">면포 ${n(s.roomKg)} kg</span></div>`);
    if (s.unknownKg > 0 || s.unknown > 0) lines.push(html`<div key="u">출처 미입력 ${n(s.unknownKg)} kg</div>`);
    if (s.drink) lines.push(html`<div key="d">드링크 ${n(s.drinkKg)} kg</div>`);
    return lines.length ? lines : '—';
  };
  const pdfBlock = html`<div class="pdf-pages">${pdfPages.map((page, i) => html`<div key=${i} id=${`trace-pdf-${i}`} class="pdf-page">
    <div class="shot-head"><b>${pdfTitle}</b><span>${state.settings.companyName} · ${pdfPeriod} · ${i + 1}/${pdfPages.length} · ${fmtDate(today())} 출력</span></div>
    <div class="pdf-sum">검색 "${q.trim()}" · 총 ${n(pdfRows.length)}건 · 필터프레스 ${n(pdfCounts.press)}건 · 유청분리실 ${n(pdfCounts.room)}건 · 출처 미입력 ${n(pdfCounts.unknown)}건</div>
    <table class="tbl pdf-tbl"><colgroup><col style="width:34px" /><col style="width:96px" /><col style="width:150px" /><col style="width:104px" /><col style="width:56px" /><col style="width:86px" /><col style="width:62px" /><col style="width:290px" /><col /></colgroup>
    <thead><tr><th>No.</th><th>제품 LOT</th><th>품목</th><th>충진일</th><th>설비</th><th>소비기한</th><th class="num">수량</th><th>배양 LOT</th><th>면포 출처</th></tr></thead>
    <tbody>${page.map((r, j) => html`<tr key=${r.key}><td class="num">${pdfNo(i, j)}</td><td><span class="lot">${lot7(r.pk.productLot) || '—'}</span></td><td class="wrap">${shortName(r)}</td><td>${fmtDate(r.pk.date)}(${dow(r.pk.date)})</td><td>${r.fillers.length ? r.fillers.map((f) => f.name).join('·') : '—'}</td><td>${r.pk.expiry ? fmtDate(r.pk.expiry) : '—'}</td><td class="num">${n(r.qty)}</td><td class="wrap">${r.src.cultures.length ? lotPairs(r).map((t, k) => html`<div key=${k}>${t}</div>`) : '—'}</td><td class="wrap">${srcCell(r)}</td></tr>`)}</tbody></table>
  </div>`)}</div>`;
  const pickCulture = (id) => { setSelected(id); setFocusPack(null); };
  // 제품 LOT 이력에서 배양 LOT를 누르면 배양 LOT 기준 검색으로 넘어가 그 탱크의 원유가 어디로 갔는지 추적
  const goCulture = (id) => { const c = state.cultures.find((x) => x.id === id); setMode('culture'); if (c) setQ(c.lot); setSelected(id); setFocusPack(null); };
  // 제품 LOT를 고르면 그 배치에 들어간 배양 LOT 중 하나로 이동 (왼쪽 목록에 없어도). 면포 연결이 없는 배치면 배양 LOT 대신 제품 LOT 카드만
  const pickPack = (r) => {
    setFocusPack(r.key);
    const ids = [...new Set(r.batches.flatMap((b) => b.sources || []).map((x) => x.cultureId).filter((id) => id && state.cultures.some((c) => c.id === id)))];
    setSelected(ids.includes(selected) ? selected : (r.srcIds[0] || ids[0] || null));
  };
  // 검색 기준을 바꾸면 고른 제품 LOT는 해제. 제품 LOT 기준에서는 목록의 첫 제품을 자동으로 고름
  const switchMode = (m) => { setMode(m); setFocusPack(null); };
  // 다른 화면에서 특정 제품 LOT·품목으로 넘어올 때 (params.packKey = "제품LOT|품목코드"): 목록에서 그 줄을 바로 고름 (v262)
  const [wantKey, setWantKey] = useState(params.packKey || null);
  useEffect(() => { if (params.packKey) setWantKey(params.packKey); }, [params.packKey]);
  useEffect(() => {
    if (mode !== 'product') return;
    if (wantKey) { const w = packRows.find((r) => r.key === wantKey); if (w) { pickPack(w); setWantKey(null); return; } }
    if (packRows.length && !packRows.some((r) => r.key === focusPack)) pickPack(packRows[0]);
    else if (!packRows.length && focusPack) setFocusPack(null);
  }, [mode, packRows, wantKey]);
  const focusRow = focusPack ? packRows.find((r) => r.key === focusPack) : null;
  const packOnly = focusRow && !focusRow.src.cultures.length ? focusRow : null;
  const hitIds = useMemo(() => new Set([...search.hits.map((h) => h.id), ...(focusRow ? focusRow.packs.map((p) => p.id) : [])]), [search, focusRow]);

  const counts = useMemo(() => {
    const all = state.cultures.map((c) => cultureStock(state, c.id).status);
    return { open: all.filter((s) => OPEN_STATUSES.includes(s)).length };
  }, [state]);

  const exportList = () => exportCSV('LOT현황.csv', ['배양일', '탱크', '배양 LOT', '구분', '원유 kg', '소분 면포', '포당 kg', '충진 사용 면포', '폐기', '재고 면포', '상태'],
    rows.map((r) => [r.c.date, r.tank.name, r.c.lot, r.c.type, r.c.rawKg, r.stock.splitCloths, r.stock.kgPerCloth != null ? n(r.stock.kgPerCloth, 2) : '', r.stock.usedCloths, r.stock.disposedCloths, r.stock.remaining, STATUS[r.stock.status].label]));

  return html`
    <div class="page-head"><div><div class="eyebrow">Traceability</div><h1>LOT 추적</h1></div>
      <div class="actions"><button class="btn" onClick=${exportList}><${Icon} name="download" />LOT 현황 CSV</button></div></div>

    <${Card}>
      <div class="filters">
        <${Field} label="검색 기준"><div><${Segmented} options=${MODES} value=${mode} onChange=${switchMode} /></div><//>
        <${Field} label="LOT 검색"><div class="search" style="min-width:min(100%,360px)"><${Icon} name="search" /><input id="trace-q" class="input" placeholder=${mode === 'product' ? '제품 LOT (예: 26-1020 A4) · 품목명 (여러 개는 쉼표)' : '배양 LOT (예: 261006T02-01) · 배치번호 · 자재 LOT'} value=${q} onInput=${(e) => setQ(e.target.value)} /></div><//>
        <${Field} label="충진일"><div class="row" style="flex-wrap:nowrap"><input id="trace-day" type="date" class="input" style="width:150px" value=${day} onInput=${(e) => { setDay(e.target.value); setFocusPack(null); }} />${day && html`<button class="btn sm ghost" onClick=${() => { setDay(''); setFocusPack(null); }}>전체</button>`}</div><//>
        <${Field} label="충진 월"><div class="row" style="flex-wrap:nowrap"><input id="trace-ym" type="month" class="input" style="width:150px" value=${ym} onInput=${(e) => setYm(e.target.value)} />${ym && html`<button class="btn sm ghost" onClick=${() => setYm('')}>전체</button>`}</div><//>      </div>
      ${!hasQ && day && html`<div class="row" style="margin-top:10px;font-size:12.5px;color:var(--fg-2)"><span>${fmtDate(day)}(${dow(day)}) 충진 · 배양 LOT ${rows.length}건 · 제품 LOT ${packRows.length}건</span></div>`}
      ${hasQ && html`<div class="row" style="margin-top:10px;font-size:12.5px;color:var(--fg-2)">
        <span>검색 결과: 배양 LOT ${rows.length}건${search.keyword ? ` · ${search.keyword} 작업 충진 배치 ${search.hits.filter((h) => h.type === 'batch').length}건 · 제품 LOT ${search.hits.filter((h) => h.type === 'pack').length}건` : ''}${(() => { const ph = search.hits.filter((h) => h.type === 'pack' && h.product); if (!ph.length) return ''; const names = [...new Set(ph.map((h) => h.product.replace(/^충진[-_]\s*/, '')))]; return ` · 품목 ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` 외 ${names.length - 3}종` : ''} 제품 LOT ${ph.length}건`; })()}</span>
        ${search.hits.filter((h) => h.type !== 'culture' && (!search.keyword || h.type === 'batch') && !(h.type === 'pack' && h.product)).slice(0, 8).map((h) => html`<${Chip} key=${h.id} tone="accent">${{ batch: '배치', pack: '제품 LOT', materialLot: '자재 LOT' }[h.type]} ${h.label}<//>`)}
      </div>`}
    <//>

    ${!active && !params.cultureId ? html`<${Card}><${Empty} title="LOT를 검색하거나 충진일을 고르세요">제품 포장에 찍힌 LOT(예: 26-1109 A2), 품목명(예: 소프트 500), 배양 LOT, 배치번호 중 아무거나 위 검색창에 입력하면 관련 배양 LOT와 공정 이력이 나옵니다. 충진일만 고르면 그날 충진한 제품 LOT와 발효탱크가 전부 나옵니다. '필터프레스'라고 치면 필터프레스로 작업한 배양 LOT·충진 배치·제품 LOT가 모두 나옵니다.<//><//>`
    : html`<div class="trace-layout ${active ? (mode === 'product' ? 'product-mode' : 'with-packs') : ''}" style=${!active ? 'grid-template-columns:1fr' : ''}>
      ${active && html`<div class="trace-lists">
      ${mode === 'culture' && html`<${Card} title="배양 LOT" count=${rows.length} desc=${`처리 중 ${counts.open}건`} flush>
        <div class="lot-list">
          ${rows.length === 0 && html`<${Empty} title="해당하는 LOT가 없습니다">검색어를 확인해 보세요.<//>`}
          ${rows.slice(0, 300).map((r) => html`<button key=${r.c.id} class="lot-item ${r.c.id === selected ? 'active' : ''}" onClick=${() => pickCulture(r.c.id)}>
            ${(() => { const a = clothAge(state, r.c); return html`<span class=${`lot${ageCls(a, ' ')}`} title=${a ? `가장 늦은 반출: ${clothAgeTitle(a)}` : ''}>${r.c.lot}</span>`; })()}
            <${Chip} tone=${STATUS[r.stock.status].tone} dot>${STATUS[r.stock.status].label}<//>
            <span class="meta cu-meta"><span>${fmtDate(r.c.date)}(${dow(r.c.date)}) · ${r.tank.name}</span>${cultureOutLine(r.c) && html`<span>${cultureOutLine(r.c)}</span>`}</span>
          </button>`)}
        </div>
      <//>`}
      <${Card} title="제품 LOT" count=${packRows.length} desc=${`${directPacks ? `검색 일치 ${directPacks}건` : '왼쪽 배양 LOT로 만든 제품'}${packRows.length ? ` · 필터프레스 ${pressPacks}건` : ''}${ym ? ` · ${Number(ym.slice(5))}월 충진분` : ''}`}
        actions=${packRows.length ? html`<button class="btn sm" disabled=${shooting} onClick=${savePdf} title="이 목록을 표로 정리해 A4 PDF로 저장 (충진일·소비기한·설비·수량·배양 LOT·면포 출처)"><${Icon} name="download" />${shooting ? 'PDF 만드는 중…' : `PDF 저장 (${pdfPages.length}장)`}</button>` : null} flush>
        <div class="lot-list">
          ${packRows.length === 0 && html`<${Empty} title="제품 LOT가 없습니다">이 배양 LOT로 포장된 제품이 아직 없습니다.<//>`}
          ${packRows.slice(0, 300).map((r) => html`<button key=${r.key} class="lot-item ${focusPack === r.key ? 'active' : r.srcIds.includes(selected) ? 'related' : ''}" onClick=${() => pickPack(r)} title=${`누르면 이 제품 LOT를 만든 배양탱크·유청분리·충진 이력을 보여줍니다${r.packs.length > 1 ? ` · 포장 내역 ${r.packs.length}건 묶음` : ''}`}>
            <span class="lot pk-lot">${lot7(r.pk.productLot) || '(LOT 없음)'}${shortName(r) ? html`<span class="pk-name"> - ${shortName(r)}</span>` : ''}</span>
            <${Chip} tone=${r.direct ? 'accent' : 'good'} dot=${r.direct}>${n(r.qty)} ${r.product ? r.product.unit : 'ea'}<//>
            <span class="meta pk-meta"><span>${r.fillers.length ? `${r.fillers.map((f) => f.name).join('·')} : ` : ''}${fmtDate(r.pk.date)}(${dow(r.pk.date)})${r.src.cultures.length > 1 ? ` · 탱크 ${r.src.cultures.length}개` : ''}</span>${(r.pk.expiry || r.src.isPress || r.src.label !== '—') && html`<span>${r.pk.expiry ? `소비기한 : ${fmtDate(r.pk.expiry).replace(/^20(\d{2})/, '$1')}` : ''}${r.src.isPress ? html` [<b>필터프레스</b>]` : r.src.label !== '—' ? ` [${r.src.label.replace(/유청분리실/g, '면포')}]` : ''}</span>`}</span>
          </button>`)}
        </div>
      <//>
      </div>`}
      <div class="stack">
        ${packOnly ? html`<${PackOnly} r=${packOnly} go=${go} state=${state} />` : focusRow ? html`<${LotChain} r=${focusRow} state=${state} go=${go} onPick=${goCulture} />` : mode === 'product' ? html`<${Card}><${Empty} title="제품 LOT를 선택하세요">왼쪽 목록에서 제품 LOT를 고르면 배양탱크·유청분리·충진 이력을 보여줍니다.<//><//>` : trace ? html`<${Chain} trace=${trace} hitIds=${hitIds} focusPackId=${focusPack} onShowAll=${() => setFocusPack(null)} state=${state} go=${go} />` : html`<${Card}><${Empty} title="LOT를 선택하세요">왼쪽 목록에서 배양 LOT를 고르면 공정 이력을 보여줍니다.<//><//>`}
      </div>
    </div>`}
    ${shooting && pdfBlock}`;
}

// 충진 배치에 면포(배양 LOT) 연결이 없는 제품 LOT: 다른 배양 LOT의 이력을 보여주지 않고 제품·배치 정보만
function PackOnly({ r, go, state }) {
  const b = r.batch;
  const legacy = !!(r.pk.legacy || (b && b.legacy));
  // 백데이터(전산 엑셀) 충진은 반출 기록이 없으므로, 충진일에 배출된 배양 LOT를 '참고 후보'로만 보여줌
  const cands = legacy && b ? dischargeCandidates(state, b.date) : [];
  return html`<${Card} title=${lot7(r.pk.productLot) || '(LOT 없음)'} desc=${`${shortName(r)}${legacy ? ' · 전산 백데이터' : ''}`}>
    <${KV} items=${[
      ['충진일', `${fmtDate(r.pk.date)} (${dow(r.pk.date)})`],
      ['설비', r.filler ? r.filler.name : b && b.fillerName ? b.fillerName : '—'],
      b && (b.startTime || b.endTime) && ['충진 시간', `${b.startTime || '?'}~${b.endTime || '?'}`],
      ['소비기한', r.pk.expiry ? fmtDate(r.pk.expiry) : '—'],
      ['수량', `${n(r.qty)} ${r.product ? r.product.unit : 'ea'}`],
      b && ['충진 배치', `${b.batchNo || '—'}${b.erpDraft ? ' (전산 임시)' : legacy ? ' (전산 백데이터)' : ''}`],
      b && legacy && num(b.cloths) > 0 && ['면포 사용', `${n(b.cloths)}포`],
      b && ['양품', `${n(b.goodEa)} ea${num(b.goodKg) ? ` · ${n(b.goodKg)} kg` : ''}`],
    ]} />
    ${(() => { const s = shipLines(state, r.pk.productLot, r.product ? r.product.name : '', r.pk.productCode); return s && html`<div class="kv" style="margin-top:10px"><div><span class="k">출고</span><span class="v">${s}</span></div></div>`; })()}
    ${legacy ? html`<div class="banner info" style="margin-top:12px"><${Icon} name="alert" /><span>전산 백데이터(엑셀)에서 옮긴 충진이라 반출 기록이 없어 배양 LOT가 연결되지 않습니다.${cands.length ? html` 충진일에 배출된 배양 LOT(참고): ${cands.map((c, i) => html`${i ? ', ' : ''}<button key=${c.id} class="linkish" onClick=${() => go('trace', { cultureId: c.id, q: c.lot })}>${c.lot}</button>`)}` : ' 그날 배출된 배양 LOT 기록도 없습니다.'}</span></div>`
      : html`<div class="banner warn" style="margin-top:12px"><${Icon} name="alert" /><span>${b ? '이 제품 LOT의 충진 배치에 반출 면포(배양 LOT)가 연결돼 있지 않아 배양·유청분리 이력을 추적할 수 없습니다.' : '이 제품 LOT는 충진 배치에 연결돼 있지 않습니다.'}</span>${b && html`<button onClick=${() => go('fill')}>충진/포장 실적에서 면포 선택</button>`}</div>`}
  <//>`;
}

/** 제품 LOT 중심 이력: 같은 제품 LOT로 묶인 포장·배치 전체 → 배양탱크(여러 개) · 탱크별 유청분리 · 충진(설비·날짜별, 탱크별 사용 면포 / FP) */
function LotChain({ r, state, go, onPick }) {
  // 탱크 이름은 두 자리로: "1번 탱크" → "01번 탱크" (줄이 가지런히 보이게)
  const tankName = (t) => String(t && t.name || '').replace(/^(\d)번/, '0$1번');
  const cultures = r.src.cultures.map((c) => ({ c, tank: tankOf(state, c.tankId), stock: cultureStock(state, c.id) })).sort((a, b) => String(a.c.tankId).localeCompare(String(b.c.tankId)) || String(a.c.lot).localeCompare(String(b.c.lot)));
  const weight = r.product ? num(r.product.weightG) / 1000 : 0;
  const unit = r.product ? r.product.unit || 'ea' : 'ea';
  // 이 제품 LOT의 충진 배치들이 각 배양 LOT에서 가져다 쓴 양 (면포 포 수 / 드링크 L) → 유청분리 줄 끝에 "- 19포 사용"
  // 한 배치(버퍼)에서 여러 품목을 함께 충진했으면 면포 기록은 배치 단위뿐이라, 이 품목 몫은 배치 안 수량 비율로 나눈 어림값 (v244 사용자 요청)
  const shareOf = new Map(); const together = new Map(); // 배치 id → 이 품목 비율 / 같은 배치의 다른 품목 → 수량
  for (const b of r.batches) {
    const bp = state.packs.filter((p) => p.batchId === b.id && p.kind !== 'repack');
    const mine = sum(r.packs.filter((p) => p.batchId === b.id), (p) => num(p.qty)); const all = sum(bp, (p) => num(p.qty));
    shareOf.set(b.id, all > 0 && mine > 0 ? Math.min(1, mine / all) : 1);
    for (const p of bp) if (!r.packs.some((x) => x.id === p.id)) together.set(p.productCode, (together.get(p.productCode) || 0) + num(p.qty));
  }
  const used = new Map();
  for (const b of r.batches) for (const src of b.sources || []) {
    const sh = shareOf.get(b.id) ?? 1;
    const mv = src.moveId ? state.separations.find((m) => m.id === src.moveId) : null;
    const u = used.get(src.cultureId) || { cloths: 0, kg: 0, liters: 0, fullCloths: 0, fullLiters: 0, pressCloths: 0 };
    if (src.kind === 'drink') { u.liters += num(src.liters) * sh; u.fullLiters += num(src.liters); u.kg += num(src.kg) * sh; }
    else { const c = num(src.cloths) || (mv ? num(mv.cloths) : 0); u.cloths += c * sh; u.fullCloths += c; u.kg += (num(src.kg) || (mv ? num(mv.kg) : 0)) * sh; if (mv && mv.source === 'press') { u.press = true; u.pressCloths += c * sh; } } // u.press: 이 제품 배치가 그 배양 LOT의 필터프레스 면포를 썼는지 (v264) · pressCloths: 그중 FP 포 수 (v305)
    used.set(src.cultureId, u);
  }
  const shared = together.size > 0;
  const r1 = (v) => n(v, Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1);
  // v305: 필터프레스 면포를 썼으면 유청분리 줄에도 FP 표시 (전부 FP면 "필터프레스 40포", 섞였으면 "면포 10포 + FP 30포")
  const usedText = (id) => { const u = used.get(id); if (!u) return ''; const parts = [];
    if (u.cloths > 0) { const fp = u.pressCloths || 0, room = u.cloths - fp; const what = fp > 0.05 ? (room > 0.05 ? `면포 ${r1(room)}포 + FP ${r1(fp)}포` : `${r1(fp)}포`) : `${r1(u.cloths)}포`; parts.push(`${shared ? '약 ' : ''}${what}${u.kg > 0 ? ` · ${n(u.kg)} kg` : ''}`); }
    if (u.liters > 0) parts.push(`드링크 ${shared ? '약 ' : ''}${r1(u.liters)} L`); if (!parts.length) return '';
    return html` - ${u.pressCloths > 0.05 ? html`<span class="chip accent" title="필터프레스에서 작업한 면포">필터프레스</span> ` : ''}<b>${parts.join(' · ')} 사용</b>${shared && u.fullCloths > u.cloths + 0.05 ? html` <span class="muted">(배치 전체 ${n(u.fullCloths)}포 중 수량 비율)</span>` : ''}`; };
  // v269: 이 제품 배치에 들어간 반출 기준 면포 경과일 (배출 → 반출 4일 넘으면 빨간 LOT)
  const bids = new Set(r.batches.map((b) => b.id));
  const ageOf = (c) => clothAge(state, c, (m) => bids.has(m.batchId));
  const rows = [];
  for (const x of cultures) { const a = ageOf(x.c); rows.push({ step: '배양탱크', text: html`<b>${tankName(x.tank)}</b> · <button class=${`linkish lot${ageCls(a, ' ')}`} onClick=${() => onPick(x.c.id)} title=${`이 배양 LOT의 공정 이력 상세${a ? ` · ${clothAgeTitle(a)}` : ''}`}>${x.c.lot}</button>${a && a.old ? html` <span class="age-old">(배출 후 ${a.days}일 반출)</span>` : ''} · 배양 시작 ${fmtDate(x.c.date)} (${dow(x.c.date)}) · 원유 <b>${n(x.c.rawL)} L · ${n(x.c.rawKg)} kg</b>${x.stock.hasPress && (used.get(x.c.id) || {}).press ? html` <span style="white-space:nowrap;font-size:12px"><span class="chip accent">FP</span> 필터프레스 배출 <b>${n(x.stock.pressL)} L · ${n(x.stock.pressKg)} kg</b></span>` : ''}` }); } // v264: FP는 이 제품 배치가 실제로 FP 면포를 썼을 때만 (탱크 일부가 FP로 배출됐어도 이 제품은 면포면 표시 안 함)
  for (const x of cultures) {
    const s = x.stock.splits[0];
    rows.push({ step: '유청분리', text: s ? html`<b>${tankName(x.tank)}</b>${usedText(x.c.id) || html` <span class="muted">사용 기록 없음</span>`} <span class="muted">· 탱크 전체 면포 ${n(x.stock.splitCloths)}포 · ${n(x.stock.splitKg)} kg (포당 ${n(x.stock.kgPerCloth, 2)} kg${s.pressCloths != null ? ` · 면포 ${n(s.roomCloths)} + FP ${n(s.pressCloths)}` : ''})</span>` : html`<b>${tankName(x.tank)}</b> <span class="muted">소분 아직 없음</span>${usedText(x.c.id)}` });
  }
  if (shared && cultures.length) rows.push({ step: '유청분리', text: html`<span class="muted">같은 배치에서 ${[...together].map(([code, q]) => { const p = productOf(state, code); return `${String(p ? p.name : code).replace(/^충진[-_]\s*/, '')} ${n(q)} ea`; }).join(', ')}도 함께 충진 — 면포는 배치 단위로만 기록돼 이 품목 몫은 수량 비율로 나눈 어림값입니다</span>` });
  // 충진: 설비·날짜별로 묶어 이 제품 LOT의 수량을 적고, 그 아래에 그날 그 설비에서 충진한 제품 전부를 충진 순서대로 (이 제품 LOT 줄은 강조)
  const groups = [];
  for (const b of r.batches) {
    const key = `${b.fillerId}|${b.date}`;
    let g = groups.find((x) => x.key === key); if (!g) { g = { key, fillerId: b.fillerId, filler: fillerOf(state, b.fillerId), date: b.date, batches: [], qty: 0, mixes: new Set() }; groups.push(g); }
    g.batches.push(b); g.qty += sum(r.packs.filter((p) => p.batchId === b.id), (p) => num(p.qty)); if (b.mixType) g.mixes.add(b.mixType);
  }
  groups.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const mine = new Set(r.packs.map((p) => p.id));
  for (const g of groups) rows.push({ step: '충진', text: html`<div><b>${g.filler.name}</b> · ${fmtDate(g.date)} (${dow(g.date)}) · 양품 <b>${n(g.qty)} ${unit}</b>${weight ? ` · ${n(g.qty * weight, 0)} kg` : ''}${g.mixes.size ? ` · ${[...g.mixes].join('·')}` : ''}${g.batches.length > 1 ? html` <span class="muted">(배치 ${g.batches.length}건)</span>` : ''}</div><${SameDayTable} g=${sameDayPacks(state, g.date, g.fillerId)} hitIds=${mine} inline />` });
  if (!groups.length) rows.push({ step: '충진', text: html`<span class="muted">아직 없음</span>` });
  const ships = shipLines(state, r.pk.productLot, r.product ? r.product.name : '', r.pk.productCode);
  if (ships) for (const s of ships) rows.push({ step: '출고', text: s });
  const dates = [...new Set(r.batches.map((b) => fmtDate(b.date)))];
  return html`<${Card} title=${html`<span class="lot">${lot7(r.pk.productLot) || '(LOT 없음)'}</span>`} desc=${`${shortName(r)} · ${n(r.qty)} ${unit} · 충진 ${dates.join(', ') || '—'}${r.pk.expiry ? ` · 소비기한 ${fmtDate(r.pk.expiry)}` : ''}${r.packs.length > 1 ? ` · 포장 내역 ${r.packs.length}건 묶음` : ''}`}
      actions=${html`${r.src.isPress && html`<${Chip} tone="accent">FP<//>`}${cultures.map((x) => { const a = ageOf(x.c); return html`<button key=${x.c.id} class=${`btn sm${ageCls(a, ' ')}`} onClick=${() => onPick(x.c.id)} title=${`이 배양 LOT의 공정 이력 상세 보기${a ? ` · ${clothAgeTitle(a)}` : ''}`}><${Icon} name="eye" />${x.c.lot}</button>`; })}`} flush>
    <div class="table-wrap"><table class="tbl hist"><thead><tr><th style="width:110px">공정</th><th>내용</th></tr></thead>
      <tbody>${(() => { const merged = []; for (const x of rows) { const last = merged[merged.length - 1]; if (last && last.step === x.step) last.items.push(x.text); else merged.push({ step: x.step, items: [x.text] }); } // 공정별로 한 행: 배양탱크·유청분리·충진 각각 하나로 묶고 탱크(설비)마다 줄바꿈
        return merged.map((g, i) => html`<tr key=${i}><td><${Chip} tone=${g.step === '배양탱크' ? 'accent' : g.step === '충진' ? 'good' : g.step === '출고' ? 'info' : ''}>${g.step}<//></td><td>${g.items.map((t, k) => html`<div key=${k} style=${k ? 'margin-top:6px' : ''}>${t}</div>`)}</td></tr>`); })()}</tbody></table></div>
  <//>`;
}

function Node({ icon, title, done, hit, last, children }) {
  return html`<div class="node ${done ? 'done' : ''} ${hit ? 'hit' : ''}">
    <div class="rail"><div class="pin"><${Icon} name=${icon} size="16" /></div>${!last && html`<div class="line"></div>`}</div>
    <div class="body"><h3>${title}</h3>${children}</div>
  </div>`;
}
function KV({ items }) {
  return html`<div class="kv">${items.filter((x) => x).map(([k, v]) => html`<div key=${k}><span class="k">${k}</span><span class="v">${v}</span></div>`)}</div>`;
}

function Chain({ trace, hitIds, focusPackId, onShowAll, state, go }) {
  const { culture: c, tank, stock, rawLots, batches, balance } = trace;
  const st = STATUS[stock.status];
  const allPacks = batches.flatMap((b) => b.packs.map((p) => ({ ...p, batch: b })));
  // 제품 LOT를 골라 들어왔으면 그 제품을 만든 배치의 충진만 보여줌 (같은 배양 LOT의 다른 배치는 '전체 보기'로)
  const focusPack = focusPackId ? allPacks.find((p) => p.id === focusPackId) : null;
  const focusBatchId = focusPack ? focusPack.batchId : null;
  // 고른 제품 LOT가 이 배양 LOT의 배치에 없으면 다른 충진을 보여주지 않음
  const shownBatches = focusPackId ? batches.filter((b) => b.batch.id === focusBatchId) : batches;
  const p = (v) => balance.rawKg > 0 && v != null ? pct(v / balance.rawKg * 100) : '—';
  // 공정 흐름 상세 '충진' 아래: 같은 날 같은 설비에서 충진한 제품 LOT 전부 (다른 배양 LOT의 배치 포함).
  // 제품 LOT를 골라 들어왔으면 그 제품의 충진일·설비 하나, 아니면 보이는 충진 배치들의 (날짜·설비)별로
  const sameDay = useMemo(() => {
    const keys = [];
    const addKey = (date, fillerId) => { if (date && fillerId && !keys.some((k) => k.date === date && k.fillerId === fillerId)) keys.push({ date, fillerId }); };
    if (focusPack && focusPack.batch) addKey(focusPack.batch.batch.date, focusPack.batch.batch.fillerId);
    else for (const b of shownBatches) addKey(b.batch.date, b.batch.fillerId);
    return keys.map(({ date, fillerId }) => sameDayPacks(state, date, fillerId));
  }, [state, focusPackId, shownBatches.map((b) => b.batch.id).join()]);
  const [detail, setDetail] = useState(false);
  // 제품 LOT 목록에서 고르면 상세 보기를 열어 해당 제품 LOT까지 보여줌
  useEffect(() => { if (focusPackId) setDetail(true); }, [focusPackId]);

  // 기본 보기(완제품 컴플레인 역추적용): 배양탱크 번호 · 유청분리(소분 수) · 충진(설비·날짜·수량)만
  // 유청분리 날짜는 표시하지 않음: 배양탱크 배출일이 곧 유청분리 입고일이라 배양 날짜와 같음
  const rows = [];
  // 배양: 원유 총량(L·kg). 드링크 직송이 있으면 그 양도 함께
  rows.push({ step: '배양탱크', date: c.date, text: html`<b>${tank.name}</b> · 배양 시작 ${fmtDate(c.date)} (${dow(c.date)}) · 원유 <b>${n(c.rawL)} L · ${n(c.rawKg)} kg</b>${stock.hasDrink ? html` · 드링크 이동 ${n(stock.drinkL)} L · ${n(stock.drinkKg)} kg` : ''}` });
  if (stock.hasWhey) {
    // 유청분리로 간 원유를 경로별로: 필터프레스(배양 실적의 이동량) + 유청분리실(나머지). L은 kg ÷ 비중
    const density = num(state.settings.milkDensity) || 1.03;
    const roomKg = stock.hasPress ? stock.wheyRoomKg : stock.wheyKg;
    const roomL = Math.round(roomKg / density);
    // 둘째 줄: 경로별 양 (가독성 때문에 소분 줄과 분리)
    const routeParts = [stock.hasPress ? html`<span class="chip accent">필터프레스</span> ${n(stock.pressL)} L · ${n(stock.pressKg)} kg` : null, roomKg > 0 ? html`유청분리실 ${n(roomL)} L · ${n(roomKg)} kg` : null].filter((x) => x);
    const route = routeParts.length ? html`<div class="line2">${routeParts.map((x, i) => html`${i ? ' · ' : ''}${x}`)}</div>` : '';
    if (stock.splits.length) for (const s of stock.splits) rows.push({ step: '유청분리', date: s.date, text: html`<div>소분 <b>${n(s.cloths)}포 · ${n(s.kg)} kg</b> (포당 ${n(s.kgPerCloth, 2)} kg${s.pressCloths != null ? ` · 유청분리실 ${n(s.roomCloths)}포 + 필터프레스 ${n(s.pressCloths)}포` : ''})</div>${route}` });
    else rows.push({ step: '유청분리', date: '', text: html`<div><span class="muted">아직 없음</span>${stock.hasPress ? html` <span class="muted">· 예상 약 ${n(stock.pressClothsEst, 1)}포 · 실제 소분 수 입력 대기</span>` : ''}</div>${route}` });
  }
  // 충진: 배치별로 묶어 양품(ea·kg)과 이 LOT에서 가져다 쓴 양을 면포 출처(필터프레스 / 유청분리실)별로 표시
  // 출처는 반출 기록의 '면포 출처'에서 옴. 필터프레스 탱크인데 출처가 비어 있으면(구버전 반출) '출처 미입력'
  const srcLabel = (u) => u.kind === 'drink' ? '드링크' : u.source === 'press' ? html`<span class="chip accent">필터프레스</span>` : u.source === 'room' || !stock.hasPress ? '유청분리실' : html`<span class="muted">출처 미입력</span>`;
  // 같은 배치에 함께 들어간 다른 배양 LOT의 면포 출처 (제품 LOT의 필터프레스 표시가 이쪽에서 올 수 있음)
  const otherLabel = (o) => { if (o.kind === 'drink') return '드링크'; const mv = o.moveId && state.separations.find((s) => s.id === o.moveId); const src = mv ? mv.source || '' : ''; return src === 'press' ? html`<span class="chip accent">필터프레스</span>` : src === 'room' || !(o.culture && num(o.culture.pressL) > 0) ? '유청분리실' : '출처 미입력'; };
  const byBatch = [];
  for (const b of shownBatches) {
    const g = byBatch.find((x) => x.batch.id === b.batch.id);
    if (g) { g.uses.push(b); g.kg += b.kg; g.share += b.share; } else byBatch.push({ batch: b.batch, filler: b.filler, goodKg: b.goodKg, otherSources: b.otherSources, uses: [b], kg: b.kg, share: b.share });
  }
  // 첫째 줄: 설비·날짜·양품, 둘째 줄: 이 LOT에서 쓴 양(출처별)·배치 비중·유형
  // v270: 충진 줄마다 이 배양 LOT 자신의 면포 경과일(배출 → 이 배치로 반출) 색·일수 (다른 LOT 색만 보여 헷갈린다는 사용자 의견)
  for (const g of byBatch) { const ga = clothAge(state, c, (m) => m.batchId === g.batch.id); rows.push({ step: '충진', date: g.batch.date, hit: hitIds.has(g.batch.id), text: html`<div><b>${g.filler.name}</b> · ${fmtDate(g.batch.date)} (${dow(g.batch.date)}) · 양품 <b>${n(g.batch.goodEa)} ea</b>${g.goodKg ? ` · ${n(g.goodKg)} kg` : ''} · 사용</div><div class="line2">${ga ? html`<b class=${ageCls(ga)} title=${clothAgeTitle(ga)}>${c.lot} 배출 후 ${ga.days}일</b> · ` : ''}${g.uses.map((u, i) => html`${i ? ' + ' : ''}${srcLabel(u)} <b>${u.kind === 'drink' ? `${n(u.liters)} L` : `${n(u.cloths)}포`} · ${n(u.kg)} kg</b>`)}${g.otherSources.length ? ` (배치의 ${pct(g.share * 100, 0)})` : ''}${g.batch.mixType ? ` · ${g.batch.mixType}` : ''}</div>${g.otherSources.length ? html`<div class="line2 muted" style="font-size:12px" title=${`같은 배치에 함께 들어간 배양 LOT: ${g.otherSources.map((o) => `${o.culture ? o.culture.lot : o.cultureId} ${o.kind === 'drink' ? `${n(o.liters)} L` : `${n(o.cloths)}포`}`).join(', ')}`}>같은 배치에 다른 배양 LOT ${g.otherSources.length}개 함께 들어감</div>` : ''}` }); } // v270: 다른 LOT 이름은 빼고 개수만 (사용자: 검색한 LOT와 상관없는 LOT가 보여 헷갈림)
  if (!shownBatches.length) rows.push({ step: '충진', date: '', text: html`<span class="muted">아직 없음</span>` });

  // v269: 이 배양 LOT의 반출 중 배출 후 4일 이상 지난 것이 있으면 빨간 LOT (제품 LOT를 골라 들어왔으면 그 배치 반출만)
  const cAge = clothAge(state, c, focusBatchId ? (m) => m.batchId === focusBatchId : null);
  return html`
    <${Card} title=${html`<span class=${`lot${ageCls(cAge, ' ')}`} title=${clothAgeTitle(cAge)}>${c.lot}</span>${cAge && cAge.old ? html` <span class="age-old">배출 후 ${cAge.days}일 반출</span>` : ''}`} desc=${`${tank.name} · 배양일 ${fmtDate(c.date)}(${dow(c.date)}) · ${c.type || ''}`}
      actions=${html`${stock.hasPress && html`<${Chip} tone="accent">필터프레스 ${n(stock.pressL)} L<//>`}<${Chip} tone=${st.tone} dot>${st.label}<//><button class="btn sm" onClick=${() => setDetail(!detail)}><${Icon} name=${detail ? 'x' : 'eye'} />${detail ? '간단히' : '상세 보기'}</button>`} flush>
      <div class="table-wrap"><table class="tbl hist">
        <thead><tr><th style="width:110px">공정</th><th>내용</th></tr></thead>
        <tbody>${rows.map((r, i) => html`<tr key=${i} class=${r.hit ? 'hit' : ''}><td><${Chip} tone=${r.step === '배양탱크' ? 'accent' : r.step === '충진' ? 'good' : ''}>${r.step}<//></td><td>${r.text}</td></tr>`)}</tbody>
      </table></div>
      ${focusPack && html`<div class="note" style="padding:8px 14px;border-top:1px solid var(--line)">제품 LOT <b>${lot7(focusPack.productLot)}</b>을 만든 충진만 표시 중${batches.length > shownBatches.length ? html` · 이 배양 LOT의 다른 충진 ${batches.length - shownBatches.length}건 숨김 · <button class="linkish" onClick=${onShowAll}>충진 전체 보기</button>` : ''}</div>`}
    <//>
    ${detail && html`<${Card} title="물량 수지" actions=${html`<button class="btn sm" onClick=${() => go('culture', { date: c.date })}><${Icon} name="edit" />배양 실적</button>`}>
      <div class="balance">
        <div><span class="k">원유 투입</span><span class="v">${n(balance.rawKg)} kg</span><span class="p">100%</span></div>
        ${stock.hasPress && html`<div><span class="k">필터프레스 이동</span><span class="v">${n(stock.pressKg)} kg</span><span class="p">${p(stock.pressKg)} · ${n(stock.pressL)} L · 예상 약 ${n(stock.pressClothsEst, 1)}포</span></div>`}
        ${stock.hasWhey && html`<div><span class="k">소분 면포</span><span class="v">${n(balance.splitKg)} kg</span><span class="p">${p(balance.splitKg)} · ${stock.splitCloths}포</span></div>`}
        ${stock.hasDrink && html`<div><span class="k">드링크 이동</span><span class="v">${n(stock.drinkKg)} kg</span><span class="p">${p(stock.drinkKg)} · ${n(stock.drinkL)} L</span></div>`}
        <div><span class="k">충진 반출</span><span class="v">${n(balance.usedKg)} kg</span><span class="p">${p(balance.usedKg)}${stock.usedCloths ? ` · ${stock.usedCloths}포` : ''}${stock.drinkUsedL ? ` · ${n(stock.drinkUsedL)} L` : ''}</span></div>
        <div><span class="k">계근 투입(배분)</span><span class="v">${n(balance.inputKg)} kg</span><span class="p">${p(balance.inputKg)}</span></div>
        <div><span class="k">양품(배분)</span><span class="v">${n(balance.goodKg)} kg</span><span class="p">종합 수율 ${p(balance.goodKg)}</span></div>
      </div>
    <//>`}

    ${detail && html`<${Card} title="공정 흐름 상세">
      <div class="chain">
        <${Node} icon="flask" title="배양" done hit=${hitIds.has(c.id)}>
          <div class="box ${hitIds.has(c.id) ? 'hit' : ''}"><div class="t"><span>${tank.name} <b>${c.lot}</b></span><span>${fmtDate(c.date)}</span></div>
            <${KV} items=${[['원유량', `${n(c.rawL)} L · ${n(c.rawKg)} kg`], ['유산균', `${n(c.starterBags)} 봉`], ['배출 구분', c.type || '—'], stock.hasDrink && ['드링크 이동 (당일)', `${n(stock.drinkL)} L · ${n(stock.drinkKg)} kg`], stock.hasPress && ['필터프레스 이동', `${n(stock.pressL)} L · ${n(stock.pressKg)} kg → 예상 약 ${n(stock.pressClothsEst, 1)}포 (${n(stock.pressKgPerCloth, 1)} kg/포)`], stock.hasPress && stock.wheyRoomKg > 0 && ['유청분리실 대상', `${n(stock.wheyRoomKg)} kg`], stock.hasDrink && !stock.hasPress && stock.hasWhey && ['유청분리 대상', `${n(stock.wheyKg)} kg`], c.note && ['비고', c.note]]} /></div>
        <//>
        <${Node} icon="funnel" title="유청분리 · 면포 소분" done=${stock.splits.length > 0 || !stock.hasWhey}>
          ${!stock.hasWhey ? html`<div class="pending">드링크로 전량 이동 · 유청분리 공정 없음</div>`
            : stock.splits.length === 0 ? html`<div class="pending">${stock.hasPress ? `필터프레스 ${n(stock.pressL)} L 배출 · 예상 약 ${n(stock.pressClothsEst, 1)}포 · 실제 소분 수 입력 대기. ` : '아직 소분 기록이 없습니다. '}<button class="linkish" onClick=${() => go('separation', { cultureId: c.id })}>유청분리 실적 입력 →</button></div>`
            : stock.splits.map((s) => html`<div key=${s.id} class="box"><div class="t"><span>소분 <b>${n(s.cloths)}포</b> × ${n(s.kgPerCloth, 2)} kg${s.pressCloths != null ? html` <span class="muted">(유청분리실 ${n(s.roomCloths)} + 필터프레스 ${n(s.pressCloths)})</span>` : ''}</span></div>
              <${KV} items=${[['총 중량', `${n(s.kg, 1)} kg`], ['현재 재고', `${n(stock.remaining)}포 · ${n(stock.remainingKg)} kg`], ['충진 사용', `${n(stock.usedCloths)}포`], stock.disposedCloths > 0 && ['폐기', `${n(stock.disposedCloths)}포 · ${n(stock.disposedKg, 1)} kg`], s.note && ['비고', s.note]]} /></div>`)}
          ${stock.disposes.map((s) => html`<div key=${s.id} class="box" style="border-color:var(--bad)"><div class="t"><span><${Chip} tone="bad">${s.source === 'press' ? 'FP 폐기' : '폐기'}<//> ${n(s.cloths)}포 · ${n(s.kg, 1)} kg${s.source === 'press' ? html` <span class="muted">· 필터프레스 면포</span>` : ''}</span><span>${fmtDate(s.date)}</span></div>${s.note && html`<div class="note">${s.note}</div>`}</div>`)}
        <//>
        ${stock.hasWhey && html`<${Node} icon="right" title="반출 (유청분리 → 충진설비)" done=${stock.moves.length > 0}>
          ${stock.moves.length === 0 ? html`<div class="pending">${stock.splits.length ? html`반출 기록이 없습니다. 재고 ${n(stock.remaining)}포. <button class="linkish" onClick=${() => go('separation', { cultureId: c.id })}>반출 기록 →</button>` : '소분 후 충진설비로 반출하면 여기에 표시됩니다.'}</div>`
            : stock.moves.map((m) => html`<div key=${m.id} class="box ${focusBatchId && m.batchId === focusBatchId ? 'focus-use' : hitIds.has(m.id) ? 'hit' : ''}">${focusBatchId && m.batchId === focusBatchId && html`<div class="focus-tag"><${Icon} name="check" size="13" />제품 LOT ${focusPack.productLot}${focusPack.product ? ` · ${String(focusPack.product.name).replace(/^충진[-_]\s*/, '')}` : ''}에 사용</div>`}<div class="t"><span>${m.source === 'press' ? html`<${Chip} tone="accent">필터프레스<//> ` : ''}${m.fillerId ? fillerOf(state, m.fillerId).name : '설비 대기'} <b>${m.mixType || ''}</b> ${n(m.cloths)}포 · ${n(m.kg, 1)} kg</span><span class="row">${m.batch ? html`<${Chip} tone="good">${m.batch.batchNo}<//>` : html`<${Chip} tone="info" dot>충진 배정 대기<//>`}${(() => { const a = moveAge(c, m); return html`<span class=${ageCls(a)} title=${clothAgeTitle(a)}>${fmtDate(m.date)}${a && a.old ? ` · 배출 후 ${a.days}일` : ''}</span>`; })()}</span></div>${m.note && html`<div class="note">${m.note}</div>`}</div>`)}
          ${stock.remaining > 0 && stock.moves.length > 0 && html`<div class="pending">남은 재고 ${n(stock.remaining)}포 · ${n(stock.remainingKg)} kg</div>`}
        <//>`}
        <${Node} icon="package" title=${focusPack ? `충진 (제품 LOT ${lot7(focusPack.productLot)}의 배치만)` : '충진'} done=${batches.length > 0} last=${sameDay.length === 0}>
          ${batches.length === 0 ? html`<div class="pending">아직 충진 배치에 배정되지 않았습니다.${(stock.pendingMoves.length > 0 || stock.drinkRemainingL > 0) && html` ${stock.pendingMoves.length > 0 ? `반출 ${stock.pendingMoves.length}건` : ''}${stock.pendingMoves.length > 0 && stock.drinkRemainingL > 0 ? ' · ' : ''}${stock.drinkRemainingL > 0 ? `드링크 ${n(stock.drinkRemainingL)} L` : ''} 대기 중. <button class="linkish" onClick=${() => go('fill', { cultureId: c.id })}>충진 배치 등록 →</button>`}</div>`
            : shownBatches.map((b) => html`<div key=${b.batch.id} class="box ${hitIds.has(b.batch.id) ? 'hit' : ''}"><div class="t"><span>${b.filler.name} <b>${b.batch.batchNo}</b></span><span class="row"><${Chip} tone=${b.yieldPct == null ? '' : b.yieldPct >= 92 ? 'good' : b.yieldPct >= 85 ? 'warn' : 'bad'}>충진 수율 ${pct(b.yieldPct)}<//><span>${fmtDate(b.batch.date)}</span></span></div>
              <${KV} items=${[['이 LOT 사용', `${b.kind === 'drink' ? `드링크 ${n(b.liters)} L` : `${b.source === 'press' ? '필터프레스' : b.source === 'room' || !stock.hasPress ? '유청분리실' : '출처 미입력'} ${n(b.cloths)}포`} · ${n(b.kg, 1)} kg (${pct(b.share * 100, 0)})`], ['재공품 유형', b.batch.mixType || '—'], ['출고 → 계근', `${n(b.batch.outKg, 0)} → ${n(b.batch.inputKg, 0)} kg`], ['양품', `${n(b.batch.goodEa)} ea · ${n(b.goodKg, 1)} kg`], ['불량 / 폐기', `${n(b.batch.defectEa)} ea / ${n(b.batch.wasteKg, 1)} kg`], ['인원 · 가동', `${n(batchPersons(b.batch))}명 · ${n(batchRunMin(b.batch))}분`], crewNames(b.batch).length > 0 && ['작업자', crewNames(b.batch).join(', ')]]} />
              ${b.otherSources.length > 0 && html`<div class="note" style="margin-top:6px">${b.otherSources.map((s) => html`<button key=${s.cultureId} class="linkish" style="margin-right:8px" onClick=${() => go('trace', { cultureId: s.cultureId })}>${s.culture ? s.culture.lot : s.cultureId}</button>`)}</div>`}</div>`)}
        <//>
        ${sameDay.map((g, gi) => html`<${Node} key=${g.key} icon="box" title=${`${g.filler.name} ${fmtDate(g.date)}(${dow(g.date)}) 충진 제품 · ${g.packs.length}건`} done=${g.packs.length > 0} last=${gi === sameDay.length - 1}>
          <${SameDayTable} g=${g} hitIds=${focusPackId ? new Set([focusPackId]) : null} />
        <//>`)}
      </div>
    <//>`}`;
}
