/**
 * Slice 22 — Edge → ordered sweep path / wire.
 *
 * Pure helpers shared by palette preview, goldens, and docs examples.
 * Script-facing makeSweepPath lives in sandboxWorker (mirrors assembleSweepPath).
 *
 * Value shape (plain object, no class inheritance):
 *   {
 *     kind: 'sweepPath',
 *     closed: boolean,
 *     points: number[][],   // ordered XYZ polyline (closed: first≠last; use closed flag)
 *     length: number,
 *     edgeCount: number,
 *   }
 *
 * Does NOT sweep a cutter / fillet — path value only for later slices.
 */

import { edgeKey, buildEdgeVertexAdj } from './selectEdge.js';

export const SWEEP_PATH_EMPTY =
  'Select edges first (Edge pick mode), then Path. Tangent-on chains work for circular rims.';

export const SWEEP_PATH_DISCONNECTED =
  'Selected edges are disconnected — pick a single contiguous chain or loop (use Tangent for circular rims).';

export const SWEEP_PATH_BRANCH =
  'Selected edges branch (junction) — Path needs a simple open chain or closed loop, not a Y/T junction.';

export const SWEEP_PATH_INVALID =
  'Could not order selected edges into a path — re-pick a contiguous chain or loop.';

/** Recover a dominant simple chain when strays are a small leftover (not a tie). */
export const SWEEP_PATH_RECOVER_MIN_FRAC = 0.75;

/** Min path sample spacing after pts expansion (mm). See thinSweepPathPoints.
 * Assembly floor only — long straights are already one segment, so this does
 * not subdivide them. Fillet consumption resamples arcs separately
 * (sweepPathMaxChordForTurn); do not lower this globally or micro-clusters
 * come back as fin slivers. */
export const SWEEP_PATH_MIN_SEG = 1.2;

/**
 * Longest chord on a circular arc of radius `r` whose turn is ≤ maxTurnDeg.
 * chord = 2 r sin(θ/2). At 5° and r=6 this is ~0.52 mm; the 1.2 mm assembly
 * floor is ~11° on that arc, coarser than the shell normal cluster.
 * Not a straight-edge subdivider — only meaningful along a fitted turn.
 * @param {number} radius path-arc radius (mm)
 * @param {number} [maxTurnDeg=5]
 * @returns {number}
 */
export function sweepPathMaxChordForTurn(radius, maxTurnDeg = 5) {
  const r = Number(radius);
  const deg = Number(maxTurnDeg);
  if (!(r > 0) || !Number.isFinite(r) || !(deg > 0) || !Number.isFinite(deg)) {
    return SWEEP_PATH_MIN_SEG;
  }
  const half = (deg * Math.PI) / 360;
  return 2 * r * Math.sin(half);
}

function disconnectedMessage(compSizes, total) {
  const sizes = compSizes.slice().sort((a, b) => b - a);
  const n = sizes.length;
  const extra = n > 1
    ? ` (${n} components, largest ${sizes[0]} of ${total})`
    : '';
  return SWEEP_PATH_DISCONNECTED + extra;
}

function edgeComponents(unique, adj) {
  const visited = new Set();
  const comps = [];
  for (const start of unique) {
    if (visited.has(start.key)) continue;
    const q = [start];
    visited.add(start.key);
    const list = [];
    while (q.length) {
      const cur = q.shift();
      list.push(cur);
      for (const v of [cur.a, cur.b]) {
        for (const nbr of adj.get(v) || []) {
          const nk = edgeKey(nbr);
          if (visited.has(nk)) continue;
          visited.add(nk);
          q.push(nbr);
        }
      }
    }
    comps.push(list);
  }
  return comps;
}

function isSimpleChainOrLoop(edges) {
  const adj = buildEdgeVertexAdj(edges);
  let endpoints = 0;
  for (const list of adj.values()) {
    if (list.length > 2) return false;
    if (list.length === 1) endpoints++;
  }
  return endpoints === 0 || endpoints === 2;
}

/**
 * Prefer the largest simple component when the selection is mostly one chain
 * plus stray scraps. Refuse ties / split-in-half sets (unsafe to guess).
 */
