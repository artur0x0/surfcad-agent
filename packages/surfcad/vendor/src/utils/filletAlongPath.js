/**
 * Slice 23 — Fillet via swept cross-section.
 *
 * Pure helpers shared by palette soft-fail, goldens, and docs.
 * Script-facing filletAlongPath lives in sandboxWorker (sweep + boolean subtract).
 *
 * Cutter profile is shaped from the measured interior dihedral θ between the
 * two in-face directions (not a hard-coded 90° wedge). At θ = 90° the fillet
 * is the historical first-quadrant wedge (square minus quarter-disk at (r,r),
 * area r²(1−π/4)) and the chamfer is the right triangle (0,0)-(c,0)-(0,c).
 *
 * Strategy default (and auto) is sweep — the universal fillet. Planar is an
 * explicit manual override for classic filletEdges only.
 * Does NOT ship extrude/revolve/loft — wait for Product brief.
 */

import { assembleSweepPath, sweepPathMaxChordForTurn } from './edgeSweepPath.js';
export { SLIVER_MAX_ABS, SLIVER_MAX_FRAC, isFilletSliverDirty } from './filletSliverGuard.js';

export const FILLET_SWEEP_EMPTY =
  'Select edges first (Edge pick mode), then Fillet (Strategy=sweep by default). Tangent-on chains work for circular rims.';

export const FILLET_SWEEP_DISCONNECTED =
  'Selected edges are disconnected — sweep fillet needs a single contiguous chain or loop (use Tangent for circular rims).';

export const FILLET_SWEEP_BRANCH =
  'Selected edges branch (junction) — sweep fillet needs a simple open chain or closed loop, not a Y/T junction.';

/**
 * Default fillet-arc tessellation. 12 steps on a 90° corner is a 7.5° facet
 * (and a ~3% face on a box-scale edge). Kept at 24 — denser turns come from
 * FRAME_DENSIFY_MAX_TURN_DEG (5°) and semi-arc independent subtracts; raising
 * the wedge segment count spiked long-fin counts on wrap goldens.
 */
export const FILLET_ARC_SEGMENTS = 24;

/**
 * Fillet cutter wedge in UV (u≥0, v≥0): origin → (r,0) → arc (center (r,r)) → (0,r).
 * Area = r²(1 − π/4). Opposite of a quarter-disk pie.
 * @param {number} radius
 * @param {number} [arcSegments=12]
 * @returns {number[][]} closed polyline (first ≠ last)
 */
export function filletWedgeContour(radius, arcSegments = FILLET_ARC_SEGMENTS) {
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r)) {
    throw new Error('filletWedgeContour: radius must be > 0');
  }
  const seg = Math.max(2, Math.round(Number(arcSegments) || FILLET_ARC_SEGMENTS));
  const pts = [[0, 0], [r, 0]];
  for (let i = 1; i <= seg; i++) {
    const t = (i / seg) * (Math.PI / 2);
    // Arc from (r,0) → (0,r) with center (r,r), short way near origin.
    pts.push([r - r * Math.sin(t), r - r * Math.cos(t)]);
  }
  return pts;
}

/**
 * Chamfer triangle cutter: (0,0) → (c,0) → (0,c).
 * @param {number} size
 * @returns {number[][]}
 */
export function chamferWedgeContour(size) {
  const c = Number(size);
  if (!(c > 0) || !Number.isFinite(c)) {
    throw new Error('chamferWedgeContour: size must be > 0');
  }
  return [[0, 0], [c, 0], [0, c]];
}

/**
 * Normalize path input to { points, closed, length, edgeCount? }.
 * Accepts makeSweepPath value, { points, closed }, or bare points[] (+ opts.closed).
 * @param {object|number[][]} path
 * @param {object} [opts]
 * @returns {{ points: number[][], closed: boolean, length: number, edgeCount: number|null }}
 */
export function normalizeFilletPath(path, opts = {}) {
  if (!path) {
    throw new Error('filletAlongPath: path is required (makeSweepPath result or points[])');
  }
  let points;
  let closed = !!opts.closed;
  let edgeCount = null;

  if (Array.isArray(path)) {
    points = path;
  } else if (typeof path === 'object') {
    if (path.kind && path.kind !== 'sweepPath') {
      throw new Error(`filletAlongPath: unexpected path.kind "${path.kind}" (want sweepPath)`);
    }
    if (!Array.isArray(path.points)) {
      throw new Error('filletAlongPath: path.points must be an array of [x,y,z]');
    }
    points = path.points;
    if (path.closed != null) closed = !!path.closed;
    if (Number.isFinite(path.edgeCount)) edgeCount = path.edgeCount;
  } else {
    throw new Error('filletAlongPath: path must be makeSweepPath result or points[]');
  }

  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('filletAlongPath: path needs ≥ 2 points');
  }
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Array.isArray(p) || p.length < 3) {
      throw new Error(`filletAlongPath: point[${i}] must be [x,y,z]`);
    }
    const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`filletAlongPath: point[${i}] has non-finite coords`);
    }
    if (out.length) {
      const prev = out[out.length - 1];
      if (Math.hypot(x - prev[0], y - prev[1], z - prev[2]) < 1e-9) continue;
    }
    out.push([x, y, z]);
  }
  if (out.length < 2) {
    throw new Error('filletAlongPath: path collapsed to < 2 distinct points');
  }
  // Closed: strip duplicated close point if present
  if (closed && out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-5) {
      out.pop();
    }
  }
  if (closed && out.length < 3) {
    throw new Error('filletAlongPath: closed path needs ≥ 3 distinct points');
  }

  let length = 0;
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i], b = out[i + 1];
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  if (closed) {
    const a = out[out.length - 1], b = out[0];
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  if (!(length > 1e-9)) {
    throw new Error('filletAlongPath: path has zero length');
  }
  return { points: out, closed, length, edgeCount };
}


/**
 * Fillet strategy from selected edges.
 * Sweep is the universal default — planar is never chosen automatically.
 * Manual Strategy=planar still overrides via resolveFilletStrategy.
 * Extra args (edge set) are ignored — kept so call sites stay stable.
 *
 * @returns {'planar'|'sweep'}
 */
export function pickFilletStrategy() {
  return 'sweep';
}

/**
 * Resolve Strategy select value: sweep is default; auto → sweep;
 * planar is the only manual override (classic filletEdges).
 * Extra args (edge set) are ignored — kept so call sites stay stable.
 * @param {string|null|undefined} strategy
 * @returns {'planar'|'sweep'}
 */
export function resolveFilletStrategy(strategy) {
  const s = String(strategy || 'sweep').toLowerCase();
  if (s === 'planar') return 'planar';
  return 'sweep';
}

