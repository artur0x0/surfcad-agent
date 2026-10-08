/**
 * Sheet-metal model — one JSON spec drives the 3D solid (sandbox
 * `sheetMetalSolid`), the viewport preview / pick handles, the flat pattern
 * (DXF) and DFM. Pure math, no three.js / Manifold.
 *
 * spec = {
 *   v: 1, sku, t (mm), r (inner bend radius mm), k (k-factor),
 *   limits: { …mm / deg from the SKU, see sheetLimitsFromRecord },
 *   plane: 'XY' | 'XZ' | 'YZ', width, height,          // base flange (centered)
 *   bends: [{ id, panel: 'base' | bendId, edge: 'u+'|'u-'|'v+'|'v-', angle, length, flip }],
 *   tabs:  [{ id, panel, edge, width, depth, centered, offset }],
 *   holes: [{ id, panel, u, v, d, kind: 'hole'|'countersink'|'tapped' }],
 * }
 *
 * Panel frame: origin o, in-plane axes U, V, normal N (right-handed);
 * material spans u∈[u0,u1], v∈[v0,v1], w∈[0,t] along N.
 * A bend on edge E of panel P: outward d, along-edge e (d×e = N). Up bend
 * (flip false) rolls toward +N around an axis at E0 + (t+r)N; flip rolls
 * toward −N around E0 − rN. The child flange is a panel with U = rolled d,
 * V = e, u∈[0,length]. The flat pattern is the same tree with θ = 0 and the
 * child shifted by the bend allowance BA = θ·(r + k·t).
 */

export const IN = 25.4;

export const SHEET_PLANES = Object.freeze({
  XY: { id: 'XY', label: 'Top', U: [1, 0, 0], V: [0, 1, 0], N: [0, 0, 1] },
  XZ: { id: 'XZ', label: 'Front', U: [1, 0, 0], V: [0, 0, 1], N: [0, -1, 0] },
  YZ: { id: 'YZ', label: 'Right', U: [0, 1, 0], V: [0, 0, 1], N: [1, 0, 0] },
});

export const SHEET_EDGES = Object.freeze(['u+', 'u-', 'v+', 'v-']);

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (s, a) => [s * a[0], s * a[1], s * a[2]];
const neg = (a) => [-a[0], -a[1], -a[2]];
export const vAdd = add;
export const vSub = sub;
export const vMul = mul;
export const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const round = (n, p = 1e4) => Math.round(n * p) / p;

/** SKU record (S1) → mm / deg limits embedded in the spec (offline DFM). */
export function sheetLimitsFromRecord(rec) {
  const mm = (n) => (typeof n === 'number' && Number.isFinite(n) ? round(n * IN) : null);
  const b = rec?.bend || {};
  const flat = (sz) => (Array.isArray(sz) ? sz.map((n) => round(n * IN)) : null);
  return {
    bendable: !!rec?.bendable,
    services: Array.isArray(rec?.services) ? [...rec.services] : [],
    minFlange: mm(b.minFlangeIn),
    maxAngle: typeof b.maxAngleDeg === 'number' ? b.maxAngleDeg : null,
    minAngle: typeof b.minAngleDeg === 'number' ? b.minAngleDeg : null,
    reliefDepth: mm(b.reliefDepthIn),
    cornerRelief: mm(b.minCornerReliefIn),
    maxBendLength: mm(b.maxBendLengthIn),
    bendDeduction: mm(b.bendDeductionIn),
    minFlat: flat(b.minFlatIn),
    maxFlat: flat(b.maxFlatIn),
    maxPart: flat(rec?.maxPartIn),
    minPart: flat(rec?.minPartIn),
    minHole: mm(rec?.dfm?.minHoleIn),
    minBridge: mm(rec?.dfm?.minBridgeIn),
    minHoleToEdge: mm(rec?.dfm?.minHoleToEdgeIn),
    minHoleToBend: mm(rec?.dfm?.minHoleToBendIn),
  };
}