function pickPathComponent(unique, adj) {
  const comps = edgeComponents(unique, adj);
  if (comps.length <= 1) {
    return { edges: unique, recovered: false, comps };
  }
  const sorted = comps.slice().sort((a, b) => b.length - a.length);
  const largest = sorted[0];
  const second = sorted[1];
  const recoverable = largest.length >= 2
    && largest.length > second.length
    && (largest.length / unique.length) >= SWEEP_PATH_RECOVER_MIN_FRAC
    && isSimpleChainOrLoop(largest);
  if (recoverable) {
    return { edges: largest, recovered: true, comps };
  }
  return { edges: null, recovered: false, comps };
}

/**
 * Split a selection into connected edge components for independent fillets.
 * Unlike orderEdgePath / assembleSweepPath (single path, may drop strays),
 * every component is kept. Each must be a simple open chain or closed loop;
 * a Y/T branch inside any component still refuses.
 *
 * @param {object[]} selectedEdges
 * @returns {{
 *   ok: true,
 *   components: object[][],
 * } | {
 *   ok: false,
 *   code: 'empty'|'branch'|'invalid',
 *   message: string,
 * }}
 */
export function splitEdgePathComponents(selectedEdges) {
  const raw = Array.isArray(selectedEdges) ? selectedEdges : [];
  const uniq = new Map();
  for (const e of raw) {
    if (!e) continue;
    if (!Number.isFinite(e.a) || !Number.isFinite(e.b)) continue;
    const n = normalizePathEdge(e);
    if (!n) continue;
    // Preserve caller fields (n0/n1, boundaryId, blendStrip, …) for fillet emit/preview.
    if (!uniq.has(n.key)) uniq.set(n.key, { ...e, ...n });
  }
  const unique = [...uniq.values()];
  if (!unique.length) {
    return { ok: false, code: 'empty', message: SWEEP_PATH_EMPTY };
  }

  const adj = buildEdgeVertexAdj(unique);
  const comps = edgeComponents(unique, adj);
  for (const comp of comps) {
    if (!isSimpleChainOrLoop(comp)) {
      return { ok: false, code: 'branch', message: SWEEP_PATH_BRANCH };
    }
  }
  // Stable order: selection order of each component's first-seen edge.
  const orderIndex = new Map(unique.map((e, i) => [e.key, i]));
  const sorted = comps.slice().sort((a, b) => {
    const ia = Math.min(...a.map((e) => orderIndex.get(e.key) ?? 0));
    const ib = Math.min(...b.map((e) => orderIndex.get(e.key) ?? 0));
    return ia - ib;
  });
  return { ok: true, components: sorted };
}