/**
 * Soft-fail gate for UI (same topology rules as Path / makeSweepPath).
 * @param {object[]|null|undefined} edges
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function canBuildFilletAlongPath(edges) {
  const base = assembleSweepPath(edges);
  if (base.ok) return { ok: true };
  const msg = base.message || FILLET_SWEEP_EMPTY;
  if (/disconnect/i.test(msg)) {
    const extra = (msg.match(/\([^)]*component[^)]*\)/) || [])[0];
    return {
      ok: false,
      message: FILLET_SWEEP_DISCONNECTED + (extra ? ` ${extra}` : ''),
    };
  }
  if (/branch/i.test(msg)) return { ok: false, message: FILLET_SWEEP_BRANCH };
  return { ok: false, message: msg || FILLET_SWEEP_EMPTY };
}

/**
 * Assemble path value for sweep fillet from edge selection (palette).
 * @param {object[]} edges
 * @param {object} [opts]
 */
export function assembleFilletSweepPath(edges, opts = {}) {
  const gate = canBuildFilletAlongPath(edges);
  if (!gate.ok) return gate;
  return assembleSweepPath(edges, opts);
}

/**
 * Analytic removed area for a 90° fillet cross-section (per unit length).
 * @param {number} r
 */
export function filletWedgeArea(r) {
  return r * r * (1 - Math.PI / 4);
}

/**
 * Analytic removed area for a 90° chamfer triangle (per unit length).
 * @param {number} c
 */
export function chamferWedgeArea(c) {
  return 0.5 * c * c;
}

/**
 * Sweep-path policy for filletAlongPath (sandboxWorker + goldens).
 *
 * PR #27 skipped tessellated prior-fillet micro-arcs (mixed long+micro → open
 * long runs only). That left a gap instead of wrapping the prior blend.
 * Never drop micro arcs — slivers are consumed by cutter exterior overlap.
 * Uniform closed rims and mixed long+micro stay `as-is`.
 *
 * Corner arcs on the path: a continuous sweep over an arc has bad start/end
 * conditions (cusp leftovers; #107 sphere caps left twin bulges). When
 * distinct corner-arc runs are present (mixed straights + arcs), split into
 * straight runs + two semi-arcs per corner → `mode:'runs'`. Fillet profile
 * only splits same-r arcs (path R ≈ cutter); chamfer also splits when path R
 * ≠ cutter (chamfer-along-prior-fillet). Uniform closed all-arc rims stay
 * `as-is`.
 *
 * @param {number[][]} points
 * @param {boolean} [closed]
 * @param {number} [radius]
 * @param {object} [opts]
 * @param {'fillet'|'chamfer'} [opts.profile='fillet'] — chamfer enables R≠cutter arc split
 * @param {boolean} [opts.splitTighterArcs=false] — fillet: also split arcs with R < r (all-convex path)
 * @returns {{ mode:'as-is' } | { mode:'empty' } | { mode:'runs', runs: number[][][] }}
 */
export function planFilletSweepPath(points, closed, radius, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) return { mode: 'empty' };
  const r = Number(radius);
  if (Number.isFinite(r) && r > 0) {
    // Fillet: same-r arcs, plus — on an all-convex path (opts.splitTighterArcs)
    // — arcs TIGHTER than the cutter (R < r). A wrap around a looser arc
    // (R > r) stays as-is — fin-safe. A concave (material-add) run keeps its
    // tight arc whole: its filler sits outside the bend, and splitting it
    // left zero-area cracks on the hollow/draft playtests.
    // Chamfer: any corner arc (chamfer-along-prior-fillet, path R ≠ cutter).
    //
    // Why tighter arcs split: one tube swept round an arc of radius R turns
    // every ring about the arc's center, and when R < r that center lies
    // INSIDE the r-section. Rings on the inside of the bend then cross each
    // other — the tube self-intersects. Artur's three-fillet wrap (r=3.73)
    // turns 90° round each R=2 prior-fillet arc, four times along one chain;
    // each turn left a bow-tie notch / fin on the top face. Semi-arc runs
    // (each its own cutter, unioned) are what the chamfer already does.
    const matchCutterRadius = opts.profile !== 'chamfer';
    const runs = splitSameRadiusArcsIntoSemiArcRuns(points, !!closed, r, {
      arcsOnly: false,
      matchCutterRadius,
      splitTighterArcs: matchCutterRadius && opts.splitTighterArcs === true,
    });
    if (runs && runs.length >= 2) return { mode: 'runs', runs };
  }
  return { mode: 'as-is' };
}

/** Fraction of radius used as exterior / rear boolean-fuzz (does not grow Q1 extent). */
export const FILLET_SWEEP_EXPAND_FRAC = 0.15;
/** Floor so tiny / tighter follow-on radii still get a rear overlap (mm). Size-neutral. */
export const FILLET_SWEEP_EXPAND_MIN = 0.30;
/** Cap on exterior / rear overlap (mm). Size-neutral — does not redefine fillet r. */
export const FILLET_SWEEP_EXPAND_MAX = 1.20;

/**
 * Exterior / rear overlap margin for the sweep cutter (−e,−e) family.
 * Decoupled from blend size: first-quadrant extent stays at requested r.
 * @param {number} radius
 * @returns {number}
 */
export function filletSweepCutterExpand(radius) {
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r)) return 0;
  return Math.min(
    FILLET_SWEEP_EXPAND_MAX,
    Math.max(FILLET_SWEEP_EXPAND_MIN, FILLET_SWEEP_EXPAND_FRAC * r),
  );
}

