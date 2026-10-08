/**
 * Slice 12 — Edge pick helpers for Fillet/Chamfer.
 * Candidate edges = mesh edges shared by two triangles whose normals diverge
 * enough to be a feature edge (not a planar tessellation seam).
 */

import {
  propagateTrueTangentEdges,
  TANGENCY_PROP_DEG,
  TANGENCY_NORMAL_ALIGN,
} from './edgeTangencyField.js';
// Not cutMode.js: that file imports the helper palette, which imports this
// module back. The cycle ran holeFeatureParamDefs before HOLE_SIZE_OPTIONS.
import { meshBodyComponents } from './meshBodyComponents.js';

const DEFAULT_FEATURE_DEG = 2;

/**
 * Build feature edges from a BufferGeometry (indexed).
 * @returns {{ key: string, a: number, b: number, va: number[], vb: number[], mid: number[], length: number, tangent: number[], n0: number[], n1: number[] }[]}
 */
/** 26 bits per vertex index. Past that, the key falls back to a string. */
const EDGE_PACK = 0x4000000;

function packedEdgeKey(a, b) {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  if (hi >= EDGE_PACK) return `${lo}-${hi}`;
  return lo * EDGE_PACK + hi;
}

export function buildFeatureEdges(geometry, minAngleDeg = DEFAULT_FEATURE_DEG) {
  if (!geometry?.index || !geometry.attributes?.position) return [];
  const attr = geometry.attributes.position;
  const index = geometry.index.array;
  const numTri = index.length / 3;
  const arr = attr.array;
  const item = attr.itemSize || 3;
  const nx = new Float64Array(numTri);
  const ny = new Float64Array(numTri);
  const nz = new Float64Array(numTri);
  for (let t = 0; t < numTri; t++) {
    const i0 = index[t * 3] * item;
    const i1 = index[t * 3 + 1] * item;
    const i2 = index[t * 3 + 2] * item;
    const ax = arr[i0];
    const ay = arr[i0 + 1];
    const az = arr[i0 + 2];
    const bx = arr[i1] - ax;
    const by = arr[i1 + 1] - ay;
    const bz = arr[i1 + 2] - az;
    const cx = arr[i2] - ax;
    const cy = arr[i2 + 1] - ay;
    const cz = arr[i2 + 2] - az;
    let x = by * cz - bz * cy;
    let y = bz * cx - bx * cz;
    let z = bx * cy - by * cx;
    const len = Math.hypot(x, y, z) || 1;
    nx[t] = x / len;
    ny[t] = y / len;
    nz[t] = z / len;
  }

  const edgeMap = new Map();
  for (let t = 0; t < numTri; t++) {
    const i0 = index[t * 3];
    const i1 = index[t * 3 + 1];
    const i2 = index[t * 3 + 2];
    const pairs = [i0, i1, i1, i2, i2, i0];
    for (let k = 0; k < 6; k += 2) {
      let a = pairs[k];
      let b = pairs[k + 1];
      if (a > b) {
        const s = a;
        a = b;
        b = s;
      }
      const key = packedEdgeKey(a, b);
      let e = edgeMap.get(key);
      if (!e) {
        e = { a, b, tris: [] };
        edgeMap.set(key, e);
      }
      e.tris.push(t);
    }
  }

  const cosMin = Math.cos((minAngleDeg * Math.PI) / 180);
  const bodies = meshBodyComponents(attr, geometry.index);
  const triBody = new Int32Array(numTri).fill(-1);
  bodies.forEach((body, id) => {
    for (const t of body.triangles) triBody[t] = id;
  });
  const out = [];
  for (const e of edgeMap.values()) {
    if (e.tris.length !== 2) continue;
    const t0 = e.tris[0];
    const t1 = e.tris[1];
    if (nx[t0] * nx[t1] + ny[t0] * ny[t1] + nz[t0] * nz[t1] > cosMin) continue;
    const oa = e.a * item;
    const ob = e.b * item;
    const vax = arr[oa];
    const vay = arr[oa + 1];
    const vaz = arr[oa + 2];
    const vbx = arr[ob];
    const vby = arr[ob + 1];
    const vbz = arr[ob + 2];
    const dx = vbx - vax;
    const dy = vby - vay;
    const dz = vbz - vaz;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-9) continue;
    out.push({
      key: `${e.a}-${e.b}`,
      a: e.a,
      b: e.b,
      va: [vax, vay, vaz],
      vb: [vbx, vby, vbz],
      mid: [(vax + vbx) / 2, (vay + vby) / 2, (vaz + vbz) / 2],
      length,
      tangent: [dx / length, dy / length, dz / length],
      n0: [nx[t0], ny[t0], nz[t0]],
      n1: [nx[t1], ny[t1], nz[t1]],
      bodyId: triBody[t0],
    });
  }
  return out;
}

