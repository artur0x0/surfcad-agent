/**
 * Flat pattern (unfolded with BA = θ(r + k·t)) and a DXF writer for SCS.
 * All flat frames are ± the base axes, so every region is an axis-aligned
 * rectangle in base (u, v): panels, bend strips, tabs; corner notches cut.
 * The outline is the boundary of that union (grid sweep), holes are circles.
 * Bend lines are reported but NOT written to the cut DXF (SCS cuts every line).
 */
import { normalizeSheetSpec, panelLocal, panelPoint, solveSheet, vAdd, vMul } from './sheetModel.js';

const EPS = 1e-6;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

function rect2(a, b) {
  return { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) };
}

export function sheetFlatPattern(rawSpec) {
  const spec = normalizeSheetSpec(rawSpec);
  if (!spec) throw new Error('flat pattern: invalid spec');
  const flat = solveSheet(spec, { flat: true });
  const base = flat.panels[0];
  const to2 = (p) => panelLocal(base, p);
  const rects = [];
  for (const p of flat.panels) {
    if (p.u1 - p.u0 > EPS && p.v1 - p.v0 > EPS) rects.push(rect2(to2(panelPoint(p, p.u0, p.v0)), to2(panelPoint(p, p.u1, p.v1))));
  }
  const bendLines = [];
  for (const b of flat.bends) {
    const a0 = vAdd(b.E0, vMul(b.q0, b.e));
    const a1 = vAdd(vAdd(b.E0, vMul(b.q1, b.e)), vMul(b.allowance, b.d));
    if (b.allowance > EPS && b.q1 - b.q0 > EPS) rects.push(rect2(to2(a0), to2(a1)));
    bendLines.push({
      id: b.id,
      angle: b.angle,
      flip: b.flip,
      a: to2(vAdd(b.lineMid, vMul(b.q0, b.e))),
      b: to2(vAdd(b.lineMid, vMul(b.q1, b.e))),
    });
  }
  for (const tb of flat.tabs) {
    const a0 = vAdd(tb.E0, vMul(tb.q0, tb.e));
    const a1 = vAdd(vAdd(tb.E0, vMul(tb.q1, tb.e)), vMul(tb.depth, tb.d));
    if (tb.depth > EPS && tb.q1 - tb.q0 > EPS) rects.push(rect2(to2(a0), to2(a1)));
  }
  const cuts = flat.notches.map((n) => ({ x0: n.u0, x1: n.u1, y0: n.v0, y1: n.v1 }));
  const holes = flat.holes
    .filter((h) => Number(h.d) > 0)
    .map((h) => {
      const [x, y] = to2(h.center);
      return { id: h.id, x: r6(x), y: r6(y), r: Number(h.d) / 2, type: h.type || 'hole', thread: h.thread || null, cskDia: h.cskDia || null };
    });

  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]).concat(cuts.flatMap((c) => [c.x0, c.x1])).map(r6))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y0, r.y1]).concat(cuts.flatMap((c) => [c.y0, c.y1])).map(r6))].sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const inside = (i, j) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    if (cuts.some((c) => cx > c.x0 && cx < c.x1 && cy > c.y0 && cy < c.y1)) return false;
    return rects.some((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1);
  };
  const cell = [];
  for (let i = 0; i < nx; i++) {
    cell.push([]);
    for (let j = 0; j < ny; j++) cell[i].push(inside(i, j));
  }
  const at = (i, j) => (i >= 0 && j >= 0 && i < nx && j < ny ? cell[i][j] : false);
  // Directed boundary edges with material on the left (CCW outer loops).
  const edges = new Map();
  const key = (p) => `${p[0]},${p[1]}`;
  const addEdge = (a, b) => {
    const k = key(a);
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push(b);
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!cell[i][j]) continue;
      if (!at(i, j - 1)) addEdge([xs[i], ys[j]], [xs[i + 1], ys[j]]);
      if (!at(i + 1, j)) addEdge([xs[i + 1], ys[j]], [xs[i + 1], ys[j + 1]]);
      if (!at(i, j + 1)) addEdge([xs[i + 1], ys[j + 1]], [xs[i], ys[j + 1]]);
      if (!at(i - 1, j)) addEdge([xs[i], ys[j + 1]], [xs[i], ys[j]]);
    }
  }
  const loops = [];
  while (edges.size) {
    const [startKey, outs] = edges.entries().next().value;
    const start = startKey.split(',').map(Number);
    let cur = start;
    const loop = [start];
    let next = outs.shift();
    if (!outs.length) edges.delete(startKey);
    let guard = 100000;
    while (next && guard-- > 0) {
      if (key(next) === startKey) break;
      loop.push(next);
      cur = next;
      const list = edges.get(key(cur));
      if (!list || !list.length) break;
      next = list.shift();
      if (!list.length) edges.delete(key(cur));
    }
    // Drop collinear points.
    const clean = loop.filter((p, i) => {
      const a = loop[(i - 1 + loop.length) % loop.length];
      const b = loop[(i + 1) % loop.length];
      return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > EPS;
    });
    if (clean.length >= 3) loops.push(clean);
  }
  const area = (lp) => lp.reduce((s, p, i) => {
    const q = lp[(i + 1) % lp.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
  loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
  const pts = loops.flat();
  const bbox = pts.length
    ? { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) }
    : { x0: 0, x1: 0, y0: 0, y1: 0 };
  return {
    outline: loops,
    area: loops.reduce((s, lp) => s + area(lp), 0),
    holes,
    bendLines,
    bbox,
    size: [r6(bbox.x1 - bbox.x0), r6(bbox.y1 - bbox.y0)],
  };
}

const fmt = (n) => {
  const v = Math.abs(n) < 1e-9 ? 0 : n;
  return Number(v.toFixed(6)).toString();
};

/**
 * Cut-only DXF (R12 ASCII, mm): outline LINEs + hole CIRCLEs on layer CUT,
 * translated so the flat sits at the origin. No bend lines (SCS cuts every
 * line); bends come through the STEP / the SCS app.
 */
export function sheetFlatDxf(pattern) {
  const ox = pattern.bbox.x0;
  const oy = pattern.bbox.y0;
  const out = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4',
    '9', '$MEASUREMENT', '70', '1',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER', '70', '1',
    '0', 'LAYER', '2', 'CUT', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
  ];
  for (const loop of pattern.outline) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      out.push('0', 'LINE', '8', 'CUT',
        '10', fmt(a[0] - ox), '20', fmt(a[1] - oy), '30', '0',
        '11', fmt(b[0] - ox), '21', fmt(b[1] - oy), '31', '0');
    }
  }
  for (const h of pattern.holes) {
    out.push('0', 'CIRCLE', '8', 'CUT', '10', fmt(h.x - ox), '20', fmt(h.y - oy), '30', '0', '40', fmt(h.r));
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return `${out.join('\n')}\n`;
}