/**
 * Boolean-fuzz a fillet/chamfer wedge so cutter legs are not
 * tangent-coincident with the part faces.
 *
 * Mechanism: the nominal wedge legs (0,0)→(r,0) and (0,0)→(0,r) lie ON the
 * two adjacent faces. Manifold CSG on coincident surfaces can leave sliver
 * sheets — worse when the path includes tessellated prior-fillet micro-arcs
 * (chordal RMF frames sitting near-tangent to the old cylinder).
 *
 * Size-neutral boolean robustness: keep every first-quadrant vertex at the
 * requested r (realized blend extent = requested r) and replace the origin
 * with a rear bumper in the (−e,−e) family: (−e,−e) plus thickness-e strips
 * in Q2/Q4. Extra cutter lives in empty space past the crease so the legs
 * are not coplanar-coincident with the faces — mixed-radius / tighter
 * follow-on sweeps need a deeper rear pad than the original 4%·r sliver.
 * Uniform Q1 scale is not used — it only redefined requested r.
 *
 * Face-leg setback endpoints on fillet wedges are nudged a tiny ε
 * (≈min(0.0025, max(1e-4, 5e-4·r))) into empty space so they are not
 * exactly on the part faces. Wrap playtest long fins drop 138→~26; dark
 * visible inward wedges stay 0. Chamfer keeps historical on-face legs.
 * Larger nudges / bumper-anchor inset clear more setback-plane fins but
 * either decompose fillet-on-fillet wraps or regress stacked chamfer into
 * visible inward wedges — residual setback fins are ceiling-locked in the
 * box-stack golden instead.
 *
 * (−e,−e) family is an unvalidated boolean-robustness margin: kept because
 * legs must not coplanar-coincide with faces, and as the origin vertex (the
 * (0,0) corner is skipped so this must replace it or the contour
 * collapses). Size-neutral. It is not proven load-bearing by the rim
 * fIn net — that net is a gap detector on the whole rim sphere and
 * cannot certify pad / coincident slivers. The same net still catches
 * path truncation / skip-micro (M6), separately from the pad.
 *
 * Pure 2D — no Manifold.
 *
 * @param {number[][]} contour  wedge from filletWedgeContour / chamferWedgeContour
 * @param {number} radius
 * @returns {number[][]}
 */
export function expandFilletCutterContour(contour, radius) {
  if (!Array.isArray(contour) || contour.length < 3) {
    throw new Error('expandFilletCutterContour: need a wedge (≥3 pts)');
  }
  const e = filletSweepCutterExpand(radius);
  const r = Number(radius);
  if (!(e > 0) || !(r > 0) || !Number.isFinite(r)) {
    return contour.map((p) => [Number(p[0]), Number(p[1])]);
  }
  // Fillet: nudge face-leg setback verts (r,0)/(0,r) a tiny ε into EMPTY
  // space so they are not exactly on the part faces. Exact on-face verts
  // make Manifold leave long needle fins (wrap playtest: 138→~11). Chamfer
  // keeps exact legs — nudging them, or insetting bumper anchors off the
  // setback, reintroduced visible inward wedges on stacked rim chamfers.
  const isChamfer = contour.length <= 3;
  const faceEps = Math.min(0.0025, Math.max(1e-4, 5e-4 * r));
  const q1 = [];
  for (const p of contour) {
    const u = Number(p[0]);
    const v = Number(p[1]);
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      throw new Error('expandFilletCutterContour: non-finite vertex');
    }
    if (Math.abs(u) < 1e-15 && Math.abs(v) < 1e-15) continue;
    let uu = u;
    let vv = v;
    if (!isChamfer) {
      if (Math.abs(v) < 1e-12 && u > faceEps) vv = -faceEps;
      if (Math.abs(u) < 1e-12 && v > faceEps) uu = -faceEps;
    }
    q1.push([uu, vv]);
  }
  if (q1.length < 2) {
    throw new Error('expandFilletCutterContour: contour collapsed');
  }
  // Rear bumper: Q3 origin + Q4/Q2 strips of thickness e. Q1 stays at r.
  // Bumper-anchor inset (r−δ) clears setback-plane fins on a lone closed
  // wrap but reintroduces visible inward wedges when a chamfer follows on
  // the same part — left disabled; face-leg nudge above is the safe fix.
  const uMax = Math.max(r, ...q1.map((p) => p[0]));
  const vMax = Math.max(r, ...q1.map((p) => p[1]));
  const out = [[-e, -e], [uMax, -e], ...q1, [-e, vMax]];
  if (out.length < 3) {
    throw new Error('expandFilletCutterContour: contour collapsed');
  }
  return out;
}

function _v3(v) {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function _dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Orthonormal cross-section frame for a dihedral fillet/chamfer.
 * N is one in-face direction, B is the in-plane perpendicular toward the
 * other, and (N, B, T) is right-handed so a CCW (u,v) contour extrudes
 * along +T. θ is the interior angle between the in-face rays.
 * prevN, when set, prefers the face that continues the previous segment
 * so a chain does not swap axes at every sample.
 *
 * @param {number[]} T tangent
 * @param {number[]} f0 in-face direction
 * @param {number[]} f1 in-face direction
 * @param {number[]|null} [prevN]
 * @returns {{ N: number[], B: number[], theta: number }}
 */
export function orientFilletFrame(T, f0, f1, prevN = null) {
  let A = _v3(f0);
  let C = _v3(f1);
  if (prevN && _dot3(C, prevN) > _dot3(A, prevN)) {
    const tmp = A;
    A = C;
    C = tmp;
  }
  const Tn = _v3(T);
  let N = A;
  let B = _v3(_cross3(Tn, N));
  if (_dot3(B, C) < 0) {
    N = C;
    B = _v3(_cross3(Tn, N));
    const other = A;
    if (_dot3(B, other) < 0) B = [-B[0], -B[1], -B[2]];
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, _dot3(_v3(f0), _v3(f1)))));
  return { N, B, theta };
}

/**
 * Interior setback along each face for a radius-r fillet of dihedral θ.
 * t = r / tan(θ/2). At 90° this is r.
 * @param {number} radius
 * @param {number} theta radians, (0, π)
 */
export function filletSetback(radius, theta) {
  const r = Number(radius);
  const th = Number(theta);
  if (!(r > 0) || !Number.isFinite(r)) throw new Error('filletSetback: radius must be > 0');
  if (!(th > 0) || !(th < Math.PI) || !Number.isFinite(th)) {
    throw new Error(`filletSetback: face angle ${th} rad is degenerate`);
  }
  return r / Math.tan(th / 2);
}

/**
 * Analytic removed area of a dihedral fillet (per unit length).
 * r·t − ½·r²·(π − θ), with t = r/tan(θ/2). At 90° this is r²(1−π/4).
 * @param {number} radius
 * @param {number} theta
 */
export function filletRemovedArea(radius, theta) {
  const r = Number(radius);
  const th = Number(theta);
  const t = filletSetback(r, th);
  return r * t - 0.5 * r * r * (Math.PI - th);
}

/**
 * Analytic removed area of an equal-leg chamfer (per unit length).
 * ½·c²·sin(θ). At 90° this is ½·c².
 * @param {number} size leg length
 * @param {number} theta
 */
export function chamferRemovedArea(size, theta) {
  const c = Number(size);
  const th = Number(theta);
  if (!(c > 0) || !Number.isFinite(c)) throw new Error('chamferRemovedArea: size must be > 0');
  if (!(th > 0) || !(th < Math.PI) || !Number.isFinite(th)) {
    throw new Error(`chamferRemovedArea: face angle ${th} rad is degenerate`);
  }
  return 0.5 * c * c * Math.sin(th);
}

