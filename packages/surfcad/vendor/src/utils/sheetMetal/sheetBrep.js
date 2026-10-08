/**
 * Sheet spec → exact B-rep (planes, bend cylinders, hole cylinders,
 * countersink cones) for STEP. Built from the spec, not from a mesh.
 *
 * The solid is the flat pattern × [0, t] (w along the panel normal), pushed
 * through the fold. Topology comes from the flat grid (`sheetFlat`): every
 * flat cell belongs to a piece (a panel with its tabs, or a bend strip
 * E0 … E0 + BA·d). A grid edge between two pieces is a bend tangent line
 * (shared, no wall); an edge on the outline is a wall. Vertices are keyed
 * by their flat point and level w, so faces share edges exactly.
 *
 * Geometry per piece: panel → plane (folded frame); strip → cylinder about
 * the bend axis, radius r … r + t (inner = SKU bend radius). A strip's
 * side wall is a planar annular sector bounded by two arcs. Holes are two
 * half cylinders; a countersink adds two half cones on the +N face.
 */
import { normalizeSheetSpec, panelLocal, panelPoint, solveSheet, vAdd, vDot, vMul, vSub } from './sheetModel.js';

const EPS = 1e-6;
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

function rect2(a, b, piece) {
  return { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), piece };
}

/** Countersink geometry for a hole (null when plain): { depth, rTop, half }. */
export function countersinkOf(hole, t) {
  const d = Number(hole?.d) || 0;
  const csk = Number(hole?.cskDia) || 0;
  if (hole?.type !== 'countersink' || !(csk > d)) return null;
  const half = ((Number(hole.cskAngle) || 82) / 2) * (Math.PI / 180);
  const depth = Math.min(t, (csk - d) / 2 / Math.tan(half));
  return { depth, rTop: d / 2 + depth * Math.tan(half), half };
}

/**
 * { vertices: [p3], edges: [{ v1, v2, curve }], faces: [{ surface, sameSense,
 *   loops: [[{ edge, forward }]], kind }], stats }. Throws when the spec
 * cannot be folded into one closed shell (caller falls back to the mesh).
 */
