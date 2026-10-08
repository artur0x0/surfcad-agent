/**
 * Slice C3 / C3.1 — shared tangency + face-normal field for Edge pick and Fillet.
 *
 * One substrate for:
 *   - Tangent-on G1 propagation (true design chains, not #49 tessellation spaghetti)
 *   - Variable-profile hard fillet framing (inscribed arc in the local wall square)
 *   - Along-path frame transport (C3.1): parallel-transport / continuous θ so the
 *     hard variableProfile sweep stays smooth (no staircase ridge)
 *   - C3.2: tighter damp + curvature-aware densify; variableProfile keeps one
 *     continuous cutter run (θ-split seams were the loft-ridge staircase)
 *
 * G1 = tangent alignment AND wall-normal continuity. Tessellation zig-zag often
 * passes a loose tangent check but flips / swaps face normals at every step.
 *
 * Kept free of imports from selectEdge.js to avoid a cycle (selectEdge consumes
 * the G1 helpers below).
 */

/**
 * Default G1 tangent tol between *adjacent* pick chords (degrees).
 * Decoupled from selectEdge's CHAIN_MAX_TURN_DEG (within-one-RDP-chord span).
 * RDP can emit adjacent chords that turn ~26° on a shelled fillet arc even when
 * each chord's internal span is ≤20° — so this must sit above that between-chord
 * turn, not merely "CHAIN + margin". 28° clears the shelled outer round without
 * opening sharp cube corners (≥45°) or roundedBox 90° face outlines.
 */
export const TANGENCY_PROP_DEG = 28;
/** Min wall-normal continuity (cos) for true G1. */
export const TANGENCY_NORMAL_ALIGN = Math.cos((28 * Math.PI) / 180);
/** Human-scale chain cap — matches selectEdge.COHERENT_EDGE_MAX. */
export const TANGENCY_CHAIN_MAX = 36;