function _requireDihedral(name, radius, theta) {
  const r = Number(radius);
  const th = Number(theta);
  if (!(r > 0) || !Number.isFinite(r)) throw new Error(`${name}: radius must be > 0`);
  if (!(th > 0.05) || th > Math.PI - 0.05 || !Number.isFinite(th)) {
    throw new Error(`${name}: face angle ${th} rad is degenerate`);
  }
  return { r, th };
}

/**
 * Fillet cutter in orthonormal (u,v): u along one face, +v toward the other.
 * Origin → setback on face 0 → arc (center inset by r) → setback on face 1.
 * At θ = π/2 this matches filletWedgeContour.
 * @param {number} radius
 * @param {number} theta interior angle, radians
 * @param {number} [arcSegments=12]
 * @returns {number[][]}
 */
export function dihedralFilletContour(radius, theta, arcSegments = FILLET_ARC_SEGMENTS) {
  const { r, th } = _requireDihedral('dihedralFilletContour', radius, theta);
  const seg = Math.max(2, Math.round(Number(arcSegments) || FILLET_ARC_SEGMENTS));
  const t = r / Math.tan(th / 2);
  const p1 = [t * Math.cos(th), t * Math.sin(th)];
  const span = Math.PI - th;
  const pts = [[0, 0], [t, 0]];
  for (let i = 1; i <= seg; i++) {
    const phi = -Math.PI / 2 - (i / seg) * span;
    pts.push([t + r * Math.cos(phi), r + r * Math.sin(phi)]);
  }
  pts[pts.length - 1] = p1;
  return pts;
}

/**
 * Equal-leg chamfer triangle for interior angle θ.
 * (0,0) → (c,0) → c·(cos θ, sin θ). At 90° this is chamferWedgeContour.
 * @param {number} size
 * @param {number} theta
 * @returns {number[][]}
 */
export function dihedralChamferContour(size, theta) {
  const { r: c, th } = _requireDihedral('dihedralChamferContour', size, theta);
  return [[0, 0], [c, 0], [c * Math.cos(th), c * Math.sin(th)]];
}

/**
 * Exterior bumper for a dihedral wedge so cutter legs are not coincident
 * with the faces. At θ = π/2 this matches expandFilletCutterContour
 * (rear corner (−e,−e), strips (leg,−e) and (−e,leg)).
 * Contour must be origin, face-0 point, …, face-1 point.
 * @param {number[][]} contour
 * @param {number} radius
 * @param {number} theta
 * @returns {number[][]}
 */
export function expandDihedralCutterContour(contour, radius, theta) {
  if (!Array.isArray(contour) || contour.length < 3) {
    throw new Error('expandDihedralCutterContour: need a wedge (≥3 pts)');
  }
  const { r, th } = _requireDihedral('expandDihedralCutterContour', radius, theta);
  const e = filletSweepCutterExpand(r);
  if (!(e > 0)) {
    return contour.map((p) => [Number(p[0]), Number(p[1])]);
  }
  const p0 = contour[1];
  const p1 = contour[contour.length - 1];
  const u0 = Number(p0[0]);
  const v0 = Number(p0[1]);
  const u1 = Number(p1[0]);
  const v1 = Number(p1[1]);
  if (![u0, v0, u1, v1].every(Number.isFinite)) {
    throw new Error('expandDihedralCutterContour: non-finite vertex');
  }
  const cot = 1 / Math.tan(th / 2);
  const sin = Math.sin(th);
  const cos = Math.cos(th);
  const exterior = [-e * cot, -e];
  const face0Out = [u0, -e];
  const face1Out = [u1 + e * (-sin), v1 + e * cos];
  // Fillet: nudge face-ray setback endpoints into empty space (same as
  // expandFilletCutterContour). Chamfer keeps historical on-face legs.
  const isChamfer = contour.length <= 3;
  const faceEps = Math.min(0.0025, Math.max(1e-4, 5e-4 * r));
  const nFace0 = [0, -1];
  const nFace1 = [-sin, cos];
  const q1 = [];
  for (let i = 1; i < contour.length; i++) {
    let u = Number(contour[i][0]);
    let v = Number(contour[i][1]);
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      throw new Error('expandDihedralCutterContour: non-finite vertex');
    }
    if (!isChamfer) {
      const d0 = Math.abs(v);
      const d1 = Math.abs(u * sin - v * cos);
      if (d0 < 1e-12) {
        u += faceEps * nFace0[0];
        v += faceEps * nFace0[1];
      } else if (d1 < 1e-12) {
        u += faceEps * nFace1[0];
        v += faceEps * nFace1[1];
      }
    }
    q1.push([u, v]);
  }
  return [exterior, face0Out, ...q1, face1Out];
}

/**
 * Tube mesh over a sequence of rings that all carry the SAME vertex count.
 *
 * This is the varying-cross-section sweep (C3.3): unlike extrude+warp, which
 * can only reorient ONE fixed profile, each ring may be a different profile —
 * so a dihedral that ramps along the path (loft ridge: 161° at the smooth end,
 * 93° at the corner) gets its own correct wedge at every knot.
 *
 * Rings must be ordered along +T and each wound CCW about +T (the winding
 * `_s23DihedralContour` / `expandDihedralCutterContour` already produce in the
 * (N, B) basis), or the tube comes out inside-out.
 *
 * Caps are a triangle fan from vertex 0. That is valid for every θ because the
 * cutter section is a convex wedge minus a convex disk bite, and vertex 0 is
 * the rear bumper corner, which lies outside that disk — so the section is
 * star-shaped from it and no fan triangle can escape the region.
 *
 * Pure — no Manifold. Caller feeds the arrays to _meshDataToManifold.
 *
 * @param {number[][][]} rings  [ring][vertex][x,y,z]
 * @param {boolean} [closed]    wrap the last ring back to the first (no caps)
 * @returns {{ vertProperties: number[], triVerts: number[] }}
 */
