// 예시 데이터 생성 (저장되지 않음). 실제 요즘의 실적이 아니며 작업자 이름도 가명입니다.
import { today, addDays, cultureLot, batchNo, productLot } from './util.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function makeDemoData(settings) {
  const r = rng(20261027);
  const rand = (a, b) => a + (b - a) * r();
  const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
  const density = settings.milkDensity || 1.03;
  const end = today();
  const start = addDays(end, -27);
  const fillerByName = (nm) => settings.fillers.find((f) => f.name === nm) || settings.fillers[0];
  const ratioOf = (mix) => (settings.mixTypes.find((m) => m.name === mix) || { ratio: 1 }).ratio;

  const products = [
    { id: 'P-PL100', code: 'P-PL100', name: '충진-플레인 100g', mixType: '플레인', weightG: 100, unit: 'ea', shelfDays: 13, erpCode: '2YOW0000001' },
    { id: 'P-PL450', code: 'P-PL450', name: '충진-플레인 450g', mixType: '플레인', weightG: 450, unit: 'ea', shelfDays: 13, erpCode: '2YOW0000002' },
    { id: 'P-SPL100', code: 'P-SPL100', name: '충진-서울 플레인 100g', mixType: '플레인', weightG: 100, unit: 'ea', shelfDays: 13, erpCode: '5BFR0000004' },
    { id: 'P-SF100', code: 'P-SF100', name: '충진-소프트 100g', mixType: '소프트', weightG: 100, unit: 'ea', shelfDays: 13, erpCode: '5BFS0000005' },
    { id: 'P-SF500', code: 'P-SF500', name: '충진-소프트 500g', mixType: '소프트', weightG: 500, unit: 'ea', shelfDays: 13, erpCode: '5BFS0000008' },
    { id: 'P-AL100', code: 'P-AL100', name: '충진-알룰로스 100g', mixType: '알룰로스', weightG: 100, unit: 'ea', shelfDays: 13, erpCode: '5BFR0000005' },
    { id: 'P-MC100', code: 'P-MC100', name: '충진-말차 100g', mixType: '말차', weightG: 100, unit: 'ea', shelfDays: 13, erpCode: '5BFS0000003' },
    { id: 'P-DR18', code: 'P-DR18', name: '마시는그릭 1.8L', mixType: '드링크', weightG: 1854, unit: 'ea', shelfDays: 19, erpCode: '2YOW0001G01' },
    { id: 'P-HJ5', code: 'P-HJ5', name: '충진-한정선 5kg', mixType: '한정선', weightG: 5000, unit: 'ea', shelfDays: 12, erpCode: '' },
  ];
  const materials = [
    { id: 'RM-001', code: 'RM-001', name: '원유', unit: 'kg', kind: 'raw', safety: 20000 },
    { id: 'RM-002', code: 'RM-002', name: '유산균 스타터', unit: '봉', kind: 'raw', safety: 40 },
    { id: 'PM-001', code: 'PM-001', name: '100g 용기', unit: 'ea', kind: 'pack', safety: 30000 },
    { id: 'PM-002', code: 'PM-002', name: '450g 용기', unit: 'ea', kind: 'pack', safety: 6000 },
    { id: 'PM-003', code: 'PM-003', name: '1.8L 드링크 병', unit: 'ea', kind: 'pack', safety: 3000 },
  ];
  const materialLots = [];
  const milkLotFor = {};
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const lot = { id: 'ml-' + d, materialCode: 'RM-001', lot: 'MLK-' + d.slice(2).replace(/-/g, ''), receivedDate: d, expiry: addDays(d, 2), qty: 56000, disposedQty: 0, supplier: '○○목장', note: '' };
    materialLots.push(lot); milkLotFor[d] = lot.id;
  }
  materialLots.push(
    { id: 'st-1', materialCode: 'RM-002', lot: 'ST-2609A', receivedDate: addDays(start, -10), expiry: addDays(end, 120), qty: 400, disposedQty: 0, supplier: '', note: '' },
    { id: 'cup100-1', materialCode: 'PM-001', lot: 'CUP100-2609', receivedDate: addDays(start, -5), expiry: '', qty: 900000, disposedQty: 0, supplier: '', note: '' },
    { id: 'cup450-1', materialCode: 'PM-002', lot: 'CUP450-2609', receivedDate: addDays(start, -5), expiry: '', qty: 120000, disposedQty: 0, supplier: '', note: '' },
    { id: 'btl18-1', materialCode: 'PM-003', lot: 'BTL18-2610', receivedDate: addDays(start, -2), expiry: '', qty: 80000, disposedQty: 0, supplier: '', note: '' },
  );

  const crews = {
    '1호기': { fill: ['김가', '이나'], cap: ['박다'], pack: ['최라', '정마'] }, '2호기': { fill: ['강바', '조사'], cap: ['박다'], pack: ['윤아', '장자'] },
    '3호기': { fill: ['한차', '오카'], cap: ['박다'], pack: ['서타', '권파'] }, '로타리': { fill: ['신하'], cap: [], pack: ['유거'] },
    '드링크': { fill: ['문너'], cap: [], pack: ['배더', '홍러'] }, '벌크': { fill: ['임머', '노버'], cap: [], pack: ['송서'] },
  };

  const cultures = [], separations = [], batches = [], packs = [];
  const tankPlan = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12'];
  const batchSeq = {};
  const addPack = (b, productCode, cupLot) => {
    const product = products.find((p) => p.code === productCode);
    const filler = settings.fillers.find((f) => f.id === b.fillerId);
    const expiry = addDays(b.date, product.shelfDays);
    packs.push({ id: `p-${b.id}-${productCode}`, batchId: b.id, date: b.date, productCode, productLot: productLot(expiry, b.date, filler ? filler.code : ''), expiry, qty: b.goodEa, kind: 'normal', workers: 0, hours: 0, usedKg: b.goodKg, packLots: cupLot ? [{ lotId: cupLot, qty: b.goodEa + b.defectEa }] : [], note: '' });
  };
  const makeBatch = (fillDay, fillerName, mixType, sources, productCode, wheyRatio, yieldR, startMin) => {
    const filler = fillerByName(fillerName);
    const product = products.find((p) => p.code === productCode);
    const fermentKg = round(sources.reduce((s, x) => s + x.kg, 0), 1);
    const ratio = ratioOf(mixType);
    const inputKg = round(fermentKg * wheyRatio * ratio, 1);            // 계근량 = 유청분리 후 그릭 + 부원료
    const ingredientKg = ratio > 1 ? round(inputKg * (1 - 1 / ratio), 1) : 0; // 엑셀 N열: 계근 × (1 − 1/비율)
    const outKg = round(fermentKg + ingredientKg, 1);
    const wasteKg = mixType === '드링크' ? 0 : round(inputKg * rand(0.005, 0.03), 1);
    const goodKg = round((inputKg - wasteKg) * yieldR, 1);
    const goodEa = Math.round(goodKg * 1000 / product.weightG);
    const defectEa = Math.round(goodEa * rand(0.002, 0.01));
    batchSeq[fillDay + filler.id] = (batchSeq[fillDay + filler.id] || 0) + 1;
    const runMin = Math.round(rand(120, 420)); const breakMin = runMin > 300 ? 30 : 0;
    const crew = crews[fillerName] || { fill: ['김가'], cap: [], pack: ['최라'] };
    const persons = crew.fill.length + crew.cap.length + crew.pack.length;
    const b = { id: `b-${fillDay}-${filler.id}-${batchSeq[fillDay + filler.id]}`, date: fillDay, batchNo: batchNo(fillDay, filler.name, batchSeq[fillDay + filler.id], mixType), fillerId: filler.id, mixType, sources, fermentKg, ingredientKg, outKg, inputKg, wasteKg, goodEa, defectEa, goodKg,
      startTime: hhmm(startMin), endTime: hhmm(startMin + runMin + breakMin), breakMin, runMin, crew, workers: persons, hours: round(runMin / 60, 2), note: '' };
    batches.push(b);
    for (const sx of sources) if (sx.moveId) { const m = separations.find((x) => x.id === sx.moveId); if (m) m.batchId = b.id; }
    return b;
  };

  for (let day = start; day <= end; day = addDays(day, 1)) {
    const daily = [];
    for (const tankId of tankPlan) {
      const cap = settings.tanks.find((t) => t.id === tankId).capT;
      const rawL = cap === 5 ? round(rand(4800, 5000)) : round(rand(1900, 2000));
      const rawKg = round(rawL * density);
      const drinkL = tankId === 'T12' ? rawL : tankId === 'T09' ? 2000 : 0;
      // T04는 필터프레스 배출 예시: 1,100 L는 필터프레스로, 나머지는 유청분리실로
      const pressL = tankId === 'T04' ? 1100 : 0;
      const type = drinkL > 0 ? '일반 드링크' : tankId === 'T11' ? '락토프리 드링크' : pressL > 0 ? '필터프레스 배출' : '일반 배양';
      const c = { id: `c-${day}-${tankId}`, date: day, tankId, seq: 1, lot: cultureLot(day, tankId, 1, settings.lotDateOffset, settings.offDays), rawL, rawKg, starterBags: cap === 5 ? 2 : 1, type,
        drinkL, drinkKg: round(drinkL * density), pressL, pressKg: round(pressL * density), rawLots: [{ lotId: milkLotFor[day], qty: rawKg }, { lotId: 'st-1', qty: cap === 5 ? 2 : 1 }], note: '', createdAt: day + 'T06:00:00' };
      cultures.push(c); daily.push(c);
    }
    // 드링크: 당일 직송 충진 (T09 2,000 L + T12 전량)
    {
      const srcs = daily.filter((c) => c.drinkL > 0).map((c) => ({ cultureId: c.id, kind: 'drink', cloths: 0, liters: c.drinkL, kg: round(c.drinkL * density, 1) }));
      const b = makeBatch(day, '드링크', '드링크', srcs, 'P-DR18', rand(0.975, 0.995), rand(0.97, 0.995), 13 * 60);
      addPack(b, 'P-DR18', 'btl18-1');
    }
    // 다음날 소분 (드링크 제외분) — 포당 무게 = 유청분리 kg ÷ 면포 수 (엑셀 방식)
    const splitDay = addDays(day, 1);
    if (splitDay <= end) {
      for (const c of daily) {
        const wheyKg = c.rawKg - c.drinkKg; if (wheyKg <= 0) continue;
        const cloths = Math.round(wheyKg / rand(48, 56));
        const kgPer = Math.floor(wheyKg / cloths * 1e6) / 1e6;
        const pressCloths = c.pressL > 0 ? Math.round(c.pressKg / kgPer) : null;
        separations.push({ id: `s-${c.id}`, cultureId: c.id, kind: 'split', date: splitDay, cloths, kgPerCloth: kgPer, kg: round(cloths * kgPer, 1), note: '', ...(pressCloths != null ? { pressCloths, roomCloths: cloths - pressCloths } : {}) });
      }
    }
    // 이틀 뒤: 반출(Flow) → 충진 배치
    const fillDay = addDays(day, 2);
    if (fillDay <= end) {
      const plan = [
        { filler: '1호기', mix: '플레인', ids: ['T01', 'T02', 'T03'], product: 'P-SPL100', cup: 'cup100-1', start: 7 * 60 + 35 },
        { filler: '3호기', mix: '소프트', ids: ['T04'], press: true, product: 'P-SF500', cup: 'cup450-1', start: 6 * 60 + 40 }, // T04 필터프레스 면포만
        { filler: '2호기', mix: '플레인', ids: ['T04', 'T05', 'T06'], product: 'P-PL100', cup: 'cup100-1', start: 7 * 60 + 50 },
        { filler: '3호기', mix: '플레인', ids: ['T07', 'T08'], product: 'P-PL450', cup: 'cup450-1', start: 8 * 60 + 10 },
        { filler: '3호기', mix: '소프트', ids: ['T09'], product: 'P-SF500', cup: 'cup450-1', start: 15 * 60 + 30 },
        { filler: '로타리', mix: '알룰로스', ids: ['T10'], product: 'P-AL100', cup: 'cup100-1', start: 8 * 60 + 20 },
        { filler: '벌크', mix: '한정선', ids: ['T11'], product: 'P-HJ5', cup: null, start: 8 * 60 + 30 },
      ];
      for (const g of plan) {
        const srcs = [];
        for (const c of daily.filter((x) => g.ids.includes(x.tankId))) {
          const sp = separations.find((s) => s.cultureId === c.id); if (!sp) continue;
          const used = separations.filter((s) => s.kind === 'move' && s.cultureId === c.id).reduce((a, s) => a + s.cloths, 0);
          let cloths = g.press ? (sp.pressCloths || 0) : sp.cloths - used; if (cloths <= 0) continue;
          if (fillDay === end && c.tankId === 'T03') cloths -= 30; // 오늘은 일부만 반출해 재고를 남김
          const mv = { id: `mv-${c.id}-${g.filler}`, cultureId: c.id, kind: 'move', date: addDays(fillDay, -1), fillDate: fillDay, fillerId: fillerByName(g.filler).id, mixType: g.mix, cloths, kg: round(cloths * sp.kgPerCloth, 1), batchId: null, source: c.pressL > 0 ? (g.press ? 'press' : 'room') : '', note: '' };
          separations.push(mv);
          srcs.push({ moveId: mv.id, cultureId: c.id, kind: 'cloth', cloths, liters: 0, kg: mv.kg });
        }
        if (!srcs.length) continue;
        if (fillDay === end && g.filler === '로타리') continue; // 오늘 반출만 되고 충진 배정은 아직인 예
        const wheyRatio = g.mix === '한정선' ? rand(0.38, 0.41) : rand(0.21, 0.24);
        const b = makeBatch(fillDay, g.filler, g.mix, srcs, g.product, wheyRatio, g.mix === '한정선' ? rand(0.99, 0.998) : rand(0.86, 0.95), g.start);
        addPack(b, g.product, g.cup);
      }
    }
  }
  for (const lot of materialLots) {
    if (lot.materialCode !== 'RM-001' || !(lot.expiry < end)) continue;
    const used = cultures.reduce((s, c) => s + (c.rawLots || []).filter((r) => r.lotId === lot.id).reduce((a, r) => a + r.qty, 0), 0);
    lot.disposedQty = Math.max(0, lot.qty - used);
  }
  // 폐기 1건
  const lastBatch = batches.filter((b) => b.mixType === '플레인').slice(-2)[0];
  const dispCulture = cultures.find((c) => c.date === addDays(end, -1) && c.tankId === 'T02');
  if (dispCulture) { const sp = separations.find((s) => s.cultureId === dispCulture.id && s.kind === 'split'); if (sp) separations.push({ id: 's-disp-1', cultureId: dispCulture.id, kind: 'dispose', date: sp.date, cloths: 3, kg: round(3 * sp.kgPerCloth, 1), note: '면포 파손' }); }

  const plans = [];
  for (let day = addDays(end, -3); day <= addDays(end, 10); day = addDays(day, 1)) {
    plans.push({ id: 'pl-' + day + '-a', date: day, productCode: 'P-SPL100', qty: 20000, note: '' }, { id: 'pl-' + day + '-b', date: day, productCode: 'P-PL100', qty: 20000, note: '' }, { id: 'pl-' + day + '-c', date: day, productCode: 'P-DR18', qty: 3500, note: '' });
  }
  return { products, materials, materialLots, cultures, separations, batches, packs, plans };
}