/** Distance from point to segment (va–vb). */
export function distPointToSegment(p, va, vb) {
  const ax = va[0], ay = va[1], az = va[2];
  const bx = vb[0], by = vb[1], bz = vb[2];
  const px = p[0], py = p[1], pz = p[2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const abLen2 = abx * abx + aby * aby + abz * abz;
  let t = abLen2 > 1e-18 ? (apx * abx + apy * aby + apz * abz) / abLen2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * abx, qy = ay + t * aby, qz = az + t * abz;
  return Math.hypot(px - qx, py - qy, pz - qz);
}

/**
 * Pick nearest feature edge to a world hit point.
 * @deprecated-in-app Prefer pickNearestEdgeScreen for Viewport edge mode (screen-space slop).
 * Kept for golden coverage and any world-space call sites.
 * @returns {object|null}
 */
export function pickNearestEdge(featureEdges, hitPoint, maxDist) {
  if (!featureEdges?.length || !hitPoint) return null;
  let best = null;
  let bestD = maxDist;
  for (const e of featureEdges) {
    const d = distPointToSegment(hitPoint, e.va, e.vb);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Stable edge id for multi-select toggle. */
export function edgeKey(edge) {
  if (!edge) return '';
  if (edge.key) return edge.key;
  const a = Math.min(edge.a, edge.b);
  const b = Math.max(edge.a, edge.b);
  return `${a}-${b}`;
}

/**
 * The same picked edge on the same part. Vertex-index keys collide across
 * parts (both solids have an edge "0-1"), so the part id is part of the
 * identity. An untagged edge (single-part viewport) matches on key alone.
 */
export function sameSelectedEdge(a, b) {
  if (!a || !b) return false;
  if (edgeKey(a) !== edgeKey(b)) return false;
  const pa = a.partId == null ? '' : String(a.partId);
  const pb = b.partId == null ? '' : String(b.partId);
  if (!pa || !pb) return true;
  return pa === pb;
}

/** Part-scoped key for chips and React lists: `partId::a-b`, or `a-b` untagged. */
export function selectionEdgeKey(edge) {
  if (!edge) return '';
  const p = edge.partId == null ? '' : String(edge.partId);
  return p ? `${p}::${edgeKey(edge)}` : edgeKey(edge);
}

/**
 * Toggle edge in selection list (by part + key). Returns new array.
 * Picks on other parts are left alone.
 */
export function toggleEdgeSelection(selected, edge) {
  const key = edgeKey(edge);
  const list = Array.isArray(selected) ? [...selected] : [];
  const idx = list.findIndex((e) => sameSelectedEdge(e, edge));
  if (idx >= 0) list.splice(idx, 1);
  else {
    list.push(copyPickEdge(edge, key));
  }
  return list;
}

/** Fields the viewport pick must keep so Fillet Accept can emit face/edge ids. */
function copyPickEdge(edge, key) {
  return {
    key,
    a: edge.a,
    b: edge.b,
    va: edge.va.slice(),
    vb: edge.vb.slice(),
    mid: edge.mid.slice(),
    length: edge.length,
    tangent: edge.tangent ? edge.tangent.slice() : undefined,
    n0: edge.n0 ? edge.n0.slice() : undefined,
    n1: edge.n1 ? edge.n1.slice() : undefined,
    faceA: Number.isFinite(edge.faceA) ? edge.faceA : undefined,
    faceB: Number.isFinite(edge.faceB) ? edge.faceB : undefined,
    boundaryId: Number.isFinite(edge.boundaryId) ? edge.boundaryId : undefined,
    pairCount: Number.isFinite(edge.pairCount) ? edge.pairCount : undefined,
    chainId: Number.isFinite(edge.chainId) ? edge.chainId : undefined,
    partId: edge.partId != null && edge.partId !== '' ? edge.partId : undefined,
    // Slice B+C: dense pre-RDP polyline for chip tracking + makeSweepPath fidelity.
    pts: Array.isArray(edge.pts) && edge.pts.length >= 2
      ? edge.pts.map((p) => p.slice())
      : undefined,
  };
}

/**
 * Kernel size-guard fraction for **planar** filletEdges / chamferEdges (t < 0.45·L).
 * Planar-only: Strategy=sweep / filletAlongPath must NOT use this clamp — short
 * tessellation edges on a prior fillet rim would pin the slider near ~0.04 while
 * r=6 is fine in script. See defaultSweepBlendSize / sweepBlendHardMax.
 */
export const EDGE_BLEND_SIZE_GUARD = 0.45;

/**
 * Minimum length among selected edges (uses .length or |vb-va|).
 * @param {object[]|null|undefined} edges
 * @returns {number|null}
 */
export function minSelectedEdgeLength(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return null;
  let min = Infinity;
  for (const e of edges) {
    let L = Number(e?.length);
    if (!(Number.isFinite(L) && L > 0) && e?.va && e?.vb) {
      L = Math.hypot(
        e.vb[0] - e.va[0],
        e.vb[1] - e.va[1],
        e.vb[2] - e.va[2],
      );
    }
    if (Number.isFinite(L) && L > 0) min = Math.min(min, L);
  }
  return min === Infinity ? null : min;
}

/**
 * Length used for Fillet/Chamfer slider defaults on multi-edge picks.
 * Raw min() collapses to ~0.03 when a tangent/compound set includes short
 * tessellation scraps; drop outliers below 25% of the median, then take min
 * of the kept pool (single-edge unchanged).
 * @param {object[]|null|undefined} edges
 * @returns {number|null}
 */
export function effectiveBlendEdgeLength(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return null;
  const lengths = [];
  for (const e of edges) {
    let L = Number(e?.length);
    if (!(Number.isFinite(L) && L > 0) && e?.va && e?.vb) {
      L = Math.hypot(
        e.vb[0] - e.va[0],
        e.vb[1] - e.va[1],
        e.vb[2] - e.va[2],
      );
    }
    if (Number.isFinite(L) && L > 0) lengths.push(L);
  }
  if (!lengths.length) return null;
  if (lengths.length === 1) return lengths[0];
  lengths.sort((a, b) => a - b);
  const med = lengths[Math.floor(lengths.length / 2)];
  const kept = lengths.filter((L) => L >= 0.25 * med);
  const pool = kept.length ? kept : [med];
  return Math.min(...pool);
}

/**
 * Range-input step scaled to hard-max so short-edge sliders are not stuck
 * (step 0.5 with max≈0.03 leaves the thumb immovable).
 * @param {number|null|undefined} hardMax
 * @returns {number}
 */
export function blendSliderStep(hardMax) {
  const m = Number(hardMax);
  if (!(m > 0) || m >= 5) return 0.5;
  return Math.max(0.01, Math.round((m / 20) * 100) / 100);
}

/**
 * Safe default fillet/chamfer size from min edge length.
 * Formula: clamp(0.15·minL, min(0.5, 0.35·minL), 0.35·minL) — always ≤ 0.35·L < 0.45·L.
 * @param {number} minEdgeLength
 * @returns {number}
 */
export function defaultEdgeBlendSize(minEdgeLength) {
  const minL = Number(minEdgeLength);
  if (!(minL > 0)) return 3;
  const softMax = 0.35 * minL;
  const floor = Math.min(0.5, softMax);
  const r = Math.min(softMax, Math.max(floor, 0.15 * minL));
  // Param min for radius/chamfer is 0.01 — never round a tiny softMax down to 0.
  return Math.max(0.01, Math.round(r * 100) / 100);
}

/**
 * Slider / type hard max under the kernel size guard (0.44·minL).
 * @param {number} minEdgeLength
 * @returns {number}
 */
export function edgeBlendHardMax(minEdgeLength) {
  const minL = Number(minEdgeLength);
  if (!(minL > 0)) return 100;
  return Math.round(0.44 * minL * 100) / 100;
}

/**
 * True if blend size would fail the **planar** kernel size guard (t ≥ 0.45·L).
 * Do not call for Strategy=sweep / filletAlongPath — see sweepBlendHardMax.
 */
export function edgeBlendFailsSizeGuard(size, minEdgeLength) {
  const t = Number(size);
  const minL = Number(minEdgeLength);
  if (!(t > 0) || !(minL > 0)) return false;
  return t >= EDGE_BLEND_SIZE_GUARD * minL;
}

/**
 * Total path length of selected edges (sum of .length / |vb−va|).
 * Used for Strategy=sweep radius defaults when per-edge min L is tessellation-scale.
 * @param {object[]|null|undefined} edges
 * @returns {number|null}
 */
export function pathLengthFromEdges(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const e of edges) {
    let L = Number(e?.length);
    if (!(Number.isFinite(L) && L > 0) && e?.va && e?.vb) {
      L = Math.hypot(
        e.vb[0] - e.va[0],
        e.vb[1] - e.va[1],
        e.vb[2] - e.va[2],
      );
    }
    if (Number.isFinite(L) && L > 0) {
      sum += L;
      n++;
    }
  }
  return n ? sum : null;
}

/**
 * Absolute model-unit floor/cap for defaultSweepBlendSize (box-scale UX).
 * 0.1·L is scale-relative; these bound the thumb on ~10–60 unit perimeters.
 */
export const SWEEP_BLEND_DEFAULT_MIN = 1;
export const SWEEP_BLEND_DEFAULT_MAX = 6;

/**
 * Untouched Fillet radius: a fixed 2 mm, however many edges are picked.
 * (Fillet mode thin-clamps it per part: see defaultFilletRadius in filletMode.js.)
 */
export const FILLET_DEFAULT_RADIUS = 2;

/**
 * Sweep fillet default radius from path length (not 0.45·minL).
 * Caps at SWEEP_BLEND_DEFAULT_MAX so box-scale perimeter picks get a usable
 * thumb without the planar 0.45·L clamp. Empty L → 3 (planar fillet seed);
 * call sites pass null through rather than inventing L=30.
 * @param {number} pathLength
 * @returns {number}
 */
export function defaultSweepBlendSize(pathLength) {
  const L = Number(pathLength);
  if (!(L > 0)) return 3;
  const r = Math.min(
    SWEEP_BLEND_DEFAULT_MAX,
    Math.max(SWEEP_BLEND_DEFAULT_MIN, 0.1 * L),
  );
  return Math.max(0.01, Math.round(r * 100) / 100);
}

/**
 * Sweep slider / typed hard max — scale-relative (½·L), floored at 6 (not 50).
 * Floor 6 (vs review's suggested 5) keeps typed-6 + max≥6 golden on short rims;
 * absolute 50 was oversized (~13× segment on box-scale paths).
 * Empty / non-positive L → 100 (no invented L=30).
 * @param {number} [pathLength]
 * @returns {number}
 */
export function sweepBlendHardMax(pathLength) {
  const L = Number(pathLength);
  if (L > 0) return Math.max(6, Math.round(0.5 * L * 100) / 100);
  return 100;
}

/** Pop the last selected edge (Back affordance). Returns new array. */
export function popLastEdgeSelection(selected) {
  const list = Array.isArray(selected) ? [...selected] : [];
  if (list.length === 0) return list;
  list.pop();
  return list;
}

/** 2D distance from point (px,py) to segment (ax,ay)–(bx,by). */
export function distPointToSegment2D(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLen2 = abx * abx + aby * aby;
  let t = abLen2 > 1e-18 ? (apx * abx + apy * aby) / abLen2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * abx;
  const qy = ay + t * aby;
  return Math.hypot(px - qx, py - qy);
}

/** Default finger slop in CSS pixels for edge pick (mobile-friendly). */
export const EDGE_PICK_SLOP_PX = 32;
export const EDGE_PICK_SLOP_COARSE_PX = 40;

/**
 * Resolve pixel slop for the current pointer type.
 * Coarse (touch) gets a larger target; fine pointers stay at EDGE_PICK_SLOP_PX.
 */
export function resolveEdgePickSlopPx(opts = {}) {
  if (typeof opts.slopPx === 'number' && opts.slopPx > 0) return opts.slopPx;
  if (opts.coarse === true) return EDGE_PICK_SLOP_COARSE_PX;
  if (opts.coarse === false) return EDGE_PICK_SLOP_PX;
  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
    return EDGE_PICK_SLOP_COARSE_PX;
  }
  return EDGE_PICK_SLOP_PX;
}

/**
 * Project a world point through a Three.js camera into canvas pixel coords.
 * Returns null if the point is outside useful NDC depth (behind / clipped).
 *
 * @param {object} camera Three.js Camera
 * @param {number[]} world [x,y,z]
 * @param {number} canvasW
 * @param {number} canvasH
 * @param {{x:number,y:number,z:number,project?:Function}|null} [tmp]
 */
export function projectWorldToCanvas(camera, world, canvasW, canvasH, tmp = null) {
  if (!camera || !world || !(canvasW > 0) || !(canvasH > 0)) return null;
  const v = tmp || { x: 0, y: 0, z: 0 };
  v.x = world[0];
  v.y = world[1];
  v.z = world[2];
  if (typeof v.project === 'function') {
    v.project(camera);
  } else {
    const m = camera.matrixWorldInverse;
    const p = camera.projectionMatrix;
    if (!m || !p) return null;
    const e = m.elements;
    const x = v.x;
    const y = v.y;
    const z = v.z;
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const ww = e[3] * x + e[7] * y + e[11] * z + e[15];
    const pe = p.elements;
    const cx = pe[0] * wx + pe[4] * wy + pe[8] * wz + pe[12] * ww;
    const cy = pe[1] * wx + pe[5] * wy + pe[9] * wz + pe[13] * ww;
    const cz = pe[2] * wx + pe[6] * wy + pe[10] * wz + pe[14] * ww;
    const cw = pe[3] * wx + pe[7] * wy + pe[11] * wz + pe[15] * ww;
    if (Math.abs(cw) < 1e-12) return null;
    v.x = cx / cw;
    v.y = cy / cw;
    v.z = cz / cw;
  }
  if (v.z < -1 || v.z > 1) return null;
  return {
    x: (v.x * 0.5 + 0.5) * canvasW,
    y: (-v.y * 0.5 + 0.5) * canvasH,
    ndcZ: v.z,
  };
}


/**
 * True when no adjacent face normal points toward the camera (back / through
 * solid). Silhouette edges typically have one camera-facing normal — false.
 * Missing normals: treat as facing away so distance-only rejection still works.
 */
export function edgeFacesAwayFromCamera(e, camPos) {
  if (!e?.mid || !camPos) return true;
  const mid = e.mid;
  const vx = camPos[0] - mid[0];
  const vy = camPos[1] - mid[1];
  const vz = camPos[2] - mid[2];
  const toward = (n) => n && (n[0] * vx + n[1] * vy + n[2] * vz) > 0;
  if (!e.n0 && !e.n1) return true;
  return !(toward(e.n0) || toward(e.n1));
}

/**
 * Screen-space edge pick: nearest feature edge by 2D pixel distance to the
 * projected segment. Does NOT require a mesh face hit — silhouette / near-miss
 * taps work. Prefer closer-to-camera edge on near ties.
 *
 * Occlusion (opts.meshHitPoint + opts.cameraPosition): when the tap hits the
 * mesh, reject edges whose midpoint is further from the camera than the hit
 * (plus a small epsilon) AND whose adjacent face normals both face away from
 * the camera. Pure distance rejection false-rejects silhouette / boundary
 * edges beside the solid (lateral offset makes mid farther even when the edge
 * is the intended pick). Edges with any camera-facing normal (silhouette band)
 * are kept. Taps with no mesh hit skip this filter.
 *
 * @returns {object|null}
 */
export function pickNearestEdgeScreen(
  featureEdges,
  camera,
  canvasW,
  canvasH,
  px,
  py,
  maxPx,
  opts = {},
) {
  if (!featureEdges?.length || !camera || !(maxPx > 0)) return null;
  const scratchA = opts.projectScratchA || null;
  const scratchB = opts.projectScratchB || null;
  const hit = opts.meshHitPoint;
  const camPos = opts.cameraPosition;
  const occludeEps = typeof opts.occlusionEps === 'number' ? opts.occlusionEps : 0.75;
  let hitDist = null;
  if (hit && camPos && Array.isArray(hit) && Array.isArray(camPos)) {
    hitDist = Math.hypot(hit[0] - camPos[0], hit[1] - camPos[1], hit[2] - camPos[2]);
  }
  let best = null;
  let bestD = Infinity;
  let bestDepth = Infinity;
  for (const e of featureEdges) {
    const sa = projectWorldToCanvas(camera, e.va, canvasW, canvasH, scratchA);
    const sb = projectWorldToCanvas(camera, e.vb, canvasW, canvasH, scratchB);
    if (!sa && !sb) continue;
    let d;
    let depth;
    if (sa && sb) {
      d = distPointToSegment2D(px, py, sa.x, sa.y, sb.x, sb.y);
      depth = Math.min(sa.ndcZ, sb.ndcZ);
    } else {
      const s = sa || sb;
      d = Math.hypot(px - s.x, py - s.y);
      depth = s.ndcZ;
    }
    // Strict < maxPx (matches pickNearestEdge); depth tie-break when equal px.
    if (!(d < maxPx)) continue;
    // Mesh occlusion: drop edges behind the front-face hit, but only when the
    // edge faces away from the camera. Silhouette edges beside the solid have
    // a lateral mid offset that exceeds hitDist+eps even though one face
    // normal still faces the camera — keep those.
    if (hitDist != null && camPos && e.mid) {
      const mid = e.mid;
      const edgeDist = Math.hypot(mid[0] - camPos[0], mid[1] - camPos[1], mid[2] - camPos[2]);
      if (edgeDist > hitDist + occludeEps && edgeFacesAwayFromCamera(e, camPos)) continue;
    }
    if (d < bestD || (d === bestD && depth < bestDepth)) {
      bestD = d;
      bestDepth = depth;
      best = e;
    }
  }
  return best;
}

/**
 * G1 walk tolerance *between adjacent pick chords* (degrees).
 * Re-export of edgeTangencyField.TANGENCY_PROP_DEG. Decoupled from
 * `CHAIN_MAX_TURN_DEG` (within-one-RDP-chord span) — see that constant.
 */
export const TANGENT_PROP_DEG = TANGENCY_PROP_DEG;

/**
 * Build adjacency: vertex index → feature edges touching it.
 * @param {object[]} featureEdges
 * @returns {Map<number, object[]>}
 */
export function buildEdgeVertexAdj(featureEdges) {
  const adj = new Map();
  if (!featureEdges?.length) return adj;
  for (const e of featureEdges) {
    for (const v of [e.a, e.b]) {
      if (!adj.has(v)) adj.set(v, []);
      adj.get(v).push(e);
    }
  }
  return adj;
}

/**
 * Absolute tangent alignment |t0·t1| for G1 test (direction-insensitive).
 */
export function tangentAlign(t0, t1) {
  if (!t0 || !t1) return 0;
  return Math.abs(t0[0] * t1[0] + t0[1] * t1[1] + t0[2] * t1[2]);
}

/**
 * Propagate G1-connected (tangent) edges from a seed through the feature-edge
 * graph. Soft-fails to [seed] when no tangent neighbors exist.
 *
 * Walk rule: at a shared vertex, accept a neighbor when |t_seed·t_nbr| >= cos(tolDeg)
 * (tessellated circular / fillet loops stay linked; sharp corners break the chain).
 *
 * @param {object[]} featureEdges
 * @param {object} seedEdge
 * @param {{ tolDeg?: number, adj?: Map<number, object[]> }} [opts]
 * @returns {object[]} seed + G1 chain (deduped by edgeKey)
 */
export function propagateTangentEdges(featureEdges, seedEdge, opts = {}) {
  // C3 / Mobile C.2 / C.3: G1 walk via shared tangency field. Soft-fails to seed.
  // Walker is uncapped so long legitimate wires return whole; callers refuse
  // floods via TANGENT_PROP_FLOOD_MAX (see toggleEdgeSelectionPropagated).
  // Edge-pick defaults to skipNormals:
  //   - Smooth tan within tol (circular / RDP chords) — no wall-normal gate (C.2)
  //   - Collapsed fillet corners (~70–85°) — seed-plane continue (C.3)
  //   - Spatial endpoint bridging when coherent chains mint fresh vertex ids (C.3)
  //   - Same-face parallel bridge, node-gated on corresponding endpoints (C.3 / EDGES PR1)
  if (!seedEdge) return [];
  const skipNormals = opts.skipNormals !== false;
  const chain = propagateTrueTangentEdges(featureEdges || [], seedEdge, {
    tolDeg: opts.tolDeg != null ? opts.tolDeg : TANGENCY_PROP_DEG,
    normalAlign: opts.normalAlign != null ? opts.normalAlign : TANGENCY_NORMAL_ALIGN,
    skipNormals,
    spatialAdjacency: opts.spatialAdjacency,
    cornerDeg: opts.cornerDeg,
    cornerSharpDeg: opts.cornerSharpDeg,
    cornerOutOfPlaneDeg: opts.cornerOutOfPlaneDeg,
    parallelFaceBridge: opts.parallelFaceBridge,
    seedPlaneNormal: opts.seedPlaneNormal,
    adj: opts.adj || buildEdgeVertexAdj(featureEdges || []),
    max: 1e9,
  });
  return chain.map((e) => copyPickEdge(e, edgeKey(e)));
}

export function edgeDihedralDeg(edge) {
  const n0 = edge?.n0;
  const n1 = edge?.n1;
  if (!n0 || !n1) return 0;
  const d = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
  return Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI;
}

/**
 * Hard cap on a single pick / tangent chain.
 * A simple loft silhouette (rim, corner generator, rectangle side) fits;
 * a tessellation flood (~160 zig-zag segments) does not — refuse it.
 */
export const COHERENT_EDGE_MAX = 36;

/**
 * Mobile C.2 — refuse threshold for Tangent-on G1 walks on the *coherent* pick
 * graph. Separate from {@link COHERENT_EDGE_MAX} (silhouette simplify cap).
 * Covers default/max circular segments (64 / 128) while still refusing
 * tessellation floods (~160). #68 raised segments 32→64; the old reuse of
 * COHERENT_EDGE_MAX (=36) refused legitimate 64-seg rim walks when chainId
 * fast-path was not taken.
 */
export const TANGENT_PROP_FLOOD_MAX = 128;

const COLLINEAR_DEG = 6;
const LINE_OFFSET_EPS = 0.45;
const LINE_GAP_EPS = 0.75;
/** RDP tolerance. Keeps a mild loft generator; collapses a straight side to one segment. */
const CHAIN_SIMPLIFY_EPS = 0.35;
/**
 * Max turn (deg) a single simplified chord may span *internally* (RDP).
 *
 * RDP alone is a *distance* test, so on a tight arc it is scale-blind: a
 * fillet's r=4 quarter-round sits only 0.30 mm off its own 45° chord, under
 * CHAIN_SIMPLIFY_EPS, so a 24-segment blend end-cap collapsed to TWO chords
 * turning 45° each. That broke Tangent-on twice over: the highlight was a
 * 2-chord polyline instead of a curve, and 45° blows past the between-chord
 * walk tolerance, so the G1 walk died one chord into the round.
 *
 * This caps the angular span *within* one kept chord. It does **not** bound
 * the turn *between* adjacent chords — that is {@link TANGENT_PROP_DEG}
 * (EDGES.md PR 1). Adjacent chords can still turn ~26° on a shelled fillet
 * arc when each internal span is ≤20°, so the walk tol must be set separately.
 * Straight runs turn 0° and still collapse to one segment.
 */
const CHAIN_MAX_TURN_DEG = 20;
/** Closed loops kept only when they are circular rims, not a face outline. */
const RIM_RADIAL_CV = 0.12;

function _sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _len3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function _dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function _otherVert(edge, v) {
  return edge.a === v ? edge.b : edge.a;
}
function _posAt(edge, v) {
  return v === edge.a ? edge.va : edge.vb;
}

function _pointLineDist(p, origin, tangent) {
  const vx = p[0] - origin[0];
  const vy = p[1] - origin[1];
  const vz = p[2] - origin[2];
  const proj = vx * tangent[0] + vy * tangent[1] + vz * tangent[2];
  return Math.hypot(p[0] - (origin[0] + proj * tangent[0]), p[1] - (origin[1] + proj * tangent[1]), p[2] - (origin[2] + proj * tangent[2]));
}

function _pointSegDist(p, a, b) {
  const ab = _sub3(b, a);
  const L2 = _dot3(ab, ab);
  let t = L2 > 1e-18 ? _dot3(_sub3(p, a), ab) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return _dist3(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]);
}