function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _len(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function _norm(v) {
  const L = _len(v) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function _edgeKey(edge) {
  if (!edge) return '';
  if (edge.key) return edge.key;
  const a = Math.min(edge.a, edge.b);
  const b = Math.max(edge.a, edge.b);
  return `${a}-${b}`;
}

function _tangentAlign(t0, t1) {
  if (!t0 || !t1) return 0;
  return Math.abs(t0[0] * t1[0] + t0[1] * t1[1] + t0[2] * t1[2]);
}

function _buildAdj(featureEdges) {
  const adj = new Map();
  for (const e of featureEdges || []) {
    for (const v of [e.a, e.b]) {
      if (!adj.has(v)) adj.set(v, []);
      adj.get(v).push(e);
    }
  }
  return adj;
}

/**
 * Unit tangent + adjacent face normals for one edge (or knot sample).
 * @param {object} edge
 * @returns {{ T: number[], n0: number[]|null, n1: number[]|null, dihedralDeg: number }}
 */
export function edgeTangencyFrame(edge) {
  let T = null;
  if (Array.isArray(edge?.tangent) && edge.tangent.length >= 3) {
    T = _norm(edge.tangent);
  } else if (edge?.va && edge?.vb) {
    const d = _sub(edge.vb, edge.va);
    if (_len(d) > 1e-12) T = _norm(d);
  }
  if (!T) T = [0, 0, 1];
  const n0 = Array.isArray(edge?.n0) && edge.n0.length >= 3 ? _norm(edge.n0) : null;
  const n1 = Array.isArray(edge?.n1) && edge.n1.length >= 3 ? _norm(edge.n1) : null;
  let dihedralDeg = 0;
  if (n0 && n1) {
    dihedralDeg = Math.acos(Math.min(1, Math.max(-1, _dot(n0, n1)))) * 180 / Math.PI;
  }
  return { T, n0, n1, dihedralDeg };
}

/**
 * Best pairwise continuity of two normal pairs (order-insensitive).
 * High when the same two walls continue; low on tessellation flip noise.
 */
export function wallNormalContinuity(n0a, n1a, n0b, n1b) {
  if (!n0a || !n1a || !n0b || !n1b) return 1;
  const a = Math.min(_dot(n0a, n0b), _dot(n1a, n1b));
  const b = Math.min(_dot(n0a, n1b), _dot(n1a, n0b));
  return Math.max(a, b);
}

/**
 * Prefer the more axis-aligned wall normal of an edge frame (rim plane).
 * Slight |Nz| bias so top/bottom rims of axis-aligned CAD parts win over
 * shallow blend diagonals when n0/n1 score nearly equal (roundedBox).
 */
export function preferredPlaneNormal(frame) {
  if (!frame) return null;
  const { T, n0, n1 } = frame;
  if (!n0 && !n1) return null;
  if (!n0) return n1;
  if (!n1) return n0;
  const score = (n) => {
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    const dom = Math.max(ax, ay, az);
    const inP = T ? 1 - Math.abs(_dot(T, n)) : 1;
    return dom * 10 + inP + az * 0.02 + ay * 0.01;
  };
  return score(n0) >= score(n1) ? n0 : n1;
}

/**
 * True G1 between two feature/coherent edges.
 * @param {object} a
 * @param {object} b
 * @param {{ tolDeg?: number, normalAlign?: number, skipNormals?: boolean,
 *           cornerDeg?: number, cornerSharpDeg?: number,
 *           cornerOutOfPlaneDeg?: number, seedPlaneNormal?: number[] }} [opts]
 */
export function isTrueG1(a, b, opts = {}) {
  const tolDeg = typeof opts.tolDeg === 'number' ? opts.tolDeg : TANGENCY_PROP_DEG;
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  const fa = edgeTangencyFrame(a);
  const fb = edgeTangencyFrame(b);
  const tan = _tangentAlign(fa.T, fb.T);

  if (opts.skipNormals) {
    // Smooth G1 — skip wall normals on RDP chords (C.2 circular / split chainIds).
    if (tan >= cosTol) return true;
    // Collapsed fillet corners turn ~70–85°. Reject sharp ~90° cube corners
    // (cornerSharpDeg) and require both tangents to lie in the seed rim plane
    // so vertical T-junctions off a roundedBox rim do not flood.
    const cornerDeg = typeof opts.cornerDeg === 'number' ? opts.cornerDeg : 95;
    const sharpDeg = typeof opts.cornerSharpDeg === 'number' ? opts.cornerSharpDeg : 85;
    if (tan < Math.cos((cornerDeg * Math.PI) / 180)) return false;
    if (tan <= Math.cos((sharpDeg * Math.PI) / 180)) return false;
    const N = Array.isArray(opts.seedPlaneNormal) && opts.seedPlaneNormal.length >= 3
      ? opts.seedPlaneNormal
      : preferredPlaneNormal(fa);
    if (!N) return false;
    const outOfPlane = Math.sin(((opts.cornerOutOfPlaneDeg ?? 30) * Math.PI) / 180);
    if (Math.abs(_dot(fa.T, N)) > outOfPlane || Math.abs(_dot(fb.T, N)) > outOfPlane) {
      return false;
    }
    // Corner continue also needs wall-normal continuity when both sides carry
    // real normals. Loft generators meet the top rim at ~74° in-plane but the
    // wall pair changes (L1 3→1). RoundedBox collapsed rim corners keep the
    // top-face normal and pass. Incomplete/zero normals refuse the corner path
    // (smooth G1 above still applies).
    if (!_nOk(fa.n0) || !_nOk(fa.n1) || !_nOk(fb.n0) || !_nOk(fb.n1)) return false;
    const normalAlign = typeof opts.normalAlign === 'number' ? opts.normalAlign : TANGENCY_NORMAL_ALIGN;
    return wallNormalContinuity(fa.n0, fa.n1, fb.n0, fb.n1) >= normalAlign;
  }

  if (tan < cosTol) return false;
  const normalAlign = typeof opts.normalAlign === 'number' ? opts.normalAlign : TANGENCY_NORMAL_ALIGN;
  if (fa.n0 && fa.n1 && fb.n0 && fb.n1) {
    if (wallNormalContinuity(fa.n0, fa.n1, fb.n0, fb.n1) < normalAlign) return false;
  }
  return true;
}

/**
 * Propagate a true-G1 chain from seed. Soft-fails to [seed]. Caps at max.
 * @param {object[]} featureEdges
 * @param {object} seedEdge
 * @param {{ tolDeg?: number, adj?: Map, max?: number }} [opts]
 * @returns {object[]}
 */
/** Endpoint positions within this distance count as the same corner (split chainIds). */
const SPATIAL_VERT_EPS = 0.08;

function _near3(a, b, eps = SPATIAL_VERT_EPS) {
  if (!a || !b) return false;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < eps;
}

/**
 * Neighbors of `cur` by vertex-id adjacency, plus edges whose endpoints
 * coincide in space (coherent chains often mint fresh vertex ids per chain).
 */
function _neighborsOf(cur, featureEdges, adj, useSpatial) {
  const out = new Map();
  for (const v of [cur.a, cur.b]) {
    for (const nbr of adj.get(v) || []) {
      out.set(_edgeKey(nbr), nbr);
    }
  }
  if (!useSpatial) return out;
  // Only bridge from dead-end endpoints (no other incident edge in adj).
  // Full spatial linking at fillet corners over-floods into verticals.
  for (const [v, p] of [[cur.a, cur.va], [cur.b, cur.vb]]) {
    const incident = adj.get(v) || [];
    if (incident.length > 1) continue; // not a dead end in the id graph
    for (const nbr of featureEdges || []) {
      const nk = _edgeKey(nbr);
      if (out.has(nk) || nk === _edgeKey(cur)) continue;
      if (Number.isFinite(cur.bodyId) && Number.isFinite(nbr.bodyId) && cur.bodyId !== nbr.bodyId) continue;
      if (_near3(p, nbr.va) || _near3(p, nbr.vb)) {
        out.set(nk, nbr);
      }
    }
  }
  return out;
}

function _mid3(e) {
  if (Array.isArray(e?.mid) && e.mid.length >= 3) return e.mid;
  if (e?.va && e?.vb) {
    return [
      (e.va[0] + e.vb[0]) / 2,
      (e.va[1] + e.vb[1]) / 2,
      (e.va[2] + e.vb[2]) / 2,
    ];
  }
  return null;
}

function _copyEdge(edge, key) {
  return {
    ...edge,
    key,
    va: edge.va ? edge.va.slice() : undefined,
    vb: edge.vb ? edge.vb.slice() : undefined,
    mid: edge.mid ? edge.mid.slice() : undefined,
    tangent: edge.tangent ? edge.tangent.slice() : undefined,
    n0: edge.n0 ? edge.n0.slice() : undefined,
    n1: edge.n1 ? edge.n1.slice() : undefined,
    pts: Array.isArray(edge.pts) && edge.pts.length >= 2
      ? edge.pts.map((p) => p.slice())
      : edge.pts,
  };
}

/**
 * Max corresponding-endpoint separation (mm) for the parallel-face bridge.
 * Fillet top/bottom creases on roundedBox meet via short connectors (~1.6 mm at
 * r=4). A 5 mm *midpoint* band (pre-PR1) reached through a 2.5 mm shell wall;
 * gating on both endpoint pairs under this cap keeps the roundedBox rim link
 * and rejects through-wall pairs (endpoint gaps ≥ ~3.5 mm on the shelled box).
 */
const PARALLEL_BRIDGE_NODE_EPS = 2.5;

function _nOk(n) {
  return Array.isArray(n) && n.length >= 3 && _len(n) > 0.1;
}

/**
 * Same-face near-parallel crease bridge — node-gated (EDGES.md PR 1 fallback).
 *
 * Prefer delete of proximity bridging; roundedBox lower crease → top rim still
 * needs a link, and those creases share a face with corresponding endpoints
 * joined by a short topological connector. Require that honest node shape
 * instead of a 5 mm midpoint proximity band that reaches through walls.
 */
function _parallelFaceBridge(seed, list, planeN) {
  if (!seed || !list?.length) return null;
  const faces = [seed.faceA, seed.faceB].filter(Number.isFinite);
  if (!faces.length) return null;
  if (!seed.va || !seed.vb) return null;
  const sf = edgeTangencyFrame(seed);
  const cosTol = Math.cos((TANGENCY_PROP_DEG * Math.PI) / 180);
  let best = null;
  let bestD = Infinity;
  let bestH = -Infinity;
  for (const e of list) {
    if (_edgeKey(e) === _edgeKey(seed)) continue;
    if (Number.isFinite(seed.bodyId) && Number.isFinite(e.bodyId) && seed.bodyId !== e.bodyId) continue;
    if (!faces.includes(e.faceA) && !faces.includes(e.faceB)) continue;
    if (!e.va || !e.vb) continue;
    const ef = edgeTangencyFrame(e);
    if (_tangentAlign(sf.T, ef.T) < cosTol) continue;
    // Node gate: both corresponding endpoint pairs must be within eps
    // (same-direction va↔va/vb↔vb or flipped va↔vb/vb↔va).
    const d00 = Math.hypot(seed.va[0] - e.va[0], seed.va[1] - e.va[1], seed.va[2] - e.va[2]);
    const d11 = Math.hypot(seed.vb[0] - e.vb[0], seed.vb[1] - e.vb[1], seed.vb[2] - e.vb[2]);
    const d01 = Math.hypot(seed.va[0] - e.vb[0], seed.va[1] - e.vb[1], seed.va[2] - e.vb[2]);
    const d10 = Math.hypot(seed.vb[0] - e.va[0], seed.vb[1] - e.va[1], seed.vb[2] - e.va[2]);
    const sameDir = d00 <= PARALLEL_BRIDGE_NODE_EPS && d11 <= PARALLEL_BRIDGE_NODE_EPS;
    const flipDir = d01 <= PARALLEL_BRIDGE_NODE_EPS && d10 <= PARALLEL_BRIDGE_NODE_EPS;
    if (!sameDir && !flipDir) continue;
    const d = sameDir ? (d00 + d11) / 2 : (d01 + d10) / 2;
    const em = _mid3(e);
    if (!em) continue;
    const h = planeN ? Math.abs(_dot(em, planeN)) : 0;
    // Prefer the outer/higher rim when distances tie.
    if (h > bestH + 0.3 || (Math.abs(h - bestH) <= 0.3 && d < bestD)) {
      bestH = h;
      bestD = d;
      best = e;
    }
  }
  return best;
}

export function propagateTrueTangentEdges(featureEdges, seedEdge, opts = {}) {
  if (!seedEdge) return [];
  const max = typeof opts.max === 'number' ? opts.max : TANGENCY_CHAIN_MAX;
  const list = featureEdges || [];
  const adj = opts.adj || _buildAdj(list);
  // Edge-pick (skipNormals): also bridge split chainIds that meet in space.
  const useSpatial = opts.spatialAdjacency !== false && opts.skipNormals === true;
  const seedFrame = edgeTangencyFrame(seedEdge);
  let seedPlaneNormal = Array.isArray(opts.seedPlaneNormal) && opts.seedPlaneNormal.length >= 3
    ? opts.seedPlaneNormal
    : preferredPlaneNormal(seedFrame);

  const out = new Map();
  const queue = [];
  const enqueue = (edge) => {
    const nk = _edgeKey(edge);
    if (out.has(nk)) return;
    if (out.size >= max) return;
    const copy = _copyEdge(edge, nk);
    out.set(nk, copy);
    queue.push(copy);
  };
  enqueue(seedEdge);

  // Parallel same-face bridge before the walk (roundedBox lower crease → outer rim).
  if (opts.skipNormals && opts.parallelFaceBridge !== false) {
    const bridge = _parallelFaceBridge(seedEdge, list, seedPlaneNormal);
    if (bridge) {
      const bf = preferredPlaneNormal(edgeTangencyFrame(bridge));
      // Prefer the bridge plane when it is more face-like along Z (top rim).
      if (bf && (!seedPlaneNormal || Math.abs(bf[2]) > Math.abs(seedPlaneNormal[2]))) {
        seedPlaneNormal = bf;
      }
      enqueue(bridge);
    }
  }

  const g1Opts = { ...opts, seedPlaneNormal };
  while (queue.length) {
    const cur = queue.shift();
    for (const nbr of _neighborsOf(cur, list, adj, useSpatial).values()) {
      const nk = _edgeKey(nbr);
      if (out.has(nk)) continue;
      if (!isTrueG1(cur, nbr, g1Opts)) continue;
      if (out.size >= max) return [...out.values()];
      enqueue(nbr);
    }
  }
  return [...out.values()];
}

/**
 * Densify a polyline so no segment exceeds `step`.
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {number} step
 * @returns {number[][]}
 */
export function densifyPathPoints(points, closed, step, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) return points ? points.map((p) => p.slice()) : [];
  const s = Math.max(1e-3, Number(step) || 1);
  const out = [];
  const n = points.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    out.push(a.slice());
    if (!(L > 1e-9)) continue;
    const nInsert = Math.max(0, Math.ceil(L / s) - 1);
    for (let k = 1; k <= nInsert; k++) {
      const t = k / (nInsert + 1);
      out.push([
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        a[2] + t * (b[2] - a[2]),
      ]);
    }
  }
  if (!closed) out.push(points[n - 1].slice());
  const maxTurnDeg = Number(opts.maxTurnDeg);
  if (!(maxTurnDeg > 0) || out.length < 3) return out;
  return densifyPathByMaxTurn(out, closed, maxTurnDeg);
}