function _dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function _mid(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function _add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function _mul(s, a) {
  return [s * a[0], s * a[1], s * a[2]];
}

function _len(v) {
  return Math.hypot(v[0], v[1], v[2]) || 1;
}

function _n(v) {
  const L = _len(v);
  return [v[0] / L, v[1] / L, v[2] / L];
}

/**
 * Normalize a selected / feature edge into a copy with key + endpoints.
 * @param {object} edge
 * @returns {object|null}
 */
export function normalizePathEdge(edge) {
  if (!edge) return null;
  const va = edge.va;
  const vb = edge.vb;
  if (!Array.isArray(va) || !Array.isArray(vb) || va.length < 3 || vb.length < 3) return null;
  const a = Number.isFinite(edge.a) ? edge.a : 0;
  const b = Number.isFinite(edge.b) ? edge.b : 1;
  const key = edgeKey(edge) || `${Math.min(a, b)}-${Math.max(a, b)}`;
  let length = Number(edge.length);
  if (!(length > 0)) length = _dist(va, vb);
  if (!(length > 1e-12)) return null;
  // Slice B+C: preserve dense pre-RDP polyline when present (fillet path fidelity).
  let pts;
  if (Array.isArray(edge.pts) && edge.pts.length >= 2) {
    pts = edge.pts
      .filter((p) => Array.isArray(p) && p.length >= 3)
      .map((p) => [Number(p[0]), Number(p[1]), Number(p[2])]);
    if (pts.length < 2) pts = undefined;
  }
  return {
    key,
    a,
    b,
    va: [Number(va[0]), Number(va[1]), Number(va[2])],
    vb: [Number(vb[0]), Number(vb[1]), Number(vb[2])],
    mid: Array.isArray(edge.mid)
      ? [Number(edge.mid[0]), Number(edge.mid[1]), Number(edge.mid[2])]
      : _mid(va, vb),
    length,
    tangent: edge.tangent ? edge.tangent.slice() : undefined,
    pts,
  };
}

/** Orient so .a/.va sit at fromVert (mesh vertex index). */
function orientFromVert(edge, fromVert) {
  if (edge.a === fromVert) {
    return {
      key: edge.key,
      a: edge.a,
      b: edge.b,
      va: edge.va.slice(),
      vb: edge.vb.slice(),
      mid: edge.mid ? edge.mid.slice() : _mid(edge.va, edge.vb),
      length: edge.length,
      tangent: edge.tangent ? edge.tangent.slice() : undefined,
      pts: Array.isArray(edge.pts) ? edge.pts.map((p) => p.slice()) : undefined,
    };
  }
  return {
    key: edge.key,
    a: edge.b,
    b: edge.a,
    va: edge.vb.slice(),
    vb: edge.va.slice(),
    mid: edge.mid ? edge.mid.slice() : _mid(edge.va, edge.vb),
    length: edge.length,
    tangent: edge.tangent
      ? [-edge.tangent[0], -edge.tangent[1], -edge.tangent[2]]
      : undefined,
    // Flip dense polyline with the endpoints so makeSweepPath stays coherent.
    pts: Array.isArray(edge.pts)
      ? edge.pts.map((p) => p.slice()).reverse()
      : undefined,
  };
}

/**
 * Order selected edges into a contiguous open chain or closed loop.
 *
 * Open: walk from a degree-1 endpoint.
 * Closed: all degrees 2; walk from the first selected edge.
 * Soft-fails (ok:false) on empty, disconnected, or branched selections.
 * If the set is mostly one simple chain/loop plus stray scraps (≥75% in the
 * largest simple component, not a size-tie), recovers that component.
 *
 * @param {object[]} selectedEdges
 * @returns {{
 *   ok: true,
 *   closed: boolean,
 *   orderedEdges: object[],
 *   points: number[][],
 *   length: number,
 * } | {
 *   ok: false,
 *   code: 'empty'|'disconnected'|'branch'|'invalid',
 *   message: string,
 * }}
 */
export function orderEdgePath(selectedEdges) {
  const raw = Array.isArray(selectedEdges) ? selectedEdges : [];
  const uniq = new Map();
  for (const e of raw) {
    if (!e) continue;
    if (!Number.isFinite(e.a) || !Number.isFinite(e.b)) continue;
    const n = normalizePathEdge(e);
    if (!n) continue;
    if (!uniq.has(n.key)) uniq.set(n.key, n);
  }
  const unique = [...uniq.values()];
  if (!unique.length) {
    return { ok: false, code: 'empty', message: SWEEP_PATH_EMPTY };
  }

  const adj = buildEdgeVertexAdj(unique);
  const picked = pickPathComponent(unique, adj);
  if (!picked.edges) {
    return {
      ok: false,
      code: 'disconnected',
      message: disconnectedMessage(picked.comps.map((c) => c.length), unique.length),
    };
  }
  const working = picked.edges;
  const workAdj = picked.recovered ? buildEdgeVertexAdj(working) : adj;

  const endpoints = [];
  for (const [v, list] of workAdj) {
    if (list.length > 2) {
      return { ok: false, code: 'branch', message: SWEEP_PATH_BRANCH };
    }
    if (list.length === 1) endpoints.push(v);
  }

  const closed = endpoints.length === 0;
  if (!closed && endpoints.length !== 2) {
    return { ok: false, code: 'invalid', message: SWEEP_PATH_INVALID };
  }

  // Open: prefer an endpoint on the first-selected edge for stable direction.
  // Closed: start at working[0].a. After recovery, first-selected may be a stray.
  const seed = working.find((e) => e.key === unique[0].key) || working[0];
  let startVert;
  if (closed) {
    startVert = seed.a;
  } else if (endpoints.includes(seed.a)) startVert = seed.a;
  else if (endpoints.includes(seed.b)) startVert = seed.b;
  else startVert = endpoints[0];

  const used = new Set();
  const ordered = [];
  let curV = startVert;

  for (let guard = 0; guard < working.length + 2; guard++) {
    const nbrs = (workAdj.get(curV) || []).filter((e) => !used.has(edgeKey(e)));
    if (!nbrs.length) break;

    let pick = nbrs[0];
    if (ordered.length === 0) {
      const prefer = nbrs.find((e) => edgeKey(e) === seed.key);
      if (prefer) pick = prefer;
    }

    const edge = orientFromVert(pick, curV);
    used.add(edge.key);
    ordered.push(edge);
    curV = edge.b;
    if (used.size === working.length) break;
  }

  if (ordered.length !== working.length) {
    return { ok: false, code: 'invalid', message: SWEEP_PATH_INVALID };
  }

  // Slice B+C: expand dense pre-RDP polylines so fillet/sweep see the real
  // curve, not RDP chords (chord corners → faceted/wedge blends).
  const points = [];
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    const poly = Array.isArray(e.pts) && e.pts.length >= 2
      ? e.pts
      : [e.va, e.vb];
    if (i === 0) {
      for (const p of poly) points.push(p.slice());
    } else {
      // Skip duplicate shared endpoint with previous edge.
      for (let k = 1; k < poly.length; k++) points.push(poly[k].slice());
    }
  }

  let length = 0;
  for (let i = 1; i < points.length; i++) length += _dist(points[i - 1], points[i]);
  if (!(length > 0)) {
    length = 0;
    for (const e of ordered) length += e.length;
  }

  return {
    ok: true,
    closed,
    orderedEdges: ordered,
    points,
    length,
    recovered: !!picked.recovered,
  };
}


