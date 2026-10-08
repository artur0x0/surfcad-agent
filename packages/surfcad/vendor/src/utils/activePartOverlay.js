/**
 * Pick highlights and tool previews in a multi-part viewport.
 *
 * Edge and face graphs are stored in the active part's local frame. The
 * assembly translation lives on the mesh, not in those points. Painting the
 * local points in the scene puts them on whichever other part occupies the
 * origin. A vertex-index key is also not an identity across parts: both
 * solids have an edge "0-1".
 */
import { pickNearestEdge } from './selectEdge.js';

/** [x, y, z] assembly translation. Missing or non-finite components are 0. */
export function activePartTranslation(position) {
  if (!position) return [0, 0, 0];
  const x = Number(position[0]);
  const y = Number(position[1]);
  const z = Number(position[2]);
  return [
    Number.isFinite(x) ? x : 0,
    Number.isFinite(y) ? y : 0,
    Number.isFinite(z) ? z : 0,
  ];
}

export function shiftLocalPoint(point, position) {
  if (!point) return point;
  const [x, y, z] = activePartTranslation(position);
  return [point[0] + x, point[1] + y, point[2] + z];
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Same geometric segment, either direction.
 * A shared vertex index is not enough: the other solid has those indices too.
 */
export function sameLocalSegment(a, b, eps = 0.2) {
  if (!a?.va || !a?.vb || !b?.va || !b?.vb) return false;
  const direct = dist3(a.va, b.va) <= eps && dist3(a.vb, b.vb) <= eps;
  const flip = dist3(a.va, b.vb) <= eps && dist3(a.vb, b.va) <= eps;
  return direct || flip;
}

function overlaySamples(edge) {
  if (Array.isArray(edge?.pts) && edge.pts.length >= 2) return edge.pts;
  if (edge?.va && edge?.vb) return [edge.va, edge.vb];
  return [];
}

/**
 * World-space samples for an edge highlight or a tool preview.
 *
 * A graph still keyed to another part is not painted. Its local points would
 * land on that part. Points that do belong to the active part are shifted by
 * its assembly translation.
 *
 * @param {{ edges?: object[]|null, sourceId?: string|null, activeId?: string|null, position?: number[]|null }} args
 * @returns {{ partId: string|null, points: number[][], foreign: boolean }}
 */
export function resolveActivePartOverlay({
  edges = null,
  sourceId = null,
  activeId = null,
  position = null,
} = {}) {
  const list = Array.isArray(edges) ? edges.filter(Boolean) : [];
  const ids = new Set();
  if (sourceId != null && sourceId !== '') ids.add(String(sourceId));
  for (const edge of list) {
    if (edge.partId != null && edge.partId !== '') ids.add(String(edge.partId));
  }
  const active = activeId == null || activeId === '' ? null : String(activeId);
  const foreign = !!(active && [...ids].some((id) => id !== active));
  if (foreign) return { partId: null, points: [], foreign: true };
  const points = [];
  for (const edge of list) {
    for (const p of overlaySamples(edge)) {
      if (!p || p.length < 3) continue;
      points.push(shiftLocalPoint(p, position));
    }
  }
  const partId = active || (sourceId != null && sourceId !== '' ? String(sourceId) : null)
    || (list[0]?.partId != null ? String(list[0].partId) : null);
  return { partId, points, foreign: false };
}

function shiftEdge(edge, position) {
  return {
    ...edge,
    va: shiftLocalPoint(edge.va, position),
    vb: shiftLocalPoint(edge.vb, position),
    mid: edge.mid ? shiftLocalPoint(edge.mid, position) : edge.mid,
  };
}

/**
 * Pick one edge of the active solid. Other visible solids are not candidates,
 * including when a vertex-index key exists on both meshes.
 *
 * @param {{ id: string, edges?: object[], position?: number[]|null }[]} solids
 * @param {string|null} activeId
 * @param {number[]|null} worldPoint
 * @param {number} [maxDist]
 * @returns {{ partId: string, edge: object, points: number[][] }|null}
 */
export function pickActivePartEdge(solids, activeId, worldPoint, maxDist = 1) {
  if (activeId == null || activeId === '' || !worldPoint) return null;
  const active = (solids || []).find((solid) => solid && String(solid.id) === String(activeId));
  if (!active) return null;
  const local = Array.isArray(active.edges) ? active.edges : [];
  const worldEdges = local.map((edge) => shiftEdge(edge, active.position));
  const hit = pickNearestEdge(worldEdges, worldPoint, maxDist);
  if (!hit) return null;
  const edge = local.find((candidate) => candidate.key === hit.key);
  if (!edge) return null;
  const overlay = resolveActivePartOverlay({
    edges: [{ ...edge, partId: active.id }],
    sourceId: active.id,
    activeId: active.id,
    position: active.position,
  });
  return { partId: String(active.id), edge, points: overlay.points };
}

/**
 * Move an overlay object onto the active part. `position` is the part
 * translation. Local child coordinates stay in the part frame.
 * @param {object|null} obj three.js object (position + userData)
 * @param {number[]|null} position
 */
export function applyActivePartAnchor(obj, position) {
  if (!obj?.position?.set) return obj;
  const [x, y, z] = activePartTranslation(position);
  obj.position.set(x, y, z);
  if (!obj.userData) obj.userData = {};
  obj.userData.anchorToActivePart = true;
  return obj;
}