export function buildSheetBrep(rawSpec) {
  const spec = normalizeSheetSpec(rawSpec);
  if (!spec) throw new Error('sheet B-rep: invalid spec');
  const folded = solveSheet(spec);
  const flat = solveSheet(spec, { flat: true });
  if (folded.errors.length) throw new Error(`sheet B-rep: ${folded.errors[0]}`);
  const { t, r } = spec;
  const base = flat.panels[0];
  const to2 = (p) => panelLocal(base, p);
  const from2 = (x, y) => vAdd(vAdd(base.o, vMul(x, base.U)), vMul(y, base.V));

  // Pieces + their flat rectangles (same regions as the flat pattern).
  const pieces = new Map();
  const rects = [];
  const foldPanel = new Map(folded.panels.map((p) => [p.id, p]));
  for (const p of flat.panels) {
    pieces.set(p.id, { id: p.id, kind: 'panel', flat: p, fold: foldPanel.get(p.id) });
    if (p.u1 - p.u0 > EPS && p.v1 - p.v0 > EPS) rects.push(rect2(to2(panelPoint(p, p.u0, p.v0)), to2(panelPoint(p, p.u1, p.v1)), p.id));
  }
  const foldBend = new Map(folded.bends.map((b) => [b.id, b]));
  for (const b of flat.bends) {
    const id = `bend:${b.id}`;
    pieces.set(id, { id, kind: 'bend', flat: b, fold: foldBend.get(b.id) });
    const a0 = vAdd(b.E0, vMul(b.q0, b.e));
    const a1 = vAdd(vAdd(b.E0, vMul(b.q1, b.e)), vMul(b.allowance, b.d));
    if (b.allowance > EPS && b.q1 - b.q0 > EPS) rects.push(rect2(to2(a0), to2(a1), id));
  }
  for (const tb of flat.tabs) {
    const a0 = vAdd(tb.E0, vMul(tb.q0, tb.e));
    const a1 = vAdd(vAdd(tb.E0, vMul(tb.q1, tb.e)), vMul(tb.depth, tb.d));
    if (tb.depth > EPS && tb.q1 - tb.q0 > EPS) rects.push(rect2(to2(a0), to2(a1), tb.panel));
  }
  const cuts = flat.notches.map((n) => ({ x0: n.u0, x1: n.u1, y0: n.v0, y1: n.v1 }));

  // Allowed seams: a strip touches its parent panel and its child flange; a
  // 0° bend (no strip) joins parent and child directly.
  const allowed = new Set();
  const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const b of flat.bends) {
    allowed.add(pair(`bend:${b.id}`, b.panel));
    allowed.add(pair(`bend:${b.id}`, b.id));
    if (!(b.allowance > EPS)) allowed.add(pair(b.panel, b.id));
  }

  // Map a flat point (x, y) at level w through its piece.
  const point3 = (pieceId, x, y, w) => {
    const pc = pieces.get(pieceId);
    const P = from2(x, y);
    if (pc.kind === 'panel') {
      const [u, v] = panelLocal(pc.flat, P);
      return panelPoint(pc.fold, u, v, w);
    }
    const bf = pc.flat;
    const b = pc.fold;
    const s = vDot(vSub(P, bf.E0), bf.d);
    const q = vDot(vSub(P, bf.E0), bf.e);
    const phi = bf.allowance > EPS ? (b.theta * s) / bf.allowance : 0;
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    if (b.flip) {
      const Nphi = vAdd(vMul(sn, b.d), vMul(c, b.N));
      return vAdd(vAdd(b.axis, vMul(q, b.e)), vMul(r + w, Nphi));
    }
    const Nphi = vAdd(vMul(-sn, b.d), vMul(c, b.N));
    return vSub(vAdd(b.axis, vMul(q, b.e)), vMul(t + r - w, Nphi));
  };
  const bendRadius = (pc, w) => (pc.fold.flip ? r + w : t + r - w);

  // Flat grid.
  const xs = [...new Set(rects.flatMap((q) => [q.x0, q.x1]).concat(cuts.flatMap((c) => [c.x0, c.x1])).map(r6))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((q) => [q.y0, q.y1]).concat(cuts.flatMap((c) => [c.y0, c.y1])).map(r6))].sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const pieceAtPoint = (cx, cy) => {
    if (cuts.some((c) => cx > c.x0 && cx < c.x1 && cy > c.y0 && cy < c.y1)) return null;
    const hit = rects.find((q) => cx > q.x0 && cx < q.x1 && cy > q.y0 && cy < q.y1);
    return hit ? hit.piece : null;
  };
  const cell = [];
  for (let i = 0; i < nx; i++) {
    cell.push([]);
    for (let j = 0; j < ny; j++) cell[i].push(pieceAtPoint((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2));
  }
  const at = (i, j) => (i >= 0 && j >= 0 && i < nx && j < ny ? cell[i][j] : null);

  // Directed boundary edges per piece, material on the left (CCW outer).
  const k2 = (p) => `${r6(p[0])},${r6(p[1])}`;
  const byPiece = new Map();
  const push = (piece, a, b, cls) => {
    if (cls !== 'wall' && !allowed.has(pair(piece, cls))) {
      throw new Error(`sheet B-rep: ${piece} touches ${cls} in the flat pattern`);
    }
    if (!byPiece.has(piece)) byPiece.set(piece, new Map());
    const m = byPiece.get(piece);
    const k = k2(a);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push({ a, b, cls });
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const P = cell[i][j];
      if (!P) continue;
      const side = (Q, a, b) => {
        if (Q === P) return;
        push(P, a, b, Q || 'wall');
      };
      side(at(i, j - 1), [xs[i], ys[j]], [xs[i + 1], ys[j]]);
      side(at(i + 1, j), [xs[i + 1], ys[j]], [xs[i + 1], ys[j + 1]]);
      side(at(i, j + 1), [xs[i + 1], ys[j + 1]], [xs[i], ys[j + 1]]);
      side(at(i - 1, j), [xs[i], ys[j + 1]], [xs[i], ys[j]]);
    }
  }

  // Chain each piece's edges into loops; merge collinear runs of one class.
  const dir2 = (s) => {
    const dx = s.b[0] - s.a[0];
    const dy = s.b[1] - s.a[1];
    const l = Math.hypot(dx, dy);
    return [dx / l, dy / l];
  };
  const mergeable = (s, n) => {
    if (s.cls !== n.cls) return false;
    const d0 = dir2(s);
    const d1 = dir2(n);
    return Math.abs(d0[0] - d1[0]) < 1e-9 && Math.abs(d0[1] - d1[1]) < 1e-9;
  };
  const loopArea = (lp) => lp.reduce((s, g) => s + g.a[0] * g.b[1] - g.b[0] * g.a[1], 0) / 2;
  const pieceLoops = new Map();
  for (const [piece, m] of byPiece) {
    const loops = [];
    while (m.size) {
      const [startKey, outs0] = m.entries().next().value;
      const segs = [];
      let cur = outs0.shift();
      if (!outs0.length) m.delete(startKey);
      let guard = 1e6;
      while (cur && guard-- > 0) {
        segs.push(cur);
        const kb = k2(cur.b);
        if (kb === startKey) break;
        const list = m.get(kb);
        if (!list || !list.length) throw new Error(`sheet B-rep: open boundary on ${piece}`);
        cur = list.shift();
        if (!list.length) m.delete(kb);
      }
      // Rotate to a corner, then merge.
      let s0 = segs.findIndex((s, i) => !mergeable(segs[(i - 1 + segs.length) % segs.length], s));
      if (s0 < 0) s0 = 0;
      const rot = [...segs.slice(s0), ...segs.slice(0, s0)];
      const merged = [];
      for (const s of rot) {
        const last = merged[merged.length - 1];
        if (last && mergeable(last, s)) last.b = s.b;
        else merged.push({ ...s });
      }
      loops.push(merged);
    }
    const outer = loops.filter((lp) => loopArea(lp) > EPS);
    if (outer.length !== 1) throw new Error(`sheet B-rep: ${piece} is not one region`);
    loops.sort((a, b) => loopArea(b) - loopArea(a));
    pieceLoops.set(piece, loops);
  }

  // B-rep store.
  const vertices = [];
  const vIndex = new Map();
  const vertex = (key, p3) => {
    let id = vIndex.get(key);
    if (id == null) {
      id = vertices.length;
      vertices.push(p3);
      vIndex.set(key, id);
    } else if (len(vSub(vertices[id], p3)) > 1e-6) {
      throw new Error(`sheet B-rep: vertex ${key} disagrees between pieces`);
    }
    return id;
  };
  const edges = [];
  const eIndex = new Map();
  const edge = (key, v1, v2, curveFn) => {
    let id = eIndex.get(key);
    if (id == null) {
      id = edges.length;
      edges.push({ v1, v2, curve: curveFn() });
      eIndex.set(key, id);
    }
    const e = edges[id];
    if (!((e.v1 === v1 && e.v2 === v2) || (e.v1 === v2 && e.v2 === v1))) throw new Error(`sheet B-rep: edge ${key} endpoints differ`);
    return { edge: id, forward: e.v1 === v1 };
  };
  const faces = [];
  const LV = (w) => (Math.abs(w) < EPS ? '0' : Math.abs(w - t) < EPS ? 't' : r6(w).toString());
  const gridVertex = (piece, p, w) => vertex(`g:${k2(p)}@${LV(w)}`, point3(piece, p[0], p[1], w));
  const arcCurve = (C, A, M, radius) => {
    const axis = unit(cross(vSub(A, C), vSub(M, C)));
    return { type: 'circle', center: C, axis, ref: unit(vSub(A, C)), radius };
  };
  /** A flat segment at level w inside its piece: line, or an arc across a strip. */
  const gridEdge = (piece, s, w) => {
    const va = gridVertex(piece, s.a, w);
    const vb = gridVertex(piece, s.b, w);
    const key = `g:${Math.min(va, vb)}:${Math.max(va, vb)}`;
    return edge(key, va, vb, () => {
      const pc = pieces.get(piece);
      if (pc.kind === 'bend' && pc.flat.allowance > EPS) {
        const d2 = to2(vAdd(base.o, pc.flat.d));
        const dd = dir2(s);
        if (Math.abs(dd[0] * d2[0] + dd[1] * d2[1]) > 1 - 1e-9) {
          const q = vDot(vSub(from2(s.a[0], s.a[1]), pc.flat.E0), pc.flat.e);
          const C = vAdd(pc.fold.axis, vMul(q, pc.fold.e));
          const mid = point3(piece, (s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, w);
          return arcCurve(C, vertices[va], mid, bendRadius(pc, w));
        }
      }
      return { type: 'line' };
    });
  };
  const verticalEdge = (piece, p) => {
    const va = gridVertex(piece, p, 0);
    const vb = gridVertex(piece, p, t);
    return edge(`v:${k2(p)}`, va, vb, () => ({ type: 'line' }));
  };
  const flip = (oe) => ({ edge: oe.edge, forward: !oe.forward });
  const reverseLoop = (loop) => loop.slice().reverse().map(flip);

  // Holes: which piece, flat center, levels.
  const flatHoles = new Map(flat.holes.map((h) => [h.id, h]));
  const holesByPiece = new Map();
  const holeLoops = [];
  for (const h of folded.holes) {
    const d = Number(h.d) || 0;
    if (!(d > 0)) continue;
    const fh = flatHoles.get(h.id);
    const [cx, cy] = to2(fh.center);
    const piece = pieceAtPoint(cx, cy);
    if (piece !== h.panel) throw new Error(`sheet B-rep: hole ${h.id} is not inside ${h.panel}`);
    const R = d / 2;
    const csk = countersinkOf(h, t);
    // Levels bottom → top with radius at each.
    const levels = [{ w: 0, rad: R }];
    if (csk && csk.depth < t - EPS) levels.push({ w: t - csk.depth, rad: R });
    levels.push({ w: t, rad: csk ? csk.rTop : R });
    const pc = pieces.get(piece);
    const ptAt = (ang, rad, w) => point3(piece, cx + rad * Math.cos(ang), cy + rad * Math.sin(ang), w);
    const center3 = (w) => point3(piece, cx, cy, w);
    // Half arcs, clockwise in flat (material on the left): 0 → −π/2 → π, π → π/2 → 0.
    const halfMid = [-Math.PI / 2, Math.PI / 2];
    const hv = (k, li) => vertex(`h:${h.id}:${k}:${li}`, ptAt(k * Math.PI, levels[li].rad, levels[li].w));
    const arcAt = (hi, li) => {
      const am = halfMid[hi];
      const va = hv(hi, li);
      const vb = hv((hi + 1) % 2, li);
      return edge(`ha:${h.id}:${hi}:${li}`, va, vb, () => arcCurve(center3(levels[li].w), vertices[va], ptAt(am, levels[li].rad, levels[li].w), levels[li].rad));
    };
    const top = [arcAt(0, levels.length - 1), arcAt(1, levels.length - 1)];
    const bottom = reverseLoop([arcAt(0, 0), arcAt(1, 0)]);
    if (!holesByPiece.has(piece)) holesByPiece.set(piece, []);
    holesByPiece.get(piece).push({ top, bottom });
    // Walls per band, per half.
    const N3 = pc.fold.N;
    const U3 = pc.fold.U;
    for (let li = 0; li + 1 < levels.length; li++) {
      const lo = levels[li];
      const hiL = levels[li + 1];
      for (let hi = 0; hi < 2; hi++) {
        const ka = hi;
        const kb = (hi + 1) % 2;
        const up = (k) => edge(`hv:${h.id}:${k}:${li}`, hv(k, li), hv(k, li + 1), () => ({ type: 'line' }));
        const loop = [arcAt(hi, li), up(kb), flip(arcAt(hi, li + 1)), flip(up(ka))];
        const cone = Math.abs(hiL.rad - lo.rad) > EPS;
        faces.push({
          kind: cone ? 'countersink' : 'hole',
          surface: cone
            ? { type: 'cone', origin: center3(lo.w), axis: N3, ref: U3, radius: lo.rad, semiAngle: Math.atan((hiL.rad - lo.rad) / (hiL.w - lo.w)) }
            : { type: 'cylinder', origin: center3(0), axis: N3, ref: U3, radius: lo.rad },
          sameSense: false,
          loops: [loop],
        });
      }
    }
    holeLoops.push(h.id);
  }

  // Top / bottom faces per piece, and walls.
  for (const [piece, loops] of pieceLoops) {
    const pc = pieces.get(piece);
    const topLoops = loops.map((lp) => lp.map((s) => gridEdge(piece, s, t)));
    const botLoops = loops.map((lp) => reverseLoop(lp.map((s) => gridEdge(piece, s, 0))));
    const holes = holesByPiece.get(piece) || [];
    for (const hl of holes) {
      topLoops.push(hl.top);
      botLoops.push(hl.bottom);
    }
    if (pc.kind === 'panel') {
      const P = pc.fold;
      const o3 = panelPoint(P, (P.u0 + P.u1) / 2, (P.v0 + P.v1) / 2, 0);
      faces.push({ kind: 'panel', piece, surface: { type: 'plane', origin: vAdd(o3, vMul(t, P.N)), axis: P.N, ref: P.U }, sameSense: true, loops: topLoops });
      faces.push({ kind: 'panel', piece, surface: { type: 'plane', origin: o3, axis: vMul(-1, P.N), ref: P.U }, sameSense: true, loops: botLoops });
    } else {
      const b = pc.fold;
      // +w moves away from the axis on a flip bend (r + w), toward it on an up
      // bend (t + r − w). The cylinder's own normal points away from the axis.
      const plusWAway = !!b.flip;
      const mk = (w, loopsW, outwardIsPlusW) => {
        const radius = bendRadius(pc, w);
        const awayFromAxis = outwardIsPlusW ? plusWAway : !plusWAway;
        faces.push({ kind: 'bend', piece, bend: b.id, surface: { type: 'cylinder', origin: vAdd(b.axis, vMul(b.q0, b.e)), axis: b.e, ref: b.N, radius }, sameSense: awayFromAxis, loops: loopsW });
      };
      mk(t, topLoops, true);
      mk(0, botLoops, false);
    }
    // Walls on the outline: a_bot → b_bot → b_top → a_top.
    for (const lp of loops) {
      for (const s of lp) {
        if (s.cls !== 'wall') continue;
        const bot = gridEdge(piece, s, 0);
        const top = gridEdge(piece, s, t);
        const loop = [bot, verticalEdge(piece, s.b), flip(top), flip(verticalEdge(piece, s.a))];
        const A = vertices[gridVertex(piece, s.a, 0)];
        const Atop = vertices[gridVertex(piece, s.a, t)];
        const M = point3(piece, (s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, 0);
        const normal = unit(cross(vSub(M, A), vSub(Atop, A)));
        faces.push({ kind: 'wall', piece, surface: { type: 'plane', origin: A, axis: normal, ref: unit(vSub(Atop, A)) }, sameSense: true, loops: [loop] });
      }
    }
  }

  // Closed, consistently oriented shell: every edge used twice, opposite ways.
  const uses = new Map();
  for (const f of faces) {
    for (const lp of f.loops) {
      for (const oe of lp) {
        const u = uses.get(oe.edge) || { f: 0, b: 0 };
        if (oe.forward) u.f += 1;
        else u.b += 1;
        uses.set(oe.edge, u);
      }
    }
  }
  for (let i = 0; i < edges.length; i++) {
    const u = uses.get(i);
    if (!u || u.f !== 1 || u.b !== 1) throw new Error(`sheet B-rep: edge ${i} used ${u ? `${u.f}+${u.b}` : 0} times`);
  }
  const count = (kind, type) => faces.filter((f) => (!kind || f.kind === kind) && (!type || f.surface.type === type)).length;
  return {
    vertices,
    edges,
    faces,
    stats: {
      faces: faces.length,
      edges: edges.length,
      vertices: vertices.length,
      planes: count(null, 'plane'),
      cylinders: count(null, 'cylinder'),
      cones: count(null, 'cone'),
      bendFaces: count('bend'),
      holes: holeLoops.length,
    },
  };
}

/** Sample an oriented edge into points (arcs: `seg` segments), start → end. */
export function sampleEdge(brep, oe, seg = 64) {
  const e = brep.edges[oe.edge];
  const A = brep.vertices[e.v1];
  const B = brep.vertices[e.v2];
  let pts;
  if (e.curve.type === 'circle') {
    const { center: C, axis, radius } = e.curve;
    const x = unit(vSub(A, C));
    const y = cross(axis, x);
    const bx = vDot(vSub(B, C), x);
    const by = vDot(vSub(B, C), y);
    let sweep = Math.atan2(by, bx);
    if (sweep <= 1e-9) sweep += 2 * Math.PI;
    pts = [];
    for (let i = 0; i <= seg; i++) {
      const a = (sweep * i) / seg;
      pts.push(i === seg ? B : vAdd(C, vAdd(vMul(radius * Math.cos(a), x), vMul(radius * Math.sin(a), y))));
    }
  } else {
    pts = [A, B];
  }
  return oe.forward ? pts : pts.reverse();
}

/**
 * Volume of the B-rep from its own edges (divergence theorem on a closed
 * polyhedron with every arc sampled `seg` times). Planar faces use their
 * sampled loops; a curved face is ruled between its two arc edges.
 */
export function brepVolume(brep, seg = 256) {
  let v = 0;
  for (const f of brep.faces) {
    if (f.surface.type === 'plane') {
      for (const lp of f.loops) {
        const pts = [];
        for (const oe of lp) pts.push(...sampleEdge(brep, oe, seg).slice(0, -1));
        let ax = 0;
        let ay = 0;
        let az = 0;
        for (let i = 0; i < pts.length; i++) {
          const c = cross(pts[i], pts[(i + 1) % pts.length]);
          ax += c[0];
          ay += c[1];
          az += c[2];
        }
        v += vDot([ax / 2, ay / 2, az / 2], pts[0]) / 3;
      }
      continue;
    }
    const lp = f.loops[0];
    const arcs = lp.map((oe, i) => ({ oe, i })).filter(({ oe }) => brep.edges[oe.edge].curve.type === 'circle');
    if (arcs.length !== 2) throw new Error('brepVolume: curved face needs two arcs');
    const A = sampleEdge(brep, arcs[0].oe, seg);
    const B = sampleEdge(brep, arcs[1].oe, seg).reverse();
    for (let i = 0; i < seg; i++) {
      const tri = (p, q, s) => vDot(p, cross(q, s)) / 6;
      v += tri(A[i], A[i + 1], B[i + 1]) + tri(A[i], B[i + 1], B[i]);
    }
  }
  return v;
}