export function varyingProfileTubeMesh(rings, closed = false) {
  if (!Array.isArray(rings) || rings.length < 2) {
    throw new Error('varyingProfileTubeMesh: need ≥ 2 rings');
  }
  const m = rings.length;
  const K = Array.isArray(rings[0]) ? rings[0].length : 0;
  if (!(K >= 3)) {
    throw new Error('varyingProfileTubeMesh: rings need ≥ 3 vertices');
  }
  const vertProperties = [];
  for (let i = 0; i < m; i++) {
    const ring = rings[i];
    if (!Array.isArray(ring) || ring.length !== K) {
      throw new Error(
        `varyingProfileTubeMesh: ring ${i} has ${ring ? ring.length : 0} vertices, expected ${K} `
        + '— every profile must tessellate identically or the rings cannot be stitched',
      );
    }
    for (let k = 0; k < K; k++) {
      const p = ring[k];
      const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`varyingProfileTubeMesh: ring ${i} vertex ${k} is non-finite`);
      }
      vertProperties.push(x, y, z);
    }
  }
  const triVerts = [];
  const spans = closed ? m : m - 1;
  for (let i = 0; i < spans; i++) {
    const a = i * K;
    const b = ((i + 1) % m) * K;
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      // Outward with CCW-about-+T rings advancing along +T.
      triVerts.push(a + k, a + k1, b + k1);
      triVerts.push(a + k, b + k1, b + k);
    }
  }
  if (!closed) {
    const last = (m - 1) * K;
    for (let k = 1; k < K - 1; k++) {
      triVerts.push(0, k + 1, k);                    // start cap faces −T
      triVerts.push(last, last + k, last + k + 1);   // end cap faces +T
    }
  }
  return { vertProperties, triVerts };
}

/**
 * Circle through three non-colinear points.
 * @returns {{ C: number[], R: number, n: number[] } | null}
 */
export function circFit3(p0, p1, p2) {
  const A = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const B = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const n = [
    A[1] * B[2] - A[2] * B[1],
    A[2] * B[0] - A[0] * B[2],
    A[0] * B[1] - A[1] * B[0],
  ];
  const nL = Math.hypot(n[0], n[1], n[2]);
  if (nL < 1e-14) return null;
  const mid1 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
  const mid2 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
  const d1 = [
    A[1] * n[2] - A[2] * n[1],
    A[2] * n[0] - A[0] * n[2],
    A[0] * n[1] - A[1] * n[0],
  ];
  const Bv = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const d2 = [
    Bv[1] * n[2] - Bv[2] * n[1],
    Bv[2] * n[0] - Bv[0] * n[2],
    Bv[0] * n[1] - Bv[1] * n[0],
  ];
  const rhs = [mid2[0] - mid1[0], mid2[1] - mid1[1], mid2[2] - mid1[2]];
  const rhsxd2 = [
    rhs[1] * d2[2] - rhs[2] * d2[1],
    rhs[2] * d2[0] - rhs[0] * d2[2],
    rhs[0] * d2[1] - rhs[1] * d2[0],
  ];
  const d1xd2 = [
    d1[1] * d2[2] - d1[2] * d2[1],
    d1[2] * d2[0] - d1[0] * d2[2],
    d1[0] * d2[1] - d1[1] * d2[0],
  ];
  const denom = d1xd2[0] * n[0] + d1xd2[1] * n[1] + d1xd2[2] * n[2];
  if (Math.abs(denom) < 1e-14) return null;
  const s = (rhsxd2[0] * n[0] + rhsxd2[1] * n[1] + rhsxd2[2] * n[2]) / denom;
  const C = [mid1[0] + s * d1[0], mid1[1] + s * d1[1], mid1[2] + s * d1[2]];
  const R = Math.hypot(C[0] - p0[0], C[1] - p0[1], C[2] - p0[2]);
  if (!(R > 1e-12) || !Number.isFinite(R)) return null;
  return { C, R, n: [n[0] / nL, n[1] / nL, n[2] / nL] };
}