/** New spec for a SKU on a plane; base flange centered at the origin. */
export function createSheetSpec(rec, plane = 'XY', { width = 100, height = 60 } = {}) {
  const t = Number(rec?.thicknessMm) || 1;
  const rIn = rec?.bend?.radiusIn;
  const r = typeof rIn === 'number' && rIn > 0 ? round(rIn * IN) : round(t);
  const k = typeof rec?.bend?.kFactor === 'number' ? rec.bend.kFactor : 0.44;
  return {
    v: 1,
    sku: rec?.sku || '',
    material: rec?.name || '',
    t,
    r,
    k,
    limits: sheetLimitsFromRecord(rec),
    plane: SHEET_PLANES[plane] ? plane : 'XY',
    width: Number(width) || 100,
    height: Number(height) || 60,
    bends: [],
    tabs: [],
    holes: [],
  };
}

/** Re-bind an existing spec to another SKU (thickness / radius / k / limits). */
export function respecSheetSku(spec, rec) {
  const fresh = createSheetSpec(rec, spec?.plane, { width: spec?.width, height: spec?.height });
  return { ...spec, sku: fresh.sku, material: fresh.material, t: fresh.t, r: fresh.r, k: fresh.k, limits: fresh.limits };
}

export function bendAllowance(spec, angleDeg) {
  const th = (Math.abs(Number(angleDeg) || 0) * Math.PI) / 180;
  return th * (spec.r + spec.k * spec.t);
}

/** Edge frame of a panel: start point E0 (q = 0), outward d, along e, q range. */
export function panelEdge(panel, edge) {
  const { o, U, V } = panel;
  switch (edge) {
    case 'u+': return { E0: add(o, mul(panel.u1, U)), d: U, e: V, q0: panel.v0, q1: panel.v1 };
    case 'u-': return { E0: add(o, mul(panel.u0, U)), d: neg(U), e: neg(V), q0: -panel.v1, q1: -panel.v0 };
    case 'v+': return { E0: add(o, mul(panel.v1, V)), d: V, e: neg(U), q0: -panel.u1, q1: -panel.u0 };
    case 'v-': return { E0: add(o, mul(panel.v0, V)), d: neg(V), e: U, q0: panel.u0, q1: panel.u1 };
    default: return null;
  }
}

/** Corner neighbours of an edge: [edge at q0 end, edge at q1 end]. */
export const EDGE_NEIGHBORS = Object.freeze({
  'u+': ['v-', 'v+'],
  'v+': ['u+', 'u-'],
  'u-': ['v+', 'v-'],
  'v-': ['u-', 'u+'],
});

/** Edges a panel can host a bend on: base → all four, flange → its tip. */
export function bendableEdges(panelId) {
  return panelId === 'base' ? SHEET_EDGES : ['u+'];
}
/** Edges a tab can sit on: base → all four, flange → tip + sides. */
export function tabEdges(panelId) {
  return panelId === 'base' ? SHEET_EDGES : ['u+', 'v+', 'v-'];
}

/** Corner relief size (mm): SCS min corner relief, never below t. */
export function cornerReliefSize(spec) {
  return round(Math.max(spec.t, Number(spec.limits?.cornerRelief) || 0) + spec.r);
}

function rotateFrame(d, N, theta, flip) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return flip
    ? { d2: sub(mul(c, d), mul(s, N)), N2: add(mul(s, d), mul(c, N)) }
    : { d2: add(mul(c, d), mul(s, N)), N2: add(mul(-s, d), mul(c, N)) };
}

/**
 * Solve the tree. `flat` = unfolded into the base plane.
 * Returns { panels, bends, tabs, holes, notches, errors }.
 */
