/**
 * Sheet-metal spec → Manifold solid (sandbox `sheetMetalSolid(spec)`).
 * Panels are boxes in their frames, bends are annular sectors swept along
 * the edge, tabs extend an edge in-plane, holes / corner notches subtract.
 * Transforms use the sandbox row-vector convention (rows = axes, last row =
 * translation); every frame is right-handed so no mirror flips winding.
 */
import { normalizeSheetSpec, solveSheet, panelPoint, vAdd, vMul, vSub } from './sheetModel.js';

const ARC_SEGMENTS_PER_90 = 12;

function frameMatrix(X, Y, Z, origin) {
  return [
    X[0], X[1], X[2], 0,
    Y[0], Y[1], Y[2], 0,
    Z[0], Z[1], Z[2], 0,
    origin[0], origin[1], origin[2], 1,
  ];
}

function boxIn(Manifold, X, Y, Z, origin, sx, sy, sz) {
  if (!(sx > 1e-6 && sy > 1e-6 && sz > 1e-6)) return null;
  return Manifold.cube([sx, sy, sz], false).transform(frameMatrix(X, Y, Z, origin));
}

function sectorPolygon(rIn, rOut, theta, flip) {
  const n = Math.max(2, Math.ceil((theta / (Math.PI / 2)) * ARC_SEGMENTS_PER_90));
  const pt = (rad, phi) => (flip
    ? [rad * Math.sin(phi), rad * Math.cos(phi)]
    : [rad * Math.sin(phi), -rad * Math.cos(phi)]);
  const outer = [];
  const inner = [];
  for (let i = 0; i <= n; i++) {
    const phi = (theta * i) / n;
    outer.push(pt(rOut, phi));
    if (rIn > 1e-6) inner.push(pt(rIn, phi));
  }
  const poly = rIn > 1e-6 ? [...outer, ...inner.reverse()] : [...outer, [0, 0]];
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    area += x0 * y1 - x1 * y0;
  }
  return area < 0 ? poly.reverse() : poly;
}

/** One bend zone: annular sector around the bend axis, along the edge. */
function bendZone(Manifold, CrossSection, bend, t, r) {
  if (!(bend.theta > 1e-6) || !(bend.q1 - bend.q0 > 1e-6)) return null;
  // Sector in (X = d, Y = N) about the axis; up: radii r..r+t from below,
  // flip: from above. Extrude along Z, mapped to −e so the frame stays
  // right-handed (d × N = −e).
  const poly = sectorPolygon(r, r + t, bend.theta, bend.flip);
  const cs = new CrossSection([poly]);
  const zone = Manifold.extrude(cs, bend.q1 - bend.q0);
  const origin = vAdd(bend.axis, vMul(bend.q1, bend.e));
  return zone.transform(frameMatrix(bend.d, bend.N, vMul(-1, bend.e), origin));
}

export function buildSheetMetalSolid(Manifold, CrossSection, rawSpec) {
  const spec = normalizeSheetSpec(rawSpec);
  if (!spec) throw new Error('sheetMetalSolid: spec needs t, width, height > 0');
  const solved = solveSheet(spec);
  if (solved.errors.length) throw new Error(`sheetMetalSolid: ${solved.errors[0]}`);
  const { t, r } = solved;
  const parts = [];
  for (const p of solved.panels) {
    const origin = panelPoint(p, p.u0, p.v0, 0);
    const box = boxIn(Manifold, p.U, p.V, p.N, origin, p.u1 - p.u0, p.v1 - p.v0, t);
    if (box) parts.push(box);
  }
  for (const b of solved.bends) {
    const zone = bendZone(Manifold, CrossSection, b, t, r);
    if (zone) parts.push(zone);
  }
  for (const tab of solved.tabs) {
    const origin = vAdd(tab.E0, vMul(tab.q0, tab.e));
    const box = boxIn(Manifold, tab.d, tab.e, tab.N, origin, tab.depth, tab.q1 - tab.q0, t);
    if (box) parts.push(box);
  }
  if (!parts.length) throw new Error('sheetMetalSolid: nothing to build');
  let solid = parts.length === 1 ? parts[0] : Manifold.union(parts);
  const cutters = [];
  const base = solved.panels[0];
  for (const n of solved.notches) {
    const origin = vSub(panelPoint(base, n.u0, n.v0, 0), vMul(0.5, base.N));
    const c = boxIn(Manifold, base.U, base.V, base.N, origin, n.u1 - n.u0, n.v1 - n.v0, t + 1);
    if (c) cutters.push(c);
  }
  for (const h of solved.holes) {
    const d = Number(h.d) || 0;
    if (!(d > 0)) continue;
    const p = h.panelRef;
    // Cylinder along local Z, placed in the panel frame through the thickness.
    const cyl = Manifold.cylinder(t + 2, d / 2, d / 2, 48, false);
    const origin = vSub(h.center, vMul(1, p.N));
    cutters.push(cyl.transform(frameMatrix(p.U, p.V, p.N, origin)));
    // Countersink: 82° cone opening on the +N face, capped at the thickness.
    const csk = Number(h.cskDia) || 0;
    if (h.type === 'countersink' && csk > d) {
      const half = ((Number(h.cskAngle) || 82) / 2) * (Math.PI / 180);
      const depth = Math.min(t, (csk - d) / 2 / Math.tan(half));
      const rTop = d / 2 + depth * Math.tan(half);
      const cone = Manifold.cylinder(depth + 0.5, d / 2, rTop + 0.5 * Math.tan(half), 48, false);
      cutters.push(cone.transform(frameMatrix(p.U, p.V, p.N, vAdd(h.center, vMul(t - depth, p.N)))));
    }
  }
  if (cutters.length) solid = solid.subtract(cutters.length === 1 ? cutters[0] : Manifold.union(cutters));
  return solid;
}
