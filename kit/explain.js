/* explain.js: the runtime for explain pages. One file, no dependencies.
   It draws .k-flow diagrams, .k-diagram templates, .k-dots scores, .k-model sliders, .k-steps and Mermaid blocks.
   In Node (no DOM) it only sets globalThis.Explain, so cli/agent-pages.mjs can lint with the same parsers.
   The flow parser and layout (marked below) come from Anthropic's html-plan skill. See ../NOTICE.md. */
(function () {
'use strict';
const HAS_DOM = typeof document !== 'undefined';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function dedent(text) {
  const lines = String(text).replace(/\t/g, '  ').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length), 999);
  return lines.map((l) => l.slice(ind === 999 ? 0 : ind)).join('\n');
}
function srcOf(el) {
  const s = el.querySelector(':scope > script[type="text/plain"]');
  return dedent(s ? s.textContent : '');
}

/* ─── From html-plan (Apache-2.0 / MIT, Anthropic). Changed: TONES uses the kit's color ramps;
       parseFlow and layoutFlow are local constants instead of properties of a namespace;
       parseFlow reads tag:, zone and legend; layoutFlow reserves a row for a tag, pads groups by 22 px
       at the bottom, and places each group label in a corner that no arrow crosses. ─── */
const MARK = { '+': 'new', '-': 'gone', '~': 'mod', '!': 'hl' };
function takeMark(line) { const m = line.match(/^([+\-~!])\s+(?=\S)|^([+\-!])(?=[A-Za-z_])/); return m && !/^--/.test(line) && !/^->/.test(line) ? [MARK[m[1] || m[2]], line.slice(m[0].length)] : [null, line]; }
const SHAPES = new Set(['box', 'pill', 'diamond', 'db', 'circle', 'note', 'hex', 'actor']);
const TONES = new Set(['gray', 'purple', 'teal', 'coral', 'pink', 'blue', 'green', 'amber', 'red', 'accent', 'muted', 'ink']);
const EDGE_RE = /^(\S+)\s+(<?)(-->|->|=>|==>|-x->|\.\.>)\s*(\S+?)(?:\s*:\s*(.*))?$/;