/**
 * Path length of a polyline (optionally closed).
 * @param {number[][]} points
 * @param {boolean} closed
 */
export function pathPolylineLength(points, closed) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const n = points.length;
  const segCount = closed ? n : n - 1;
  let L = 0;
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    L += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return L;
}

/**
 * C3.2 densify step: chord step from radius AND path length so large-R loft
 * ridges still get ~48 samples (0.75R alone left playtest R≈200 with ~handful knots).
 * @param {number} radius
 * @param {number} pathLength
 */
export function variableProfileDensifyStep(radius, pathLength) {
  const R = Math.max(Number(radius) || 1, 1e-6);
  const plen = Math.max(Number(pathLength) || 0, 0);
  const fromR = Math.max(0.28 * R, 0.4);
  if (!(plen > 1e-6)) return fromR;
  const fromLen = Math.max(plen / 48, 0.25);
  return Math.min(fromR, fromLen);
}

/**
 * Insert midpoints until consecutive segment turn angles stay under maxTurnDeg.
 * Chord-only densify misses high-curvature loft polylines where knots are already
 * shorter than step but turns between them are large.
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {number} maxTurnDeg
 * @param {number} [maxPasses]
 */
export function densifyPathByMaxTurn(points, closed, maxTurnDeg, maxPasses = 8) {
  if (!Array.isArray(points) || points.length < 3) return points ? points.map((p) => p.slice()) : [];
  const lim = Math.max(1, Number(maxTurnDeg) || 12) * Math.PI / 180;
  let cur = points.map((p) => p.slice());
  for (let pass = 0; pass < maxPasses; pass++) {
    const n = cur.length;
    const segCount = closed ? n : n - 1;
    if (segCount < 2) break;
    const insertAfter = new Set();
    for (let i = 0; i < segCount; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % n];
      const c = cur[(i + 2) % n];
      if (!closed && i + 2 >= n) break;
      const t0 = _norm(_sub(b, a));
      const t1 = _norm(_sub(c, b));
      const turn = Math.acos(Math.min(1, Math.max(-1, _dot(t0, t1))));
      if (turn > lim) {
        insertAfter.add(i);
        insertAfter.add((i + 1) % n);
      }
    }
    if (insertAfter.size === 0) break;
    const next = [];
    for (let i = 0; i < segCount; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % n];
      next.push(a.slice());
      if (insertAfter.has(i)) {
        next.push([
          (a[0] + b[0]) / 2,
          (a[1] + b[1]) / 2,
          (a[2] + b[2]) / 2,
        ]);
      }
    }
    if (!closed) next.push(cur[n - 1].slice());
    if (next.length <= cur.length) break;
    cur = next;
  }
  return cur;
}