function _sameLine(a, b) {
  if (tangentAlign(a.tangent, b.tangent) < Math.cos((COLLINEAR_DEG * Math.PI) / 180)) return false;
  if (_pointLineDist(b.va, a.va, a.tangent) > LINE_OFFSET_EPS) return false;
  if (_pointLineDist(b.vb, a.va, a.tangent) > LINE_OFFSET_EPS) return false;
  return true;
}

function _uniqueFinite(edges, field) {
  let value;
  let seen = false;
  for (const e of edges) {
    if (!Number.isFinite(e?.[field])) continue;
    if (!seen) {
      value = e[field];
      seen = true;
    } else if (e[field] !== value) {
      return undefined;
    }
  }
  return seen ? value : undefined;
}

/**
 * Collapse overlapping collinear copies of one design edge (loft rims are
 * often dozens of coincident triangle edges on the same line) into one segment.
 * @param {object[]} edges
 */
function mergeCollinearEdges(edges) {
  // Group against the seed line only. Union-find would walk a curve
  // (each 6° step collinear with the last) and erase a loft generator.
  // The foot of the perpendicular from the origin is constant on one line.
  // A partner within COLLINEAR_DEG and LINE_OFFSET_EPS lands in this cell
  // or a neighbor (cell size is that slack). The exact test still decides,
  // and candidates are taken in index order so the seed grouping stays put.
  const n = edges.length;
  const used = new Array(n).fill(false);
  const groups = [];
  const feet = new Float64Array(n * 3);
  let reach2 = 0;
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    const t = e.tangent;
    const s = e.va[0] * t[0] + e.va[1] * t[1] + e.va[2] * t[2];
    feet[i * 3] = e.va[0] - t[0] * s;
    feet[i * 3 + 1] = e.va[1] - t[1] * s;
    feet[i * 3 + 2] = e.va[2] - t[2] * s;
    const rva = e.va[0] * e.va[0] + e.va[1] * e.va[1] + e.va[2] * e.va[2];
    const rvb = e.vb[0] * e.vb[0] + e.vb[1] * e.vb[1] + e.vb[2] * e.vb[2];
    if (rva > reach2) reach2 = rva;
    if (rvb > reach2) reach2 = rvb;
  }
  const reach = Math.sqrt(reach2);
  const slack = LINE_OFFSET_EPS + reach * Math.sin((COLLINEAR_DEG * Math.PI) / 180) + 1e-4;
  const Q = slack;
  const BIAS = 65536;
  const CELL = 131072;
  const pack = (ix, iy, iz) => {
    if (ix < -BIAS || iy < -BIAS || iz < -BIAS || ix >= BIAS || iy >= BIAS || iz >= BIAS) {
      return `${ix}|${iy}|${iz}`;
    }
    return ((ix + BIAS) * CELL + (iy + BIAS)) * CELL + (iz + BIAS);
  };
  const bins = new Map();
  const bix = new Int32Array(n);
  const biy = new Int32Array(n);
  const biz = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const ix = Math.round(feet[i * 3] / Q);
    const iy = Math.round(feet[i * 3 + 1] / Q);
    const iz = Math.round(feet[i * 3 + 2] / Q);
    bix[i] = ix;
    biy[i] = iy;
    biz[i] = iz;
    const key = pack(ix, iy, iz);
    let list = bins.get(key);
    if (!list) {
      list = [];
      bins.set(key, list);
    }
    list.push(i);
  }
  const cands = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    const group = [edges[i]];
    used[i] = true;
    cands.length = 0;
    const ix = bix[i];
    const iy = biy[i];
    const iz = biz[i];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = bins.get(pack(ix + dx, iy + dy, iz + dz));
          if (!list) continue;
          for (let p = 0; p < list.length; p++) {
            const j = list[p];
            if (j > i && !used[j]) cands.push(j);
          }
        }
      }
    }
    cands.sort((a, b) => a - b);
    const seedBody = edges[i].bodyId;
    const seedFinite = Number.isFinite(seedBody);
    for (let p = 0; p < cands.length; p++) {
      const j = cands[p];
      if (used[j]) continue;
      if (seedFinite && Number.isFinite(edges[j].bodyId) && seedBody !== edges[j].bodyId) continue;
      if (!_sameLine(edges[i], edges[j])) continue;
      used[j] = true;
      group.push(edges[j]);
    }
    groups.push(group);
  }
  const out = [];
  for (const group of groups) {
    const t = group[0].tangent;
    const origin = group[0].va;
    const spans = group.map((e) => {
      const pa = _dot3(_sub3(e.va, origin), t);
      const pb = _dot3(_sub3(e.vb, origin), t);
      const lo = Math.min(pa, pb);
      const hi = Math.max(pa, pb);
      const loP = pa <= pb ? e.va : e.vb;
      const hiP = pa <= pb ? e.vb : e.va;
      const loI = pa <= pb ? e.a : e.b;
      const hiI = pa <= pb ? e.b : e.a;
      return { lo, hi, loP, hiP, loI, hiI, src: e };
    });
    spans.sort((a, b) => a.lo - b.lo);
    const flush = (span) => {
      const va = span.loP.slice();
      const vb = span.hiP.slice();
      const delta = _sub3(vb, va);
      const L = _len3(delta);
      if (!(L > 1e-8)) return;
      const tangent = [delta[0] / L, delta[1] / L, delta[2] / L];
      out.push({
        key: `m-${span.loI}-${span.hiI}-${out.length}`,
        a: span.loI,
        b: span.hiI,
        va,
        vb,
        mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
        length: L,
        tangent,
        n0: span.src.n0 ? span.src.n0.slice() : undefined,
        n1: span.src.n1 ? span.src.n1.slice() : undefined,
        boundaryId: span.boundaryId,
        faceA: span.faceA,
        faceB: span.faceB,
        pairCount: span.pairCount,
        bodyId: span.src.bodyId,
        _sources: span.sources,
      });
    };
    const first = spans[0];
    let acc = {
      lo: first.lo,
      hi: first.hi,
      loP: first.loP,
      hiP: first.hiP,
      loI: first.loI,
      hiI: first.hiI,
      src: first.src,
      boundaryId: _uniqueFinite([first.src], 'boundaryId'),
      faceA: _uniqueFinite([first.src], 'faceA'),
      faceB: _uniqueFinite([first.src], 'faceB'),
      pairCount: _uniqueFinite([first.src], 'pairCount'),
      sources: [first.src],
    };
    for (let k = 1; k < spans.length; k++) {
      const s = spans[k];
      if (s.lo <= acc.hi + LINE_GAP_EPS) {
        acc.sources.push(s.src);
        if (s.hi > acc.hi) {
          acc.hi = s.hi;
          acc.hiP = s.hiP;
          acc.hiI = s.hiI;
        }
        acc.boundaryId = _uniqueFinite(acc.sources, 'boundaryId');
        acc.faceA = _uniqueFinite(acc.sources, 'faceA');
        acc.faceB = _uniqueFinite(acc.sources, 'faceB');
        acc.pairCount = _uniqueFinite(acc.sources, 'pairCount');
      } else {
        flush(acc);
        acc = {
          lo: s.lo,
          hi: s.hi,
          loP: s.loP,
          hiP: s.hiP,
          loI: s.loI,
          hiI: s.hiI,
          src: s.src,
          boundaryId: _uniqueFinite([s.src], 'boundaryId'),
          faceA: _uniqueFinite([s.src], 'faceA'),
          faceB: _uniqueFinite([s.src], 'faceB'),
          pairCount: _uniqueFinite([s.src], 'pairCount'),
          sources: [s.src],
        };
      }
    }
    flush(acc);
  }
  return out;
}