export function solveSheet(spec, { flat = false } = {}) {
  const plane = SHEET_PLANES[spec.plane] || SHEET_PLANES.XY;
  const t = spec.t;
  const r = spec.r;
  const errors = [];
  const base = {
    id: 'base',
    o: [0, 0, 0],
    U: plane.U,
    V: plane.V,
    N: plane.N,
    u0: -spec.width / 2,
    u1: spec.width / 2,
    v0: -spec.height / 2,
    v1: spec.height / 2,
    depth: 0,
  };
  const panels = new Map([['base', base]]);
  const bendsOut = [];
  const used = new Set();
  const notches = [];
  const relief = cornerReliefSize(spec);
  const baseBent = new Set((spec.bends || []).filter((b) => b.panel === 'base').map((b) => b.edge));
  // Corner reliefs: a square notch where two bent base edges meet.
  for (const edge of SHEET_EDGES) {
    const [, nb] = EDGE_NEIGHBORS[edge];
    if (baseBent.has(edge) && baseBent.has(nb)) {
      const uSide = edge.startsWith('u') ? edge : nb;
      const vSide = edge.startsWith('v') ? edge : nb;
      const u = uSide === 'u+' ? base.u1 : base.u0;
      const v = vSide === 'v+' ? base.v1 : base.v0;
      notches.push({
        panel: 'base',
        corner: [uSide, vSide],
        u0: uSide === 'u+' ? u - relief : u,
        u1: uSide === 'u+' ? u : u + relief,
        v0: vSide === 'v+' ? v - relief : v,
        v1: vSide === 'v+' ? v : v + relief,
      });
    }
  }
  // Bends in dependency order (parent before child).
  const pending = [...(spec.bends || [])];
  let guard = pending.length + 1;
  while (pending.length && guard-- > 0) {
    for (let i = 0; i < pending.length; i++) {
      const b = pending[i];
      const parent = panels.get(b.panel);
      if (!parent) continue;
      pending.splice(i, 1);
      i -= 1;
      const key = `${b.panel}:${b.edge}`;
      if (!bendableEdges(b.panel).includes(b.edge)) {
        errors.push(`bend ${b.id}: edge ${b.edge} is not bendable on ${b.panel}`);
        continue;
      }
      if (used.has(key)) {
        errors.push(`bend ${b.id}: edge ${key} already bent`);
        continue;
      }
      used.add(key);
      const ef = panelEdge(parent, b.edge);
      let q0 = ef.q0;
      let q1 = ef.q1;
      if (b.panel === 'base') {
        const [nb0, nb1] = EDGE_NEIGHBORS[b.edge];
        if (baseBent.has(nb0)) q0 += relief;
        if (baseBent.has(nb1)) q1 -= relief;
      }
      const angle = Math.max(0, Math.min(180, Number(b.angle) || 0));
      const theta = (angle * Math.PI) / 180;
      const length = Math.max(0, Number(b.length) || 0);
      const flip = !!b.flip;
      const N = parent.N;
      let o;
      let U;
      let N2;
      let axis = null;
      const ba = bendAllowance(spec, angle);
      if (flat) {
        o = add(ef.E0, mul(ba, ef.d));
        U = ef.d;
        N2 = N;
      } else {
        const rot = rotateFrame(ef.d, N, theta, flip);
        U = rot.d2;
        N2 = rot.N2;
        if (flip) {
          axis = sub(ef.E0, mul(r, N));
          o = add(axis, mul(r, N2));
        } else {
          axis = add(ef.E0, mul(t + r, N));
          o = sub(axis, mul(t + r, N2));
        }
      }
      const child = {
        id: b.id,
        o,
        U,
        V: ef.e,
        N: N2,
        u0: 0,
        u1: length,
        v0: q0,
        v1: q1,
        parent: b.panel,
        edge: b.edge,
        depth: parent.depth + 1,
      };
      panels.set(b.id, child);
      bendsOut.push({
        id: b.id,
        panel: b.panel,
        edge: b.edge,
        angle,
        length,
        flip,
        theta,
        allowance: ba,
        E0: ef.E0,
        d: ef.d,
        e: ef.e,
        N,
        q0,
        q1,
        axis,
        // Flat: bend zone strip [E0, E0 + BA·d]; bend line at its middle.
        lineMid: add(ef.E0, mul(ba / 2, ef.d)),
      });
    }
  }
  for (const b of pending) errors.push(`bend ${b.id}: parent ${b.panel} not found`);

  const tabsOut = [];
  for (const tab of spec.tabs || []) {
    const parent = panels.get(tab.panel);
    if (!parent) {
      errors.push(`tab ${tab.id}: panel ${tab.panel} not found`);
      continue;
    }
    if (!tabEdges(tab.panel).includes(tab.edge) || used.has(`${tab.panel}:${tab.edge}`)) {
      errors.push(`tab ${tab.id}: edge ${tab.panel}:${tab.edge} is bent or not allowed`);
      continue;
    }
    const ef = panelEdge(parent, tab.edge);
    const width = Math.max(0, Number(tab.width) || 0);
    const depth = Math.max(0, Number(tab.depth) || 0);
    const span = ef.q1 - ef.q0;
    const w = Math.min(width, span);
    const start = tab.centered !== false
      ? ef.q0 + (span - w) / 2
      : Math.max(ef.q0, Math.min(ef.q1 - w, ef.q0 + (Number(tab.offset) || 0)));
    tabsOut.push({ ...tab, E0: ef.E0, d: ef.d, e: ef.e, N: parent.N, q0: start, q1: start + w, depth, width: w });
  }

  const holesOut = [];
  for (const h of spec.holes || []) {
    const p = panels.get(h.panel);
    if (!p) {
      errors.push(`hole ${h.id}: panel ${h.panel} not found`);
      continue;
    }
    const center = add(add(p.o, mul(Number(h.u) || 0, p.U)), mul(Number(h.v) || 0, p.V));
    holesOut.push({ ...h, center, N: p.N, panelRef: p });
  }

  return { panels: [...panels.values()], bends: bendsOut, tabs: tabsOut, holes: holesOut, notches, errors, t, r };
}