/** Flow DSL → { nodes:{id:{id,label,sub,shape,tone,mark,href,tag,detail}}, edges:[], grid:[[id|null]], groups:[{label,ids,zone}], dir, legend, errors:[] } */
const parseFlow = function parseFlow(text) {
  const m = { nodes: {}, order: [], edges: [], grid: [], groups: [], dir: 'TB', legend: false, errors: [] };
  const node = (id, ln) => { if (!/^[\w.-]+$/.test(id)) m.errors.push(`line ${ln}: bad node id "${id}"`); if (!m.nodes[id]) { m.nodes[id] = { id, label: id, sub: '', shape: 'box', tone: '', mark: null, href: '', tag: '', detail: [] }; m.order.push(id); } return m.nodes[id]; };
  let last = null;
  text.split('\n').forEach((raw, i) => {
    const ln = i + 1;
    if (!raw.trim() || /^\s*\/\//.test(raw)) return;
    if (/^\s+\S/.test(raw) && last) { last.detail.push(raw.trim()); return; }   // indented → detail of previous node
    let line = raw.trim(); last = null;
    let [mark, rest] = takeMark(line); line = rest;
    let mm;
    if ((mm = line.match(/^dir\s*[:=]?\s*(LR|TB)$/i))) { m.dir = mm[1].toUpperCase(); return; }
    if (/^legend$/i.test(line)) { m.legend = true; return; }
    if (line.startsWith('|')) {                                                     // grid row
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      m.grid.push(cells.map((c) => (c && c !== '.' && c !== '·') ? (node(c, ln), c) : null)); return;
    }
    if ((mm = line.match(/^(group|zone)\s+(?:"([^"]+)"|([^:]+?))\s*:\s*(.+)$/i))) {
      const ids = mm[4].split(/[\s,]+/).filter(Boolean); ids.forEach((id) => node(id, ln));
      m.groups.push({ label: mm[2] || mm[3], ids, tone: '', zone: mm[1].toLowerCase() === 'zone' }); return;
    }
    if ((mm = line.match(EDGE_RE))) {
      const [, a, back, op, b, label] = mm; node(a, ln); node(b, ln);
      m.edges.push({ from: a, to: b, label: (label || '').trim(), dash: op === '-->' || op === '..>', bold: op === '=>' || op === '==>', both: back === '<', mark, ln }); return;
    }
    if ((mm = line.match(/^([\w.-]+)\s*=\s*(.*)$/))) {                               // node def
      const n = node(mm[1], ln); let body = mm[2];
      const attr = body.match(/\[([^\]]*)\]\s*$/); if (attr) { body = body.slice(0, attr.index).trim();
        attr[1].split(/[\s,]+/).filter(Boolean).forEach((t) => { if (SHAPES.has(t)) n.shape = t; else if (TONES.has(t)) n.tone = t; else if (t.startsWith('#')) n.href = t; else if (/^tag:[\w.-]{1,12}$/.test(t)) n.tag = t.slice(4).toUpperCase(); else m.errors.push(`line ${ln}: unknown node attribute "${t}" (shapes: ${[...SHAPES].join(' ')}; tones: ${[...TONES].join(' ')}; tag:name, 12 characters at most)`); }); }
      const parts = body.split(/\s+\/\s+/); n.label = parts[0].replace(/\\n/g, '\n') || n.id; n.sub = parts.slice(1).join(' / ');
      if (mark) n.mark = mark; last = n; return;
    }
    if (/^[\w.-]+$/.test(line)) { const n = node(line, ln); if (mark) n.mark = mark; last = n; return; }
    m.errors.push(`line ${ln}: couldn't parse "${line}" — expected  id = Label [attrs]  |  a -> b : label  |  | a | b |  |  group Name: a b  |  zone Name: a b  |  legend`);
  });
  // grid sanity
  const seen = {}; m.grid.forEach((row, r) => row.forEach((id, c) => { if (!id) return; if (seen[id]) m.errors.push(`grid: "${id}" appears twice (${seen[id]} and ${r},${c})`); seen[id] = `${r},${c}`; }));
  if (m.grid.length) m.order.forEach((id) => { if (!seen[id]) m.errors.push(`grid: node "${id}" is used but has no cell — add it to a | row |`); });
  return m;
};

/** Sequence DSL → { actors:[{id,label}], steps:[{kind:'msg'|'note'|'div', ...}], errors } */
const layoutFlow = function layoutFlow(m, opt = {}) {
  const ids = m.order; if (!ids.length) return { W: 0, H: 0, boxes: {}, routes: [], groups: [] };
  const wrapAt = 18;
  // wrap labels at ~18 chars; long identifiers soft-break at camelCase / punctuation without inserting spaces
  const soft = (w) => w.length > wrapAt ? w.replace(/([a-z0-9])([A-Z])/g, '$1\u200b$2').replace(/([._/:-])(?=\w)/g, '$1\u200b').split('\u200b').map((t, i) => ({ t, sp: i === 0 })) : [{ t: w, sp: true }];
  const wrap = (s) => { const out = []; String(s).split('\n').forEach((para) => { let cur = ''; para.split(/\s+/).filter(Boolean).flatMap(soft).forEach(({ t, sp }) => { const join = cur ? cur + (sp ? ' ' : '') + t : t; if (join.length > wrapAt && cur) { out.push(cur); cur = t; } else cur = join; }); if (cur) out.push(cur); }); return out.length ? out : ['']; };
  const wrapSub = (t) => { t = String(t || ''); if (t.length <= 24) return t ? [t] : []; const mid = Math.round(t.length / 2); let at = -1; for (let d = 0; d < mid; d++) { if (/[\s/·,]/.test(t[mid - d])) { at = mid - d; break; } if (/[\s/·,]/.test(t[mid + d])) { at = mid + d; break; } } return at > 0 ? [t.slice(0, at + (t[at] === ' ' ? 0 : 1)).trim(), t.slice(at + 1).trim()] : [t]; };
  Object.values(m.nodes).forEach((n) => { n.lines = wrap(n.label); n.subLines = wrapSub(n.sub); });
  const maxLines = Math.max(...Object.values(m.nodes).map((n) => n.lines.length + n.subLines.length * 0.85 + (n.tag ? 1 : 0)));
  const longest = Math.max(...Object.values(m.nodes).flatMap((n) => { const pad = n.shape === 'actor' ? 22 : 0; return [...n.lines.map((l) => l.length * 7.3 + pad), ...n.subLines.map((l) => l.length * 6.5 + pad)]; }));
  const splitLbl = (t) => { t = String(t || ''); if (t.length <= 22) return t ? [t] : []; const mid = Math.round(t.length / 2); let at = -1; for (let d = 0; d < mid; d++) { if (t[mid - d] === ' ') { at = mid - d; break; } if (t[mid + d] === ' ') { at = mid + d; break; } } return at > 0 ? [t.slice(0, at), t.slice(at + 1)] : [t]; };
  m.edges.forEach((e) => { e.lines = splitLbl(e.label); e.tw = e.lines.length ? Math.max(24, Math.max(...e.lines.map((l) => l.length)) * 6.4 + 12) : 0; e.th = e.lines.length > 1 ? 30 : 18; });
  const maxLbl = Math.max(0, ...m.edges.map((e) => e.tw ? e.tw + 4 : 0));
  const NWID = opt.nodeW || clamp(Math.ceil(longest + 30), 120, 240), NH = Math.max(50, Math.ceil(20 + maxLines * 16)), GX = clamp(Math.ceil(maxLbl + 22), 56, 92), GY = m.edges.some((e) => e.th > 18) ? 62 : maxLbl > 0 ? 54 : 44, PAD = 28;
  let cells = {}; // id -> {c, r} possibly fractional c for auto layout
  if (m.grid.length) { m.grid.forEach((row, r) => row.forEach((id, c) => { if (id) cells[id] = { c, r }; })); }
  else {
    // longest-path layering over a DAG (back edges ignored via DFS)
    const out = {}, inn = {}; ids.forEach((id) => { out[id] = []; inn[id] = []; });
    const state = {}; const back = new Set();
    m.edges.forEach((e, i) => { if (e.from !== e.to) { out[e.from].push([e.to, i]); inn[e.to].push([e.from, i]); } });
    const dfs = (u) => { state[u] = 1; out[u].forEach(([v, i]) => { if (state[v] === 1) back.add(i); else if (!state[v]) dfs(v); }); state[u] = 2; };
    ids.forEach((id) => { if (!state[id]) dfs(id); });
    const layer = {}; const L = (u) => { if (layer[u] != null) return layer[u]; layer[u] = -1; let best = 0; inn[u].forEach(([p, i]) => { if (!back.has(i)) best = Math.max(best, L(p) + 1); }); return (layer[u] = best); };
    ids.forEach((id) => L(id));
    const layers = []; ids.forEach((id) => { (layers[layer[id]] ||= []).push(id); });
    // barycenter ordering, two down-sweeps
    for (let pass = 0; pass < 2; pass++) for (let i = 1; i < layers.length; i++) { const pos = {}; layers[i - 1].forEach((id, k) => { pos[id] = k; }); layers[i].sort((a, b) => { const pa = inn[a].map(([p]) => pos[p]).filter((x) => x != null), pb = inn[b].map(([p]) => pos[p]).filter((x) => x != null); const ba = pa.length ? pa.reduce((s, x) => s + x, 0) / pa.length : 1e9, bb = pb.length ? pb.reduce((s, x) => s + x, 0) / pb.length : 1e9; return ba - bb; }); }
    const maxN = Math.max(...layers.map((l) => l.length));
    layers.forEach((l, li) => l.forEach((id, k) => { const off = (maxN - l.length) / 2; cells[id] = m.dir === 'LR' ? { c: li, r: k + off } : { c: k + off, r: li }; }));
  }
  const boxes = {}; let W = 0, H = 0;
  ids.forEach((id) => { const cell = cells[id]; if (!cell) return; const n = m.nodes[id]; const x = PAD + cell.c * (NWID + GX), y = PAD + cell.r * (NH + GY); boxes[id] = { id, x, y, w: NWID, h: NH, cx: x + NWID / 2, cy: y + NH / 2, c: cell.c, r: cell.r, n }; W = Math.max(W, x + NWID + PAD); H = Math.max(H, y + NH + PAD); });
  // groups
  const groups = m.groups.map((g) => { const bs = g.ids.map((id) => boxes[id]).filter(Boolean); if (!bs.length) return null; const x0 = Math.min(...bs.map((b) => b.x)) - 14, y0 = Math.min(...bs.map((b) => b.y)) - 22, x1 = Math.max(...bs.map((b) => b.x + b.w)) + 14, y1 = Math.max(...bs.map((b) => b.y + b.h)) + 22; W = Math.max(W, x1 + 8); H = Math.max(H, y1 + 8); return { label: g.label, zone: !!g.zone, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }).filter(Boolean);
  if (groups.length) { const miny = Math.min(0, ...groups.map((g) => g.y - 6)); if (miny < 0) { Object.values(boxes).forEach((b) => { b.y -= miny; b.cy -= miny; }); groups.forEach((g) => { g.y -= miny; }); H -= miny; } }
  // routing
  const occupied = (x, y, skip) => Object.values(boxes).some((b) => !skip.includes(b.id) && x > b.x - 4 && x < b.x + b.w + 4 && y > b.y - 4 && y < b.y + b.h + 4);
  const segClear = (x1, y1, x2, y2, skip) => { const steps = 24; for (let i = 1; i < steps; i++) { const t = i / steps; if (occupied(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, skip)) return false; } return true; };
  const lane = {}; const laneOff = (key) => { lane[key] = (lane[key] || 0) + 1; const k = lane[key] - 1; return k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 8; };
  // 1) decide each edge's exit/entry sides
  const plans = m.edges.map((e) => {
    const a = boxes[e.from], b = boxes[e.to]; if (!a || !b || a === b) return null;
    const skip = [a.id, b.id]; const dx = b.cx - a.cx, dy = b.cy - a.cy;
    const sameRow = Math.abs(dy) < 2, sameCol = Math.abs(dx) < 2;
    let orient; // 'h' = leave from left/right, 'v' = leave from top/bottom
    if (sameRow) orient = 'h'; else if (sameCol) orient = 'v';
    else {
      const hFirstClear = segClear(dx > 0 ? a.x + a.w : a.x, a.cy, dx > 0 ? b.x - GX / 2 : b.x + b.w + GX / 2, a.cy, skip) && segClear(dx > 0 ? b.x - GX / 2 : b.x + b.w + GX / 2, b.cy, dx > 0 ? b.x : b.x + b.w, b.cy, skip);
      const vFirstClear = segClear(a.cx, dy > 0 ? a.y + a.h : a.y, a.cx, dy > 0 ? b.y - GY / 2 : b.y + b.h + GY / 2, skip) && segClear(b.cx, dy > 0 ? b.y - GY / 2 : b.y + b.h + GY / 2, b.cx, dy > 0 ? b.y : b.y + b.h, skip);
      const cols = Math.abs(dx) / (NWID + GX), rws = Math.abs(dy) / (NH + GY);
      const preferH = Math.abs(cols - rws) < 0.2 ? m.dir === 'LR' : cols > rws;
      orient = preferH ? (hFirstClear ? 'h' : vFirstClear ? 'v' : 'h') : (vFirstClear ? 'v' : hFirstClear ? 'h' : 'v');
    }
    const sideA = orient === 'h' ? (dx >= 0 ? 'r' : 'l') : (dy >= 0 ? 'b' : 't');
    const sideB = orient === 'h' ? (sameRow ? (dx >= 0 ? 'l' : 'r') : (dx >= 0 ? 'l' : 'r')) : (sameCol ? (dy >= 0 ? 't' : 'b') : (dy >= 0 ? 't' : 'b'));
    return { e, a, b, skip, dx, dy, sameRow, sameCol, orient, sideA, sideB };
  }).filter(Boolean);
  // 2) spread ports: several edges on one side of a node get distinct attachment points
  const portList = {}; plans.forEach((p) => { (portList[p.a.id + p.sideA] ||= []).push([p, 'A']); (portList[p.b.id + p.sideB] ||= []).push([p, 'B']); });
  Object.values(portList).forEach((list) => {
    const side = list[0][1] === 'A' ? list[0][0].sideA : list[0][0].sideB; const horizSide = side === 't' || side === 'b';
    list.sort((u, v) => { const ou = u[1] === 'A' ? u[0].b : u[0].a, ov = v[1] === 'A' ? v[0].b : v[0].a; return horizSide ? ou.cx - ov.cx : ou.cy - ov.cy; });
    const n = list.length; list.forEach(([p, end], i) => { const off = (i - (n - 1) / 2) * (horizSide ? Math.min(22, (NWID - 30) / Math.max(1, n - 1)) : Math.min(14, (NH - 16) / Math.max(1, n - 1))); p['off' + end] = n > 1 ? off : 0; });
  });
  const port = (bx, side, off) => side === 'r' ? [bx.x + bx.w, bx.cy + off] : side === 'l' ? [bx.x, bx.cy + off] : side === 'b' ? [bx.cx + off, bx.y + bx.h] : [bx.cx + off, bx.y];
  const placed = []; // label rects for collision avoidance
  const routes = plans.map((p) => {
    const { e, a, b, skip, dx, dy, sameRow, sameCol, orient } = p;
    if (sameRow || sameCol) { const o = ((p.offA || 0) + (p.offB || 0)) / 2; p.offA = p.offB = o; }  // straight edges stay straight
    const [sx, sy] = port(a, p.sideA, p.offA), [tx, ty] = port(b, p.sideB, p.offB); let pts;
    if (orient === 'h') {
      if (sameRow && segClear(sx, sy, tx, ty, skip)) pts = [[sx, sy], [tx, ty]];
      else if (sameRow) { const gy = a.y - GY / 2 + laneOff('h' + a.r + ':' + Math.min(a.c, b.c)); pts = [[a.cx + p.offA, a.y], [a.cx + p.offA, gy], [b.cx + p.offB, gy], [b.cx + p.offB, b.y]]; }
      else { let mx = dx >= 0 ? b.x - GX / 2 : b.x + b.w + GX / 2; mx += laneOff('vx' + Math.round(mx / 10)); pts = [[sx, sy], [mx, sy], [mx, ty], [tx, ty]];
        if (!segClear(sx, sy, mx, sy, skip)) { const gy = (dy > 0 ? a.y + a.h + GY / 2 : a.y - GY / 2) + laneOff('hy' + Math.round((dy > 0 ? a.y + a.h : a.y) / 10)); pts = [[a.cx, dy > 0 ? a.y + a.h : a.y], [a.cx, gy], [mx, gy], [mx, ty], [tx, ty]]; } }
    } else {
      if (sameCol && segClear(sx, sy, tx, ty, skip)) pts = [[sx, sy], [tx, ty]];
      else if (sameCol) { const gx = a.x + a.w + GX / 2 + laneOff('v' + a.c + ':' + Math.min(a.r, b.r)); pts = [[a.x + a.w, a.cy + p.offA], [gx, a.cy + p.offA], [gx, b.cy + p.offB], [b.x + b.w, b.cy + p.offB]]; }
      else { let my = dy >= 0 ? b.y - GY / 2 : b.y + b.h + GY / 2; my += laneOff('hy' + Math.round(my / 10)); pts = [[sx, sy], [sx, my], [tx, my], [tx, ty]];
        if (!segClear(sx, sy, sx, my, skip)) { const gx = (dx > 0 ? a.x + a.w + GX / 2 : a.x - GX / 2) + laneOff('vx' + Math.round((dx > 0 ? a.x + a.w : a.x) / 10)); pts = [[dx > 0 ? a.x + a.w : a.x, a.cy], [gx, a.cy], [gx, my], [tx, my], [tx, ty]]; } }
    }
    // simplify collinear points
    pts = pts.filter((pt, i) => i === 0 || i === pts.length - 1 || !((pts[i - 1][0] === pt[0] && pt[0] === pts[i + 1][0]) || (pts[i - 1][1] === pt[1] && pt[1] === pts[i + 1][1])));
    const segsOut = pts.slice(0, -1).map((pt, i) => [pt[0], pt[1], pts[i + 1][0], pts[i + 1][1]]);
    return { e, pts, lx: 0, ly: 0, segs: segsOut };
  });
  // 3) labels — placed once every route is known: try along own segments (longest first), then just off the line,
  //    avoiding nodes, other labels, and other edges' lines
  routes.forEach((r) => {
    const { e, pts } = r; if (!e.label) return;
    const tw = e.tw, th = e.th; const others = routes.filter((o) => o !== r).flatMap((o) => o.segs);
    const segs = pts.slice(0, -1).map((pt, i) => ({ i, l: Math.hypot(pts[i + 1][0] - pt[0], pts[i + 1][1] - pt[1]) })).sort((u, v) => v.l - u.l);
    const at = (i, t) => [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    const cands = []; segs.forEach(({ i }) => [0.5, 0.33, 0.67, 0.2, 0.8].forEach((t) => cands.push(at(i, t))));
    segs.slice(0, 2).forEach(({ i }) => { const horiz = Math.abs(pts[i + 1][1] - pts[i][1]) < 1; [0.5, 0.35, 0.65].forEach((t) => { const [cx, cy] = at(i, t); if (horiz) { cands.push([cx, cy - th / 2 - 5], [cx, cy + th / 2 + 5]); } else { cands.push([cx - tw / 2 - 6, cy], [cx + tw / 2 + 6, cy]); } }); });
    segs.slice(0, 2).forEach(({ i }) => { const horiz = Math.abs(pts[i + 1][1] - pts[i][1]) < 1; const [cx, cy] = at(i, 0.5); if (horiz) cands.push([cx, cy - NH / 2 - th / 2 - 4], [cx, cy + NH / 2 + th / 2 + 4]); else cands.push([cx - NWID / 2 - tw / 2 - 4, cy], [cx + NWID / 2 + tw / 2 + 4, cy]); });  // last resort: clear of the whole node row/column
    const bad = (x, y) => x - tw / 2 < 2 || y - th / 2 < 2 || placed.some((q) => Math.abs(q.x - x) < (q.w + tw) / 2 + 4 && Math.abs(q.y - y) < (q.h + th) / 2 + 2) || Object.values(boxes).some((bx) => x + tw / 2 > bx.x - 2 && x - tw / 2 < bx.x + bx.w + 2 && y + th / 2 > bx.y - 2 && y - th / 2 < bx.y + bx.h + 2);
    const onOther = (x, y) => others.some(([x1, y1, x2, y2]) => (Math.abs(y1 - y2) < 1 && Math.abs(y - y1) < th / 2 + 1 && x + tw / 2 > Math.min(x1, x2) && x - tw / 2 < Math.max(x1, x2)) || (Math.abs(x1 - x2) < 1 && Math.abs(x - x1) < tw / 2 + 1 && y + th / 2 > Math.min(y1, y2) && y - th / 2 < Math.max(y1, y2)));
    const ok = cands.find(([x, y]) => !bad(x, y) && !onOther(x, y)) || cands.find(([x, y]) => !bad(x, y)) || cands[0];
    [r.lx, r.ly] = ok; placed.push({ x: ok[0], y: ok[1], w: tw, h: th }); W = Math.max(W, ok[0] + tw / 2 + 6); H = Math.max(H, ok[1] + th / 2 + 6);
  });
  // 4) group labels: try the four inside corners of the group padding, top-left first. Keep the first corner
  //    that no arrow and no arrow label crosses. If every corner is blocked, keep top-left and set clash,
  //    so the drawing puts a mask behind the label.
  const allSegs = routes.flatMap((r) => r.segs);
  const hitSeg = (x0, y0, x1, y1) => allSegs.some(([ax, ay, bx, by]) => Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1 && Math.max(ay, by) >= y0 && Math.min(ay, by) <= y1);
  const hitLbl = (x0, y0, x1, y1) => placed.some((q) => q.x + q.w / 2 > x0 && q.x - q.w / 2 < x1 && q.y + q.h / 2 > y0 && q.y - q.h / 2 < y1);
  const charW = opt.groupCharW || 7.1;
  groups.forEach((g) => {
    const lw = g.label.length * charW + 6, lh = 13;
    const cands = [[g.x + 10, g.y + 4, 'start'], [g.x + g.w - 10, g.y + 4, 'end'], [g.x + 10, g.y + g.h - 4 - lh, 'start'], [g.x + g.w - 10, g.y + g.h - 4 - lh, 'end']];
    const rect = ([x, y, a]) => a === 'start' ? [x - 3, y, x + lw, y + lh] : [x - lw, y, x + 3, y + lh];
    const ok = cands.find((c) => { const r = rect(c); return !hitSeg(...r) && !hitLbl(...r); });
    const [lx, ly, anchor] = ok || cands[0];
    Object.assign(g, { lx, ly, anchor, lw, lh, clash: !ok });
  });
  return { W, H, boxes, routes, groups, NH, NWID };
};
/* ─── End of html-plan code. ─── */

const TONE_CLASS = { accent: 'purple', muted: 'gray', ink: 'gray' };

/* ─── Expressions for .k-model: numbers, names, + - * / ^, ( ), and a few functions. No eval. ─── */
const FN = { min: Math.min, max: Math.max, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, pow: Math.pow, log: Math.log, exp: Math.exp };
function evalExpr(src, vars) {
  const toks = String(src).match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|[-+*/^(),]/g) || [];
  if (toks.join('') !== String(src).replace(/\s+/g, '')) throw new Error(`cannot read "${src}"`);
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') { const op = next(); const r = term(); v = op === '+' ? v + r : v - r; } return v; };
  const term = () => { let v = power(); while (peek() === '*' || peek() === '/') { const op = next(); const r = power(); v = op === '*' ? v * r : v / r; } return v; };
  const power = () => { const v = unary(); if (peek() === '^') { next(); return Math.pow(v, power()); } return v; };
  const unary = () => (peek() === '-' ? (next(), -unary()) : peek() === '+' ? (next(), unary()) : atom());
  const atom = () => {
    const t = next();
    if (t === undefined) throw new Error(`"${src}" ends too early`);
    if (t === '(') { const v = expr(); if (next() !== ')') throw new Error(`missing ")" in "${src}"`); return v; }
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        if (!FN[t]) throw new Error(`unknown function "${t}"`);
        next(); const args = []; if (peek() !== ')') { args.push(expr()); while (peek() === ',') { next(); args.push(expr()); } }
        if (next() !== ')') throw new Error(`missing ")" after ${t}(`); return FN[t](...args);
      }
      if (!(t in vars)) throw new Error(`unknown name "${t}"`);
      return vars[t];
    }
    throw new Error(`unexpected "${t}" in "${src}"`);
  };
  const v = expr(); if (i < toks.length) throw new Error(`unexpected "${toks[i]}" in "${src}"`); return v;
}
/** "name = expr" lines, in order. Returns the new vars. */
function evalDefs(text, vars) {
  const out = { ...vars };
  dedent(text).split(/\n|;/).map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).forEach((l) => {
    const m = l.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/); if (!m) throw new Error(`expected "name = expression", got "${l}"`);
    out[m[1]] = evalExpr(m[2], out);
  });
  return out;
}
/** Formats: x2 → 2.35×   %1 → 0.123 as 12.3%   $0 → $1,234   n1 → 1,234.5   An optional data-unit adds a suffix. */
function fmt(v, f = 'n1', unit = '') {
  if (!Number.isFinite(v)) return '—';
  const kind = f[0], d = +(f.slice(1) || 0);
  const num = (x) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const s = kind === 'x' ? num(v) + '×' : kind === '%' ? num(v * 100) + '%' : kind === '$' ? (v < 0 ? '−$' : '$') + num(Math.abs(v)) : num(v);
  return s.replace(/^-/, '−') + (unit ? ' ' + unit : '');
}