function _walkDir(prev, v, adj, used) {
  const cosTol = Math.cos((TANGENT_PROP_DEG * Math.PI) / 180);
  const seq = [];
  while (seq.length < 8000) {
    const nbrs = adj.get(v) || [];
    let best = null;
    let bestAl = cosTol;
    for (const n of nbrs) {
      const nk = edgeKey(n);
      if (used.has(nk)) continue;
      if (Number.isFinite(prev.bodyId) && Number.isFinite(n.bodyId) && prev.bodyId !== n.bodyId) continue;
      const al = tangentAlign(prev.tangent, n.tangent);
      if (al + 1e-12 < cosTol) continue;
      if (!best || al > bestAl + 1e-12 || (Math.abs(al - bestAl) <= 1e-12 && n.length > best.length)) {
        bestAl = al;
        best = n;
      }
    }
    if (!best) break;
    seq.push(best);
    used.add(edgeKey(best));
    v = _otherVert(best, v);
    prev = best;
  }
  return seq;
}

function _traceChains(edges) {
  const adj = buildEdgeVertexAdj(edges);
  const used = new Set();
  const chains = [];
  for (const edge of edges) {
    const sk = edgeKey(edge);
    if (used.has(sk)) continue;
    used.add(sk);
    const forward = _walkDir(edge, edge.b, adj, used);
    const backward = _walkDir(edge, edge.a, adj, used);
    chains.push([...backward.reverse(), edge, ...forward]);
  }
  return chains;
}