function _turnDeg(a, b, c) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const bcx = c[0] - b[0], bcy = c[1] - b[1], bcz = c[2] - b[2];
  const lab = Math.hypot(abx, aby, abz);
  const lbc = Math.hypot(bcx, bcy, bcz);
  if (!(lab > 1e-9) || !(lbc > 1e-9)) return 0;
  const d = (abx * bcx + aby * bcy + abz * bcz) / (lab * lbc);
  return Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI;
}

/** Circle through 3 points, or null if colinear. Local — no filletAlongPath import. */
function _circFit3(p0, p1, p2) {
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
  const d1 = [A[1] * n[2] - A[2] * n[1], A[2] * n[0] - A[0] * n[2], A[0] * n[1] - A[1] * n[0]];
  const Bv = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const d2 = [Bv[1] * n[2] - Bv[2] * n[1], Bv[2] * n[0] - Bv[0] * n[2], Bv[0] * n[1] - Bv[1] * n[0]];
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
  if (!(R > 1e-9) || !Number.isFinite(R)) return null;
  return { C, R };
}

/**
 * Points dropped between `ib` and `ic` that still lie on a circular run.
 * The 1.2 mm floor keeps a long prior-fillet quarter (r≈4, chords > 1.2 mm).
 * A short inner offset of that quarter (r≈1.5, arc ≈ 2.4 mm) collapses to one
 * chord and loses the tangency vertex where the arc meets the next straight,
 * so the later fillet sweeps a shortcut off the shell edge. Put the arc back
 * at ~15° steps — coarse enough to avoid micro-cluster fins, and at least
 * three interior samples on a quarter so densifySweepArcTurns can fit the
 * circle (it will not extend a two-point run to the tangency vertices).
 * 15° is under that fitter's 50° step cap and under smoothPathCorners' 40°
 * spike gate, so the restored samples stay on the arc for the ≤5° resample.
 * A long straight
 * tail is not subdivided. Colinear spans and real sharp corners (no circle)
 * are left alone.
 * A quarter that thinning already left with two or more interior samples
 * (the r=4 wrap, ~22° chords) is left alone: the arc fitter can refit it,
 * and extra samples there retessellate a later shell.
 * @param {number[]} kept greedy-thinned original indices
 * @returns {number[]} original indices strictly between ib and ic
 */