function _dst(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _ddot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _dcross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function _dlen(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
function _dnorm(a) {
  const L = _dlen(a) || 1;
  return [a[0] / L, a[1] / L, a[2] / L];
}

/** Turn at b between chords a→b and b→c. ang in radians, axis = t0×t1. */
function _turnAt(a, b, c) {
  const t0 = _dnorm(_dst(b, a));
  const t1 = _dnorm(_dst(c, b));
  const cr = _dcross(t0, t1);
  const s = _dlen(cr);
  const ang = Math.atan2(s, _ddot(t0, t1));
  if (!(ang > 1e-8) || s < 1e-12) return { ang: 0, axis: null };
  return { ang, axis: [cr[0] / s, cr[1] / s, cr[2] / s] };
}

/**
 * Resample consistent circular-arc spans so consecutive chords turn by at
 * most `maxTurnDeg`. Sharp corners (one kink, straight neighbors) and long
 * straights are copied unchanged — this must not round a cube edge or
 * dust a straight into extra sweep seams.
 *
 * Colinear midpoint insertion (densifyPathByMaxTurn) cannot shrink the turn
 * at an existing vertex. Points already on the arc are rebuilt along the
 * fitted circle at chord ≤ sweepPathMaxChordForTurn(R).
 *
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {number} [maxTurnDeg=5]
 * @param {{ alignFilletLattice?: boolean }} [opts]
 *   alignFilletLattice (default true): a ~90° arc whose samples already sit
 *   on the FILLET_ARC_SEGMENTS lattice is filled on that phase, so a later
 *   fillet meets the earlier one's rulings. false keeps the plain ≤maxTurn
 *   resample (chamfer sweeps — lattice fill regresses sliver counts).
 * @returns {number[][]}
 */
export function densifySweepArcTurns(points, closed, maxTurnDeg = 5, opts = {}) {
  return _densifySweepArcTurns(points, !!closed, maxTurnDeg, false, opts || {});
}

function _densifySweepArcTurns(points, isClosed, maxTurnDeg, rotated, opts) {
  if (!Array.isArray(points) || points.length < 3) {
    return points ? points.map((p) => p.slice()) : [];
  }
  const lim = Math.max(1, Number(maxTurnDeg) || 5) * Math.PI / 180;
  const n = points.length;
  const info = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!isClosed && (i === 0 || i === n - 1)) {
      info[i] = { ang: 0, axis: null };
      continue;
    }
    info[i] = _turnAt(points[(i - 1 + n) % n], points[i], points[(i + 1) % n]);
  }
  const segLen = new Array(n).fill(0);
  const segN = isClosed ? n : n - 1;
  for (let i = 0; i < segN; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    segLen[i] = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  // Tessellation step, not a designed corner. 90° rectangle corners are
  // concyclic — rebuilding them would turn the path into a circle. 60° hex
  // corners stay corners. ~11° thinned fillet arcs (and coarse rims up to
  // ~50°) are eligible.
  const stepCap = 50 * Math.PI / 180;
  const neigh = (i, j) => {
    if (!isClosed && (j <= 0 || j >= n - 1)) return false;
    if (!(info[j].ang > lim * 0.35) || info[j].ang > stepCap) return false;
    if (!info[i].axis || !info[j].axis) return false;
    return _ddot(info[i].axis, info[j].axis) > 0.5;
  };
  // Long straight vs short arc chord: the junction vertex must not glue
  // separate corner arcs into one loop (rounded-rect perimeter).
  const chordsSimilar = (i) => {
    const prev = (i - 1 + n) % n;
    const l0 = segLen[prev];
    const l1 = segLen[i];
    if (!(l0 > 1e-9) || !(l1 > 1e-9)) return false;
    const ratio = Math.max(l0, l1) / Math.min(l0, l1);
    return ratio <= 2.5;
  };
  const arc = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (!(info[i].ang > lim) || info[i].ang > stepCap) continue;
    if (!chordsSimilar(i)) continue;
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    if (neigh(i, prev) || neigh(i, next)) arc[i] = true;
  }
  if (!arc.some(Boolean)) return points.map((p) => p.slice());

  // Closed paths have no distinguished start. Spin so a straight vertex is
  // index 0 and every arc span is a linear slice (no wrap bookkeeping).
  if (isClosed && !rotated && !arc.every(Boolean)) {
    const origin = arc.findIndex((v) => !v);
    if (origin > 0) {
      const spun = points.slice(origin).concat(points.slice(0, origin));
      return _densifySweepArcTurns(spun, true, maxTurnDeg, true, opts);
    }
  }

  const runs = [];
  if (arc.every(Boolean)) {
    runs.push({ full: true, idxs: [...Array(n).keys()] });
  } else {
    for (let i = 0; i < n; i++) {
      if (!arc[i]) continue;
      const idxs = [i];
      let j = i + 1;
      while (j < n && arc[j]) {
        idxs.push(j);
        j++;
      }
      i = j - 1;
      runs.push({ full: false, idxs });
    }
  }

  function resample(seq, fullLoop) {
    if (seq.length < 3) return null;
    const mid = seq[Math.floor(seq.length / 2)];
    const fit = circFit3(seq[0], mid, seq[seq.length - 1]);
    if (!fit) return null;
    const { C, R } = fit;
    const nn = fit.n;
    const tol = Math.max(0.35, 0.06 * R);
    for (const p of seq) {
      const d = Math.hypot(p[0] - C[0], p[1] - C[1], p[2] - C[2]);
      if (Math.abs(d - R) > tol) return null;
    }
    const tmp = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const x = _dnorm(_dcross(tmp, nn));
    const y = _dcross(nn, x);
    const angOf = (p) => {
      const v = _dst(p, C);
      return Math.atan2(_ddot(v, y), _ddot(v, x));
    };
    const src = fullLoop ? seq.concat([seq[0]]) : seq;
    const angles = src.map(angOf);
    for (let i = 1; i < angles.length; i++) {
      let a = angles[i];
      while (a - angles[i - 1] > Math.PI) a -= 2 * Math.PI;
      while (angles[i - 1] - a > Math.PI) a += 2 * Math.PI;
      angles[i] = a;
    }
    let dir = 0;
    for (let i = 1; i < angles.length; i++) {
      const dlt = angles[i] - angles[i - 1];
      if (Math.abs(dlt) < 1e-8) continue;
      const s = Math.sign(dlt);
      if (!dir) dir = s;
      else if (s !== dir) return null;
    }
    const sweep = angles[angles.length - 1] - angles[0];
    if (!(Math.abs(sweep) > lim)) return null;
    const chord = sweepPathMaxChordForTurn(R, (lim * 180) / Math.PI);
    const nAng = Math.max(1, Math.ceil(Math.abs(sweep) / lim - 1e-9));
    const arcLen = Math.abs(sweep) * R;
    const nCh = chord > 1e-9 ? Math.max(1, Math.ceil(arcLen / chord - 1e-9)) : nAng;
    const steps = Math.max(nAng, nCh);
    const atOn = (CC, RR, xx, yy, a) => {
      const c = Math.cos(a);
      const sn = Math.sin(a);
      return [
        CC[0] + RR * (c * xx[0] + sn * yy[0]),
        CC[1] + RR * (c * xx[1] + sn * yy[1]),
        CC[2] + RR * (c * xx[2] + sn * yy[2]),
      ];
    };
    // A prior fillet's quarter-arc is already sampled on the profile lattice
    // (FILLET_ARC_SEGMENTS over 90°, 3.75° at 24). Equal 5° chords of that
    // span fall BETWEEN those rulings, so the later corner's rings cross the
    // earlier fillet instead of meeting it on shared lines — a stray triangle
    // on the inside after the shell. When the input samples already share
    // that lattice, fill the quarter on the same phase (still ≤ lim). Other
    // arcs, including a quarter that is not a prior fillet, keep the ≤lim
    // chord resample. Endpoints stay put (face-epsilon nudge).
    let out = null;
    const QUARTER = Math.PI / 2;
    // Chamfer-along-fillet keeps the 5° chord resample. Filling the fillet
    // lattice there blew zero-area counts past the sliver gate (rounded-wrap
    // chamfer, box-stack bottom). Fillet sweeps want the shared rulings.
    const alignLattice = !opts || opts.alignFilletLattice !== false;
    if (alignLattice && Math.abs(Math.abs(sweep) - QUARTER) <= 4 * Math.PI / 180 && seq.length >= 5) {
      const step = QUARTER / FILLET_ARC_SEGMENTS;
      const fit2 = circFit3(seq[1], seq[Math.floor(seq.length / 2)], seq[seq.length - 2]);
      if (fit2 && step <= lim + 1e-9 && Math.abs(fit2.R - R) <= Math.max(0.05, 0.02 * R)) {
        let n2 = fit2.n;
        if (_ddot(n2, nn) < 0) n2 = [-n2[0], -n2[1], -n2[2]];
        const tmp2 = Math.abs(n2[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const x2 = _dnorm(_dcross(tmp2, n2));
        const y2 = _dcross(n2, x2);
        const angOf2 = (p) => {
          const v = _dst(p, fit2.C);
          return Math.atan2(_ddot(v, y2), _ddot(v, x2));
        };
        const src2 = fullLoop ? seq.concat([seq[0]]) : seq;
        const ang = src2.map(angOf2);
        let monotonic = true;
        for (let i = 1; i < ang.length; i++) {
          let a = ang[i];
          while (a - ang[i - 1] > Math.PI) a -= 2 * Math.PI;
          while (ang[i - 1] - a > Math.PI) a += 2 * Math.PI;
          ang[i] = a;
          if (Math.sign(ang[i] - ang[i - 1]) && Math.sign(ang[i] - ang[i - 1]) !== dir) monotonic = false;
        }
        const a0 = ang[0];
        const a1 = ang[ang.length - 1];
        const phases = [];
        for (let i = 1; i < ang.length - 1; i++) {
          let ph = ang[i] % step;
          if (ph < 0) ph += step;
          phases.push(ph);
        }
        phases.sort((p, q) => p - q);
        let phase = phases.length ? phases[phases.length >> 1] : 0;
        let spread = phases.length ? phases[phases.length - 1] - phases[0] : 0;
        if (phases.length >= 2 && spread > step * 0.5) {
          const wrapped = phases.map((ph) => (ph > step * 0.5 ? ph - step : ph));
          wrapped.sort((p, q) => p - q);
          phase = wrapped[wrapped.length >> 1];
          spread = wrapped[wrapped.length - 1] - wrapped[0];
        }
        // Only a lattice the input already sits on. A foreign phase would
        // move knots off a quarter that was not this fillet's rulings.
        if (monotonic && spread <= step * 0.15) {
          const lo = Math.min(a0, a1);
          const hi = Math.max(a0, a1);
          const grid = [];
          const base = Math.floor(lo / step) * step + (phase >= 0 ? phase : phase + step);
          for (let a = base - 2 * step; a < hi + 2 * step; a += step) {
            if (a > lo + 1e-4 && a < hi - 1e-4) grid.push(a);
          }
          grid.sort((p, q) => (a1 >= a0 ? p - q : q - p));
          const seqA = [a0, ...grid, a1];
          let spaced = grid.length > 0;
          for (let i = 1; i < seqA.length; i++) {
            if (Math.abs(seqA[i] - seqA[i - 1]) > lim + 1e-4) spaced = false;
          }
          if (spaced) out = seqA.map((a) => atOn(fit2.C, fit2.R, x2, y2, a));
        }
      }
    }
    if (!out) {
      out = [];
      for (let k = 0; k <= steps; k++) {
        out.push(atOn(C, R, x, y, angles[0] + sweep * (k / steps)));
      }
    }
    out[0] = seq[0].slice();
    if (fullLoop) out.pop();
    else out[out.length - 1] = seq[seq.length - 1].slice();
    if (out.length <= seq.length) return null;
    return out;
  }

  if (runs.length === 1 && runs[0].full) {
    const pts = resample(points, true);
    return pts || points.map((p) => p.slice());
  }

  const byStart = new Map();
  for (const run of runs) {
    let idxs = run.idxs.slice();
    const seq0 = idxs.map((i) => points[i]);
    const fit0 = circFit3(seq0[0], seq0[Math.floor(seq0.length / 2)], seq0[seq0.length - 1]);
    if (fit0) {
      const onCirc = (p) => {
        const d = Math.hypot(p[0] - fit0.C[0], p[1] - fit0.C[1], p[2] - fit0.C[2]);
        return Math.abs(d - fit0.R) <= Math.max(0.35, 0.06 * fit0.R);
      };
      let prev = idxs[0] - 1;
      let next = idxs[idxs.length - 1] + 1;
      if (isClosed) {
        if (prev < 0) prev = n - 1;
        if (next >= n) next = 0;
      }
      if (prev >= 0 && prev < n && !idxs.includes(prev) && onCirc(points[prev])) {
        idxs = [prev, ...idxs];
      }
      if (next >= 0 && next < n && !idxs.includes(next) && onCirc(points[next])) {
        idxs = [...idxs, next];
      }
    }
    if (idxs.length < 3) continue;
    const pts = resample(idxs.map((i) => points[i]), false);
    if (!pts) continue;
    byStart.set(idxs[0], { start: idxs[0], end: idxs[idxs.length - 1], pts });
  }
  if (!byStart.size) return points.map((p) => p.slice());

  // A closed arc that ends on index 0 is emitted at the tail; don't also
  // copy point 0 at the head (that chord is the close of the loop).
  let i0 = 0;
  for (const rep of byStart.values()) {
    if (rep.end === 0 && rep.start > 0) i0 = 1;
  }
  const out = [];
  for (let i = i0; i < n;) {
    const rep = byStart.get(i);
    if (!rep) {
      out.push(points[i].slice());
      i++;
      continue;
    }
    const prev = out.length ? out[out.length - 1] : null;
    const p0 = rep.pts[0];
    const dup = prev && Math.hypot(prev[0] - p0[0], prev[1] - p0[1], prev[2] - p0[2]) < 1e-6;
    const chunk = dup ? rep.pts.slice(1) : rep.pts;
    for (const q of chunk) out.push(q);
    i = rep.end >= i ? rep.end + 1 : n;
  }
  return out.length >= 2 ? out : points.map((p) => p.slice());
}

/**
 * Find corner-arc spans on a sweep path (curved runs bounded by straights).
 *
 * Continuous sweeps over path arcs have degenerate start/end conditions
 * (cusp leftovers). Callers split each site into two semi-arc polylines and
 * subtract those cutters independently (`splitSameRadiusArcsIntoSemiArcRuns`
 * / `planFilletSweepPath`).
 *
 * Detects both same-r fillet-on-fillet (path R ≈ cutter r) and
 * chamfer-along-prior-fillet (path R ≠ cutter r). Uniform closed all-arc
 * rims are omitted (whole-path cover) so the planner keeps them `as-is`.
 *
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {number} radius — cutter radius (O inset; optional same-r filter)
 * @param {object} [opts]
 * @param {number} [opts.tol=0.25] — relative |R − R_med| / R_med consistency
 * @param {number} [opts.minVerts=3] — minimum consistent-arc vertices per site
 * @param {boolean} [opts.matchCutterRadius=false] — also require |R_med − r|/r ≤ tol
 * @param {boolean} [opts.splitTighterArcs=false] — with matchCutterRadius, also keep R_med < r
 * @returns {Array<{ C: number[], R: number, n: number[], A: number[], B: number[], O: number[], P: number[], idxs: number[] }>}
 */
export function detectSameRadiusArcSites(points, closed, radius, opts = {}) {
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r) || !Array.isArray(points) || points.length < 3) {
    return [];
  }
  const tol = opts.tol != null ? Number(opts.tol) : 0.25;
  const minVerts = opts.minVerts != null ? Math.max(2, opts.minVerts | 0) : 3;
  const matchCutter = opts.matchCutterRadius === true;
  // With matchCutterRadius: also keep arcs tighter than the cutter (R < r).
  const tighter = opts.splitTighterArcs === true;
  const n = points.length;
  const isCurved = (R) => Number.isFinite(R) && R > 1e-12;
  const nearMed = (R, med) => Number.isFinite(R) && Number.isFinite(med) && med > 0
    && Math.abs(R - med) <= tol * med;
  const compatible = (Ra, Rb) => isCurved(Ra) && isCurved(Rb)
    && Math.abs(Ra - Rb) <= tol * Math.max(Ra, Rb);

  const localR = new Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const i0 = closed ? (i - 1 + n) % n : i - 1;
    const i2 = closed ? (i + 1) % n : i + 1;
    if (i0 < 0 || i2 >= n) continue;
    const fit = circFit3(points[i0], points[i], points[i2]);
    if (fit) localR[i] = fit.R;
  }

  // Path centroid — used to pick plane-normal sign (outward = away from centroid).
  let cx = 0, cy = 0, cz = 0;
  for (const p of points) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= n; cy /= n; cz /= n;

  // Contiguous same-R curved runs (relative-R gate splits arc from near-straight
  // junction fits). Merge wrap-around for closed when end runs agree on R.
  const runs = [];
  let cur = [];
  for (let i = 0; i < n; i++) {
    const R = localR[i];
    if (!isCurved(R)) {
      if (cur.length) { runs.push(cur); cur = []; }
      continue;
    }
    if (!cur.length) { cur = [i]; continue; }
    if (compatible(localR[cur[cur.length - 1]], R)) cur.push(i);
    else { runs.push(cur); cur = [i]; }
  }
  if (cur.length) runs.push(cur);
  if (closed && runs.length >= 2) {
    const head = runs[0];
    const tail = runs[runs.length - 1];
    if (head[0] === 0 && tail[tail.length - 1] === n - 1
        && compatible(localR[tail[tail.length - 1]], localR[head[0]])) {
      runs[0] = tail.concat(head);
      runs.pop();
    }
  }

  const sites = [];
  for (const rawIdxs of runs) {
    if (rawIdxs.length < minVerts) continue;
    const sortedR = rawIdxs.map((i) => localR[i]).filter(isCurved).sort((a, b) => a - b);
    if (sortedR.length < minVerts) continue;
    const med = sortedR[Math.floor(sortedR.length / 2)];
    if (!(med > 0) || !Number.isFinite(med)) continue;
    if (matchCutter && Math.abs(med - r) > tol * r && !(tighter && med < r)) continue;
    const idxs = rawIdxs.filter((i) => nearMed(localR[i], med));
    if (idxs.length < minVerts) continue;
    // Uniform all-arc rim: whole path is one arc → leave as-is.
    if (idxs.length >= n) continue;
    const iA = closed ? (idxs[0] - 1 + n) % n : Math.max(0, idxs[0] - 1);
    const iB = closed ? (idxs[idxs.length - 1] + 1) % n : Math.min(n - 1, idxs[idxs.length - 1] + 1);
    const A = points[iA];
    const B = points[iB];
    const mid = points[idxs[Math.floor(idxs.length / 2)]];
    const fit = circFit3(A, mid, B);
    if (!fit || !nearMed(fit.R, med)) continue;
    let nx = fit.n[0], ny = fit.n[1], nz = fit.n[2];
    const away = (fit.C[0] - cx) * nx + (fit.C[1] - cy) * ny + (fit.C[2] - cz) * nz;
    if (away < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const O = [fit.C[0] - r * nx, fit.C[1] - r * ny, fit.C[2] - r * nz];
    const P = [
      A[0] + B[0] - fit.C[0],
      A[1] + B[1] - fit.C[1],
      A[2] + B[2] - fit.C[2],
    ];
    sites.push({
      C: fit.C, R: fit.R, n: [nx, ny, nz], A, B, O, P, idxs: idxs.slice(),
    });
  }
  return sites;
}