/**
 * In-face directions from wall normals + path tangent.
 * @param {number[]} T
 * @param {number[]|null} n0
 * @param {number[]|null} n1
 */
export function inFaceDirsFromNormals(T, n0, n1, convex = true) {
  if (!T || !n0 || !n1) return null;
  const Tn = _norm(T);
  let f0 = _cross(n0, Tn);
  let f1 = _cross(n1, Tn);
  if (_len(f0) < 1e-8 || _len(f1) < 1e-8) return null;
  f0 = _norm(f0);
  f1 = _norm(f1);
  if (_dot(f0, n1) > 0) f0 = [-f0[0], -f0[1], -f0[2]];
  if (_dot(f1, n0) > 0) f1 = [-f1[0], -f1[1], -f1[2]];
  // Those flips orient each ray into the MATERIAL wedge, which is what a convex
  // blend carves. On a concave edge the material wedge is the reflex one and the
  // rays end up pointing into solid rather than along the walls (measured on an
  // L: f0=-Y, f1=-X where the faces actually run +Y and +X). Negating both puts
  // them back on the walls, spanning the EMPTY corner — exactly the region a
  // concave round fills, and the same contour then serves as the filler.
  if (!convex) {
    f0 = [-f0[0], -f0[1], -f0[2]];
    f1 = [-f1[0], -f1[1], -f1[2]];
  }
  return { f0, f1 };
}