function _restoreShortArcSpan(pts, kept, ib, ic) {
  if (ic <= ib + 1) return [];
  const segLen = (i) => _dist(pts[i], pts[i + 1]);
  const shorts = [];
  let junction = ic;
  for (let i = ib; i < ic; i++) {
    const L = segLen(i);
    if (shorts.length >= 2) {
      const sorted = shorts.slice().sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      if (L > med * 2.5 && L > shorts[shorts.length - 1] * 2.5) {
        junction = i;
        break;
      }
    }
    shorts.push(L);
  }
  if (junction <= ib) return [];
  const seqIdx = [];
  for (let i = ib; i <= junction; i++) seqIdx.push(i);
  if (seqIdx.length < 3) {
    if (junction < ic) return [junction];
    return [];
  }
  const fit = _circFit3(
    pts[seqIdx[0]],
    pts[seqIdx[seqIdx.length >> 1]],
    pts[seqIdx[seqIdx.length - 1]],
  );
  if (!fit) return junction < ic ? [junction] : [];
  const tol = Math.max(0.35, 0.08 * fit.R);
  for (const i of seqIdx) {
    const p = pts[i];
    const d = Math.hypot(p[0] - fit.C[0], p[1] - fit.C[1], p[2] - fit.C[2]);
    if (Math.abs(d - fit.R) > tol) return junction < ic ? [junction] : [];
  }
  // densifySweepArcTurns needs two interior samples that can neighbor each
  // other (plus the ends it extends to). A kept run that already has those
  // is the normal 1.2 mm floor on a long quarter — do not re-seed it.
  let onKept = 0;
  for (const i of kept) {
    const p = pts[i];
    const d = Math.hypot(p[0] - fit.C[0], p[1] - fit.C[1], p[2] - fit.C[2]);
    if (Math.abs(d - fit.R) <= tol) onKept++;
  }
  if (onKept >= 4) return [];
  // 15°: a quarter then has ≥3 interior samples. Under the 40° corner-smooth
  // gate and under the arc fitter's 50° step cap.
  const chord = Math.max(0.2, 2 * fit.R * Math.sin((15 * Math.PI) / 360));
  const out = [];
  let last = ib;
  for (let i = ib + 1; i < junction; i++) {
    if (_dist(pts[i], pts[last]) >= chord * 0.85) {
      out.push(i);
      last = i;
    }
  }
  if (junction < ic && junction !== last) out.push(junction);
  return out;
}

/**
 * Index of the vertex where a circular run meets a long straight, or -1.
 * Same detection as the short-quarter restore (short chords, then a segment
 * much longer than their median, and the short run sits on one circle).
 * A long quarter that already has its samples is not re-seeded here — the
 * caller only puts this one joint back.
 */
function _arcStraightJointIndex(pts, ib, ic) {
  if (ic <= ib + 1) return -1;
  const segLen = (i) => _dist(pts[i], pts[i + 1]);
  const shorts = [];
  let junction = ic;
  for (let i = ib; i < ic; i++) {
    const L = segLen(i);
    if (shorts.length >= 2) {
      const sorted = shorts.slice().sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      if (L > med * 2.5 && L > shorts[shorts.length - 1] * 2.5) {
        junction = i;
        break;
      }
    }
    shorts.push(L);
  }
  if (!(junction > ib && junction < ic)) return -1;
  const seqIdx = [];
  for (let i = ib; i <= junction; i++) seqIdx.push(i);
  if (seqIdx.length < 3) return -1;
  const fit = _circFit3(
    pts[seqIdx[0]],
    pts[seqIdx[seqIdx.length >> 1]],
    pts[seqIdx[seqIdx.length - 1]],
  );
  if (!fit) return -1;
  const tol = Math.max(0.35, 0.08 * fit.R);
  for (const i of seqIdx) {
    const p = pts[i];
    const d = Math.hypot(p[0] - fit.C[0], p[1] - fit.C[1], p[2] - fit.C[2]);
    if (Math.abs(d - fit.R) > tol) return -1;
  }
  return junction;
}

/**
 * Cap path sample density after pts expansion.
 *
 * Slice B+C expands pre-RDP `pts` so fillets follow real curvature instead of
 * faceted RDP chords. Full tessellation density on prior-fillet arcs, however,
 * leaves vertical fin-slivers when a later wrap fillet meets those blends
 * (Artur cube playtest: 50+ zero-area fins on the side faces). Thinning to a
 * ~1.2 mm floor keeps arc fidelity for smooth wedges while dropping the
 * micro-cluster samples that poison the dihedral sweep boolean.
 *
 * That floor is ~11° on an r=6 arc and still leaves a fittable quarter when
 * the chords themselves exceed 1.2 mm. It deletes a short inner-shell quarter
 * (hollow offset of a prior fillet, arc shorter than ~2× the floor) including
 * the vertex where the arc meets the next wall. The shortcut is not tangent
 * to either shell face. When thinning itself creates that kink, and the
 * dropped samples lie on a circle, restore the arc at ~15° steps (at least
 * three interior samples on a quarter, which is what the arc fitter needs
 * before it will extend to the tangency vertices) so the fillet arc resample
 * (≤5°) can refit it. That full restore stays behind the 18° kink gate.
 * A circle that already has its samples, running into a long straight, only
 * gets the joint vertex back, and only when the thinned shortcut turns more
 * than 5° — the corner-split gate. SWEEP_PATH_MIN_SEG is unchanged.
 *
 * Long straight edges are unchanged (already one segment). Closed paths keep
 * first ≠ last.
 *
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {{ minSeg?: number }} [opts]
 * @returns {number[][]}
 */