export function splitSameRadiusArcsIntoSemiArcRuns(points, closed, radius, opts = {}) {
  const sites = detectSameRadiusArcSites(points, closed, radius, opts);
  if (!sites.length || !Array.isArray(points) || points.length < 2) return null;
  const arcsOnly = !!opts.arcsOnly;
  const n = points.length;
  const mark = new Array(n).fill(-1);
  for (let si = 0; si < sites.length; si++) {
    const idxs = sites[si].idxs;
    if (!Array.isArray(idxs)) continue;
    for (const i of idxs) {
      if (i >= 0 && i < n) mark[i] = si;
    }
  }
  let start = 0;
  if (closed) {
    for (let i = 0; i < n; i++) {
      if (mark[i] < 0) { start = i; break; }
    }
  }
  const at = (k) => (closed ? (start + k) % n : k);
  const walkN = closed ? n : n;
  const spans = [];
  let k = 0;
  while (k < walkN) {
    const idx = at(k);
    const m = mark[idx];
    const idxs = [idx];
    k += 1;
    while (k < walkN && mark[at(k)] === m) {
      idxs.push(at(k));
      k += 1;
    }
    spans.push({ site: m, idxs });
  }
  if (closed && spans.length >= 2 && spans[0].site < 0 && spans[spans.length - 1].site < 0) {
    spans[0].idxs = spans[spans.length - 1].idxs.concat(spans[0].idxs);
    spans.pop();
  }

  const pt = (i) => points[i].slice();
  const dedup = (arr) => {
    const out = [];
    for (const i of arr) {
      if (!out.length || out[out.length - 1] !== i) out.push(i);
    }
    return out;
  };
  const runs = [];
  for (const sp of spans) {
    if (sp.site < 0) {
      if (!arcsOnly && sp.idxs.length >= 2) runs.push(sp.idxs.map(pt));
      continue;
    }
    const idxs = sp.idxs;
    if (idxs.length < 2) continue;
    const iFirst = idxs[0];
    const iLast = idxs[idxs.length - 1];
    const iA = closed ? (iFirst - 1 + n) % n : Math.max(0, iFirst - 1);
    const iB = closed ? (iLast + 1) % n : Math.min(n - 1, iLast + 1);
    const mid = Math.floor(idxs.length / 2);
    const leftIdx = [];
    if (iA !== idxs[0] && iA !== idxs[mid]) leftIdx.push(iA);
    for (let j = 0; j <= mid; j++) leftIdx.push(idxs[j]);
    const rightIdx = [];
    for (let j = mid; j < idxs.length; j++) rightIdx.push(idxs[j]);
    if (iB !== idxs[idxs.length - 1] && iB !== idxs[mid]) rightIdx.push(iB);
    const L = dedup(leftIdx);
    const R = dedup(rightIdx);
    if (L.length >= 2) runs.push(L.map(pt));
    if (R.length >= 2) runs.push(R.map(pt));
  }
  return runs.length >= 1 ? runs : null;
}
