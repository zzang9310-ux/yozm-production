// 공통 UI 컴포넌트 (Preact + htm)
import { html, render, useState, useEffect, useRef, useMemo, useCallback } from 'https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js';
import { subscribe, getState } from './store.js';
import { n, toCSV } from './util.js';

export { html, render, useState, useEffect, useRef, useMemo, useCallback };

export function useStore() {
  const [s, setS] = useState(getState());
  useEffect(() => subscribe(setS), []);
  return s;
}

// ---------- icons ----------
const PATHS = {
  home: 'M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  flask: 'M9 3h6M10 3v6L4.5 19a1 1 0 0 0 .9 1.5h13.2a1 1 0 0 0 .9-1.5L14 9V3',
  funnel: 'M3 4h18l-7 9v6l-4 2v-8L3 4z',
  package: 'M21 8 12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
  box: 'M4 7h16v13H4zM4 7l2-4h12l2 4M10 11h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  up: 'M18 15l-6-6-6 6',
  down: 'M6 9l6 6 6-6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 3v12M6 11l6 6 6-6M4 21h16',
  upload: 'M12 21V9M6 13l6-6 6 6M4 3h16',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 3 2 20h20L12 3zM12 10v4M12 17v1',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  calendar: 'M4 5h16v16H4zM4 10h16M8 3v4M16 3v4',
  clipboard: 'M9 3h6v3H9zM6 5h-1v16h14V5h-1M9 12h6M9 16h6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  milk: 'M8 2h8v3l2 4v13H6V9l2-4V2zM6 13h12',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};
export function Icon({ name, size = 18 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${PATHS[name] || ''} /></svg>`;
}

// ---------- toast ----------
let toastSet = () => {};
let toastId = 0;
export function toast(msg, tone = '') {
  const id = ++toastId;
  toastSet((list) => [...list, { id, msg, tone }]);
  setTimeout(() => toastSet((list) => list.filter((t) => t.id !== id)), 3200);
}
export function Toasts() {
  const [list, setList] = useState([]);
  useEffect(() => { toastSet = setList; return () => { toastSet = () => {}; }; }, []);
  return html`<div class="toasts" role="status" aria-live="polite">${list.map((t) => html`<div key=${t.id} class="toast ${t.tone}">${t.msg}</div>`)}</div>`;
}

// ---------- confirm (alert/confirm 대화상자는 뷰어에서 동작하지 않으므로 자체 구현) ----------
let confirmSet = () => {};
export function confirmAsync(message, { ok = '삭제', danger = true } = {}) {
  return new Promise((resolve) => confirmSet({ message, ok, danger, resolve }));
}
export function ConfirmHost() {
  const [c, setC] = useState(null);
  useEffect(() => { confirmSet = setC; return () => { confirmSet = () => {}; }; }, []);
  if (!c) return null;
  const close = (v) => { c.resolve(v); setC(null); };
  return html`<${Modal} title="확인" onClose=${() => close(false)} narrow footer=${html`
    <button class="btn" onClick=${() => close(false)}>취소</button>
    <button class="btn ${c.danger ? 'danger' : 'primary'}" onClick=${() => close(true)}>${c.ok}</button>`}>
    <p style="margin:0">${c.message}</p>
  <//>`;
}

// ---------- layout primitives ----------
export function Card({ title, desc, count, actions, children, flush, style, className }) {
  return html`<section class=${`card ${className || ''}`} style=${style || ''}>
    ${(title || actions) && html`<div class="card-head"><div><h2>${title}${count != null && html`<span class="count">${count}</span>`}</h2>${desc && html`<div class="desc">${desc}</div>`}</div>${actions && html`<div class="row">${actions}</div>`}</div>`}
    <div class="card-body ${flush ? 'flush' : ''}">${children}</div>
  </section>`;
}
export function Stat({ k, v, unit, s, hero }) {
  return html`<div class="stat ${hero ? 'hero' : ''}"><div class="k">${k}</div><div class="v">${v}${unit && html`<small>${unit}</small>`}</div>${s && html`<div class="s">${s}</div>`}</div>`;
}
export function Chip({ tone = '', children, dot }) {
  return html`<span class="chip ${tone}">${dot && html`<i></i>`}${children}</span>`;
}
export function Field({ label, hint, children, class: cls = '' }) {
  return html`<div class="field ${cls}">${label && html`<label>${label}</label>`}${children}${hint && html`<span class="hint">${hint}</span>`}</div>`;
}
export function Empty({ title, children }) {
  return html`<div class="empty">${title && html`<b>${title}</b>`}${children}</div>`;
}
export function Modal({ title, onClose, children, footer, narrow }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return html`<div class="modal-bg" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal" role="dialog" aria-modal="true" style=${narrow ? 'width:min(440px,100%)' : ''}>
      <div class="m-head"><h3>${title}</h3><button class="icon-btn" aria-label="닫기" onClick=${onClose}><${Icon} name="x" /></button></div>
      <div class="m-body">${children}</div>
      ${footer && html`<div class="m-foot">${footer}</div>`}
    </div></div>`;
}
export function Segmented({ options, value, onChange }) {
  return html`<div class="seg" role="tablist">${options.map((o) => html`<button key=${o.value} role="tab" aria-selected=${o.value === value} class=${o.value === value ? 'active' : ''} onClick=${() => onChange(o.value)}>${o.label}</button>`)}</div>`;
}

/** cols: [{key, label, num, render(row), sub(row)}] */
/** groups(선택): 머리글 위에 묶음 줄 [{label, span}] — 예) 클레임 3칸 · 자사검사 4칸 */
export function DataTable({ cols, rows, keyFn = (r, i) => r.id ?? i, total, empty, onRowClick, rowClass, groups }) {
  // 묶음 줄이 있으면 고정 폭 표(table-layout:fixed)가 첫 줄 기준으로 폭을 나누므로 colgroup으로 칸 폭을 지정
  // 묶음이 시작하는 칸(gs)에는 진한 세로선 (index.html .tbl.grouped)
  const gs = new Set(); if (groups) { let at = 0; for (const g of groups) { if (at > 0) gs.add(at); at += g.span; } }
  const cls = (c, j) => [c.num ? 'num' : '', gs.has(j) ? 'gs' : '', c.cls || ''].filter(Boolean).join(' ');
  // 셀 병합(v321): 열에 mergeKey(r)가 있으면 이어진 줄의 값이 같을 때 첫 줄 칸을 rowspan으로 합침 (나머지 줄은 칸 생략)
  const spans = new Map();
  for (const c of cols) {
    if (!c.mergeKey) continue;
    const s = new Array(rows.length).fill(1);
    for (let i = 0; i < rows.length;) { let j = i + 1; const k = c.mergeKey(rows[i]); while (j < rows.length && c.mergeKey(rows[j]) === k) { s[j] = 0; j++; } s[i] = j - i; i = j; }
    spans.set(c.key, s);
  }
  return html`<div class="table-wrap"><table class=${groups ? 'tbl grouped' : 'tbl'}>
    ${groups && cols.some((c) => c.width) && html`<colgroup>${cols.map((c) => html`<col key=${c.key} style=${c.width ? `width:${c.width}` : ''} />`)}</colgroup>`}
    <thead>${groups && html`<tr class="grp">${groups.map((g, i) => html`<th key=${i} colspan=${g.span} class=${[g.label ? 'has' : '', i > 0 ? 'gs' : ''].filter(Boolean).join(' ')}>${g.label}</th>`)}</tr>`}<tr>${cols.map((c, j) => html`<th key=${c.key} class=${cls(c, j)} style=${c.width ? `width:${c.width}` : ''}>${c.label}</th>`)}</tr></thead>
    <tbody>
      ${rows.length === 0 && html`<tr><td colspan=${cols.length}>${empty || html`<${Empty}>표시할 데이터가 없습니다.<//>`}</td></tr>`}
      ${rows.map((r, i) => html`<tr key=${keyFn(r, i)} class=${rowClass ? rowClass(r) : ''} style=${onRowClick ? 'cursor:pointer' : ''} onClick=${onRowClick ? () => onRowClick(r) : null}>
        ${cols.map((c, j) => { const sp = spans.get(c.key); if (sp && sp[i] === 0) return null;
          return html`<td key=${c.key} class=${[cls(c, j), sp ? 'merged' : ''].filter(Boolean).join(' ')} rowspan=${sp && sp[i] > 1 ? sp[i] : undefined}>${c.render ? c.render(r) : r[c.key]}${c.sub && html`<span class="sub">${c.sub(r)}</span>`}</td>`; })}
      </tr>`)}
      ${total && html`<tr class="total">${cols.map((c) => html`<td key=${c.key} class=${c.num ? 'num' : ''}>${c.total ? c.total(total) : (c.key === cols[0].key ? '합계' : '')}</td>`)}</tr>`}
    </tbody></table></div>`;
}

// ---------- CSV 내보내기 ----------
let downloadsNs;
async function getDownloads() {
  if (downloadsNs !== undefined) return downloadsNs;
  downloadsNs = null;
  try { if (window.claude?.use) downloadsNs = await window.claude.use('downloads'); } catch { downloadsNs = null; }
  return downloadsNs;
}
/** 파일(Blob/문자열) 저장: 다운로드 기능 → 일반 브라우저 다운로드 순. 저장 요청이 받아들여지면 true */
export async function saveFile(filename, data) {
  const dl = await getDownloads();
  if (dl) {
    try { await dl.save({ filename, data }); toast(`${filename} 저장을 요청했습니다.`); return true; }
    catch (e) { if (e && e.code === 'declined') { toast('저장을 취소했습니다.'); return false; } }
  }
  try {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast(`${filename} 다운로드를 시작했습니다.`); return true;
  } catch { toast('이 환경에서는 파일을 저장할 수 없습니다.', 'bad'); return false; }
}
export async function exportCSV(filename, headers, rows) {
  const csv = toCSV(headers, rows);
  const dl = await getDownloads();
  if (dl) {
    try { await dl.save({ filename, data: csv }); toast(`${filename} 저장을 요청했습니다.`); return; } catch { /* fall through */ }
  }
  if (!window.claude) {
    try {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = filename; a.click();
      toast(`${filename} 다운로드를 시작했습니다.`); return;
    } catch { /* fall through to clipboard */ }
  }
  try { await navigator.clipboard.writeText(csv); toast('CSV 내용을 클립보드에 복사했습니다. 스프레드시트에 붙여넣으세요.'); }
  catch { toast('CSV를 내보낼 수 없는 환경입니다.', 'bad'); }
}

// ---------- 차트: 막대(양) + 선(비율) 복합, SVG ----------
/** hideBarAxis: 왼쪽 막대 수치 축을 숨김(값은 마우스를 올리면 툴팁으로). extra(d): 툴팁에 덧붙일 줄 */
// bar2Label을 주면 막대 두 개(bar, bar2)를 나란히 그림 — 단위가 달라 각자 자기 최대값 기준으로 높이를 잡음(왼쪽 축은 숨기는 것을 전제)
/** 막대(+둘째 막대)+선 차트. sub(d) → 문자열 배열을 주면 각 막대 라벨 아래에 그 줄들을 항상 표시(마우스 없이). 선 축(오른쪽 %) 숫자는 표시하지 않음 */
export function BarLineChart({ data, barLabel, lineLabel, barUnit = '', lineUnit = '', lineMin, lineMax, height = 220, width = 720, barDigits = 0, lineDigits = 1, hideBarAxis = false, extra, bar2Label, bar2Unit = '', bar2Digits = 0, sub }) {
  const [tip, setTip] = useState(null);
  const two = !!bar2Label;
  const subLines = sub ? data.map((d) => (sub(d) || []).filter((s) => s != null && s !== '')) : null;
  const subN = subLines ? Math.max(0, ...subLines.map((l) => l.length)) : 0;
  const W = width, H = height, padL = hideBarAxis ? 14 : 46, padR = 14, padT = 14, padB = 30 + subN * 14;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxBar = Math.max(1, ...data.map((d) => d.bar || 0));
  const maxBar2 = Math.max(1, ...data.map((d) => d.bar2 || 0));
  const lineVals = data.map((d) => d.line).filter((v) => v != null);
  const lmax = lineMax || Math.max(1, ...lineVals);
  const lmin = lineVals.length ? Math.min(...lineVals) : 0;
  // 선 축 범위: lineMin/lineMax를 주면 그대로(예: 수율 0~100%), 없으면 값 범위에 맞춰 5 단위로
  const lo = lineMin != null ? lineMin : Math.max(0, Math.floor((lmin - (lmax - lmin) * 0.3) / 5) * 5);
  const hi = lineMax != null ? lineMax : Math.ceil(Math.max(lmax, lo + 1) / 5) * 5;
  const n_ = data.length || 1;
  const slot = iw / n_;
  const bw = two ? Math.max(3, Math.min(22, slot * 0.3)) : Math.max(3, Math.min(28, slot * 0.6));
  const bx1 = (i) => two ? padL + slot * i + slot / 2 - bw - 1.5 : padL + slot * i + slot / 2 - bw / 2;
  const bx2 = (i) => padL + slot * i + slot / 2 + 1.5;
  const y = (v) => padT + ih - (v / maxBar) * ih;
  const y2 = (v) => padT + ih - (v / maxBar2) * ih;
  const yl = (v) => padT + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxBar);
  const path = data.map((d, i) => d.line == null ? null : `${i === 0 || data[i - 1].line == null ? 'M' : 'L'}${padL + slot * i + slot / 2},${yl(d.line)}`).filter(Boolean).join(' ');
  const labelEvery = Math.ceil(n_ / 12);
  // 선(수율) 점 위 숫자: 칸이 좁으면 소수점을 빼고, 그래도 좁으면 건너뛰며 표시. 위쪽 끝에 닿는 점은 숫자를 점 아래로
  const ptDigits = slot < 34 ? 0 : lineDigits;
  const ptEvery = slot < 22 ? Math.ceil(22 / slot) : 1;
  const ptY = (v) => (yl(v) - 9 < padT + 8 ? yl(v) + 16 : yl(v) - 9);
  return html`<div class="chart-wrap">
    <div class="legend"><span><i style="background:var(--s1)"></i>${barLabel}</span>${two && html`<span><i style="background:var(--s3)"></i>${bar2Label}</span>`}${lineLabel && html`<span><i style="background:var(--s2)"></i>${lineLabel}</span>`}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" onMouseLeave=${() => setTip(null)}>
      <g class="grid">${ticks.map((t) => html`<line x1=${padL} x2=${W - padR} y1=${y(t)} y2=${y(t)} />`)}</g>
      <g class="axis">
        ${!hideBarAxis && ticks.map((t) => html`<text x=${padL - 6} y=${y(t) + 4} text-anchor="end">${n(t, 0)}</text>`)}
        ${data.map((d, i) => i % labelEvery === 0 && html`<text x=${padL + slot * i + slot / 2} y=${padT + ih + 20} text-anchor="middle">${d.label}</text>`)}
      </g>
      ${subLines && data.map((d, i) => subLines[i].map((s, j) => html`<text key=${`s${i}-${j}`} class="lbl" x=${padL + slot * i + slot / 2} y=${padT + ih + 34 + j * 14} text-anchor="middle">${s}</text>`))}
      ${data.map((d, i) => html`<rect key=${i} class="bar ${d.hl ? 'hl' : ''}" x=${bx1(i)} y=${y(d.bar || 0)} width=${bw} height=${Math.max(0, padT + ih - y(d.bar || 0))} rx="3" />`)}
      ${two && data.map((d, i) => html`<rect key=${'b' + i} class="bar b2 ${d.hl ? 'hl' : ''}" x=${bx2(i)} y=${y2(d.bar2 || 0)} width=${bw} height=${Math.max(0, padT + ih - y2(d.bar2 || 0))} rx="3" />`)}
      ${lineLabel && html`<path class="ln" d=${path} />`}
      ${lineLabel && data.map((d, i) => d.line != null && html`<circle key=${'p' + i} class="pt" cx=${padL + slot * i + slot / 2} cy=${yl(d.line)} r="3.5" />`)}
      ${lineLabel && data.map((d, i) => d.line != null && i % ptEvery === 0 && html`<text key=${'v' + i} class="pt-val" x=${padL + slot * i + slot / 2} y=${ptY(d.line)} text-anchor="middle">${n(d.line, ptDigits)}${lineUnit}</text>`)}
      ${data.map((d, i) => html`<rect key=${'h' + i} x=${padL + slot * i} y=${padT} width=${slot} height=${ih} fill="transparent"
        onMouseEnter=${(e) => setTip({ i, x: (padL + slot * i + slot / 2) / W * 100, y: y(d.bar || 0) / H * 100 })} />`)}
    </svg>
    ${tip && html`<div class="chart-tip" style="left:${tip.x}%;top:${tip.y}%"><b>${data[tip.i].title || data[tip.i].label}</b><br/>${barLabel} ${n(data[tip.i].bar, barDigits)}${barUnit}${two ? html`<br/>${bar2Label} ${n(data[tip.i].bar2, bar2Digits)}${bar2Unit}` : ''}${extra && extra(data[tip.i]) ? html`<br/>${extra(data[tip.i])}` : ''}${lineLabel && data[tip.i].line != null ? html`<br/>${lineLabel} ${n(data[tip.i].line, lineDigits)}${lineUnit}` : ''}</div>`}
  </div>`;
}

/** 도넛(원형) 차트: data = [{label, value, sub?}] · 색은 --c1~--c8 순서 고정 · 가운데에 합계, 오른쪽에 범례(값·비중) */
export function DonutChart({ data, unit = '', digits = 0, centerLabel = '합계' }) {
  const [hover, setHover] = useState(null);
  const items = data.filter((d) => d.value > 0);
  const total = items.reduce((s, d) => s + d.value, 0);
  const cx = 110, cy = 110, R = 100, r = 64;
  const polar = (a, rad) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  let acc = -Math.PI / 2;
  const slices = items.map((d, i) => {
    const frac = total > 0 ? d.value / total : 0; const a0 = acc, a1 = acc + frac * Math.PI * 2; acc = a1;
    let path;
    if (frac >= 0.9999) path = `M${cx},${cy - R}A${R},${R} 0 1 1 ${cx - 0.01},${cy - R}L${cx - 0.01},${cy - r}A${r},${r} 0 1 0 ${cx},${cy - r}Z`;
    else { const [x0, y0] = polar(a0, R), [x1, y1] = polar(a1, R), [x2, y2] = polar(a1, r), [x3, y3] = polar(a0, r); const big = frac > 0.5 ? 1 : 0; path = `M${x0},${y0}A${R},${R} 0 ${big} 1 ${x1},${y1}L${x2},${y2}A${r},${r} 0 ${big} 0 ${x3},${y3}Z`; }
    return { ...d, i, frac, path, color: `var(--c${(i % 8) + 1})` };
  });
  const cur = hover != null ? slices[hover] : null;
  return html`<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 220 220" onMouseLeave=${() => setHover(null)}>
      ${items.length === 0 ? html`<circle cx=${cx} cy=${cy} r=${(R + r) / 2} fill="none" stroke="var(--line)" stroke-width=${R - r} />`
        : slices.map((s) => html`<path key=${s.i} d=${s.path} fill=${s.color} stroke="var(--surface)" stroke-width="2" opacity=${hover == null || hover === s.i ? 1 : 0.35} onMouseEnter=${() => setHover(s.i)}><title>${s.label} · ${n(s.value, digits)}${unit} · ${n(s.frac * 100, 1)}%</title></path>`)}
      <text x=${cx} y=${cy - 6} text-anchor="middle" class="donut-k">${cur ? cur.label : centerLabel}</text>
      <text x=${cx} y=${cy + 16} text-anchor="middle" class="donut-v">${cur ? `${n(cur.frac * 100, 1)}%` : `${n(total, digits)}${unit}`}</text>
    </svg>
    <div class="donut-legend">
      ${slices.map((s) => html`<div key=${s.i} class="row-l ${hover === s.i ? 'on' : ''}" onMouseEnter=${() => setHover(s.i)} onMouseLeave=${() => setHover(null)}><i style=${`background:${s.color}`}></i><span class="lb">${s.label}</span><span class="v">${n(s.value, digits)}${unit}</span><span class="p">${n(s.frac * 100, 1)}%</span></div>`)}
      ${items.length === 0 && html`<div class="muted">실적이 없습니다.</div>`}
    </div>
  </div>`;
}