export function thinSweepPathPoints(points, closed, opts = {}) {
  const pts = Array.isArray(points) ? points : [];
  if (pts.length < 3) return pts.map((p) => p.slice());
  const minSeg = typeof opts.minSeg === 'number' ? opts.minSeg : SWEEP_PATH_MIN_SEG;
  if (!(minSeg > 0)) return pts.map((p) => p.slice());

  const kept = [0];
  for (let i = 1; i < pts.length; i++) {
    const last = pts[kept[kept.length - 1]];
    const d = _dist(pts[i], last);
    const isLast = i === pts.length - 1;
    if (d >= minSeg || isLast) kept.push(i);
  }
  if (closed && kept.length > 2) {
    const a = pts[kept[0]];
    const b = pts[kept[kept.length - 1]];
    if (_dist(a, b) < 1e-5) kept.pop();
  }
  // If the forced endpoint is too close to the previous kept sample, drop the
  // previous (keep the true end) so we do not reintroduce a micro segment.
  if (kept.length >= 3) {
    const dEnd = _dist(pts[kept[kept.length - 1]], pts[kept[kept.length - 2]]);
    if (dEnd < minSeg * 0.35) kept.splice(kept.length - 2, 1);
  }
  if (kept.length < 2) return pts.map((p) => p.slice());

  // Thinning-created kinks only. A 15–22° chord on a long quarter already
  // has two interior samples on the circle, so the span restore leaves it
  // alone and wrap goldens keep their path. A collapsed short quarter
  // (one interior sample, tangency vertex dropped) is put back.
  const KINK_DEG = 18;
  const restored = [kept[0]];
  for (let k = 1; k < kept.length - 1; k++) {
    const ia = kept[k - 1];
    const ib = kept[k];
    const ic = kept[k + 1];
    restored.push(ib);
    if (ic <= ib + 1) continue;
    const thinTurn = _turnDeg(pts[ia], pts[ib], pts[ic]);
    const joint = _arcStraightJointIndex(pts, ib, ic);
    const pushJoint = () => {
      // Greater than 5°: a turn at the split gate. The 18° gate below is
      // unchanged and still owns the full quarter re-seed.
      if (!(thinTurn > 5)) return;
      if (!(joint > restored[restored.length - 1] && joint < ic)) return;
      restored.push(joint);
    };
    if (thinTurn < KINK_DEG) {
      pushJoint();
      continue;
    }
    let maxOrig = 0;
    for (let i = ib + 1; i < ic; i++) {
      if (i - 1 < 0 || i + 1 >= pts.length) continue;
      maxOrig = Math.max(maxOrig, _turnDeg(pts[i - 1], pts[i], pts[i + 1]));
    }
    if (thinTurn < maxOrig + 8) {
      pushJoint();
      continue;
    }
    for (const j of _restoreShortArcSpan(pts, kept, ib, ic)) {
      if (j > restored[restored.length - 1] && j < ic) restored.push(j);
    }
    pushJoint();
  }
  restored.push(kept[kept.length - 1]);

  const out = [];
  for (const i of restored) {
    const p = pts[i];
    if (out.length && _dist(out[out.length - 1], p) < 1e-9) continue;
    out.push(p.slice());
  }
  if (out.length < 2) return pts.map((p) => p.slice());
  return out;
}

/**
 * Slice B+C — tiny Accept densify: round RDP-scale corners that densify-along-
 * chord cannot fix. At each vertex whose turn exceeds maxTurnDeg, replace the
 * sharp joint with quadratic Bézier samples (prev → corner → next). Chips and
 * highlight still use on-geometry `pts`/`mid`; this only smooths the path
 * handed to filletAlongPath / makeSweepPath.
 *
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {{ maxTurnDeg?: number, samples?: number }} [opts]
 * @returns {number[][]}
 */