export function panelById(solved, id) {
  return solved.panels.find((p) => p.id === id) || null;
}

/** Point on a panel at local (u, v, w). */
export function panelPoint(panel, u, v, w = 0) {
  return add(add(add(panel.o, mul(u, panel.U)), mul(v, panel.V)), mul(w, panel.N));
}

/** World point → panel local (u, v). */
export function panelLocal(panel, p) {
  const rel = sub(p, panel.o);
  return [vDot(rel, panel.U), vDot(rel, panel.V)];
}

/**
 * Free edges a tap can target (S3 bends / S4 tabs):
 * [{ panel, edge, a, b (world endpoints at mid-thickness), bendable, tabbable }]
 */
export function sheetFreeEdges(spec, solved = solveSheet(spec)) {
  const usedBend = new Set((spec.bends || []).map((b) => `${b.panel}:${b.edge}`));
  const usedTab = new Set((spec.tabs || []).map((tb) => `${tb.panel}:${tb.edge}`));
  const out = [];
  for (const p of solved.panels) {
    for (const edge of SHEET_EDGES) {
      const key = `${p.id}:${edge}`;
      if (usedBend.has(key)) continue;
      const canBend = bendableEdges(p.id).includes(edge) && !usedTab.has(key);
      const canTab = tabEdges(p.id).includes(edge) && !usedTab.has(key);
      if (!canBend && !canTab) continue;
      const ef = panelEdge(p, edge);
      const mid = mul(spec.t / 2, p.N);
      out.push({
        panel: p.id,
        edge,
        a: add(add(ef.E0, mul(ef.q0, ef.e)), mid),
        b: add(add(ef.E0, mul(ef.q1, ef.e)), mid),
        length: ef.q1 - ef.q0,
        bendable: canBend,
        tabbable: canTab,
      });
    }
  }
  return out;
}

let nextId = 0;
export function sheetFeatureId(prefix, spec) {
  const taken = new Set([
    ...(spec?.bends || []).map((b) => b.id),
    ...(spec?.tabs || []).map((tb) => tb.id),
    ...(spec?.holes || []).map((h) => h.id),
  ]);
  for (let i = 1; i < 10000; i++) {
    const id = `${prefix}${i}`;
    if (!taken.has(id)) return id;
  }
  nextId += 1;
  return `${prefix}x${nextId}`;
}

/** Normalize a parsed spec (tolerate missing arrays / fields). Null when unusable. */
export function normalizeSheetSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = Number(raw.t);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!(t > 0) || !(width > 0) || !(height > 0)) return null;
  return {
    v: 1,
    sku: String(raw.sku || ''),
    material: String(raw.material || ''),
    t,
    r: Number(raw.r) >= 0 ? Number(raw.r) : t,
    k: Number(raw.k) > 0 ? Number(raw.k) : 0.44,
    limits: raw.limits && typeof raw.limits === 'object' ? raw.limits : {},
    plane: SHEET_PLANES[raw.plane] ? raw.plane : 'XY',
    width,
    height,
    bends: Array.isArray(raw.bends) ? raw.bends.filter((b) => b && b.id) : [],
    tabs: Array.isArray(raw.tabs) ? raw.tabs.filter((tb) => tb && tb.id) : [],
    holes: Array.isArray(raw.holes) ? raw.holes.filter((h) => h && h.id) : [],
  };
}