function _orderChain(chain) {
  if (!chain.length) return null;
  let v = chain[0].a;
  if (chain.length > 1) {
    const n = chain[1];
    const sharesA = n.a === chain[0].a || n.b === chain[0].a;
    v = sharesA ? chain[0].b : chain[0].a;
  }
  const pts = [];
  const idxs = [];
  pts.push(_posAt(chain[0], v).slice());
  idxs.push(v);
  for (const e of chain) {
    const next = e.a === v ? e.b : (e.b === v ? e.a : null);
    if (next == null) return null;
    pts.push(_posAt(e, next).slice());
    idxs.push(next);
    v = next;
  }
  const closed = idxs.length > 2 && idxs[0] === idxs[idxs.length - 1];
  if (closed) {
    pts.pop();
    idxs.pop();
  }
  return { pts, idxs, closed };
}

/**
 * Turn (deg) the original polyline accumulates across span [i,j]: the angle
 * between its first and last segment direction. 0 on a straight run.
 */
function _spanTurnDeg(pts, i, j) {
  if (j - i < 2) return 0;
  const first = _sub3(pts[i + 1], pts[i]);
  const last = _sub3(pts[j], pts[j - 1]);
  const la = _len3(first);
  const lb = _len3(last);
  if (!(la > 1e-9) || !(lb > 1e-9)) return 0;
  const c = _dot3(first, last) / (la * lb);
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

function _rdpKeep(pts, eps, maxTurnDeg = CHAIN_MAX_TURN_DEG) {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const keep = new Array(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const pair = stack.pop();
    const i = pair[0];
    const j = pair[1];
    let maxD = 0;
    let maxK = -1;
    for (let k = i + 1; k < j; k++) {
      const d = _pointSegDist(pts[k], pts[i], pts[j]);
      if (d > maxD) {
        maxD = d;
        maxK = k;
      }
    }
    // Split on distance OR on angular span: RDP's distance test is scale-blind
    // on tight arcs (see CHAIN_MAX_TURN_DEG). When only the turn is over, the
    // farthest point is still the right place to cut — on an arc it is the
    // mid-vertex, which halves the span.
    if (maxK >= 0 && (maxD > eps || _spanTurnDeg(pts, i, j) > maxTurnDeg)) {
      keep[maxK] = true;
      stack.push([i, maxK], [maxK, j]);
    }
  }
  const idx = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return idx;
}

function _simplifyPolyline(pts, closed) {
  if (!pts || pts.length < 2) return null;
  if (!closed) {
    const idx = _rdpKeep(pts, CHAIN_SIMPLIFY_EPS);
    return idx.length >= 2 ? idx : null;
  }
  if (pts.length < 3) return null;
  let far = 1;
  let best = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = _dist3(pts[0], pts[i]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const left = _rdpKeep(pts.slice(0, far + 1), CHAIN_SIMPLIFY_EPS);
  const rightPts = pts.slice(far).concat([pts[0]]);
  const right = _rdpKeep(rightPts, CHAIN_SIMPLIFY_EPS).map((i) => (i === rightPts.length - 1 ? 0 : far + i));
  const merged = left.concat(right.slice(1, -1));
  return merged.length >= 3 ? merged : null;
}

function _radialCv(pts) {
  if (!pts.length) return Infinity;
  const c = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  c[0] /= pts.length;
  c[1] /= pts.length;
  c[2] /= pts.length;
  const rs = pts.map((p) => _dist3(p, c));
  const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
  if (!(mean > 1e-8)) return Infinity;
  const dev = rs.reduce((s, r) => s + Math.abs(r - mean), 0) / rs.length;
  return dev / mean;
}

/**
 * Dense original polyline spanning keep indices [i0 → i1] (closed wrap OK).
 * RDP chords alone shortcut curves — chips and fillet paths need these pts.
 */
function _sliceOrderedPts(pts, i0, i1) {
  if (!pts?.length) return [];
  if (i0 === i1) return [pts[i0].slice()];
  if (i0 < i1) return pts.slice(i0, i1 + 1).map((p) => p.slice());
  // Closed wrap: i0 → end, then 0 → i1
  return pts.slice(i0).concat(pts.slice(0, i1 + 1)).map((p) => p.slice());
}

/** Arc-length midpoint on a dense polyline (on-geometry track for chips). */
function _arcLengthMidpoint(poly) {
  if (!poly?.length) return null;
  if (poly.length === 1) return poly[0].slice();
  let total = 0;
  const lens = [];
  for (let i = 1; i < poly.length; i++) {
    const L = _dist3(poly[i - 1], poly[i]);
    lens.push(L);
    total += L;
  }
  if (!(total > 1e-12)) return poly[0].slice();
  let target = total * 0.5;
  for (let i = 0; i < lens.length; i++) {
    const L = lens[i];
    if (target <= L + 1e-12) {
      const t = L > 1e-12 ? target / L : 0;
      const a = poly[i];
      const b = poly[i + 1];
      return [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        a[2] + t * (b[2] - a[2]),
      ];
    }
    target -= L;
  }
  return poly[poly.length - 1].slice();
}

/**
 * On-geometry track point for HTML edge chips / overlays.
 * Prefers dense `pts` arc mid; falls back to chord mid / endpoint average.
 */
export function edgeTrackPoint(edge) {
  if (!edge) return null;
  if (Array.isArray(edge.pts) && edge.pts.length >= 2) {
    const mid = _arcLengthMidpoint(edge.pts);
    if (mid) return mid;
  }
  if (Array.isArray(edge.mid) && edge.mid.length >= 3) {
    return [Number(edge.mid[0]), Number(edge.mid[1]), Number(edge.mid[2])];
  }
  if (Array.isArray(edge.va) && Array.isArray(edge.vb)) {
    return [
      (edge.va[0] + edge.vb[0]) / 2,
      (edge.va[1] + edge.vb[1]) / 2,
      (edge.va[2] + edge.vb[2]) / 2,
    ];
  }
  return null;
}

/**
 * Oriented dense polyline for an edge (va→vb). Used by highlight + makeSweepPath.
 * @returns {number[][]|null}
 */
export function edgePolyline(edge) {
  if (!edge) return null;
  if (Array.isArray(edge.pts) && edge.pts.length >= 2) {
    return edge.pts.map((p) => p.slice());
  }
  if (Array.isArray(edge.va) && Array.isArray(edge.vb)) {
    return [edge.va.slice(), edge.vb.slice()];
  }
  return null;
}

/**
 * Chord-mid vs on-geometry track distance — goldens pin that RDP chords
 * no longer float chips inside rounded corners.
 */
export function edgeChordFloatError(edge) {
  if (!edge || !Array.isArray(edge.pts) || edge.pts.length < 3) return 0;
  const chordMid = [
    (edge.va[0] + edge.vb[0]) / 2,
    (edge.va[1] + edge.vb[1]) / 2,
    (edge.va[2] + edge.vb[2]) / 2,
  ];
  const track = edgeTrackPoint(edge);
  if (!track) return 0;
  return _dist3(chordMid, track);
}

function _segmentsFromKeep(ordered, keep) {
  const { pts, idxs, closed } = ordered;
  const segs = [];
  const n = keep.length;
  const steps = closed ? n : n - 1;
  for (let s = 0; s < steps; s++) {
    const i0 = keep[s];
    const i1 = keep[(s + 1) % n];
    const va = pts[i0];
    const vb = pts[i1];
    const delta = _sub3(vb, va);
    const L = _len3(delta);
    if (!(L > 1e-8)) continue;
    // Slice B+C: keep the pre-RDP polyline under each chord so chips sit on
    // the real edge and makeSweepPath / fillet recover curvature (RDP chords
    // alone shortcut arcs — mid floats inside; densify-along-chord cannot
    // restore corners lost to simplification).
    const dense = _sliceOrderedPts(pts, i0, i1);
    const track = dense.length >= 2 ? _arcLengthMidpoint(dense) : null;
    let arcLen = 0;
    for (let k = 1; k < dense.length; k++) arcLen += _dist3(dense[k - 1], dense[k]);
    segs.push({
      a: idxs[i0],
      b: idxs[i1],
      va: va.slice(),
      vb: vb.slice(),
      mid: track || [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
      length: arcLen > 1e-8 ? arcLen : L,
      tangent: [delta[0] / L, delta[1] / L, delta[2] / L],
      pts: dense.length >= 2 ? dense : undefined,
    });
  }
  return segs;
}

/**
 * Pick candidates for Edge / Fillet: sharp creases collapsed to a short
 * silhouette polyline. Shallow loft-wall seams (dihedral under the #46
 * gate) never enter the graph, so tangent-on cannot flood the tessellation.
 * A chain that will not simplify under {@link COHERENT_EDGE_MAX} is dropped
 * (empty is better than a zig-zag mesh dump).
 *
 * Closed loops: circular rims always; filleted face outlines (rounded-rect)
 * kept when under TANGENT_PROP_FLOOD_MAX. Untagged open chains (loft generators
 * / post-fillet rails the small-face test dropped) kept when the simplified
 * polyline is a spine.
 *
 * Mobile C.4: tagged (#46) and untagged sharp pools are traced separately so
 * post-fillet rounded rails are not glued to residual sharp edges and refused.
 *
 * @param {object[]} featureEdges
 * @param {{ minDeg?: number }} [opts]
 * @returns {object[]}
 */
export function buildCoherentEdges(featureEdges, opts = {}) {
  const minDeg = typeof opts.minDeg === 'number' ? opts.minDeg : 15;
  const sharp = [];
  for (const e of featureEdges || []) {
    if (!e?.va || !e?.vb || !e?.tangent) continue;
    if (edgeDihedralDeg(e) + 1e-9 < minDeg) continue;
    sharp.push(e);
  }
  if (!sharp.length) return [];
  // Mobile C.4: process tagged (#46 boundary) and untagged sharp edges in
  // separate graphs. Post-fillet rounded rails (large face ↔ blend facet) lose
  // boundaryId under BOUNDARY_SMALL_FACE_FRAC (minFaceArea of the blend facet)
  // and share vertices with residual sharp cube edges. Tracing them together
  // glues rail+sharp into a wandering chain the spine test refuses — so the
  // rail never becomes pickable and Tangent-on never starts. Untagged alone
  // forms clean open arcs (quarter-circle rails) / closed rims that pass.
  const taggedSharp = sharp.filter((e) => Number.isFinite(e.boundaryId));
  const untaggedSharp = sharp.filter((e) => !Number.isFinite(e.boundaryId));
  const out = [];
  let chainSeq = 0;
  const consumedIds = new Set();
  const noteIds = (chain) => {
    for (const e of chain) {
      if (Number.isFinite(e.boundaryId)) consumedIds.add(e.boundaryId);
      const sources = e._sources;
      if (!sources) continue;
      for (const src of sources) {
        if (Number.isFinite(src.boundaryId)) consumedIds.add(src.boundaryId);
      }
    }
  };
  const emitChainSegs = (chain, segs, boundaryId) => {
    const id = chainSeq;
    chainSeq += 1;
    const faceA = _uniqueFinite(chain, 'faceA');
    const faceB = _uniqueFinite(chain, 'faceB');
    const pairCount = _uniqueFinite(chain, 'pairCount');
    const bodyId = _uniqueFinite(chain, 'bodyId');
    segs.forEach((seg, i) => {
      // C3: nearest-source normals (not a single first-hit stamp).
      let best = null;
      let bestD = Infinity;
      for (const src of chain) {
        if (!src?.n0 || !src?.n1 || !src.mid) continue;
        const d = _dist3(seg.mid, src.mid);
        if (d < bestD) {
          bestD = d;
          best = src;
        }
      }
      const n0 = best?.n0 || chain.find((e) => e.n0)?.n0;
      const n1 = best?.n1 || chain.find((e) => e.n1)?.n1;
      out.push({
        ...seg,
        key: `coh-${id}-${i}`,
        chainId: id,
        boundaryId,
        faceA,
        faceB,
        pairCount,
        bodyId,
        n0: n0 ? n0.slice() : undefined,
        n1: n1 ? n1.slice() : undefined,
      });
    });
  };
  const emitFromPool = (pool) => {
    if (!pool.length) return;
    const merged = mergeCollinearEdges(pool);
    const chains = _traceChains(merged);
    for (const chain of chains) {
      const ordered = _orderChain(chain);
      if (!ordered || ordered.pts.length < 2) continue;
      const keep = _simplifyPolyline(ordered.pts, ordered.closed);
      if (!keep) continue;
      const segs = _segmentsFromKeep(ordered, keep);
      if (!segs.length) continue;
      const boundaryId = _uniqueFinite(chain, 'boundaryId');
      const tagged = Number.isFinite(boundaryId);
      const roundRim = ordered.closed && _radialCv(ordered.pts) <= RIM_RADIAL_CV;
      // Mobile C.2: closed circular rims may keep more RDP points on large radii;
      // allow up to TANGENT_PROP_FLOOD_MAX so 64-seg defaults are not dropped.
      const maxSegs = roundRim ? TANGENT_PROP_FLOOD_MAX : COHERENT_EDGE_MAX;
      if (segs.length > maxSegs) continue;
      if (!tagged) {
        if (ordered.closed) {
          // Circular rims always keep. Filleted face outlines (rounded-rect) are
          // closed but not circular — previously dropped, which left only
          // leftover per-side fragments so Tangent-on selected 1–3 segs of a
          // roundedBox rim (Artur mobile CAD after #77). Keep them when they
          // simplify under the flood cap (same budget as circular rims).
          if (!roundRim && segs.length > TANGENT_PROP_FLOOD_MAX) continue;
        } else {
          // Open recovery (loft generator / post-fillet rails the small-face
          // test dropped) must be a spine. Blend outlines wander across a
          // whole face and are refused.
          const a = ordered.pts[0];
          const b = ordered.pts[ordered.pts.length - 1];
          const chord = _dist3(a, b);
          let dev = 0;
          for (let i = 1; i < ordered.pts.length - 1; i++) {
            dev = Math.max(dev, _pointSegDist(ordered.pts[i], a, b));
          }
          if (dev > Math.max(1.25, 0.3 * chord)) continue;
        }
      }
      noteIds(chain);
      emitChainSegs(chain, segs, boundaryId);
    }
  };
  emitFromPool(taggedSharp);
  emitFromPool(untaggedSharp);
  // #46 edges must survive even when a tangent walk dragged them into a
  // chain that was refused as a blend outline.
  const leftover = new Map();
  for (const e of sharp) {
    if (!Number.isFinite(e.boundaryId) || consumedIds.has(e.boundaryId)) continue;
    if (!leftover.has(e.boundaryId)) leftover.set(e.boundaryId, []);
    leftover.get(e.boundaryId).push(e);
  }
  for (const group of leftover.values()) {
    const merged = mergeCollinearEdges(group);
    const pieces = _traceChains(merged);
    for (const chain of pieces) {
      const ordered = _orderChain(chain);
      if (!ordered) continue;
      const keep = _simplifyPolyline(ordered.pts, ordered.closed);
      if (!keep) continue;
      const segs = _segmentsFromKeep(ordered, keep);
      if (!segs.length || segs.length > COHERENT_EDGE_MAX) continue;
      const boundaryId = _uniqueFinite(chain, 'boundaryId');
      emitChainSegs(chain, segs, boundaryId);
    }
  }
  return out;
}

export function toggleEdgeSelectionPropagated(selected, edge, opts = {}) {
  const list = Array.isArray(selected) ? [...selected] : [];
  const idx = list.findIndex((e) => sameSelectedEdge(e, edge));
  if (idx >= 0) {
    list.splice(idx, 1);
    return list;
  }
  const propagate = opts.propagate !== false;
  let toAdd = null;
  let refuseFlood = false;
  // Mobile C.3: UNION chainId fragment + G1 walk. chainId alone is often just
  // one RDP-simplified side of a rounded-box rim (3 segs); G1 + spatial
  // bridging continues around collapsed fillet corners onto neighboring
  // chainIds. Skipping the walk after a chainId hit was Artur's "1/3 selected
  // with Tangent on" mobile CAD bug after #77.
  if (propagate && Number.isFinite(edge?.chainId) && opts.featureEdges?.length) {
    const chain = opts.featureEdges.filter((e) => e.chainId === edge.chainId);
    if (chain.length > TANGENT_PROP_FLOOD_MAX) {
      refuseFlood = true;
    } else if (chain.length > 1) {
      toAdd = chain;
    }
  }
  if (!refuseFlood && propagate && opts.featureEdges?.length) {
    const walked = propagateTangentEdges(opts.featureEdges, edge, {
      tolDeg: opts.tolDeg,
      skipNormals: opts.skipNormals,
    });
    if (walked.length > TANGENT_PROP_FLOOD_MAX) {
      // Tessellation flood — keep chainId fragment if we have one, else seed.
      if (!toAdd) toAdd = null;
    } else if (walked.length > 1) {
      if (!toAdd || toAdd.length <= 1) {
        toAdd = walked;
      } else {
        const have = new Set(toAdd.map((e) => edgeKey(e)));
        const merged = toAdd.slice();
        for (const e of walked) {
          const k = edgeKey(e);
          if (have.has(k)) continue;
          merged.push(e);
          have.add(k);
        }
        toAdd = merged;
      }
    }
  }
  if (!toAdd || toAdd.length <= 1) {
    // Soft-fail: no tangents — just the seed (same as toggleEdgeSelection add).
    return toggleEdgeSelection(list, edge);
  }
  if (toAdd.length > TANGENT_PROP_FLOOD_MAX) {
    return toggleEdgeSelection(list, edge);
  }
  // Dedupe against picks on this edge's part only. Another part's "0-1" is
  // a different edge and stays selected.
  const have = new Set(list.map((e) => selectionEdgeKey(e)));
  const untagged = new Set(list.filter((e) => e.partId == null || e.partId === '').map((e) => edgeKey(e)));
  for (const e of toAdd) {
    const k = edgeKey(e);
    const sk = selectionEdgeKey(e);
    if (have.has(sk) || untagged.has(k)) continue;
    list.push(copyPickEdge(e, k));
    have.add(sk);
  }
  return list;
}