export function smoothPathCorners(points, closed, opts = {}) {
  const pts = Array.isArray(points) ? points : [];
  if (pts.length < 3) return pts.map((p) => p.slice());
  // Default 40°: catch RDP-collapsed round corners (~90–110°) without touching
  // circular-rim tessellation (~12–25°/facet) or long cube side miters smoothed
  // by the short-seg gate below.
  const maxTurnDeg = typeof opts.maxTurnDeg === 'number' ? opts.maxTurnDeg : 40;
  const samples = Math.max(2, Math.round(opts.samples || 6));
  const maxSegFrac = typeof opts.maxSegFrac === 'number' ? opts.maxSegFrac : 0.18;
  const cosTol = Math.cos((maxTurnDeg * Math.PI) / 180);
  const n = pts.length;
  const out = [];

  let pathLen = 0;
  for (let i = 1; i < n; i++) pathLen += _dist(pts[i - 1], pts[i]);
  if (closed) pathLen += _dist(pts[n - 1], pts[0]);
  const maxSeg = pathLen > 1e-9 ? pathLen * maxSegFrac : Infinity;

  const at = (i) => pts[(i + n) % n];
  const segLen = (i0, i1) => _dist(at(i0), at(i1));
  const turnAlign = (i) => {
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const ab = _sub(b, a);
    const bc = _sub(c, b);
    const lab = _len(ab);
    const lbc = _len(bc);
    if (!(lab > 1e-9) || !(lbc > 1e-9)) return 1;
    return (ab[0] * bc[0] + ab[1] * bc[1] + ab[2] * bc[2]) / (lab * lbc);
  };

  /** RDP-spike corner: sharp turn between two *short* similar chords. */
  const isRdpSpike = (i) => {
    const align = turnAlign(i);
    if (align >= cosTol - 1e-12) return false;
    const lab = segLen(i - 1, i);
    const lbc = segLen(i, i + 1);
    if (!(lab > 1e-9) || !(lbc > 1e-9)) return false;
    if (lab > maxSeg || lbc > maxSeg) return false; // long cube sides
    const ratio = lab > lbc ? lab / lbc : lbc / lab;
    if (ratio > 2.5) return false; // mismatched — not a collapsed arc pair
    return true;
  };

  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) {
      out.push(pts[i].slice());
      continue;
    }
    if (!isRdpSpike(i)) {
      out.push(at(i).slice());
      continue;
    }
    // Sharp RDP spike: quadratic Bézier samples (prev → corner → next),
    // dropping the chord corner that produced faceted fillet wedges.
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    for (let s = 1; s <= samples; s++) {
      const t = s / (samples + 1);
      const u = 1 - t;
      out.push([
        u * u * a[0] + 2 * u * t * b[0] + t * t * c[0],
        u * u * a[1] + 2 * u * t * b[1] + t * t * c[1],
        u * u * a[2] + 2 * u * t * b[2] + t * t * c[2],
      ]);
    }
  }
  if (closed && out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (_dist(a, b) < 1e-5) out.pop();
  }
  return out;
}

/**
 * Assemble reusable sweep-path value (client / golden mirror of makeSweepPath).
 * Soft-fail shape when selection cannot form a path (ok:false).
 *
 * @param {object[]} selectedEdges
 * @param {{ reverse?: boolean, smoothCorners?: boolean, thinPath?: boolean, minSeg?: number }} [opts]
 */