/* The diagram-design palette, for .k-diagram templates. Each color maps to a kit token in explain.css. */
const DIAGRAM_PALETTE = { '45,49,66': 'ink', '79,93,117': 'muted', '90,101,128': 'soft', '191,69,32': 'accent', '46,90,168': 'link', '245,245,245': 'paper', '236,236,236': 'paper-2', '255,255,255': 'node', '61,68,96': 'ink-2', '191,192,192': 'muted-2' };
/** A diagram-design color → a kit CSS value, or null for a color outside the palette. */
function diagramColor(v) {
  v = String(v || '').trim().toLowerCase();
  let rgb, a = 1, mm;
  if (v === 'white' || v === '#fff') rgb = '255,255,255';
  else if ((mm = v.match(/^#([0-9a-f]{6})$/))) rgb = [0, 2, 4].map((i) => parseInt(mm[1].slice(i, i + 2), 16)).join(',');
  else if ((mm = v.match(/^#([0-9a-f]{3})$/))) rgb = [...mm[1]].map((c) => parseInt(c + c, 16)).join(',');
  else if ((mm = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/))) { rgb = [mm[1], mm[2], mm[3]].join(','); if (mm[4] != null) a = mm[4].endsWith('%') ? parseFloat(mm[4]) / 100 : parseFloat(mm[4]); }
  const role = rgb && DIAGRAM_PALETTE[rgb];
  if (!role) return null;
  return a >= 1 ? `var(--d-${role})` : `color-mix(in srgb, var(--d-${role}) ${+(a * 100).toFixed(1)}%, transparent)`;
}
/** The slide layouts the kit draws. A slide names one in data-layout. */
const DECK_LAYOUTS = ['title', 'section', 'statement', 'bullets', 'split', 'figure', 'table', 'stat', 'quote', 'code'];

/* ─── Presence, the pure part: find a quote in the text of a page ───
   texts is the text of each text node, in document order. White space does not count, so a quote matches
   when the page splits it across inline elements, lines or blocks. When the whole quote is not in the page,
   the longest start of the quote counts, if it is at least 16 characters and half of the quote.
   A quote that occurs two times needs a place to start from: the text `hint` (the first match at or after
   it wins), or the text node `fromNode`. With neither one the answer is null, so no wrong text gets a highlight.
   Returns { a: [node, offset], b: [node, offset], exact } or null. b is the position after the last character. */
function findQuote(texts, quote, hint, fromNode) {
  const squash = (t) => String(t ?? '').replace(/\s+/g, '');
  const need = squash(quote);
  if (need.length < 4) return null;
  const chars = [], node = [], off = [];
  let base = 0;
  texts.forEach((t, n) => {
    if (n === fromNode) base = chars.length;
    for (let i = 0; i < t.length; i++) if (!/\s/.test(t[i])) { chars.push(t[i]); node.push(n); off.push(i); }
  });
  const flat = chars.join('');
  let n = need.length;
  if (flat.indexOf(need) < 0) {
    // The start of length lo is in the page, and the start of length hi is not.
    let lo = 0, hi = need.length;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (flat.indexOf(need.slice(0, mid)) >= 0) lo = mid; else hi = mid; }
    if (lo < 16 || lo < need.length / 2) return null;
    n = lo;
  }
  const part = need.slice(0, n);
  let at = flat.indexOf(part);
  if (flat.indexOf(part, at + 1) >= 0) {
    const h = squash(hint);
    let from = h.length >= 4 ? flat.indexOf(h, base) : -1;
    if (from < 0 && fromNode != null && fromNode >= 0) from = base;
    at = from < 0 ? -1 : flat.indexOf(part, from);
    if (at < 0) return null;
  }
  const z = at + n - 1;
  return { a: [node[at], off[at]], b: [node[z], off[z] + 1], exact: n === need.length };
}

globalThis.Explain = { parseFlow, layoutFlow, evalExpr, evalDefs, fmt, dedent, diagramColor, DECK_LAYOUTS, findQuote };
if (!HAS_DOM) return;

/* ─── Flow → SVG ───
   The look comes from diagram-design (MIT, Cathryn Lavery): type tags, mono sublabels, mono caps arrow labels,
   filled zones, the accent on the main path and the focal node, and a legend. See ../NOTICE.md. */
let flowN = 0;
function shape(b) {
  const { x, y, w, h, n } = b;
  switch (n.shape) {
    case 'pill': case 'actor': return `<rect class="box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
    case 'circle': return `<ellipse class="box" cx="${b.cx}" cy="${b.cy}" rx="${w / 2}" ry="${h / 2}"/>`;
    case 'diamond': return `<polygon class="box" points="${b.cx},${y} ${x + w},${b.cy} ${b.cx},${y + h} ${x},${b.cy}"/>`;
    case 'hex': return `<polygon class="box" points="${x + 14},${y} ${x + w - 14},${y} ${x + w},${b.cy} ${x + w - 14},${y + h} ${x + 14},${y + h} ${x},${b.cy}"/>`;
    case 'note': return `<rect class="box" x="${x}" y="${y}" width="${w}" height="${h}" rx="2" stroke-dasharray="4 3"/>`;
    case 'db': { const e = 7; return `<path class="box" d="M${x},${y + e} a${w / 2},${e} 0 0 1 ${w},0 v${h - 2 * e} a${w / 2},${e} 0 0 1 ${-w},0 z"/><path class="box" style="fill:none" d="M${x},${y + e} a${w / 2},${e} 0 0 0 ${w},0"/>`; }
    default: return `<rect class="box" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`;
  }
}
/** A right-angle route with rounded elbows of radius 8. */
function elbow(pts, r = 8) {
  const f = (v) => +v.toFixed(1);
  let d = 'M' + f(pts[0][0]) + ',' + f(pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y), rr = Math.min(r, l1 / 2, l2 / 2);
    if (!l1 || !l2) continue;
    d += ' L' + f(x - ((x - px) / l1) * rr) + ',' + f(y - ((y - py) / l1) * rr) + ' Q' + f(x) + ',' + f(y) + ' ' + f(x + ((nx - x) / l2) * rr) + ',' + f(y + ((ny - y) / l2) * rr);
  }
  const z = pts[pts.length - 1];
  return d + ' L' + f(z[0]) + ',' + f(z[1]);
}
function drawFlow(el) {
  const m = parseFlow(srcOf(el));
  const L = layoutFlow(m);
  const id = 'kf' + (++flowN);
  const out = [], labels = [];
  const mk = (sfx, cls) => `<marker id="${id}${sfx}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="${cls}" d="M1,1 L9,5 L1,9 z"/></marker>`;
  const dots = el.dataset.paper === 'dots' ? `<pattern id="${id}d" width="22" height="22" patternUnits="userSpaceOnUse"><circle class="fdot" cx="1" cy="1" r="0.9"/></pattern>` : '';
  out.push(`<defs>${mk('a', 'fm')}${mk('m', 'fm main')}${dots}</defs>`);
  if (dots) out.push(`<rect x="0" y="0" width="100%" height="100%" fill="url(#${id}d)"/>`);
  // Zones and groups sit behind the arrows. Their labels draw after the arrows, so no arrow covers a label.
  L.groups.forEach((g) => {
    out.push(g.zone ? `<rect class="zone" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="4"/>` : `<rect class="grp" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="6"/>`);
    const x0 = g.anchor === 'start' ? g.lx - 3 : g.lx - g.lw;
    labels.push((g.clash ? `<rect class="${g.zone ? 'zone-bg' : 'lbl-bg'}" x="${x0}" y="${g.ly}" width="${g.lw + 3}" height="${g.lh}"/>` : '') +
      `<text class="fe" x="${g.lx}" y="${g.ly + 9.5}" text-anchor="${g.anchor}">${esc(g.label.toUpperCase())}</text>`);
  });
  L.routes.forEach((r) => {
    const cls = ['arr', r.e.dash ? 'dash' : '', r.e.bold ? 'main' : ''].join(' ').trim(), mid = r.e.bold ? 'm' : 'a';
    out.push(`<path class="${cls}" d="${elbow(r.pts)}" marker-end="url(#${id}${mid})"${r.e.both ? ` marker-start="url(#${id}${mid})"` : ''}/>`);
  });
  L.routes.forEach((r) => {
    if (!r.e.label) return;
    const lines = r.e.lines, tw = r.e.tw, th = r.e.th;
    out.push(`<rect class="lbl-bg" x="${r.lx - tw / 2}" y="${r.ly - th / 2}" width="${tw}" height="${th}" rx="2"/>`);
    lines.forEach((t, i) => out.push(`<text class="fl${r.e.bold ? ' main' : ''}" x="${r.lx}" y="${r.ly + (i - (lines.length - 1) / 2) * 13}" text-anchor="middle" dominant-baseline="central">${esc(t.toUpperCase())}</text>`));
  });
  out.push(...labels);
  Object.values(L.boxes).forEach((b) => {
    const n = b.n, tone = TONE_CLASS[n.tone] || n.tone, round = n.shape === 'pill' || n.shape === 'actor' || n.shape === 'circle';
    const rows = [...n.lines.map((t) => ['fn', t, 16]), ...n.subLines.map((t) => ['fs', t, 14])];
    const tagH = n.tag ? 16 : 0, total = rows.reduce((s, r) => s + r[2], 0) + tagH;
    let y = b.cy - total / 2 + (n.shape === 'db' ? 4 : 0);   // a cylinder's top curve takes space
    let txt = '';
    if (n.tag) {
      // A box keeps its tag in the top-left corner. A round or tilted shape centers it above the name.
      const tw = n.tag.length * 5.6 + 10, corner = !round && n.shape !== 'db' && n.shape !== 'diamond' && n.shape !== 'hex';
      const tx = corner ? b.x + 8 : b.cx - tw / 2, ty = corner ? b.y + 7 : y + 1;
      txt += `<rect class="ftag" x="${tx}" y="${ty}" width="${tw}" height="12" rx="2"/><text class="ftt" x="${tx + tw / 2}" y="${ty + 6.5}" text-anchor="middle" dominant-baseline="central">${esc(n.tag)}</text>`;
      y += tagH;
    }
    txt += rows.map(([c, t, lh]) => { const s = `<text class="${c}" x="${b.cx}" y="${y + lh / 2}" text-anchor="middle" dominant-baseline="central">${esc(t)}</text>`; y += lh; return s; }).join('');
    const tip = n.detail.length ? `<title>${esc(n.detail.join('\n'))}</title>` : '';
    out.push(`<g class="${['node', tone ? 'c-' + tone : '', n.mark ? 'mark-' + n.mark : ''].join(' ').trim()}">${tip}${shape(b)}${txt}</g>`);
  });
  let W = Math.ceil(L.W), H = Math.ceil(L.H);
  if (m.legend) {
    // The legend lists only the parts that this flow uses.
    const items = [];
    if (Object.values(m.nodes).some((n) => n.mark === 'hl')) items.push(['focal', 'Focal']);
    if (m.edges.some((e) => !e.dash && !e.bold)) items.push(['arr', 'Every time']);
    if (m.edges.some((e) => e.bold)) items.push(['arr main', 'Main path']);
    if (m.edges.some((e) => e.dash)) items.push(['arr dash', 'Sometimes']);
    const y0 = H + 4, cy = y0 + 22; let x = 100;
    out.push(`<line class="rule" x1="28" y1="${y0}" x2="${Math.max(W - 28, 240)}" y2="${y0}"/><text class="fe" x="28" y="${cy + 3.5}">LEGEND</text>`);
    items.forEach(([k, label]) => {
      if (k === 'focal') out.push(`<g class="node mark-hl"><rect class="box" x="${x}" y="${cy - 6}" width="18" height="12" rx="3"/></g>`);
      else out.push(`<path class="${k}" d="M${x},${cy} L${x + 22},${cy}" marker-end="url(#${id}${k.includes('main') ? 'm' : 'a'})"/>`);
      out.push(`<text class="flg" x="${x + 30}" y="${cy}" dominant-baseline="central">${esc(label)}</text>`);
      x += 30 + label.length * 6.6 + 26;
    });
    W = Math.max(W, x); H = cy + 14;
  }
  const label = el.getAttribute('aria-label') || el.closest('figure')?.querySelector('figcaption')?.textContent || 'Flow diagram';
  el.style.setProperty('--w', W + 'px');
  el.innerHTML = (m.errors.length ? `<div class="k-err">${esc('Flow spec errors:\n' + m.errors.join('\n'))}</div>` : '') +
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label.trim())}" xmlns="http://www.w3.org/2000/svg">${out.join('')}</svg>`;
}

/* ─── Diagram templates: <figure class="k-diagram"> with an SVG from skills/explain/diagrams ───
   The templates use the diagram-design palette. drawDiagram maps each palette color, at any alpha,
   to a kit token, so a template follows the light and dark themes. Other colors stay as they are.
   It also makes the ids unique, so two templates on one page do not share a marker or a pattern. */
let diagramN = 0;
const COLOR_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color', 'color'];
function drawDiagram(fig) {
  const pre = 'kd' + (++diagramN) + '-';
  const els = [...fig.querySelectorAll('svg, svg *')];
  const ids = new Set(els.map((e) => e.id).filter(Boolean));
  const ref = (v) => v.replace(/url\(#([^)]+)\)/g, (x, i) => ids.has(i) ? `url(#${pre}${i})` : x);
  els.forEach((e) => {
    if (e.id) e.id = pre + e.id;
    for (const at of [...e.attributes]) {
      if (/url\(#/.test(at.value)) e.setAttribute(at.name, ref(at.value));
      else if ((at.name === 'href' || at.name === 'xlink:href') && at.value.startsWith('#') && ids.has(at.value.slice(1))) e.setAttribute(at.name, '#' + pre + at.value.slice(1));
      else if ((at.name === 'aria-labelledby' || at.name === 'aria-describedby')) e.setAttribute(at.name, at.value.split(/\s+/).map((i) => ids.has(i) ? pre + i : i).join(' '));
    }
    COLOR_ATTRS.forEach((p) => { const c = diagramColor(e.getAttribute(p)); if (c) e.style.setProperty(p, c); });
  });
  // The figure scrolls sideways before its text draws much smaller than the size the template sets.
  const svg = fig.querySelector('svg'), vb = svg?.viewBox?.baseVal;
  if (vb && vb.width) fig.style.setProperty('--d-min', Math.round(vb.width * 0.85) + 'px');
  fig.dataset.kReady = '';
}

/* ─── Score dots: <span class="k-dots" data-score="3/5"> ─── */
function drawDots(el) {
  const [v, max] = el.dataset.score.split('/').map(Number);
  el.setAttribute('role', 'img'); el.setAttribute('aria-label', `${v} of ${max}`);
  el.innerHTML = Array.from({ length: max }, (_, i) => `<i class="${i < v ? 'on' : ''}"></i>`).join('') + `<span>${v}/${max}</span>`;
}

/* ─── Model: inputs [data-var], defs script, outputs [data-out], bars [data-bar] ─── */
function runModel(el) {
  const defs = el.querySelector(':scope > script[data-defs]')?.textContent || '';
  const inputs = [...el.querySelectorAll('input[data-var]')];
  const update = () => {
    let vars = {};
    inputs.forEach((i) => { vars[i.dataset.var] = i.valueAsNumber; });
    try { vars = evalDefs(defs, vars); } catch (e) { el.querySelector('.k-err')?.remove(); el.insertAdjacentHTML('afterbegin', `<div class="k-err">${esc(e.message)}</div>`); return; }
    el.querySelectorAll('[data-show]').forEach((o) => { o.textContent = fmt(vars[o.dataset.show], o.dataset.fmt, o.dataset.unit); });
    el.querySelectorAll('[data-out]').forEach((o) => { let v; try { v = evalExpr(o.dataset.out, vars); } catch (e) { o.textContent = '!'; o.title = e.message; return; } o.textContent = fmt(v, o.dataset.fmt, o.dataset.unit); });
    el.querySelectorAll('[data-bar]').forEach((o) => { let v = 0; try { v = evalExpr(o.dataset.bar, vars); } catch {} o.style.setProperty('--v', clamp(Number.isFinite(v) ? v : 0, 0, 100)); });
  };
  inputs.forEach((i) => i.addEventListener('input', update));
  if (!el.querySelector('[data-reset]')) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Reset'; b.dataset.reset = '';
    b.addEventListener('click', () => { inputs.forEach((i) => { i.value = i.defaultValue; }); update(); });
    (el.querySelector('.k-in') || el).append(b);
  }
  update();
}

/* ─── Steps ─── */
function runSteps(el) {
  const steps = [...el.querySelectorAll(':scope > .k-step')]; if (!steps.length) return;
  let k = 0;
  const nav = document.createElement('nav');
  nav.innerHTML = '<button type="button" data-d="-1">Back</button><button type="button" data-d="1">Next</button><span class="k-pos"></span>';
  el.append(nav);
  const show = () => { steps.forEach((s, i) => s.classList.toggle('on', i === k)); nav.querySelector('[data-d="-1"]').disabled = k === 0; nav.querySelector('[data-d="1"]').disabled = k === steps.length - 1; nav.querySelector('.k-pos').textContent = `${k + 1} / ${steps.length}`; };
  nav.addEventListener('click', (e) => { const d = +e.target.dataset?.d; if (d) { k = clamp(k + d, 0, steps.length - 1); show(); } });
  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { k = clamp(k + 1, 0, steps.length - 1); show(); } if (e.key === 'ArrowLeft') { k = clamp(k - 1, 0, steps.length - 1); show(); } });
  show();
}

/* ─── Mermaid, only when the page has a pre.mermaid block ─── */
async function runMermaid() {
  const blocks = document.querySelectorAll('pre.mermaid'); if (!blocks.length) return;
  try {
    const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    const bg2 = v('--bg2'), p = v('--p'), s = v('--s');
    mermaid.initialize({ startOnLoad: false, theme: 'base', fontFamily: v('--sans'), themeVariables: {
      background: 'transparent', primaryColor: bg2, primaryTextColor: p, primaryBorderColor: s, lineColor: s,
      secondaryColor: v('--bg3'), tertiaryColor: bg2, noteBkgColor: bg2, noteTextColor: p, actorBkg: bg2, actorBorder: s, actorTextColor: p, signalColor: s, signalTextColor: p, fontSize: '14px' } });
    await mermaid.run({ nodes: blocks });
  } catch (e) { blocks.forEach((b) => b.insertAdjacentHTML('beforebegin', `<div class="k-err">Mermaid did not load: ${esc(e.message)}</div>`)); }
}

/* ─── Deck: <main class="k-deck"> with <section class="k-claim k-slide"> slides ───────────
   The page runs in a sandboxed iframe with no origin, so the deck keeps all state in the hash,
   talks to the host only with postMessage, and never touches storage.
   Hash: #<slide id or number>[/<build>][&view=slide|scroll][&thumbs=0|1][&audit] */
const DECK_W = 1920, DECK_H = 1080, DECK_MIN_FONT = 24, RAIL_W = 216, BAR_H = 64;
const DECK_ICON = {
  rail: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 2.75v10.5"/>',
  prev: '<path d="M9.75 3.5 5.25 8l4.5 4.5"/>',
  next: '<path d="M6.25 3.5 10.75 8l-4.5 4.5"/>',
};
const deckIcon = (k) => `<svg viewBox="0 0 16 16" aria-hidden="true">${DECK_ICON[k]}</svg>`;
function runDeck(deck) {
  const root = document.documentElement;
  const slides = [...deck.querySelectorAll(':scope > .k-slide')];
  const N = slides.length; if (!N) return;
  const frames = slides.map((s, i) => {
    if (!s.id) s.id = 'slide-' + (i + 1);
    const f = document.createElement('div'); f.className = 'k-frame'; f.dataset.n = i + 1;
    s.before(f); f.append(s);
    s.querySelectorAll('.k-build').forEach((b, k) => { b.dataset.k = k + 1; });
    return f;
  });
  const builds = (i) => slides[i].querySelectorAll('.k-build').length;
  // thumbs is null until the reader chooses; then the sidebar follows the screen width.
  const S = { i: 0, b: 0, view: 'slide', thumbs: null, present: false };
  const bar = document.createElement('nav'); bar.className = 'k-deck-bar'; bar.setAttribute('aria-label', 'Deck');
  // A floating toolbar: thumbnails | previous, one tick for each slide, next, position. Each control has a tooltip.
  // The ticks show the deck's structure: section slides stand taller, and a slide with builds fills its tick in steps.
  // A long deck gets one continuous bar instead, because its ticks would not fit.
  const TICKS_MAX = 15, heading = (s) => (s.querySelector('h1, h2, blockquote')?.textContent || '').replace(/\s+/g, ' ').trim();
  const tipOf = (i) => { const t = heading(slides[i]); return `${i + 1}  ${t.length > 56 ? t.slice(0, 55) + '…' : t}`.trim(); };
  const ticks = N <= TICKS_MAX
    ? `<span class="k-ticks">${slides.map((s, i) => `<button type="button" class="k-tick${['title', 'section'].includes(s.dataset.layout) ? ' k-tall' : ''}" data-i="${i}" tabindex="-1" aria-label="Slide ${i + 1}" data-tip="${esc(tipOf(i))}"></button>`).join('')}</span>`
    : '<span class="k-ticks k-long" aria-hidden="true"><span class="k-fill"></span></span>';
  bar.innerHTML = `<span class="k-bt"><button type="button" class="k-ib" data-thumbs aria-label="Thumbnails">${deckIcon('rail')}</button><span class="k-sep"></span></span>`
    + `<button type="button" class="k-ib" data-go="-1" aria-label="Previous slide" data-tip="Previous slide  ←">${deckIcon('prev')}</button>${ticks}<button type="button" class="k-ib" data-go="1" aria-label="Next slide" data-tip="Next slide  →">${deckIcon('next')}</button>`
    + '<span class="k-pos" aria-live="polite"></span>';
  // The sidebar holds copies of the slides.
  const rail = document.createElement('nav'); rail.className = 'k-rail'; rail.setAttribute('aria-label', 'Slides');
  deck.before(rail); deck.append(bar);

  const parseHash = () => {
    let t = '', kv = [];
    try { [t, ...kv] = decodeURIComponent(location.hash.slice(1)).split('&'); } catch {}
    const p = Object.fromEntries(kv.map((x) => x.split('=')));
    const [id, b] = t.split('/');
    let i = /^\d+$/.test(id) ? +id - 1 : slides.findIndex((s) => s.id === id || (id && s.querySelector('#' + CSS.escape(id))));
    return { i: clamp(i < 0 ? 0 : i, 0, N - 1), b: +b || 0, view: ['slide', 'scroll'].includes(p.view) ? p.view : undefined, thumbs: 'thumbs' in p ? p.thumbs !== '0' : null, audit: 'audit' in p };
  };
  const hashOf = () => '#' + slides[S.i].id + (S.b ? '/' + S.b : '') + (S.view !== 'slide' ? '&view=' + S.view : '') + (S.thumbs === null ? '' : '&thumbs=' + +S.thumbs) + (root.dataset.kAudit ? '&audit' : '');
  let hashTimer;
  const writeHash = () => {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const h = hashOf(); if (h === location.hash) return;
      // replaceState, not location.hash: the host's Back button must not step through slides.
      try { history.replaceState(null, '', h); } catch {}
      if (parent !== window) parent.postMessage({ ns: 'k-deck', v: 1, type: 'location', hash: h }, '*');
    }, 300);
  };

  // Copy the slides into the sidebar each time it opens, so the copies show flows and charts drawn since.
  function fillRail() {
    rail.replaceChildren(...slides.map((s, i) => {
      const c = s.cloneNode(true);
      c.removeAttribute('id'); c.removeAttribute('hidden'); c.classList.remove('k-claim');
      // A copy keeps its SVG ids under a new name, so arrows and styles in the slide still point at the slide's own markers.
      c.querySelectorAll('[id]').forEach((e) => {
        if (!e.closest('svg')) return e.removeAttribute('id');
        const id = e.id, nid = `${id}-t${i}`, ref = new RegExp(`#${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
        e.id = nid;
        c.querySelectorAll('*').forEach((x) => [...x.attributes].forEach((a) => { if (a.value.includes('#' + id)) a.value = a.value.replace(ref, '#' + nid); }));
        c.querySelectorAll('style').forEach((st) => { if (st.textContent.includes('#' + id)) st.textContent = st.textContent.replace(ref, '#' + nid); });
      });
      c.querySelectorAll('.k-build').forEach((e) => e.classList.add('on'));
      c.inert = true; c.setAttribute('aria-hidden', 'true');
      const t = document.createElement('button'); t.type = 'button'; t.className = 'k-thumb'; t.dataset.i = i;
      t.setAttribute('aria-label', `Slide ${i + 1}`);
      t.innerHTML = `<span class="k-tnum">${i + 1}</span><span class="k-tframe"></span>`;
      t.title = (s.querySelector('h1, h2, blockquote')?.textContent || `Slide ${i + 1}`).replace(/\s+/g, ' ').trim();
      t.lastChild.append(c);
      return t;
    }));
    rail.dataset.filled = '';
  }
  // Like Google Slides, the sidebar shows on a wide screen until the reader hides it.
  const railWanted = () => S.thumbs ?? root.clientWidth >= 1000;
  const railOn = () => railWanted() && !S.present && root.clientWidth >= 700;
  // The position text and the ticks: past slides darker, the current one in the accent, filled by its builds.
  function markBar() {
    bar.querySelector('.k-pos').textContent = `${S.i + 1} / ${N}`;
    const fill = builds(S.i) && S.view === 'slide' ? ((S.b + 1) / (builds(S.i) + 1)) * 100 : 100;
    bar.querySelectorAll('.k-tick').forEach((t, i) => {
      t.classList.toggle('k-past', i < S.i); t.classList.toggle('k-cur', i === S.i);
      if (i === S.i) { t.style.setProperty('--k-f', fill + '%'); t.setAttribute('aria-current', 'true'); } else t.removeAttribute('aria-current');
    });
    const long = bar.querySelector('.k-long .k-fill'); if (long) long.style.width = ((S.i + 1) / N) * 100 + '%';
  }
  function markRail() {
    if (!railOn()) return;
    [...rail.children].forEach((t, i) => { t.classList.toggle('k-cur', i === S.i); if (i === S.i) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current'); });
    rail.children[S.i]?.scrollIntoView({ block: 'nearest' });
  }

  function layout() {
    const rl = railOn(), vw = root.clientWidth - (rl ? RAIL_W : 0), v = S.view;
    const bh = S.present ? 0 : BAR_H, vh = root.clientHeight - bh, pad = S.present ? 0 : vw < 700 ? 12 : 32;
    if (rl) root.dataset.kRail = ''; else delete root.dataset.kRail;
    if (S.present) root.dataset.kPresent = ''; else delete root.dataset.kPresent;
    root.style.setProperty('--k-bar', bh + 'px');
    root.style.setProperty('--k-rail', (rl ? RAIL_W : 0) + 'px');
    // The slide width is a multiple of 16 px, so the width and the height are whole pixels. The slide sits on whole pixels too.
    // A slide on a half pixel shifts its edges when a build fades in.
    const fit = v === 'slide' ? Math.min((vw - 2 * pad) / DECK_W, (vh - 2 * pad) / DECK_H) : Math.min(vw - 48, 1100) / DECK_W;
    const s = Math.max(16, Math.floor((fit * DECK_W) / 16) * 16) / DECK_W;
    const was = root.style.getPropertyValue('--k-s');
    root.style.setProperty('--k-s', s);
    root.style.setProperty('--k-fx', Math.floor((vw - s * DECK_W) / 2) + 'px');
    root.style.setProperty('--k-fy', Math.floor((vh - s * DECK_H) / 2) + 'px');
    // The thumbnails fill the sidebar, so their scale follows its width, with or without a scroll bar.
    const tf = rl && rail.querySelector('.k-tframe');
    if (tf && tf.clientWidth) root.style.setProperty('--k-ts', tf.clientWidth / DECK_W);
    // Chrome keeps SVG text placed for the old scale until the SVG lays out again.
    if (was && +was !== s) deck.querySelectorAll('.k-slide svg').forEach((g) => { g.style.display = 'none'; g.getBoundingClientRect(); g.style.display = ''; });
  }
  function show() {
    root.dataset.kView = S.view;
    frames.forEach((f, i) => f.classList.toggle('k-cur', i === S.i));
    slides.forEach((s, i) => {
      // In the slide view, the browser's find-in-page still finds text on hidden slides.
      if (S.view === 'slide' && i !== S.i) s.setAttribute('hidden', 'until-found'); else s.removeAttribute('hidden');
      s.querySelectorAll('.k-build').forEach((b) => b.classList.toggle('on', i !== S.i || S.view === 'scroll' || +b.dataset.k <= S.b));
    });
    markBar();
    const tb = bar.querySelector('[data-thumbs]');
    tb.setAttribute('aria-pressed', railWanted()); tb.dataset.tip = (railWanted() ? 'Hide' : 'Show') + ' thumbnails  T';
    bar.querySelector('[data-go="-1"]').disabled = S.i === 0 && S.b === 0;
    bar.querySelector('[data-go="1"]').disabled = S.i === N - 1 && S.b === builds(N - 1);
    layout();
    if (railOn() && !('filled' in rail.dataset)) { fillRail(); layout(); }
    markRail();
    writeHash();
  }
  function go(i, b = 0, opts = {}) {
    S.i = clamp(i, 0, N - 1); S.b = clamp(b, 0, builds(S.i)); show();
    if (S.view === 'scroll' && opts.scroll !== false) frames[S.i].scrollIntoView({ block: 'start' });
  }
  const step = (d) => {
    if (d > 0) { if (S.b < builds(S.i)) go(S.i, S.b + 1); else if (S.i < N - 1) go(S.i + 1, 0); }
    else if (S.b > 0) go(S.i, S.b - 1); else if (S.i > 0) go(S.i - 1, builds(S.i - 1));
  };
  // Until the reader picks a view, the view follows the width: slides when wide, the document on a phone.
  let autoView = false;
  const widthView = () => (root.clientWidth < 600 ? 'scroll' : 'slide');
  function setView(v, auto = false) {
    autoView = auto; S.view = v; show();
    if (v === 'scroll') frames[S.i].scrollIntoView({ block: 'start' }); else scrollTo(0, 0);
  }
  function toggleThumbs() { S.thumbs = !railWanted(); if (S.thumbs) fillRail(); show(); }
  // Present: the current slide, full screen. The sidebar and the bar stay hidden until the pointer moves.
  function present() {
    if (S.view !== 'slide') setView('slide');
    if (document.fullscreenEnabled) (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen()).catch(() => {});
  }
  addEventListener('fullscreenchange', () => { S.present = !!document.fullscreenElement; show(); });
  addEventListener('message', (e) => {
    const d = e.data; if (!d || d.ns !== 'k-deck' || d.v !== 1 || parent === window || e.source !== parent) return;
    // The host makes the frame full screen itself, so it tells the deck when that starts and ends.
    if (d.type === 'present') { S.present = !!d.on; if (S.present && S.view !== 'slide') { S.view = 'slide'; autoView = false; } show(); }
    if (d.type === 'view' && ['slide', 'scroll'].includes(d.view)) setView(d.view);
    if (d.type === 'audit') parent.postMessage({ ns: 'k-deck', v: 1, type: 'audit', report: window.kDeck?.report || null }, '*');
  });

  // ─── Input ───
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key, paged = S.view === 'slide';
    if (paged && ['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(k)) step(1);
    else if (paged && ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) step(-1);
    else if (paged && k === 'Home') go(0);
    else if (paged && k === 'End') go(N - 1, builds(N - 1));
    else if (k === 't' || k === 'T') toggleThumbs();
    else if (k === 'd' || k === 'D') setView(S.view === 'scroll' ? 'slide' : 'scroll');
    else if (k === 'f' || k === 'F') present();
    else return;
    e.preventDefault();
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.go) step(+b.dataset.go);
    if ('thumbs' in b.dataset) toggleThumbs();
    if (b.classList.contains('k-tick')) go(+b.dataset.i);
  });
  bar.querySelector('.k-long')?.addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); go(Math.floor(((e.clientX - r.left) / r.width) * N)); });
  // In the slide view, the wheel or a trackpad swipe pages through the slides, as in Preview's single-page view.
  // One gesture moves one slide: after a step, the deck waits for the gesture's momentum to stop.
  let wheelSum = 0, wheelLock = false, wheelIdle;
  addEventListener('wheel', (e) => {
    if (S.view !== 'slide' || e.ctrlKey || e.target.closest?.('.k-rail, .k-deck-bar')) return;
    e.preventDefault();
    clearTimeout(wheelIdle); wheelIdle = setTimeout(() => { wheelLock = false; wheelSum = 0; }, 220);
    if (wheelLock) return;
    wheelSum += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(wheelSum) >= 50) { step(wheelSum > 0 ? 1 : -1); wheelLock = true; wheelSum = 0; }
  }, { passive: false });
  rail.addEventListener('click', (e) => { const t = e.target.closest('.k-thumb'); if (t) go(+t.dataset.i); });
  slides.forEach((s, i) => s.addEventListener('beforematch', () => go(i)));
  // Presence asks for the slide that an assistant edits, with every build shown.
  slides.forEach((s, i) => s.addEventListener('k-show', () => { if (i !== S.i || S.b < builds(i)) go(i, builds(i), { scroll: false }); }));
  let tx = null;
  deck.addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
  deck.addEventListener('touchend', (e) => { if (tx === null || S.view !== 'slide') return; const dx = e.changedTouches[0].clientX - tx; tx = null; if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); });
  let idle;
  addEventListener('pointermove', () => { root.classList.add('k-awake'); clearTimeout(idle); idle = setTimeout(() => root.classList.remove('k-awake'), 2000); });
  addEventListener('hashchange', () => { const h = parseHash(); if (h.view && h.view !== S.view) { S.view = h.view; autoView = false; } S.thumbs = h.thumbs; go(h.i, h.b); });
  new ResizeObserver(() => requestAnimationFrame(() => {
    if (autoView && widthView() !== S.view) return setView(widthView(), true);
    const rl = 'kRail' in root.dataset; layout(); if (rl !== railOn()) show();
  })).observe(root);
  new ResizeObserver(() => requestAnimationFrame(layout)).observe(rail);
  // In the document view, the current slide is the last one whose top is above a line near the top of the screen, or the last slide at the end of the page.
  let scrollTick = 0;
  addEventListener('scroll', () => { if (S.view !== 'scroll' || scrollTick) return; scrollTick = requestAnimationFrame(() => {
    scrollTick = 0; const line = Math.min(innerHeight * 0.3, 120);
    let i = 0; frames.forEach((f, k) => { if (f.getBoundingClientRect().top <= line) i = k; });
    if (innerHeight + scrollY >= root.scrollHeight - 2) i = N - 1;
    if (i !== S.i) { S.i = i; S.b = 0; markBar(); markRail(); writeHash(); }
  }); }, { passive: true });

  const h = parseHash();
  S.view = h.view || widthView(); autoView = !h.view;
  // The host's thumbnail render: the slide alone, as in Present.
  if ('kCapture' in root.dataset) { S.view = 'slide'; S.present = true; autoView = false; }
  S.thumbs = h.thumbs;
  if (h.audit) root.dataset.kAudit = 'show';
  go(h.i, h.b, { scroll: false });
  if (S.view === 'scroll' && (h.i || location.hash)) frames[S.i].scrollIntoView({ block: 'start' });
  // Flows and charts draw after this function returns. Copy the slides again once they have.
  if (railOn()) setTimeout(() => { fillRail(); show(); });
  auditDeck(slides);
}

/* ─── Deck audit: how far each slide overflows its 1920×1080 canvas ───
   Reports on each slide (data-k-overflow), on <html> (data-k-audit, then data-k-deck="ready"),
   in a JSON script block with the id k-deck-report, in the console, and to the host viewer. */
async function auditDeck(slides) {
  try { await document.fonts.ready; } catch {}
  await Promise.all([...document.images].map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const root = document.documentElement;
  // until-found skips the layout of hidden slides, so show them all while measuring.
  const hidden = slides.filter((s) => s.hasAttribute('hidden'));
  hidden.forEach((s) => s.removeAttribute('hidden'));
  const path = (el, s) => {
    const parts = [];
    for (let x = el; x && x !== s; x = x.parentElement) parts.unshift(x.tagName.toLowerCase() + (x.classList[0] ? '.' + x.classList[0] : ''));
    return '#' + s.id + ' > ' + parts.join(' > ') + ' "' + el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40) + '"';
  };
  const results = slides.map((s, i) => {
    const r = { id: s.id, n: i + 1, layout: s.dataset.layout || '', y: 0, x: 0, clip: [], tiny: [] };
    const innerH = s.clientHeight, innerW = s.clientWidth;
    r.y = s.scrollHeight - innerH; r.x = s.scrollWidth - innerW;
    // A flex child can shrink and clip without raising scrollHeight. Measure again at natural height.
    s.classList.add('k-natural');
    r.y = Math.max(r.y, s.scrollHeight - innerH);
    s.classList.remove('k-natural');
    s.querySelectorAll('*').forEach((el) => {
      if (el.closest('[data-k-crop], svg')) return;
      const c = getComputedStyle(el);
      const hides = /hidden|clip|auto|scroll/.test(c.overflowX + c.overflowY) || c.textOverflow === 'ellipsis' || (c.webkitLineClamp && c.webkitLineClamp !== 'none');
      if (hides && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) r.clip.push(path(el, s));
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (own && parseFloat(c.fontSize) * (el.currentCSSZoom || 1) < DECK_MIN_FONT - 0.5) r.tiny.push(path(el, s));
    });
    r.y = Math.max(0, Math.round(r.y)); r.x = Math.max(0, Math.round(r.x));
    r.fail = r.y > 1 || r.x > 1 || r.clip.length > 0;
    if (r.fail || r.tiny.length) s.dataset.kOverflow = `y:${r.y} x:${r.x} clip:${r.clip.length} tiny:${r.tiny.length}`; else delete s.dataset.kOverflow;
    return r;
  });
  hidden.forEach((s) => s.setAttribute('hidden', 'until-found'));
  const fails = results.filter((r) => r.fail);
  const report = { v: 1, w: DECK_W, h: DECK_H, minFont: DECK_MIN_FONT, pass: !fails.length, slides: results };
  let tag = document.getElementById('k-deck-report');
  if (!tag) { tag = document.createElement('script'); tag.type = 'application/json'; tag.id = 'k-deck-report'; document.body.append(tag); }
  tag.textContent = JSON.stringify(report);
  window.kDeck = { report };
  fails.forEach((r) => console.warn('[k-deck:overflow] ' + JSON.stringify(r)));
  console.info(`[k-deck:audit] ${fails.length ? 'fail ' + fails.length : 'pass'} (${results.length} slides)`);
  root.dataset.kAuditResult = fails.length ? 'fail:' + fails.length : 'pass';
  if (parent !== window) parent.postMessage({ ns: 'k-deck', v: 1, type: 'audit', report }, '*');
  root.dataset.kDeck = 'ready';
}

/* ─── Presence: the cursor of an assistant that edits the page ───────────
   The host viewer sends the state of each run with postMessage. Nothing here runs, and the page gets no
   element, until the first message from the parent window. Each text from the viewer is text from an
   assistant: it goes into the page with textContent only.
   Messages from the viewer, all { ns: 'k-presence', v: 1, type }:
     state    runs: [{ id, agent, name, phase, quote, text, final, before, anchor, hint }]. A run that is not in the list leaves.
     reveal   id. Scroll to the cursor of that run, also when the reader scrolls.
     where    The page answers { type: 'at', x, y }: its scroll position.
     restore  x, y, flash: [{ id, agent, name, quote, before, anchor, cursor }]. Scroll there with no animation, mark the
              new text for a moment, and answer { type: 'restored' }.
   The page tells the viewer { type: 'busy', on } while a cursor moves or types. */
function runPresence() {
  if (parent === window) return;
  let P = null;
  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.ns !== 'k-presence' || d.v !== 1 || e.source !== parent) return;
    if (!P) P = startPresence();
    if (d.type === 'state' && Array.isArray(d.runs)) P.state(d.runs);
    else if (d.type === 'reveal') P.reveal(d.id);
    else if (d.type === 'where') parent.postMessage({ ns: 'k-presence', v: 1, type: 'at', x: scrollX, y: scrollY }, '*');
    else if (d.type === 'restore') P.restore(d);
  });
}
function startPresence() {
  const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT' };
  const VERBS = { starting: 'starting', reading: 'reading', editing: 'editing', replying: 'replying' };
  const SKIP = 'script, style, template, noscript, .k-pr, .k-pr-dock, .k-pr-new, .k-rail, .k-deck-bar, .k-err';
  const POINTER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 1.8 13.6 6.6 8.9 8.4 7 13.4z"/></svg>';
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const say = (msg) => parent.postMessage({ ns: 'k-presence', v: 1, ...msg }, '*');
  const mk = (tag, cls) => { const e = document.createElement(tag); e.className = cls; return e; };
  // The layer scrolls with the page: highlights and carets. The dock stays at the top: a cursor with no place in the text.
  const layer = mk('div', 'k-pr'), dock = mk('div', 'k-pr-dock');
  layer.setAttribute('aria-hidden', 'true'); dock.setAttribute('aria-hidden', 'true');
  document.body.append(layer, dock);
  const runs = new Map();
  // The reader moved the page a moment ago: do not scroll it away.
  let userAt = 0;
  ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown'].forEach((t) => addEventListener(t, (e) => { if (e.isTrusted) userAt = Date.now(); }, { passive: true, capture: true }));

  function textNodes() {
    const out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (!n.parentElement.closest(SKIP)) out.push(n);
    return out;
  }
  /** The range of a quote in the page, or null. */
  function rangeOf(quote, hint, anchor) {
    if (!quote) return null;
    const nodes = textNodes(), el = anchor ? document.getElementById(anchor) : null;
    const from = el ? nodes.findIndex((n) => el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) : -1;
    const hit = findQuote(nodes.map((n) => n.data), quote, hint, from < 0 ? undefined : from);
    if (!hit) return null;
    const g = document.createRange();
    g.setStart(nodes[hit.a[0]], hit.a[1]); g.setEnd(nodes[hit.b[0]], hit.b[1]);
    return g;
  }
  const shown = (el) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : getComputedStyle(el).visibility !== 'hidden');
  const hostOf = (g) => (g.startContainer.nodeType === 1 ? g.startContainer : g.startContainer.parentElement);
  /** One box for each line of the range, in viewport pixels. */
  function lines(g) {
    if (!shown(hostOf(g))) return [];
    const out = [];
    [...g.getClientRects()].filter((b) => b.width > 0.5 && b.height > 0.5).sort((a, b) => a.top - b.top || a.left - b.left).forEach((b) => {
      const l = out[out.length - 1];
      if (l && Math.abs(b.top - l.top) < Math.max(l.height, b.height) / 2 && b.left <= l.right + 3) {
        const top = Math.min(l.top, b.top), bottom = Math.max(l.bottom, b.bottom);
        Object.assign(l, { top, bottom, height: bottom - top, right: Math.max(l.right, b.right) });
      } else out.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom, height: b.height });
    });
    return out;
  }
  function paint(box, list, cls) {
    const o = layer.getBoundingClientRect();
    const key = cls + list.map((l) => [l.left - o.left, l.top - o.top, l.right - l.left, l.height].map(Math.round).join(',')).join(';');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.replaceChildren(...list.map((l) => {
      const i = mk('i', 'k-pr-hl ' + cls);
      i.style.cssText = `left:${l.left - o.left - 2}px;top:${l.top - o.top}px;width:${l.right - l.left + 4}px;height:${l.height}px`;
      return i;
    }));
  }
  /** Marks the old text of each run as replaced, where the browser has the CSS Custom Highlight API. */
  function strike() {
    if (!globalThis.Highlight || !CSS.highlights) return;
    const old = [...runs.values()].filter((r) => r.ins && r.range).map((r) => r.range);
    if (old.length) CSS.highlights.set('k-pr-old', new Highlight(...old)); else CSS.highlights.delete('k-pr-old');
  }

  function make(id, agent, name) {
    const cur = mk('div', 'k-pr-cur'), hl = mk('div', 'k-pr-box');
    cur.dataset.agent = hl.dataset.agent = agent === 'chatgpt' ? 'chatgpt' : 'claude';
    cur.innerHTML = '<i class="k-pr-bar"></i><span class="k-pr-flag">' + POINTER + '<b></b><span class="k-pr-verb"></span></span>';
    cur.querySelector('b').textContent = str(name, 24) || NAMES[agent] || 'Assistant';
    layer.append(hl);
    return { id, cur, hl, quote: '', key: '', range: null, landed: false, ins: null, target: '', done: 0, note: '', verb: '' };
  }
  function unpreview(r) {
    if (!r.ins) return;
    const p = r.ins.parentNode;
    r.ins.remove(); r.ins = null; r.target = ''; r.done = 0;
    if (p) p.normalize();
  }
  /** Puts the cursor in the text, or in the dock. A change of place glides: first, last, invert, play. */
  function place(r, glide) {
    const first = r.cur.isConnected && glide && !still.matches ? r.cur.getBoundingClientRect() : null;
    const list = r.range ? lines(r.range) : [];
    let at = null;
    if (r.ins) { const b = [...r.ins.getClientRects()].filter((x) => x.height > 0.5).pop(); if (b) at = { x: b.right, y: b.top, h: b.height }; }
    if (!at && list.length) { const l = r.landed || r.ins ? list[list.length - 1] : list[0]; at = { x: r.landed || r.ins ? l.right : l.left, y: l.top, h: l.height }; }
    if (at) {
      const o = layer.getBoundingClientRect();
      if (r.cur.parentNode !== layer) layer.append(r.cur);
      r.cur.dataset.mode = 'caret';
      r.cur.style.cssText = `transform:translate(${Math.round(at.x - o.left)}px,${Math.round(at.y - o.top)}px);height:${Math.round(at.h)}px`;
      // The flag sits under the caret at the top edge of the window, and while the caret writes, so it does not cover the new text.
      r.cur.classList.toggle('k-pr-low', at.y < 26 || !!r.ins);
    } else {
      if (r.cur.parentNode !== dock) dock.append(r.cur);
      r.cur.dataset.mode = 'dock'; r.cur.style.cssText = '';
    }
    r.cur.querySelector('.k-pr-verb').textContent = at ? '' : r.verb + (r.note ? ' ' + r.note : '');
    paint(r.hl, r.landed ? [] : list, r.ins ? 'k-pr-old' : '');
    if (first) {
      const last = r.cur.getBoundingClientRect(), dx = first.left - last.left, dy = first.top - last.top;
      if (Math.abs(dx) + Math.abs(dy) > 2) { r.cur.animate([{ transform: (r.cur.style.transform || '') + ` translate(${dx}px,${dy}px)` }, { transform: r.cur.style.transform || 'none' }], { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }); movedAt = Date.now(); }
    }
  }
  /** Shows the slide and scrolls to the place, unless the reader moved the page in the last seconds. */
  function show(r, force) {
    const el = r.range ? hostOf(r.range) : r.spot;
    if (!el || (!force && Date.now() - userAt < 2500)) return;
    el.closest('.k-slide')?.dispatchEvent(new CustomEvent('k-show'));
    const b = r.range ? r.range.getBoundingClientRect() : el.getBoundingClientRect();
    if (!b.width && !b.height) return;
    if (b.top < 72 || b.bottom > innerHeight - 96) scrollBy({ top: b.top - innerHeight * 0.32, behavior: still.matches ? 'auto' : 'smooth' });
  }
  /** Finds the place of the run again: the old text, or the new text after the page has the new version. */
  function find(r, s) {
    unpreview(r);
    r.range = rangeOf(s.quote, s.before || s.hint, s.anchor); r.landed = false;
    if (!r.range && s.final && s.text) { r.range = rangeOf(s.text, s.before, s.anchor); r.landed = !!r.range; }
    r.spot = r.range ? null : (s.anchor && document.getElementById(s.anchor)) || null;
    // A place on a slide that the deck does not show: the dock names the slide.
    const slide = (r.range ? hostOf(r.range) : r.spot)?.closest('.k-slide');
    r.note = slide ? 'slide ' + ([...document.querySelectorAll('main.k-deck > .k-frame > .k-slide')].indexOf(slide) + 1) : '';
  }
  let typeTimer = 0, movedAt = 0, busy = false, tick = 0;
  let typedAt = 0;
  function type() {
    // A browser slows the timers of a tab in the background. The text keeps its speed: one step for each 32 ms that passed.
    const now = Date.now(), steps = Math.max(1, Math.min(60, Math.round((now - (typedAt || now)) / 32)));
    typedAt = now;
    let more = false;
    runs.forEach((r) => {
      if (!r.ins || r.done >= r.target.length) return;
      for (let k = 0; k < steps; k++) r.done = still.matches ? r.target.length : Math.min(r.target.length, r.done + Math.max(1, Math.ceil((r.target.length - r.done) / 12)));
      r.ins.textContent = r.target.slice(0, r.done);
      place(r);
      more = more || r.done < r.target.length;
    });
    if (!more) { clearInterval(typeTimer); typeTimer = 0; typedAt = 0; movedAt = Date.now(); }
  }
  /** Writes the new text after the old text, as a preview. The stored page does not change. */
  function preview(r, text) {
    if (!r.range || r.landed) return;
    const deck = !!hostOf(r.range).closest('.k-slide'), max = deck ? 280 : 700;
    const target = text.length > max ? text.slice(0, max) + '…' : text;
    if (!r.ins) {
      const end = r.range.endContainer, host = end.nodeType === 1 ? end : end.parentElement;
      if (!host || host.closest('svg, textarea, select, option, button')) return;
      r.ins = mk('ins', 'k-pr-new'); r.ins.dataset.agent = r.cur.dataset.agent; r.ins.setAttribute('aria-hidden', 'true');
      const at = r.range.cloneRange(); at.collapse(false); at.insertNode(r.ins);
      strike();
    }
    if (target === r.target) return;
    // The assistant changed text that the preview has: keep the part that is the same.
    let same = 0; while (same < r.done && same < target.length && target[same] === r.target[same]) same++;
    r.target = target; r.done = same; r.ins.textContent = target.slice(0, same);
    if (!typeTimer) typeTimer = setInterval(type, 32);
  }
  function leave(r) {
    runs.delete(r.id); unpreview(r); strike();
    r.hl.remove(); r.cur.classList.add('k-pr-out');
    setTimeout(() => r.cur.remove(), still.matches ? 0 : 320);
  }
  function redraw() {
    runs.forEach((r) => place(r));
    const on = !!typeTimer || Date.now() - movedAt < 500;
    if (on !== busy) { busy = on; say({ type: 'busy', on }); }
    if (!runs.size && !layer.querySelector('.k-pr-flash')) { clearInterval(tick); tick = 0; }
  }
  const wake = () => { if (!tick) tick = setInterval(redraw, 200); };
  new ResizeObserver(() => requestAnimationFrame(redraw)).observe(document.documentElement);

  return {
    state(list) {
      const seen = new Set();
      list.slice(0, 4).forEach((s) => {
        if (!s || typeof s.id !== 'string' || !s.id || s.id.length > 64) return;
        seen.add(s.id);
        let r = runs.get(s.id);
        if (!r) { r = make(s.id, s.agent, s.name); runs.set(s.id, r); dock.append(r.cur); r.cur.dataset.mode = 'dock'; }
        const q = { quote: str(s.quote, 600), text: str(s.text, 2000), final: s.final === true, before: str(s.before, 200), hint: str(s.hint, 1000), anchor: str(s.anchor, 200) };
        r.verb = VERBS[s.phase] || '';
        const key = q.quote + '\n' + q.anchor + '\n' + q.before;
        // The place changed, or the old text is gone because the page has the new version.
        const moved = key !== r.key || (r.range && !r.range.startContainer.isConnected);
        if (moved) { r.key = key; find(r, q); show(r); movedAt = Date.now(); }
        if (q.text && q.quote) preview(r, q.text); else if (r.ins && !q.quote) { unpreview(r); strike(); }
        place(r, moved || (!!r.ins && !r.done));
      });
      runs.forEach((r) => { if (!seen.has(r.id)) leave(r); });
      wake(); redraw();
    },
    reveal(id) { const r = runs.get(id); if (r) { show(r, true); place(r); } },
    async restore(d) {
      // Web fonts change the height of the text. Wait for them, but not for long.
      try { await Promise.race([document.fonts.ready, new Promise((ok) => setTimeout(ok, 400))]); } catch {}
      if (Number.isFinite(d.x) && Number.isFinite(d.y)) scrollTo({ left: d.x, top: d.y, behavior: 'instant' });
      (Array.isArray(d.flash) ? d.flash : []).slice(0, 8).forEach((f) => {
        const g = f && rangeOf(str(f.quote, 2000), str(f.before, 200), str(f.anchor, 200));
        if (!g) return;
        const list = lines(g);
        if (!list.length) return;
        // The mark fades. A run that has ended gets a cursor that fades with it.
        const ghost = make('', f.agent, f.name), box = mk('div', 'k-pr-box');
        box.dataset.agent = ghost.cur.dataset.agent; layer.append(box);
        paint(box, list, 'k-pr-flash');
        if (f.cursor === true) { ghost.range = g; ghost.landed = true; place(ghost); ghost.cur.classList.add('k-pr-fade'); }
        setTimeout(() => { box.remove(); ghost.hl.remove(); ghost.cur.remove(); }, 2200);
      });
      wake();
      requestAnimationFrame(() => say({ type: 'restored' }));
    },
  };
}

function init() {
  document.documentElement.classList.remove('no-js');
  runPresence();
  document.querySelectorAll('main.k-deck').forEach(runDeck);
  document.querySelectorAll('.k-flow').forEach((el) => { try { drawFlow(el); } catch (e) { el.innerHTML = `<div class="k-err">${esc(e.message)}</div>`; } });
  document.querySelectorAll('figure.k-diagram').forEach((el) => { try { drawDiagram(el); } catch (e) { el.insertAdjacentHTML('afterbegin', `<div class="k-err">${esc(e.message)}</div>`); } });
  document.querySelectorAll('.k-dots[data-score]').forEach(drawDots);
  document.querySelectorAll('.k-model').forEach(runModel);
  document.querySelectorAll('.k-steps').forEach(runSteps);
  runMermaid();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