/**
 * Local wall-square frame at a knot: path-normal orientation.
 * Square side ≈ 2R (ball diameter); setback = R / tan(θ/2).
 *
 * @param {number[]} origin
 * @param {number[]} T
 * @param {number[]} n0
 * @param {number[]} n1
 * @param {number} radius
 * @param {number[]|null} [prevN]
 */
export function buildInscribedArcFrame(origin, T, n0, n1, radius, prevN = null, convex = true) {
  const dirs = inFaceDirsFromNormals(T, n0, n1, convex);
  if (!dirs) return null;
  let A = dirs.f0;
  let C = dirs.f1;
  if (prevN && _dot(C, prevN) > _dot(A, prevN)) {
    const tmp = A;
    A = C;
    C = tmp;
  }
  const Tn = _norm(T);
  let N = A;
  let B = _norm(_cross(Tn, N));
  if (_dot(B, C) < 0) {
    N = C;
    B = _norm(_cross(Tn, N));
    if (_dot(B, A) < 0) B = [-B[0], -B[1], -B[2]];
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, _dot(_norm(dirs.f0), _norm(dirs.f1)))));
  if (!(theta > 0.05) || !(theta < Math.PI - 0.05)) return null;
  const r = Number(radius);
  if (!(r > 0)) return null;
  return {
    origin: origin.slice(),
    T: Tn,
    N,
    B,
    theta,
    setback: r / Math.tan(theta / 2),
    squareSide: 2 * r,
    f0: dirs.f0,
    f1: dirs.f1,
    convex,
  };
}