export function assembleSweepPath(selectedEdges, opts = {}) {
  const ordered = orderEdgePath(selectedEdges);
  if (!ordered.ok) return ordered;

  let pts = ordered.points.map((p) => p.slice());
  let edges = ordered.orderedEdges.map((e) => ({
    key: e.key,
    a: e.a,
    b: e.b,
    va: e.va.slice(),
    vb: e.vb.slice(),
    mid: e.mid ? e.mid.slice() : _mid(e.va, e.vb),
    length: e.length,
    pts: Array.isArray(e.pts) ? e.pts.map((p) => p.slice()) : undefined,
  }));

  // Closed: drop duplicated closing vertex (sweepPoints uses closed:true).
  if (ordered.closed && pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (_dist(a, b) < 1e-5) pts = pts.slice(0, -1);
  }

  // Density cap on expanded pre-RDP pts BEFORE corner smooth — thinning after
  // smoothPathCorners would wipe the Bézier samples that remove RDP spikes.
  if (opts.thinPath !== false && pts.length >= 3) {
    pts = thinSweepPathPoints(pts, ordered.closed, {
      minSeg: opts.minSeg,
    });
  }

  // Slice B+C: round RDP-scale corners before fillet/sweep consume the path.
  // Skip when caller asks for raw chords (opts.smoothCorners === false).
  if (opts.smoothCorners !== false && pts.length >= 3) {
    pts = smoothPathCorners(pts, ordered.closed, {
      maxTurnDeg: opts.maxTurnDeg,
      samples: opts.cornerSamples,
    });
  }

  if (opts.reverse) {
    pts = pts.slice().reverse();
    edges = edges
      .slice()
      .reverse()
      .map((e) => ({
        ...e,
        a: e.b,
        b: e.a,
        va: e.vb.slice(),
        vb: e.va.slice(),
        pts: Array.isArray(e.pts) ? e.pts.map((p) => p.slice()).reverse() : undefined,
      }));
  }

  let length = 0;
  for (let i = 1; i < pts.length; i++) length += _dist(pts[i - 1], pts[i]);
  if (ordered.closed && pts.length > 1) length += _dist(pts[pts.length - 1], pts[0]);
  if (!(length > 0)) length = ordered.length;

  return {
    ok: true,
    value: {
      kind: 'sweepPath',
      closed: ordered.closed,
      points: pts,
      length,
      edgeCount: edges.length,
    },
    orderedEdges: edges,
  };
}

/**
 * Loud variant for script/golden parity with sandboxWorker makeSweepPath.
 * @param {object[]} edges
 * @param {{ reverse?: boolean }} [opts]
 */
export function makeSweepPathLoud(edges, opts = {}) {
  const r = assembleSweepPath(edges, opts);
  if (!r.ok) {
    throw new Error(r.message || `makeSweepPath: ${r.code}`);
  }
  return r.value;
}

/**
 * Preview payload for Viewport — ordered polyline + direction cues.
 * Distinct from #20 edge-selection halo (orange): gradient polyline + arrow ticks.
 *
 * @param {object[]} selectedEdges
 * @param {{ reverse?: boolean }} [opts]
 * @returns {object|null}
 */
export function buildSweepPathPreview(selectedEdges, opts = {}) {
  const r = assembleSweepPath(selectedEdges, opts);
  if (!r.ok || !r.value?.points?.length) return null;

  const pts = r.value.points.map((p) => p.slice());
  const drawPts = r.value.closed && pts.length >= 2
    ? [...pts, pts[0].slice()]
    : pts;

  if (drawPts.length < 2) return null;

  const nSeg = drawPts.length - 1;
  const colors = drawPts.map((_, i) => {
    const t = nSeg > 0 ? i / nSeg : 0;
    // Green → magenta (order / direction).
    const rC = Math.round(34 + t * (168 - 34));
    const gC = Math.round(197 + t * (85 - 197));
    const bC = Math.round(94 + t * (247 - 94));
    return [rC / 255, gC / 255, bC / 255];
  });

  const arrows = [];
  for (let i = 0; i < nSeg; i++) {
    const a = drawPts[i];
    const b = drawPts[i + 1];
    const dir = _n(_sub(b, a));
    const segLen = _dist(a, b);
    if (segLen < 1e-6) continue;
    const tip = _add(a, _mul(0.72, _sub(b, a)));
    const up = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const side = _n([
      dir[1] * up[2] - dir[2] * up[1],
      dir[2] * up[0] - dir[0] * up[2],
      dir[0] * up[1] - dir[1] * up[0],
    ]);
    const wing = Math.min(1.1, segLen * 0.18);
    const back = _add(tip, _mul(-wing * 1.4, dir));
    arrows.push({
      tip,
      left: _add(back, _mul(wing, side)),
      right: _add(back, _mul(-wing, side)),
    });
  }

  const markers = [];
  const step = Math.max(1, Math.ceil(pts.length / 12));
  for (let i = 0; i < pts.length; i += step) {
    markers.push({ pos: pts[i].slice(), index: i });
  }
  if (pts.length > 1 && (pts.length - 1) % step !== 0) {
    markers.push({ pos: pts[pts.length - 1].slice(), index: pts.length - 1 });
  }

  return {
    closed: r.value.closed,
    points: drawPts,
    colors,
    arrows,
    markers,
    length: r.value.length,
    edgeCount: r.value.edgeCount,
  };
}

/** True when selection can form a path (for modal gating). */
export function canBuildSweepPath(selectedEdges) {
  return assembleSweepPath(selectedEdges).ok === true;
}
