// src/lib/surfcad/runtime.js
// Script helpers + the sandbox message protocol. The worker entry binds this module.
import Module from '../../../built/manifold.js';
import {
  fastenerClearanceDia,
  fastenerTapDrillDia,
  fastenerMajorDia,
  listFastenerSizes,
  resolveFastenerSize,
} from '../../workers/fastenerSizes.js';
import { isFilletSliverDirty } from '../../utils/filletSliverGuard.js';
import {
  expandFilletCutterContour,
  expandDihedralCutterContour,
  filletSweepCutterExpand,
  planFilletSweepPath,
  densifySweepArcTurns,
  dihedralFilletContour,
  dihedralChamferContour,
  filletRemovedArea,
  chamferRemovedArea,
  orientFilletFrame,
  varyingProfileTubeMesh,
  FILLET_ARC_SEGMENTS,
} from '../../utils/filletAlongPath.js';
import { densifyPathPoints, buildVariableProfileFrames, maxConsecutiveFrameAngleDeg, countThetaRuns, variableProfileDensifyStep, pathPolylineLength, FRAME_DENSIFY_MAX_TURN_DEG } from '../../utils/edgeTangencyField.js';
import { indexBoundaryEdges } from '../../utils/boundaryEdgeIds.js';
import { assembleSweepPath } from '../../utils/edgeSweepPath.js';
import {
  calibrateScriptLineOffset,
  createFeatureTracker,
  FEATURE_TRACE_ENTER,
  FEATURE_TRACE_LEAVE,
  instrumentFeatureBlocks,
  scriptLineFromStack,
} from '../../utils/featureFailure.js';
import { buildMakeLoftSolid, offsetPlaneFrame } from '../../utils/makeLoft.js';
import { blockSpec, buildBlockManifold } from '../../utils/blockSolid.js';
import { buildSheetMetalSolid } from '../../utils/sheetMetal/sheetSolid.js';
import { installSeparateBodies, overlappingBodies } from '../../workers/separateBodies.js';

/**
 * List of globals to block/remove in the worker context
 */
const BLOCKED_GLOBALS = [
  // Network
  'fetch',
  'XMLHttpRequest', 
  'WebSocket',
  'EventSource',
  
  // Storage
  'indexedDB',
  'caches',
  
  // Workers (prevent spawning nested workers)
  'Worker',
  'SharedWorker',
  
  // Messaging that could leak data
  'BroadcastChannel',
  
  // Import (dynamic) - We load Manifold before blocking
  'importScripts',
];

/**
 * Globals to make read-only proxies (allow reading but not as escape vectors)
 */
const READONLY_GLOBALS = [
  'navigator',
  'location',
  'performance',
];

let manifoldModule = null;
let isInitialized = false;
let cachedManifold = null;
// Nonce of the execute that last wrote cachedManifold (game compare staleness).
let cachedExecuteNonce = null;
// Live ghost target for game-mode match (independent cloned handle retained
// across attempt executes — not an alias of cachedManifold).
let gameTargetManifold = null;
// Snapshot of the attempt solid at the execute that ran while a ghost was set.
// compareGameMatch grades this — never ambient cachedManifold.
let gameAttemptManifold = null;

/** Best-effort Manifold.dispose (embind .delete); ignore missing/throws. */
function _safeDeleteManifold(m) {
  if (!m) return;
  try {
    if (typeof m.delete === 'function') m.delete();
  } catch (_) { /* already freed or non-embind */ }
}

/** Finite and > 0, else fallback (for relEps / volFloor). */
function _positiveFinite(v, fallback) {
  return (Number.isFinite(v) && v > 0) ? v : fallback;
}

// ============================================================================
// EXTENDED MANIFOLD HELPERS
// These functions are injected into the script execution scope
// ============================================================================

// ---------------------------------------------------------------- status
// Build-tolerant Manifold status probe -- the single source of truth for
// "is this manifold valid". The two builds in use report status() in
// DIFFERENT shapes, and both must work:
//   * npm `manifold-3d` (harness/CI)  -> the string 'NoError'
//   * bundled `built/manifold.js` (the browser worker) -> an enum object
//     whose .value is 0 for valid and nonzero for an error (11 = degenerate)
// So comparing status() against the string 'NoError' inline throws on EVERY
// valid manifold in the browser while passing in the harness -- the exact C8
// bug class. Never inline a status comparison again; call this.
// Returns null when valid (or when the status shape is unknown to this
// build -- callers keep their volume() floor checks), else a printable label.
function _c4StatusError(m) {
  if (!m || typeof m.status !== 'function') return 'not a manifold';
  const s = m.status();
  if (typeof s === 'string') return s === 'NoError' ? null : s;
  if (s && typeof s.value === 'number') return s.value === 0 ? null : `code ${s.value}`;
  return null;
}

/** Slice-01: fail loudly on bad numeric args (never silently produce empty/non-manifold). */
function _c4RequirePositive(fn, label, val) {
  if (typeof val !== 'number' || !Number.isFinite(val) || !(val > 0)) {
    throw new Error(`${fn}: ${label} must be a finite number > 0 (got ${val})`);
  }
}

/** Status + empty-volume guard shared by feature cutters. */
function _c4RequireValidSolid(out, fn) {
  const se = _c4StatusError(out);
  if (se) throw new Error(`${fn}: bad result (${se})`);
  if (typeof out.volume === 'function' && out.volume() <= 1e-9) {
    throw new Error(`${fn}: result is EMPTY (volume 0) — cutter consumed the solid or inputs were degenerate`);
  }
  return out;
}

/**
 * Helper to compute uniform scale ratio based on min perpendicular dimension
 *
 * LEGACY: this is the math the pre-uniform-wall `shell()` used. Kept because it
 * is part of HELPER_FUNCTIONS (user scripts may call it), but nothing in this
 * module uses it any more — a uniform SCALE cannot produce a uniform WALL:
 * scaling a 60x20 box by one ratio leaves a 3x thicker wall on the long axis
 * than on the short one. See `shell()` for the offset-based replacement.
 */
function getScaleRatio(manifold, axis, thickness) {
  const bbox = manifold.boundingBox();
  const minPt = bbox.min;
  const maxPt = bbox.max;
  const sizes = [
    maxPt[0] - minPt[0],
    maxPt[1] - minPt[1],
    maxPt[2] - minPt[2]
  ];
  const perpAxes = [0, 1, 2].filter(i => i !== axis);
  const minPerpSize = Math.min(sizes[perpAxes[0]], sizes[perpAxes[1]]);
  if (minPerpSize <= 2 * thickness) {
    throw new Error('Shell thickness too large for object dimensions');
  }
  return (minPerpSize - 2 * thickness) / minPerpSize;
}

// ============================================================================
// SHELL / DRAFT — face-driven, uniform wall
// ----------------------------------------------------------------------------
// Both features used to be bounding-box tricks:
//   shell    = scale the solid down by ONE ratio and subtract -> wall thickness
//              differed per axis (a 60x20x20 box got a 2.5mm wall on Y and a
//              7.5mm wall on X), and the "axis" argument was the only way to
//              say where the opening goes.
//   addDraft = taper by scaling every perpendicular coordinate -> the requested
//              angle was only achieved on the SMALLEST perpendicular dimension;
//              every wider wall came out shallower.
// Both are now built from the real face set (c4MeshData) so thickness and angle
// are honoured per face, and both accept a face SELECTION (what the Viewport
// face pick hands over) instead of only an axis letter.
// ============================================================================

const _C4_SIDE_FACE_COS = Math.cos((25 * Math.PI) / 180); // |n·pull| above this = cap, not side

/** 'z' | '+z' | '-y' | [x,y,z] | {normal} -> unit vector. */
function _c4DirVec(spec, label = 'direction') {
  if (Array.isArray(spec) && spec.length === 3 && spec.every((n) => typeof n === 'number')) {
    if (_c4Len(spec) < 1e-12) throw new Error(`${label}: zero-length vector`);
    return _c4Norm(spec);
  }
  if (spec && typeof spec === 'object' && Array.isArray(spec.normal)) return _c4Norm(spec.normal);
  if (typeof spec === 'string') {
    const s = spec.trim().toLowerCase();
    const sign = s.startsWith('-') ? -1 : 1;
    const ax = { x: 0, y: 1, z: 2 }[s.replace(/^[+-]/, '')];
    if (ax === undefined) {
      throw new Error(`${label}: expected 'x'|'y'|'z' (optionally signed) or [x,y,z], got '${spec}'`);
    }
    const v = [0, 0, 0];
    v[ax] = sign;
    return v;
  }
  throw new Error(`${label}: expected 'x'|'y'|'z', a signed axis like '-z', or [x,y,z]`);
}

/** Unique vertex indices of a face, in first-seen order. */
function _c4FaceVertIndices(md, face) {
  const seen = new Set();
  const out = [];
  for (const t of face.tris) {
    for (let k = 0; k < 3; k++) {
      const vi = md.T[t * 3 + k];
      if (!seen.has(vi)) { seen.add(vi); out.push(vi); }
    }
  }
  return out;
}

/**
 * Resolve a face SELECTION to a Set of face indices into md.faces.
 *
 * Accepted specs (arrays mix freely):
 *   null | false | 'none' | []      -> {} (nothing)
 *   'all'                           -> every face
 *   'sides'                         -> faces more than 25° off ±opts.pull
 *   'z' | '-z' | [0,0,1]            -> every face whose normal is within tolDeg
 *   a face from facesByNormal()     -> that one face
 *   a Viewport face pick {center, normal} / a PlaneFrame -> the face it names
 *
 * Fails loudly when a named face is not on this body: a silently-empty
 * selection would make shell()/draftFaces() a no-op that looks like a kernel bug.
 */
function _c4ResolveFaceSelection(md, spec, opts = {}) {
  const { tolDeg = 8, label = 'faces', pull = null } = opts;
  const out = new Set();
  const add = (s) => {
    if (s === null || s === undefined || s === false || s === 'none') return;
    if (s === 'all') { md.faces.forEach((_, i) => out.add(i)); return; }
    if (s === 'sides') {
      if (!pull) throw new Error(`${label}: 'sides' needs a pull direction`);
      md.faces.forEach((f, i) => {
        if (Math.abs(_c4Dot(f.normal, pull)) < _C4_SIDE_FACE_COS) out.add(i);
      });
      return;
    }
    if (Array.isArray(s) && !(s.length === 3 && s.every((n) => typeof n === 'number'))) {
      s.forEach(add);
      return;
    }
    // A face object (it carries a center) names ONE face; a bare direction
    // names every face pointing that way.
    const named = s && typeof s === 'object' && Array.isArray(s.center);
    const dir = _c4DirVec(s, label);
    const cosT = Math.cos((tolDeg * Math.PI) / 180);
    const cands = [];
    md.faces.forEach((f, i) => { if (_c4Dot(f.normal, dir) >= cosT) cands.push(i); });
    if (!cands.length) {
      throw new Error(
        `${label}: no face on this body points along [${dir.map((n) => n.toFixed(3))}] `
        + `(within ${tolDeg}°) — re-pick the face after the edit that changed it`,
      );
    }
    if (!named) { cands.forEach((i) => out.add(i)); return; }
    const c = s.center;
    // Distance to the face center crosses bodies: a small face on another
    // body can sit closer to the pick than the center of the face that was
    // actually hit. The pick stays on the body whose surface contains it.
    let best = null;
    for (const i of cands) {
      const f = md.faces[i];
      let dist = Infinity;
      const tris = f.tris;
      for (let ti = 0; ti < tris.length; ti++) {
        const t = tris[ti];
        const d = _c4DistPointTri(
          c,
          md.V[md.T[t * 3]],
          md.V[md.T[t * 3 + 1]],
          md.V[md.T[t * 3 + 2]],
        );
        if (d < dist) dist = d;
      }
      const off = Math.abs(_c4Dot(_c4Sub(c, f.center), f.normal));
      if (!best || dist < best.dist - 1e-4
        || (Math.abs(dist - best.dist) <= 1e-4 && off < best.off - 1e-6)) {
        best = { i, dist, off };
      }
    }
    if (!best) return;
    if (best.dist > 1 && best.off > 1) {
      throw new Error(
        `${label}: the picked face is ${best.off.toFixed(3)}mm off every matching `
        + 'plane on this body — it belongs to an earlier version of the part; re-pick it',
      );
    }
    out.add(best.i);
  };
  add(spec);
  return out;
}

/**
 * Rebuild a Manifold from md's triangles with new vertex positions.
 *
 * NOT `warp()`: getMesh() reports float32 vertices while warp() hands the
 * callback Manifold's own double-precision positions, so keying displacements
 * by coordinate silently missed every vertex whose value is not exact in
 * float32 — a shelled cube came out right and a shelled cylinder came out 0.1mm
 * thick. Going through the mesh keeps positions and indices in lockstep.
 */
function _c4RebuildWithVerts(md, verts, label) {
  const { Manifold, Mesh } = manifoldModule;
  const vp = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    vp[i * 3] = verts[i][0];
    vp[i * 3 + 1] = verts[i][1];
    vp[i * 3 + 2] = verts[i][2];
  }
  const out = new Manifold(new Mesh({
    numProp: 3,
    vertProperties: vp,
    triVerts: new Uint32Array(md.T),
  }));
  const se = _c4StatusError(out);
  if (se) {
    throw new Error(
      `${label}: the offset surface folds in on itself (${se}) — use a smaller value`,
    );
  }
  return out;
}

/** 3x3 solve (Cramer). Returns null when the matrix is effectively singular. */
function _c4Solve3(A, b) {
  const [a0, a1, a2] = A;
  const det = a0[0] * (a1[1] * a2[2] - a1[2] * a2[1])
    - a0[1] * (a1[0] * a2[2] - a1[2] * a2[0])
    + a0[2] * (a1[0] * a2[1] - a1[1] * a2[0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const d = (m) => (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
  const sub = (k) => A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  return [d(sub(0)) / det, d(sub(1)) / det, d(sub(2)) / det];
}

/**
 * The one displacement that satisfies `d·nᵢ = rᵢ` for every plane meeting a
 * vertex, in the least-squares sense. This single solve is what makes both
 * shell walls and draft angles come out right, because it distinguishes
 * "several facets of ONE curved surface" from "several DISTINCT planes":
 *   one plane        -> d = r·n                    (flat wall)
 *   two              -> the intersection of the two moved planes (a box edge
 *                       gives d = -t(n₁+n₂), so the corner is not pinched)
 *   three            -> the corner of three moved planes
 *   many, near-parallel -> their common value, i.e. the smooth-surface answer
 *                       for a sphere, a tessellated cylinder or a lofted wall
 * SUMMING per-face displacements instead would be right for the box corner and
 * badly wrong for the loft — it multiplied a lofted cup's draft by its facet
 * count and collapsed the solid. A small Tikhonov term keeps the 3x3 well
 * conditioned at every rank so one code path covers all of the above.
 *
 * @param {number[][]} normals distinct unit plane normals
 * @param {number[]} rhs signed distance to move each plane along its normal
 * @returns {number[]}
 */
function _c4SolvePlaneMoves(normals, rhs) {
  if (!normals.length) return [0, 0, 0];
  if (normals.length === 1) return _c4Mul(rhs[0], normals[0]);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (let k = 0; k < normals.length; k++) {
    const n = normals[k];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) A[i][j] += n[i] * n[j];
      b[i] += rhs[k] * n[i];
    }
  }
  const lam = 1e-6 * normals.length;
  for (let i = 0; i < 3; i++) A[i][i] += lam;
  const sol = _c4Solve3(A, b);
  if (sol) return sol;
  // Singular even with the regulariser: every normal points the same way, so
  // the average direction and the mean distance are the answer.
  const avg = _c4Norm(normals.reduce(_c4Add, [0, 0, 0]));
  return _c4Mul(rhs.reduce((x, y) => x + y, 0) / rhs.length, avg);
}

/**
 * Append unit direction `n` to `list` unless one within angular tolerance is
 * already there. Default cosTol≈1 (1e-6 component match) keeps draftFaces'
 * sharp-corner behaviour; shell offset passes a looser cosTol so tessellated
 * fillet/cylinder facets collapse to one plane per vertex.
 */
function _c4PushDistinct(list, n, cosTol = null) {
  if (cosTol == null) {
    for (const m of list) {
      if (Math.abs(m[0] - n[0]) < 1e-6 && Math.abs(m[1] - n[1]) < 1e-6 && Math.abs(m[2] - n[2]) < 1e-6) return;
    }
  } else {
    for (const m of list) {
      if (_c4Dot(m, n) >= cosTol) return;
    }
  }
  list.push(n);
}

/**
 * Area-weighted normal clustering for shell offset. Unlike `_c4PushDistinct`
 * (first-wins), a later larger facet in the same ~cosTol cone pulls the
 * representative toward its normal — fillet boolean scraps no longer steal the
 * cluster from the real wall/fillet plane.
 * `list` entries are `{ n:[x,y,z], w:number }`; call `_c4FinalizeClusters`
 * before using them as unit normals.
 */
function _c4PushCluster(list, n, area, cosTol) {
  const w = Math.max(area, 1e-18);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (_c4Dot(c.n, n) >= cosTol) {
      const nw = c.w + w;
      c.n = _c4Norm(_c4Add(_c4Mul(c.w, c.n), _c4Mul(w, n)));
      c.w = nw;
      return;
    }
  }
  list.push({ n: n.slice(), w });
}

function _c4FinalizeClusters(list) {
  return list.map((c) => _c4Norm(c.n));
}

/**
 * Reject an offset/draft that turns the surface inside out.
 *
 * A fold is still a closed mesh, so volume alone does not catch it — but a
 * folded facet has its normal REVERSED. Weigh flips BY AREA and judge the
 * surface as a whole: a dense loft or sweep always has a few slivers that
 * invert under any offset (the boolean absorbs them), while a genuinely
 * over-thick wall or over-steep draft turns the whole surface inside out.
 */
function _c4RequireNoFold(md, out, label, amount, maxFrac = 0.25) {
  let flipped = 0;
  let total = 0;
  for (let t = 0; t < md.numTri; t++) {
    const i0 = md.T[t * 3], i1 = md.T[t * 3 + 1], i2 = md.T[t * 3 + 2];
    const before = _c4Cross(_c4Sub(md.V[i1], md.V[i0]), _c4Sub(md.V[i2], md.V[i0]));
    const a = _c4Len(before);
    if (a < 1e-9) continue; // already degenerate: carries no normal
    total += a;
    const after = _c4Cross(_c4Sub(out[i1], out[i0]), _c4Sub(out[i2], out[i0]));
    if (_c4Dot(before, after) < 0) flipped += a;
  }
  if (total > 0 && flipped / total > maxFrac) {
    throw new Error(
      `${label}: ${amount} is too large for this body — ${Math.round((flipped / total) * 100)}% `
      + 'of the surface folds through itself; use a smaller value',
    );
  }
}

/**
 * Displacement that puts a vertex on the inward offset of every face meeting it.
 * `openNormals` are faces the cavity must break THROUGH: the vertex is pushed
 * out along them by t instead of in, so the cavity pokes past the outer surface
 * and the subtraction opens the face. Several removed faces are solved together
 * (each at +t), not averaged into one push — an averaged push leaves a rib on
 * the edge those faces share.
 *
 * Ill-conditioned multi-plane solves at fillet×planar junctions blow |d| past
 * the orthogonal bound t√N. When residual is high, fall back to a single inward
 * step along the mean of the (hemisphere-filtered) normals — they cannot cancel,
 * so this insets instead of tearing the cavity.
 */
function _c4VertexOffset(closedNormals, openNormals, t) {
  let d = _c4SolvePlaneMoves(closedNormals, closedNormals.map(() => -t));
  if (closedNormals.length) {
    let resid2 = 0;
    for (const n of closedNormals) {
      const e = _c4Dot(d, n) + t;
      resid2 += e * e;
    }
    const resid = Math.sqrt(resid2 / closedNormals.length);
    const dLen = _c4Len(d);
    const softCap = t * Math.sqrt(closedNormals.length) * 1.6;
    if (resid > t * 0.3 || dLen > softCap) {
      const avg = _c4Norm(closedNormals.reduce(_c4Add, [0, 0, 0]));
      d = _c4Mul(-t, avg);
    }
  }
  if (openNormals.length === 1) {
    // One removed face: push out along its normal by t so the cavity
    // overshoots that face and the subtraction opens it.
    d = _c4Add(d, _c4Mul(t, openNormals[0]));
  } else if (openNormals.length > 1) {
    // Two or more removed faces meet here. Averaging their normals into ONE
    // push of length t leaves the shared edge short of both planes (a rib).
    // Solve every removed plane at +t together with the kept-face offsets at
    // -t, so that edge is consumed in one bite.
    const normals = closedNormals.concat(openNormals);
    const rhs = closedNormals.map(() => -t).concat(openNormals.map(() => t));
    const dj = _c4SolvePlaneMoves(normals, rhs);
    let resid2 = 0;
    for (let k = 0; k < normals.length; k++) {
      const e = _c4Dot(dj, normals[k]) - rhs[k];
      resid2 += e * e;
    }
    const resid = Math.sqrt(resid2 / normals.length);
    const dLen = _c4Len(dj);
    const softCap = t * Math.sqrt(normals.length) * 1.6;
    if (!Number.isFinite(dLen) || resid > t * 0.3 || dLen > softCap) {
      // Ill-conditioned (opposite openings, scrap normals). Still clear each
      // removed plane by a full t — do not fall back to the short bisector.
      for (const n of openNormals) d = _c4Add(d, _c4Mul(t, n));
    } else {
      d = dj;
    }
  }
  return d;
}

/**
 * The CAVITY of a uniform-thickness shell: the whole boundary offset inward by
 * `thickness`, as one warp of the solid (O(vertices), no per-facet booleans).
 *
 * Faces in `openSet` are pushed OUT instead of in, so the cavity overshoots the
 * outer surface there and subtracting it opens that face.
 *
 * Why not prisms: sweeping each facet inward and unioning is exact, but a
 * lofted wall is tens of thousands of facets — the default Solo Cup script took
 * 83s and produced a 968k-triangle skin. This keeps the original topology.
 */
function _c4OffsetCavity(md, thickness, openSet, label) {
  const nV = md.V.length;
  // Cluster facet normals within ~10°, AREA-WEIGHTED. Tessellated fillets /
  // cylinders put many near-parallel planes on one vertex; treating each as
  // distinct makes `_c4SolvePlaneMoves` shoot vertices hundreds of mm.
  // First-wins clustering let tiny boolean scraps own the cone; area-weighted
  // merge keeps the representative honest. 10° still keeps real sharp edges.
  const COS_CLUSTER = Math.cos((10 * Math.PI) / 180);
  // Per-vertex area-weighted clusters (open / closed), finalised below.
  const closedC = Array.from({ length: nV }, () => []);
  const openC = Array.from({ length: nV }, () => []);
  const isOpenTri = new Uint8Array(md.numTri);
  for (const fi of openSet) {
    for (const t of md.faces[fi].tris) isOpenTri[t] = 1;
  }
  for (let t = 0; t < md.numTri; t++) {
    const i0 = md.T[t * 3], i1 = md.T[t * 3 + 1], i2 = md.T[t * 3 + 2];
    const cx = _c4Cross(_c4Sub(md.V[i1], md.V[i0]), _c4Sub(md.V[i2], md.V[i0]));
    const area2 = _c4Len(cx);
    if (area2 < 1e-12) continue; // zero-area facet carries no plane
    const n = _c4Norm(cx);
    const bucket = isOpenTri[t] ? openC : closedC;
    _c4PushCluster(bucket[i0], n, area2, COS_CLUSTER);
    _c4PushCluster(bucket[i1], n, area2, COS_CLUSTER);
    _c4PushCluster(bucket[i2], n, area2, COS_CLUSTER);
  }
  const closed = closedC.map(_c4FinalizeClusters);
  const open = openC.map(_c4FinalizeClusters);
  // Bbox centre = outward reference for hemisphere filtering. Fillet boolean
  // scraps / opposite-sheet facets park nearly-antiparallel normals on one
  // vertex; averaging them cancels and the old fallback then shoved the vert
  // OUT through the wall (visible punch-through at vertical×rim junctions).
  let bbMin = [Infinity, Infinity, Infinity];
  let bbMax = [-Infinity, -Infinity, -Infinity];
  for (let vi = 0; vi < nV; vi++) {
    const v = md.V[vi];
    for (let k = 0; k < 3; k++) {
      if (v[k] < bbMin[k]) bbMin[k] = v[k];
      if (v[k] > bbMax[k]) bbMax[k] = v[k];
    }
  }
  const center = [
    0.5 * (bbMin[0] + bbMax[0]),
    0.5 * (bbMin[1] + bbMax[1]),
    0.5 * (bbMin[2] + bbMax[2]),
  ];
  // Verts that sit on a solid AABB face must keep that face's plane in their
  // normal set. Fillet scraps sometimes leave only a sideways normal on a
  // flat-face vert; LS then insets the wrong way and the AABB clamp freezes
  // or tears the inner wall at flat↔fillet transitions.
  const AABB_FACE_EPS = 1e-3;
  const ensureAabbFaceNormals = (normals, vert) => {
    const add = [];
    if (Math.abs(vert[0] - bbMax[0]) <= AABB_FACE_EPS) add.push([1, 0, 0]);
    if (Math.abs(vert[0] - bbMin[0]) <= AABB_FACE_EPS) add.push([-1, 0, 0]);
    if (Math.abs(vert[1] - bbMax[1]) <= AABB_FACE_EPS) add.push([0, 1, 0]);
    if (Math.abs(vert[1] - bbMin[1]) <= AABB_FACE_EPS) add.push([0, -1, 0]);
    if (Math.abs(vert[2] - bbMax[2]) <= AABB_FACE_EPS) add.push([0, 0, 1]);
    if (Math.abs(vert[2] - bbMin[2]) <= AABB_FACE_EPS) add.push([0, 0, -1]);
    if (!add.length) return normals;
    const out = normals.slice();
    for (const n of add) {
      if (!out.some((m) => _c4Dot(m, n) >= 0.985)) out.push(n);
    }
    return out;
  };
  const COS_HEMI = Math.cos((85 * Math.PI) / 180); // keep ~outward vs centre
  const filterHemi = (normals, vert) => {
    if (!normals.length) return normals;
    const ref = _c4Sub(vert, center);
    const rLen = _c4Len(ref);
    if (rLen < 1e-12) return normals;
    const r = _c4Mul(1 / rLen, ref);
    const kept = normals.filter((n) => _c4Dot(n, r) >= COS_HEMI);
    // Spurious-only set (e.g. a lone inward normal on the opposite side):
    // replace with geometric outward so we still inset instead of punching out.
    return kept.length ? kept : [r];
  };
  // A vertex on N unit planes offset by t moves at most t*sqrt(N) in the
  // orthogonal case (box corner: t√3). Anything far beyond that is a blown
  // solve — clamp magnitude along the LS direction (do NOT avg-cancel).
  const dCap = thickness * 4;
  let moved = 0;
  const out = md.V.map((v) => v.slice());
  for (let vi = 0; vi < nV; vi++) {
    if (!closed[vi].length && !open[vi].length) continue;
    // Skip AABB-face injection on open-rim verts — injecting the open face's
    // normal as closed would cancel the intentional outward overshoot.
    const closedF = filterHemi(
      open[vi].length ? closed[vi] : ensureAabbFaceNormals(closed[vi], md.V[vi]),
      md.V[vi],
    );
    // Open faces intentionally overshoot outward; do not hemisphere-filter them
    // against centre (the open rim would lose its -Y push).
    let d = _c4VertexOffset(closedF, open[vi], thickness);
    if (!Number.isFinite(d[0] + d[1] + d[2])) {
      throw new Error(`${label}: offset blew up at a degenerate vertex — check the mesh for slivers`);
    }
    const dLen = _c4Len(d);
    if (dLen > dCap) {
      d = _c4Mul(dCap / dLen, d);
    }
    if (_c4Len(d) < 1e-12) continue;
    moved++;
    const v0 = md.V[vi];
    let nv = _c4Add(v0, d);
    // Closed-only verts: (1) strip leftover OUTWARD motion along (v−centre) so
    // a residual/LS miss cannot push the cavity through the outer wall;
    // (2) per-axis AABB clamp ONLY axes that exited — full segment pullback
    // froze verts that start on an AABB face whenever any component nudged
    // outward through that face (inner-wall holes at flat↔fillet junctions).
    if (!open[vi].length) {
      const ref = _c4Sub(v0, center);
      const rLen = _c4Len(ref);
      if (rLen > 1e-12) {
        const r = _c4Mul(1 / rLen, ref);
        const outExtra = _c4Dot(_c4Sub(nv, v0), r);
        if (outExtra > 0) nv = _c4Sub(nv, _c4Mul(outExtra, r));
      }
      nv = [
        Math.min(bbMax[0], Math.max(bbMin[0], nv[0])),
        Math.min(bbMax[1], Math.max(bbMin[1], nv[1])),
        Math.min(bbMax[2], Math.max(bbMin[2], nv[2])),
      ];
    }
    out[vi] = nv;
  }
  if (!moved) throw new Error(`${label}: nothing to offset — the body has no faces`);
  _c4RequireNoFold(md, out, label, thickness);
  return _c4RebuildWithVerts(md, out, label);
}


/**
 * Face features on a part whose bodies overlap (Merge bodies off).
 *
 * hollow / draftFaces / moveFace / deleteFace read the whole mesh. With two
 * overlapping bodies that is wrong: a hollow's cavity of one body cuts the
 * other's walls, a coplanar seam expansion can reach the other body, and a
 * draft's neutral plane comes from the whole part's box. So each named face
 * ({ center }) goes to the body whose surface is closest to it, and the
 * feature runs on that body alone. Unnamed selectors ('z', 'all', 'sides',
 * a bare normal, or none) run on every body. Bodies that get no face are
 * kept as they are, and the results are composed again.
 *
 * A part that is one body, or whose bodies do not overlap, takes the
 * feature exactly as before.
 */
function _perBodyFaceOp(manifold, faces, run) {
  const split = manifold && typeof manifold.decompose === 'function'
    ? overlappingBodies(manifold)
    : null;
  if (!split) return run(manifold, faces);
  const { Manifold } = manifoldModule;
  const bodies = split.bodies;
  const named = bodies.map(() => []);
  const shared = [];
  const flat = [];
  const walk = (s) => {
    if (Array.isArray(s) && !(s.length === 3 && s.every((n) => typeof n === 'number'))) {
      s.forEach(walk);
      return;
    }
    flat.push(s);
  };
  walk(faces);
  let meshes = null;
  for (const entry of flat) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(entry.center)) {
      if (!meshes) meshes = bodies.map((b) => b.getMesh());
      let best = 0;
      let bestD = Infinity;
      const want = Array.isArray(entry.normal) && entry.normal.length >= 3 ? _c4Norm(entry.normal.map(Number)) : null;
      for (let bi = 0; bi < bodies.length; bi++) {
        const mesh = meshes[bi];
        const np = mesh.numProp;
        const vp = mesh.vertProperties;
        const tv = mesh.triVerts;
        const at = (k) => [vp[k * np], vp[k * np + 1], vp[k * np + 2]];
        for (let t = 0; t < mesh.numTri; t++) {
          const a = at(tv[t * 3]);
          const b = at(tv[t * 3 + 1]);
          const c = at(tv[t * 3 + 2]);
          // A pick on the seam where two bodies cross is 0 from both; the
          // facing triangle (same normal as the pick) decides.
          if (want) {
            const tn = _c4Norm(_c4Cross(_c4Sub(b, a), _c4Sub(c, a)));
            if (_c4Dot(tn, want) < 0.99) continue;
          }
          const d = _c4DistPointTri(entry.center, a, b, c);
          if (d < bestD) { bestD = d; best = bi; }
        }
      }
      named[best].push(entry);
    } else {
      shared.push(entry);
    }
  }
  const out = [];
  const temps = [];
  for (let bi = 0; bi < bodies.length; bi++) {
    const mine = named[bi];
    const anyNamed = flat.some((e) => e && typeof e === 'object' && Array.isArray(e.center));
    // Only named picks, none on this body → leave it alone.
    if (!mine.length && anyNamed && !shared.length) {
      out.push(bodies[bi]);
      continue;
    }
    const spec = [...mine, ...shared];
    const arg = Array.isArray(faces) || spec.length !== 1 ? spec : spec[0];
    const res = run(bodies[bi], flat.length ? arg : faces);
    out.push(res);
    if (res !== bodies[bi]) temps.push(bodies[bi]);
  }
  const result = Manifold.compose(out);
  for (const m of out) _safeDeleteManifold(m);
  for (const m of temps) _safeDeleteManifold(m);
  return result;
}

/**
 * shell(manifold, thickness, opening) — the CAVITY tool.
 *
 * Returns the material to remove, so the historical call site still reads
 *   part = part.subtract(shell(part, 2.5, 'z'));
 * `hollow(part, 2.5, 'z')` is the same thing with the subtraction done for you.
 *
 * Wall thickness is uniform on every face: each boundary vertex lands on the
 * inward offset of every face meeting it, instead of the old single-ratio scale
 * that gave a 60x20 box a 2.5mm wall on Y and 7.5mm on X.
 *
 * @param {Manifold} manifold
 * @param {number} thickness wall thickness, mm
 * @param {*} [opening='z'] which face(s) open into the cavity: 'z' (default,
 *        the +Z face — what the old axis argument meant), '-z', 'x'…; 'none'
 *        for a closed hollow; a face from facesByNormal()/planarFaceAt(); a
 *        Viewport face pick {center, normal}; or an array of those.
 * @returns {Manifold} the cavity — subtract it from `manifold`
 */
function shell(manifold, thickness, opening = 'z') {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  _c4RequirePositive('shell', 'thickness', thickness);
  const md = c4MeshData(manifold);
  const openSet = _c4ResolveFaceSelection(md, opening, { label: 'shell: opening' });
  const cavity = _c4OffsetCavity(md, thickness, openSet, 'shell');
  const cv = cavity.volume();
  if (cv <= 1e-9) {
    throw new Error(
      cv < -1e-9
        ? `shell: wall thickness ${thickness} folded the offset surface (cavity volume ${cv.toFixed(3)}) — try a smaller wall or simplify the body`
        : `shell: wall thickness ${thickness} leaves no cavity — the part is thinner than 2x the wall`,
    );
  }
  return cavity;
}

/**
 * hollow(manifold, thickness, opening) — the shelled SOLID (walls only).
 * @see shell for the `opening` forms.
 */
function hollow(manifold, thickness, opening = 'z') {
  return _perBodyFaceOp(manifold, opening, (body, sel) => _hollowOne(body, thickness, sel));
}

function _hollowOne(manifold, thickness, opening) {
  const out = _c4RequireValidSolid(manifold.subtract(shell(manifold, thickness, opening)), 'hollow');
  // A wall thicker than half the part can leave the solid untouched — a silent
  // no-op that reads as a kernel bug. Say it instead.
  if (out.volume() >= manifold.volume() - 1e-9) {
    throw new Error(
      `hollow: wall thickness ${thickness} leaves no cavity — the part is thinner than 2x the wall`,
    );
  }
  return out;
}

/** Face → neighbor face indices, from the welded edge table. */
function _c4FaceAdj(md) {
  const adj = new Map();
  for (const e of md.edges) {
    const a = e.faces[0], b = e.faces[1];
    if (a < 0 || b < 0 || a === b) continue;
    let sa = adj.get(a);
    if (!sa) { sa = []; adj.set(a, sa); }
    let sb = adj.get(b);
    if (!sb) { sb = []; adj.set(b, sb); }
    sa.push(b);
    sb.push(a);
  }
  return adj;
}

/**
 * Pull-coordinate of the fillet/chamfer tangency to hinge `fi` on, or null
 * to keep the neutral plane.
 *
 * A blend between the neutral plane and the wall stops the wall short of the
 * plane. Shearing that wall about the plane slides the shared tangency edge
 * (tan(angle) × the gap) and leaves a ledge; the blend itself must stay.
 * Hinge on the tangency instead: vertices on that line do not move, and the
 * wall tilts from there. The blend is not added to the draft selection.
 *
 * Returns null — caller keeps the neutral plane — when the wall already
 * meets that plane, when the blend is on the far side of the wall, or when
 * the near outline is not one tangency line (reference:'mid' on a cube).
 */
function _c4BlendHingePull(md, fi, pull, t0, sel, getAdj) {
  const f = md.faces[fi];
  const sAbs = (vi) => Math.abs(_c4Dot(md.V[vi], pull) - t0);
  const vis = _c4FaceVertIndices(md, f);
  let minAbs = Infinity;
  for (const vi of vis) minAbs = Math.min(minAbs, sAbs(vi));
  // Already meets the neutral plane — nothing sits between them.
  if (!(minAbs > 1e-3)) return null;

  // Vertices on the near side of this face. 0.05 mm covers tessellation
  // noise on the tangency without swallowing the rest of a real wall.
  const near = new Set();
  for (const vi of vis) {
    if (Math.abs(sAbs(vi) - minAbs) <= 0.05) near.add(vi);
  }
  const pulls = [];
  const start = [];
  for (const e of md.edges) {
    let ni = -1;
    if (e.faces[0] === fi) ni = e.faces[1];
    else if (e.faces[1] === fi) ni = e.faces[0];
    else continue;
    if (ni < 0 || ni === fi || !near.has(e.a) || !near.has(e.b)) continue;
    if (sel.has(ni)) continue;
    pulls.push(_c4Dot(md.V[e.a], pull), _c4Dot(md.V[e.b], pull));
    start.push(ni);
  }
  if (!pulls.length) return null;
  let pLo = Infinity, pHi = -Infinity;
  for (const p of pulls) {
    if (p < pLo) pLo = p;
    if (p > pHi) pHi = p;
  }
  // The tangency has to be one line parallel to the neutral plane. A face
  // whose whole outline is equally near (reference:'mid' on a cube) spans
  // the height and keeps the neutral-plane hinge.
  if (pHi - pLo > 0.5) return null;

  const adj = getAdj();
  const CAP = Math.cos((20 * Math.PI) / 180);
  const PARALLEL = Math.cos((5 * Math.PI) / 180);
  const fn = f.normal;
  const seen = new Set([fi]);
  const q = start.slice();
  let closer = false;
  let blend = false;
  let guard = 0;
  while (q.length && guard < 4000) {
    const ni = q.pop();
    guard++;
    if (seen.has(ni)) continue;
    seen.add(ni);
    if (sel.has(ni)) continue;
    const n = md.faces[ni];
    if (!n || _c4Len(n.normal) < 1e-8) continue;
    const align = Math.abs(_c4Dot(n.normal, fn));
    const pullAlign = Math.abs(_c4Dot(n.normal, pull));
    const isCap = pullAlign > CAP;
    // Neighboring wall: perpendicular to the drafted face and to the pull.
    const isSide = pullAlign < 0.34 && align < 0.25;
    let headsToward = false;
    for (const vi of _c4FaceVertIndices(md, n)) {
      const a = sAbs(vi);
      if (a < minAbs - 0.005) {
        closer = true;
        headsToward = true;
      } else if (a <= minAbs + 0.2) headsToward = true;
    }
    // A blend normal sits between the wall and the cap (fillet facets, or
    // one chamfer plane). A parallel step and the floor do not count.
    if (!isCap && !isSide && align < PARALLEL && align > 0.25) blend = true;
    if (closer && blend) break;
    if (isCap || isSide || !headsToward) continue;
    const nbrs = adj.get(ni);
    if (!nbrs) continue;
    for (const k of nbrs) if (!seen.has(k)) q.push(k);
  }
  if (!closer || !blend) return null;
  return pulls.reduce((a, b) => a + b, 0) / pulls.length;
}

/** One slide direction per vertex. Same normal keeps the first hinge. */
function _c4PushDraftDir(list, n, tRef) {
  for (const m of list) {
    if (Math.abs(m.n[0] - n[0]) < 1e-6 && Math.abs(m.n[1] - n[1]) < 1e-6 && Math.abs(m.n[2] - n[2]) < 1e-6) return;
  }
  list.push({ n, tRef });
}

/**
 * draftFaces(manifold, faces, angleDeg, opts) — tilt the selected faces by a
 * true constant angle about their intersection with a reference plane.
 *
 * Each selected face tilts about the line where it meets the reference plane,
 * so the achieved angle is `angleDeg` on EVERY selected wall regardless of its
 * width (the old scale-based taper only hit the angle on the narrowest one).
 * When a fillet or chamfer sits between that plane and the face, the hinge
 * moves to the blend–wall tangency; the blend face is not drafted.
 * Vertices shared by two selected faces get both displacements solved together,
 * which is what keeps a drafted corner sharp.
 *
 * Sign: positive tapers the face INWARD going along the pull direction (the
 * usual mould-release sense — the section shrinks toward the pull); negative
 * flares it outward. Inner (cavity) faces read their own outward normal, so a
 * negative angle on them widens the cavity toward the pull, which is what a
 * core needs.
 *
 * @param {Manifold} manifold
 * @param {*} faces face selection: a Viewport face pick, a face from
 *        facesByNormal(), an axis like '-x', 'sides' for every side wall, or an
 *        array mixing those.
 * @param {number} angleDeg signed draft angle in degrees
 * @param {object} [opts]
 * @param {*} [opts.pull='z'] pull/draw direction ('z', '-z', [x,y,z]…)
 * @param {*} [opts.reference='min'] the neutral plane that does not move:
 *        'min' | 'max' | 'mid' along the pull axis, a number (coordinate along
 *        pull), or a face / PlaneFrame / face pick whose center defines it.
 * @returns {Manifold}
 */
function draftFaces(manifold, faces, angleDeg, opts = {}) {
  return _perBodyFaceOp(manifold, faces, (body, sel) => _draftFacesOne(body, sel, angleDeg, opts));
}

function _draftFacesOne(manifold, faces, angleDeg, opts = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  if (typeof angleDeg !== 'number' || !Number.isFinite(angleDeg)) {
    throw new Error(`draftFaces: angleDeg must be a finite number (got ${angleDeg})`);
  }
  if (Math.abs(angleDeg) >= 89) throw new Error(`draftFaces: angleDeg ${angleDeg} is past vertical`);
  const pull = _c4DirVec(opts.pull ?? 'z', 'draftFaces: pull');
  const md = c4MeshData(manifold);
  const sel = _c4ResolveFaceSelection(md, faces, { label: 'draftFaces: faces', pull });
  if (!sel.size) throw new Error('draftFaces: face selection is empty — nothing to draft');

  // Reference ("neutral") plane level, measured along pull.
  const bb = manifold.boundingBox();
  const proj = [];
  for (const x of [bb.min[0], bb.max[0]]) {
    for (const y of [bb.min[1], bb.max[1]]) {
      for (const z of [bb.min[2], bb.max[2]]) proj.push(_c4Dot([x, y, z], pull));
    }
  }
  const lo = Math.min(...proj), hi = Math.max(...proj);
  const refSpec = opts.reference ?? 'min';
  let t0;
  if (typeof refSpec === 'number') t0 = refSpec;
  else if (refSpec === 'min') t0 = lo;
  else if (refSpec === 'max') t0 = hi;
  else if (refSpec === 'mid') t0 = (lo + hi) / 2;
  else if (refSpec && typeof refSpec === 'object' && Array.isArray(refSpec.center)) {
    t0 = _c4Dot(refSpec.center, pull);
  } else {
    throw new Error(
      `draftFaces: reference must be 'min'|'max'|'mid', a number, or a face/plane (got ${refSpec})`,
    );
  }

  const tan = Math.tan((angleDeg * Math.PI) / 180);
  // Per vertex, the DISTINCT slide directions of the selected faces meeting it.
  // Distinct is the operative word: a tessellated wall contributes one direction
  // many times over (solve once), while two walls of a box corner contribute two
  // (solve together, so the corner stays sharp). Each direction carries the
  // pull coordinate it hinges on: the neutral plane, or the blend tangency
  // when a fillet/chamfer sits between that plane and the face.
  const dirs = new Map(); // vertex index -> { n, tRef }[]
  let faceAdj = null;
  // 'taper' makes every selected wall lean the same way round the pull axis, so
  // a HOLLOW part keeps its wall: the cavity wall's own normal points at the
  // axis, and honouring it would drive the inner and outer walls INTO each other
  // (a 1° draft closed the 2mm wall of the 125mm Solo Cup and left 11% of it).
  // 'face' honours each face's own normal — right for a picked face, and the
  // mould-core sense on a cavity wall.
  const sense = opts.sense ?? (faces === 'sides' ? 'taper' : 'face');
  if (sense !== 'taper' && sense !== 'face') {
    throw new Error(`draftFaces: sense must be 'taper' or 'face' (got ${sense})`);
  }
  // Pull axis for 'taper': the body's centre line along the pull direction.
  const axisPt = [
    (bb.min[0] + bb.max[0]) / 2,
    (bb.min[1] + bb.max[1]) / 2,
    (bb.min[2] + bb.max[2]) / 2,
  ];
  let drafted = 0;
  for (const fi of sel) {
    const f = md.faces[fi];
    // In-plane part of the face normal: the direction the face slides. A face
    // perpendicular to pull (a cap) has none — it cannot be drafted.
    const nIn = _c4Sub(f.normal, _c4Mul(_c4Dot(f.normal, pull), pull));
    // A face parallel to the pull is a cap. Do not skip it — one cap in the
    // list (including the neutral face) must fail, not silently drop.
    if (_c4Len(nIn) < 1e-6) {
      // A zero normal is a degenerate triangle cluster, not a cap. 'sides'
      // can pick one up after a hollow; skipping it is not dropping a wall.
      // A real face whose plane is perpendicular to the pull (normal parallel
      // to the pull) must throw, even when other faces in the list are walls.
      if (_c4Len(f.normal) < 1e-6) continue;
      throw new Error(
        'draftFaces: a selected face is parallel to the pull (its plane is perpendicular '
        + 'to the pull direction) — a cap cannot be drafted, including the neutral face; '
        + 'remove it from the list',
      );
    }
    let u = _c4Norm(nIn);
    if (sense === 'taper') {
      const r = _c4Sub(f.center, axisPt);
      const rIn = _c4Sub(r, _c4Mul(_c4Dot(r, pull), pull));
      // Point the slide direction away from the axis, whichever side of the
      // wall this face is. (A face centred on the axis keeps its own normal.)
      if (_c4Len(rIn) > 1e-9 && _c4Dot(u, rIn) < 0) u = _c4Mul(-1, u);
    }
    drafted++;
    const tRef = _c4BlendHingePull(md, fi, pull, t0, sel, () => {
      if (!faceAdj) faceAdj = _c4FaceAdj(md);
      return faceAdj;
    }) ?? t0;
    for (const vi of _c4FaceVertIndices(md, f)) {
      let list = dirs.get(vi);
      if (!list) { list = []; dirs.set(vi, list); }
      _c4PushDraftDir(list, u, tRef);
    }
  }
  if (!drafted) {
    throw new Error(
      'draftFaces: every selected face is perpendicular to the pull direction — '
      + 'a cap cannot be drafted; pick the side walls or change opts.pull',
    );
  }
  if (!dirs.size) return manifold;

  // Rebuild rather than warp(): warp() is fed Manifold's double-precision
  // positions while our vertex indices came from the float32 getMesh(), so a
  // coordinate-keyed lookup misses every non-exact vertex (see
  // _c4RebuildWithVerts).
  const moved = md.V.map((v) => v.slice());
  for (const [vi, us] of dirs) {
    // Each selected plane slides by tan(angle) × the vertex's distance along
    // pull from THAT face's hinge (neutral plane, or the blend tangency).
    const s = _c4Dot(md.V[vi], pull);
    const rhs = us.map((u) => -tan * (s - u.tRef));
    moved[vi] = _c4Add(md.V[vi], _c4SolvePlaneMoves(us.map((u) => u.n), rhs));
  }
  _c4RequireNoFold(md, moved, 'draftFaces', `${angleDeg}°`);
  return _c4RequireValidSolid(_c4RebuildWithVerts(md, moved, 'draftFaces'), 'draftFaces');
}

/**
 * Add draft angle to a manifold — every side wall, true constant angle.
 *
 * Back-compatible wrapper over `draftFaces`: the bottom (min along `axis`) stays
 * put and every wall tilts in by `draftDeg`. Unlike the old scale-based taper, a
 * 60x20 box now gets the SAME angle on its long and short walls.
 *
 * @param {Manifold} manifold
 * @param {number} draftDeg draft angle in degrees (positive tapers toward +axis)
 * @param {string} [axis='z'] pull direction: 'x', 'y', 'z' (or signed, '-z')
 * @returns {Manifold}
 *
 * @example
 * const box = Manifold.cube([50, 50, 30], true);
 * return addDraft(hollow(box, 2, 'z'), 2, 'z');
 */
function addDraft(manifold, draftDeg, axis = "z") {
  return draftFaces(manifold, 'sides', draftDeg, { pull: axis, reference: 'min' });
}

/**
 * Rigid offset of a tangent blend that shares an edge with the selection.
 *
 * An internal fillet is one body with the wall, but its facets are their own
 * faces. Leaving them stationary pins the shared vertices (the facet is
 * almost the wall's plane, with a zero offset) and the wall cannot move, so
 * the fillet stays where it was. A circular blend between planar faces
 * translates with the moved plane and stays tangent to the planes that do
 * not move. Facets much smaller than the picked face, starting within 18°
 * of it and continuing within 28°, are that blend. The next wall is not.
 *
 * @returns {Map<number, number[]>|null} vertex index → displacement
 */
function _c4BlendCarryDelta(md, sel, signed) {
  const adj = _c4FaceAdj(md);
  const area = md.faces.map((face) => {
    let a = 0;
    for (const t of face.tris) {
      const i0 = md.T[t * 3];
      const i1 = md.T[t * 3 + 1];
      const i2 = md.T[t * 3 + 2];
      a += 0.5 * _c4Len(_c4Cross(_c4Sub(md.V[i1], md.V[i0]), _c4Sub(md.V[i2], md.V[i0])));
    }
    return a;
  });
  const tangent = Math.cos((18 * Math.PI) / 180);
  const smooth = Math.cos((28 * Math.PI) / 180);
  const carry = new Set();
  const seedOf = new Map();
  const stack = [];
  for (const fi of sel) {
    const limit = Math.max(area[fi] * 0.5, 12);
    for (const nb of adj.get(fi) || []) {
      if (sel.has(nb) || carry.has(nb)) continue;
      if (!(area[nb] < limit)) continue;
      if (_c4Dot(md.faces[fi].normal, md.faces[nb].normal) < tangent) continue;
      carry.add(nb);
      seedOf.set(nb, fi);
      stack.push(nb);
    }
  }
  while (stack.length) {
    const fi = stack.pop();
    const seed = seedOf.get(fi);
    const limit = Math.max(area[seed] * 0.5, 12);
    for (const nb of adj.get(fi) || []) {
      if (sel.has(nb) || carry.has(nb)) continue;
      if (!(area[nb] < limit)) continue;
      if (_c4Dot(md.faces[fi].normal, md.faces[nb].normal) < smooth) continue;
      carry.add(nb);
      seedOf.set(nb, seed);
      stack.push(nb);
    }
  }
  if (!carry.size) return null;

  const seen = new Set();
  const vertDelta = new Map();
  for (const start of carry) {
    if (seen.has(start)) continue;
    const comp = [];
    const seeds = new Set();
    const st = [start];
    seen.add(start);
    while (st.length) {
      const fi = st.pop();
      comp.push(fi);
      seeds.add(seedOf.get(fi));
      for (const nb of adj.get(fi) || []) {
        if (!carry.has(nb) || seen.has(nb)) continue;
        seen.add(nb);
        st.push(nb);
      }
    }
    const faceSet = new Set(comp);
    const stationary = [];
    const statSeen = new Set();
    for (const e of md.edges) {
      const a = e.faces[0];
      const b = e.faces[1];
      let other = -1;
      if (faceSet.has(a) && !faceSet.has(b)) other = b;
      else if (faceSet.has(b) && !faceSet.has(a)) other = a;
      else continue;
      if (other < 0 || sel.has(other) || statSeen.has(other)) continue;
      if (area[other] < Math.max(area[seeds.values().next().value] * 0.5, 12)) continue;
      statSeen.add(other);
      stationary.push(other);
    }
    const normals = [];
    const rhs = [];
    const pushPlane = (n, r) => {
      for (let k = 0; k < normals.length; k++) {
        const d = _c4Dot(normals[k], n);
        if (d > 0.999) return;
        if (d < -0.999) return;
      }
      normals.push(n);
      rhs.push(r);
    };
    for (const fi of seeds) pushPlane(md.faces[fi].normal, signed);
    for (const fi of stationary) pushPlane(md.faces[fi].normal, 0);
    let delta = _c4SolvePlaneMoves(normals, rhs);
    let worst = 0;
    for (let k = 0; k < normals.length; k++) {
      worst = Math.max(worst, Math.abs(_c4Dot(delta, normals[k]) - rhs[k]));
    }
    if (worst > Math.max(1e-3, Math.abs(signed) * 0.02)) {
      delta = _c4Mul(signed, md.faces[seeds.values().next().value].normal);
    }
    for (const fi of comp) {
      for (const vi of _c4FaceVertIndices(md, md.faces[fi])) vertDelta.set(vi, delta);
    }
  }
  return vertDelta.size ? vertDelta : null;
}

/**
 * moveFace(manifold, faces, distance, opts) — offset the selected faces along
 * their own normals. Adjacent planar faces stay on their planes, so they
 * extend or trim and the result is still one closed solid. A tangent blend
 * on the picked face (an internal fillet) translates with that face instead
 * of staying behind.
 *
 * This is not move(). move() translates a whole body. A vertex on a selected
 * face is solved against every plane that meets it: selected planes move by
 * the signed distance, the others stay. Facets within 10° on the same side
 * of that offset are one plane. A thin facet a few degrees off that plane,
 * sharing its vertices, is the same face: the pick includes the larger plane
 * it was cut from. A distance the walls cannot absorb throws.
 * It does not return a folded mesh.
 *
 * @param {Manifold} manifold
 * @param {*} faces face selection: a viewport pick `{ center, normal }`, a
 *        face from facesByNormal(), or an array of those
 * @param {number} distance millimetres along each selected face normal
 * @param {object} [opts]
 * @param {boolean} [opts.flip=false] reverse each face normal
 * @returns {Manifold}
 */
/**
 * A fillet boolean can leave two copies of a cap vertex about 0.001mm apart,
 * so c4MeshData keeps two faces and the needle between them draws a seam.
 * They are one plane on one body. A named pick of either face includes the
 * other. The curved blend is several degrees off that plane and stays out.
 */
function _c4ExpandCoplanarSeam(md, sel) {
  const STITCH = 0.02;
  const STITCH2 = STITCH * STITCH;
  const cosP = Math.cos((0.5 * Math.PI) / 180);
  const inv = 1 / STITCH;
  const faceVerts = md.faces.map((face) => _c4FaceVertIndices(md, face));
  const buckets = new Map();
  for (let fi = 0; fi < md.faces.length; fi++) {
    for (let k = 0; k < faceVerts[fi].length; k++) {
      const p = md.V[faceVerts[fi][k]];
      const key = `${Math.floor(p[0] * inv)}|${Math.floor(p[1] * inv)}|${Math.floor(p[2] * inv)}`;
      let list = buckets.get(key);
      if (!list) { list = []; buckets.set(key, list); }
      list.push(fi);
    }
  }
  const out = new Set(sel);
  const stack = [...sel];
  while (stack.length) {
    const fi = stack.pop();
    const face = md.faces[fi];
    const n = face.normal;
    const off = n[0] * face.center[0] + n[1] * face.center[1] + n[2] * face.center[2];
    const seen = new Set();
    for (let k = 0; k < faceVerts[fi].length; k++) {
      const p = md.V[faceVerts[fi][k]];
      const cx = Math.floor(p[0] * inv);
      const cy = Math.floor(p[1] * inv);
      const cz = Math.floor(p[2] * inv);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const list = buckets.get(`${cx + dx}|${cy + dy}|${cz + dz}`);
            if (!list) continue;
            for (let li = 0; li < list.length; li++) {
              const fj = list[li];
              if (out.has(fj) || seen.has(fj)) continue;
              seen.add(fj);
              const other = md.faces[fj];
              if (other.body !== face.body) continue;
              const nd = n[0] * other.normal[0] + n[1] * other.normal[1] + n[2] * other.normal[2];
              if (nd < cosP) continue;
              const offO = n[0] * other.center[0] + n[1] * other.center[1] + n[2] * other.center[2];
              if (Math.abs(offO - off) > 0.05) continue;
              let close = false;
              for (let a = 0; a < faceVerts[fj].length && !close; a++) {
                const q = md.V[faceVerts[fj][a]];
                for (let b = 0; b < faceVerts[fi].length; b++) {
                  const r = md.V[faceVerts[fi][b]];
                  const ex = q[0] - r[0];
                  const ey = q[1] - r[1];
                  const ez = q[2] - r[2];
                  if (ex * ex + ey * ey + ez * ez <= STITCH2) { close = true; break; }
                }
              }
              if (!close) continue;
              out.add(fj);
              stack.push(fj);
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * A fillet boolean can leave a thin facet a few degrees off a planar face,
 * sharing that face's vertices. The click treats them as one plane. Pairwise
 * 0.5° seam expansion does not: the worker faces are the merged ends of that
 * chain, and the leftover step is wider than 0.5°. Moving only the scrap
 * pins the real plane (offset 0 against offset d) and every distance throws.
 * The larger face on the same body, within 10°, that shares a vertex and
 * still contains the scrap (the scrap lies within 0.012mm of its plane) is
 * that plane. A similar-sized neighbor is the next fillet step and stays out.
 */
function _c4FaceArea(md, face) {
  let a = 0;
  for (const t of face.tris) {
    const i0 = md.T[t * 3];
    const i1 = md.T[t * 3 + 1];
    const i2 = md.T[t * 3 + 2];
    a += 0.5 * _c4Len(_c4Cross(_c4Sub(md.V[i1], md.V[i0]), _c4Sub(md.V[i2], md.V[i0])));
  }
  return a;
}

function _c4MaxPlaneOff(md, face, normal, off) {
  let far = 0;
  for (const vi of _c4FaceVertIndices(md, face)) {
    const p = md.V[vi];
    const d = Math.abs(normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] - off);
    if (d > far) far = d;
  }
  return far;
}

function _c4ExpandSamePlane(md, sel) {
  const COS = Math.cos((10 * Math.PI) / 180);
  const ON_PLANE = 0.012;
  const seeds = [...sel];
  const out = new Set(sel);
  const vertToSeed = new Map();
  for (const fi of seeds) {
    for (const vi of _c4FaceVertIndices(md, md.faces[fi])) vertToSeed.set(vi, fi);
  }
  for (let fj = 0; fj < md.faces.length; fj++) {
    if (out.has(fj)) continue;
    const other = md.faces[fj];
    let seedFi = -1;
    for (const vi of _c4FaceVertIndices(md, other)) {
      if (vertToSeed.has(vi)) { seedFi = vertToSeed.get(vi); break; }
    }
    if (seedFi < 0) continue;
    const face = md.faces[seedFi];
    if (other.body !== face.body) continue;
    const nd = face.normal[0] * other.normal[0]
      + face.normal[1] * other.normal[1]
      + face.normal[2] * other.normal[2];
    if (nd < COS) continue;
    // Only the plane this scrap was cut from. A similar-sized neighbor is the
    // next fillet step; pulling it in leaves a new edge the walls cannot meet.
    const aSeed = _c4FaceArea(md, face);
    const aOther = _c4FaceArea(md, other);
    if (!(aOther > aSeed * 4)) continue;
    const n = other.normal;
    const p0 = md.V[_c4FaceVertIndices(md, other)[0]];
    const off = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2];
    if (_c4MaxPlaneOff(md, face, n, off) > ON_PLANE) continue;
    out.add(fj);
  }
  return out;
}

function moveFace(manifold, faces, distance, opts = {}) {
  return _perBodyFaceOp(manifold, faces, (body, sel) => _moveFaceOne(body, sel, distance, opts));
}

function _moveFaceOne(manifold, faces, distance, opts = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  if (typeof distance !== 'number' || !Number.isFinite(distance)) {
    throw new Error(`moveFace: distance must be a finite number (got ${distance})`);
  }
  const flip = !!(opts && opts.flip);
  const signed = flip ? -distance : distance;
  const md = c4MeshData(manifold);
  const sel = _c4ExpandSamePlane(md, _c4ExpandCoplanarSeam(md, _c4ResolveFaceSelection(md, faces, { label: 'moveFace: faces' })));
  if (!sel.size) throw new Error('moveFace: face selection is empty — nothing to move');
  for (const fi of sel) {
    if (_c4Len(md.faces[fi].normal) < 1e-8) {
      throw new Error('moveFace: a selected face has no normal — re-pick it');
    }
  }
  if (signed === 0) return manifold;

  const carried = _c4BlendCarryDelta(md, sel, signed);

  const vertFaces = new Map();
  for (let fi = 0; fi < md.faces.length; fi++) {
    for (const vi of _c4FaceVertIndices(md, md.faces[fi])) {
      let list = vertFaces.get(vi);
      if (!list) { list = []; vertFaces.set(vi, list); }
      list.push(fi);
    }
  }
  const touched = new Set();
  for (const fi of sel) {
    for (const vi of _c4FaceVertIndices(md, md.faces[fi])) touched.add(vi);
  }

  const moved = md.V.map((v) => v.slice());
  const tol = Math.max(1e-3, Math.abs(signed) * 1e-3);
  // Same 10° cone as the shell offset. A fillet leaves several facets of one
  // wall on a corner; they are one plane. A real corner is wider and stays.
  const COS_CLUSTER = Math.cos((10 * Math.PI) / 180);
  const faceArea = md.faces.map((face) => {
    let a = 0;
    for (const t of face.tris) {
      const i0 = md.T[t * 3];
      const i1 = md.T[t * 3 + 1];
      const i2 = md.T[t * 3 + 2];
      a += 0.5 * _c4Len(_c4Cross(_c4Sub(md.V[i1], md.V[i0]), _c4Sub(md.V[i2], md.V[i0])));
    }
    return a;
  });
  for (const vi of touched) {
    if (carried && carried.has(vi)) continue;
    const held = [];
    const moving = [];
    for (const fi of vertFaces.get(vi) || []) {
      const n = md.faces[fi].normal;
      if (_c4Len(n) < 1e-8) continue;
      _c4PushCluster(sel.has(fi) ? moving : held, n, faceArea[fi], COS_CLUSTER);
    }
    const heldN = _c4FinalizeClusters(held);
    const movingN = _c4FinalizeClusters(moving);
    const normals = heldN.concat(movingN);
    const rhs = heldN.map(() => 0).concat(movingN.map(() => signed));
    if (!normals.length) continue;
    const d = _c4SolvePlaneMoves(normals, rhs);
    let worst = 0;
    for (let k = 0; k < normals.length; k++) {
      worst = Math.max(worst, Math.abs(_c4Dot(d, normals[k]) - rhs[k]));
    }
    if (worst > tol) {
      throw new Error(
        `moveFace: offset ${distance} cannot keep a closed solid — adjacent faces `
        + 'would not meet the moved face; use a smaller distance',
      );
    }
    moved[vi] = _c4Add(md.V[vi], d);
  }
  if (carried) {
    for (const [vi, delta] of carried) moved[vi] = _c4Add(md.V[vi], delta);
  }

  let acc = 0;
  let nAcc = 0;
  for (const fi of sel) {
    const n = md.faces[fi].normal;
    for (const vi of _c4FaceVertIndices(md, md.faces[fi])) {
      acc += _c4Dot(_c4Sub(moved[vi], md.V[vi]), n);
      nAcc++;
    }
  }
  const achieved = nAcc ? acc / nAcc : 0;
  if (Math.abs(achieved - signed) > Math.max(1e-2, Math.abs(signed) * 0.02)) {
    throw new Error(
      `moveFace: offset ${distance} did not land on the moved face `
      + `(achieved ${achieved.toFixed(3)}) — refusing a solid that is not that offset`,
    );
  }
  _c4RequireNoFold(md, moved, 'moveFace', `${distance}`, 0.02);
  let out;
  try {
    out = _c4RebuildWithVerts(md, moved, 'moveFace');
    return _c4RequireValidSolid(out, 'moveFace');
  } catch (err) {
    if (out) _safeDeleteManifold(out);
    throw err;
  }
}

/**
 * deleteFace(manifold, faces) — remove the selected faces and heal by
 * extending or trimming the neighboring faces.
 *
 * A boundary vertex of a deleted face slides onto the intersection of the
 * kept planes that meet it and the neighbor across the gap. The deleted
 * triangles are dropped. The result is returned only when every edge is
 * shared by two triangles and Manifold accepts a closed solid. An open gap,
 * a non-manifold edge, or a folded heal throws. Nothing dirty is returned.
 *
 * Faces are the same `{ center, normal }` picks moveFace uses.
 *
 * @param {Manifold} manifold
 * @param {*} faces face selection: a viewport pick `{ center, normal }`, a
 *        face from facesByNormal(), or an array of those
 * @returns {Manifold}
 */
function deleteFace(manifold, faces) {
  return _perBodyFaceOp(manifold, faces, (body, sel) => _deleteFaceOne(body, sel));
}

function _deleteFaceOne(manifold, faces) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const md = c4MeshData(manifold);
  const sel = _c4ResolveFaceSelection(md, faces, { label: 'deleteFace: faces' });
  if (!sel.size) throw new Error('deleteFace: face selection is empty — nothing to delete');
  for (const fi of sel) {
    if (_c4Len(md.faces[fi].normal) < 1e-8) {
      throw new Error('deleteFace: a selected face has no normal — re-pick it');
    }
  }

  const nTri = md.numTri;
  const nV = md.V.length;
  const triFace = new Int32Array(nTri).fill(-1);
  for (let fi = 0; fi < md.faces.length; fi++) {
    for (const t of md.faces[fi].tris) triFace[t] = fi;
  }
  const dropTri = new Uint8Array(nTri);
  for (const fi of sel) {
    for (const t of md.faces[fi].tris) dropTri[t] = 1;
  }
  let keptTris = 0;
  for (let t = 0; t < nTri; t++) if (!dropTri[t]) keptTris++;
  if (!keptTris) {
    throw new Error(
      'deleteFace: removing these faces cannot keep a closed solid — every face was selected',
    );
  }

  const planeOf = (face) => {
    if (!face || _c4Len(face.normal) < 1e-8) return null;
    return { n: face.normal, o: _c4Dot(face.normal, face.center) };
  };
  const planesParallel = (a, b) => Math.abs(_c4Dot(a.n, b.n)) >= 0.999;
  const samePlane = (a, b) => {
    const d = _c4Dot(a.n, b.n);
    if (Math.abs(d) < 0.999) return false;
    const oB = d >= 0 ? b.o : -b.o;
    return Math.abs(a.o - oB) <= 0.05;
  };
  const pushPlane = (list, plane) => {
    if (!plane) return;
    for (const have of list) {
      if (samePlane(have, plane)) return;
    }
    list.push(plane);
  };
  const planeLine = (p, q) => {
    const dir = _c4Cross(p.n, q.n);
    const len = _c4Len(dir);
    if (len < 1e-8) return null;
    const n3 = [dir[0] / len, dir[1] / len, dir[2] / len];
    const point = _c4Solve3([p.n, q.n, n3], [p.o, q.o, 0]);
    if (!point) return null;
    return { point, dir: n3 };
  };
  const lineHit = (line, plane) => {
    const denom = _c4Dot(line.dir, plane.n);
    if (Math.abs(denom) < 1e-8) return null;
    const t = (plane.o - _c4Dot(line.point, plane.n)) / denom;
    if (!Number.isFinite(t)) return null;
    return _c4Add(line.point, _c4Mul(t, line.dir));
  };
  const projectLine = (v, line) => {
    const t = _c4Dot(_c4Sub(v, line.point), line.dir);
    return _c4Add(line.point, _c4Mul(t, line.dir));
  };
  const onPlanes = (point, planes) => {
    for (const p of planes) {
      if (Math.abs(_c4Dot(p.n, point) - p.o) > 0.05) return false;
    }
    return true;
  };

  const vertFaces = Array.from({ length: nV }, () => []);
  const touchesDrop = new Uint8Array(nV);
  const touchesKeep = new Uint8Array(nV);
  for (let t = 0; t < nTri; t++) {
    const fi = triFace[t];
    const drop = dropTri[t];
    for (let k = 0; k < 3; k++) {
      const vi = md.T[t * 3 + k];
      if (drop) touchesDrop[vi] = 1;
      else touchesKeep[vi] = 1;
      if (fi >= 0 && vertFaces[vi].indexOf(fi) < 0) vertFaces[vi].push(fi);
    }
  }

  const delNeighbors = new Map();
  for (const e of md.edges) {
    const a = e.faces[0];
    const b = e.faces[1];
    if (a < 0 || b < 0 || a === b) continue;
    const link = (del, kept) => {
      let set = delNeighbors.get(del);
      if (!set) { set = new Set(); delNeighbors.set(del, set); }
      set.add(kept);
    };
    if (sel.has(a) && !sel.has(b)) link(a, b);
    else if (sel.has(b) && !sel.has(a)) link(b, a);
  }

  const bb = manifold.boundingBox();
  const diag = Math.hypot(
    bb.max[0] - bb.min[0],
    bb.max[1] - bb.min[1],
    bb.max[2] - bb.min[2],
  );
  const cap = Math.max(diag, 1);

  const moved = md.V.map((v) => v.slice());
  for (let vi = 0; vi < nV; vi++) {
    if (!touchesDrop[vi] || !touchesKeep[vi]) continue;
    const constraints = [];
    const deleted = [];
    for (const fi of vertFaces[vi]) {
      if (sel.has(fi)) deleted.push(fi);
      else pushPlane(constraints, planeOf(md.faces[fi]));
    }
    const partners = [];
    for (const dfi of deleted) {
      const neigh = delNeighbors.get(dfi);
      if (!neigh) continue;
      for (const kfi of neigh) {
        const plane = planeOf(md.faces[kfi]);
        if (!plane) continue;
        let blocked = false;
        for (const c of constraints) {
          if (planesParallel(c, plane)) { blocked = true; break; }
        }
        if (blocked) continue;
        pushPlane(partners, plane);
      }
    }

    let point = null;
    let bestD = Infinity;
    const consider = (hit) => {
      if (!hit || !onPlanes(hit, constraints)) return;
      const d = _c4Len(_c4Sub(hit, md.V[vi]));
      if (d < bestD) { bestD = d; point = hit; }
    };
    if (constraints.length === 2) {
      const line = planeLine(constraints[0], constraints[1]);
      if (line) {
        for (const p of partners) consider(lineHit(line, p));
      }
    } else if (constraints.length === 1) {
      for (const p of partners) {
        const line = planeLine(constraints[0], p);
        if (line) consider(projectLine(md.V[vi], line));
      }
    }
    if (!point || !(bestD > 1e-4) || bestD > cap) continue;
    moved[vi] = point;
  }

  let flipped = 0;
  let total = 0;
  for (let t = 0; t < nTri; t++) {
    if (dropTri[t]) continue;
    const i0 = md.T[t * 3];
    const i1 = md.T[t * 3 + 1];
    const i2 = md.T[t * 3 + 2];
    const before = _c4Cross(_c4Sub(md.V[i1], md.V[i0]), _c4Sub(md.V[i2], md.V[i0]));
    const a = _c4Len(before);
    if (a < 1e-9) continue;
    total += a;
    const after = _c4Cross(_c4Sub(moved[i1], moved[i0]), _c4Sub(moved[i2], moved[i0]));
    if (_c4Len(after) < 1e-9) continue;
    if (_c4Dot(before, after) < 0) flipped += a;
  }
  if (total > 0 && flipped / total > 0.02) {
    throw new Error(
      `deleteFace: removing these faces cannot keep a closed solid — `
      + `${Math.round((flipped / total) * 100)}% of the surface folds`,
    );
  }

  const weld = new Map();
  const newV = [];
  const mapV = (old) => {
    const v = moved[old];
    const key = `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)},${Math.round(v[2] * 1e4)}`;
    if (weld.has(key)) return weld.get(key);
    const id = newV.length;
    weld.set(key, id);
    newV.push(v.slice());
    return id;
  };
  const newTris = [];
  const seenTri = new Set();
  for (let t = 0; t < nTri; t++) {
    if (dropTri[t]) continue;
    const i0 = mapV(md.T[t * 3]);
    const i1 = mapV(md.T[t * 3 + 1]);
    const i2 = mapV(md.T[t * 3 + 2]);
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
    const area = _c4Len(_c4Cross(
      _c4Sub(newV[i1], newV[i0]),
      _c4Sub(newV[i2], newV[i0]),
    ));
    if (area < 1e-8) continue;
    const key = [i0, i1, i2].sort((a, b) => a - b).join(',');
    if (seenTri.has(key)) continue;
    seenTri.add(key);
    newTris.push(i0, i1, i2);
  }
  if (newTris.length < 12) {
    throw new Error(
      'deleteFace: removing these faces cannot keep a closed solid — neighboring faces do not meet',
    );
  }

  const edgeUse = new Map();
  for (let i = 0; i < newTris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const u = newTris[i + k];
      const w = newTris[i + ((k + 1) % 3)];
      const key = u < w ? `${u},${w}` : `${w},${u}`;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }
  let open = 0;
  let nonManifold = 0;
  for (const count of edgeUse.values()) {
    if (count === 1) open++;
    else if (count !== 2) nonManifold++;
  }
  if (open || nonManifold) {
    throw new Error(
      'deleteFace: removing these faces cannot keep a closed solid — neighboring faces do not meet'
      + ` (${open} open, ${nonManifold} non-manifold)`,
    );
  }

  const { Manifold, Mesh } = manifoldModule;
  const vp = new Float32Array(newV.length * 3);
  for (let i = 0; i < newV.length; i++) {
    vp[i * 3] = newV[i][0];
    vp[i * 3 + 1] = newV[i][1];
    vp[i * 3 + 2] = newV[i][2];
  }
  let out;
  try {
    out = new Manifold(new Mesh({
      numProp: 3,
      vertProperties: vp,
      triVerts: new Uint32Array(newTris),
    }));
    const se = _c4StatusError(out);
    if (se) {
      throw new Error(
        `deleteFace: removing these faces cannot keep a closed solid (${se})`,
      );
    }
    const outBb = out.boundingBox();
    const outDiag = Math.hypot(
      outBb.max[0] - outBb.min[0],
      outBb.max[1] - outBb.min[1],
      outBb.max[2] - outBb.min[2],
    );
    if (outDiag > diag * 2 + 1) {
      throw new Error(
        'deleteFace: removing these faces cannot keep a closed solid — the heal runs away',
      );
    }
    return _c4RequireValidSolid(out, 'deleteFace');
  } catch (err) {
    if (out) _safeDeleteManifold(out);
    throw err;
  }
}

// Helpers for a loft function

// Compute centroid of a contour (array of [x, y] points)
function computeCentroid(contour) {
  let cx = 0;
  let cy = 0;
  const n = contour.length;
  if (n === 0) return [0, 0];

  for (const p of contour) {
    cx += p[0];
    cy += p[1];
  }
  return [cx / n, cy / n];
}

// Center a contour by subtracting its centroid
function centerContour(contour) {
  const [cx, cy] = computeCentroid(contour);
  return contour.map(p => [p[0] - cx, p[1] - cy]);
}

// Resample a closed contour to n evenly spaced points using arc-length parameterization
function resampleContour(contour, n) {
  if (contour.length < 2) return contour;
  if (n < 2) n = 2;

  // Compute cumulative arc lengths
  const lengths = [0];
  for (let i = 1; i < contour.length; i++) {
    const dx = contour[i][0] - contour[i - 1][0];
    const dy = contour[i][1] - contour[i - 1][1];
    lengths.push(lengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  // Close the loop
  const dxClose = contour[0][0] - contour[contour.length - 1][0];
  const dyClose = contour[0][1] - contour[contour.length - 1][1];
  lengths.push(lengths[lengths.length - 1] + Math.sqrt(dxClose * dxClose + dyClose * dyClose));

  const totalLength = lengths[lengths.length - 1];

  const resampled = [];
  for (let i = 0; i < n; i++) {
    const target = (i / n) * totalLength;

    // Find segment
    let seg = 0;
    while (seg < lengths.length - 1 && target > lengths[seg + 1]) seg++;

    const s0 = lengths[seg];
    const s1 = lengths[seg + 1];
    const frac = (target - s0) / (s1 - s0);

    const idx0 = seg % contour.length;
    const idx1 = (seg + 1) % contour.length;

    const x = contour[idx0][0] + frac * (contour[idx1][0] - contour[idx0][0]);
    const y = contour[idx0][1] + frac * (contour[idx1][1] - contour[idx0][1]);

    resampled.push([x, y]);
  }

  return resampled;
}

// Rotate a contour (array of [x, y] points) by a given angle in degrees
function rotateContour(contour, deg) {
  if (contour.length === 0) return contour;
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return contour.map(p => [
    p[0] * cos - p[1] * sin,
    p[0] * sin + p[1] * cos
  ]);
}

// Compute sum of squared distances between two contours of equal length
function sumSqDist(cont1, cont2) {
  if (cont1.length !== cont2.length) {
    throw new Error('Contours must have the same number of points for sumSqDist');
  }
  let dist = 0;
  for (let i = 0; i < cont1.length; i++) {
    const dx = cont1[i][0] - cont2[i][0];
    const dy = cont1[i][1] - cont2[i][1];
    dist += dx * dx + dy * dy;
  }
  return dist;
}

function loft({
  topCS,
  bottomCS,
  height = 30,
  twistDeg = 0,
  topScale = 1.0,
  align = true,
  resolution = 1024  // Higher for better corner preservation
} = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;

  // Extract and center contours
  let bottomContour = centerContour(bottomCS.toPolygons()[0]);
  let topContour = centerContour(topCS.toPolygons()[0]);

  // Scale top
  topContour = topContour.map(p => [p[0] * topScale, p[1] * topScale]);

  // Resample using arc length
  const bottomTable = resampleContour(bottomContour, resolution);
  let topTable = resampleContour(topContour, resolution);

  // Optional alignment
  if (align) {
    let bestRot = 0;
    let minDist = Infinity;
    const steps = 72;
    for (let k = 0; k < steps; k++) {
      const rot = k * (360 / steps);
      const rotated = rotateContour(topTable, rot);
      const d = sumSqDist(bottomTable, rotated);
      if (d < minDist) {
        minDist = d;
        bestRot = rot;
      }
    }
    topTable = rotateContour(topTable, bestRot);
  }

  // Precompute radial distance table for bottom (normalized radius at each angle)
  const radialTable = [];
  for (let i = 0; i < resolution; i++) {
    const x = bottomTable[i][0];
    const y = bottomTable[i][1];
    radialTable[i] = Math.sqrt(x * x + y * y);
  }

  // Extrude bottom to full height
  const straight = Manifold.extrude(bottomCS, height, 128);

  // Warp using polar coordinates for proper corner blending
  const warp = (v) => {
    let [x, y, z] = v;

    const t = z / height;

    // Handle center separately
    const r_orig = Math.sqrt(x * x + y * y);
    if (r_orig < 1e-8) {
      v[0] = 0;
      v[1] = 0;
      return;
    }

    // Normalized radius on bottom at this angle
    let angle = Math.atan2(y, x);
    if (angle < 0) angle += 2 * Math.PI;
    const s = angle / (2 * Math.PI);

    const i = Math.floor(s * resolution);
    const frac = (s * resolution) - i;

    // Interpolate normalized radius from bottom table
    let r_bottom = radialTable[i];
    r_bottom += frac * (radialTable[(i + 1) % resolution] - radialTable[i]);

    // Scale factor for this ray
    const scale = r_orig / r_bottom;

    // Interpolate target point from top table at same angle
    let tx = topTable[i][0];
    let ty = topTable[i][1];
    tx += frac * (topTable[(i + 1) % resolution][0] - tx);
    ty += frac * (topTable[(i + 1) % resolution][1] - ty);

    // Linear blend in shape space
    let targetX = x + t * (tx * scale - x);
    let targetY = y + t * (ty * scale - y);

    // Apply twist
    if (twistDeg !== 0) {
      const twistAngle = t * twistDeg * Math.PI / 180;
      const cosT = Math.cos(twistAngle);
      const sinT = Math.sin(twistAngle);
      const tempX = targetX * cosT - targetY * sinT;
      targetY = targetX * sinT + targetY * cosT;
      targetX = tempX;
    }

    v[0] = targetX;
    v[1] = targetY;
  };

  return straight.warp(warp);
}

/**
 * Sweep a 2D profile along a 3D path
 * 
 * Creates a 3D manifold by extruding a cross-section profile along a parametric
 * path curve. Uses Rotation Minimizing Frames (RMF) for smooth orientation
 * without twist artifacts, and arc-length parameterization for uniform distribution.
 * 
 * @param {CrossSection} profile - The 2D cross-section to sweep (centered at origin)
 * @param {Object} path - Parametric path definition
 * @param {Function} path.position - Function(t) returning [x,y,z] position on curve
 * @param {Function} [path.derivative] - Function(t) returning first derivative [dx,dy,dz].
 *                                       If omitted, computed numerically.
 * @param {number} [path.tMin=0] - Start parameter value
 * @param {number} [path.tMax=1] - End parameter value
 * @param {Object} [options] - Sweep options
 * @param {number} [options.arcSamples=1000] - Samples for arc-length table (higher = more accurate)
 * @param {number} [options.extrudeSegments=64] - Segments along the extrusion
 * @param {number} [options.epsilon=1e-5] - Delta for numerical derivatives
 * @param {number[]} [options.initialNormal] - Initial normal direction hint [x,y,z]
 * @returns {Manifold} The swept 3D manifold
 * 
 * @example
 * // Sweep a circle along a helix
 * const profile = CrossSection.circle(2, 32);
 * const helixPath = {
 *   position: (t) => [10 * Math.cos(t), 10 * Math.sin(t), 3 * t],
 *   tMin: 0,
 *   tMax: 4 * Math.PI
 * };
 * return sweep(profile, helixPath);
 */
function sweep(profile, path, options = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  
  const {
    position,
    derivative: explicitDerivative,
    tMin = 0,
    tMax = 1
  } = path;
  
  const {
    arcSamples = 1000,
    extrudeSegments = 64,
    epsilon = 1e-5,
    initialNormal = null
  } = options;
  
  if (typeof position !== 'function') {
    throw new Error('path.position must be a function');
  }
  
  // Numerical derivative fallback
  const derivative = explicitDerivative || ((t) => {
    const p0 = position(t - epsilon);
    const p1 = position(t + epsilon);
    return vecMul(1 / (2 * epsilon), vecSub(p1, p0));
  });
  
  // Precompute arc length table
  const tValues = [];
  const sValues = [0];
  const deltaT = (tMax - tMin) / arcSamples;
  
  for (let i = 0; i <= arcSamples; i++) {
    tValues.push(tMin + i * deltaT);
  }
  
  for (let i = 1; i <= arcSamples; i++) {
    const speedPrev = vecNorm(derivative(tValues[i - 1]));
    const speedCurr = vecNorm(derivative(tValues[i]));
    const deltaS = (speedPrev + speedCurr) / 2 * deltaT;
    sValues.push(sValues[i - 1] + deltaS);
  }
  
  const totalLength = sValues[sValues.length - 1];
  
  if (totalLength < epsilon) {
    throw new Error('Path has zero or near-zero length');
  }
  
  // =========================================================================
  // Precompute Rotation Minimizing Frames (RMF) at sample points
  // This prevents twist discontinuities that occur with Frenet frames
  // =========================================================================
  
  const frames = []; // Array of { T, N, B } at each tValue
  
  // Compute initial frame
  const T0 = vecNormalize(derivative(tValues[0]));
  let N0;
  
  if (initialNormal) {
    // Use provided initial normal, orthogonalize to tangent
    const proj = vecMul(vecDot(initialNormal, T0), T0);
    N0 = vecNormalize(vecSub(initialNormal, proj));
  } else {
    // Find a vector not parallel to T0 for initial normal
    const absT = [Math.abs(T0[0]), Math.abs(T0[1]), Math.abs(T0[2])];
    let minAxis;
    if (absT[0] <= absT[1] && absT[0] <= absT[2]) {
      minAxis = [1, 0, 0];
    } else if (absT[1] <= absT[0] && absT[1] <= absT[2]) {
      minAxis = [0, 1, 0];
    } else {
      minAxis = [0, 0, 1];
    }
    N0 = vecNormalize(vecCross(T0, minAxis));
  }
  
  const B0 = vecCross(T0, N0);
  frames.push({ T: T0, N: N0, B: B0 });
  
  // Propagate frame using double reflection method (rotation minimizing)
  for (let i = 1; i <= arcSamples; i++) {
    const prevFrame = frames[i - 1];
    const Ti = vecNormalize(derivative(tValues[i]));
    
    // Double reflection method for RMF
    // Reflect previous frame to midpoint, then to current point
    const v1 = vecSub(position(tValues[i]), position(tValues[i - 1]));
    const c1 = vecDot(v1, v1);
    
    if (c1 < epsilon * epsilon) {
      // Points too close, copy previous frame with new tangent
      const proj = vecMul(vecDot(prevFrame.N, Ti), Ti);
      const Ni = vecNormalize(vecSub(prevFrame.N, proj));
      const Bi = vecCross(Ti, Ni);
      frames.push({ T: Ti, N: Ni, B: Bi });
      continue;
    }
    
    // First reflection: reflect N and T across v1
    const NL = vecSub(prevFrame.N, vecMul((2 / c1) * vecDot(v1, prevFrame.N), v1));
    const TL = vecSub(prevFrame.T, vecMul((2 / c1) * vecDot(v1, prevFrame.T), v1));
    
    // Second reflection: reflect across v2 = Ti - TL
    const v2 = vecSub(Ti, TL);
    const c2 = vecDot(v2, v2);
    
    let Ni;
    if (c2 < epsilon * epsilon) {
      Ni = NL;
    } else {
      Ni = vecSub(NL, vecMul((2 / c2) * vecDot(v2, NL), v2));
    }
    
    // Ensure orthonormality
    Ni = vecNormalize(vecSub(Ni, vecMul(vecDot(Ni, Ti), Ti)));
    const Bi = vecCross(Ti, Ni);
    
    frames.push({ T: Ti, N: Ni, B: Bi });
  }
  
  // Create straight extrusion to warp
  const straight = Manifold.extrude(profile, totalLength, extrudeSegments);
  
  // Warp function using precomputed RMF frames
  const warp = (v) => {
    let [x, y, s] = v;
    s = Math.max(0, Math.min(totalLength, s));
    
    // Binary search for arc length to parameter mapping
    let low = 0;
    let high = sValues.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (sValues[mid] <= s) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    
    let i = low;
    if (i === sValues.length - 1) i--;
    
    // Interpolate between frames
    const frac = (s - sValues[i]) / (sValues[i + 1] - sValues[i]);
    const t = tValues[i] + frac * (tValues[i + 1] - tValues[i]);
    
    // Get position on curve
    const P = position(t);
    
    // Interpolate frame (simple linear interp, could use slerp for better results)
    const frame0 = frames[i];
    const frame1 = frames[i + 1];
    
    const N = vecNormalize([
      frame0.N[0] + frac * (frame1.N[0] - frame0.N[0]),
      frame0.N[1] + frac * (frame1.N[1] - frame0.N[1]),
      frame0.N[2] + frac * (frame1.N[2] - frame0.N[2])
    ]);
    const B = vecNormalize([
      frame0.B[0] + frac * (frame1.B[0] - frame0.B[0]),
      frame0.B[1] + frac * (frame1.B[1] - frame0.B[1]),
      frame0.B[2] + frac * (frame1.B[2] - frame0.B[2])
    ]);
    
    // Map local (x, y) to N-B plane
    v[0] = P[0] + x * N[0] + y * B[0];
    v[1] = P[1] + x * N[1] + y * B[1];
    v[2] = P[2] + x * N[2] + y * B[2];
  };
  
  return straight.warp(warp);
}

// ============================================================================
// VECTOR HELPERS (for sweep and other operations)
// ============================================================================

function vecAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vecSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vecMul(s, v) { return [s * v[0], s * v[1], s * v[2]]; }
function vecDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vecCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function vecNorm(v) { return Math.sqrt(vecDot(v, v)); }
function vecNormalize(v) {
  const len = vecNorm(v);
  return len > 1e-8 ? vecMul(1 / len, v) : [0, 0, 1];
}

/**
 * Sweep a profile along a path defined by an array of points
 * 
 * Convenience wrapper for sweep() that accepts a polyline path.
 * Internally creates a Catmull-Rom spline through the points.
 * 
 * @param {CrossSection} profile - The 2D cross-section to sweep
 * @param {number[][]} points - Array of [x,y,z] points defining the path (minimum 2 points)
 * @param {Object} [options] - Sweep options (see sweep())
 * @param {boolean} [options.closed=false] - Whether the path forms a closed loop
 * @returns {Manifold} The swept 3D manifold
 * 
 * @example
 * // Sweep along a series of points
 * const profile = CrossSection.circle(1, 16);
 * const points = [
 *   [0, 0, 0],
 *   [10, 5, 0],
 *   [20, 0, 10],
 *   [30, -5, 10]
 * ];
 * return sweepPoints(profile, points);
 */
function sweepPoints(profile, points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('points must be an array of at least 2 [x,y,z] coordinates');
  }
  
  const { closed = false, ...sweepOptions } = options;
  const n = points.length;
  
  // Catmull-Rom spline interpolation
  const catmullRom = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return [
      0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
      0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3)
    ];
  };
  
  const catmullRomDeriv = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    return [
      0.5 * ((-p0[0] + p2[0]) + 2 * (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t + 3 * (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t2),
      0.5 * ((-p0[1] + p2[1]) + 2 * (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t + 3 * (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t2),
      0.5 * ((-p0[2] + p2[2]) + 2 * (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t + 3 * (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t2)
    ];
  };
  
  // Get control points with proper boundary handling
  // For open curves, extrapolate phantom points to maintain tangent direction
  const getPoint = (i) => {
    if (closed) {
      return points[((i % n) + n) % n];
    } else {
      if (i < 0) {
        // Extrapolate before start: reflect point[1] across point[0]
        const idx = -i;
        if (idx <= n - 1) {
          return vecSub(vecMul(2, points[0]), points[idx]);
        }
        return points[0];
      } else if (i >= n) {
        // Extrapolate after end: reflect point[n-2] across point[n-1]
        const idx = 2 * (n - 1) - i;
        if (idx >= 0) {
          return vecSub(vecMul(2, points[n - 1]), points[idx]);
        }
        return points[n - 1];
      }
      return points[i];
    }
  };
  
  const numSegments = closed ? n : n - 1;
  
  const path = {
    position: (t) => {
      // Clamp t to valid range to avoid issues at boundaries
      t = Math.max(0, Math.min(1, t));
      const scaledT = t * numSegments;
      let segment = Math.floor(scaledT);
      let localT = scaledT - segment;
      
      // Handle exact endpoint
      if (segment >= numSegments) {
        segment = numSegments - 1;
        localT = 1;
      }
      
      const p0 = getPoint(segment - 1);
      const p1 = getPoint(segment);
      const p2 = getPoint(segment + 1);
      const p3 = getPoint(segment + 2);
      
      return catmullRom(p0, p1, p2, p3, localT);
    },
    derivative: (t) => {
      t = Math.max(0, Math.min(1, t));
      const scaledT = t * numSegments;
      let segment = Math.floor(scaledT);
      let localT = scaledT - segment;
      
      if (segment >= numSegments) {
        segment = numSegments - 1;
        localT = 1;
      }
      
      const p0 = getPoint(segment - 1);
      const p1 = getPoint(segment);
      const p2 = getPoint(segment + 1);
      const p3 = getPoint(segment + 2);
      
      // Scale derivative by numSegments due to chain rule
      const d = catmullRomDeriv(p0, p1, p2, p3, localT);
      return vecMul(numSegments, d);
    },
    tMin: 0,
    tMax: 1
  };
  
  return sweep(profile, path, sweepOptions);
}

/**
 * Create a rounded box (box with filleted edges)
 * @param {number[]} size - [x, y, z] dimensions
 * @param {number} radius - Corner/edge radius
 * @param {number} segments - Number of segments for rounding (default 16)
 */
function roundedBox(size, radius, segments = 16) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  const minDim = Math.min(...size);
  const r = Math.min(radius, minDim / 2 - 0.001);
  if (!(r > 0)) return Manifold.cube(size, true);
  // Bundled Manifold has no offset()/minkowski — hull of 8 corner spheres
  // equals cube ⊕ sphere (rounded box).
  const half = size.map((s) => s / 2 - r);
  const spheres = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        spheres.push(
          Manifold.sphere(r, segments).translate([
            sx * half[0], sy * half[1], sz * half[2],
          ]),
        );
      }
    }
  }
  return Manifold.hull(spheres);
}

/**
 * Rounded-rectangle 2D profile as a CrossSection, centered on the origin.
 * r = 0 gives a plain rectangle. r is clamped to half the shorter side.
 */
function _c4RectProfile(w, d, r, segments) {
  const { CrossSection } = manifoldModule;
  const rr = Math.min(Math.max(r || 0, 0), Math.min(w, d) / 2 - 1e-9);
  if (!(rr > 1e-9)) return CrossSection.square([w, d], true);
  // Offset an inset rectangle outward: exact rounded corners, no hand-rolled arcs.
  return CrossSection.square([w - 2 * rr, d - 2 * rr], true)
    .offset(rr, 'Round', 2, Math.max(8, segments || 32));
}

/**
 * rectTube(outer, inner, height, opts) — rectangular (square) tube.
 *
 * @param {number|number[]} outer outer size: [w, d], or a number for a square
 * @param {number|number[]} inner inner size [w, d]; a NUMBER is read as a
 *        uniform wall thickness (inner = outer - 2*wall), which is how you
 *        usually want to specify a rectangular tube
 * @param {number} height extruded height (z = 0 .. height, like Manifold.cylinder)
 * @param {object} [opts]
 * @param {number} [opts.cornerRadius=0] outer corner radius
 * @param {number} [opts.innerCornerRadius] inner corner radius; defaults to
 *        cornerRadius - wall (>= 0), which keeps the wall uniform round the corner
 * @param {number} [opts.segments=32] segments per full circle for the corner arcs
 * @param {boolean} [opts.center=false] center the extrusion on z instead of z=0..h
 * @returns {Manifold}
 *
 * @example
 * rectTube([40, 20], 2.5, 60);                        // 2.5mm wall, sharp corners
 * rectTube([40, 20], [30, 10], 60, { cornerRadius: 4 });
 */
function rectTube(outer, inner, height, opts = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const size = (v, label) => {
    if (Array.isArray(v)) {
      if (v.length !== 2) throw new Error(`rectTube: ${label} must be [w, d] or a number`);
      return [v[0], v[1]];
    }
    return [v, v];
  };
  const [ow, od] = size(outer, 'outer');
  _c4RequirePositive('rectTube', 'outer width', ow);
  _c4RequirePositive('rectTube', 'outer depth', od);
  _c4RequirePositive('rectTube', 'height', height);
  let iw, id, wall;
  if (typeof inner === 'number') {
    wall = inner;
    _c4RequirePositive('rectTube', 'wall', wall);
    iw = ow - 2 * wall;
    id = od - 2 * wall;
    if (!(iw > 0) || !(id > 0)) {
      throw new Error(
        `rectTube: wall ${wall} is too thick for a ${ow}x${od} tube (needs < ${(Math.min(ow, od) / 2).toFixed(3)})`,
      );
    }
  } else {
    [iw, id] = size(inner, 'inner');
    _c4RequirePositive('rectTube', 'inner width', iw);
    _c4RequirePositive('rectTube', 'inner depth', id);
    if (iw >= ow || id >= od) {
      throw new Error(`rectTube: inner ${iw}x${id} must be smaller than outer ${ow}x${od}`);
    }
    wall = Math.min(ow - iw, od - id) / 2;
  }
  const segments = opts.segments ?? 32;
  const rOut = opts.cornerRadius ?? 0;
  const rIn = opts.innerCornerRadius ?? Math.max(0, rOut - wall);
  const profile = _c4RectProfile(ow, od, rOut, segments)
    .subtract(_c4RectProfile(iw, id, rIn, segments));
  const out = profile.extrude(height, 0, 0, [1, 1], !!opts.center);
  return _c4RequireValidSolid(out, 'rectTube');
}

/**
 * Create a tube/pipe shape — round or rectangular.
 *
 * Round:       tube(outerRadius, innerRadius, height, segments?)
 * Rectangular: tube([w, d], wall, height, opts?)  /  tube([w, d], [iw, id], height, opts?)
 *
 * Passing an array as the first argument hands off to `rectTube`, so the 4th
 * argument is then its options object ({ cornerRadius, segments, center }) and
 * not a segment count.
 *
 * @param {number|number[]} outerRadius outer radius, or [w, d] for a rectangle
 * @param {number|number[]} innerRadius inner radius; for a rectangle, a wall
 *        thickness or [iw, id]
 * @param {number} height Height of the tube
 * @param {number|object} [segments=32] segments (round) or opts (rectangular)
 */
function tube(outerRadius, innerRadius, height, segments = 32) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;

  if (Array.isArray(outerRadius)) {
    return rectTube(outerRadius, innerRadius, height, typeof segments === 'object' ? segments : {});
  }

  if (innerRadius >= outerRadius) {
    throw new Error('Inner radius must be smaller than outer radius');
  }

  const outer = Manifold.cylinder(height, outerRadius, outerRadius, segments);
  const inner = Manifold.cylinder(height, innerRadius, innerRadius, segments);

  return outer.subtract(inner);
}

/**
 * Create a hexagonal prism
 * @param {number} radius - Radius (circumradius)
 * @param {number} height - Height
 */
function hexPrism(radius, height) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  
  return Manifold.cylinder(height, radius, radius, 6);
}

/**
 * Mirror a manifold across a plane
 * @param {Manifold} manifold - The manifold to mirror
 * @param {string} plane - 'xy', 'xz', or 'yz'
 * @param {boolean} keepOriginal - Whether to union with original (default true)
 */
function mirror(manifold, plane = 'xy', keepOriginal = true) {
  let scale;
  switch (plane.toLowerCase()) {
    case 'xy': scale = [1, 1, -1]; break;
    case 'xz': scale = [1, -1, 1]; break;
    case 'yz': scale = [-1, 1, 1]; break;
    default: throw new Error('Plane must be "xy", "xz", or "yz"');
  }
  
  const mirrored = manifold.scale(scale);
  
  if (keepOriginal) {
    // Union might fail if they overlap - try to handle gracefully
    try {
      return manifold.add(mirrored);
    } catch {
      return mirrored;
    }
  }
  return mirrored;
}

/**
 * Create an array/grid of manifolds
 * @param {Manifold} manifold - The manifold to array
 * @param {number[]} counts - [nx, ny, nz] number of copies in each direction
 * @param {number[]} spacing - [dx, dy, dz] spacing between copies
 */
function array3D(manifold, counts, spacing) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  
  const [nx, ny, nz] = counts;
  const [dx, dy, dz] = spacing;
  
  const copies = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (ix === 0 && iy === 0 && iz === 0) {
          copies.push(manifold);
        } else {
          copies.push(manifold.translate([ix * dx, iy * dy, iz * dz]));
        }
      }
    }
  }
  
  return Manifold.union(copies);
}

/**
 * Create a polar array (copies around an axis)
 * @param {Manifold} manifold - The manifold to array
 * @param {number} count - Number of copies
 * @param {number} radius - Radius from center (optional offset)
 * @param {string} axis - Rotation axis ('x', 'y', or 'z')
 */
function polarArray(manifold, count, radius = 0, axis = 'z') {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  
  const copies = [];
  const angleStep = 360 / count;
  
  for (let i = 0; i < count; i++) {
    const angle = i * angleStep;
    let rotated;
    
    // Apply radius offset first
    let positioned = radius > 0 ? manifold.translate([radius, 0, 0]) : manifold;
    
    // Then rotate
    switch (axis.toLowerCase()) {
      case 'x':
        rotated = positioned.rotate([angle, 0, 0]);
        break;
      case 'y':
        rotated = positioned.rotate([0, angle, 0]);
        break;
      case 'z':
      default:
        rotated = positioned.rotate([0, 0, angle]);
        break;
    }
    
    copies.push(rotated);
  }
  
  return Manifold.union(copies);
}

/**
 * Center a manifold at origin
 * @param {Manifold} manifold - The manifold to center
 * @param {boolean[]} axes - [centerX, centerY, centerZ] which axes to center
 */
function center(manifold, axes = [true, true, true]) {
  const bbox = manifold.boundingBox();
  const offset = [0, 0, 0];
  
  for (let i = 0; i < 3; i++) {
    if (axes[i]) {
      offset[i] = -(bbox.min[i] + bbox.max[i]) / 2;
    }
  }
  
  return manifold.translate(offset);
}

/**
 * Align a manifold to a specific position
 * @param {Manifold} manifold - The manifold to align
 * @param {object} options - { min: [x,y,z], max: [x,y,z], center: [x,y,z] }
 */
function align(manifold, options = {}) {
  const bbox = manifold.boundingBox();
  const offset = [0, 0, 0];
  
  if (options.min) {
    for (let i = 0; i < 3; i++) {
      if (options.min[i] !== undefined) {
        offset[i] = options.min[i] - bbox.min[i];
      }
    }
  }
  
  if (options.max) {
    for (let i = 0; i < 3; i++) {
      if (options.max[i] !== undefined) {
        offset[i] = options.max[i] - bbox.max[i];
      }
    }
  }
  
  if (options.center) {
    for (let i = 0; i < 3; i++) {
      if (options.center[i] !== undefined) {
        const currentCenter = (bbox.min[i] + bbox.max[i]) / 2;
        offset[i] = options.center[i] - currentCenter;
      }
    }
  }
  
  return manifold.translate(offset);
}

/**
 * Get the dimensions of a manifold
 * @param {Manifold} manifold - The manifold to measure
 * @returns {object} { size: [x,y,z], min: [x,y,z], max: [x,y,z], center: [x,y,z] }
 */
function getDimensions(manifold) {
  const bbox = manifold.boundingBox();
  return {
    size: [
      bbox.max[0] - bbox.min[0],
      bbox.max[1] - bbox.min[1],
      bbox.max[2] - bbox.min[2]
    ],
    min: [...bbox.min],
    max: [...bbox.max],
    center: [
      (bbox.min[0] + bbox.max[0]) / 2,
      (bbox.min[1] + bbox.max[1]) / 2,
      (bbox.min[2] + bbox.max[2]) / 2
    ]
  };
}

// ============================================================================
// C4 — Selection + Feature helpers for Manifold JS (3dculos sandbox)
// Ported from cadgen-workspace/harness/c4_helpers.mjs (all 21 harness tests
// green; verified against real dataset STEP ground truth).
//
// Mesh facts (verified against manifold-3d):
//   getMesh() -> { numProp, vertProperties(Float32), triVerts(Uint32, 3/tri),
//                  faceID(Uint32, per-tri), ... }
//   faceID = true BRep face grouping (stable across booleans; 6 on a box,
//   14 on a 12-seg cylinder, 36 on a holed box). Triangle winding is outward.
//   runIndex = per-component (NOT per edge) — edges are derived from the
//   welded triangle map instead.
//   .transform(m) = flat-16 matrix, axes packed as ROWS (row-vector
//   convention, empirically verified; see frameToMatrix). Last row = translation.
//   No face/edge API exists — this module IS the selector layer.
// ============================================================================

// ---------------------------------------------------------------- local math
function _c4Cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function _c4Dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function _c4Len(v) { return Math.hypot(v[0], v[1], v[2]); }
function _c4Norm(v) { const l = _c4Len(v) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
function _c4Sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function _c4Add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function _c4Mul(s, v) { return [s*v[0], s*v[1], s*v[2]]; }

/** Distance from point p to triangle abc. Used so a face pick stays on the body under the point. */
function _c4DistPointTri(p, a, b, c) {
  const ab = _c4Sub(b, a);
  const ac = _c4Sub(c, a);
  const ap = _c4Sub(p, a);
  const d1 = _c4Dot(ab, ap);
  const d2 = _c4Dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return _c4Len(ap);
  const bp = _c4Sub(p, b);
  const d3 = _c4Dot(ab, bp);
  const d4 = _c4Dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return _c4Len(bp);
  const cp = _c4Sub(p, c);
  const d5 = _c4Dot(ab, cp);
  const d6 = _c4Dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return _c4Len(cp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return _c4Len(_c4Sub(p, _c4Add(a, _c4Mul(v, ab))));
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return _c4Len(_c4Sub(p, _c4Add(a, _c4Mul(w, ac))));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return _c4Len(_c4Sub(p, _c4Add(b, _c4Mul(w, _c4Sub(c, b)))));
  }
  const n = _c4Cross(ab, ac);
  const nn = _c4Len(n);
  if (!(nn > 1e-18)) return _c4Len(ap);
  return Math.abs(_c4Dot(ap, n)) / nn;
}

/**
 * Vertex-connected component of each triangle. A cut that keeps both pieces
 * does not share vertices, so each piece is its own body even when Manifold
 * reuses the original faceID across the cut.
 */
function _triComponentIds(triVerts, numTri) {
  const parent = new Uint32Array(numTri);
  for (let i = 0; i < numTri; i++) parent[i] = i;
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    let x = a;
    while (parent[x] !== r) {
      const n = parent[x];
      parent[x] = r;
      x = n;
    }
    return r;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const vertToTri = new Map();
  for (let t = 0; t < numTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = triVerts[t * 3 + k];
      const prev = vertToTri.get(v);
      if (prev === undefined) vertToTri.set(v, t);
      else unite(prev, t);
    }
  }
  const rootToId = new Map();
  const ids = new Int32Array(numTri);
  let next = 0;
  for (let t = 0; t < numTri; t++) {
    const r = find(t);
    let id = rootToId.get(r);
    if (id == null) {
      id = next++;
      rootToId.set(r, id);
    }
    ids[t] = id;
  }
  return ids;
}

// ---------------------------------------------------------------- mesh data
// c4MeshData(m) -> { V:[[x,y,z]...], faces:[{id, tris, normal, center, verts}],
//                    edges:[{a, b, va, vb, tris, tangent, faces:[faceIdx,faceIdx]}] }
/** In-plane share of a face group's area for its normal to drop foreign facets. */
const _C4_PLANAR_INLIER_FRAC = 0.9;
/** A triangle within this of the area-weighted normal is in the group's plane. */
const _C4_PLANAR_INLIER_DEG = 2;

/**
 * Face-group normal that ignores foreign facets on a planar face.
 *
 * faceID is only unique within one source mesh, and every swept fillet cutter
 * is built with the same triangle numbering, so a cutter facet can carry the
 * same faceID as the flat face it touches. When it shares an edge with that
 * face it lands in the same connected component, and the old unweighted sum
 * of unit normals counted a 1.3 mm² fillet facet (normal 80° off) as much as
 * each big face triangle: on the three-fillet cube the +y wall read
 * (0.070, 0.997, 0.012), 4° off, and the next variable-profile fillet cut a
 * 94° section along it. When ≥ 90% of the group's area lies within 2° of its
 * area-weighted normal, the group is a plane: average only those triangles.
 * Curved groups (and clean planes, where every triangle is an inlier) keep
 * the plain sum `cn` exactly as before.
 */
function _c4PlanarGroupNormal(trisSub, mesh, V, cn, areaSum) {
  if (!(areaSum > 1e-18) || trisSub.length < 2) return _c4Norm(cn);
  const tns = [];
  const aw = [0, 0, 0];
  for (const t of trisSub) {
    const v0 = V[mesh.triVerts[t*3]], v1 = V[mesh.triVerts[t*3+1]], v2 = V[mesh.triVerts[t*3+2]];
    const cxv = _c4Cross(_c4Sub(v1, v0), _c4Sub(v2, v0));
    const area = 0.5 * _c4Len(cxv);
    aw[0] += cxv[0]; aw[1] += cxv[1]; aw[2] += cxv[2];
    tns.push({ n: _c4Norm(cxv), area });
  }
  if (_c4Len(aw) < 1e-18) return _c4Norm(cn);
  const awn = _c4Norm(aw);
  const cosIn = Math.cos((_C4_PLANAR_INLIER_DEG * Math.PI) / 180);
  const sum = [0, 0, 0];
  let inArea = 0;
  let outliers = 0;
  for (const { n, area } of tns) {
    if (_c4Dot(n, awn) > cosIn) {
      sum[0] += n[0]; sum[1] += n[1]; sum[2] += n[2];
      inArea += area;
    } else {
      outliers++;
    }
  }
  if (!outliers || inArea < _C4_PLANAR_INLIER_FRAC * areaSum || _c4Len(sum) < 0.5) return _c4Norm(cn);
  return _c4Norm(sum);
}

function c4MeshData(m) {
  const mesh = m.getMesh();
  const triBody = _triComponentIds(mesh.triVerts, mesh.numTri);
  const np = mesh.numProp;
  const V = [];
  // Vertex count = vertProperties length / numProp (NOT tri count — that silently
  // truncated V on welded meshes and read past the buffer on sparse ones).
  const nVerts = mesh.vertProperties.length / np;
  for (let i = 0; i < nVerts; i++)
    V.push([mesh.vertProperties[i*np], mesh.vertProperties[i*np+1], mesh.vertProperties[i*np+2]]);

  const faceMap = new Map();
  const triFace = [];
  for (let i = 0; i < mesh.numTri; i++) {
    const fid = mesh.faceID[i];
    triFace.push(fid);
    if (!faceMap.has(fid)) faceMap.set(fid, []);
    faceMap.get(fid).push(i);
  }
  const faces = [];
  const triToFace = new Int32Array(mesh.numTri).fill(-1);
  for (const [fid, tris] of faceMap) {
    const n = [0, 0, 0];
    for (const t of tris) {
      const v0 = V[mesh.triVerts[t*3]], v1 = V[mesh.triVerts[t*3+1]], v2 = V[mesh.triVerts[t*3+2]];
      const tn = _c4Norm(_c4Cross(_c4Sub(v1, v0), _c4Sub(v2, v0))); // outward (winding)
      n[0] += tn[0]; n[1] += tn[1]; n[2] += tn[2];
    }
    const nrm = _c4Norm(n);
    // Manifold may merge coplanar-but-DISCONNECTED regions into one faceID
    // (e.g. a base top ring at z=5 and a raised step top at z=15 both have
    // normal +Z), which breaks face `center` (mean of both planes) and
    // misplaces any feature cut from it. Split the group into CONNECTED
    // components (triangles sharing an edge). NOTE: must NOT use a
    // coplanarity condition — tessellated curved faces (fillets) have
    // non-coplanar adjacent facets, and shredding them re-creates the
    // per-seam face pairings that force expensive convexEdges ball probes
    // and break chamfer/fillet edge data.
    const parent = tris.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    const edgeTris = new Map();
    tris.forEach((t, gi) => {
      const vs = [mesh.triVerts[t*3], mesh.triVerts[t*3+1], mesh.triVerts[t*3+2]];
      for (let k = 0; k < 3; k++) {
        const u = vs[k], w = vs[(k+1) % 3];
        const key = u < w ? u * 1e9 + w : w * 1e9 + u;
        if (!edgeTris.has(key)) edgeTris.set(key, []);
        edgeTris.get(key).push(gi);
      }
    });
    for (const list of edgeTris.values())
      for (let i = 1; i < list.length; i++) union(list[0], list[i]);
    const byRoot = new Map();
    tris.forEach((t, gi) => {
      const r = find(gi);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(gi);
    });
    // Components that lie in the SAME plane AND the same body (e.g. an annulus
    // split into two regions by a groove, both at z=10) are re-merged into one
    // face so that queries see the original Manifold face. A cut that keeps
    // both pieces reuses that faceID across two bodies; those stay separate
    // so each body keeps its own contour. Curved faces never re-merge: their
    // connected components each span one plane offset, and a curved group is
    // a single connected component anyway.
    const offs = tris.map((t) => {
      const v0 = V[mesh.triVerts[t*3]];
      return nrm[0]*v0[0] + nrm[1]*v0[1] + nrm[2]*v0[2];
    });
    // The offset alone is not a plane test. faceID is only unique within one
    // source mesh, and every swept fillet cutter is built with the same
    // triangle numbering, so faceID k is a facet of EACH earlier fillet. On a
    // symmetric part two such facets on different fillets can sit at the same
    // offset along their averaged normal (measured: a +x top fillet facet and
    // a −x vertical fillet facet, normals 90° apart). Merged, the group normal
    // was 45° off both, signedFeatureEdges handed that to the next fillet as
    // the edge dihedral, and the variable-profile cutter cut a wrong section
    // there (the three-fillet corner blob). Re-merge only components whose
    // own normals agree.
    const compNormal = (gis) => {
      const n = [0, 0, 0];
      for (const gi of gis) {
        const t = tris[gi];
        const v0 = V[mesh.triVerts[t*3]], v1 = V[mesh.triVerts[t*3+1]], v2 = V[mesh.triVerts[t*3+2]];
        const tn = _c4Norm(_c4Cross(_c4Sub(v1, v0), _c4Sub(v2, v0)));
        n[0] += tn[0]; n[1] += tn[1]; n[2] += tn[2];
      }
      return _c4Norm(n);
    };
    const cosSamePlane = Math.cos((COPLANAR_PAIR_MIN_DEG * Math.PI) / 180);
    const planeGroups = new Map(); // offsetKey -> [{ n, gis }]
    for (const gis of byRoot.values()) {
      const key = `${triBody[tris[gis[0]]]}:${Math.round(offs[gis[0]] * 1e3)}`;
      if (!planeGroups.has(key)) planeGroups.set(key, []);
      const bucket = planeGroups.get(key);
      const cn = compNormal(gis);
      const hit = bucket.find((g) => _c4Dot(g.n, cn) > cosSamePlane);
      if (hit) hit.gis.push(...gis);
      else bucket.push({ n: cn, gis: gis.slice() });
    }
    const planeGroupList = [];
    for (const bucket of planeGroups.values()) for (const g of bucket) planeGroupList.push(g.gis);
    for (const gis of planeGroupList) {
      const cn = [0, 0, 0];
      const c = [0, 0, 0];
      let areaSum = 0;
      const all = [];
      const seenVert = new Set();
      const trisSub = gis.map(gi => tris[gi]);
      for (const t of trisSub) {
        const i0 = mesh.triVerts[t*3], i1 = mesh.triVerts[t*3+1], i2 = mesh.triVerts[t*3+2];
        const v0 = V[i0], v1 = V[i1], v2 = V[i2];
        const cxv = _c4Cross(_c4Sub(v1, v0), _c4Sub(v2, v0));
        const area = 0.5 * _c4Len(cxv);
        const tn = _c4Norm(cxv);
        cn[0] += tn[0]; cn[1] += tn[1]; cn[2] += tn[2];
        // Area-weighted triangle centroid (matches Viewport face pick center).
        const tc = [(v0[0]+v1[0]+v2[0])/3, (v0[1]+v1[1]+v2[1])/3, (v0[2]+v1[2]+v2[2])/3];
        c[0] += tc[0]*area; c[1] += tc[1]*area; c[2] += tc[2]*area;
        areaSum += area;
        for (const id of [i0, i1, i2]) {
          if (!seenVert.has(id)) { seenVert.add(id); all.push(V[id]); }
        }
      }
      const center = areaSum > 1e-18 ? _c4Mul(1/areaSum, c) : [0, 0, 0];
      faces.push({
        id: fid,
        tris: trisSub,
        normal: _c4PlanarGroupNormal(trisSub, mesh, V, cn, areaSum),
        center,
        verts: all,
        body: triBody[trisSub[0]],
      });
    }
  }
  faces.sort((a, b) => a.id - b.id);

  // ── Slice 12: merge coplanar connected faces ─────────────────────────
  // built/manifold.wasm (and some Manifold builds) assign a *unique faceID
  // per triangle*. Without this pass, a rectangular face is two one-tri
  // "faces" whose centers are triangle centroids — so workplaneFromFace +
  // hole(u=0,v=0) misses the true face center (playtest Center miss).
  // Merge only when adjacent faces share an edge, normals align, and plane
  // offsets match.
  //
  // Hotfix (occlusion/tangent/hole slice): use a tight 0.1° pairwise gate.
  // A 1° gate + union-find was transitive through fillet chord facets
  // (~0.23° steps on a 384-seg arc), absorbing the true planar top into a
  // frankenstein face whose averaged normal drifted >5° from +Z — then
  // facesByNormal(selNormal, 5) missed the face the Viewport chip showed.
  // Curved walls (normals diverge >0.1°) stay one-tri each so convexEdges
  // dihedral filtering still sees tessellation seams.
  {
    const nF = faces.length;
    if (nF > 1) {
      const parent = Array.from({ length: nF }, (_, i) => i);
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
      const t2f = new Int32Array(mesh.numTri).fill(-1);
      for (let fi = 0; fi < nF; fi++)
        for (const t of faces[fi].tris) t2f[t] = fi;
      const cosPlanar = Math.cos((0.1 * Math.PI) / 180);
      const edgeMapM = new Map();
      for (let t = 0; t < mesh.numTri; t++) {
        const vs = [mesh.triVerts[t*3], mesh.triVerts[t*3+1], mesh.triVerts[t*3+2]];
        for (let k = 0; k < 3; k++) {
          const u = vs[k], w = vs[(k+1)%3];
          const key = u < w ? u * 1e9 + w : w * 1e9 + u;
          if (!edgeMapM.has(key)) edgeMapM.set(key, []);
          edgeMapM.get(key).push(t);
        }
      }
      for (const trisE of edgeMapM.values()) {
        if (trisE.length !== 2) continue;
        const f0 = t2f[trisE[0]], f1 = t2f[trisE[1]];
        if (f0 < 0 || f1 < 0 || f0 === f1) continue;
        if (triBody[trisE[0]] !== triBody[trisE[1]]) continue;
        const A = faces[f0], B = faces[f1];
        if (_c4Dot(A.normal, B.normal) < cosPlanar) continue;
        const offA = A.center[0]*A.normal[0] + A.center[1]*A.normal[1] + A.center[2]*A.normal[2];
        const offB = B.center[0]*A.normal[0] + B.center[1]*A.normal[1] + B.center[2]*A.normal[2];
        if (Math.abs(offA - offB) > 1e-3) continue;
        union(f0, f1);
      }
      const groups = new Map();
      for (let fi = 0; fi < nF; fi++) {
        const r = find(fi);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(fi);
      }
      if (groups.size < nF) {
        const merged = [];
        for (const members of groups.values()) {
          if (members.length === 1) {
            merged.push(faces[members[0]]);
            continue;
          }
          const cn = [0, 0, 0];
          const c = [0, 0, 0];
          let areaSum = 0;
          const all = [];
          const seenVert = new Set();
          const trisSub = [];
          let id = faces[members[0]].id;
          for (const fi of members) {
            id = Math.min(id, faces[fi].id);
            for (const t of faces[fi].tris) {
              trisSub.push(t);
              const i0 = mesh.triVerts[t*3], i1 = mesh.triVerts[t*3+1], i2 = mesh.triVerts[t*3+2];
              const v0 = V[i0], v1 = V[i1], v2 = V[i2];
              const cxv = _c4Cross(_c4Sub(v1, v0), _c4Sub(v2, v0));
              const area = 0.5 * _c4Len(cxv);
              const tn = _c4Norm(cxv);
              cn[0] += tn[0]; cn[1] += tn[1]; cn[2] += tn[2];
              const tc = [(v0[0]+v1[0]+v2[0])/3, (v0[1]+v1[1]+v2[1])/3, (v0[2]+v1[2]+v2[2])/3];
              c[0] += tc[0]*area; c[1] += tc[1]*area; c[2] += tc[2]*area;
              areaSum += area;
              for (const vi of [i0, i1, i2]) {
                if (!seenVert.has(vi)) { seenVert.add(vi); all.push(V[vi]); }
              }
            }
          }
          const center = areaSum > 1e-18 ? _c4Mul(1/areaSum, c) : faces[members[0]].center;
          merged.push({
            id,
            tris: trisSub,
            normal: _c4Norm(cn),
            center,
            verts: all,
            body: faces[members[0]].body,
          });
        }
        faces.length = 0;
        faces.push(...merged);
        faces.sort((a, b) => a.id - b.id);
      }
    }
  }

  // Within each faceID group, order sub-faces OUTERMOST-FIRST in the face's
  // normal direction (desc by n·center): for a merged group of parallel
  // planes (e.g. two +Z planes at z=5 and z=15), facesByNormal(+Z)[0] is the
  // topmost plane — what a "top face" query almost always means.
  {
    const byId = new Map();
    for (const f of faces) { if (!byId.has(f.id)) byId.set(f.id, []); byId.get(f.id).push(f); }
    for (const list of byId.values())
      list.sort((a, b) => {
        const oa = a.center[0]*a.normal[0] + a.center[1]*a.normal[1] + a.center[2]*a.normal[2];
        const ob = b.center[0]*b.normal[0] + b.center[1]*b.normal[1] + b.center[2]*b.normal[2];
        return ob - oa;
      });
  }
  // Build triToFace AFTER all sorts — indices assigned at push-time would be
  // stale once faces is re-ordered. This map is what edges/convexEdges use to
  // reach each triangle's true (sub-)face.
  triToFace.fill(-1);
  for (let fi = 0; fi < faces.length; fi++)
    for (const t of faces[fi].tris) triToFace[t] = fi;
  const faceIdxById = new Map(faces.map((f, i) => [f.id, i]));

  // edges: weld key = sorted vertex pair
  const edgeMap = new Map();
  for (let t = 0; t < mesh.numTri; t++) {
    const vs = [mesh.triVerts[t*3], mesh.triVerts[t*3+1], mesh.triVerts[t*3+2]];
    for (let k = 0; k < 3; k++) {
      const u = vs[k], w = vs[(k+1) % 3];
      const key = u < w ? u * 1e9 + w : w * 1e9 + u;
      if (!edgeMap.has(key)) edgeMap.set(key, { a: u, b: w, tris: [] });
      edgeMap.get(key).tris.push(t);
    }
  }
  const edges = [];
  for (const e of edgeMap.values()) {
    if (e.tris.length !== 2) continue; // interior/defect: not a real boundary edge
    // triToFace: each triangle -> its (sub-)face index. After the coplanar
    // connected-component split, a faceID may own several faces, so the
    // triangle's face MUST come from triToFace, not faceIdxById.
    const f0 = triToFace[e.tris[0]];
    const f1 = triToFace[e.tris[1]];
    // canonical direction: lower-ordered vertex first (stable, undirected)
    const [a, b] = e.a < e.b ? [e.a, e.b] : [e.b, e.a];
    let tangent = _c4Sub(V[b], V[a]);
    if (_c4Len(tangent) < 1e-9) {
      tangent = _c4Norm(_c4Cross(faces[f0].normal, faces[f1].normal));
    }
    tangent = _c4Norm(tangent);
    edges.push({ a, b, va: V[a], vb: V[b], tris: e.tris, tangent, faces: [f0, f1] });
  }
  // T/numTri expose the welded triangle table so callers that need per-triangle
  // vertices (shell skin prisms, draftFaces vertex sets) do not have to call
  // getMesh() again and risk a DIFFERENT welding than the faces above.
  if (_s23CaptureFaceSoupOn) _s23RememberFaceSoup(m, faces, V, mesh.triVerts);
  return { V, faces, edges, faceIdxById, T: mesh.triVerts, numTri: mesh.numTri };
}

// ---------------------------------------------------------------- selectors
/**
 * facesByNormal(m, dir, tolDeg=1) — faces whose normal is within tolDeg of dir.
 * dir e.g. [0,0,1] (>Z) or [0,0,-1] (<Z).
 */
function facesByNormal(m, dir, tolDeg = 1) {
  const d = _c4Norm(dir);
  const cosT = Math.cos((tolDeg * Math.PI) / 180);
  // Outermost-first along dir so facesByNormal(+Z)[0] is the topmost plane
  // (byId re-sort below does not rewrite the faces array order).
  return c4MeshData(m).faces
    .filter(f => _c4Dot(f.normal, d) >= cosT)
    .sort((a, b) => _c4Dot(b.center, d) - _c4Dot(a.center, d));
}

/**
 * planarFaceAt(m, axis, value, tol=1e-3) — the face lying in plane axis==value
 * (axis 'x'|'y'|'z'). Returns null if absent, throws if ambiguous.
 */
function planarFaceAt(m, axis, value, tol = 1e-3) {
  const i = { x: 0, y: 1, z: 2 }[axis.toLowerCase()];
  if (i === undefined) throw new Error(`planarFaceAt: bad axis '${axis}'`);
  const n = [0, 0, 0]; n[i] = 1;
  const cands = c4MeshData(m).faces.filter(f =>
    Math.abs(Math.abs(_c4Dot(f.normal, n)) - 1) < 0.01 &&
    f.verts.every(v => Math.abs(v[i] - value) < tol));
  if (cands.length === 0) return null;
  if (cands.length > 1) throw new Error(`planarFaceAt: ${cands.length} faces at ${axis}=${value}`);
  return cands[0];
}

/**
 * edgesByOrientation(m, axis, dir, tolDeg=5)
 *  axis 'x'|'y'|'z'  -> edges parallel to that axis
 *  dir 1 | -1 | null -> one-sided / both
 */
function edgesByOrientation(m, axis, dir = null, tolDeg = 5) {
  const i = { x: 0, y: 1, z: 2 }[axis.toLowerCase()];
  if (i === undefined) throw new Error(`edgesByOrientation: bad axis '${axis}'`);
  const ax = [0, 0, 0]; ax[i] = 1;
  const cosT = Math.cos((tolDeg * Math.PI) / 180);
  return c4MeshData(m).edges.filter(e => {
    const s = _c4Dot(e.tangent, ax); // in [-1, 1]
    if (dir === 1 && s < cosT) return false;
    if (dir === -1 && s > -cosT) return false;
    return Math.abs(s) >= cosT;
  });
}

/**
 * workplaneFromFace(m, face) -> { center, normal, x, y }
 * Local 2D frame on the face. center = face centroid, normal = outward face
 * normal, and the in-plane axes x,y are DETERMINISTIC + AXIS-ALIGNED so
 * (u,v) map to predictable world directions (a transpiler/LLM can reason
 * about them):
 *   x = the world axis most in-plane with the face (smallest |n·axis|),
 *       ties broken by axis index (X > Y > Z); y = normal × x.
 * So: +Z face -> u→+X, v→+Y ; -Z -> u→+X, v→-Y ; +X -> u→+Y, v→+Z ;
 *     -X -> u→+Y, v→-Z ; +Y -> u→+X, v→-Z ; -Y -> u→+X, v→+Z.
 * (Non-axis-aligned faces, e.g. a 45° chamfer, fall back to the
 * first-vertex direction.)
 * (pass a face object from facesByNormal/planarFaceAt, or a face index into m)
 */
function workplaneFromFace(m, face) {
  if (typeof face === 'number') face = c4MeshData(m).faces[face];
  const normal = _c4Norm(face.normal);
  const worldAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let x = null, best = Infinity;
  for (const a of worldAxes) {
    const s = Math.abs(_c4Dot(normal, a));
    if (s < best - 1e-9) { best = s; x = a; }
  }
  if (best > 0.9) { // face normal is diagonal — no world axis is in-plane
    const w = face.verts.find(v => _c4Len(_c4Sub(v, face.center)) > 1e-9) || face.verts[0];
    x = _c4Sub(w, face.center);
    x = _c4Sub(x, _c4Mul(_c4Dot(x, normal), normal)); // project onto plane
    if (_c4Len(x) < 1e-9) x = Math.abs(normal[2]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  }
  x = _c4Norm(x);
  const y = _c4Norm(_c4Cross(normal, x));
  return { center: face.center, normal, x, y };
}

// ---------------------------------------------------------------- frames
// frameToMatrix(frame) -> flat 16 for Manifold .transform(m).
// CONVENTION (empirically verified): Manifold applies world = localRow · M
// (row-vector), so the frame axes must be packed as ROWS:
//   row0 = frame.x, row1 = frame.y, row2 = frame.normal, row3 = center.
// (Packing them as columns silently transposes the rotation — invisible
// for axis-aligned faces, wrong for arbitrary face normals.)
function frameToMatrix(frame) {
  const z = frame.normal, x = frame.x, y = frame.y, c = frame.center;
  return [
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    c[0], c[1], c[2], 1,
  ];
}

/**
 * placeInFrame(frame, solid, uvw = [0, 0, 0])
 * Transform `solid` so its local origin lands at
 * center + u·x + v·y + w·normal, axes aligned to (x, y, normal).
 * `frame` is a PlaneFrame { center, normal, x, y } — never a Manifold.
 * Does not take a host part; caller assigns the result (replace, not add).
 */
function placeInFrame(frame, solid, uvw = [0, 0, 0]) {
  if (frame && typeof frame.status === 'function') {
    throw new Error('placeInFrame: frame must be a PlaneFrame { center, normal, x, y }, not a Manifold solid');
  }
  if (!frame || !frame.center || !frame.normal || !frame.x || !frame.y) {
    throw new Error('placeInFrame: frame must be a PlaneFrame { center, normal, x, y }');
  }
  if (!solid || typeof solid.status !== 'function') {
    throw new Error('placeInFrame: solid must be a Manifold');
  }
  const u = Number(uvw?.[0]) || 0;
  const v = Number(uvw?.[1]) || 0;
  const w = Number(uvw?.[2]) || 0;
  const x = frame.x, y = frame.y, n = frame.normal, c = frame.center;
  const t = frameToMatrix({
    center: [
      c[0] + u * x[0] + v * y[0] + w * n[0],
      c[1] + u * x[1] + v * y[1] + w * n[1],
      c[2] + u * x[2] + v * y[2] + w * n[2],
    ],
    x,
    y,
    normal: n,
  });
  return solid.transform(t);
}

/** Alias — same frame-only replace transform as placeInFrame. */
function transformByFrame(frame, solid, uvw = [0, 0, 0]) {
  return placeInFrame(frame, solid, uvw);
}

/**
 * placeOnFace(part, frame, builder) — run builder in the face's local frame.
 * builder receives { Manifold: statics, frame, put } where put(m, [u,v,w])
 * returns m transformed so its local origin lands at
 * center + u·x + v·y + w·normal (w is along the outward normal), with its
 * local axes aligned to (x, y, normal). Lets scripts write axis-aligned
 * geometry for arbitrary face normals.
 *
 * `part` is unused (legacy host arg). New-body Confirm should assign
 * placeInFrame/transformByFrame instead of placeOnFace + part.add.
 */
function placeOnFace(part, frame, builder) {
  void part;
  const M = manifoldModule.Manifold;
  const built = builder({
    Manifold: M,
    frame,
    put: (mm, offset) => placeInFrame(frame, mm, offset),
  });
  if (!built || typeof built.status !== 'function')
    throw new Error('placeOnFace: builder must return a Manifold');
  return built;
}

// ---------------------------------------------------------------- features
/**
 * hole(part, frame, u, v, dia, span) — cut a round hole through `part`.
 * frame from workplaneFromFace; (u,v) local coords (mm), span = cut length
 * along the outward normal from the face (use holeSpan() for full thickness).
 * Returns the cut part.
 */
function hole(part, frame, u, v, dia, span) {
  _c4RequirePositive('hole', 'dia', dia);
  _c4RequirePositive('hole', 'span', span);
  if (!frame || !frame.normal || !frame.center || !frame.x || !frame.y) {
    throw new Error('hole: frame must come from workplaneFromFace (needs center/normal/x/y)');
  }
  const M = manifoldModule.Manifold;
  const cut = _c4PutCyl(M, frame, u, v, dia, span);
  return _c4RequireValidSolid(M.difference(part, cut), 'hole');
}
// _c4PutCyl: centered cylinder anchored so it spans w ∈ [1, 1-len] in frame
// space (1mm outside the face, len-1mm INTO the solid).
function _c4PutCyl(M, frame, u, v, dia, len) {
  const n = frame.normal;
  const c = _c4Add(_c4Add(frame.center, _c4Mul(u, frame.x)), _c4Mul(v, frame.y));
  const w0 = 1 - len / 2; // centered body covers w0 ± len/2 = [1-len, 1]
  const t = frameToMatrix({ center: [
    c[0] + n[0] * w0, c[1] + n[1] * w0, c[2] + n[2] * w0,
  ], x: frame.x, y: frame.y, normal: n });
  return M.cylinder(len, dia/2, dia/2, 48, true).transform(t);
}

/**
 * holeSpan(part, frame) — full extent of the part measured along the frame
 * normal (both directions from the face plane) + 2mm overshoot. A safe
 * full-through cut length from that face.
 */
function holeSpan(part, frame) {
  const bb = part.boundingBox();
  const corners = [
    [bb.min[0], bb.min[1], bb.min[2]], [bb.max[0], bb.min[1], bb.min[2]],
    [bb.min[0], bb.max[1], bb.min[2]], [bb.max[0], bb.max[1], bb.min[2]],
    [bb.min[0], bb.min[1], bb.max[2]], [bb.max[0], bb.min[1], bb.max[2]],
    [bb.min[0], bb.max[1], bb.max[2]], [bb.max[0], bb.max[1], bb.max[2]],
  ];
  let minW = Infinity, maxW = -Infinity;
  for (const p of corners) {
    const w = _c4Dot(_c4Sub(p, frame.center), frame.normal);
    minW = Math.min(minW, w);
    maxW = Math.max(maxW, w);
  }
  return (maxW - minW) + 2; // +2mm overshoot
}

/**
 * cboreHole(part, frame, u, v, diaThru, diaCbore, cboreDepth, span)
 * — through hole + larger counterbore from the face. (CadQuery cboreHole)
 */
function cboreHole(part, frame, u, v, diaThru, diaCbore, cboreDepth, span) {
  _c4RequirePositive('cboreHole', 'diaThru', diaThru);
  _c4RequirePositive('cboreHole', 'diaCbore', diaCbore);
  _c4RequirePositive('cboreHole', 'cboreDepth', cboreDepth);
  _c4RequirePositive('cboreHole', 'span', span);
  if (!(diaCbore > diaThru)) {
    throw new Error(`cboreHole: diaCbore (${diaCbore}) must be > diaThru (${diaThru})`);
  }
  if (!frame || !frame.normal || !frame.center || !frame.x || !frame.y) {
    throw new Error('cboreHole: frame must come from workplaneFromFace (needs center/normal/x/y)');
  }
  const M = manifoldModule.Manifold;
  const thru = _c4PutCyl(M, frame, u, v, diaThru, span);
  const cbore = _c4PutCyl(M, frame, u, v, diaCbore, cboreDepth + 1); // [−depth, +1]
  return _c4RequireValidSolid(M.difference(M.difference(part, thru), cbore), 'cboreHole');
}

/**
 * cskHole(part, frame, u, v, diaThru, diaCsk, cskDepth, span)
 * — through hole + cone countersink: the cone spans diaThru→diaCsk over
 * cskDepth (118° style for cskDepth ≈ 1.17·(diaCsk−diaThru)/2).
 * (CadQuery cskHole)
 */
function cskHole(part, frame, u, v, diaThru, diaCsk, cskDepth, span) {
  _c4RequirePositive('cskHole', 'diaThru', diaThru);
  _c4RequirePositive('cskHole', 'diaCsk', diaCsk);
  _c4RequirePositive('cskHole', 'cskDepth', cskDepth);
  _c4RequirePositive('cskHole', 'span', span);
  if (!(diaCsk > diaThru)) {
    throw new Error(`cskHole: diaCsk (${diaCsk}) must be > diaThru (${diaThru})`);
  }
  if (!frame || !frame.normal || !frame.center || !frame.x || !frame.y) {
    throw new Error('cskHole: frame must come from workplaneFromFace (needs center/normal/x/y)');
  }
  const M = manifoldModule.Manifold;
  const thru = _c4PutCyl(M, frame, u, v, diaThru, span);
  // Exact csk frustum: small end (diaThru) at depth cskDepth below the face,
  // big end (diaCsk) flush at the face. Cylinder rLow sits at local z0
  // (bottom), rHigh at the top; frame row-packing maps local +z to the
  // OUTWARD normal. Length = cskDepth, centered at w0 = -cskDepth/2 so the
  // body spans w ∈ [-cskDepth, 0] (0 = face plane, - = into the solid).
  const n = frame.normal;
  const c = _c4Add(_c4Add(frame.center, _c4Mul(u, frame.x)), _c4Mul(v, frame.y));
  const cone = M.cylinder(cskDepth, diaThru/2, diaCsk/2, 48, true); // rLow small
  const w0 = -cskDepth / 2;
  const t = frameToMatrix({ center: [
    c[0] + n[0] * w0, c[1] + n[1] * w0, c[2] + n[2] * w0,
  ], x: frame.x, y: frame.y, normal: n });
  return _c4RequireValidSolid(
    M.difference(M.difference(part, thru), cone.transform(t)),
    'cskHole',
  );
}

/**
 * chamferEdges(part, edges, c) — equal-leg 45° chamfer c on a SET of straight
 * convex edges. Edges = objects from c4MeshData/convexEdges, or a plain
 * [{va, vb, n0, n1}] array. n0/n1 (outward normals of the two adjacent faces
 * at that edge) are REQUIRED for hand-built edges, but are AUTO-DERIVED from
 * the current mesh when the edge object carries {faces: [i0, i1]} (as all
 * c4MeshData-based selectors do: convexEdges, edgesByOrientation,
 * edgesByNormal, planarFaceAt-derived selections) — no more
 * "Cannot read properties of undefined (reading '0')" when mixing selectors
 * with chamferEdges.
 *
 * Construction (verified, C2 pilot + C4): per edge, cutter = hull of the two
 * edge endpoints plus four corner points pulled c into each adjacent face
 * interior. c IS THE LEG LENGTH along each adjacent face (CAD "C2" = 2 mm
 * on both legs), NOT the perpendicular face offset — the perpendicular
 * offset is derived from the face-to-face angle (offset = c·tan(θ/2), θ =
 * angle between n0/n1; at a 90° corner they coincide, at a 120° hex-nut
 * corner C2 → 1.155 mm offset / 2 mm legs). CUTTERS ARE APPLIED SEQUENTIALLY (one difference per edge) and
 * each intermediate result is checked: a single degenerate cutter (e.g. at
 * a triple-junction rib-base edge where the two "adjacent faces" are coplanar
 * or the cutter self-intersects) must not be allowed to wedge the batch
 * union into a wasm out-of-bounds trap (observed: chamfering ALL convex
 * edges of a ribbed plate — one subset crashes the kernel while the rest
 * build fine). The first bad edge throws a named, actionable error instead.
 * Cost: n differences instead of 1 — fine for the edge counts these parts
 * actually use (≤ ~30); the C8 timeout guard catches anything pathological.
 */
function chamferEdges(part, edges, c) {
  _c4RequirePositive('chamferEdges', 'c (leg length)', c);
  const M = manifoldModule.Manifold;
  if (!edges || !edges.length) return part;
  let data = null;
  const laz = () => (data ||= c4MeshData(part));
  let out = part;
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const p0 = e.va, p1 = e.vb;
    if (!p0 || !p1) throw new Error(`chamferEdges: edge ${ei} has no va/vb coordinates`);
    const len = _c4Len(_c4Sub(p1, p0));
    if (len < 1e-9) continue;
    const d = _c4Mul(1/len, _c4Sub(p1, p0));
    // adjacent face normals: use provided n0/n1, else derive from the mesh
    // via e.faces (present on all c4MeshData-derived edge objects).
    let n0 = e.n0, n1 = e.n1;
    if ((!n0 || !n1) && Array.isArray(e.faces) && e.faces.length === 2) {
      const ds = laz();
      n0 = ds.faces[e.faces[0]].normal;
      n1 = ds.faces[e.faces[1]].normal;
    }
    if (!n0 || !n1)
      throw new Error(`chamferEdges: edge ${ei} has no adjacent face normals (n0/n1) — get the edge from convexEdges()/edgesByOrientation() on THIS part, or pass explicit n0/n1`);
    if (_c4Dot(n0, n1) > 0.9999)
      throw new Error(`chamferEdges: edge ${ei} — adjacent faces are coplanar (tessellation seam or wrong face pair); not a chamferable edge`);
    // offset c INTO each adjacent face: (-n) projected perpendicular to the
    // edge direction. This is a unit direction lying IN the face plane,
    // pointing toward the face interior (negated normal = into the solid).
    const off = (n) => {
      const t = _c4Dot(_c4Mul(-1, n), d);
      return _c4Mul(c, _c4Norm(_c4Sub(_c4Mul(-1, n), _c4Mul(t, d))));
    };
    const a0 = off(n0), a1 = off(n1);
    const cutter = M.hull([
      p0, p1,
      _c4Add(p0, a0), _c4Add(p0, a1),
      _c4Add(p1, a0), _c4Add(p1, a1),
    ]);
    const seCutter = _c4StatusError(cutter);
    if (seCutter)
      throw new Error(`chamferEdges: edge ${ei} — degenerate cutter (hull status ${seCutter}); check the two adjacent faces at this edge`);
    const next = M.difference(out, cutter);
    const seNext = _c4StatusError(next);
    if (seNext)
      throw new Error(`chamferEdges: edge ${ei} — boolean failed (${seNext}); the cutter geometry is degenerate at this edge (common at triple-junction rib-base edges)`);
    out = next;
  }
  return out;
}

/**
 * Ball-probe-equivalent feature threshold (degrees).
 *
 * The old convexity test intersected a small sphere at each edge midpoint with
 * the whole solid and kept `f < 0.45`. Measured across box / cylinder / sphere /
 * L-shape / loft, that fraction is exactly `(180 - dihedralDeg) / 360` — the
 * probe was a dihedral threshold wearing a CSG costume, at ~4.5 ms per edge
 * (5.5 s of a 5.6 s loft fillet). `f < 0.45` ⇔ dihedral > 18°.
 *
 * It was also WRONG on fine meshes: on a 384-segment filleted box the probe
 * sphere shrinks to ~0.012 mm, where Manifold's boolean returns f = 0.5 for
 * plainly 90° edges and even negative volumes. The local test below has no
 * such scale dependence.
 */
const FEATURE_EDGE_MIN_DEG = 18;

/**
 * Coplanarity gate on the FACE-GROUP normal pair that these helpers return.
 * Downstream (chamferEdges, the fillet framing) consumes n0/n1 and loud-fails
 * on a coplanar pair, so the returned pair must clear this independently of
 * the per-triangle dihedral used for the sign.
 */
const COPLANAR_PAIR_MIN_DEG = 2;

/** Area of triangle `ti`, for spotting degenerate slivers. */
function _c4TriArea(tri) {
  return 0.5 * _c4Len(_c4Cross(_c4Sub(tri.v[1], tri.v[0]), _c4Sub(tri.v[2], tri.v[0])));
}

/**
 * Signed feature edges — convex AND concave, by a local winding test.
 *
 * Sign: `dot(cross(n0, n1), dir) > 0` is convex, `< 0` is concave, where `dir`
 * is the edge as wound in the triangle whose normal is n0. Winding is what
 * carries the inside/outside information; a dot product alone cannot tell a 90°
 * convex edge from a 270° concave one (they share the same normal angle).
 *
 * Normals come from the adjacent TRIANGLES, not the face groups: a face group's
 * normal is an area-weighted average, and on a curved group (a fillet sail) it
 * points nowhere near the local surface, which flips the cross product. Where a
 * triangle is a degenerate sliver — tessellated lofts carry hundreds — its
 * normal is meaningless, so the face-group normal stands in for it instead.
 *
 * `e.tris[i]` is the triangle belonging to face group `e.faces[i]`, so the
 * substitution always pairs a triangle with its own group.
 *
 * @param {Manifold} m
 * @param {number} [minAngleDeg] dihedral gate; raised to FEATURE_EDGE_MIN_DEG
 * @returns {object[]} edges with { n0, n1, convex, dihedralDeg }
 */
function signedFeatureEdges(m, minAngleDeg = FEATURE_EDGE_MIN_DEG) {
  const data = c4MeshData(m);
  const info = _c6BuildMeshInfo(m);
  const gate = Math.max(Number(minAngleDeg) || 0, FEATURE_EDGE_MIN_DEG);
  const cosGate = Math.cos((gate * Math.PI) / 180);
  // The old helper's coplanarity pre-gate, kept verbatim at its 2° default.
  const cosContract = Math.cos((COPLANAR_PAIR_MIN_DEG * Math.PI) / 180);
  const out = [];
  for (const e of data.edges) {
    const g0 = data.faces[e.faces[0]].normal;
    const g1 = data.faces[e.faces[1]].normal;
    const i0 = e.tris[0];
    const i1 = e.tris[1];
    const t0 = info.tris[i0];
    const t1 = info.tris[i1];
    if (!t0 || !t1) continue;
    const eLen = _c4Len(_c4Sub(e.vb, e.va));
    if (!(eLen > 0)) continue;
    // Relative sliver test: a 384-segment fillet's triangles are tiny but valid,
    // so an absolute area floor would reject the whole blend surface.
    const slivEps = 1e-6 * eLen * eLen;
    const tOK0 = _c4TriArea(t0) > slivEps;
    const tOK1 = _c4TriArea(t1) > slivEps;
    // c4MeshData sums a face group's triangle normals; on difference-derived
    // solids a group can span opposing patches and cancel to the zero vector
    // (measured: 13 of 17 convex edges on an L-shape). Those zeros used to
    // flow straight into the fillet framing as n0/n1. Prefer the group normal,
    // but fall back to the triangle when the group degenerates.
    const gOK0 = _c4Len(g0) > 0.5;
    const gOK1 = _c4Len(g1) > 0.5;
    if ((!tOK0 && !gOK0) || (!tOK1 && !gOK1)) continue;
    const n0 = tOK0 ? t0.n : g0;
    const n1 = tOK1 ? t1.n : g1;
    const outN0 = gOK0 ? g0 : t0.n;
    const outN1 = gOK1 ? g1 : t1.n;
    // Gate 1 (consumer contract): the normals this helper RETURNS are the
    // face-group pair, and chamferEdges / the fillet framing reject a coplanar
    // pair. Gating on the triangle normals alone would hand them edges whose
    // group normals are coplanar — a real regression the pilot caught.
    if (_c4Dot(outN0, outN1) > cosContract) continue;
    // Gate 2 (feature): dihedral must clear the ball-probe-equivalent threshold.
    const dot = _c4Dot(n0, n1);
    if (dot > cosGate) continue; // coplanar / tessellation seam / below gate
    // Edge as wound in t0. Vertex ORDER survives degeneracy even when the
    // normal does not, so this stays valid for sliver triangles.
    let dir = null;
    for (let k = 0; k < 3; k++) {
      const u = t0.vs[k];
      const w = t0.vs[(k + 1) % 3];
      if ((u === e.a && w === e.b) || (u === e.b && w === e.a)) {
        dir = _c4Sub(t0.v[(k + 1) % 3], t0.v[k]);
        break;
      }
    }
    if (!dir) continue;
    const convex = _c4Dot(_c4Cross(n0, n1), dir) > 0;
    const dihedralDeg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    out.push({ ...e, n0: outN0, n1: outN1, convex, dihedralDeg });
  }
  return out;
}

/**
 * convexEdges(m, minAngleDeg) — genuine convex feature edges.
 * Thin filter over signedFeatureEdges; see FEATURE_EDGE_MIN_DEG for why the
 * ball probe it replaced was both slow and scale-dependent.
 * n0/n1 stay the FACE-GROUP normals, which is what the fillet framing consumes.
 */
function convexEdges(m, minAngleDeg = FEATURE_EDGE_MIN_DEG) {
  return signedFeatureEdges(m, minAngleDeg).filter((e) => e.convex);
}

/**
 * concaveEdges(m, minAngleDeg) — genuine concave (interior) feature edges.
 * Rounding these is material ADD, not remove; see filletAlongPath.
 */
function concaveEdges(m, minAngleDeg = FEATURE_EDGE_MIN_DEG) {
  return signedFeatureEdges(m, minAngleDeg).filter((e) => !e.convex);
}

// ---------------------------------------------------------------- hole patterns
/**
 * holePattern(part, frame, { n, m, spacingU, spacingV, dia, span, u0=0, v0=0 })
 * — linear grid of through holes (CadQuery rarray idiom).
 * Grid centered on the face center + (u0, v0) offset.
 */
function holePattern(part, frame, opts) {
  const { n = 1, m = 1, spacingU = 10, spacingV = 10, dia = 2, span, u0 = 0, v0 = 0 } = opts;
  _c4RequirePositive('holePattern', 'dia', dia);
  if (!frame || !frame.normal || !frame.center || !frame.x || !frame.y) {
    throw new Error('holePattern: frame must come from workplaneFromFace (needs center/normal/x/y)');
  }
  const sp = span ?? holeSpan(part, frame);
  let out = part;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const u = u0 + (i - (n-1)/2) * spacingU;
      const v = v0 + (j - (m-1)/2) * spacingV;
      out = hole(out, frame, u, v, dia, sp);
    }
  }
  return out;
}

// ---------------------------------------------------------------- fastener holes (slice 01 puzzle vocabulary)
/**
 * clearanceHole(part, frame, u, v, size, spanOrOpts?, fit?)
 * Cut a clearance hole for fastener `size` ('M3', 3, '#8-32', …).
 * fit: 'close'|'normal'|'loose' (default 'normal'). span defaults to holeSpan().
 * Also accepts opts object: { fit, span }.
 */
function clearanceHole(part, frame, u, v, size, spanOrOpts, fitArg) {
  let fit = 'normal';
  let span;
  if (spanOrOpts && typeof spanOrOpts === 'object' && !Array.isArray(spanOrOpts)) {
    fit = spanOrOpts.fit ?? 'normal';
    span = spanOrOpts.span;
  } else {
    span = spanOrOpts;
    if (fitArg != null) fit = fitArg;
  }
  const dia = fastenerClearanceDia(size, fit);
  const sp = span ?? holeSpan(part, frame);
  return hole(part, frame, u, v, dia, sp);
}

/**
 * tapDrillHole(part, frame, u, v, size, span?)
 * Cut a tap-drill hole for fastener `size` (for subsequent tapping).
 * span defaults to holeSpan().
 */
function tapDrillHole(part, frame, u, v, size, span) {
  const dia = fastenerTapDrillDia(size);
  const sp = span ?? holeSpan(part, frame);
  return hole(part, frame, u, v, dia, sp);
}

// ============================================================================
// C6 — Fillet helper (Manifold JS has no native fillet; this is the v1/v2
// geometric construction). v1 ported from cadgen-workspace/harness/c6_fillet.mjs
// (8 harness tests green, 08-25). v2 (09-08) adds CLOSED CIRCULAR RUN
// support so a tessellated circular edge (a hole rim, an outer cylinder rim
// — any curved surface meeting a planar face, which Manifold represents as
// a LOOP of many short straight mesh edges) fillets as ONE feature instead
// of silently losing its fillet edge-by-edge. This was a real, verified
// bug: a Ø12 hole rim at 48 segs has ~0.78mm segments, and r=1 needs
// t=1 > 0.45·0.78 — every single segment failed the old "tessellation
// sliver" guard and got skipped, part-wide, with no error.
//
// Per SINGLETON edge (both adjacent faces planar, edge convex, v1 —
// unchanged):
//   Cross-section perpendicular to the edge: the two faces meet at interior
//   angle θ (material side). A fillet arc of radius r is tangent to both
//   faces at distance t = r/tan(θ/2) from the corner, centered on the
//   INTERIOR angle bisector at distance r/sin(θ/2). Removed cross-section
//   (sliver between corner and arc) = r·t − ½·r²·(π − θ)  (90°: r²(1−π/4)).
//   Boundary rays f0/f1 (in-face, from the corner into the material) are
//   derived from the ADJACENT TRIANGLES' third vertices — NOT face normals
//   (valid at 90° only) and NOT faceID groups (Manifold can merge faces
//   from different planes, or both edge triangles, into one faceID —
//   verified on a box cut by a slanted prism, 08-25).
//   Cutter = parallelepiped(t·f0, t·f1, edge) − cylinder(r, on bisector
//   line); exact for every θ. Cutters for a SET of edges are unioned and
//   subtracted once (same batching as chamferEdges) — shared-corner
//   overlaps are counted once, matching analytic inclusion-exclusion.
//
// CLOSED CIRCULAR RUNS (v2): a maximal chain of INPUT edges that (a) share
// consecutive mesh vertices, (b) turn <=30° at each shared vertex
// (tangent-continuous — a genuine polygon corner turns 60-180°; a
// tessellated circle turns 360/segs°, which is <=30° for any segs>=12),
// and (c) keep the SAME θ (within 3°) and SAME r, are merged into a run;
// if the chain walk closes on itself, that run is a candidate circular rim.
//
// FIRST ATTEMPT (rejected by measurement, keeping the note as a warning):
// re-using the exact per-segment parallelepiped/cylinder cutter for every
// segment in the run (just not skipping short ones) looks tempting — v1
// already unions all cutters and subtracts once, so it seems like "batching
// was never the problem, only the length guard was." It is WRONG whenever
// t is not small relative to the segment length L (exactly the case a real
// fillet radius on a coarse rim produces, e.g. r=5 on a 96-seg, 2.6mm-pitch
// rim has t=5 ≈ 2·L): each segment's box/cylinder overshoots its own
// [0,L] span by a large fraction of L, so neighboring segments' cutters —
// each tilted slightly differently around the curve — overlap heavily and
// produce either a wasm trap (measured: part 95d717e6 crashed with "memory
// access out of bounds") or a badly wrong volume (measured: part b0c16861
// went from 0.7% symRel to 8.1%, removing ~640mm³ against an analytic
// ~35mm³). Verified on the actual regression corpus before shipping —
// see fillet-fix/FIX_REPORT.md.
//
// ACTUAL v2 CONSTRUCTION: a closed run is fit to an exact circle (3-point
// circumcircle through 3 well-separated run vertices, then every OTHER
// vertex in the run is checked to actually lie on that circle within
// tolerance — a real tessellated Manifold.cylinder rim fits to float
// precision; a coincidentally-closed loop of unrelated edges will not, and
// falls back below). Given the fit (center C, axis N, radius R) and the
// run's (θ, t, r) — constant across the run by the merge criterion — the
// SAME 2D corner-sliver construction used per-edge is built ONCE in the
// meridian half-plane (ρ = radial distance from the axis, z = height along
// it) and swept a full 360° with `makeRevolve`/`CrossSection.revolve`
// (box-in-the-meridian-plane minus a small offset circle, i.e. a torus) —
// exactly the "sweep the profile along the fillet edge" construction from
// the original sketch, specialized (and made exact, not tessellation-
// approximate) for the circular case, which is what every rim in this
// corpus (holes, cylinder rims) actually is. ONE boolean-quality cutter per
// run, no segment-length sensitivity at all, so the R11-class failure mode
// above cannot occur. If the fit or the in-meridian-plane check fails (a
// non-circular closed run — mixed topology), or the run isn't closed
// (a partial/open curved chain), filletEdges FALLS BACK to the v1
// per-EDGE construction for every edge in that run, INCLUDING the original
// t > 0.45·L skip guard — i.e. exactly v1 behaviour, not the rejected
// per-segment-run idea above. Known gap: an OPEN curved run (a fillet on a
// less-than-360° arc) does not get the new treatment and can still lose
// short segments to the skip guard; not exercised by the current corpus
// (every curved surface here comes from a full-revolution primitive).
//
// Curved-adjacent-face relaxation (v2): _c6AssertPlanarAtEdge (below)
// forbids a fillet whose adjacent face is curved — still enforced for
// SINGLETON edges (including fallback-run edges, treated as singletons).
// A run that gets the closed-circular-run treatment SKIPS that assert
// entirely: the circle fit + per-vertex on-circle check IS the validity
// proof for "this is one smooth curved feature," and is strictly more
// specific than the singleton assert's local coplanarity probe (which was
// never designed to look past one edge, and throws on any tessellation
// finer than 3°/facet — exactly what a genuinely curved rim looks like at
// high segment counts).
//
// Constraints (v1, still true for SINGLETON/fallback edges): planar faces
// at the edge (checked: all same-face neighbor triangles coplanar within
// 1e-3; curved-face fillets throw); convex edges only (ball probe, same
// criterion as convexEdges — concave rounding is material ADD and out of
// scope); radius = number (all edges) or number[] parallel to the edge
// list (per-edge radii); a SINGLETON/fallback edge must satisfy
// t < 0.45·edge length (larger r runs off the face — the boolean clips it,
// documented lower fidelity). A closed-circular-run cutter throws instead
// of silently clipping if r is so large the fillet would revolve through
// the rim's own axis. Per-edge arc tessellated at 384 segments (results sit
// ≤ L·(π−(n/2)sin(2π/n))·r² ABOVE the circle-exact volume per edge); a
// closed-run's revolve uses its own (generally coarser, still >=96-segment)
// resolution — see _c6ClosedRunCutter.
//
// opts.sphericalCorners: at every vertex where THREE filleted edges meet
// (~90° corners, equal radii only — v1 scope), the three fillet sails
// converge to a sharp cusp. The option cuts that cusp pocket with a ball
// of radius r centered on the trihedral incenter (equidistant r from all
// three faces and ON all three sail axes) — the result is a spherical
// corner patch tangent to each sail along a circle (C1) and to each face
// at one point, i.e. the true CAD corner for an r/r/r box corner. Closed
// circular runs never participate (a closed loop has no vertex where three
// DIFFERENT edges converge; interior run vertices are always degree-2).
// ============================================================================
function _c6Norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
function _c6Cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function _c6Sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function _c6Len(v) { return Math.hypot(v[0], v[1], v[2]); }

// Per-edge geometry needed by both run-detection and singleton/fallback
// cutter construction. Throws on exactly the conditions v1 threw on
// (stale/degenerate mesh lookup, concave edge, degenerate face angle) —
// BEFORE any run decision is made, so a single bad edge anywhere in the
// list still fails loud, in the same order as before.
function _c6InFaceFromNormal(n, d, nOther) {
  if (!n || !d) return null;
  let f = _c6Cross(n, d);
  if (_c6Len(f) < 1e-8) return null;
  f = _c6Norm(f);
  if (nOther) {
    const toward = [-nOther[0], -nOther[1], -nOther[2]];
    if (f[0]*toward[0] + f[1]*toward[1] + f[2]*toward[2] < 0)
      f = [-f[0], -f[1], -f[2]];
  }
  return f;
}

/**
 * Sine floor for reading an in-face ray off a triangle's third vertex. Below
 * it the vertex sits (almost) on the edge line, so the component ⊥ the edge
 * is rounding noise and its direction is arbitrary.
 */
const _C6_IN_FACE_MIN_SIN = 0.02;

/**
 * In-face ray of one edge triangle, robust to sliver triangles.
 *
 * The ray is the third vertex's offset ⊥ the edge. Boolean seams leave
 * slivers whose third vertex is almost on the edge line: on the three-fillet
 * cube the y = −10 top edge (−8.02 → 8.02) has a front-face triangle whose
 * third vertex is (8.13, −10, 9.9957), 0.004 mm off a 16 mm edge. Measured
 * against the path segment instead of the edge, a segment tilted 0.015° (its
 * start knot sits on the resampled corner arc, y = −9.9957) adds a ⊥ error
 * of the same size, and the ray came out 45° off the face: the whole leg's
 * chamfer section turned 45° (the lip and step). Below the sine floor the
 * ray is the face normal × the edge, signed toward the vertex while it still
 * has a side, else away from the other face (convex edge); then put back ⊥
 * `d`. Well-conditioned triangles return exactly what they always did.
 *
 * `d` is the direction the ray must be ⊥ to; `dEdge` (default `d`) is the
 * mesh edge the triangle actually sits on.
 */
function _c6InFaceDirSafe(X, P0, d, nFace, nOther, dEdge = null) {
  const e = dEdge || d;
  const v = [X[0]-P0[0], X[1]-P0[1], X[2]-P0[2]];
  const L = Math.hypot(v[0], v[1], v[2]);
  const s = v[0]*e[0] + v[1]*e[1] + v[2]*e[2];
  const w = [v[0]-s*e[0], v[1]-s*e[1], v[2]-s*e[2]];
  const wl = Math.hypot(w[0], w[1], w[2]);
  // Well-conditioned (the usual case): unchanged, against the caller's `d`.
  if (L > 1e-12 && wl >= _C6_IN_FACE_MIN_SIN * L && wl > 1e-6) return _c6InFaceDir(X, P0, d);
  // Sliver: direction from the face normal about the EDGE, side from the
  // vertex while it still has one (near-tangent seams, where the other face
  // cannot tell the sides apart), else away from the other face.
  let f = _c6InFaceFromNormal(nFace, e, wl > 1e-9 ? null : nOther);
  if (!f) return _c6InFaceDir(X, P0, d);
  if (wl > 1e-9 && f[0]*w[0] + f[1]*w[1] + f[2]*w[2] < 0) f = [-f[0], -f[1], -f[2]];
  // Back into the plane ⊥ d (d is the path segment for the sweep probes).
  const t = f[0]*d[0] + f[1]*d[1] + f[2]*d[2];
  const g = [f[0]-t*d[0], f[1]-t*d[1], f[2]-t*d[2]];
  const gl = Math.hypot(g[0], g[1], g[2]);
  return gl > 1e-9 ? [g[0]/gl, g[1]/gl, g[2]/gl] : f;
}

/**
 * Face normals for the two triangles on an edge: the triangles' own normals.
 * The face-group normals (n0/n1) are a stand-in only for a triangle too
 * degenerate to have one — on a curved group they are an average over the
 * whole blend, not the local surface.
 */
function _c6EdgeTriNormals(e, triA, triB) {
  const own = (tri) => {
    if (!tri?.v) return null;
    const [v0, v1, v2] = tri.v;
    const c = _c6Cross([v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]], [v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2]]);
    return Math.hypot(c[0], c[1], c[2]) > 1e-12 ? _c6Norm(c) : null;
  };
  let a = own(triA);
  let b = own(triB);
  if ((!a || !b) && e && Array.isArray(e.n0) && Array.isArray(e.n1)) {
    const d = (p, q) => p[0]*q[0] + p[1]*q[1] + p[2]*q[2];
    if (a && !b) b = d(a, e.n0) >= d(a, e.n1) ? e.n1 : e.n0;
    else if (b && !a) a = d(b, e.n0) >= d(b, e.n1) ? e.n1 : e.n0;
    else { a = e.n0; b = e.n1; }
  }
  return [a, b];
}

function _c6EdgeGeom(M, part, mesh, e, r, opts = {}) {
  const relaxPlanar = !!opts.relaxPlanar;
  const P0 = e.va, P1 = e.vb;
  const L = Math.hypot(P1[0]-P0[0], P1[1]-P0[1], P1[2]-P0[2]);
  if (L < 1e-9) return null;
  const d = [(P1[0]-P0[0])/L, (P1[1]-P0[1])/L, (P1[2]-P0[2])/L];

  // in-face boundary rays: prefer mesh triangles on the edge. Hard Accept
  // (relaxPlanar) may pass #49 coherent segments whose endpoints are not a
  // single mesh triangle edge — fall back to carried n0/n1 face normals.
  const eKey = e.a < e.b ? e.a * 1e9 + e.b : e.b * 1e9 + e.a;
  const ti = mesh.pairMap.get(eKey);
  let f0 = null;
  let f1 = null;
  if (ti && ti.length === 2) {
    const thirdVertex = (tri) => {
      for (let k = 0; k < 3; k++) if (tri.vs[k] !== e.a && tri.vs[k] !== e.b) return tri.v[k];
      throw new Error('filletEdges: degenerate edge triangle');
    };
    const [nA, nB] = _c6EdgeTriNormals(e, mesh.tris[ti[0]], mesh.tris[ti[1]]);
    f0 = _c6InFaceDirSafe(thirdVertex(mesh.tris[ti[0]]), P0, d, nA, nB);
    f1 = _c6InFaceDirSafe(thirdVertex(mesh.tris[ti[1]]), P0, d, nB, nA);
  } else if (relaxPlanar && e.n0 && e.n1) {
    f0 = _c6InFaceFromNormal(e.n0, d, e.n1);
    f1 = _c6InFaceFromNormal(e.n1, d, e.n0);
  } else if (!ti || ti.length !== 2) {
    throw new Error('filletEdges: edge not found in mesh (stale selection?)');
  }
  if (!f0 || !f1)
    throw new Error('filletEdges: could not resolve in-face directions for edge');

  // convexity guard: ball probe at the midpoint (same criterion as
  // convexEdges — a dot-product test cannot distinguish a 90° concave
  // corner from a 90° convex one).
  const mid = [(P0[0]+P1[0])/2, (P0[1]+P1[1])/2, (P0[2]+P1[2])/2];
  const rProbe = Math.min(0.05, L * 0.25);
  const sp = M.sphere(rProbe, 12, 6).transform(
    [1,0,0,0, 0,1,0,0, 0,0,1,0, mid[0],mid[1],mid[2], 1]);
  const fIn = M.intersection(part, sp).volume() / sp.volume();
  if (fIn >= 0.45)
    throw new Error('filletEdges: edge is concave (pass convexEdges() output)');

  // interior (material-side) angle between the boundary rays
  const cTheta = Math.max(-1, Math.min(1, f0[0]*f1[0] + f0[1]*f1[1] + f0[2]*f1[2]));
  const theta = Math.acos(cTheta);
  if (theta < 0.05 || theta > Math.PI - 0.05)
    throw new Error(`filletEdges: degenerate face angle ${theta} rad`);
  const t = r / Math.tan(theta / 2);
  return { e, P0, P1, L, d, f0, f1, theta, t, r };
}

// Run detection (v2, see C6 block header). geoms = _c6EdgeGeom results,
// parallel to the input edge array (nulls for degenerate zero-length
// edges). Returns [{ idxs: [...], closed }] covering every geoms[] index
// exactly once; length-1 entries are singleton edges. Walk: at each shared
// mesh vertex, exactly one OTHER input edge must touch it (a real chain
// link, not a triple-junction or a branch), with matching r, matching θ
// (within 3°), and a turn angle <=30° between the two segments' directions
// (a tessellated circle turns 360/segs° — under 30° for any segs>=12; a
// genuine polygon corner turns 60-180° and is correctly rejected as a chain
// link, staying a singleton).
function _c6DetectRuns(geoms) {
  const TURN_COS_MIN = Math.cos(30 * Math.PI / 180);
  const THETA_TOL = 3 * Math.PI / 180;
  const byVertex = new Map(); // mesh vertex index -> [{idx, end}]
  geoms.forEach((g, i) => {
    if (!g) return;
    for (const end of ['a', 'b']) {
      const vk = g.e[end];
      if (!byVertex.has(vk)) byVertex.set(vk, []);
      byVertex.get(vk).push({ idx: i, end });
    }
  });
  // arrival(g,end): unit direction arriving AT the vertex `end`, walking g
  // in its natural a->b sense. departure(g,end): unit direction leaving
  // the vertex `end`, continuing along g in its natural a->b sense.
  const arrival = (g, end) => end === 'b' ? g.d : [-g.d[0], -g.d[1], -g.d[2]];
  const departure = (g, end) => end === 'a' ? g.d : [-g.d[0], -g.d[1], -g.d[2]];
  const findNext = (i, end) => {
    const vk = geoms[i].e[end];
    const touching = byVertex.get(vk);
    if (!touching || touching.length !== 2) return null; // branch/terminus
    const other = touching.find(x => x.idx !== i);
    if (!other) return null;
    const j = other.idx;
    if (Math.abs(geoms[i].r - geoms[j].r) > 1e-9) return null;
    if (Math.abs(geoms[i].theta - geoms[j].theta) > THETA_TOL) return null;
    const arr = arrival(geoms[i], end);
    const dep = departure(geoms[j], other.end);
    const cosAng = arr[0]*dep[0] + arr[1]*dep[1] + arr[2]*dep[2];
    if (cosAng < TURN_COS_MIN) return null; // real corner, not a curve
    return other;
  };
  const visited = new Array(geoms.length).fill(false);
  const runs = [];
  for (let i = 0; i < geoms.length; i++) {
    if (visited[i] || !geoms[i]) continue;
    visited[i] = true;
    const chain = [i];
    let closed = false;
    let curIdx = i, curEnd = 'b';
    for (;;) {
      const nxt = findNext(curIdx, curEnd);
      if (!nxt) break;
      if (nxt.idx === i) { closed = true; break; } // loop closes on itself
      if (visited[nxt.idx]) break;
      chain.push(nxt.idx);
      visited[nxt.idx] = true;
      curIdx = nxt.idx;
      curEnd = nxt.end === 'a' ? 'b' : 'a'; // continue from the far end
    }
    if (!closed) {
      curIdx = i; curEnd = 'a';
      for (;;) {
        const nxt = findNext(curIdx, curEnd);
        if (!nxt) break;
        if (visited[nxt.idx]) break;
        chain.unshift(nxt.idx);
        visited[nxt.idx] = true;
        curIdx = nxt.idx;
        curEnd = nxt.end === 'a' ? 'b' : 'a';
      }
    }
    runs.push({ idxs: chain, closed });
  }
  return runs;
}

// Exact circumcircle through 3 non-collinear 3D points -> {center, normal,
// radius}, or null if (near-)collinear. Standard vector formula relative
// to A: center = A + (|AC|²(AB×AC)×AB + |AB|²AC×(AB×AC)) / (2|AB×AC|²).
function _c6FitCircle3(A, B, C) {
  const ab = _c6Sub(B, A), ac = _c6Sub(C, A);
  const abLen2 = ab[0]*ab[0]+ab[1]*ab[1]+ab[2]*ab[2];
  const acLen2 = ac[0]*ac[0]+ac[1]*ac[1]+ac[2]*ac[2];
  const cr = _c6Cross(ab, ac);
  const denom = 2 * (cr[0]*cr[0]+cr[1]*cr[1]+cr[2]*cr[2]);
  if (denom < 1e-9) return null; // near-collinear: no well-defined circle
  const t1 = _c6Cross(cr, ab), t2 = _c6Cross(ac, cr);
  const center = [
    A[0] + (acLen2*t1[0] + abLen2*t2[0]) / denom,
    A[1] + (acLen2*t1[1] + abLen2*t2[1]) / denom,
    A[2] + (acLen2*t1[2] + abLen2*t2[2]) / denom,
  ];
  return { center, normal: _c6Norm(cr), radius: _c6Len(_c6Sub(A, center)) };
}

// Build the single exact revolve cutter for a CLOSED circular run (see C6
// block header). Returns null if the run doesn't fit a clean circle or its
// f0/f1 aren't in the meridian plane (axisymmetric geometry required) —
// the caller then falls back to the v1 per-edge path for every edge in the
// run. Throws if the fit is circular but r is too large for the rim
// (would revolve through the axis).
function _c6ClosedRunCutter(M, manifoldModule, run, geoms) {
  const { CrossSection } = manifoldModule;
  const n = run.idxs.length;
  const pt = (k) => geoms[run.idxs[k]].P0;
  const fit = _c6FitCircle3(pt(0), pt(Math.floor(n / 3)), pt(Math.floor(2 * n / 3)));
  if (!fit) return null;
  const { center: C, normal: N, radius: R } = fit;
  if (R < 1e-6) return null;
  // Sanity: every run vertex must actually lie on this circle (real
  // tessellated rims fit to float precision; a coincidental closed loop of
  // unrelated edges will not).
  const tol = Math.max(0.02 * R, 0.01);
  for (let k = 0; k < n; k++) {
    const rel = _c6Sub(pt(k), C);
    const z = rel[0]*N[0] + rel[1]*N[1] + rel[2]*N[2];
    const rho = _c6Len([rel[0]-z*N[0], rel[1]-z*N[1], rel[2]-z*N[2]]);
    if (Math.abs(z) > tol || Math.abs(rho - R) > tol) return null; // not circular
  }
  const g0 = geoms[run.idxs[0]];
  const rel0 = _c6Sub(pt(0), C);
  const z0 = rel0[0]*N[0] + rel0[1]*N[1] + rel0[2]*N[2];
  const rhoHat = _c6Norm(_c6Sub(rel0, [z0*N[0], z0*N[1], z0*N[2]]));
  const yHat = _c6Norm(_c6Cross(N, rhoHat));
  // f0/f1 SHOULD lie in the meridian plane (axisymmetric geometry), but the
  // "third vertex" in-face direction (see _c6EdgeGeom) is measured against
  // ONE mesh triangle, whose third vertex is one tessellation STEP away
  // around the curve — for an n-segment rim that leaks a genuine tangential
  // component of magnitude ~sin(π/n) into f0/f1 (verified: 96 segs ->
  // 0.0327, matches sin(1.875°) exactly). That leak is a tessellation
  // artifact, not a sign of non-axisymmetric geometry, and `to2d` below
  // already discards it (keeps only the (ρ,z) components) — so gate on how
  // much LENGTH survives the projection (near 1 for any reasonably fine
  // rim; n>=12 — the run-detection turn-angle filter's own floor — keeps
  // sin(π/12)=0.259 leak, length sqrt(1-0.259²)=0.966, comfortably clear of
  // this threshold) rather than rejecting on the leak itself.
  const to2d = (v) => [v[0]*rhoHat[0]+v[1]*rhoHat[1]+v[2]*rhoHat[2], v[0]*N[0]+v[1]*N[1]+v[2]*N[2]];
  let f0_2d = to2d(g0.f0), f1_2d = to2d(g0.f1);
  const f0Len = Math.hypot(f0_2d[0], f0_2d[1]), f1Len = Math.hypot(f1_2d[0], f1_2d[1]);
  if (f0Len < 0.9 || f1Len < 0.9) return null; // not axisymmetric -- fall back
  f0_2d = [f0_2d[0]/f0Len, f0_2d[1]/f0Len];
  f1_2d = [f1_2d[0]/f1Len, f1_2d[1]/f1Len];
  const { theta, t, r } = g0;
  const P0_2d = [R, 0];
  const sLen = Math.hypot(f0_2d[0]+f1_2d[0], f0_2d[1]+f1_2d[1]) || 1;
  const bis = [(f0_2d[0]+f1_2d[0])/sLen, (f0_2d[1]+f1_2d[1])/sLen];
  const dC = r / Math.sin(theta / 2);
  const O0 = [P0_2d[0] + dC*bis[0], P0_2d[1] + dC*bis[1]];
  const quad = [
    P0_2d,
    [P0_2d[0]+t*f0_2d[0], P0_2d[1]+t*f0_2d[1]],
    [P0_2d[0]+t*(f0_2d[0]+f1_2d[0]), P0_2d[1]+t*(f0_2d[1]+f1_2d[1])],
    [P0_2d[0]+t*f1_2d[0], P0_2d[1]+t*f1_2d[1]],
  ];
  const minX = Math.min(quad[0][0], quad[1][0], quad[2][0], quad[3][0], O0[0] - r);
  if (minX < 1e-6)
    throw new Error('filletEdges: fillet radius too large for this rim (would revolve through the axis)');
  // REVOLVE_SEGS MUST equal n exactly (verified empirically, not a style
  // choice): Manifold's boolean difference between the ORIGINAL part (an
  // n-segment tessellated rim) and a cutter revolved at a DIFFERENT segment
  // count is only PARTIALLY effective — even at a clean integer multiple of
  // n — silently removing less material than the cutter's own volume
  // (measured on a 40mm-radius rim: cutter built at 96 segs vs the part's
  // 64 has volume 53.91 but removes only 49.84; at EXACTLY 64 segs it
  // removes the full 53.86). The two meshes' angular samples must land at
  // the identical phase for the boolean to fully resolve — a real
  // robustness limit of the boolean engine at differing/misaligned
  // tessellation, not a quality/tolerance knob. ARC_SEGS (the small fillet
  // arc's own resolution) has no such constraint — it only touches the
  // cutter's OWN geometry, not the part/cutter alignment — so it is free to
  // be tuned for quality.
  const REVOLVE_SEGS = n;
  const ARC_SEGS = 128;
  // Wedge profile built as ONE 2D CrossSection boolean (quad minus the fillet
  // arc's disk), THEN revolved once. Do NOT revolve the box and the arc into
  // two 3D solids and difference those (the original construction): the box
  // corner and the arc are mathematically TANGENT along their whole shared
  // boundary -- that is the definition of a fillet -- and a 3D boolean
  // between two meshes meeting at a near-but-not-exactly-tangent surface
  // (float noise ~1e-7 from the fitted R/t) is the classic worst case for a
  // mesh boolean: it manufactures a sliver of near-zero-volume overlap that
  // triangulates into hundreds of degenerate triangles (measured: 316
  // zero-area tris + 508 q<0.01 needles on the 9e2b61bb flange; the
  // no-fillet baseline is 0/34). The 2D boolean is well-conditioned (both
  // shapes are flat; the "torus" is just a circle), the solid is identical
  // as a point set -- revolve(A\B) = revolve(A)\revolve(B) for full 360
  // revolutions -- with ZERO degenerate tris, at half the triangle count
  // (one revolve instead of two). Revolve still locks to n (see above): the
  // phase-lock constraint is about THIS solid vs the PART mesh, not internal.
  const quadCS = new CrossSection(_c8NormalizeContours([quad]));
  const arcCS = CrossSection.circle(r, ARC_SEGS).translate(O0);
  const cutter2D = _c8CheckValid(
    quadCS.subtract(arcCS).revolve(REVOLVE_SEGS), 'filletEdges (closed run)');
  const mat = frameToMatrix({ center: C, x: rhoHat, y: yHat, normal: N });
  return cutter2D.transform(mat);
}

/**
 * filletEdges(part, edges, radius, opts) — circular fillet of radius r on
 * a SET of straight convex edges.
 *   edges  = objects from convexEdges() (required: they carry the mesh
 *            indices this helper needs; edges from OTHER selections can
 *            still be filleted if the edge object has {a, b, va, vb}
 *            vertex data).
 *   radius = number (same r for all edges) OR number[] parallel to the
 *            edge list (per-edge radii).
 *   opts   = { sphericalCorners: true, relaxPlanar: false } —
 *            sphericalCorners rounds box-like (~90°, equal-radius) corners
 *            where THREE filleted edges meet (spherical patch / C1 junction).
 *            relaxPlanar (Slice C2 hard Accept) skips the curved-face planar
 *            assert so loft generators use per-segment rolling-ball cutters.
 * Returns the filleted part. v2: edges that chain into a CLOSED CIRCULAR
 * RUN (see block header) fillet as one exact revolved feature even though
 * each mesh segment is individually short (a tessellated circular rim).
 */
function filletEdges(part, edgesIn, radiusIn, opts = {}) {
  const M = manifoldModule.Manifold;
  // Arc tessellation. 96 segments left a measurable sliver: each flat facet
  // between chord vertices dips inward by r·(1−cos(π/96)) ≈ 1.07e-3 mm for
  // r=2, leaving a thin residual band of the original flat face along the
  // whole fillet (measured 4.5e-2 mm³ per 20 mm edge vs the analytic
  // circle-exact fillet). 384 segments cut that ~16x (2.7e-3 mm³) for a
  // trivial mesh cost (~400 tris per edge vs ~108).
  const SEGMENTS = 384;
  const sphericalCorners = !!opts.sphericalCorners;
  // Slice C2 hard path: skip local planar-adjacent assert so loft generators
  // can use the same parallelepiped−cylinder cutter per coherent segment.
  const relaxPlanar = !!opts.relaxPlanar;

  let edges = edgesIn;
  let radiusArr = radiusIn;
  // [{edge, radius}] form: auto-detect on the first entry
  if (Array.isArray(edgesIn) && edgesIn.length && edgesIn[0] && edgesIn[0].edge) {
    radiusArr = null;
    edges = edgesIn.map(x => x.edge);
    const perEdge = new Map();
    for (const x of edgesIn) perEdge.set(x.edge, x.radius);
    radiusArr = edges.map(e => perEdge.get(e));
  }
  if (!edges.length) return part;

  const radii = new Map(); // edge object -> r
  if (Array.isArray(radiusArr)) {
    if (radiusArr.length !== edges.length)
      throw new Error(`filletEdges: radius array length ${radiusArr.length} != edge count ${edges.length}`);
    edges.forEach((e, i) => {
      const rr = radiusArr[i];
      if (!(rr > 0)) throw new Error(`filletEdges: r must be > 0 (edge ${i}, got ${rr})`);
      radii.set(e, rr);
    });
  } else {
    const rr = radiusArr;
    if (!(rr > 0)) throw new Error(`filletEdges: r must be > 0 (got ${rr})`);
    for (const e of edges) radii.set(e, rr);
  }

  const mesh = _c6BuildMeshInfo(part);
  // Per-edge geometry ONCE (also validates every edge — same throws as v1,
  // same order), THEN run detection, THEN try the exact closed-circular-run
  // cutter per run; runs that don't fit one fall back to v1 per-edge.
  const geoms = edges.map(e => _c6EdgeGeom(M, part, mesh, e, radii.get(e), { relaxPlanar }));
  const runs = _c6DetectRuns(geoms);
  const runCutter = new Map(); // run -> cutter Manifold (only for successful closed runs)
  const runOf = new Array(edges.length);
  for (const run of runs) {
    run.idxs.forEach(i => { runOf[i] = run; });
    if (run.closed && run.idxs.length > 1) {
      const c = _c6ClosedRunCutter(M, manifoldModule, run, geoms);
      if (c) runCutter.set(run, c);
    }
  }
  const isHandled = (i) => runCutter.has(runOf[i]);


  // Planarity assert: SINGLETON and fallback edges only (v1 behaviour).
  // Successfully-fit closed circular runs skip it — the circle fit + on-
  // circle check IS the run-level validity proof; see block header.
  // Hard Accept (C2) passes relaxPlanar and skips this assert so generator
  // walls use per-segment rolling-ball cutters instead of loud-failing.
  for (let i = 0; i < edges.length; i++) {
    if (!geoms[i] || isHandled(i)) continue;
    if (!relaxPlanar) _c6AssertPlanarAtEdge(mesh, edges[i]);
  }

  const cutters = [];
  const edgeGeom = []; // per SINGLETON/fallback edge: { kA, kB, V0, V1, r, theta, cyl }
  const skippedShort = []; // {L, t} per SINGLETON/fallback edge skipped as a sliver
  const doneRuns = new Set();
  for (let i = 0; i < edges.length; i++) {
    const g = geoms[i];
    if (!g) continue;
    if (isHandled(i)) {
      const run = runOf[i];
      if (!doneRuns.has(run)) {
        doneRuns.add(run);
        cutters.push(runCutter.get(run));
      }
      continue;
    }
    const e = edges[i];
    const { P0, P1, L, d, f0, f1, theta, t, r } = g;
    if (t > 0.45 * L) {
      // SKIP, don't throw: short edges are tessellation slivers of a curved
      // arc (96/384-seg fillet/chamfer seams) that a filtered edge list
      // picks up alongside the real edge, OR a curved run that didn't fit
      // a clean circle (see block header) — filing one off would only add
      // noise, and one bad sliver must not kill the whole part.
      skippedShort.push({ L: +L.toFixed(4), t: +t.toFixed(4) });
      continue;
    }

    // arc center line: interior bisector, distance r/sin(θ/2) from the edge
    const sLen = Math.hypot(f0[0]+f1[0], f0[1]+f1[1], f0[2]+f1[2]) || 1;
    const bis = [(f0[0]+f1[0])/sLen, (f0[1]+f1[1])/sLen, (f0[2]+f1[2])/sLen];
    const dC = r / Math.sin(theta / 2);
    const O0 = [P0[0] + dC*bis[0], P0[1] + dC*bis[1], P0[2] + dC*bis[2]];

    // parallelepiped spanned by t·f0 and t·f1, extruded along the edge
    const B = [];
    for (const s of [0, L]) {
      const P = [P0[0]+s*d[0], P0[1]+s*d[1], P0[2]+s*d[2]];
      B.push(
        P,
        [P[0]+t*f0[0], P[1]+t*f0[1], P[2]+t*f0[2]],
        [P[0]+t*f1[0], P[1]+t*f1[1], P[2]+t*f1[2]],
        [P[0]+t*(f0[0]+f1[0]), P[1]+t*(f0[1]+f1[1]), P[2]+t*(f0[2]+f1[2])],
      );
    }
    const box = M.hull(B);

    // cylinder: radius r, axis along the edge, centered on the bisector
    // line (1mm overshoot each end). Rows = local x,y,z axes (row-vector
    // convention, see frameToMatrix): x = f1, z = d, y = x̂z.
    const cyU = _c6Norm(_c6Cross(d, f1));
    const C = [O0[0] + (L/2)*d[0], O0[1] + (L/2)*d[1], O0[2] + (L/2)*d[2]];
    const mat = [
      f1[0], f1[1], f1[2], 0,
      cyU[0], cyU[1], cyU[2], 0,
      d[0],  d[1],  d[2],   0,
      C[0], C[1], C[2], 1,
    ];
    const cyl = M.cylinder(L + 2, r, r, SEGMENTS, true).transform(mat);
    const cutter = M.difference(box, cyl);
    const seC = _c4StatusError(cutter);
    if (seC)
      throw new Error(`filletEdges: bad cutter (${seC})`);
    cutters.push(cutter);
    edgeGeom.push({ kA: e.a, kB: e.b, V0: P0, V1: P1, r, theta, cyl });
  }
  if (!cutters.length) {
    // Slice-01: never silently "succeed" with an unchanged part when the
    // caller asked for fillets. Empty edge list → no-op; non-empty with
    // zero cutters → loud failure (the old console.warn hid hole-rim misses).
    if (!edges.length) return part;
    const hint = skippedShort.length
      ? `all ${skippedShort.length} edges failed the size guard (t > 0.45·L); example t=${skippedShort[0].t} L=${skippedShort[0].L}`
      : 'no valid cutters (geometry/status rejected every edge)';
    throw new Error(
      `filletEdges: no edges could be filleted (${hint}). ` +
      `For circular rims pass convexEdges(part) unfiltered so closed-run detection can fire; or reduce r. ` +
      `Curved-face singleton fillets are unsupported.`,
    );
  }
  // Union cutters, subtract once: shared-corner overlaps counted once
  // (matches analytic inclusion-exclusion — see block header).
  let tool = cutters[0];
  for (let i = 1; i < cutters.length; i++) tool = M.union([tool, cutters[i]]);
  let out = M.difference(part, tool);
  const seOut = _c4StatusError(out);
  if (seOut) throw new Error(`filletEdges: bad result (${seOut})`);

  // ------------------------------------------------------------------
  // Optional: spherical corner caps. When THREE filleted edges meet at
  // one vertex, the three fillet "sails" converge to a sharp cusp point.
  // Cutting the corner hexahedron with a ball of radius r centered at
  // the trihedral incenter replaces the cusp with a spherical patch:
  //   - the incenter is equidistant r from all three faces → the patch
  //     is tangent to all three faces;
  //   - the incenter lies ON each fillet cylinder's axis at the same
  //     radius → the patch is tangent to each fillet sail ALONG A
  //     CIRCLE (C1-smooth junction).
  // Only applied to box-like (~90°) triple-vertex corners with equal
  // radii; other corners keep the cusp (v1 scope).
  if (sphericalCorners) {
    // group edges by endpoint vertex index
    const byVertex = new Map(); // vertexIndex -> [edgeGeom entries]
    for (const g of edgeGeom) {
      for (const k of [g.kA, g.kB]) {
        if (!byVertex.has(k)) byVertex.set(k, []);
        byVertex.get(k).push(g);
      }
    }
    const caps = [];
    for (const [vk, eg] of byVertex) {
      if (eg.length !== 3) continue;
      const [g1, g2, g3] = eg;
      if (Math.abs(g1.r - g2.r) > 1e-6 || Math.abs(g1.r - g3.r) > 1e-6) continue;
      // v1: only ~90° corners (all three face angles)
      if (!eg.every(g => Math.abs(g.theta - Math.PI/2) < 0.02)) continue;

      // P = the shared vertex point; d_i = unit direction from P INTO edge i
      const P = g1.kA === vk ? g1.V0 : g1.V1;
      const dOf = (g) => {
        const other = g.kA === vk ? g.V1 : g.V0; // endpoint that is NOT P
        return _c6Norm(_c6Sub(other, P));
      };
      const d1 = dOf(g1), d2 = dOf(g2), d3 = dOf(g3);
      if (_c6Len(_c6Cross(d1, d2)) < 0.5 || _c6Len(_c6Cross(d2, d3)) < 0.5 ||
          _c6Len(_c6Cross(d3, d1)) < 0.5) continue; // two edges nearly parallel

      // inward face normals: face(d1,d2) ⊥ d3, so its inward normal is
      // ±(d1×d2) with the sign pointing toward the solid — i.e. positive
      // dot with the THIRD edge direction (which lies in the solid's
      // trihedral cone for a convex corner). For a convex trihedral corner
      // the three inward normals are mutually orthogonal, and the corner
      // box basis is {m12, m23, m31}.
      const inwardOf = (a, b, third) => {
        const n = _c6Norm(_c6Cross(a, b));
        const dot = n[0]*third[0] + n[1]*third[1] + n[2]*third[2];
        return dot < 0 ? [-n[0], -n[1], -n[2]] : n;
      };
      const m12 = inwardOf(d1, d2, d3); // normal of the face containing d1,d2
      const m23 = inwardOf(d2, d3, d1);
      const m31 = inwardOf(d3, d1, d2);
      const r0 = g1.r;
      // incenter: equidistant r0 from all three faces
      const O = [
        P[0] + r0*(m12[0]+m23[0]+m31[0]),
        P[1] + r0*(m12[1]+m23[1]+m31[1]),
        P[2] + r0*(m12[2]+m23[2]+m31[2]),
      ];
      // sanity: for orthogonal faces |O−P| = r0·√3
      const dist = _c6Len(_c6Sub(O, P));
      const dev = Math.abs(dist - r0*Math.sqrt(3));
      if (dev > 1e-3 * r0 + 1e-6)
        throw new Error(`filletEdges: corner-cap incenter sanity failed (|O−P|=${dist}, want ${r0*Math.sqrt(3)})`);
      const ball = M.sphere(r0, 256).transform(
        [1,0,0,0, 0,1,0,0, 0,0,1,0, O[0],O[1],O[2], 1]);
      // cap = (cornerBox ∩ cyl1 ∩ cyl2 ∩ cyl3) \ (ball ∩ cornerBox):
      //   cornerBox ∩ all three sails = material T left in the corner
      //     box by the three fillets; ball ∩ cornerBox = the IDEAL
      //     rounded corner (every octant point is inside all three sail
      //     cylinders, so the sphere IS the true CAD corner patch).
      //   T \ octant = the cusp pocket the plain fillets leave.
      const mkPt = (a, b, c) => [
        P[0] + r0*(a*m12[0] + b*m23[0] + c*m31[0]),
        P[1] + r0*(a*m12[1] + b*m23[1] + c*m31[1]),
        P[2] + r0*(a*m12[2] + b*m23[2] + c*m31[2]),
      ];
      const cornerBox = M.hull([
        mkPt(0,0,0), mkPt(1,0,0), mkPt(0,1,0), mkPt(0,0,1),
        mkPt(1,1,0), mkPt(1,0,1), mkPt(0,1,1), mkPt(1,1,1),
      ]);
      let cap = cornerBox;
      for (const g of eg) cap = M.intersection(cap, g.cyl);
      const seCap = _c4StatusError(cap);
      if (seCap || cap.volume() < 1e-9)
        throw new Error(`filletEdges: bad corner material (${seCap || 'ok'}, vol ${cap.volume()})`);
      const octant = M.intersection(ball, cornerBox);
      const seOct = _c4StatusError(octant);
      if (seOct || octant.volume() < 1e-9)
        throw new Error(`filletEdges: bad corner octant (${seOct || 'ok'})`);
      cap = M.difference(cap, octant);
      const seCap2 = _c4StatusError(cap);
      if (seCap2 || cap.volume() < 1e-9)
        throw new Error(`filletEdges: bad corner cap (${seCap2 || 'ok'}, vol ${cap.volume()})`);
      caps.push(cap);
    }
    if (caps.length) {
      let capTool = caps[0];
      for (let i = 1; i < caps.length; i++) capTool = M.union([capTool, caps[i]]);
      out = M.difference(out, capTool);
      const seCapTool = _c4StatusError(out);
      if (seCapTool)
        throw new Error(`filletEdges: bad corner-cap result (${seCapTool})`);
    }
  }
  // Hard rolling-ball (relaxPlanar): loud-fail scrap rather than leave Area≈0
  // needles unlabeled — Auto-Run restores the prior solid; Undo still works.
  // Fail closed: scrap throw and any unexpected inspection fault must
  // propagate — never swallow unrecognized errors into `return out`.
  if (relaxPlanar) {
    const mOut = out.getMesh();
    const np = mOut.numProp || 3;
    const V = mOut.vertProperties;
    const T = mOut.triVerts;
    const nTri = T.length / 3;
    let tiny = 0;
    for (let ti = 0; ti < nTri; ti++) {
      const i0 = T[ti * 3] * np;
      const i1 = T[ti * 3 + 1] * np;
      const i2 = T[ti * 3 + 2] * np;
      const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
      const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
      const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      if (A < 1e-8) tiny++;
    }
    if (isFilletSliverDirty(tiny, nTri)) {
      throw new Error(
        `filletEdges: result has ${tiny}/${nTri} degenerate triangles (sliver scraps) — `
        + 'failing loud rather than shipping a dirty solid; try a smaller radius',
      );
    }
  }
  return out;
}

// (X − P0) projected perpendicular to the edge direction, normalized.
function _c6InFaceDir(X, P0, d) {
  let v = [X[0]-P0[0], X[1]-P0[1], X[2]-P0[2]];
  const s = v[0]*d[0] + v[1]*d[1] + v[2]*d[2];
  v = [v[0]-s*d[0], v[1]-s*d[1], v[2]-s*d[2]];
  return _c6Norm(v);
}

// Per-triangle {vs, v, n, p0} + (vertex-pair) → triangle list map.
function _c6BuildMeshInfo(part) {
  const mesh = part.getMesh();
  const np = mesh.numProp;
  const V = [];
  for (let i = 0; i < mesh.triVerts.length / 3; i++)
    V.push([mesh.vertProperties[i*np], mesh.vertProperties[i*np+1], mesh.vertProperties[i*np+2]]);
  const tris = [];
  const pairMap = new Map();
  for (let i = 0; i < mesh.numTri; i++) {
    const vs = [mesh.triVerts[i*3], mesh.triVerts[i*3+1], mesh.triVerts[i*3+2]];
    const v0 = V[vs[0]], v1 = V[vs[1]], v2 = V[vs[2]];
    let n = _c6Cross([v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]], [v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2]]);
    if (Math.hypot(n[0], n[1], n[2]) < 1e-12) n = [0, 0, 1]; // degenerate tri
    tris.push({ vs, v: [v0, v1, v2], n: _c6Norm(n), p0: v0 });
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k+1) % 3];
      const key = a < b ? a * 1e9 + b : b * 1e9 + a;
      if (!pairMap.has(key)) pairMap.set(key, []);
      pairMap.get(key).push(i);
    }
  }
  return { tris, pairMap };
}

// Local planarity on each side of the edge: the edge triangle's plane must
// also hold for all same-face neighbor triangles (shared edge + normal
// within 3° of the edge triangle's). Deliberately local, NOT per faceID
// group (Manifold can merge faces from different planes into one group).
// Called for SINGLETON/fallback edges only (v2): a successfully-fit closed
// circular run skips this and relies on the circle fit + on-circle check
// instead — see the C6 block header for why (this probe throws on any
// tessellation finer than 3°/facet, which is exactly what a genuine
// curved run looks like).
const _C6_COS3DEG = Math.cos(3 * Math.PI / 180);
function _c6AssertPlanarAtEdge(mesh, e) {
  const { tris, pairMap } = mesh;
  const key = e.a < e.b ? e.a * 1e9 + e.b : e.b * 1e9 + e.a;
  const ti = pairMap.get(key);
  if (!ti || ti.length !== 2)
    throw new Error('filletEdges: edge not found in mesh (stale selection?)');
  for (const idx of [0, 1]) {
    const A = tris[ti[idx]];
    const refN = A.n, refP0 = A.p0;
    for (let k = 0; k < 3; k++) {
      const a = A.vs[k], b = A.vs[(k+1) % 3];
      const nk = a < b ? a * 1e9 + b : b * 1e9 + a;
      if (nk === key) continue; // the fillet edge itself
      const nti = pairMap.get(nk);
      if (!nti) continue;
      for (const tidx of nti) {
        if (tidx === ti[idx] || tidx === ti[1 - idx]) continue;
        const T = tris[tidx];
        const dot = T.n[0]*refN[0] + T.n[1]*refN[1] + T.n[2]*refN[2];
        if (dot <= _C6_COS3DEG) continue; // different face (3rd face at a corner)
        for (const v of T.v) {
          const dev = (v[0]-refP0[0])*refN[0] + (v[1]-refP0[1])*refN[1] + (v[2]-refP0[2])*refN[2];
          if (Math.abs(dev) > 1e-3)
            throw new Error('filletEdges: adjacent face is not planar at this edge (curved-face fillet not supported)');
        }
      }
    }
  }
}

// ------------------------------------------------------------------ revolve / extrude (C8)
// Manifold requires a very specific contour winding (outer CCW, holes CW)
// and fails SILENTLY when it's wrong: status 'InvalidConstruction', volume
// 0, no exception. That's how C8 produced "empty geometry" parts with no
// actionable error. These helpers normalize winding, drop an explicit
// closing point, and throw a loud, fixable error if the build is still
// invalid — so the LLM loop gets a real correction instead of "no geometry".
function _c8ContourArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function _c8NormalizeContours(contours) {
  // Accept both makeRevolve([outer, hole]) and makeRevolve(outerPoints).
  if (!Array.isArray(contours) || !contours.length || !Array.isArray(contours[0]))
    throw new Error('makeRevolve/makeExtrude: expected an array of contours (array of [x,y] point arrays)');
  if (typeof contours[0][0] === 'number') contours = [contours]; // bare point list
  const cleaned = contours.map(pts => {
    const p = pts.map(v => [v[0], v[1]]);
    const f = p[0], l = p[p.length - 1];
    if (p.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) p.pop(); // explicit close
    return p;
  });
  for (const p of cleaned)
    if (p.length < 3)
      throw new Error('makeRevolve/makeExtrude: every contour needs >= 3 distinct points — the profile is not closed');
  // outermost = largest |area| must be CCW; all others are holes -> CW.
  const order = cleaned.map((p, i) => i)
    .sort((a, b) => Math.abs(_c8ContourArea(cleaned[b])) - Math.abs(_c8ContourArea(cleaned[a])));
  return order.map((idx, rank) => {
    const p = cleaned[idx];
    if (_c8ContourArea(p) < 0 === (rank === 0)) return p.slice().reverse();
    return p;
  });
}
function _c8CheckValid(m, what) {
  // Build-tolerant status check: the npm `manifold-3d` returns the string
  // 'NoError' for valid manifolds, but the bundled `built/manifold.js`
  // (what the browser worker loads) returns an opaque {} for EVERYTHING.
  // So only treat a NON-STRING non-NoError status as an error; when status()
  // is an object (bundled build) the volume check below is the real
  // degeneracy guard (verified: valid → real volume, bad profile → 0).
  const se = _c4StatusError(m);
  if (se)
    throw new Error(`${what}: invalid result (status ${se}) — the profile must be a closed polygon; for revolve: x >= 0 (radial), y = height around the axis`);
  if (m.volume() <= 1e-9)
    throw new Error(`${what}: result is EMPTY (volume 0) — check the profile has real area and (for revolve) does not sit on the axis`);
  return m;
}
/**
 * makeRevolve(contours, segments=96, degrees=360) — revolve a 2D profile
 * around its Y axis (result's axis = Z). contours = [[x,y]...] outer first
 * + optional holes; winding is normalized automatically; throws loudly on
 * an invalid profile instead of returning a silent empty manifold.
 * Profile: x = radial (>= 0), y = height along the axis.
 * If polygons cross the Y-axis, only the positive-X side is used.
 */
function makeRevolve(contours, segments = 96, degrees = 360) {
  const { CrossSection } = manifoldModule;
  const cs = new CrossSection(_c8NormalizeContours(contours));
  const segs = Number(segments);
  if (!(segs >= 3) || !Number.isFinite(segs)) {
    throw new Error('makeRevolve: segments must be >= 3');
  }
  const deg = degrees == null ? 360 : Number(degrees);
  if (!(deg > 0) || !Number.isFinite(deg) || deg > 360) {
    throw new Error('makeRevolve: angle must be > 0 and ≤ 360');
  }
  return _c8CheckValid(cs.revolve(Math.round(segs), deg), 'makeRevolve');
}
/**
 * makeExtrude(contours, height) — extrude a 2D profile by `height` along Z.
 * Same contour rules as makeRevolve (outer CCW + CW holes, auto-normalized).
 */
function makeExtrude(contours, height) {
  const { CrossSection } = manifoldModule;
  const cs = new CrossSection(_c8NormalizeContours(contours));
  return _c8CheckValid(cs.extrude(height), 'makeExtrude');
}

/**
 * sheetMetalSolid(spec) — SendCutSend sheet-metal part from its JSON spec
 * (base flange, bends, tabs, holes, automatic corner reliefs). Written by
 * Sheet Metal mode inside the sheet-metal markers; see utils/sheetMetal.
 */
function sheetMetalSolid(spec) {
  const { Manifold, CrossSection } = manifoldModule;
  return _c8CheckValid(buildSheetMetalSolid(Manifold, CrossSection, spec), 'sheetMetalSolid');
}

/**
 * makeLoft(sections, opts?) — loft ≥2 makeCrossSection values.
 * v1: parallel planes (same workplane + offset along the normal).
 * Result is local (z=0 at the lowest station). Confirm places it with
 * placeInFrame. Mapping is an angle-indexed polar warp (arc-length
 * samples + exact vertex angles) so circle↔rect corners stay sharp and
 * a circle does not spin the other profile off the world axes.
 * Loud-fail on <2 profiles, coincident offsets, non-parallel planes,
 * or empty volume. Legacy loft({ topCS, bottomCS, height }) is unchanged.
 */
function makeLoft(sections, opts = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold, CrossSection } = manifoldModule;
  return _c8CheckValid(buildMakeLoftSolid(Manifold, CrossSection, sections, opts), 'makeLoft');
}


// ---------------------------------------------------------------- Slice 21 cross-section substrate
// Reusable plane + 2D profile value for later edge→sweep / fillet-via-sweep /
// extrude-revolve-loft siblings. Plain object (no class inheritance).
// Contours are in plane UV; plane is a workplaneFromFace frame.
function _xsRequirePlane(plane, what) {
  if (!plane || !plane.center || !plane.normal || !plane.x || !plane.y) {
    throw new Error(`${what}: plane must come from workplaneFromFace (needs center/normal/x/y)`);
  }
}
function _xsContourArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function _xsNormalizeLoop(points, what) {
  if (!Array.isArray(points) || points.length < 3)
    throw new Error(`${what}: need ≥ 3 points for a closed polyline`);
  const p = points.map(v => [Number(v[0]), Number(v[1])]);
  if (p.some(v => !Number.isFinite(v[0]) || !Number.isFinite(v[1])))
    throw new Error(`${what}: points must be finite [u,v]`);
  const f = p[0], l = p[p.length - 1];
  if (p.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) p.pop();
  if (p.length < 3) throw new Error(`${what}: need ≥ 3 distinct points`);
  if (Math.abs(_xsContourArea(p)) < 1e-12)
    throw new Error(`${what}: degenerate profile (zero area)`);
  if (_xsContourArea(p) < 0) p.reverse();
  return p;
}
/**
 * profileCircle(radius, segments=32) → { type:'circle', radius, segments, contours }
 * Contours centered at UV origin — enough for basic extrude / future fillet.
 */
function profileCircle(radius, segments = 32) {
  _c4RequirePositive('profileCircle', 'radius', radius);
  const seg = Math.max(3, Math.round(segments || 32));
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    pts.push([radius * Math.cos(t), radius * Math.sin(t)]);
  }
  return { type: 'circle', radius, segments: seg, contours: [pts] };
}
/**
 * profileRectangle(width, height, centered=true) → rectangle profile in UV.
 */
function profileRectangle(width, height, centered = true) {
  _c4RequirePositive('profileRectangle', 'width', width);
  _c4RequirePositive('profileRectangle', 'height', height);
  let pts;
  if (centered) {
    const hw = width / 2, hh = height / 2;
    pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  } else {
    pts = [[0, 0], [width, 0], [width, height], [0, height]];
  }
  return { type: 'rectangle', width, height, centered: !!centered, contours: [pts] };
}
/**
 * profilePolygon(points) → closed polyline/polygon profile in UV.
 * Accepts ≥3 [u,v] points (explicit close optional). Winding normalized CCW.
 */
function profilePolygon(points) {
  const pts = _xsNormalizeLoop(points, 'profilePolygon');
  return { type: 'polygon', points: pts, contours: [pts] };
}
/**
 * makeCrossSection(plane, profile) → reusable { kind, plane, profile, contours }.
 * plane: workplaneFromFace frame. profile: profileCircle/Rectangle/Polygon result,
 * or { type, ... }, or bare contours / point list (same rules as makeExtrude).
 * Does NOT extrude/sweep — substrate only for later slices.
 */
function makeCrossSection(plane, profile) {
  _xsRequirePlane(plane, 'makeCrossSection');
  let desc;
  let contours;
  if (profile && typeof profile === 'object' && profile.type && Array.isArray(profile.contours)) {
    desc = { type: profile.type };
    for (const k of Object.keys(profile)) {
      if (k === 'contours') continue;
      desc[k] = profile[k];
    }
    contours = profile.contours.map(loop => _xsNormalizeLoop(loop, 'makeCrossSection'));
  } else if (profile && typeof profile === 'object' && profile.type === 'circle') {
    const built = profileCircle(profile.radius, profile.segments);
    desc = { type: 'circle', radius: built.radius, segments: built.segments };
    contours = built.contours;
  } else if (profile && typeof profile === 'object' && profile.type === 'rectangle') {
    const built = profileRectangle(profile.width, profile.height, profile.centered !== false);
    desc = { type: 'rectangle', width: built.width, height: built.height, centered: built.centered };
    contours = built.contours;
  } else if (profile && typeof profile === 'object' && profile.type === 'polygon' && profile.points) {
    const built = profilePolygon(profile.points);
    desc = { type: 'polygon', points: built.points };
    contours = built.contours;
  } else if (Array.isArray(profile)) {
    // bare point list or contours array — reuse C8 normalizer shape rules
    const cleaned = _c8NormalizeContours(profile);
    contours = cleaned;
    desc = { type: 'polygon', points: cleaned[0] };
  } else {
    throw new Error(
      'makeCrossSection: profile must be profileCircle/profileRectangle/profilePolygon, '
      + 'a { type } descriptor, or a contours / point list'
    );
  }
  return {
    kind: 'crossSection',
    plane: {
      center: plane.center.slice(),
      normal: plane.normal.slice(),
      x: plane.x.slice(),
      y: plane.y.slice(),
    },
    profile: desc,
    contours,
  };
}

/**
 * makeSweepPath(edges, opts?) → reusable ordered sweep path / wire.
 * edges: feature / convexEdges-style {a,b,va,vb,...} (selection or query).
 * Soft topology: empty / disconnected / branched → loud Error (UI soft-fails before insert).
 * Recovers the largest simple component when the set is mostly one chain + strays.
 * Does NOT sweep a cutter — path value only (consume later via sweepPoints / fillet-via-sweep).
 */
function makeSweepPath(edges, opts = {}) {
  const r = assembleSweepPath(edges, opts);
  if (r.ok) return r.value;
  if (r.code === 'empty') {
    const noUsable = /usable|endpoint/i.test(r.message || '');
    throw new Error(
      noUsable
        ? 'makeSweepPath: no usable edges (need va/vb endpoints)'
        : 'makeSweepPath: need at least one edge — pick edges in Edge mode (Tangent for circular rims)',
    );
  }
  if (r.code === 'disconnected') {
    const extra = (r.message || '').match(/\([^)]*component[^)]*\)/);
    throw new Error(
      'makeSweepPath: edges are disconnected — pick a single contiguous chain or loop'
      + (extra ? ` ${extra[0]}` : ''),
    );
  }
  if (r.code === 'branch') {
    throw new Error(
      'makeSweepPath: edges branch (junction) — need a simple open chain or closed loop',
    );
  }
  throw new Error('makeSweepPath: could not order edges into a path');
}

// ---------------------------------------------------------------- Slice 23 fillet via swept cross-section
// Unlock fillets on compound / curved-adjacent edges by sweeping a quarter-circle
// (or chamfer triangle) cutter along makeSweepPath and boolean-subtracting.
// Path is a LINEAR polyline (edge wire) — Catmull-Rom bulges off chords and left
// purple sliver scraps. Planar–planar uses filletEdges only when UI Strategy=planar.
// Extrude/revolve/loft FEAT tools live in contour mode (Slices 25/26/28).
function _s23Norm(v) {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function _s23Sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function _s23Cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function _s23Dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

/** Fillet wedge contour: square−quarterDisk@ (r,r). Chamfer: right triangle. */
function _s23WedgeContour(radius, profile, arcSegments) {
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r)) {
    throw new Error('filletAlongPath: radius must be > 0');
  }
  if (profile === 'chamfer') {
    return [[0, 0], [r, 0], [0, r]];
  }
  const seg = Math.max(2, Math.round(Number(arcSegments) || 12));
  const pts = [[0, 0], [r, 0]];
  for (let i = 1; i <= seg; i++) {
    const t = (i / seg) * (Math.PI / 2);
    pts.push([r - r * Math.sin(t), r - r * Math.cos(t)]);
  }
  return pts;
}

/**
 * Normalize path → { points, closed, length }. Loud on bad input.
 */
function _s23NormalizePath(path, opts) {
  if (!path) throw new Error('filletAlongPath: path is required (makeSweepPath result or points[])');
  let points;
  let closed = !!(opts && opts.closed);
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
  if (out.length < 2) throw new Error('filletAlongPath: path collapsed to < 2 distinct points');
  if (closed && out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-5) out.pop();
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
  if (!(length > 1e-9)) throw new Error('filletAlongPath: path has zero length');
  return { points: out, closed, length };
}

/**
 * Probe in-face directions at path start from the part mesh (no planarity assert —
 * curved-adjacent faces are the point of this helper). Returns { T, f0, f1 } or null.
 */
function _s23ProbeFrame(M, part, points) {
  const p0 = points[0];
  const p1 = points[1];
  const T = _s23Norm(_s23Sub(p1, p0));
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];

  // Prefer convexEdges mid match — carries {a,b,va,vb} for mesh lookup.
  let best = null;
  let bestD = Infinity;
  try {
    const edges = convexEdges(part);
    for (const e of edges) {
      if (!e || !Array.isArray(e.va) || !Array.isArray(e.vb)) continue;
      const em = Array.isArray(e.mid)
        ? e.mid
        : [(e.va[0] + e.vb[0]) / 2, (e.va[1] + e.vb[1]) / 2, (e.va[2] + e.vb[2]) / 2];
      const d = Math.hypot(em[0] - mid[0], em[1] - mid[1], em[2] - mid[2]);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  } catch (_) {
    best = null;
  }
  // Tolerance: half segment length or 0.5mm floor
  const segL = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) || 1;
  if (!best || bestD > Math.max(0.5, 0.55 * segL)) {
    return null;
  }

  const mesh = _c6BuildMeshInfo(part);
  const eKey = best.a < best.b ? best.a * 1e9 + best.b : best.b * 1e9 + best.a;
  const ti = mesh.pairMap.get(eKey);
  if (!ti || ti.length !== 2) return null;

  const P0 = best.va;
  const thirdVertex = (tri) => {
    for (let k = 0; k < 3; k++) {
      if (tri.vs[k] !== best.a && tri.vs[k] !== best.b) return tri.v[k];
    }
    return null;
  };
  const X0 = thirdVertex(mesh.tris[ti[0]]);
  const X1 = thirdVertex(mesh.tris[ti[1]]);
  if (!X0 || !X1) return null;
  const [nA, nB] = _c6EdgeTriNormals(best, mesh.tris[ti[0]], mesh.tris[ti[1]]);
  const eDir = _s23EdgeDirAlong(best, T);
  const f0 = _c6InFaceDirSafe(X0, P0, T, nA, nB, eDir);
  const f1 = _c6InFaceDirSafe(X1, P0, T, nB, nA, eDir);
  // Convexity: ball at mid should be mostly outside (same criterion as filletEdges).
  const rProbe = Math.min(0.05, segL * 0.25);
  const sp = M.sphere(rProbe, 12, 6).transform(
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, mid[0], mid[1], mid[2], 1],
  );
  const fIn = M.intersection(part, sp).volume() / sp.volume();
  if (fIn >= 0.45) {
    throw new Error('filletAlongPath: edge is concave (sweep fillet is external / material-remove only)');
  }
  return { T, f0, f1, mid };
}

/**
 * When the closed path fits a circle, build the fillet cutter by revolving the
 * 2D wedge in the meridian plane (same idea as C6 closed-run). Avoids closed
 * extrude+warp RMF seams that leave purple sliver sheets.
 * Returns null if the path is not a clean circle.
 */
function _s23TryRevolveCutter(CrossSection, points, radius, profileKind, arcSegs, probed) {
  if (!points || points.length < 6) return null;
  const n = points.length;
  const fit = _c6FitCircle3(points[0], points[Math.floor(n / 3)], points[Math.floor((2 * n) / 3)]);
  if (!fit) return null;
  const { center: C, normal: N, radius: R } = fit;
  if (!(R > 1e-6)) return null;
  const tol = Math.max(0.02 * R, 0.05);
  for (let k = 0; k < n; k++) {
    const rel = _s23Sub(points[k], C);
    const z = _s23Dot(rel, N);
    const rhoVec = _s23Sub(rel, [z * N[0], z * N[1], z * N[2]]);
    const rho = Math.hypot(rhoVec[0], rhoVec[1], rhoVec[2]);
    if (Math.abs(z) > tol || Math.abs(rho - R) > tol) return null;
  }
  // Meridian frame at points[0]
  const rel0 = _s23Sub(points[0], C);
  const z0 = _s23Dot(rel0, N);
  const rhoHat = _s23Norm(_s23Sub(rel0, [z0 * N[0], z0 * N[1], z0 * N[2]]));
  const yHat = _s23Norm(_s23Cross(N, rhoHat));

  // Map in-face rays into meridian (ρ, z). Prefer probed f0/f1.
  const to2d = (v) => [_s23Dot(v, rhoHat), _s23Dot(v, N)];
  let f0 = probed && probed.f0 ? probed.f0 : rhoHat.map((x) => -x); // into top ≈ -radial for outer rim
  let f1 = probed && probed.f1 ? probed.f1 : N.map((x) => -x); // into wall ≈ -axis for top rim
  let f0_2d = to2d(f0);
  let f1_2d = to2d(f1);
  let f0Len = Math.hypot(f0_2d[0], f0_2d[1]);
  let f1Len = Math.hypot(f1_2d[0], f1_2d[1]);
  if (f0Len < 0.85 || f1Len < 0.85) {
    // Fallback for axisymmetric top rim: -ρ and -N
    f0_2d = [-1, 0];
    f1_2d = [0, -1];
  } else {
    f0_2d = [f0_2d[0] / f0Len, f0_2d[1] / f0Len];
    f1_2d = [f1_2d[0] / f1Len, f1_2d[1] / f1Len];
  }
  // Ensure first-quadrant wedge maps into the solid (both axes point "inward")
  // If either axis points outward in ρ, flip.
  // Place wedge origin at (R, 0) in a local meridian where z'=0 at the rim.
  // Orthonormal meridian axes. A 90° rim (f0 ⟂ f1) matches the old
  // u·f0+v·f1 map; a non-orthogonal rim uses the dihedral contour instead
  // of shearing a quarter-circle through non-orthogonal axes.
  const e0 = f0_2d;
  const proj = f1_2d[0] * e0[0] + f1_2d[1] * e0[1];
  let e1x = f1_2d[0] - proj * e0[0];
  let e1y = f1_2d[1] - proj * e0[1];
  const e1L = Math.hypot(e1x, e1y);
  if (e1L < 1e-6) return null;
  e1x /= e1L;
  e1y /= e1L;
  const cth = Math.max(-1, Math.min(1, f0_2d[0] * f1_2d[0] + f0_2d[1] * f1_2d[1]));
  const theta = Math.acos(cth);
  if (theta < 0.05 || theta > Math.PI - 0.05) return null;
  let wedge;
  try {
    const nominal = profileKind === 'chamfer'
      ? dihedralChamferContour(radius, theta)
      : dihedralFilletContour(radius, theta, arcSegs);
    wedge = expandDihedralCutterContour(nominal, radius, theta);
  } catch (_) {
    return null;
  }
  const mapped = [];
  for (const [u, v] of wedge) {
    const rho = R + u * e0[0] + v * e1x;
    const zRel = u * e0[1] + v * e1y;
    mapped.push([rho, zRel]);
  }
  // Ensure CCW in (ρ,z)
  let a2 = 0;
  for (let i = 0; i < mapped.length; i++) {
    const a = mapped[i], b = mapped[(i + 1) % mapped.length];
    a2 += a[0] * b[1] - b[0] * a[1];
  }
  if (a2 < 0) mapped.reverse();
  // Must stay ρ≥0
  for (const p of mapped) {
    if (p[0] < 1e-6) {
      throw new Error('filletAlongPath: fillet radius too large for this rim (would revolve through the axis)');
    }
  }
  const REVOLVE_SEGS = n; // phase-lock with tessellation (see C6)
  const cs = new CrossSection([mapped]);
  let solid;
  try {
    solid = cs.revolve(REVOLVE_SEGS);
  } catch (e) {
    return null;
  }
  // Shift so zRel=0 lies at the rim height along N, then frame to world.
  // mapped uses zRel about the rim; rim world = C + R*rhoHat + z0*N, and
  // revolve is about Y in CrossSection... Manifold revolve: profile x=radial, y=height → axis Z.
  // Our CrossSection (ρ, zRel) revolved → solid with axis Z. Transform to world:
  // x_axis = rhoHat, y_axis = yHat, z_axis = N, origin = C + z0*N
  // frameToMatrix expects {center, x, y, normal} where normal is Z.
  const origin = [C[0] + z0 * N[0], C[1] + z0 * N[1], C[2] + z0 * N[2]];
  const mat = frameToMatrix({ center: origin, x: rhoHat, y: yHat, normal: N });
  return solid.transform(mat);
}

/**
 * Linear polyline path for fillet sweep (NOT Catmull-Rom).
 * Catmull-Rom bulges off mesh chords / rounds corners and leaves thin purple
 * cutter scraps after boolean subtract — follow the edge wire exactly.
 */
function _s23PolylinePath(points, closed) {
  const n = points.length;
  const segCount = closed ? n : Math.max(1, n - 1);
  const segLens = [];
  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    segLens.push(L);
    total += L;
  }
  if (!(total > 1e-12)) {
    throw new Error('filletAlongPath: polyline path has zero length');
  }
  const cum = [0];
  for (const L of segLens) cum.push(cum[cum.length - 1] + L);

  const atS = (s) => {
    const ss = Math.max(0, Math.min(total, s));
    let i = 0;
    while (i < segCount - 1 && cum[i + 1] < ss - 1e-12) i++;
    const L = segLens[i] || 1;
    const local = (ss - cum[i]) / L;
    const a = points[i];
    const b = points[(i + 1) % n];
    return {
      p: [
        a[0] + local * (b[0] - a[0]),
        a[1] + local * (b[1] - a[1]),
        a[2] + local * (b[2] - a[2]),
      ],
      i,
    };
  };

  return {
    position: (t) => atS(Math.max(0, Math.min(1, t)) * total).p,
    derivative: (t) => {
      const { i } = atS(Math.max(0, Math.min(1, t)) * total);
      const a = points[i];
      const b = points[(i + 1) % n];
      const L = segLens[i] || 1;
      // dpos/dt = tangent * totalLength (t ∈ [0,1] arc-length fraction)
      return [
        ((b[0] - a[0]) / L) * total,
        ((b[1] - a[1]) / L) * total,
        ((b[2] - a[2]) / L) * total,
      ];
    },
    tMin: 0,
    tMax: 1,
  };
}


const _S23_THETA_TOL = (3 * Math.PI) / 180;

function _s23CarryFrame(src, T) {
  const Tn = _s23Norm(T);
  let N = _s23Sub(src.N, [
    _s23Dot(src.N, Tn) * Tn[0],
    _s23Dot(src.N, Tn) * Tn[1],
    _s23Dot(src.N, Tn) * Tn[2],
  ]);
  if (Math.hypot(N[0], N[1], N[2]) < 1e-8) N = src.N.slice();
  else N = _s23Norm(N);
  let B = _s23Norm(_s23Cross(Tn, N));
  if (_s23Dot(B, src.B) < 0) {
    N = [-N[0], -N[1], -N[2]];
    B = [-B[0], -B[1], -B[2]];
  }
  return { N, B, theta: src.theta, f0: src.f0, f1: src.f1, T: Tn };
}

/** cos 2°: the matched edge must run within this of the segment to lend its direction. */
const _S23_EDGE_DIR_MIN_COS = Math.cos((2 * Math.PI) / 180);

/** Unit direction of a mesh edge, signed to run with `T` (falls back to T). */
function _s23EdgeDirAlong(edge, T) {
  const d = _s23Sub(edge.vb, edge.va);
  const L = Math.hypot(d[0], d[1], d[2]);
  if (!(L > 1e-9)) return T;
  const u = [d[0] / L, d[1] / L, d[2] / L];
  const c = _s23Dot(u, T);
  // Only a matched edge that runs WITH the segment: a loose mid match onto a
  // crossing seam must not lend its direction.
  if (Math.abs(c) < _S23_EDGE_DIR_MIN_COS) return T;
  return c < 0 ? [-u[0], -u[1], -u[2]] : u;
}

function _s23NearestMatched(raw, i, closed) {
  for (let d = 1; d < raw.length; d++) {
    const idxs = closed
      ? [(i - d + raw.length) % raw.length, (i + d) % raw.length]
      : [i - d, i + d].filter((k) => k >= 0 && k < raw.length);
    for (const k of idxs) {
      if (raw[k].matched) return raw[k];
    }
  }
  return null;
}

/**
 * In-face frame at every path segment. One convexEdges pass + one mesh info.
 * Smooth G1 bridges are not convex edges: they keep the neighboring dihedral
 * frame. Throws when no segment matches, the edge is concave, or θ is
 * degenerate — a 90° start-frame fallback is the acute-edge hook.
 */
function _s23ProbeSegments(part, points, closed) {
  const edges = _s23ProbeFeatureEdges(part);
  const mesh = _c6BuildMeshInfo(part);
  const n = points.length;
  const segCount = closed ? n : n - 1;
  const raw = [];
  for (let i = 0; i < segCount; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % n];
    const segL = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const T = _s23Norm(_s23Sub(p1, p0));
    const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
    let best = null;
    let bestScore = Infinity;
    let bestD = Infinity;
    for (const e of edges) {
      if (!e || !Array.isArray(e.va) || !Array.isArray(e.vb)) continue;
      const em = [(e.va[0] + e.vb[0]) / 2, (e.va[1] + e.vb[1]) / 2, (e.va[2] + e.vb[2]) / 2];
      const d = Math.hypot(em[0] - mid[0], em[1] - mid[1], em[2] - mid[2]);
      // Prefer edges whose chord aligns with the path tangent. On a fillet-on-
      // fillet wrap, dense path samples sit near prior-blend seams whose mids
      // can be closer than the true rim edge but run the wrong direction —
      // matching those left vertical fin-slivers at rounded corners.
      const eT = _s23Norm(_s23Sub(e.vb, e.va));
      const align = Math.abs(_s23Dot(eT, T)); // 1 = parallel, 0 = perpendicular
      // Distance primary; misalignment adds a penalty in mm-equivalent units.
      const score = d + (1 - align) * Math.max(0.55, 0.35 * (segL || 1));
      if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && d < bestD)) {
        bestScore = score;
        bestD = d;
        best = e;
      }
    }
    // Densified variable-profile knots are shorter than mesh edges — allow a
    // slightly looser mid match so loft generators still pick up local walls.
    const hit = best && bestD <= Math.max(0.85, Math.max(0.55 * (segL || 1), 0.35));
    raw.push({ p0, p1, T, length: segL, mid, best: hit ? best : null, matched: false });
  }

  const thirdVertex = (tri, edge) => {
    for (let k = 0; k < 3; k++) {
      if (tri.vs[k] !== edge.a && tri.vs[k] !== edge.b) return tri.v[k];
    }
    return null;
  };

  let prevN = null;
  for (const seg of raw) {
    if (!seg.best) continue;
    const best = seg.best;
    const eKey = best.a < best.b ? best.a * 1e9 + best.b : best.b * 1e9 + best.a;
    const ti = mesh.pairMap.get(eKey);
    if (!ti || ti.length !== 2) continue;
    const X0 = thirdVertex(mesh.tris[ti[0]], best);
    const X1 = thirdVertex(mesh.tris[ti[1]], best);
    if (!X0 || !X1) continue;
    // Read the in-face rays against the matched MESH edge, not the path
    // segment. A knot off the resampled corner arc tilts the next straight
    // leg's segment ~0.015° off its edge; against a sliver third vertex
    // (0.004 mm off a 16 mm edge) that tilt alone swung the ray 45°.
    const [nA, nB] = _c6EdgeTriNormals(best, mesh.tris[ti[0]], mesh.tris[ti[1]]);
    const eDir = _s23EdgeDirAlong(best, seg.T);
    const f0 = _c6InFaceDirSafe(X0, best.va, seg.T, nA, nB, eDir);
    const f1 = _c6InFaceDirSafe(X1, best.va, seg.T, nB, nA, eDir);
    // Per-segment, not once-per-path: a chain that changes sign mid-way used to
    // be classified by its first matched segment and silently got the wrong
    // cutter for the rest. The dihedral sweep is material-remove only, so any
    // concave segment belongs to the variable-profile filler path instead.
    if (best.convex === false) {
      throw new Error(_S23_CONCAVE_MSG);
    }
    const frame = orientFilletFrame(seg.T, f0, f1, prevN);
    if (!(frame.theta > 0.05) || frame.theta > Math.PI - 0.05) {
      throw new Error(
        `filletAlongPath: face angle ${frame.theta.toFixed(3)} rad is degenerate — re-pick edges.`,
      );
    }
    seg.matched = true;
    seg.N = frame.N;
    seg.B = frame.B;
    seg.theta = frame.theta;
    seg.f0 = f0;
    seg.f1 = f1;
    prevN = frame.N;
  }

  if (!raw.some((seg) => seg.matched)) {
    throw new Error(
      'filletAlongPath: could not orient cutter to part (no nearby convex edge along the path). '
      + 'Pass opts.initialNormal, or re-pick edges.',
    );
  }

  for (let i = 0; i < raw.length; i++) {
    if (raw[i].matched) continue;
    const src = _s23NearestMatched(raw, i, closed);
    const carried = _s23CarryFrame(src, raw[i].T);
    raw[i].N = carried.N;
    raw[i].B = carried.B;
    raw[i].theta = carried.theta;
    raw[i].f0 = carried.f0;
    raw[i].f1 = carried.f1;
    raw[i].T = carried.T;
  }

  return raw.map((seg) => ({
    T: seg.T,
    N: seg.N,
    B: seg.B,
    theta: seg.theta,
    length: seg.length,
    f0: seg.f0,
    f1: seg.f1,
    p0: seg.p0,
    p1: seg.p1,
  }));
}

function _s23GroupRuns(segs, closed) {
  if (!segs.length) return [];
  const runs = [];
  let cur = [segs[0]];
  for (let i = 1; i < segs.length; i++) {
    if (Math.abs(segs[i].theta - cur[0].theta) < _S23_THETA_TOL) cur.push(segs[i]);
    else {
      runs.push(cur);
      cur = [segs[i]];
    }
  }
  runs.push(cur);
  if (closed && runs.length > 1) {
    const head = runs[0];
    const tail = runs[runs.length - 1];
    if (Math.abs(head[0].theta - tail[0].theta) < _S23_THETA_TOL) {
      runs[0] = tail.concat(head);
      runs.pop();
    }
  }
  return runs;
}

function _s23RunGeometry(run, closedPath, onlyRun) {
  const pts = [run[0].p0.slice()];
  for (const seg of run) pts.push(seg.p1.slice());
  const frames = run.map((seg) => ({
    N: seg.N, B: seg.B, T: seg.T, f0: seg.f0, f1: seg.f1,
  }));
  if (onlyRun && closedPath && pts.length >= 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-5) pts.pop();
    return { points: pts, frames, closed: true };
  }
  return { points: pts, frames, closed: false };
}

function _s23DihedralContour(radius, theta, profileKind, arcSegs, testScale) {
  const nominal = profileKind === 'chamfer'
    ? dihedralChamferContour(radius, theta)
    : dihedralFilletContour(radius, theta, arcSegs);
  const contour = expandDihedralCutterContour(nominal, radius, theta);
  if (testScale > 1) {
    for (const p of contour) {
      p[0] *= testScale;
      p[1] *= testScale;
    }
  }
  let area2 = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  if (area2 < 0) contour.reverse();
  return contour;
}

/**
 * One dihedral sweep's ring stations, for the quality golden.
 * Each filletAlongPath call appends `{ knots, origins }`. `knots` are the
 * path points after densify (the 5° stations). `origins` are the cutter-ring
 * centers actually placed. A uniform extrude can skip a short chord; this
 * log is how the golden checks that did not happen.
 */
function _s23BeginSweepRingCall() {
  if (typeof globalThis === 'undefined') return;
  if (!globalThis.__filletSweepRingLog) globalThis.__filletSweepRingLog = [];
  const call = { knots: [], origins: [] };
  globalThis.__filletSweepRingLog.push(call);
  globalThis.__filletSweepRingCall = call;
}

function _s23SetSweepRingKnots(points) {
  const call = typeof globalThis !== 'undefined' ? globalThis.__filletSweepRingCall : null;
  if (!call || !Array.isArray(points)) return;
  call.knots = points.map((p) => [p[0], p[1], p[2]]);
}

function _s23AddRingOrigins(origins) {
  const call = typeof globalThis !== 'undefined' ? globalThis.__filletSweepRingCall : null;
  if (!call || !origins) return;
  for (let i = 0; i < origins.length; i++) {
    const p = origins[i];
    call.origins.push([p[0], p[1], p[2]]);
  }
}

/**
 * Weld tolerance for the fillet result. Long "fins" on the wrap are
 * triangles with a short edge under this distance and a long edge along a
 * ruling; the rounded-wrap rim comes back as several chains because those
 * duplicated vertices are not shared by index. Snapping them does not move
 * a real feature: arc chords at FILLET_ARC_SEGMENTS are ~0.2 mm.
 */
const _S23_RESULT_WELD_MM = 0.001;

/**
 * A straight fillet whose ruling is the whole edge (30 mm on the playtest
 * cube) comes back with the cap loop in three chains. One interpolated
 * ring on a span longer than this, still on the ruled quad, makes that
 * loop a single chain. The volume is unchanged. Path knots are not moved
 * and arcs under this length stay one quad. `__FILLET_REF_STATION_MM`,
 * when set, replaces this step with a finer measurement grid.
 */
const _S23_LONG_CHORD_MM = 29;

/**
 * Fill spans longer than the chord step with linearly interpolated rings.
 * New vertices lie on the ruled quad between the knots.
 */
function _s23RefineReferenceRings(rings, closed) {
  const ref = typeof globalThis !== 'undefined' ? Number(globalThis.__FILLET_REF_STATION_MM) : 0;
  const step = ref > 0 ? ref : _S23_LONG_CHORD_MM;
  if (!(step > 0) || !Array.isArray(rings) || rings.length < 2) return rings;
  const n = rings.length;
  const spans = closed ? n : n - 1;
  const out = [];
  for (let i = 0; i < spans; i++) {
    const a = rings[i];
    const b = rings[(i + 1) % n];
    if (!out.length) out.push(a);
    const K = a.length;
    let span = 0;
    for (let k = 0; k < K; k++) {
      const d = Math.hypot(b[k][0] - a[k][0], b[k][1] - a[k][1], b[k][2] - a[k][2]);
      if (d > span) span = d;
    }
    const cuts = Math.max(1, Math.ceil(span / step - 1e-9));
    for (let s = 1; s < cuts; s++) {
      const t = s / cuts;
      const ring = new Array(K);
      for (let k = 0; k < K; k++) {
        ring[k] = [
          a[k][0] + (b[k][0] - a[k][0]) * t,
          a[k][1] + (b[k][1] - a[k][1]) * t,
          a[k][2] + (b[k][2] - a[k][2]) * t,
        ];
      }
      out.push(ring);
    }
    if (!closed || i < spans - 1) out.push(b);
  }
  return out;
}

/**
 * Drop triangles out of their original runs. runIndex counts halfedges
 * (3 per triangle). A run that loses every triangle is removed; the
 * survivors keep that run's originalID and each triangle's faceID.
 * @returns {object|null}
 */
function _s23CompactFilletRuns(mesh, triVerts, keptTri) {
  const runIndex = mesh.runIndex;
  const runOriginalID = mesh.runOriginalID;
  const faceID = mesh.faceID;
  const nTri = triVerts.length / 3;
  if (!runIndex || !runOriginalID || runIndex.length !== runOriginalID.length + 1) return null;
  const nRun = runOriginalID.length;
  const triRun = new Int32Array(nTri);
  triRun.fill(-1);
  for (let r = 0; r < nRun; r++) {
    const a = runIndex[r];
    const b = runIndex[r + 1];
    if ((a % 3) !== 0 || (b % 3) !== 0 || b < a) return null;
    const t0 = a / 3;
    const t1 = b / 3;
    if (t1 > nTri) return null;
    for (let t = t0; t < t1; t++) triRun[t] = r;
  }
  const groups = Array.from({ length: nRun }, () => []);
  for (let i = 0; i < keptTri.length; i++) {
    const t = keptTri[i];
    const r = triRun[t];
    if (r < 0) return null;
    groups[r].push(t);
  }
  const outTri = [];
  const outFace = [];
  const outRunIndex = [0];
  const outRunId = [];
  const outTransform = [];
  const transforms = mesh.runTransform;
  const hasXform = transforms && transforms.length === nRun;
  for (let r = 0; r < nRun; r++) {
    const g = groups[r];
    if (!g.length) continue;
    for (let i = 0; i < g.length; i++) {
      const t = g[i];
      outTri.push(triVerts[t * 3], triVerts[t * 3 + 1], triVerts[t * 3 + 2]);
      outFace.push(faceID[t] >>> 0);
    }
    outRunIndex.push(outTri.length);
    outRunId.push(runOriginalID[r] >>> 0);
    if (hasXform) outTransform.push(transforms[r]);
  }
  if (outRunId.length < 1) return null;
  return {
    triVerts: new Uint32Array(outTri),
    faceID: new Uint32Array(outFace),
    runIndex: new Uint32Array(outRunIndex),
    runOriginalID: new Uint32Array(outRunId),
    runTransform: hasXform ? outTransform : null,
  };
}

/**
 * Snap vertices closer than `_S23_RESULT_WELD_MM` and drop the collapsed
 * triangles. A rebuild that is not a strict solid, or that moves the volume
 * by more than 0.001 mm³, is discarded and the boolean result stands.
 */
function _s23WeldFilletResult(manifold) {
  let mesh;
  try {
    mesh = manifold.getMesh();
  } catch {
    return manifold;
  }
  const np = mesh.numProp || 3;
  const src = mesh.vertProperties;
  const n = src.length / np;
  if (!(n >= 4) || !mesh.triVerts || mesh.triVerts.length < 3) return manifold;
  const xyz = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    xyz[i * 3] = src[i * np];
    xyz[i * 3 + 1] = src[i * np + 1];
    xyz[i * 3 + 2] = src[i * np + 2];
  }
  const welded = _weldMeshData(xyz, mesh.triVerts, _S23_RESULT_WELD_MM);
  const T = welded.triVerts;
  const nTri = T.length / 3;
  if (!mesh.faceID || mesh.faceID.length < nTri) return manifold;
  const keptTri = [];
  for (let t = 0; t < nTri; t++) {
    const a = T[t * 3];
    const b = T[t * 3 + 1];
    const c = T[t * 3 + 2];
    if (a === b || b === c || c === a) continue;
    keptTri.push(t);
  }
  if (keptTri.length < 1 || keptTri.length === nTri) {
    // Nothing collapsed, or the whole mesh did. Identical vertices are not
    // a fin until a triangle loses a corner, so an unchanged set is a no-op.
    if (keptTri.length === nTri) return manifold;
    return manifold;
  }
  const packed = _s23CompactFilletRuns(mesh, T, keptTri);
  if (!packed) return manifold;
  let builtManifold;
  try {
    const { Mesh, Manifold } = manifoldModule;
    const meshIn = {
      numProp: 3,
      vertProperties: welded.vertProperties,
      triVerts: packed.triVerts,
      faceID: packed.faceID,
      runIndex: packed.runIndex,
      runOriginalID: packed.runOriginalID,
    };
    if (packed.runTransform) meshIn.runTransform = packed.runTransform;
    builtManifold = new Manifold(new Mesh(meshIn));
  } catch {
    return manifold;
  }
  if (_c4StatusError(builtManifold)) return manifold;
  const v0 = manifold.volume();
  const v1 = builtManifold.volume();
  if (!(Number.isFinite(v1) && Math.abs(v1 - v0) < 1e-3)) return manifold;
  return builtManifold;
}

function _s23PlaceContourRing(contour, origin, N, B) {
  const ring = new Array(contour.length);
  const ox = origin[0];
  const oy = origin[1];
  const oz = origin[2];
  const Nx = N[0];
  const Ny = N[1];
  const Nz = N[2];
  const Bx = B[0];
  const By = B[1];
  const Bz = B[2];
  for (let k = 0; k < contour.length; k++) {
    const u = contour[k][0];
    const v = contour[k][1];
    ring[k] = [
      ox + u * Nx + v * Bx,
      oy + u * Ny + v * By,
      oz + u * Nz + v * Bz,
    ];
  }
  return ring;
}

/**
 * Dihedral cutter as one ring per path point. The ring at knot i uses that
 * segment's frame; the end knot reuses the last frame. Nothing is inserted
 * between knots — a long straight and a 0.3 mm arc chord both get exactly
 * their own stations, which a uniform extrude slice count does not.
 * Caps come from varyingProfileTubeMesh (fan from the rear bumper).
 */
function _s23SweepKnotRings(points, frames, contour) {
  const nSeg = points.length - 1;
  if (nSeg < 1 || frames.length !== nSeg) {
    throw new Error('filletAlongPath: sweep frame count does not match the path');
  }
  const rings = new Array(nSeg + 1);
  const origins = new Array(nSeg + 1);
  for (let i = 0; i < nSeg; i++) {
    const fr = frames[i];
    origins[i] = points[i];
    rings[i] = _s23PlaceContourRing(contour, points[i], fr.N, fr.B);
  }
  const frLast = frames[nSeg - 1];
  origins[nSeg] = points[nSeg];
  rings[nSeg] = _s23PlaceContourRing(contour, points[nSeg], frLast.N, frLast.B);
  _s23AddRingOrigins(origins);
  const mesh = varyingProfileTubeMesh(_s23RefineReferenceRings(rings, false), false);
  let solid;
  let repair;
  try {
    ({ manifold: solid, repair } = _meshDataToManifold(mesh.vertProperties, mesh.triVerts));
  } catch (e) {
    throw new Error(
      `filletAlongPath: sweep cutter is not a valid solid (${e && e.message ? e.message : e})`,
    );
  }
  // Same loud fail as the varying-profile tube: a weld means two rings collided.
  if (repair !== 'strict') {
    throw new Error(
      `filletAlongPath: sweep cutter needed mesh repair (${repair}) — `
      + 'rings collide along the path. Reduce radius or re-pick edges.',
    );
  }
  return solid;
}

function _s23SweepRun(Manifold, CrossSection, runGeom, radius, profileKind, arcSegs, testScale) {
  const thetaUse = runGeom.theta;
  if (runGeom.closed && !(testScale > 1)) {
    try {
      const probed = { f0: runGeom.frames[0].f0, f1: runGeom.frames[0].f1 };
      const rev = _s23TryRevolveCutter(
        CrossSection, runGeom.points, radius, profileKind, arcSegs, probed,
      );
      if (rev) return rev;
    } catch (e) {
      if (/too large for this rim/i.test(String(e && e.message))) throw e;
    }
  }
  let sweepPts = runGeom.points;
  let sweepFrames = runGeom.frames;
  if (runGeom.closed && runGeom.points.length >= 3) {
    const a = runGeom.points[0];
    const b = runGeom.points[1];
    const overlap = 0.08;
    sweepPts = runGeom.points.concat([
      a.slice(),
      [
        a[0] + overlap * (b[0] - a[0]),
        a[1] + overlap * (b[1] - a[1]),
        a[2] + overlap * (b[2] - a[2]),
      ],
    ]);
    sweepFrames = runGeom.frames.concat([runGeom.frames[0]]);
  }
  const contour = _s23DihedralContour(radius, thetaUse, profileKind, arcSegs, testScale);
  // One ring at every knot of this run, including the closed-loop overlap
  // stations appended above. Uniform Manifold.extrude slices space themselves
  // by arc length, so a 28 mm straight in the same run as 0.3 mm arc chords
  // leaves the turns unsampled. The cross-section between knots is the
  // contour itself (FILLET_ARC_SEGMENTS), not a second densify.
  return _s23SweepKnotRings(sweepPts, sweepFrames, contour);
}

/**
 * Minimum spacing between variable-profile knots after densify. Arc chords at
 * FILLET_ARC_SEGMENTS are ~0.2 mm, so nothing real lives below this.
 */
const _S23_MICRO_KNOT_MM = 0.05;
/** Turn above which a knot is a real corner and is never dropped. */
const _S23_MICRO_KEEP_TURN_DEG = 20;

/**
 * Drop knots closer than `gap` to the previous kept knot; path ends stay.
 * densifyPathByMaxTurn bisects both segments at any turn above 5° for up to
 * 8 passes, and bisecting cannot reduce the turn AT a true corner vertex, so
 * each such corner (and each prior-fillet arc whose raw chords did not
 * resample) grows a cluster of 0.001–0.05 mm segments. Every one of them
 * gets its own probe, frame and cutter ring, with a tangent set by the
 * corner, and the rings fold over each other where three cutters meet
 * (a genus-1 handle on the three-fillet corner wrap).
 */
function _s23DropMicroKnots(points, closed, gap = _S23_MICRO_KNOT_MM) {
  if (!Array.isArray(points) || points.length < 3 || !(gap > 0)) return points;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const n = points.length;
  // A real corner vertex stays: dropping it would chamfer the path across
  // the turn. Only the bisection debris around it goes.
  const cosCorner = Math.cos((_S23_MICRO_KEEP_TURN_DEG * Math.PI) / 180);
  const corner = (i) => {
    const a = points[(i - 1 + n) % n];
    const b = points[i];
    const c = points[(i + 1) % n];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const lu = Math.hypot(u[0], u[1], u[2]);
    const lv = Math.hypot(v[0], v[1], v[2]);
    if (!(lu > 1e-12) || !(lv > 1e-12)) return false;
    return (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv) < cosCorner;
  };
  const keep = [points[0]];
  const pinned = [true];
  const lastIdx = closed ? n : n - 1;
  for (let i = 1; i < lastIdx; i++) {
    if (corner(i)) {
      while (keep.length > 1 && !pinned[pinned.length - 1] && d(keep[keep.length - 1], points[i]) < gap) {
        keep.pop();
        pinned.pop();
      }
      keep.push(points[i]);
      pinned.push(true);
      continue;
    }
    if (d(keep[keep.length - 1], points[i]) >= gap) {
      keep.push(points[i]);
      pinned.push(false);
    }
  }
  if (closed) {
    while (keep.length > 3 && !pinned[pinned.length - 1] && d(keep[keep.length - 1], keep[0]) < gap) {
      keep.pop();
      pinned.pop();
    }
    return keep.length >= 3 ? keep : points;
  }
  const end = points[n - 1];
  while (keep.length > 1 && !pinned[pinned.length - 1] && d(keep[keep.length - 1], end) < gap) {
    keep.pop();
    pinned.pop();
  }
  keep.push(end);
  return keep.length >= 2 ? keep : points;
}

/** Last variable-profile framing meta — golden pin (m3 bypass → missing / undensified). */
let _filletVariableProfileMeta = null;

function _recordVariableProfileMeta(meta) {
  _filletVariableProfileMeta = meta;
  if (typeof globalThis !== 'undefined') {
    globalThis.__filletVariableProfileMeta = meta;
  }
}

/**
 * Probe wall normals (n0/n1) at each densified knot from the nearest convex edge.
 * Same mid-match spirit as _s23ProbeSegments; feeds buildVariableProfileFrames.
 */
function _s23ProbeKnotNormals(part, points, closed) {
  const edges = _s23ProbeFeatureEdges(part);
  const n = points.length;
  const segCount = closed ? n : n - 1;
  const segmentNormals = new Array(segCount).fill(null);
  const segmentConvex = new Array(segCount).fill(null);
  let seedNormals = null;
  const matchedIdx = [];

  for (let i = 0; i < segCount; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % n];
    const segL = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
    let best = null;
    let bestD = Infinity;
    for (const e of edges) {
      if (!e || !Array.isArray(e.va) || !Array.isArray(e.vb)) continue;
      if (!e.n0 || !e.n1) continue;
      const em = [(e.va[0] + e.vb[0]) / 2, (e.va[1] + e.vb[1]) / 2, (e.va[2] + e.vb[2]) / 2];
      const d = Math.hypot(em[0] - mid[0], em[1] - mid[1], em[2] - mid[2]);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    const hit = best && bestD <= Math.max(0.85, Math.max(0.55 * (segL || 1), 0.35));
    if (!hit) continue;
    const nr = { n0: best.n0, n1: best.n1 };
    segmentNormals[i] = nr;
    // Per-knot sign. C3.3 and earlier sampled convexity ONCE per path, so a
    // chain that changed sign mid-way was cut as whatever its first segment was.
    segmentConvex[i] = best.convex !== false;
    matchedIdx.push(i);
    if (!seedNormals) seedNormals = nr;
  }

  if (!seedNormals) {
    throw new Error(
      'filletAlongPath: could not orient cutter to part (no nearby convex edge along the path). '
      + 'Pass opts.initialNormal, or re-pick edges.',
    );
  }

  // Carry nearest matched normals onto densified knots that missed a wall hit.
  for (let i = 0; i < segCount; i++) {
    if (segmentNormals[i]) continue;
    let bestJ = matchedIdx[0];
    let bestDist = Math.abs(i - bestJ);
    for (const j of matchedIdx) {
      let d = Math.abs(i - j);
      if (closed) d = Math.min(d, segCount - d);
      if (d < bestDist) {
        bestDist = d;
        bestJ = j;
      }
    }
    segmentNormals[i] = segmentNormals[bestJ];
    segmentConvex[i] = segmentConvex[bestJ];
  }

  return { segmentNormals, seedNormals, segmentConvex };
}

/**
 * Shared run-group → sweep union. EASY path only since C3.3.
 *
 * opts.singleRun (C3.2) forced one continuous sweep at the MEDIAN θ. It cured
 * the loft saw-tooth by replacing many small θ errors with one large one, and
 * gouged instead (see docs/fillet-kernel-spike-c.md § C3.3). The hard path now
 * uses _s23VaryingProfileCutter, which needs no θ collapse at all. The option
 * is kept only because this helper still serves the easy dihedral path; do not
 * reach for it as a loft fix.
 */
/**
 * Break θ-runs at sharp direction changes.
 *
 * θ-grouping only looks at the dihedral, so a face-perimeter wrap — every
 * corner 90°, every θ exactly 90° — grouped into ONE run and was swept as a
 * single piece straight through the corners. Sweeping one section through a
 * 90° turn makes consecutive cross-sections cross on the INSIDE of the bend:
 * the cutter self-intersects, and the boolean resolves the crossing into
 * inward-facing facets. Those render dark — Artur's wrap-fillet surface
 * sliver. Measured on a plain 40×30×20 cube with nothing but the wrap: the
 * sweep path is 4 points, all four turning 90°, and the result carries 13
 * inverted triangles (7 with visible area) sitting exactly on those corners.
 *
 * densifyPathByMaxTurn cannot prevent this: densifying splits SEGMENTS, and a
 * corner is a vertex, not an arc, so splitting the legs leaves the turn at the
 * vertex untouched.
 *
 * Splitting gives each straight leg its own swept piece; `M.union` then
 * resolves the corner overlap properly instead of a self-intersecting single
 * solid. Smooth runs (tessellated rims, loft ridges) stay in one piece — the
 * gate is well above their per-segment turn.
 */
// Half the ~10° shell normal cluster. A run that still bends more than this
// at one vertex is a real corner (split into its own cutter). Smooth arcs are
// resampled to ≤ this before the sweep, so they stay ONE piece — do not split
// a G1 arc into a cutter per step.
const _S23_RUN_CORNER_DEG = FRAME_DENSIFY_MAX_TURN_DEG;

function _s23SplitRunsAtCorners(runs) {
  if (!Array.isArray(runs) || !runs.length) return runs;
  const cosGate = Math.cos((_S23_RUN_CORNER_DEG * Math.PI) / 180);
  const dirOf = (s) => {
    if (!s?.p0 || !s?.p1) return null;
    const d = [s.p1[0] - s.p0[0], s.p1[1] - s.p0[1], s.p1[2] - s.p0[2]];
    const L = Math.hypot(d[0], d[1], d[2]);
    return L > 1e-12 ? [d[0] / L, d[1] / L, d[2] / L] : null;
  };
  const out = [];
  for (const run of runs) {
    if (!Array.isArray(run) || run.length < 2) {
      if (run?.length) out.push(run);
      continue;
    }
    let cur = [run[0]];
    for (let i = 1; i < run.length; i++) {
      const a = dirOf(run[i - 1]);
      const b = dirOf(run[i]);
      const sharp = a && b && _c4Dot(a, b) < cosGate;
      if (sharp) {
        const turnDeg = (Math.acos(Math.max(-1, Math.min(1, _c4Dot(a, b)))) * 180) / Math.PI;
        const prev = cur[cur.length - 1];
        if (prev) prev._splitOutDeg = turnDeg;
        if (run[i]) run[i]._splitInDeg = turnDeg;
        out.push(cur);
        cur = [run[i]];
      } else {
        cur.push(run[i]);
      }
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

function _s23CuttersFromSegs(M, CrossSection, segs, closed, radius, profileKind, arcSegs, testScale, opts = {}) {
  const singleRun = !!opts.singleRun;
  const thetaRunCount = countThetaRuns(segs);
  const runs = singleRun
    ? (segs.length ? [segs] : [])
    : _s23SplitRunsAtCorners(_s23GroupRuns(segs, closed));
  const cutters = [];
  let expectVol = 0;
  for (const run of runs) {
    if (opts.part && !(closed && runs.length === 1)) {
      _s23ExtendOpenRunEnds(opts.part, run, radius, profileKind, arcSegs);
    }
    let theta = run[0].theta;
    if (singleRun && run.length > 1) {
      const ts = run.map((s) => Number(s.theta)).filter((t) => t > 0.05 && t < Math.PI - 0.05).sort((a, b) => a - b);
      if (ts.length) theta = ts[Math.floor(ts.length / 2)];
    }
    const area = profileKind === 'chamfer'
      ? chamferRemovedArea(radius, theta)
      : filletRemovedArea(radius, theta);
    const len = run.reduce((s, seg) => s + seg.length, 0);
    expectVol += area * len;
    const geom = _s23RunGeometry(run, closed, runs.length === 1);
    geom.theta = theta;
    for (const fr of geom.frames) fr.theta = theta;
    let piece;
    try {
      piece = _s23SweepRun(M, CrossSection, geom, radius, profileKind, arcSegs, testScale);
    } catch (e) {
      if (/too large for this rim|face angle|radius/i.test(String(e && e.message))) throw e;
      throw new Error(`filletAlongPath: sweep failed — ${e && e.message ? e.message : e}`);
    }
    const se = _c4StatusError(piece);
    if (se) throw new Error(`filletAlongPath: bad cutter (${se})`);
    cutters.push(piece);
  }
  let cutter = cutters[0];
  if (cutters.length > 1) {
    try {
      cutter = M.union(cutters);
    } catch (e) {
      throw new Error(`filletAlongPath: sweep failed — ${e && e.message ? e.message : e}`);
    }
    const se = _c4StatusError(cutter);
    if (se) throw new Error(`filletAlongPath: bad cutter (${se})`);
  }
  return { cutter, expectVol, runCount: runs.length, thetaRunCount, singleRun };
}

/** Concave rejection shared by the dihedral (material-remove only) paths. */
const _S23_CONCAVE_MSG =
  'filletAlongPath: edge is concave (sweep fillet is external / material-remove only)';

/** Numerical band for a per-knot theta. Outside it the wedge is degenerate. */
const _S23_THETA_MIN = 0.08;
const _S23_THETA_MAX = Math.PI - 0.08;

/**
 * C3.3 hard: VARYING cross-section cutter — one profile per knot.
 *
 * C3.1 approximated a ramping dihedral with piecewise-constant theta runs
 * (staircase); C3.2 replaced that with ONE median-theta run (gouge: on the
 * playtest loft ridge theta ramps 161.5 deg -> 92.8 deg, so a median 109.7 deg
 * profile cut 4.3x too deep at the shallow end). Both were the same bug — a
 * constant section swept along a path whose section must change.
 *
 * Volume guards could not see it: the median-theta total landed within 1.2x of
 * the true integral. The error was distributional, not integral. So expectVol
 * here is the true per-knot integral, which makes those guards meaningful again.
 *
 * Builds the cutter mesh directly (ring per knot, stitched) instead of
 * extrude+warp, because extrude+warp can only reorient one fixed profile.
 */
function _s23VaryingProfileTube(runSegs, wrapClosed, radius, profileKind, arcSegs, testScale) {
  const place = (contour, origin, N, B) => contour.map(([u, v]) => [
    origin[0] + u * N[0] + v * B[0],
    origin[1] + u * N[1] + v * B[1],
    origin[2] + u * N[2] + v * B[2],
  ]);
  const rings = [];
  const thetas = [];
  let expectVol = 0;
  let clampedKnots = 0;
  for (const seg of runSegs) {
    let th = Number(seg.theta);
    if (!Number.isFinite(th)) th = Math.PI / 2;
    // Clamp, don't throw: one noisy knot must not kill a 48-knot blend. A
    // near-flat knot clamps to a near-zero wedge and a knife-edge knot clamps
    // its setback — both are the conservative answer. Count them; a path that
    // is mostly clamped fails the volume guards downstream.
    if (th < _S23_THETA_MIN) { th = _S23_THETA_MIN; clampedKnots++; }
    else if (th > _S23_THETA_MAX) { th = _S23_THETA_MAX; clampedKnots++; }
    thetas.push(th);
    const area = profileKind === 'chamfer'
      ? chamferRemovedArea(radius, th)
      : filletRemovedArea(radius, th);
    expectVol += area * (Number(seg.length) || 0);
    rings.push(place(
      _s23DihedralContour(radius, th, profileKind, arcSegs, testScale),
      seg.p0, seg.N, seg.B,
    ));
  }
  if (!wrapClosed) {
    const tail = runSegs[runSegs.length - 1];
    rings.push(place(
      _s23DihedralContour(radius, thetas[thetas.length - 1], profileKind, arcSegs, testScale),
      tail.p1, tail.N, tail.B,
    ));
  }
  const ringOrigins = [];
  for (let i = 0; i < runSegs.length; i++) ringOrigins.push(runSegs[i].p0);
  if (!wrapClosed) ringOrigins.push(runSegs[runSegs.length - 1].p1);
  _s23AddRingOrigins(ringOrigins);
  const mesh = varyingProfileTubeMesh(_s23RefineReferenceRings(rings, wrapClosed), wrapClosed);
  let solid;
  let repair;
  try {
    ({ manifold: solid, repair } = _meshDataToManifold(mesh.vertProperties, mesh.triVerts));
  } catch (e) {
    throw new Error(
      'filletAlongPath: varying-profile cutter is not a valid solid (rings likely '
      + `self-intersect — path curves tighter than the blend radius): ${e && e.message ? e.message : e}`,
    );
  }
  // A tube that needed welding is a warning sign, not a pass: the rings are
  // built to be watertight by construction, so a weld means two rings collided.
  if (repair !== 'strict') {
    throw new Error(
      `filletAlongPath: varying-profile cutter needed mesh repair (${repair}) — `
      + 'rings collide along the path. Reduce radius or re-pick edges.',
    );
  }
  const se = _c4StatusError(solid);
  if (se) throw new Error(`filletAlongPath: bad cutter (${se})`);
  return { solid, expectVol, thetas, ringCount: rings.length, clampedKnots };
}

/**
 * C3.3 hard: VARYING cross-section cutter — one profile per knot.
 *
 * C3.1 approximated a ramping dihedral with piecewise-constant theta runs
 * (staircase); C3.2 replaced that with ONE median-theta run (gouge: on the
 * playtest loft ridge theta ramps 161.5 deg -> 92.8 deg, so a median 109.7 deg
 * profile cut 4.3x too deep at the shallow end). Both were the same bug — a
 * constant section swept along a path whose section must change.
 *
 * Volume guards could not see it: the median-theta total landed within 1.2x of
 * the true integral. The error was distributional, not integral. So expectVol
 * here is the true per-knot integral, which makes those guards meaningful again.
 *
 * Builds the cutter mesh directly (ring per knot, stitched) instead of
 * extrude+warp, because extrude+warp can only reorient one fixed profile.
 *
 * C4: the path is split into maximal same-SIGN runs. Convex runs become
 * cutters (material remove); concave runs become fillers (material add). The
 * wedge, the frame and the ring machinery are identical for both — only the
 * boolean differs — because for a concave edge the angle between the two
 * in-face directions IS the empty-side angle, so the same contour that carves
 * a convex corner fills a concave one.
 */
function _s23VaryingProfileCutter(segs, closed, radius, profileKind, arcSegs, testScale, part) {
  if (!Array.isArray(segs) || !segs.length) {
    throw new Error('filletAlongPath: varying-profile cutter needs ≥ 1 segment');
  }
  // Maximal same-sign runs.
  const runs = [];
  for (const seg of segs) {
    const convex = seg.convex !== false;
    const cur = runs[runs.length - 1];
    if (!cur || cur.convex !== convex) runs.push({ convex, segs: [seg] });
    else cur.segs.push(seg);
  }
  // A closed path whose head and tail share a sign is one run around the loop.
  if (closed && runs.length > 1 && runs[0].convex === runs[runs.length - 1].convex) {
    runs[0].segs = runs[runs.length - 1].segs.concat(runs[0].segs);
    runs.pop();
  }
  // Same corner split the easy path already applies. A 90° wrap was one
  // varying-profile tube, and on a drafted face that tube self-intersects
  // (shredded mesh, crease left on the second leg). Smooth runs stay one
  // piece: the gate is FRAME_DENSIFY_MAX_TURN_DEG, and densify already holds
  // per-segment turns to that. No draft flag — the turn is the corner.
  const splitRuns = [];
  for (const run of runs) {
    const pieces = _s23SplitRunsAtCorners([run.segs]);
    for (const segs of pieces) {
      if (segs && segs.length) splitRuns.push({ convex: run.convex, segs });
    }
  }
  let wrapClosed = closed && splitRuns.length === 1;
  if (wrapClosed && splitRuns[0].segs.length >= 2) {
    const segs = splitRuns[0].segs;
    const dirOf = (s) => {
      if (!s?.p0 || !s?.p1) return null;
      const d = [s.p1[0] - s.p0[0], s.p1[1] - s.p0[1], s.p1[2] - s.p0[2]];
      const L = Math.hypot(d[0], d[1], d[2]);
      return L > 1e-12 ? [d[0] / L, d[1] / L, d[2] / L] : null;
    };
    const a = dirOf(segs[segs.length - 1]);
    const b = dirOf(segs[0]);
    const cosGate = Math.cos((_S23_RUN_CORNER_DEG * Math.PI) / 180);
    if (a && b && _c4Dot(a, b) < cosGate) wrapClosed = false;
  }

  const cutters = [];
  const fillers = [];
  let expectRemove = 0;
  let expectAdd = 0;
  let clampedKnots = 0;
  let ringCount = 0;
  const allThetas = [];
  let endExtend = 0;
  for (const run of splitRuns) {
    if (!wrapClosed && part && run.convex) {
      endExtend = Math.max(
        endExtend,
        _s23ExtendOpenRunEnds(part, run.segs, radius, profileKind, arcSegs),
      );
    }
    const t = _s23VaryingProfileTube(
      run.segs, wrapClosed, radius, profileKind, arcSegs, testScale,
    );
    clampedKnots += t.clampedKnots;
    ringCount += t.ringCount;
    for (const th of t.thetas) allThetas.push(th);
    if (run.convex) {
      cutters.push(t.solid);
      expectRemove += t.expectVol;
    } else {
      fillers.push(t.solid);
      expectAdd += t.expectVol;
    }
  }
  const M = manifoldModule.Manifold;
  const merge = (list, what) => {
    if (!list.length) return null;
    let m = list[0];
    for (let i = 1; i < list.length; i++) m = M.union([m, list[i]]);
    const se = _c4StatusError(m);
    if (se) throw new Error(`filletAlongPath: bad ${what} (${se})`);
    return m;
  };
  const degs = allThetas.map((t) => (t * 180) / Math.PI);
  return {
    cutter: merge(cutters, 'cutter'),
    filler: merge(fillers, 'filler'),
    expectVol: expectRemove,
    expectAdd,
    runCount: splitRuns.length,
    convexRuns: splitRuns.filter((r) => r.convex).length,
    concaveRuns: splitRuns.filter((r) => !r.convex).length,
    thetaRunCount: countThetaRuns(segs),
    singleRun: splitRuns.length === 1,
    varyingProfile: true,
    ringCount,
    clampedKnots,
    thetaMinDeg: +Math.min(...degs).toFixed(2),
    thetaMaxDeg: +Math.max(...degs).toFixed(2),
    endExtend,
  };
}

/**
 * C3 hard: per-knot path-normal inscribed-arc frames via buildVariableProfileFrames.
 * Probes wall normals at densified knots, then sweeps with those N/B/theta frames.
 */

/**
 * Bbox as plain arrays. Manifold's min/max are indexable vec3s.
 */
function _s23ReadBBox(part) {
  const bb = part.boundingBox();
  return {
    min: [Number(bb.min[0]), Number(bb.min[1]), Number(bb.min[2])],
    max: [Number(bb.max[0]), Number(bb.max[1]), Number(bb.max[2])],
  };
}

/**
 * Drop filler material that the open-end pad pushed past the pre-fillet bbox.
 * eps keeps the original skin (float) so a solid fillet is not shaved.
 */
function _s23ClipToBBox(M, solid, bb) {
  const eps = 1e-3;
  const size = [
    bb.max[0] - bb.min[0] + 2 * eps,
    bb.max[1] - bb.min[1] + 2 * eps,
    bb.max[2] - bb.min[2] + 2 * eps,
  ];
  const c = [
    (bb.max[0] + bb.min[0]) / 2,
    (bb.max[1] + bb.min[1]) / 2,
    (bb.max[2] + bb.min[2]) / 2,
  ];
  const box = M.cube(size, true).translate(c);
  const clipped = M.intersection(solid, box);
  const se = _c4StatusError(clipped);
  if (se) throw new Error(`filletAlongPath: bad open-end clip (${se})`);
  return clipped;
}

/**
 * Concave filler caps are coplanar with the face the edge ends on.
 * On an open shell the free end is the opening (outside the bbox): the cap
 * leaves a triangular fan. The other end sits on the inner ceiling, inside
 * the bbox: the same coplanar cap is a shallow lip along the wall-ceiling
 * junction. Extend EVERY concave open-chain end by the usual cutter-expand
 * pad (not a deeper blend), then the caller clips back to the pre-fillet
 * bbox so the free end does not stick out of the opening. The inner pad
 * runs into the wall and is swallowed by the union. Convex sweeps are not
 * extended.
 */
function _s23ExtendConcaveOpenEnds(part, segs, closed, radius) {
  if (closed || !Array.isArray(segs) || !segs.length) return null;
  const pad = filletSweepCutterExpand(radius);
  if (!(pad > 1e-9)) return null;
  const bb = _s23ReadBBox(part);
  const bump = (seg, which) => {
    if (!seg || seg.convex !== false || !seg.T || !seg.p0 || !seg.p1) return false;
    const T = seg.T;
    const dir = which === 'start' ? [-T[0], -T[1], -T[2]] : [T[0], T[1], T[2]];
    const pt = which === 'start' ? seg.p0 : seg.p1;
    const moved = [pt[0] + dir[0] * pad, pt[1] + dir[1] * pad, pt[2] + dir[2] * pad];
    if (which === 'start') seg.p0 = moved;
    else seg.p1 = moved;
    seg.length = (Number(seg.length) || 0) + pad;
    return true;
  };
  const a = bump(segs[0], 'start');
  const b = bump(segs[segs.length - 1], 'end');
  return (a || b) ? bb : null;
}

/**
 * How far an open cutter end must travel along its outward tangent so the
 * whole end profile clears a face that is not perpendicular to the path.
 * A face the end profile already clears (clearance about 0) needs no
 * extension — a perpendicular cap, including a 90° end. Alignment with the
 * face normal is not that test: a 2° draft is tighter than cos(2°) and the
 * profile still stops short. Clearance is the worst profile point, then the
 * sweep expand pad. Not a sphere cap, and not the concave open-end pad
 * above (that one runs on every concave end and is clipped back to the bbox).
 */
// Plain-JS copy of the faces c4MeshData already walked. A second getMesh()
// on the live fillet input shifts a later decompose by ~0.01 and fails the
// move centroid gate, so the end extension must not touch the solid again.
let _s23CaptureFaceSoupOn = false;
let _s23FaceSoupPart = null;
let _s23FaceSoup = null;

// One fillet builds every cutter against the same solid. signedFeatureEdges
// walks the whole mesh. Cache that walk on the part object so each semi-arc
// run does not rebuild it. The boolean result is a different object, so the
// next fillet misses and rebuilds.
let _s23FeatureEdgePart = null;
let _s23FeatureEdges = null;

function _s23ProbeFeatureEdges(part) {
  if (part && part === _s23FeatureEdgePart && _s23FeatureEdges) return _s23FeatureEdges;
  _s23CaptureFaceSoupOn = true;
  try {
    const edges = signedFeatureEdges(part);
    _s23FeatureEdgePart = part;
    _s23FeatureEdges = edges;
    return edges;
  } finally {
    _s23CaptureFaceSoupOn = false;
  }
}

function _s23RememberFaceSoup(part, faces, V, triVerts) {
  const soup = [];
  for (const f of faces) {
    const n = f && f.normal;
    if (!n || _c4Len(n) < 0.5 || !Array.isArray(f.tris)) continue;
    const nn = [n[0], n[1], n[2]];
    for (const t of f.tris) {
      const i0 = triVerts[t * 3];
      const i1 = triVerts[t * 3 + 1];
      const i2 = triVerts[t * 3 + 2];
      const a = V[i0];
      const b = V[i1];
      const c = V[i2];
      if (!a || !b || !c) continue;
      soup.push({
        n: nn,
        a: [a[0], a[1], a[2]],
        b: [b[0], b[1], b[2]],
        c: [c[0], c[1], c[2]],
      });
    }
  }
  _s23FaceSoupPart = part;
  _s23FaceSoup = soup;
}

function _s23DraftEndExtension(part, origin, tout, N, B, theta, radius, profileKind, arcSegs) {
  if (!part || !origin || !tout || !N || !B) return 0;
  if (!(Number(theta) > 0.05) || !(Number(radius) > 0)) return 0;
  if (_s23FaceSoupPart !== part || !_s23FaceSoup) return 0;
  const alignGate = 0.2;
  const near2 = 0.35 * 0.35;
  let faceN = null;
  let bestAlign = alignGate;
  for (const tri of _s23FaceSoup) {
    if (_pointTriDist2(origin, tri.a, tri.b, tri.c) > near2) continue;
    const align = _c4Dot(tout, tri.n);
    if (align > bestAlign) {
      bestAlign = align;
      faceN = tri.n;
    }
  }
  if (!faceN) return 0;
  const contour = _s23DihedralContour(radius, theta, profileKind, arcSegs, 1);
  let geom = 0;
  for (const uv of contour) {
    const u = Number(uv[0]);
    const v = Number(uv[1]);
    const Q = [
      u * N[0] + v * B[0],
      u * N[1] + v * B[1],
      u * N[2] + v * B[2],
    ];
    const need = -_c4Dot(Q, faceN) / bestAlign;
    if (need > geom) geom = need;
  }
  if (!(geom > 1e-4)) return 0;
  const pad = filletSweepCutterExpand(radius);
  const cap = 2 * radius + pad;
  return Math.min(geom, cap) + pad;
}

/**
 * Internal splits milder than a real corner. Same-radius semi-arc cuts and
 * a shallow arc-to-straight kink (over the 5° corner gate, under ~20°) both
 * leave two open ends. Their face alignment is often under the 0.2 draft
 * gate, so the geometric extension stays 0 and the cutters meet with no
 * overlap. Push those ends by the sweep expand pad. A 90° corner split is
 * not this case.
 */
const _S23_SHALLOW_SPLIT_DEG = 20;

/** Turn (degrees) where two open runs meet, or null when they do not share an end. */
function _s23RunJunctionTurn(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length < 2 || next.length < 2) return null;
  const a = prev[prev.length - 1];
  const b = next[0];
  if (!a || !b) return null;
  if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-3) return null;
  const da = [
    a[0] - prev[prev.length - 2][0],
    a[1] - prev[prev.length - 2][1],
    a[2] - prev[prev.length - 2][2],
  ];
  const db = [next[1][0] - b[0], next[1][1] - b[1], next[1][2] - b[2]];
  const la = Math.hypot(da[0], da[1], da[2]);
  const lb = Math.hypot(db[0], db[1], db[2]);
  if (!(la > 1e-12) || !(lb > 1e-12)) return null;
  const dot = (da[0] * db[0] + da[1] * db[1] + da[2] * db[2]) / (la * lb);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

function _s23StampJunctionTurns(segs, junction) {
  if (!junction || !Array.isArray(segs) || !segs.length) return;
  if (Number.isFinite(junction.in) && junction.in <= _S23_SHALLOW_SPLIT_DEG && segs[0]) {
    segs[0]._splitInDeg = junction.in;
  }
  const last = segs[segs.length - 1];
  if (Number.isFinite(junction.out) && junction.out <= _S23_SHALLOW_SPLIT_DEG && last) {
    last._splitOutDeg = junction.out;
  }
}

/**
 * Extend an open run end without moving the knot. The original station stays
 * a cutter ring; the pad is a new colinear station past it, same frame.
 * Moving the knot instead left that 5° station with no ring (the quality
 * golden) and pulled the junction off the neighbor run.
 */
function _s23SpliceOpenEnd(segs, which, dist) {
  if (!Array.isArray(segs) || !segs.length || !(dist > 1e-4)) return 0;
  const seg = which === 'end' ? segs[segs.length - 1] : segs[0];
  if (!seg?.T || !seg.N || !seg.B || !seg.p0 || !seg.p1) return 0;
  const tLen = Math.hypot(seg.T[0], seg.T[1], seg.T[2]);
  if (!(tLen > 1e-12)) return 0;
  const T = [seg.T[0] / tLen, seg.T[1] / tLen, seg.T[2] / tLen];
  const tout = which === 'end' ? T : [-T[0], -T[1], -T[2]];
  const origin = (which === 'end' ? seg.p1 : seg.p0).slice();
  const moved = [
    origin[0] + tout[0] * dist,
    origin[1] + tout[1] * dist,
    origin[2] + tout[2] * dist,
  ];
  const ext = {
    T: seg.T.slice(),
    N: seg.N.slice(),
    B: seg.B.slice(),
    theta: seg.theta,
    length: dist,
    f0: seg.f0,
    f1: seg.f1,
    convex: seg.convex,
    p0: which === 'end' ? origin : moved,
    p1: which === 'end' ? moved : origin.slice(),
  };
  if (which === 'end') segs.push(ext);
  else segs.unshift(ext);
  return dist;
}

function _s23PadShallowSplitEnd(segs, which, turnDeg, radius) {
  // No tag: this is an original path end (the draft extension owns it).
  // Above ~20°: a hard corner split, left to the two cutters' own overlap.
  // A same-radius joint can be far under the 5° corner gate after densify
  // and still meets as two open ends with no overlap.
  if (!Number.isFinite(turnDeg) || turnDeg > _S23_SHALLOW_SPLIT_DEG) return 0;
  const pad = filletSweepCutterExpand(radius);
  if (!(pad > 1e-9)) return 0;
  return _s23SpliceOpenEnd(segs, which, pad);
}

/** A run whose ends do not share a tangent is a rounded path. */
function _s23RunRounded(segs) {
  if (!Array.isArray(segs) || segs.length < 2) return false;
  const dir = (s) => {
    if (!s?.T) return null;
    const L = Math.hypot(s.T[0], s.T[1], s.T[2]);
    return L > 1e-12 ? [s.T[0] / L, s.T[1] / L, s.T[2] / L] : null;
  };
  const a = dir(segs[0]);
  const b = dir(segs[segs.length - 1]);
  if (!a || !b) return false;
  return _c4Dot(a, b) < Math.cos((8 * Math.PI) / 180);
}

/**
 * Push open cutter ends that land on a tilted face. Convex runs only.
 * A rounded path samples the face at the back end and extends only that end.
 * Returns the longest extension applied (mm).
 */
function _s23ExtendOpenRunEnds(part, segs, radius, profileKind, arcSegs) {
  if (!part || !Array.isArray(segs) || !segs.length) return 0;
  if (segs.some((s) => s && s.convex === false)) return 0;
  const whichEnds = _s23RunRounded(segs) ? ['end'] : ['start', 'end'];
  let applied = 0;
  const drafted = new Set();
  for (const which of whichEnds) {
    const seg = which === 'end' ? segs[segs.length - 1] : segs[0];
    if (!seg?.T || !seg.N || !seg.B || !seg.p0 || !seg.p1) continue;
    const tLen = Math.hypot(seg.T[0], seg.T[1], seg.T[2]);
    if (!(tLen > 1e-12)) continue;
    const T = [seg.T[0] / tLen, seg.T[1] / tLen, seg.T[2] / tLen];
    const tout = which === 'end' ? T : [-T[0], -T[1], -T[2]];
    const origin = which === 'end' ? seg.p1 : seg.p0;
    const dist = _s23DraftEndExtension(
      part, origin, tout, seg.N, seg.B, seg.theta, radius, profileKind, arcSegs,
    );
    if (!(dist > 1e-4)) continue;
    const spliced = _s23SpliceOpenEnd(segs, which, dist);
    if (!(spliced > 0)) continue;
    drafted.add(which);
    if (spliced > applied) applied = spliced;
  }
  // Shallow internal splits only. Original path ends have no split tag, and
  // an end the draft extension already moved is left at that distance.
  const shallow = [
    ['start', segs[0] && segs[0]._splitInDeg],
    ['end', segs[segs.length - 1] && segs[segs.length - 1]._splitOutDeg],
  ];
  for (const [which, turn] of shallow) {
    if (drafted.has(which)) continue;
    const pad = _s23PadShallowSplitEnd(segs, which, turn, radius);
    if (pad > applied) applied = pad;
  }
  return applied;
}

function _s23BuildVariableProfileCutter(
  M, CrossSection, part, points, closed, radius, profileKind, arcSegs, testScale, rawSegCount, junction,
) {
  const { segmentNormals, seedNormals, segmentConvex } = _s23ProbeKnotNormals(part, points, closed);
  const built = buildVariableProfileFrames(points, closed, {
    radius,
    segmentNormals,
    seedNormals,
    segmentConvex,
  });
  const frames = built.frames || [];
  const n = points.length;
  const segCount = closed ? n : n - 1;
  // buildVariableProfileFrames always emits one frame per segment (strong or weak),
  // so a length≠segCount throw is unreachable; strongFrames loud-fail covers the gap.
  const strong = frames.filter((fr) => !fr.weak).length;
  if (!strong) {
    throw new Error(
      'filletAlongPath: could not orient cutter to part (no inscribed-arc frames along the path). '
      + 'Pass opts.initialNormal, or re-pick edges.',
    );
  }
  const segs = [];
  for (let i = 0; i < segCount; i++) {
    const fr = frames[i];
    const p0 = points[i];
    const p1 = points[(i + 1) % n];
    const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    segs.push({
      T: fr.T,
      N: fr.N,
      B: fr.B,
      theta: fr.theta,
      length,
      f0: fr.f0,
      f1: fr.f1,
      p0,
      p1,
      convex: segmentConvex[i] !== false,
    });
  }
  _s23StampJunctionTurns(segs, junction);
  // Open-shell concave ends: pad past the open face so the filler cap is not
  // coplanar with it (the inner-corner triangle). Convex runs are left alone.
  const openEndBBox = _s23ExtendConcaveOpenEnds(part, segs, closed, radius);
  // C3.3: one continuous cutter with a PER-KNOT section. C3.2's single median
  // θ removed the staircase but gouged wherever the true θ was far from the
  // median; θ-grouped runs (C3.1) put the same error back as steps.
  const cut = _s23VaryingProfileCutter(segs, closed, radius, profileKind, arcSegs, testScale, part);
  _recordVariableProfileMeta({
    usedFrames: true,
    frameCount: frames.length,
    densifiedPoints: points.length,
    rawSegCount: Number(rawSegCount) || segCount,
    strongFrames: strong,
    alongPathTransport: built.transported !== false,
    maxFrameJumpDeg: typeof built.maxFrameJumpDeg === 'number'
      ? built.maxFrameJumpDeg
      : maxConsecutiveFrameAngleDeg(frames),
    singleRunCutter: cut.singleRun,
    varyingProfile: true,
    convexRuns: cut.convexRuns,
    concaveRuns: cut.concaveRuns,
    expectAdd: cut.expectAdd,
    ringCount: cut.ringCount,
    clampedKnots: cut.clampedKnots,
    thetaMinDeg: cut.thetaMinDeg,
    thetaMaxDeg: cut.thetaMaxDeg,
    runCount: cut.runCount,
    thetaRunCount: cut.thetaRunCount,
    endExtend: cut.endExtend || 0,
  });
  cut.openEndBBox = openEndBBox;
  return cut;
}

function _s23BuildDihedralCutter(M, CrossSection, part, points, closed, radius, profileKind, arcSegs, testScale, junction) {
  const segs = _s23ProbeSegments(part, points, closed);
  _s23StampJunctionTurns(segs, junction);
  return _s23CuttersFromSegs(M, CrossSection, segs, closed, radius, profileKind, arcSegs, testScale, { part });
}

/** Up to 48 samples along an already-normalized path, endpoints included. */
function _filletPathSamples(points) {
  const n = points.length;
  if (n <= 48) return points;
  const out = [];
  const last = n - 1;
  for (let i = 0; i < 48; i++) out.push(points[Math.round((i * last) / 47)]);
  return out;
}

/** Squared distance from p to triangle abc (Ericson, closest point on the triangle). */
function _pointTriDist2(p, a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d1 = _c4Dot(ab, ap);
  const d2 = _c4Dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return _c4Dot(ap, ap);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = _c4Dot(ab, bp);
  const d4 = _c4Dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return _c4Dot(bp, bp);
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = _c4Dot(ab, cp);
  const d6 = _c4Dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return _c4Dot(cp, cp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const proj = [a[0] + ab[0] * v - p[0], a[1] + ab[1] * v - p[1], a[2] + ab[2] * v - p[2]];
    return _c4Dot(proj, proj);
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const proj = [a[0] + ac[0] * w - p[0], a[1] + ac[1] * w - p[1], a[2] + ac[2] * w - p[2]];
    return _c4Dot(proj, proj);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const edge = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const proj = [b[0] + edge[0] * w - p[0], b[1] + edge[1] * w - p[1], b[2] + edge[2] * w - p[2]];
    return _c4Dot(proj, proj);
  }
  const denom = va + vb + vc;
  if (!(Math.abs(denom) > 1e-20)) return _c4Dot(ap, ap);
  const v = vb / denom;
  const w = vc / denom;
  const proj = [
    a[0] + ab[0] * v + ac[0] * w - p[0],
    a[1] + ab[1] * v + ac[1] * w - p[1],
    a[2] + ab[2] * v + ac[2] * w - p[2],
  ];
  return _c4Dot(proj, proj);
}

/** Max, over samples, of the min squared distance to this body's triangles. */
function _filletBodyWorstDist2(body, samples) {
  const mesh = body.getMesh();
  const vp = mesh.vertProperties;
  const np = mesh.numProp || 3;
  const tv = mesh.triVerts;
  const nTri = Math.floor(tv.length / 3);
  if (!nTri || !samples.length) return Infinity;
  let worst = 0;
  for (const p of samples) {
    let best = Infinity;
    for (let t = 0; t < nTri; t++) {
      const i0 = tv[t * 3];
      const i1 = tv[t * 3 + 1];
      const i2 = tv[t * 3 + 2];
      const a = [vp[i0 * np], vp[i0 * np + 1], vp[i0 * np + 2]];
      const b = [vp[i1 * np], vp[i1 * np + 1], vp[i1 * np + 2]];
      const c = [vp[i2 * np], vp[i2 * np + 1], vp[i2 * np + 2]];
      const d = _pointTriDist2(p, a, b, c);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/**
 * Multi-body input: fillet only the body that owns the path, then compose
 * the untouched bodies back. The scrap check inside the recursive call then
 * sees one result. A bad path throws before decompose. One body returns null
 * so the caller runs the existing path unchanged. Ties (shared cut edge,
 * both distances ~0) keep the first decompose index.
 * Returns null when there is nothing to split.
 */
/**
 * Union decompose pieces of one fillet result back into that body.
 * A wedge that shares a face with the owner was its own body; union joins
 * that contact and the volume stays. Pieces that remain separate are
 * returned unchanged so the 5% / 0.01 scrap gate still decides them.
 * Not for keep-both siblings — union would weld the cut back together.
 */
function _filletJoinOwnedPieces(M, solid) {
  if (!solid || typeof solid.decompose !== 'function') return solid;
  let parts;
  try { parts = solid.decompose(); } catch (_) { return solid; }
  if (!Array.isArray(parts) || parts.length < 2) return solid;
  try {
    let joined = parts[0];
    for (let i = 1; i < parts.length; i++) joined = M.union([joined, parts[i]]);
    const se = _c4StatusError(joined);
    if (se) return solid;
    const again = joined.decompose();
    if (Array.isArray(again) && again.length < parts.length) return joined;
  } catch (_) { /* scrap gate still sees the original pieces */ }
  return solid;
}

function _filletOnlyOwningBody(M, part, path, radius, opts) {
  const norm = _s23NormalizePath(path, opts);
  const bodies = _cutBodiesOf(part);
  if (!bodies || bodies.length < 2) return null;
  const samples = _filletPathSamples(norm.points);
  let owner = 0;
  let best = Infinity;
  for (let i = 0; i < bodies.length; i++) {
    const w = _filletBodyWorstDist2(bodies[i], samples);
    if (i === 0 || w < best - 1e-8) {
      best = w;
      owner = i;
    }
  }
  let filleted = null;
  try {
    filleted = filletAlongPath(
      bodies[owner],
      path,
      radius,
      Object.assign({}, opts, { _filletBodySplit: true }),
    );
    const kept = [];
    for (let i = 0; i < bodies.length; i++) kept.push(i === owner ? filleted : bodies[i]);
    const result = M.compose(kept);
    const status = _c4StatusError(result);
    if (status) {
      if (result && result !== filleted && result !== part) _safeDeleteManifold(result);
      throw new Error(`filletAlongPath: bad compose (${status})`);
    }
    const ownerBody = bodies[owner];
    if (ownerBody && ownerBody !== part && ownerBody !== filleted && ownerBody !== result) {
      _safeDeleteManifold(ownerBody);
    }
    return result;
  } catch (err) {
    if (filleted && filleted !== part) _safeDeleteManifold(filleted);
    for (const b of bodies) {
      if (b && b !== part && b !== filleted) _safeDeleteManifold(b);
    }
    throw err;
  }
}

/**
 * filletAlongPath(part, path, radius, opts?)
 * Sweep a dihedral fillet (or equal-leg chamfer) along path → boolean subtract.
 *
 * Default: each path segment gets an in-face frame. Consecutive segments whose
 * interior angle stays within 3° share one cutter profile (that run's θ) and
 * are swept with those frames — not a 90° wedge spun by a single start RMF.
 * opts.initialNormal keeps the legacy 90° RMF sweep (explicit override).
 *
 * @param {Manifold} part
 * @param {object|number[][]} path — makeSweepPath result or points
 * @param {number} radius
 * @param {object} [opts]
 * @param {'fillet'|'chamfer'} [opts.profile='fillet']
 * @param {number} [opts.segments=24] — arc segments for fillet wedge
 * @param {number[]} [opts.initialNormal] — override probed frame
 * @param {boolean} [opts.closed] — when path is bare points[]
 * @param {number} [opts.arcSamples]
 * @param {number} [opts.extrudeSegments]
 * @param {number} [opts._testCutterScale] — test-only: scale 2D cutter vertices
 *   (e.g. 4) against nominal r so the 8× oversize guard can be pinned
 * @param {boolean} [opts.variableProfile] — C3 hard: densify path + per-knot
 *   path-normal inscribed-arc frames (adapts to loft twist)
 */

function filletAlongPath(part, path, radius, opts = {}) {
  const M = manifoldModule.Manifold;
  const { CrossSection } = manifoldModule;
  _c4RequirePositive('filletAlongPath', 'radius', radius);

  // Keep-both siblings are real components. Filleting the whole compose makes
  // the scrap check name the other body. Fillet the owner, compose the rest,
  // and leave the 5% / 0.01 test on the single result.
  if (!opts._filletBodySplit) {
    const owned = _filletOnlyOwningBody(M, part, path, radius, opts);
    if (owned) return owned;
  }
  _s23BeginSweepRingCall();

  const profileKind = (opts.profile === 'chamfer') ? 'chamfer' : 'fillet';
  const arcSegs = opts.segments != null ? opts.segments : FILLET_ARC_SEGMENTS;
  let { points, closed, length } = _s23NormalizePath(path, opts);

  // C3 hard: densify + per-knot path-normal inscribed-arc frames (buildVariableProfileFrames).
  // C4: a concave run is material-ADD, which the dihedral sweep cannot express
  // at all — so any concave segment routes to the varying-profile builder,
  // which handles convex, concave and mixed chains. Cheap now that the sign is
  // a local test rather than a per-edge CSG probe.
  let variableProfile = !!opts.variableProfile;
  // Every segment convex (material remove only)? Gates the tight-arc split.
  let pathConvex = false;
  if (!opts._rawPath) {
    try {
      const scan = _s23ProbeKnotNormals(part, points, closed);
      pathConvex = scan.segmentConvex.every((c) => c !== false);
      if (!variableProfile && !pathConvex) variableProfile = true;
    } catch (e) {
      // No match / unorientable — let the normal builder raise the real error.
    }
  }
  const rawSegCount = opts._c3RawSegCount != null
    ? Number(opts._c3RawSegCount)
    : (closed ? points.length : Math.max(0, points.length - 1));
  // Resample consistent circular arcs BEFORE variable-profile chord densify.
  // densifyPathByMaxTurn only inserts colinear chord midpoints, which cannot
  // shrink the turn at an existing vertex and pull those points off the
  // circle. Doing that first (the old order) left a prior-fillet quarter-arc
  // at ~15–22° chords: arc resample no longer saw a circle, and the same-
  // radius semi-arc split missed the site, so the wrap stayed one sweep
  // over the coarse arc (pinched corner). Sharp corners and long straights
  // are still copied unchanged. Semi-arc split below still owns the corner;
  // within each half this stays one sweep at ≤ FRAME_DENSIFY_MAX_TURN_DEG.
  if (!opts._rawPath) {
    const turned = densifySweepArcTurns(points, closed, FRAME_DENSIFY_MAX_TURN_DEG, {
      alignFilletLattice: profileKind !== 'chamfer',
    });
    if (Array.isArray(turned) && turned.length >= 2 && turned.length !== points.length) {
      points = turned;
      length = pathPolylineLength(points, closed);
    }
  }
  if (variableProfile && !opts._rawPath) {
    // C3.2: step from min(0.28R, pathLen/48) + max-turn densify so large-R /
    // high-curvature loft ridges get enough knots (0.75R alone was too sparse).
    // Runs after arc resample so a fitted fillet arc is not chord-poisoned.
    const plen0 = (typeof length === 'number' && length > 0)
      ? length
      : pathPolylineLength(points, closed);
    const step = variableProfileDensifyStep(radius, plen0);
    const dense = densifyPathPoints(points, closed, step, {
      maxTurnDeg: FRAME_DENSIFY_MAX_TURN_DEG,
    });
    if (dense.length > points.length) {
      points = _s23DropMicroKnots(dense, closed);
      length = pathPolylineLength(points, closed);
    }
  }
  _s23SetSweepRingKnots(points);

  // Sweep-path policy seam (planFilletSweepPath): keep the full wire by
  // default (never skip-micro). Corner arcs (same-r or R≠cutter) return
  // mode:'runs' — each straight / semi-arc is an independent cutter.

  if (!opts._rawPath) {
    const plan = planFilletSweepPath(points, closed, radius, {
      profile: profileKind,
      splitTighterArcs: pathConvex,
    });
    if (plan.mode === 'runs') {
      // Build each straight / semi-arc cutter independently against the ORIGINAL
      // part (so probes see pre-fillet faces), union, then ONE subtract.
      // Equivalent to independent subtracts but avoids stacking open-run endcap
      // seams that spiked long-fin counts on the Artur box-stack wrap.
      const scale = 1;
      const cutters = [];
      let expectVolSum = 0;
      const closedRuns = Array.isArray(plan.closedRuns) ? plan.closedRuns : null;
      for (let ri = 0; ri < plan.runs.length; ri++) {
        const run = plan.runs[ri];
        if (!Array.isArray(run) || run.length < 2) continue;
        const runClosed = closedRuns ? !!closedRuns[ri] : false;
        let built;
        const junction = {
          in: ri > 0 ? _s23RunJunctionTurn(plan.runs[ri - 1], run) : null,
          out: ri + 1 < plan.runs.length ? _s23RunJunctionTurn(run, plan.runs[ri + 1]) : null,
        };
        try {
          built = variableProfile
            ? _s23BuildVariableProfileCutter(
              M, CrossSection, part, run, runClosed, radius, profileKind, arcSegs, scale, rawSegCount, junction,
            )
            : _s23BuildDihedralCutter(
              M, CrossSection, part, run, runClosed, radius, profileKind, arcSegs, scale, junction,
            );
        } catch (_) {
          continue;
        }
        if (built?.cutter) {
          cutters.push(built.cutter);
          if (Number.isFinite(built.expectVol)) expectVolSum += built.expectVol;
        }
        if (built?.filler) {
          // Concave filler runs: apply as union into part after the subtract batch.
          // Rare on same-r wrap; keep sequential for fillers.
          try {
            part = M.union([part, built.filler]);
          } catch (_) { /* keep */ }
          // Clip outside the swallow: a failed open-end clip must not drop the filler silently.
          if (built.openEndBBox) part = _s23ClipToBBox(M, part, built.openEndBBox);
        }
      }
      if (!cutters.length) {
        throw new Error('filletAlongPath: corner-arc semi-arc split produced no valid cutters');
      }
      // One n-way subtract. A − (C1 ∪ C2 ∪ …) is the same solid as A − C1 − C2 − …,
      // and Manifold evaluates that as a single arrangement. Chaining
      // union(union(C1, C2), C3) … forced a full boolean per semi-arc on the
      // growing cutter. Each cutter was already status-checked when it was swept.
      let out;
      try {
        out = cutters.length === 1
          ? M.difference(part, cutters[0])
          : M.difference([part, ...cutters]);
      } catch (e) {
        throw new Error(`filletAlongPath: semi-arc subtract failed — ${e && e.message ? e.message : e}`);
      }
      const seOut = _c4StatusError(out);
      if (seOut) throw new Error(`filletAlongPath: bad semi-arc result (${seOut})`);
      const removed = part.volume() - out.volume();
      if (expectVolSum > 1e-3 && removed < 0.02 * expectVolSum) {
        throw new Error(
          `filletAlongPath: semi-arc batch removed only ${removed.toFixed(4)} vs expected ~${expectVolSum.toFixed(4)} `
          + '(orientation/overlap failure) — failing loud rather than shipping a near-no-op solid',
        );
      }
      if (expectVolSum > 1e-3 && removed > 8 * expectVolSum) {
        throw new Error(
          `filletAlongPath: semi-arc batch removed ${removed.toFixed(4)} vs expected ~${expectVolSum.toFixed(4)} `
          + '(cutter far larger than requested radius) — failing loud',
        );
      }
      // Semi-arc batch is composed of open runs — keep largest if the union
      // leaves scrap (do not apply the closed-path hard multi-component fail).
      // Join a wedge that shares a face with the owner before that gate.
      out = _filletJoinOwnedPieces(M, out);
      try {
        if (typeof out.decompose === 'function') {
          const parts = out.decompose();
          if (Array.isArray(parts) && parts.length > 1) {
            let best = parts[0];
            let bestVol = best.volume();
            for (let i = 1; i < parts.length; i++) {
              const v = parts[i].volume();
              if (v > bestVol) { bestVol = v; best = parts[i]; }
            }
            const scrapVol = parts.reduce((s, c) => s + c.volume(), 0) - bestVol;
            if (scrapVol > 0.05 * bestVol && scrapVol > 1e-2) {
              throw new Error(
                `filletAlongPath: semi-arc batch decompose found ${parts.length} components with scrap vol `
                + `${scrapVol.toFixed(4)} — failing loud rather than shipping a dirty solid`,
              );
            }
            out = best;
          }
        }
      } catch (e) {
        if (/semi-arc batch decompose|dirty solid/i.test(String(e && e.message))) throw e;
      }
      return out;
    }
    if (plan.mode !== 'as-is') {
      throw new Error(`filletAlongPath: unexpected sweep-path plan mode=${plan.mode}`);
    }
  }

  const testCutterScale = Number(opts._testCutterScale);
  const testingOversize = Number.isFinite(testCutterScale) && testCutterScale > 1;
  let cutter = null;
  let filler = null;
  let expectAddOverride = 0;
  let expectVolOverride = null;
  let openEndBBox = null;
  if (!opts.initialNormal) {
    const scale = testingOversize ? testCutterScale : 1;
    const built = variableProfile
      ? _s23BuildVariableProfileCutter(
        M, CrossSection, part, points, closed, radius, profileKind, arcSegs, scale, rawSegCount,
      )
      : _s23BuildDihedralCutter(
        M, CrossSection, part, points, closed, radius, profileKind, arcSegs, scale,
      );
    cutter = built.cutter;
    filler = built.filler || null;
    expectAddOverride = built.expectAdd || 0;
    expectVolOverride = built.expectVol;
    openEndBBox = built.openEndBBox || null;
  }

  // Legacy 90° RMF — only when opts.initialNormal is set. May reverse the path.
  // A filler-only build (every run concave) leaves `cutter` null legitimately,
  // so both must be absent before falling back here.
  if (!cutter && !filler) {
  let initialNormal = opts.initialNormal ? opts.initialNormal.slice() : null;
  let probed = null;
  if (!initialNormal) {
    probed = _s23ProbeFrame(M, part, points);
    if (probed) {
      const { T, f0, f1 } = probed;
      // Project f0 onto plane ⊥ T
      let N = _s23Sub(f0, [ _s23Dot(f0, T) * T[0], _s23Dot(f0, T) * T[1], _s23Dot(f0, T) * T[2] ]);
      if (Math.hypot(N[0], N[1], N[2]) < 1e-8) {
        N = _s23Sub(f1, [ _s23Dot(f1, T) * T[0], _s23Dot(f1, T) * T[1], _s23Dot(f1, T) * T[2] ]);
      }
      N = _s23Norm(N);
      let B = _s23Cross(T, N);
      // If B opposes f1, reverse path (flips T and thus B) without flipping N into exterior.
      if (_s23Dot(B, f1) < 0) {
        points = points.slice().reverse();
        // Recompute T after reverse
        const T2 = _s23Norm(_s23Sub(points[1], points[0]));
        N = _s23Sub(f0, [ _s23Dot(f0, T2) * T2[0], _s23Dot(f0, T2) * T2[1], _s23Dot(f0, T2) * T2[2] ]);
        if (Math.hypot(N[0], N[1], N[2]) < 1e-8) {
          N = _s23Sub(f1, [ _s23Dot(f1, T2) * T2[0], _s23Dot(f1, T2) * T2[1], _s23Dot(f1, T2) * T2[2] ]);
        }
        N = _s23Norm(N);
        B = _s23Cross(T2, N);
        if (_s23Dot(B, f1) < 0 && _s23Dot(B, f0) > _s23Dot(N, f0)) {
          // Swap: use f1 as N
          N = _s23Sub(f1, [ _s23Dot(f1, T2) * T2[0], _s23Dot(f1, T2) * T2[1], _s23Dot(f1, T2) * T2[2] ]);
          N = _s23Norm(N);
        }
      }
      // Prefer the face-ray that is more orthogonal as the "other" axis.
      const Tuse = _s23Norm(_s23Sub(points[1], points[0]));
      const Bnow = _s23Cross(Tuse, N);
      if (Math.abs(_s23Dot(Bnow, f1)) < Math.abs(_s23Dot(N, f1)) * 0.25
          && Math.abs(_s23Dot(N, f0)) < Math.abs(_s23Dot(Bnow, f0)) + 0.5) {
        // Axes swapped relative to (f0,f1) — start with f1 as N
        let N2 = _s23Sub(f1, [ _s23Dot(f1, Tuse) * Tuse[0], _s23Dot(f1, Tuse) * Tuse[1], _s23Dot(f1, Tuse) * Tuse[2] ]);
        if (Math.hypot(N2[0], N2[1], N2[2]) > 1e-8) N = _s23Norm(N2);
      }
      initialNormal = N;
    }
  }

  if (!initialNormal) {
    throw new Error(
      'filletAlongPath: could not orient cutter to part (no nearby convex edge at path start). '
      + 'Pass opts.initialNormal, or ensure path follows a convex feature edge.',
    );
  }

  const contour = expandFilletCutterContour(
    _s23WedgeContour(radius, profileKind, arcSegs),
    radius,
  );
  if (testingOversize) {
    for (const p of contour) {
      p[0] *= testCutterScale;
      p[1] *= testCutterScale;
    }
  }
  // Ensure CCW. Exterior (−e,−e) overlap (not skip-micro, not a radius grow)
  // provides the boolean margin so cutter legs are not face-coincident.
  let area2 = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  if (area2 < 0) contour.reverse();

  const cs = new CrossSection([contour]);
  // Mobile-friendly sampling: scale with path complexity, capped.
  const nPts = points.length;
  const arcSamples = opts.arcSamples != null
    ? opts.arcSamples
    : Math.min(320, Math.max(48, Math.round(nPts * (closed ? 3 : 4))));
  const extrudeSegments = opts.extrudeSegments != null
    ? opts.extrudeSegments
    : Math.min(64, Math.max(16, Math.round(nPts * (closed ? 1.5 : 0.75))));

  // Polyline along the edge wire. Closed loops are swept as an OPEN path that
  // covers one full lap + a small overlap — a true closed extrude+warp leaves
  // an RMF seam that triangulates into purple sliver sheets.
  let sweepPts = points;
  let sweepClosed = closed;
  if (closed && points.length >= 3) {
    const a = points[0];
    const b = points[1];
    const overlap = 0.08; // fraction of first segment
    sweepPts = points.concat([
      a.slice(),
      [
        a[0] + overlap * (b[0] - a[0]),
        a[1] + overlap * (b[1] - a[1]),
        a[2] + overlap * (b[2] - a[2]),
      ],
    ]);
    sweepClosed = false;
  }

  // Skip revolve fast-path when pinning an oversized sweep cutter.
  if (closed && !testingOversize) {
    try {
      cutter = _s23TryRevolveCutter(CrossSection, points, radius, profileKind, arcSegs, probed);
    } catch (e) {
      if (/too large for this rim/i.test(String(e && e.message))) throw e;
      cutter = null;
    }
  }
  if (!cutter) {
    try {
      const polyPath = _s23PolylinePath(sweepPts, sweepClosed);
      cutter = sweep(cs, polyPath, {
        initialNormal,
        arcSamples,
        extrudeSegments,
      });
    } catch (e) {
      throw new Error(`filletAlongPath: sweep failed — ${e && e.message ? e.message : e}`);
    }
  }
  }
  if (cutter) {
    const seC = _c4StatusError(cutter);
    if (seC) throw new Error(`filletAlongPath: bad cutter (${seC})`);
    const cutterVol = typeof cutter.volume === 'function' ? cutter.volume() : 0;
    if (!(cutterVol > 1e-9)) {
      throw new Error('filletAlongPath: cutter has zero volume — check radius / path');
    }
  }
  if (filler) {
    const seF = _c4StatusError(filler);
    if (seF) throw new Error(`filletAlongPath: bad filler (${seF})`);
    const fillerVol = typeof filler.volume === 'function' ? filler.volume() : 0;
    if (!(fillerVol > 1e-9)) {
      throw new Error('filletAlongPath: filler has zero volume — check radius / path');
    }
  }
  if (!cutter && !filler) {
    throw new Error('filletAlongPath: no cutter or filler was built — re-pick edges');
  }

  let out = part;
  // The two booleans run SEPARATELY and are measured separately. A mixed-sign
  // chain removes on its convex runs and adds on its concave ones, so a single
  // net-volume check could pass while both halves were wrong.
  let removed = 0;
  if (cutter) {
    let cut;
    try {
      cut = M.difference(out, cutter);
    } catch (e) {
      throw new Error(`filletAlongPath: boolean subtract failed — ${e && e.message ? e.message : e}`);
    }
    const seCut = _c4StatusError(cut);
    if (seCut) throw new Error(`filletAlongPath: bad result (${seCut})`);
    const v = cut.volume();
    if (!(v > 1e-9)) {
      throw new Error('filletAlongPath: result is EMPTY (cutter consumed the solid) — reduce radius');
    }
    removed = out.volume() - v;
    out = cut;
    if (!(removed > 1e-6)) {
      throw new Error(
        'filletAlongPath: subtract removed ~0 volume — cutter likely outside the solid '
        + '(wrong orientation / path). Try reversing the path or pass opts.initialNormal.',
      );
    }
  }
  // Concave runs ADD material: the same wedge, unioned instead of subtracted.
  // Guards mirror the remove side — volume must go UP by ~the per-knot integral.
  if (filler) {
    const vPre = out.volume();
    let add;
    try {
      add = M.union([out, filler]);
    } catch (e) {
      throw new Error(`filletAlongPath: boolean union failed — ${e && e.message ? e.message : e}`);
    }
    const seAdd = _c4StatusError(add);
    if (seAdd) throw new Error(`filletAlongPath: bad result (${seAdd})`);
    const added = add.volume() - vPre;
    out = add;
    if (!(added > 1e-6)) {
      throw new Error(
        'filletAlongPath: union added ~0 volume — filler likely already inside the solid '
        + '(wrong orientation / path). Re-pick edges.',
      );
    }
    if (!testingOversize && expectAddOverride > 1e-3 && added < 0.02 * expectAddOverride) {
      throw new Error(
        `filletAlongPath: added only ${added.toFixed(4)} vs expected ~${expectAddOverride.toFixed(4)} `
        + '(orientation/overlap failure) — failing loud rather than shipping a near-no-op solid',
      );
    }
    if (expectAddOverride > 1e-3 && added > 8 * expectAddOverride) {
      throw new Error(
        `filletAlongPath: added ${added.toFixed(4)} vs expected ~${expectAddOverride.toFixed(4)} `
        + '(filler far larger than requested radius) — failing loud rather than shipping an oversized blend',
      );
    }
    // Pad lives outside the pre-fillet bbox. Clip after the volume guard so
    // expectAdd (which includes the pad length) still matches `added`.
    if (openEndBBox) out = _s23ClipToBBox(M, out, openEndBBox);
  }
  // Near-no-op and oversize guards use the dihedral removed-area when the
  // per-segment cutter ran. A 90°-only expect false-trips an acute fillet
  // (removed area grows as θ shrinks) and misses a hooked 90° wedge.
  const expectArea = profileKind === 'chamfer'
    ? 0.5 * radius * radius
    : radius * radius * (1 - Math.PI / 4);
  const expectVol = expectVolOverride != null ? expectVolOverride : expectArea * length;
  // Neutralise near-no-op when pinning the sibling 8× oversize guard —
  // a coordinated oversize probe would otherwise throw here first.
  if (cutter && !testingOversize && expectVol > 1e-3 && removed < 0.02 * expectVol) {
    throw new Error(
      `filletAlongPath: removed only ${removed.toFixed(4)} vs expected ~${expectVol.toFixed(4)} `
      + '(orientation/overlap failure) — failing loud rather than shipping a near-no-op solid',
    );
  }
  if (cutter && expectVol > 1e-3 && removed > 8 * expectVol) {
    throw new Error(
      `filletAlongPath: removed ${removed.toFixed(4)} vs expected ~${expectVol.toFixed(4)} `
      + '(cutter far larger than requested radius) — failing loud rather than shipping an oversized blend',
    );
  }
  // Join a fillet wedge that shares a face with the owner, then drop
  // disconnected cutter scraps (thin purple sheets) via decompose.
  // Closed-loop sweep seams often leave tiny extra components. For closed
  // paths, multiple components are a hard fail (no silent keep-largest).
  // Corner arcs are split upstream (planFilletSweepPath mode:'runs' →
  // independent semi-arc subtracts). No sphere-cap post-pass (#107 bulges).
  out = _filletJoinOwnedPieces(M, out);
  try {
    if (typeof out.decompose === 'function') {
      const parts = out.decompose();
      if (Array.isArray(parts) && parts.length > 1) {
        if (closed) {
          throw new Error(
            `filletAlongPath: decompose found ${parts.length} components on closed path `
            + '— failing loud rather than shipping a dirty solid',
          );
        }
        let best = parts[0];
        let bestVol = best.volume();
        for (let i = 1; i < parts.length; i++) {
          const v = parts[i].volume();
          if (v > bestVol) { bestVol = v; best = parts[i]; }
        }
        const scrapVol = parts.reduce((s, c) => s + c.volume(), 0) - bestVol;
        // If scraps are a real fraction of the solid, something is badly wrong.
        if (scrapVol > 0.05 * bestVol && scrapVol > 1e-2) {
          throw new Error(
            `filletAlongPath: decompose found ${parts.length} components with scrap vol `
            + `${scrapVol.toFixed(4)} — failing loud rather than shipping a dirty solid`,
          );
        }
        out = best;
      }
    }
  } catch (e) {
    if (/decompose found|dirty solid/i.test(String(e && e.message))) throw e;
  }
  // Duplicated vertices along a ruling split the convex rim and leave
  // long degenerate fins. The weld is index-only; volume must stay put.
  out = _s23WeldFilletResult(out);
  // Loud fail if the kept solid still has many degenerate tris (attached slivers).
  try {
    const mesh = out.getMesh();
    const np = mesh.numProp || 3;
    const V = mesh.vertProperties;
    const T = mesh.triVerts;
    const nTri = T.length / 3;
    let tiny = 0;
    for (let ti = 0; ti < nTri; ti++) {
      const i0 = T[ti * 3] * np;
      const i1 = T[ti * 3 + 1] * np;
      const i2 = T[ti * 3 + 2] * np;
      const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
      const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
      const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      if (A < 1e-8) tiny++;
    }
    // C6 closed-run filletEdges itself yields ~0.5–1% needles @1e-8 from
    // mesh boolean — only fail when the mesh is clearly scrap-sheet dirty.
    if (isFilletSliverDirty(tiny, nTri)) {
      throw new Error(
        `filletAlongPath: result has ${tiny}/${nTri} degenerate triangles (sliver scraps) — `
        + 'failing loud rather than shipping a dirty solid; try a smaller radius or Strategy=planar',
      );
    }
  } catch (e) {
    if (/sliver scraps|degenerate triangles/i.test(String(e && e.message))) throw e;
  }
  return out;
}

// ---------------------------------------------------------------- Fillet edge ids (edge-spec A)
// Ids come from the current mesh, and only from sharp edges that survive the
// boundary filter (shallow dihedral / tiny blend faces are not addressable).
// faceID is Manifold provenance and can merge or split after a boolean, so a
// miss throws instead of guessing.
const _boundaryCache = new WeakMap();

function _boundaryPositions(mesh) {
  const np = mesh.numProp || 3;
  const src = mesh.vertProperties;
  if (np === 3) return src;
  const nVert = Math.floor(src.length / np);
  const positions = new Float64Array(nVert * 3);
  for (let i = 0; i < nVert; i++) {
    positions[i * 3] = src[i * np];
    positions[i * 3 + 1] = src[i * np + 1];
    positions[i * 3 + 2] = src[i * np + 2];
  }
  return positions;
}

function _boundaryIndex(part) {
  if (!part || typeof part.getMesh !== 'function') {
    throw new Error('part must be a Manifold');
  }
  if (_boundaryCache.has(part)) return _boundaryCache.get(part);
  const mesh = part.getMesh();
  const topo = indexBoundaryEdges({
    positions: _boundaryPositions(mesh),
    indices: mesh.triVerts,
    faceIDs: mesh.faceID,
  });
  _boundaryCache.set(part, topo);
  return topo;
}

function _rePickEdges(detail) {
  throw new Error(
    `re-pick edges — ${detail}. Face and edge ids belong to this mesh; `
    + 'Manifold faceID can merge or split after a boolean, so the previous ids are not reused.',
  );
}

/**
 * edge(part, id) → mesh segments of one boundary edge.
 * id is the integer shown as e{id} in Fillet mode. Suitable for makeSweepPath.
 */
function edge(part, id) {
  const topo = _boundaryIndex(part);
  const n = Number(id);
  const found = (topo.edges || []).find((e) => e.id === n);
  if (!found) _rePickEdges(`edge ${id} is not on this solid`);
  return found.segments.map((seg) => ({ ...seg }));
}

/**
 * edgesBetween(part, faceA, faceB) → segments of the only boundary between
 * those face ids. Two disconnected boundaries of the same pair throw —
 * use edge(part, id) for the one you want.
 */
function edgesBetween(part, faceA, faceB) {
  const topo = _boundaryIndex(part);
  const fa = Number(faceA);
  const fb = Number(faceB);
  const hits = (topo.edges || []).filter((e) => (
    (e.faceA === fa && e.faceB === fb) || (e.faceA === fb && e.faceB === fa)
  ));
  if (!hits.length) _rePickEdges(`no boundary between faces ${fa} and ${fb}`);
  if (hits.length > 1) {
    _rePickEdges(
      `faces ${fa} and ${fb} share ${hits.length} boundary edges — use edge(part, id)`,
    );
  }
  return hits[0].segments.map((seg) => ({ ...seg }));
}

/**
 * boundaryEdges(part) → catalog { id, faceA, faceB, mid, length } for the
 * current mesh. Discovery helper; Fillet Accept emits edge / edgesBetween.
 */
function boundaryEdges(part) {
  const topo = _boundaryIndex(part);
  return (topo.edges || []).map((e) => ({
    id: e.id,
    faceA: e.faceA,
    faceB: e.faceB,
    mid: e.mid.slice(),
    length: e.length,
  }));
}

/**
 * cut(manifold, plane, opts) — split one or more bodies with a plane, then
 * optionally delete pieces. Uses Manifold.splitByPlane (no separate kernel).
 *
 * plane is a face `{ center, normal }` or an explicit `{ normal, originOffset }`.
 * `offset` on a face shifts the plane along the normal (positive with the
 * normal) and is added to center·normal. Offset 0 is the face itself.
 * A face is never read as a world-axis name. The first splitByPlane result is
 * the '+' side (along the normal); the second is '-'.
 *
 * A body that does not cross the plane is returned unchanged (same solid, so
 * the same volume, still one body). Pieces that are kept stay separate via
 * Manifold.compose, which decompose() splits back apart.
 *
 * opts.bodies — subset to cut, each `{ at }` near that body's vertex centroid.
 *   Omit to cut every body.
 * opts.keep — 'both' (default) | '+' | '-'.
 * opts.drop — `{ at, side }` pieces to delete when keep is not a whole side.
 */
function cut(manifold, plane, opts = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  if (!manifold || typeof manifold.splitByPlane !== 'function') {
    throw new Error('cut: expected a Manifold');
  }
  const { Manifold } = manifoldModule;
  const pl = _cutResolvePlane(plane);
  const options = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const keep = _cutKeepMode(options);
  const bodies = _cutBodiesOf(manifold);
  const selected = _cutSelected(bodies, options.bodies);
  const drops = _cutDrops(bodies, selected, options.drop, keep);
  const kept = [];
  const discard = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    if (!selected.has(i)) {
      kept.push(body);
      continue;
    }
    const split = _cutSplitOrOriginal(body, pl);
    for (const piece of split.pieces) {
      const drop = _cutPieceDropped(piece.side, i, keep, drops);
      if (drop) {
        if (!piece.original) discard.push(piece.manifold);
        continue;
      }
      kept.push(piece.manifold);
    }
    for (const extra of split.discard) discard.push(extra);
  }
  for (const m of discard) _safeDeleteManifold(m);
  if (!kept.length) throw new Error('cut: every piece was deleted');
  const result = kept.length === 1 ? kept[0] : Manifold.compose(kept);
  const status = _c4StatusError(result);
  if (status) throw new Error(`cut: result is not a valid solid (${status})`);
  return result;
}

/**
 * move(manifold, [dx, dy, dz], { bodies: [{ at }] }) — translate one body.
 * Same Manifold.translate center() already uses, and the same decompose /
 * centroid / compose split cut() uses. Not a second kernel. The named body
 * moves; every other body stays. A zero delta returns the input solid.
 *
 * The { at } point is that body's vertex centroid. cut() requires squared
 * distance ≤ 1e-4. A fillet does not retessellate the same way on the next
 * run, so that average can move by a few hundredths and a valid pick would
 * miss the tight gate. move() still takes the exact match, and otherwise
 * the nearest body within 1% of its radius (at least 0.05) when the next
 * body is farther than that. A point that is not near a centroid throws.
 */
function move(manifold, delta, opts = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  if (!manifold || typeof manifold.translate !== 'function') {
    throw new Error('move: expected a Manifold');
  }
  if (!Array.isArray(delta) || delta.length < 3) {
    throw new Error('move: delta must be finite [dx, dy, dz]');
  }
  const d = [Number(delta[0]), Number(delta[1]), Number(delta[2])];
  if (d.some((v) => !Number.isFinite(v))) {
    throw new Error('move: delta must be finite [dx, dy, dz]');
  }
  const options = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  if (!Array.isArray(options.bodies) || options.bodies.length !== 1) {
    throw new Error('move: name one body with { bodies: [{ at }] }');
  }
  let bodies;
  let selected;
  try {
    bodies = _cutBodiesOf(manifold);
    selected = _moveSelected(bodies, options.bodies);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(msg.replace(/^cut:/, 'move:'));
  }
  if (selected.size !== 1) {
    throw new Error('move: name one body with { bodies: [{ at }] }');
  }
  const zero = d[0] === 0 && d[1] === 0 && d[2] === 0;
  if (bodies.length === 1 && bodies[0] === manifold) {
    if (zero) return manifold;
    const moved = manifold.translate(d);
    const status = _c4StatusError(moved);
    if (status) throw new Error(`move: result is not a valid solid (${status})`);
    return moved;
  }
  if (zero) {
    for (const body of bodies) {
      if (body && body !== manifold) _safeDeleteManifold(body);
    }
    return manifold;
  }
  const { Manifold } = manifoldModule;
  const kept = [];
  const discard = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    if (!selected.has(i)) {
      kept.push(body);
      continue;
    }
    kept.push(body.translate(d));
    if (body !== manifold) discard.push(body);
  }
  for (const m of discard) _safeDeleteManifold(m);
  const result = kept.length === 1 ? kept[0] : Manifold.compose(kept);
  const status = _c4StatusError(result);
  if (status) throw new Error(`move: result is not a valid solid (${status})`);
  return result;
}

/** Face { center, normal, offset? } or explicit { normal, originOffset }. Never an axis name. */
function _cutResolvePlane(plane) {
  if (plane == null || typeof plane !== 'object' || Array.isArray(plane)) {
    throw new Error("cut: plane must be a face { center, normal } or { normal, originOffset } — not a world-axis name");
  }
  const nRaw = plane.normal;
  if (!Array.isArray(nRaw) || nRaw.length < 3) {
    throw new Error('cut: plane.normal must be [x, y, z]');
  }
  const nx = Number(nRaw[0]);
  const ny = Number(nRaw[1]);
  const nz = Number(nRaw[2]);
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-12) || !Number.isFinite(len)) throw new Error('cut: plane normal has zero length');
  const normal = [nx / len, ny / len, nz / len];
  let originOffset;
  if (plane.originOffset != null && plane.originOffset !== '') {
    originOffset = Number(plane.originOffset);
    if (!Number.isFinite(originOffset)) throw new Error('cut: originOffset must be a finite number');
  } else if (Array.isArray(plane.center) && plane.center.length >= 3) {
    const c = plane.center.map(Number);
    if (c.some((v) => !Number.isFinite(v))) throw new Error('cut: plane.center must be finite');
    originOffset = normal[0] * c[0] + normal[1] * c[1] + normal[2] * c[2];
  } else {
    throw new Error('cut: plane needs originOffset or a center from the picked face');
  }
  if (plane.offset != null && plane.offset !== '') {
    const extra = Number(plane.offset);
    if (!Number.isFinite(extra)) throw new Error('cut: offset must be a finite number');
    originOffset += extra;
  }
  return { normal, originOffset };
}

function _cutKeepMode(options) {
  const keep = options.keep == null ? 'both' : options.keep;
  if (keep !== 'both' && keep !== '+' && keep !== '-') {
    throw new Error(`cut: keep must be 'both', '+', or '-' (got ${keep})`);
  }
  if (keep !== 'both' && Array.isArray(options.drop) && options.drop.length) {
    throw new Error('cut: pass keep or drop, not both');
  }
  return keep;
}

function _cutVol(m) {
  try {
    const v = m.volume();
    return Number.isFinite(v) ? v : 0;
  } catch (_) {
    return 0;
  }
}

function _cutNegligible(m, total) {
  if (!m) return true;
  if (typeof m.isEmpty === 'function') {
    try { if (m.isEmpty()) return true; } catch (_) { /* volume floor below */ }
  }
  const floor = Math.max(1e-6, Math.abs(total) * 1e-8);
  return !(_cutVol(m) > floor);
}

/** More than one component → those bodies. One component → the input, unchanged. */
function _cutBodiesOf(manifold) {
  if (typeof manifold.decompose !== 'function') return [manifold];
  let parts = null;
  try { parts = manifold.decompose(); } catch (_) { parts = null; }
  if (!Array.isArray(parts) || parts.length <= 1) {
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (p && p !== manifold) _safeDeleteManifold(p);
      }
    }
    return [manifold];
  }
  return parts;
}

/**
 * Centroids move() will accept for each decomposed body. Computed on a clone
 * so the cached solid stays put. The viewport mesh's own average can miss
 * these by enough to fail the 1e-4 gate after a cut of a filleted shell.
 */
function _kernelBodyCentroids(manifold) {
  if (!manifold || typeof manifold.clone !== 'function') return [];
  const clone = manifold.clone();
  const extra = [];
  try {
    const bodies = _cutBodiesOf(clone);
    const at = [];
    for (const body of bodies) {
      if (body !== clone) extra.push(body);
      const c = _cutCentroid(body);
      at.push([Number(c[0]), Number(c[1]), Number(c[2])]);
    }
    return at;
  } catch (_) {
    return [];
  } finally {
    for (const body of extra) _safeDeleteManifold(body);
    _safeDeleteManifold(clone);
  }
}

function _cutCentroid(body) {
  const mesh = body.getMesh();
  const vp = mesh.vertProperties;
  const np = mesh.numProp || 3;
  const n = Math.floor(vp.length / np);
  if (!n) return [0, 0, 0];
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    sx += vp[i * np];
    sy += vp[i * np + 1];
    sz += vp[i * np + 2];
  }
  return [sx / n, sy / n, sz / n];
}

function _cutDist2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function _cutBodyIndex(bodies, at) {
  const point = [Number(at[0]), Number(at[1]), Number(at[2])];
  if (point.some((v) => !Number.isFinite(v))) {
    throw new Error('cut: body point must be finite [x, y, z]');
  }
  let best = -1;
  let bestD = Infinity;
  let second = Infinity;
  for (let i = 0; i < bodies.length; i++) {
    const d = _cutDist2(_cutCentroid(bodies[i]), point);
    if (d < bestD) {
      second = bestD;
      bestD = d;
      best = i;
    } else if (d < second) {
      second = d;
    }
  }
  // 4-decimal script literals land well inside 1e-2 of the vertex centroid.
  if (!(bestD <= 1e-4)) {
    throw new Error('cut: that point is not a body centroid — re-pick the body');
  }
  if (second <= 1e-4 && Math.sqrt(second) - Math.sqrt(bestD) < 1e-4) {
    throw new Error('cut: that point matches more than one body');
  }
  return best;
}

/** Vertex centroid plus the farthest vertex, for move()'s looser match. */
function _moveCentroidSpan(body) {
  const mesh = body.getMesh();
  const vp = mesh.vertProperties;
  const np = mesh.numProp || 3;
  const n = Math.floor(vp.length / np);
  if (!n) return { at: [0, 0, 0], radius: 0 };
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    sx += vp[i * np];
    sy += vp[i * np + 1];
    sz += vp[i * np + 2];
  }
  const at = [sx / n, sy / n, sz / n];
  let max2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = vp[i * np] - at[0];
    const dy = vp[i * np + 1] - at[1];
    const dz = vp[i * np + 2] - at[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > max2) max2 = d2;
  }
  return { at, radius: Math.sqrt(max2) };
}

/**
 * Body named by { at }. Exact literals use cut()'s 1e-4 gate. A drifted
 * pick still names the nearest body when it sits within 1% of that body's
 * radius (at least 0.05) and the next body is outside that distance.
 */
function _moveBodyIndex(bodies, at) {
  const point = [Number(at[0]), Number(at[1]), Number(at[2])];
  if (point.some((v) => !Number.isFinite(v))) {
    throw new Error('move: body point must be finite [x, y, z]');
  }
  const spans = bodies.map((body) => _moveCentroidSpan(body));
  let best = -1;
  let bestD = Infinity;
  let second = Infinity;
  for (let i = 0; i < spans.length; i++) {
    const d = _cutDist2(spans[i].at, point);
    if (d < bestD) {
      second = bestD;
      bestD = d;
      best = i;
    } else if (d < second) {
      second = d;
    }
  }
  if (best < 0) {
    throw new Error('move: that point is not a body centroid — re-pick the body');
  }
  if (bestD <= 1e-4) {
    if (second <= 1e-4 && Math.sqrt(second) - Math.sqrt(bestD) < 1e-4) {
      throw new Error('move: that point matches more than one body');
    }
    return best;
  }
  const tol = Math.max(0.05, spans[best].radius * 0.01);
  const tol2 = tol * tol;
  if (bestD <= tol2 && !(second <= tol2)) return best;
  if (bestD <= tol2) {
    throw new Error('move: that point matches more than one body');
  }
  throw new Error('move: that point is not a body centroid — re-pick the body');
}

function _moveSelected(bodies, spec) {
  if (!Array.isArray(spec) || spec.length !== 1) {
    throw new Error('move: name one body with { bodies: [{ at }] }');
  }
  const entry = spec[0];
  const at = entry && (entry.at || entry.center);
  if (!Array.isArray(at)) throw new Error('move: name one body with { bodies: [{ at }] }');
  return new Set([_moveBodyIndex(bodies, at)]);
}

function _cutSelected(bodies, spec) {
  const selected = new Set();
  if (Array.isArray(spec) && spec.length) {
    for (const entry of spec) {
      const at = entry && (entry.at || entry.center);
      if (!Array.isArray(at)) throw new Error('cut: bodies entries need { at: [x, y, z] }');
      selected.add(_cutBodyIndex(bodies, at));
    }
    return selected;
  }
  for (let i = 0; i < bodies.length; i++) selected.add(i);
  return selected;
}

function _cutDrops(bodies, selected, spec, keep) {
  const drops = [];
  if (keep !== 'both' || !Array.isArray(spec)) return drops;
  for (const entry of spec) {
    const at = entry && (entry.at || entry.center);
    const side = entry && entry.side;
    if (side !== '+' && side !== '-') throw new Error("cut: drop side must be '+' or '-'");
    if (!Array.isArray(at)) throw new Error('cut: drop entries need { at, side }');
    const idx = _cutBodyIndex(bodies, at);
    if (!selected.has(idx)) throw new Error('cut: cannot drop a piece of a body that was not cut');
    drops.push({ idx, side });
  }
  return drops;
}

function _cutPieceDropped(side, idx, keep, drops) {
  if (keep === '+') return side === '-';
  if (keep === '-') return side === '+';
  return drops.some((d) => d.idx === idx && d.side === side);
}

function _cutExtents(body, normal, originOffset) {
  const mesh = body.getMesh();
  const vp = mesh.vertProperties;
  const np = mesh.numProp || 3;
  let min = Infinity;
  let max = -Infinity;
  const n = Math.floor(vp.length / np);
  for (let i = 0; i < n; i++) {
    const d = vp[i * np] * normal[0] + vp[i * np + 1] * normal[1] + vp[i * np + 2] * normal[2] - originOffset;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

/**
 * Split only when vertices lie strictly on both sides. Otherwise hand back
 * the same body (a tangent plane is not a cut). Empty split halves are the
 * same case — discard them and keep the original.
 */
function _cutSplitOrOriginal(body, plane) {
  const eps = 1e-5;
  const { min, max } = _cutExtents(body, plane.normal, plane.originOffset);
  const crosses = min < -eps && max > eps;
  const wholeSide = min >= -eps ? '+' : '-';
  if (!crosses) {
    return { pieces: [{ side: wholeSide, manifold: body, original: true }], discard: [] };
  }
  const total = _cutVol(body);
  const halves = body.splitByPlane(plane.normal, plane.originOffset);
  const pos = halves && halves[0];
  const neg = halves && halves[1];
  const posEmpty = _cutNegligible(pos, total);
  const negEmpty = _cutNegligible(neg, total);
  if (posEmpty || negEmpty) {
    return {
      pieces: [{ side: posEmpty ? '-' : '+', manifold: body, original: true }],
      discard: [pos, neg].filter(Boolean),
    };
  }
  return {
    pieces: [
      { side: '+', manifold: pos, original: false },
      { side: '-', manifold: neg, original: false },
    ],
    discard: [],
  };
}

/**
 * booleanBodies(manifold, { op, bodies, drop }) — union, difference, or
 * intersect of named bodies. The first { at } is the target. Later entries
 * are tools, unioned together, then subtracted from or intersected with the
 * target. Bodies that were not named stay in the solid.
 *
 * op: 'union' | 'difference' | 'intersect'.
 * bodies: [{ at }] near each body's vertex centroid, in pick order.
 *   Omit to use every body, in decompose order.
 * drop: intersect only. [{ at }] centroids of leftover pieces to delete.
 *   A piece that is not listed stays. Deleting every piece throws.
 */
function booleanBodies(manifold, opts = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  if (!manifold || typeof manifold.decompose !== 'function') {
    throw new Error('booleanBodies: expected a Manifold');
  }
  const { Manifold } = manifoldModule;
  const options = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const op = _booleanOp(options.op);
  const tools = _booleanExternalTools(options.tools);
  const bodies = _cutBodiesOf(manifold);
  let selected;
  try {
    // With external tools, an omitted list is the first body only (the target),
    // not every body: the tools come from another part.
    const spec = (tools.length && (!Array.isArray(options.bodies) || !options.bodies.length))
      ? [{ at: _cutCentroid(bodies[0]) }]
      : options.bodies;
    selected = _booleanSelected(bodies, spec);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(msg.replace(/^cut:/, 'booleanBodies:'));
  }
  if (selected.length + tools.length < 2) {
    throw new Error('booleanBodies: pick a target and at least one tool body');
  }
  // External tools (frozen copies from another part) follow the named
  // bodies. The first named body is still the target.
  const picked = [...selected.map((i) => bodies[i]), ...tools];
  const sel = new Set(selected);
  const rest = [];
  for (let i = 0; i < bodies.length; i++) {
    if (!sel.has(i)) rest.push(bodies[i]);
  }
  const combined = _booleanCombine(op, picked);
  let shaped = combined.result;
  const discard = combined.temps.slice();
  for (const tool of tools) {
    if (tool !== shaped) discard.push(tool);
  }
  if (op === 'intersect' && Array.isArray(options.drop) && options.drop.length) {
    const dropped = _booleanDropPieces(shaped, options.drop);
    shaped = dropped.kept;
    for (const extra of dropped.discard) discard.push(extra);
  }
  if (_booleanEmpty(shaped)) {
    for (const extra of discard) _safeDeleteManifold(extra);
    for (const body of bodies) {
      if (body && body !== manifold) _safeDeleteManifold(body);
    }
    throw new Error(op === 'intersect'
      ? 'booleanBodies: intersection is empty'
      : 'booleanBodies: result is empty');
  }
  const kept = [shaped, ...rest];
  const keepSet = new Set(kept);
  for (const body of bodies) {
    if (body && body !== manifold && !keepSet.has(body)) discard.push(body);
  }
  if (combined.result && combined.result !== shaped && !keepSet.has(combined.result)) {
    discard.push(combined.result);
  }
  for (const extra of discard) {
    if (extra && extra !== manifold && !keepSet.has(extra)) _safeDeleteManifold(extra);
  }
  const result = kept.length === 1 ? kept[0] : Manifold.compose(kept);
  const status = _c4StatusError(result);
  if (status) throw new Error(`booleanBodies: result is not a valid solid (${status})`);
  return result;
}

function _booleanExternalTools(list) {
  if (list == null) return [];
  const arr = Array.isArray(list) ? list : [list];
  const out = [];
  for (const m of arr) {
    if (!m || typeof m.decompose !== 'function') {
      throw new Error('booleanBodies: tools entries must be solids (externalBody(...))');
    }
    out.push(m);
  }
  return out;
}

/**
 * Pick bodies out of a copied solid and pose them into the target frame.
 * `bodies` are [{ at }] vertex centroids in the source part's frame.
 * Omit them to keep the whole solid. `offset` is source position − target
 * position (assembly placement is a translation).
 */
function _externalPick(solid, bodies, offset, label = 'externalBody') {
  const { Manifold } = manifoldModule;
  if (!solid || typeof solid.decompose !== 'function') {
    throw new Error(`${label}: the copied script must return a Manifold`);
  }
  let picked = solid;
  if (Array.isArray(bodies) && bodies.length) {
    const all = _cutBodiesOf(solid);
    const idx = [];
    for (const entry of bodies) {
      const at = entry && (entry.at || entry.center);
      if (!Array.isArray(at)) throw new Error(`${label}: bodies entries need { at: [x, y, z] }`);
      let i;
      try {
        i = _cutBodyIndex(all, at);
      } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err);
        throw new Error(msg.replace(/^cut:/, `${label}:`));
      }
      if (!idx.includes(i)) idx.push(i);
    }
    const keep = idx.map((i) => all[i]);
    for (let i = 0; i < all.length; i++) {
      if (!idx.includes(i) && all[i] !== solid) _safeDeleteManifold(all[i]);
    }
    picked = keep.length === 1 ? keep[0] : Manifold.compose(keep);
    if (keep.length > 1) {
      for (const k of keep) if (k !== solid) _safeDeleteManifold(k);
    }
  }
  const off = Array.isArray(offset) ? offset.map(Number) : [0, 0, 0];
  if (off.some((v) => !Number.isFinite(v))) throw new Error(`${label}: offset must be finite [dx, dy, dz]`);
  if (off[0] || off[1] || off[2]) {
    const moved = picked.translate(off);
    if (picked !== solid) _safeDeleteManifold(picked);
    picked = moved;
  }
  return picked;
}

/**
 * externalBody(source, { bodies, offset }) — a frozen copy of geometry from
 * another part. `source` is a function holding that part's script text as
 * it was at Accept (or a Manifold). It is not linked: editing the source part
 * later does not change this copy. `bodies` picks bodies by vertex centroid
 * in the source frame; `offset` poses the copy into this part's frame.
 */
function externalBody(source, opts = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const options = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const solid = typeof source === 'function' ? source() : source;
  const posed = _externalPick(solid, options.bodies, options.offset);
  if (posed !== solid && typeof source === 'function') _safeDeleteManifold(solid);
  return posed;
}

function _booleanOp(op) {
  const v = op == null ? 'union' : String(op).toLowerCase();
  if (v === 'union' || v === 'add') return 'union';
  if (v === 'difference' || v === 'subtract' || v === 'cut') return 'difference';
  if (v === 'intersect' || v === 'intersection') return 'intersect';
  throw new Error(`booleanBodies: op must be 'union', 'difference', or 'intersect' (got ${op})`);
}

function _booleanSelected(bodies, spec) {
  if (!Array.isArray(spec) || !spec.length) {
    return bodies.map((_, i) => i);
  }
  const selected = [];
  const seen = new Set();
  for (const entry of spec) {
    const at = entry && (entry.at || entry.center);
    if (!Array.isArray(at)) throw new Error('booleanBodies: bodies entries need { at: [x, y, z] }');
    let idx;
    try {
      idx = _cutBodyIndex(bodies, at);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      throw new Error(msg.replace(/^cut:/, 'booleanBodies:'));
    }
    if (seen.has(idx)) continue;
    seen.add(idx);
    selected.push(idx);
  }
  return selected;
}

function _booleanCombine(op, picked) {
  const { Manifold } = manifoldModule;
  if (op === 'union') {
    if (picked.length === 1) return { result: picked[0], temps: [] };
    return { result: Manifold.union(picked), temps: [] };
  }
  const target = picked[0];
  const tools = picked.slice(1);
  const temps = [];
  let tool = tools[0];
  if (tools.length > 1) {
    tool = Manifold.union(tools);
    temps.push(tool);
  }
  const result = op === 'difference'
    ? Manifold.difference(target, tool)
    : Manifold.intersection(target, tool);
  return { result, temps };
}

function _booleanEmpty(m) {
  if (!m) return true;
  if (typeof m.isEmpty === 'function') {
    try { if (m.isEmpty()) return true; } catch (_) { /* volume floor below */ }
  }
  return !(_cutVol(m) > 1e-8);
}

function _booleanDropPieces(result, spec) {
  const pieces = _cutBodiesOf(result);
  const dropIdx = new Set();
  for (const entry of spec) {
    const at = entry && (entry.at || entry.center);
    if (!Array.isArray(at)) throw new Error('booleanBodies: drop entries need { at: [x, y, z] }');
    try {
      dropIdx.add(_cutBodyIndex(pieces, at));
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      throw new Error(msg.replace(/^cut:/, 'booleanBodies:'));
    }
  }
  const kept = [];
  const discard = [];
  for (let i = 0; i < pieces.length; i++) {
    if (dropIdx.has(i)) {
      if (pieces[i] !== result) discard.push(pieces[i]);
      continue;
    }
    kept.push(pieces[i]);
  }
  if (!kept.length) throw new Error('booleanBodies: every piece was deleted');
  if (kept.length === 1) return { kept: kept[0], discard };
  const { Manifold } = manifoldModule;
  return { kept: Manifold.compose(kept), discard };
}

// Collection of all helper functions to inject
/**
 * Feature-op brackets for the face graph. Manifold hands out originalIDs in
 * order, so the IDs reserved while one fillet / chamfer call ran are exactly
 * that op's cutter pieces (legs, corner patches, welded rebuilds). The face
 * graph never merges a curved patch across two feature keys, so a fillet
 * stays one face and does not spill onto a tangent loft wall or the next
 * fillet. Reset per execute.
 */
let _featureOps = [];
function _probeOriginalID() {
  try {
    const probe = manifoldModule.Manifold.cube([1e-3, 1e-3, 1e-3]);
    const id = probe.originalID();
    probe.delete?.();
    return Number.isFinite(id) ? id : -1;
  } catch {
    return -1;
  }
}
function _featureOp(fn) {
  return function featureOp(...args) {
    const lo = _probeOriginalID();
    const out = fn.apply(this, args);
    const hi = _probeOriginalID();
    if (lo >= 0 && hi > lo + 1) _featureOps.push([lo, hi]);
    return out;
  };
}
/** Per run: the outermost op that reserved its originalID (−(op+1)), else the originalID. */
function _runFeatureKeys(runOriginalID) {
  const out = new Array(runOriginalID.length);
  for (let r = 0; r < runOriginalID.length; r++) {
    const id = runOriginalID[r];
    let key = id;
    for (let k = 0; k < _featureOps.length; k++) {
      const [lo, hi] = _featureOps[k];
      if (id > lo && id < hi) { key = -(k + 1); break; }
    }
    out[r] = key;
  }
  return out;
}

const HELPER_FUNCTIONS = {
  shell,
  hollow,
  getScaleRatio,
  roundedBox,
  tube,
  rectTube,
  hexPrism,
  mirror,
  array3D,
  polarArray,
  center,
  align,
  getDimensions,
  addDraft,
  draftFaces,
  cut,
  booleanBodies,
  externalBody,
  move,
  moveFace,
  deleteFace,
  loft,
  //loft helpers
  sumSqDist,
  rotateContour,
  sweep,
  sweepPoints,
  // sweeo helpers
  vecAdd,
  vecSub,
  vecMul,
  vecDot,
  vecCross,
  vecNorm,
  vecNormalize,
  // C4 selection + feature helpers (see block above)
  facesByNormal,
  planarFaceAt,
  edgesByOrientation,
  workplaneFromFace,
  placeInFrame,
  transformByFrame,
  placeOnFace,
  hole,
  holeSpan,
  cboreHole,
  cskHole,
  chamferEdges: _featureOp(chamferEdges),
  convexEdges,
  concaveEdges,
  signedFeatureEdges,
  holePattern,
  // Slice-01 fastener vocabulary
  clearanceHole,
  tapDrillHole,
  fastenerClearanceDia,
  fastenerTapDrillDia,
  fastenerMajorDia,
  listFastenerSizes,
  resolveFastenerSize,
  // C6 fillet (see block above)
  filletEdges: _featureOp(filletEdges),
  // C8 revolve/extrude with safe winding (see block above)
  makeRevolve,
  makeExtrude,
  makeLoft,
  offsetPlaneFrame,
  // SCS sheet metal
  sheetMetalSolid,
  // Slice 21 cross-section substrate (plane + 2D profile)
  profileCircle,
  profileRectangle,
  profilePolygon,
  makeCrossSection,
  // Slice 22 edge → sweep path / wire
  makeSweepPath,
  // Slice 23 fillet via swept cross-section
  filletAlongPath: _featureOp(filletAlongPath),
  // Fillet-mode edge ids
  edge,
  edgesBetween,
  boundaryEdges,
};

// ============================================================================
// WORKER CORE
// ============================================================================

/**
 * Load and initialize Manifold WASM
 */
const initializeManifold = async () => {
  if (isInitialized) return;
  
  try {
    manifoldModule = await Module();
    manifoldModule.setup();
    // part.add(solid, { merge: false }) + per-body booleans on overlapping bodies.
    installSeparateBodies(manifoldModule);
    
    isInitialized = true;
    console.log('[SandboxWorker] Manifold initialized');
  } catch (error) {
    console.error('[SandboxWorker] Failed to initialize Manifold:', error);
    throw error;
  }
};

// Captured before lockdown. The lockdown spreads `performance` into a frozen
// object, which drops `now` (it lives on the prototype), so a later
// `performance.now()` throws and the script never runs.
const _perfNow = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? performance.now.bind(performance)
  : () => Date.now();

/**
 * Block dangerous globals
 */
const lockdownGlobals = () => {
  // Block dangerous globals by replacing with functions that throw
  for (const name of BLOCKED_GLOBALS) {
    if (name in self) {
      Object.defineProperty(self, name, {
        get() {
          throw new Error(`Access to '${name}' is not allowed in scripts`);
        },
        configurable: false
      });
    }
  }
  
  // Make certain globals read-only and return limited info
  for (const name of READONLY_GLOBALS) {
    const original = self[name];
    if (original) {
      Object.defineProperty(self, name, {
        get() {
          // Return a frozen proxy that only allows safe operations
          return Object.freeze({ ...original });
        },
        configurable: false
      });
    }
  }
  
  console.log('[SandboxWorker] Globals locked down');
};

/**
 * Reconstruct a Manifold from mesh data
 */
const reconstructManifold = (meshData) => {
  if (!manifoldModule) {
    throw new Error('Manifold not initialized');
  }
  
  const { Manifold } = manifoldModule;
  
  const vertProperties = new Float32Array(meshData.vertProperties);
  const triVerts = new Uint32Array(meshData.triVerts);
  
  const mesh = {
    numProp: meshData.numProp || 3,
    vertProperties,
    triVerts
  };
  
  return new Manifold(mesh);
};

/**
 * Execute the user script with the Manifold API and helper functions
 */
const executeScript = (script, importedModels) => {
  if (!manifoldModule) {
    throw new Error('Manifold not initialized');
  }
  
  // Set up __importedManifolds with reconstructed Manifolds
  const importedManifolds = {};
  for (const [filename, meshData] of Object.entries(importedModels || {})) {
    importedManifolds[filename] = reconstructManifold(meshData);
  }
  
  // Create a limited window-like object for imports only
  const limitedWindow = {
    __importedManifolds: importedManifolds
  };
  
  // Which marked feature block is running (feature strip red border). This
  // does not depend on the engine's stack format, unlike `scriptLine`.
  const tracker = createFeatureTracker();
  const traced = instrumentFeatureBlocks(script);

  // Build the execution scope with Manifold API + helper functions
  const scope = {
    ...manifoldModule,        // Core Manifold API (Manifold, CrossSection, etc.)
    ...HELPER_FUNCTIONS,      // Extended helper functions
    window: limitedWindow,    // Limited window object for imports
    [FEATURE_TRACE_ENTER]: tracker.enter,
    [FEATURE_TRACE_LEAVE]: tracker.leave,
  };
  
  const scopeKeys = Object.keys(scope);
  const scopeValues = Object.values(scope);
  
  // Create the function (strict mode). The instrumented body keeps every
  // line where it was; if it does not compile (a marker inside an
  // expression), run the script as written, untracked.
  // Both stay a plain top-level function body (no wrapper function), so a
  // user `let cut` still shadows the helper the way it always did.
  const wrappedScript = `"use strict";\n${script}`;
  const tracedScript = `"use strict";\n${traced.script}`;
  let fn;
  let features = traced.features;
  try {
    fn = new Function(...scopeKeys, tracedScript);
  } catch (compileErr) {
    if (tracedScript === wrappedScript) throw compileErr;
    fn = new Function(...scopeKeys, wrappedScript);
    features = [];
  }
  try {
    return fn(...scopeValues);
  } catch (err) {
    if (err && typeof err === 'object') {
      // Primary: the open feature block (works on every engine).
      const open = tracker.current();
      const hit = open != null ? features[open] : null;
      if (hit) {
        try {
          err.featureId = hit.id;
          err.featureBlock = hit.block;
        } catch { /* frozen error */ }
      }
      // Fallback: script line of the failing call from the stack (V8 /
      // Firefox; Safari frames often do not match).
      if (_scriptLineOffset === undefined) _scriptLineOffset = calibrateScriptLineOffset();
      const line = scriptLineFromStack(err?.stack, _scriptLineOffset);
      if (line != null) {
        try { err.scriptLine = line; } catch { /* frozen error */ }
      }
    }
    throw err;
  }
};

/** Engine header lines before the script in a `new Function` body (lazy). */
let _scriptLineOffset;

/**
 * Serialize a Manifold result to mesh data for transfer
 */
const serializeResult = (manifold) => {
  if (!manifold || typeof manifold.getMesh !== 'function') {
    throw new Error('Script must return a Manifold object');
  }
  
  const mesh = manifold.getMesh();
  
  return {
    numProp: mesh.numProp,
    vertProperties: Array.from(mesh.vertProperties),
    triVerts: Array.from(mesh.triVerts),
    numRun: mesh.numRun,
    runIndex: Array.from(mesh.runIndex),
    runOriginalID: Array.from(mesh.runOriginalID),
    runFeature: _runFeatureKeys(mesh.runOriginalID),
    faceID: mesh.faceID ? Array.from(mesh.faceID) : null,
  };
};

/**
 * Memory monitoring - check if we're using too much memory
 */
const checkMemoryUsage = (limitMB) => {
  if (performance.memory) {
    const usedMB = performance.memory.usedJSHeapSize / (1024 * 1024);
    if (usedMB > limitMB) {
      throw new Error(`Memory limit exceeded: ${usedMB.toFixed(1)}MB > ${limitMB}MB`);
    }
    return usedMB;
  }
  return null; // Can't measure in this browser
};

/**
 * Message handler
 */
// ============================================================================
// STAGE VERIFICATION (dev tooling, harness/pilot_eval.mjs)
// The staging environment is the single source of kernel truth: candidate
// scripts AND reference solids both execute against the SAME bundled
// built/manifold.wasm the browser uses, and the symmetric-difference verdict
// runs HERE, in the worker, against that build. The harness's npm manifold-3d
// copy stays a cross-check, never the arbiter.
//
// Reference channel: STEP has no browser import path (backend obj_converter is
// a x86_64 ELF and firejail is absent on this box), so references are pushed as
// OBJ. The app's own importOBJ uses the STRICT constructor and is untouched;
// these paths weld in JS first (exact float-identity, then tolerance grid),
// because the WASM Mesh.merge() repair ladder crashes on unwelded input.
// ============================================================================

const _stagedReferences = new Map();   // filename -> { manifold, volume, boundingBox, source }

function _weldMeshData(vertProperties, triVerts, tolerance) {
  const vp = vertProperties;
  const n = vp.length / 3;
  const remap = new Int32Array(n);
  const out = [];
  const seen = new Map();
  const inv = tolerance > 0 ? 1 / tolerance : 0;
  for (let i = 0; i < n; i++) {
    const key = inv
      ? `${Math.round(vp[i * 3] * inv)}|${Math.round(vp[i * 3 + 1] * inv)}|${Math.round(vp[i * 3 + 2] * inv)}`
      : `${vp[i * 3]}|${vp[i * 3 + 1]}|${vp[i * 3 + 2]}`;
    let j = seen.get(key);
    if (j === undefined) { j = out.length / 3; seen.set(key, j); out.push(vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2]); }
    remap[i] = j;
  }
  const nt = new Uint32Array(triVerts.length);
  for (let i = 0; i < triVerts.length; i++) nt[i] = remap[triVerts[i]];
  return { numProp: 3, vertProperties: new Float32Array(out), triVerts: nt };
}

/** Build a Manifold from raw mesh arrays: strict first, then weld-exact, then weld@tol. */
function _meshDataToManifold(vertProperties, triVerts, tolerance = 0.001) {
  const { Mesh, Manifold } = manifoldModule;
  const tryBuild = (data) => {
    try {
      const m = new Manifold(new Mesh({ numProp: 3, vertProperties: new Float32Array(data.vertProperties), triVerts: new Uint32Array(data.triVerts) }));
      if (m && !m.isEmpty()) {
        const vol = m.volume();
        if (isFinite(vol) && vol > 0) return m;
      }
    } catch (e) {
      // strict constructor throws 'Not manifold' on unwelded STL-style meshes; fall through
    }
    return null;
  };
  let m = tryBuild({ vertProperties, triVerts });
  if (m) return { manifold: m, repair: 'strict' };
  console.log(`[stage] strict build failed for ${vertProperties.length / 3}v/${triVerts.length / 3}t — trying weld-exact`);
  m = tryBuild(_weldMeshData(vertProperties, triVerts, 0));
  if (m) return { manifold: m, repair: 'weld-exact' };
  console.log('[stage] weld-exact failed — trying weld@tol');
  if (tolerance > 0) {
    m = tryBuild(_weldMeshData(vertProperties, triVerts, tolerance));
    if (m) return { manifold: m, repair: `weld@${tolerance}` };
  }
  throw new Error('stage: could not construct valid manifold from mesh data');
}

function _parseOBJToMeshData(objText) {
  const vertices = [];
  const triangles = [];
  for (const raw of String(objText).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3]);
      if (isFinite(x) && isFinite(y) && isFinite(z)) vertices.push([x, y, z]);
    } else if (parts[0] === 'f') {
      const idx = [];
      for (let i = 1; i < parts.length; i++) {
        if (!parts[i]) continue;
        const v = parseInt(parts[i].split('/')[0], 10);
        if (!v || isNaN(v)) continue;
        idx.push(v < 0 ? vertices.length + v : v - 1);
      }
      for (let i = 1; i < idx.length - 1; i++) triangles.push([idx[0], idx[i], idx[i + 1]]);
    }
  }
  if (!vertices.length || !triangles.length) throw new Error('stage: OBJ contains no geometry');
  const vertProperties = new Float32Array(vertices.length * 3);
  vertices.forEach((p, i) => vertProperties.set(p, i * 3));
  const triVerts = new Uint32Array(triangles.length * 3);
  triangles.forEach((p, i) => triVerts.set(p, i * 3));
  return { vertProperties, triVerts };
}

function _bboxArray(m) {
  const b = m.boundingBox();
  return { min: [...b.min], max: [...b.max] };
}

function _centerAtBbox(m) {
  const b = m.boundingBox();
  return m.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -(b.min[2] + b.max[2]) / 2]);
}

// All 24 proper cube rotations as euler triples in the manifold rotate()
// convention: rotate([rx,ry,rz]) applies world-frame X, then Y, then Z, so
// R = Rz(rz)·Ry(ry)·Rx(rx). Self-tested below at build time.
function _stage24Rotations() {
  const d = Math.PI / 180;
  const eulerToMatrix = (rx, ry, rz) => {
    rx *= d; ry *= d; rz *= d;
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
    return [
      [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
      [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
      [-sy, cy * sx, cy * cx],
    ];
  };
  const matrixToEuler = (M) => {
    const ry = Math.asin(Math.max(-1, Math.min(1, -M[2][0]))) / d;
    let rx, rz;
    if (Math.abs(Math.cos(ry * d)) > 1e-9) {
      rx = Math.atan2(M[2][1], M[2][2]) / d;
      rz = Math.atan2(M[1][0], M[0][0]) / d;
    } else {
      rx = 0;
      rz = Math.atan2(-M[0][1], M[1][1]) / d;   // gimbal branch: M[1][1]=cos(rz)
    }
    return { rx, ry, rz };
  };
  const perms = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  const sgn = { '012':1,'120':1,'201':1,'021':-1,'102':-1,'210':-1 };
  const rots = [];
  for (const [ax, ay, az] of perms) {
    for (const sx of [1,-1]) for (const sy of [1,-1]) for (const sz of [1,-1]) {
      const det = sx * sy * sz * sgn[`${ax}${ay}${az}`];
      if (det !== 1) continue;
      const M = [[0,0,0],[0,0,0],[0,0,0]];
      M[0][ax] = sx; M[1][ay] = sy; M[2][az] = sz;
      const { rx, ry, rz } = matrixToEuler(M);
      const M2 = eulerToMatrix(rx, ry, rz);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        if (Math.abs(M2[i][j] - M[i][j]) > 1e-9) throw new Error(`stage rotation self-test failed: ${JSON.stringify({ M, M2 })}`);
      }
      rots.push({ name: (rx === 0 && ry === 0 && rz === 0) ? 'identity' : `r${rx}_${ry}_${rz}`, euler: [rx, ry, rz] });
    }
  }
  return rots;
}
const _STAGE_ORIENTATIONS = _stage24Rotations();

/**
 * Verdict of candidate vs target, computed entirely in THIS worker against the
 * bundled build (mirrors harness/verify.mjs verifyManifold semantics).
 * Both sides must already be live Manifolds. opts: { passRel=0.01, volGate=0.25 }.
 */
function _stageVerify(cand, target, opts = {}) {
  const { Manifold } = manifoldModule;
  const passRel = opts.passRel ?? 0.01;
  const volGate = opts.volGate ?? 0.25;
  const se = _c4StatusError(cand);
  if (se) return { pass: false, reason: 'invalid_manifold', status: se };
  const volC = cand.volume();
  const volT = target.volume();
  if (!(volC > 0) || !(volT > 0)) return { pass: false, reason: 'zero_volume', volC, volT };
  const volRel = Math.abs(volC - volT) / volT;
  if (volRel > volGate) return { pass: false, reason: 'volume_mismatch', volC, volT, volRel };
  const t = _centerAtBbox(target);
  const sym = (a, b) => {
    const u = Manifold.union(a, b);
    const i = Manifold.intersection(a, b);
    return Manifold.difference(u, i).volume();
  };
  const rel0 = sym(_centerAtBbox(cand), t) / volT;
  if (rel0 <= passRel) return { pass: true, orientation: 'identity', symRel: rel0, volC, volT };
  let best = { orientation: 'identity', symRel: rel0 };
  for (const o of _STAGE_ORIENTATIONS) {
    if (o.name === 'identity') continue;
    const r = sym(_centerAtBbox(cand.rotate(o.euler)), t) / volT;
    if (r < best.symRel) best = { orientation: o.name, symRel: r };
    if (r <= passRel) break;
  }
  if (best.symRel <= passRel) return { pass: true, ...best, volC, volT };
  return { pass: false, reason: 'symdiff_too_large', ...best, volC, volT };
}


/**
 * Game-mode match: attempt vs retained ghost, same coordinate frame.
 * Single criterion: V_symdiff / max(V_target, volFloor) < relEps
 * (empty diffs have volume 0, so exact match is covered by rel < relEps).
 * Uses stageVerify-style sym = difference(union, intersection); no isEmpty
 * typeof soft-fail. Volume pre-gate + catch fallback if booleans throw.
 */
function _gameMatchCompare(attempt, target, relEps, volFloor) {
  const { Manifold } = manifoldModule;
  const se = _c4StatusError(attempt);
  if (se) return { match: false, reason: 'invalid_manifold', status: se };
  const volA = attempt.volume();
  const volT = target.volume();
  if (!(volA > 0) || !(volT > 0)) {
    return { match: false, reason: 'zero_volume', volA, volT, volDiff: null, rel: null };
  }
  const denom = Math.max(volT, volFloor);
  const volDelta = Math.abs(volA - volT);
  if (volDelta / denom >= relEps) {
    return {
      match: false, reason: 'volume_mismatch',
      volA, volT, volDiff: volDelta, rel: volDelta / denom,
    };
  }
  let u = null;
  let i = null;
  let sym = null;
  try {
    // Prefer union/intersection/difference (more throw-resistant than two raw diffs).
    u = Manifold.union(attempt, target);
    i = Manifold.intersection(attempt, target);
    sym = Manifold.difference(u, i);
    const volDiff = sym.volume();
    const rel = volDiff / denom;
    const match = rel < relEps;
    return {
      match,
      reason: match ? 'match' : 'difference_too_large',
      volA, volT, volDiff, rel,
    };
  } catch (e) {
    // Booleans failed on near-identical solids: trust the volume pre-gate.
    return {
      match: true,
      reason: 'boolean_failed_vol_fallback',
      volA, volT,
      volDiff: volDelta,
      rel: volDelta / denom,
      warning: String(e && e.message || e),
    };
  } finally {
    _safeDeleteManifold(sym);
    _safeDeleteManifold(u);
    _safeDeleteManifold(i);
  }
}

export function bindWorker(self) {
self.onmessage = async (event) => {
  const { type, payload, id } = event.data;
  
  try {
    switch (type) {
      case 'init': {
        await initializeManifold();
        lockdownGlobals();
        self.postMessage({ type: 'ready', id });
        break;
      }

      // Lightweight alive check after Safari freeze / bfcache restore.
      case 'ping': {
        self.postMessage({ type: 'result', id, payload: { ok: true } });
        break;
      }
      
      case 'execute': {
        if (!isInitialized) {
          throw new Error('Worker not initialized');
        }
        
        const { script, importedModels, memoryLimitMB, nonce } = payload;
        if (typeof globalThis !== 'undefined') {
          globalThis.__filletSweepRingLog = [];
          globalThis.__filletSweepRingCall = null;
        }
        
        // Check memory before execution
        checkMemoryUsage(memoryLimitMB || 512);
        
        // Execute the script. execMs is the kernel; serializeMs is the mesh
        // copy that follows. The main thread adds the postMessage gap.
        const _execT0 = _perfNow();
        _featureOps = [];
        const result = executeScript(script, importedModels);
        const _execMs = _perfNow() - _execT0;
        
        // Cache the manifold for cross-section operations (+ nonce for game compare)
        cachedManifold = result;
        cachedExecuteNonce = (nonce !== undefined && nonce !== null) ? nonce : null;
        // Independent attempt snapshot for game match (only while a ghost is live).
        if (gameTargetManifold) {
          _safeDeleteManifold(gameAttemptManifold);
          gameAttemptManifold = result.clone();
        }
        
        // Check memory after execution
        const memoryUsed = checkMemoryUsage(memoryLimitMB || 512);
        
        // Serialize result for transfer
        const _serT0 = _perfNow();
        const meshData = serializeResult(result);
        const _serializeMs = _perfNow() - _serT0;
        
        // Get metadata for quoting/display
        const volume = result.volume();
        const bbox = result.boundingBox();
        const bodyCentroids = _kernelBodyCentroids(result);
        
        self.postMessage({ 
          type: 'result', 
          id,
          payload: {
            mesh: meshData,
            memoryUsedMB: memoryUsed,
            volume: volume,
            surfaceArea: result.surfaceArea(),
            status: _c4StatusError(result) || 'NoError',
            tris: meshData.triVerts.length / 3,
            boundingBox: {
              min: [...bbox.min],
              max: [...bbox.max]
            },
            nonce: cachedExecuteNonce,
            bodyCentroids,
            timing: { execMs: _execMs, serializeMs: _serializeMs },
          }
        });
        break;
      }

      // Get model info from cached manifold
      case 'getModelInfo': {
        if (!isInitialized) {
          throw new Error('Worker not initialized');
        }
        
        if (!cachedManifold) {
          throw new Error('No cached manifold - execute a script first');
        }
        
        const volume = cachedManifold.volume();
        const surfaceArea = cachedManifold.surfaceArea();
        const bbox = cachedManifold.boundingBox();
        
        self.postMessage({
          type: 'result',
          id,
          payload: {
            volume,
            surfaceArea,
            boundingBox: {
              min: [...bbox.min],
              max: [...bbox.max]
            }
          }
        });
        break;
      }

      // ── Game-mode match: retain ghost solid, compare attempt via boolean difference ──
      case 'storeGameTarget': {
        if (!isInitialized) throw new Error('Worker not initialized');
        if (!cachedManifold) throw new Error('storeGameTarget: execute the target script first');
        const se = _c4StatusError(cachedManifold);
        if (se) throw new Error(`storeGameTarget: target is invalid (${se})`);
        const volume = cachedManifold.volume();
        if (!(volume > 0)) throw new Error('storeGameTarget: target has no volume');
        // Own retained handle — do not alias cachedManifold (attempt Run overwrites it).
        _safeDeleteManifold(gameTargetManifold);
        gameTargetManifold = cachedManifold.clone();
        self.postMessage({
          type: 'result', id,
          payload: { ok: true, volume, boundingBox: _bboxArray(cachedManifold) },
        });
        break;
      }

      // Drop every retained solid from the last run. The UI sends this when a run
      // clears the viewport (empty / comment-only / construction-plane-only script):
      // nothing downstream — cross-section, model info, game compare, stage tooling —
      // may keep serving the previous object once the screen is empty.
      case 'clearResult': {
        _safeDeleteManifold(cachedManifold);
        cachedManifold = null;
        cachedExecuteNonce = null;
        _safeDeleteManifold(gameAttemptManifold);
        gameAttemptManifold = null;
        self.postMessage({ type: 'result', id, payload: { ok: true } });
        break;
      }

      case 'clearGameTarget': {
        _safeDeleteManifold(gameTargetManifold);
        gameTargetManifold = null;
        _safeDeleteManifold(gameAttemptManifold);
        gameAttemptManifold = null;
        self.postMessage({ type: 'result', id, payload: { ok: true } });
        break;
      }

      case 'compareGameMatch': {
        if (!isInitialized) throw new Error('Worker not initialized');
        if (!gameTargetManifold) throw new Error('compareGameMatch: no ghost target stored');
        if (!gameAttemptManifold) {
          throw new Error('compareGameMatch: no attempt snapshot — execute while a ghost target is stored');
        }
        if (payload?.nonce != null && payload.nonce !== cachedExecuteNonce) {
          self.postMessage({
            type: 'result', id,
            payload: {
              ignored: true, match: false, reason: 'stale_execute',
              nonce: payload.nonce, cachedNonce: cachedExecuteNonce,
            },
          });
          break;
        }
        const relEps = _positiveFinite(payload?.relEps, 0.002);
        const volFloor = _positiveFinite(payload?.volFloor, 1e-6);
        const verdict = _gameMatchCompare(gameAttemptManifold, gameTargetManifold, relEps, volFloor);
        self.postMessage({
          type: 'result', id,
          payload: { ...verdict, relEps, volFloor, nonce: cachedExecuteNonce },
        });
        break;
      }

      // Import OBJ string and create Manifold
      case 'importOBJ': {
        if (!isInitialized) {
          throw new Error('Worker not initialized');
        }
        
        const { objString, filename } = payload;
        
        // Parse OBJ string
        const vertices = [];
        const triangles = [];
        
        for (const line of objString.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          
          const parts = trimmed.split(/\s+/);
          const cmd = parts[0];
          
          if (cmd === 'v') {
            vertices.push([
              parseFloat(parts[1]) || 0,
              parseFloat(parts[2]) || 0,
              parseFloat(parts[3]) || 0
            ]);
          } else if (cmd === 'f') {
            const indices = [];
            for (let i = 1; i < parts.length; i++) {
              if (!parts[i]) continue;
              const idx = parseInt(parts[i].split('/')[0]);
              indices.push(idx < 0 ? vertices.length + idx : idx - 1);
            }
            // Fan triangulation for polygons with more than 3 vertices
            for (let i = 1; i < indices.length - 1; i++) {
              triangles.push([indices[0], indices[i], indices[i + 1]]);
            }
          }
        }
        
        if (vertices.length === 0 || triangles.length === 0) {
          throw new Error('OBJ contains no geometry');
        }
        
        console.log(`[Worker] Parsed OBJ: ${vertices.length} vertices, ${triangles.length} triangles`);
        
        // Create flat arrays for Manifold
        const vertProperties = new Float32Array(vertices.length * 3);
        for (let i = 0; i < vertices.length; i++) {
          vertProperties[i * 3] = vertices[i][0];
          vertProperties[i * 3 + 1] = vertices[i][1];
          vertProperties[i * 3 + 2] = vertices[i][2];
        }
        
        const triVerts = new Uint32Array(triangles.length * 3);
        for (let i = 0; i < triangles.length; i++) {
          triVerts[i * 3] = triangles[i][0];
          triVerts[i * 3 + 1] = triangles[i][1];
          triVerts[i * 3 + 2] = triangles[i][2];
        }
        
        // FIX: Extract Mesh and Manifold from the module
        const { Mesh, Manifold } = manifoldModule;
        
        // Create Manifold mesh
        const mesh = new Mesh({ numProp: 3, vertProperties, triVerts });
        const manifold = new Manifold(mesh);
        
        // Validate
        const meshStatus = _c4StatusError(manifold);
        if (meshStatus) {
          // More descriptive error message
          throw new Error(`Invalid mesh: status ${meshStatus}. The mesh may not be watertight.`);
        }
        
        // Cache for script access (import path — not a script execute nonce)
        cachedManifold = manifold;
        cachedExecuteNonce = null;
        
        // Get final mesh data
        const finalMesh = manifold.getMesh();
        const bbox = manifold.boundingBox();
        
        // FIX: Use 'result' type instead of 'success'
        self.postMessage({
          type: 'result',
          id,
          payload: {
            mesh: {
              numProp: finalMesh.numProp,
              vertProperties: Array.from(finalMesh.vertProperties),
              triVerts: Array.from(finalMesh.triVerts),
            },
            volume: manifold.volume(),
            boundingBox: { min: [...bbox.min], max: [...bbox.max] },
            filename
          }
        });
        break;
      }
      
      // ── Stage verification protocol (dev tooling; see _stageVerify above) ──

      // Push a reference solid into the worker-side registry.
      //   objString: OBJ text (canonical GT from the STEP converter).
      //   meshData:  { numProp, vertProperties, triVerts } (numbers; from the backend STEP
      //              converter route when the bundled obj_converter + firejail are fixed)
      case 'stageReferenceLoad': {
        if (!isInitialized) throw new Error('Worker not initialized');
        const { filename, objString, meshData, tolerance } = payload;
        if (!filename) throw new Error('stageReferenceLoad: filename required');
        let md;
        if (objString) {
          md = _parseOBJToMeshData(objString);
        } else if (meshData && meshData.vertProperties && meshData.triVerts) {
          md = { vertProperties: meshData.vertProperties, triVerts: meshData.triVerts };
        } else {
          throw new Error('stageReferenceLoad: provide objString or meshData');
        }
        const { manifold, repair } = _meshDataToManifold(md.vertProperties, md.triVerts, tolerance ?? 0.001);
        _stagedReferences.set(filename, {
          manifold,
          volume: manifold.volume(),
          surfaceArea: manifold.surfaceArea(),
          boundingBox: _bboxArray(manifold),
          tris: manifold.getMesh().triVerts.length / 3,
          repair,
          source: objString ? 'obj' : 'meshData',
        });
        self.postMessage({
          type: 'result', id,
          payload: { ok: true, filename, repair, volume: _stagedReferences.get(filename).volume,
                     surfaceArea: _stagedReferences.get(filename).surfaceArea,
                     boundingBox: _stagedReferences.get(filename).boundingBox,
                     tris: _stagedReferences.get(filename).tris,
                     staged: [..._stagedReferences.keys()] },
        });
        break;
      }

      case 'stageReferenceList': {
        const list = [];
        for (const [filename, ref] of _stagedReferences) {
          list.push({ filename, volume: ref.volume, surfaceArea: ref.surfaceArea,
                      boundingBox: ref.boundingBox, tris: ref.tris, repair: ref.repair, source: ref.source });
        }
        self.postMessage({ type: 'result', id, payload: { references: list } });
        break;
      }

      case 'stageReferenceClear': {
        const n = _stagedReferences.size;
        _stagedReferences.clear();
        self.postMessage({ type: 'result', id, payload: { ok: true, cleared: n } });
        break;
      }

      // Verify the script's LAST execution result (the cached candidate from the most
      // recent execute — the same object the Run path painted) against a staged
      // reference. Verdict computed against the bundled build, in-worker.
      case 'stageVerify': {
        if (!isInitialized) throw new Error('Worker not initialized');
        const { reference, passRel, volGate, candidateMesh } = payload;
        if (!cachedManifold && !candidateMesh) throw new Error('stageVerify: no candidate — execute a script first');
        const ref = _stagedReferences.get(reference);
        if (!ref) throw new Error(`stageVerify: reference '${reference}' not staged (staged: ${[..._stagedReferences.keys()].join(', ') || 'none'})`);
        let cand;
        if (candidateMesh) {
          cand = _meshDataToManifold(candidateMesh.vertProperties, candidateMesh.triVerts, payload.tolerance ?? 0).manifold;
        } else {
          cand = cachedManifold;
        }
        const verdict = _stageVerify(cand, ref.manifold, { passRel, volGate });
        self.postMessage({
          type: 'result', id,
          payload: { ...verdict, reference, candidateVolume: cand.volume(),
                     referenceVolume: ref.volume },
        });
        break;
      }

      // Raw geometry probe of the last execution: the meshData the worker produced.
      case 'stageGetLastMesh': {
        if (!cachedManifold) throw new Error('stageGetLastMesh: nothing executed yet');
        const m = cachedManifold.getMesh();
        self.postMessage({
          type: 'result', id,
          payload: {
            numProp: m.numProp,
            vertProperties: Array.from(m.vertProperties),
            triVerts: Array.from(m.triVerts),
            volume: cachedManifold.volume(),
            surfaceArea: cachedManifold.surfaceArea(),
            boundingBox: _bboxArray(cachedManifold),
            status: _c4StatusError(cachedManifold) || 'NoError',
          },
        });
        break;
      }

      case 'getHelperList': {
        // Return list of available helper functions
        self.postMessage({
          type: 'helperList',
          id,
          payload: Object.keys(HELPER_FUNCTIONS)
        });
        break;
      }

      // Move Face preview. Clone the cached solid and offset with moveFace.
      // The clone is deleted before this returns. cachedManifold is not
      // assigned, so leaving without Confirm writes nothing and the model
      // stays put.
      case 'previewMoveFace': {
        if (!isInitialized) throw new Error('Worker not initialized');
        if (!cachedManifold) throw new Error('No cached manifold - execute a script first');
        const created = [];
        const track = (m) => {
          if (!m || m === cachedManifold) return;
          if (created.indexOf(m) >= 0) return;
          created.push(m);
        };
        let mesh;
        try {
          const clone = cachedManifold.clone();
          track(clone);
          const out = moveFace(clone, payload && payload.faces, payload && payload.distance, {
            flip: !!(payload && payload.flip),
          });
          track(out);
          mesh = serializeResult(out);
        } finally {
          for (const m of created) _safeDeleteManifold(m);
        }
        self.postMessage({ type: 'result', id, payload: { mesh } });
        break;
      }

      // Delete Face preview. Clone the cached solid and heal with deleteFace.
      // The clone is deleted before this returns. cachedManifold is not
      // assigned, so leaving without Confirm writes nothing and the model
      // stays put.
      case 'previewDeleteFace': {
        if (!isInitialized) throw new Error('Worker not initialized');
        if (!cachedManifold) throw new Error('No cached manifold - execute a script first');
        const created = [];
        const track = (m) => {
          if (!m || m === cachedManifold) return;
          if (created.indexOf(m) >= 0) return;
          created.push(m);
        };
        let mesh;
        try {
          const clone = cachedManifold.clone();
          track(clone);
          const out = deleteFace(clone, payload && payload.faces);
          track(out);
          mesh = serializeResult(out);
        } finally {
          for (const m of created) _safeDeleteManifold(m);
        }
        self.postMessage({ type: 'result', id, payload: { mesh } });
        break;
      }

      // Block pop preview. Builds the new solid only — cube, rounded box,
      // cylinder, sphere, tube, hex prism — with the same pose the sheet
      // would write. cachedManifold is not read or assigned, so Cancel
      // leaves the part and the editor untouched.
      case 'previewBlock': {
        if (!isInitialized) throw new Error('Worker not initialized');
        const { Manifold } = manifoldModule;
        const spec = blockSpec(payload && payload.id, payload && payload.params);
        const created = [];
        const track = (m) => {
          if (!m || m === cachedManifold) return;
          if (created.indexOf(m) >= 0) return;
          created.push(m);
        };
        let mesh;
        let volume;
        let boundingBox;
        try {
          const solid = buildBlockManifold(spec, {
            Manifold, roundedBox, tube, hexPrism, track,
          });
          volume = solid.volume();
          boundingBox = _bboxArray(solid);
          mesh = serializeResult(solid);
        } finally {
          for (const m of created) _safeDeleteManifold(m);
        }
        self.postMessage({
          type: 'result',
          id,
          payload: { mesh, volume, boundingBox, combine: spec.combine },
        });
        break;
      }

      // Pieces preview. Clone the cached solid and split it with the same
      // helpers cut() uses. The clone and every temporary are deleted before
      // this returns. cachedManifold is not assigned, so leaving Pieces
      // without Confirm leaves the model whole and the editor gains no cut().
      case 'previewCut': {
        if (!isInitialized) throw new Error('Worker not initialized');
        if (!cachedManifold && !(typeof payload?.targetScript === 'string' && payload.targetScript.trim())) {
          throw new Error('No cached manifold - execute a script first');
        }
        const created = [];
        const track = (m) => {
          if (!m || m === cachedManifold) return;
          if (created.indexOf(m) >= 0) return;
          created.push(m);
        };
        let pieces;
        try {
          const pl = _cutResolvePlane(payload && payload.plane);
          const clone = cachedManifold.clone();
          track(clone);
          const bodies = _cutBodiesOf(clone);
          for (const body of bodies) track(body);
          const selected = _cutSelected(bodies, payload && payload.bodies);
          pieces = [];
          for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            const at = _cutCentroid(body);
            if (!selected.has(i)) {
              pieces.push({ at, side: 'whole', selected: false, mesh: serializeResult(body) });
              continue;
            }
            const split = _cutSplitOrOriginal(body, pl);
            for (const piece of split.pieces) {
              track(piece.manifold);
              pieces.push({
                at,
                side: piece.side,
                selected: true,
                mesh: serializeResult(piece.manifold),
              });
            }
            for (const extra of split.discard) track(extra);
          }
        } finally {
          for (const m of created) _safeDeleteManifold(m);
        }
        self.postMessage({ type: 'result', id, payload: { pieces } });
        break;
      }

      // Boolean preview. Clone the cached solid and run the same combine
      // booleanBodies() uses, without drop, so every leftover piece is listed.
      // The clone and every temporary are deleted before this returns.
      // cachedManifold is not assigned, so leaving without Confirm writes nothing.
      case 'previewBoolean': {
        if (!isInitialized) throw new Error('Worker not initialized');
        if (!cachedManifold) throw new Error('No cached manifold - execute a script first');
        const created = [];
        const track = (m) => {
          if (!m || m === cachedManifold) return;
          if (created.indexOf(m) >= 0) return;
          created.push(m);
        };
        let pieces;
        try {
          const options = (payload && typeof payload === 'object') ? payload : {};
          const op = _booleanOp(options.op);
          // Cross-part: the target part's script runs here (not cached) and
          // each external tool is that part's script, frozen and posed into
          // the target frame, exactly as Accept will write it.
          const ownRun = typeof options.targetScript === 'string' && options.targetScript.trim();
          const clone = ownRun
            ? executeScript(options.targetScript, {})
            : cachedManifold.clone();
          if (!clone || typeof clone.decompose !== 'function') {
            throw new Error('previewBoolean: target script must return a Manifold');
          }
          track(clone);
          const external = [];
          for (const tool of Array.isArray(options.tools) ? options.tools : []) {
            const src = executeScript(String(tool?.script || ''), {});
            const posed = _externalPick(src, tool?.bodies, tool?.offset, 'previewBoolean');
            if (posed !== src) track(src);
            track(posed);
            external.push(posed);
          }
          const bodies = _cutBodiesOf(clone);
          for (const body of bodies) track(body);
          const spec = (external.length && (!Array.isArray(options.bodies) || !options.bodies.length))
            ? [{ at: _cutCentroid(bodies[0]) }]
            : options.bodies;
          const selected = _booleanSelected(bodies, spec);
          const sel = new Set(selected);
          pieces = [];
          for (let i = 0; i < bodies.length; i++) {
            if (sel.has(i)) continue;
            pieces.push({
              at: _cutCentroid(bodies[i]),
              selected: false,
              kind: 'body',
              mesh: serializeResult(bodies[i]),
            });
          }
          if (selected.length + external.length >= 2) {
            const picked = [...selected.map((i) => bodies[i]), ...external];
            const combined = _booleanCombine(op, picked);
            track(combined.result);
            for (const extra of combined.temps) track(extra);
            const parts = _cutBodiesOf(combined.result);
            for (const part of parts) track(part);
            for (const part of parts) {
              pieces.push({
                at: _cutCentroid(part),
                selected: true,
                kind: 'piece',
                mesh: serializeResult(part),
              });
            }
          }
        } finally {
          for (const m of created) _safeDeleteManifold(m);
        }
        self.postMessage({ type: 'result', id, payload: { pieces } });
        break;
      }

      // Which parts a subtract cutter actually overlaps. The cutter script
      // runs here (frozen text, not cached) and each part is rebuilt from its
      // last mesh. cachedManifold is not read or assigned.
      case 'probeOverlap': {
        if (!isInitialized) throw new Error('Worker not initialized');
        const options = (payload && typeof payload === 'object') ? payload : {};
        const created = [];
        const overlaps = [];
        try {
          const cutter = executeScript(String(options.cutterScript || ''), {});
          if (!cutter || typeof cutter.intersect !== 'function') {
            throw new Error('probeOverlap: cutter script must return a Manifold');
          }
          created.push(cutter);
          for (const part of Array.isArray(options.parts) ? options.parts : []) {
            if (!part?.mesh?.vertProperties || !part?.mesh?.triVerts) continue;
            let solid = null;
            let posed = null;
            let both = null;
            try {
              solid = reconstructManifold(part.mesh);
              const off = Array.isArray(part.offset) ? part.offset.map(Number) : [0, 0, 0];
              posed = (off[0] || off[1] || off[2]) ? cutter.translate(off) : cutter;
              both = manifoldModule.Manifold.intersection(posed, solid);
              const vol = _cutVol(both);
              if (vol > 1e-6) overlaps.push({ id: part.id, volume: vol });
            } catch (_) {
              // A part whose mesh will not rebuild is not cut.
            } finally {
              _safeDeleteManifold(both);
              if (posed && posed !== cutter) _safeDeleteManifold(posed);
              _safeDeleteManifold(solid);
            }
          }
        } finally {
          for (const m of created) _safeDeleteManifold(m);
        }
        self.postMessage({ type: 'result', id, payload: { overlaps } });
        break;
      }

      case 'trimByPlane': {
        if (!isInitialized) {
          throw new Error('Worker not initialized');
        }
        
        if (!cachedManifold) {
          throw new Error('No cached manifold - execute a script first');
        }
        
        const { normal, originOffset } = payload;
        
        // Apply trimByPlane to cached manifold
        const trimmed = cachedManifold.trimByPlane(normal, originOffset);
        
        // Serialize result
        const meshData = serializeResult(trimmed);
        
        self.postMessage({
          type: 'result',
          id,
          payload: { mesh: meshData }
        });
        break;
      }
      
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({ 
      type: 'error', 
      id,
      payload: {
        message: error.message,
        stack: error.stack,
        scriptLine: Number.isFinite(error?.scriptLine) ? error.scriptLine : null,
        featureId: typeof error?.featureId === 'string' ? error.featureId : null,
        featureBlock: typeof error?.featureBlock === 'string' ? error.featureBlock : null,
      }
    });
  }
};

// Signal that the worker is loaded
self.postMessage({ type: 'loaded' });
}

export {
  HELPER_FUNCTIONS,
  initializeManifold,
  executeScript,
};

/** The Manifold module bound for helper closures (null until init / bind). */
export function getManifoldModule() {
  return manifoldModule;
}

/** True after initializeManifold or bindManifoldModule. */
export function manifoldReady() {
  return isInitialized && !!manifoldModule;
}

/**
 * Load the shipped built/manifold.js factory. `wasmPath` / `locateFile`
 * override WASM resolution. Does not call setup(); bindManifoldModule does.
 */
export async function loadBundledManifold(opts = {}) {
  const args = {};
  if (typeof opts.locateFile === 'function') args.locateFile = opts.locateFile;
  else if (opts.wasmPath) args.locateFile = () => opts.wasmPath;
  return Module(args);
}

/**
 * Install `mod` as the module helper closures read. setup() and
 * installSeparateBodies are idempotent. Pass `setup: false` only when the
 * caller already did both.
 */
export function bindManifoldModule(mod, { setup = true } = {}) {
  if (!mod || typeof mod !== 'object') {
    throw new Error('bindManifoldModule: Manifold module required');
  }
  manifoldModule = mod;
  if (setup) {
    if (typeof mod.setup === 'function') mod.setup();
    installSeparateBodies(mod);
  }
  isInitialized = true;
  return mod;
}

/**
 * Bindings executeScript spreads into the user script: the Manifold API
 * plus HELPER_FUNCTIONS. Per-run `window` and feature-trace hooks are
 * added inside executeScript / runPreparedScript, not here.
 */
export function helperScope(mod) {
  if (mod) manifoldModule = mod;
  if (!manifoldModule) throw new Error('helperScope: Manifold module required');
  return {
    ...manifoldModule,
    ...HELPER_FUNCTIONS,
  };
}

function summarizeManifold(result) {
  if (!result || typeof result.getMesh !== 'function') {
    throw new Error('Script must return a Manifold object');
  }
  const mesh = serializeResult(result);
  const bbox = result.boundingBox();
  const bodyCentroids = _kernelBodyCentroids(result);
  return {
    manifold: result,
    mesh,
    volume: result.volume(),
    surfaceArea: typeof result.surfaceArea === 'function' ? result.surfaceArea() : null,
    status: _c4StatusError(result) || 'NoError',
    tris: mesh.triVerts.length / 3,
    boundingBox: { min: [...bbox.min], max: [...bbox.max] },
    bodyCentroids,
    bodyCount: bodyCentroids.length,
    parts: bodyCentroids.map((at, index) => ({ index, at })),
  };
}

/**
 * Execute a user script the way the worker's `execute` message does:
 * feature-op reset, `"use strict"` + new Function(...helperNames, script),
 * same shadowing rules. The module must already be bound.
 */
export function runPreparedScript(source, opts = {}) {
  if (!manifoldModule || !isInitialized) throw new Error('Manifold not initialized');
  if (typeof globalThis !== 'undefined') {
    globalThis.__filletSweepRingLog = [];
    globalThis.__filletSweepRingCall = null;
  }
  _featureOps = [];
  const result = executeScript(String(source ?? ''), opts.importedModels || {});
  cachedManifold = result;
  cachedExecuteNonce = (opts.nonce !== undefined && opts.nonce !== null) ? opts.nonce : null;
  return summarizeManifold(result);
}