/** Max consecutive N/B jump (deg) before transport damps toward parallel-transported frame.
 * C3.2: tightened from 28° — soft-blend under 28° still left visible loft-ridge steps. */
export const FRAME_TRANSPORT_DAMP_DEG = 12;
/** Soft cap on consecutive θ change (rad) when blending along the path. */
export const FRAME_TRANSPORT_THETA_JUMP = (5 * Math.PI) / 180;
/** Max turn (deg) between consecutive densified chords (C3.2 curvature densify).
 * Tightened 10→5 so wrap/turn facets read smoother (Artur playtest). */
export const FRAME_DENSIFY_MAX_TURN_DEG = 5;

function _add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function _mul(s, v) {
  return [s * v[0], s * v[1], s * v[2]];
}

/**
 * Double-reflection parallel transport of a normal from prevT → nextT
 * (Wang et al. RMF; same spirit as sandboxWorker sweep frames).
 * @param {number[]} prevT
 * @param {number[]} prevN
 * @param {number[]} nextT
 * @param {number[]} [chord] — position delta between sample points
 * @returns {number[]}
 */
export function parallelTransportNormal(prevT, prevN, nextT, chord = null) {
  const Ti = _norm(nextT);
  const Tp = _norm(prevT);
  const Np = _norm(prevN);
  const eps2 = 1e-20;
  // Prefer chord between sample points; fall back to average tangent.
  let v1 = (chord && _len(chord) > 1e-12) ? chord.slice() : _add(Tp, Ti);
  if (_len(v1) < 1e-12) v1 = Tp.slice();
  const c1 = _dot(v1, v1);
  if (c1 < eps2) {
    const proj = _mul(_dot(Np, Ti), Ti);
    return _norm(_sub(Np, proj));
  }
  // First reflection: N and T across v1
  const NL = _sub(Np, _mul((2 / c1) * _dot(v1, Np), v1));
  const TL = _sub(Tp, _mul((2 / c1) * _dot(v1, Tp), v1));
  // Second reflection across v2 = Ti - TL
  const v2 = _sub(Ti, TL);
  const c2 = _dot(v2, v2);
  let Ni = c2 < eps2 ? NL : _sub(NL, _mul((2 / c2) * _dot(v2, NL), v2));
  Ni = _sub(Ni, _mul(_dot(Ni, Ti), Ti));
  if (_len(Ni) < 1e-12) {
    const proj = _mul(_dot(Np, Ti), Ti);
    Ni = _sub(Np, proj);
  }
  return _norm(Ni);
}

/**
 * Angle (deg) between two unit vectors; NaN-safe.
 */
export function vecAngleDeg(a, b) {
  if (!a || !b) return 0;
  return Math.acos(Math.min(1, Math.max(-1, _dot(_norm(a), _norm(b))))) * 180 / Math.PI;
}

/**
 * Max consecutive N (or B) jump along a frame list — golden / ridge pin.
 * @param {object[]} frames
 * @returns {number}
 */
export function maxConsecutiveFrameAngleDeg(frames) {
  const list = Array.isArray(frames) ? frames : [];
  let maxA = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (!a?.N || !b?.N) continue;
    const nJump = vecAngleDeg(a.N, b.N);
    const bJump = (a.B && b.B) ? vecAngleDeg(a.B, b.B) : 0;
    maxA = Math.max(maxA, nJump, bJump);
  }
  return maxA;
}

/**
 * How many θ-runs _s23GroupRuns would emit (3° tol). C3.2 loft pin: twisting
 * ridges produce many runs; variableProfile must keep a single continuous cutter.
 * @param {object[]} framesOrSegs — items with .theta (rad)
 * @param {number} [tolRad]
 */
export function countThetaRuns(framesOrSegs, tolRad = (3 * Math.PI) / 180) {
  const list = Array.isArray(framesOrSegs) ? framesOrSegs : [];
  if (list.length === 0) return 0;
  const tol = Number(tolRad) > 0 ? Number(tolRad) : (3 * Math.PI) / 180;
  let runs = 1;
  let run0 = Number(list[0].theta);
  for (let i = 1; i < list.length; i++) {
    const th = Number(list[i].theta);
    if (!(Math.abs(th - run0) < tol)) {
      runs += 1;
      run0 = th;
    }
  }
  return runs;
}

/**
 * Smooth along-path transport of inscribed-arc frames.
 * Parallel-transports N via double reflection, flips target if anti-aligned,
 * damps large N/B jumps, and blends θ so run grouping stays continuous.
 *
 * @param {object[]} rawFrames
 * @param {{ dampDeg?: number, thetaJump?: number }} [opts]
 * @returns {object[]}
 */
export function transportVariableProfileFrames(rawFrames, opts = {}) {
  const list = Array.isArray(rawFrames) ? rawFrames : [];
  if (list.length === 0) return [];
  const dampDeg = typeof opts.dampDeg === 'number' ? opts.dampDeg : FRAME_TRANSPORT_DAMP_DEG;
  const thetaJump = typeof opts.thetaJump === 'number' ? opts.thetaJump : FRAME_TRANSPORT_THETA_JUMP;
  const out = [];
  const first = list[0];
  out.push({
    ...first,
    origin: first.origin ? first.origin.slice() : undefined,
    T: first.T.slice(),
    N: first.N.slice(),
    B: first.B.slice(),
    f0: first.f0 ? first.f0.slice() : first.N.slice(),
    f1: first.f1 ? first.f1.slice() : first.B.slice(),
    transported: true,
  });
  for (let i = 1; i < list.length; i++) {
    const prev = out[i - 1];
    const raw = list[i];
    const chord = (prev.origin && raw.origin)
      ? _sub(raw.origin, prev.origin)
      : null;
    let Ntrans = parallelTransportNormal(prev.T, prev.N, raw.T, chord);
    // Prefer target N from inscribed-arc, but flip if anti-aligned with transport.
    let Ntgt = raw.N.slice();
    if (_dot(Ntgt, Ntrans) < 0) {
      Ntgt = [-Ntgt[0], -Ntgt[1], -Ntgt[2]];
    }
    const jump = vecAngleDeg(Ntrans, Ntgt);
    let N;
    if (jump > dampDeg) {
      // Large jump (tessellation flip / wall swap): stay with parallel transport.
      N = Ntrans;
    } else {
      // C3.2: heavier transport weight so soft-blend under damp still tracks smoothly.
      const t = jump < 1e-6 ? 1 : Math.min(1, (dampDeg - jump) / dampDeg);
      const w = 0.20 + 0.55 * t; // was 0.35+0.65 — less wall-target pull
      N = _norm(_add(_mul(1 - w, Ntrans), _mul(w, Ntgt)));
      N = _norm(_sub(N, _mul(_dot(N, raw.T), raw.T)));
    }
    let B = _norm(_cross(raw.T, N));
    // Keep B hemisphere continuous with previous.
    const BprevTrans = parallelTransportNormal(prev.T, prev.B, raw.T, chord);
    if (_dot(B, BprevTrans) < 0) {
      N = [-N[0], -N[1], -N[2]];
      B = [-B[0], -B[1], -B[2]];
    }
    // Continuous θ: damp jumps that shatter _s23GroupRuns.
    let theta = Number(raw.theta);
    if (!(theta > 0.05) || !(theta < Math.PI - 0.05)) theta = prev.theta;
    const dTh = theta - prev.theta;
    if (Math.abs(dTh) > thetaJump) {
      theta = prev.theta + Math.sign(dTh) * thetaJump;
    } else {
      // Mild blend toward raw (still tracks local walls).
      theta = prev.theta * 0.25 + theta * 0.75;
    }
    const r = (raw.squareSide != null ? raw.squareSide / 2 : null)
      || (raw.setback != null && theta > 1e-6 ? raw.setback * Math.tan(theta / 2) : null)
      || 1;
    out.push({
      ...raw,
      origin: raw.origin ? raw.origin.slice() : undefined,
      T: raw.T.slice(),
      N,
      B,
      theta,
      setback: r / Math.tan(theta / 2),
      squareSide: 2 * r,
      f0: raw.f0 ? raw.f0.slice() : N.slice(),
      f1: raw.f1 ? raw.f1.slice() : B.slice(),
      transported: true,
      transportDamped: jump > dampDeg,
    });
  }
  return out;
}

/**
 * Path-normal frames for a (possibly densified) path.
 * C3.1: by default applies along-path transport so consecutive N/B/θ stay continuous.
 *
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {{
 *   radius: number,
 *   segmentNormals?: object[],
 *   seedNormals?: {n0,n1},
 *   alongPathTransport?: boolean,
 * }} opts
 */
export function buildVariableProfileFrames(points, closed, opts = {}) {
  const pts = Array.isArray(points) ? points : [];
  const n = pts.length;
  if (n < 2) return { frames: [], points: pts };
  const segCount = closed ? n : n - 1;
  const radius = Number(opts.radius) || 1;
  const seed = opts.seedNormals || null;
  const perSeg = opts.segmentNormals || null;
  const perSegConvex = opts.segmentConvex || null;
  const rawFrames = [];
  let prevN = null;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const T = _norm(_sub(b, a));
    const nr = perSeg && perSeg[i] ? perSeg[i] : seed;
    const convex = perSegConvex ? perSegConvex[i] !== false : true;
    const fr = (nr?.n0 && nr?.n1)
      ? buildInscribedArcFrame(a, T, nr.n0, nr.n1, radius, prevN, convex)
      : null;
    if (fr) {
      rawFrames.push(fr);
      prevN = fr.N;
    } else {
      const up = Math.abs(T[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const N = _norm(_cross(T, up));
      const B = _norm(_cross(T, N));
      rawFrames.push({
        origin: a.slice(),
        T,
        N,
        B,
        theta: Math.PI / 2,
        setback: radius,
        squareSide: 2 * radius,
        f0: N,
        f1: B,
        convex,
        weak: true,
      });
      prevN = N;
    }
  }
  // C3.1 default: transport along path. opts.alongPathTransport:false guts it (golden RED).
  const doTransport = opts.alongPathTransport !== false;
  const frames = doTransport
    ? transportVariableProfileFrames(rawFrames, opts)
    : rawFrames;
  return {
    frames,
    points: pts.map((p) => p.slice()),
    transported: doTransport,
    maxFrameJumpDeg: maxConsecutiveFrameAngleDeg(frames),
  };
}
