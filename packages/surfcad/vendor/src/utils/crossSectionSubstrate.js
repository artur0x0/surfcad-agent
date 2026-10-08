/**
 * Slice 21 — Cross-section substrate (plane + 2D profile).
 *
 * Pure helpers shared by palette preview, goldens, and docs examples.
 * Script-facing builders live in sandboxWorker (makeCrossSection / profile*).
 *
 * Value shape (plain object, no class inheritance):
 *   {
 *     kind: 'crossSection',
 *     plane: { center, normal, x, y },  // workplaneFromFace frame
 *     profile: { type: 'circle'|'rectangle'|'polygon', ... },
 *     contours: number[][][],           // [[u,v], ...] outer (+ holes later)
 *   }
 *
 * NOT the cutting-plane UI in CrossSectionPanel / utils/crossSection.js.
 */

/** @typedef {{ center: number[], normal: number[], x: number[], y: number[] }} PlaneFrame */
/** @typedef {{ type: string, [k: string]: any }} ProfileDesc */

function _len(v) {
  return Math.hypot(v[0], v[1], v[2]) || 1;
}
function _n(v) {
  const L = _len(v);
  return [v[0] / L, v[1] / L, v[2] / L];
}
function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _mul(s, a) {
  return [s * a[0], s * a[1], s * a[2]];
}

/**
 * Mirror of sandboxWorker workplaneFromFace axes (deterministic, axis-aligned).
 * @param {{ center: number[], normal: number[], verts?: number[][] }} face
 * @returns {PlaneFrame}
 */
export function planeFrameFromFaceData(face) {
  if (!face || !Array.isArray(face.normal) || !Array.isArray(face.center)) {
    throw new Error('planeFrameFromFaceData: face needs center + normal');
  }
  const normal = _n(face.normal.map(Number));
  const worldAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let x = null;
  let best = Infinity;
  for (const a of worldAxes) {
    const s = Math.abs(_dot(normal, a));
    if (s < best - 1e-9) {
      best = s;
      x = a;
    }
  }
  if (best > 0.9) {
    const verts = Array.isArray(face.verts) ? face.verts : [];
    const w = verts.find((v) => _len(_sub(v, face.center)) > 1e-9) || verts[0];
    if (w) {
      x = _sub(w, face.center);
      x = _sub(x, _mul(_dot(x, normal), normal));
    }
    if (!x || _len(x) < 1e-9) {
      x = Math.abs(normal[2]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    }
  }
  x = _n(x);
  const y = _n(_cross(normal, x));
  return {
    center: face.center.map(Number),
    normal,
    x,
    y,
  };
}

/**
 * Default +Z workplane when no face is selected (matches palette workplane helper).
 * @returns {PlaneFrame}
 */
export function defaultTopPlaneFrame(center = [0, 0, 0]) {
  return {
    center: center.map(Number),
    normal: [0, 0, 1],
    x: [1, 0, 0],
    y: [0, 1, 0],
  };
}

/** Contour area (signed); >0 = CCW. */
export function contourArea2D(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/**
 * Normalize a closed polyline: drop explicit close, ensure ≥3 pts, CCW outer.
 * @param {number[][]} points
 * @returns {number[][]}
 */
export function normalizeClosedPolyline(points) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('profilePolygon: need ≥ 3 points for a closed polyline');
  }
  const p = points.map((v) => [Number(v[0]), Number(v[1])]);
  if (p.some((v) => !Number.isFinite(v[0]) || !Number.isFinite(v[1]))) {
    throw new Error('profilePolygon: points must be finite [u,v]');
  }
  const f = p[0];
  const l = p[p.length - 1];
  // Drop explicit close (incl. digon length===3) so distinct-points check can fire.
  if (p.length >= 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) p.pop();
  if (p.length < 3) {
    throw new Error('profilePolygon: need ≥ 3 distinct points');
  }
  if (Math.abs(contourArea2D(p)) < 1e-12) {
    throw new Error('profilePolygon: degenerate (zero area)');
  }
  if (contourArea2D(p) < 0) p.reverse();
  return p;
}

/**
 * Circle profile contours in plane UV (centered at origin).
 * @param {number} radius
 * @param {number} [segments=32]
 * @returns {number[][][]}
 */
export function circleContours(radius, segments = 32) {
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r)) {
    throw new Error('profileCircle: radius must be > 0');
  }
  const seg = Math.max(3, Math.round(Number(segments) || 32));
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return [pts];
}

/**
 * Rectangle profile contours in plane UV.
 * @param {number} width
 * @param {number} height
 * @param {boolean} [centered=true]
 * @returns {number[][][]}
 */
export function rectangleContours(width, height, centered = true) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error('profileRectangle: width and height must be > 0');
  }
  let pts;
  if (centered) {
    const hw = w / 2;
    const hh = h / 2;
    pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  } else {
    pts = [[0, 0], [w, 0], [w, h], [0, h]];
  }
  return [pts];
}

/**
 * Regular n-gon (closed polyline) centered at origin.
 * @param {number} sides
 * @param {number} radius
 * @returns {number[][][]}
 */
export function regularPolygonContours(sides, radius) {
  const n = Math.max(3, Math.round(Number(sides) || 6));
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r)) {
    throw new Error('profilePolygon: radius must be > 0 for regular polygon');
  }
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2 - Math.PI / 2; // flat-top-ish start
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return [normalizeClosedPolyline(pts)];
}

/**
 * Quarter-circle fillet-style profile in first quadrant (u≥0,v≥0):
 * origin → (r,0) → arc to (0,r) → close. Enough for later fillet-via-sweep.
 * @param {number} radius
 * @param {number} [arcSegments=8]
 * @returns {number[][][]}
 */
export function quarterCircleFilletContours(radius, arcSegments = 8) {
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r)) {
    throw new Error('quarterCircleFilletContours: radius must be > 0');
  }
  const seg = Math.max(2, Math.round(Number(arcSegments) || 8));
  const pts = [[0, 0], [r, 0]];
  for (let i = 1; i <= seg; i++) {
    const t = (i / seg) * (Math.PI / 2);
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return [normalizeClosedPolyline(pts)];
}

/**
 * Build contours + profile descriptor from palette / modal params.
 * @param {object} params
 * @returns {{ profile: ProfileDesc, contours: number[][][] }}
 */
export function buildProfileFromParams(params = {}) {
  const type = String(params.profileType || params.type || 'circle');
  if (type === 'circle') {
    const radius = Number(params.radius);
    const segments = Math.max(3, Math.round(Number(params.segments) || 32));
    const r = Number.isFinite(radius) && radius > 0 ? radius : 5;
    return {
      profile: { type: 'circle', radius: r, segments },
      contours: circleContours(r, segments),
    };
  }
  if (type === 'rectangle') {
    const width = Number(params.width);
    const height = Number(params.height);
    const w = Number.isFinite(width) && width > 0 ? width : 20;
    const h = Number.isFinite(height) && height > 0 ? height : 12;
    const centered = params.centered !== false && params.centered !== 'false';
    return {
      profile: { type: 'rectangle', width: w, height: h, centered },
      contours: rectangleContours(w, h, centered),
    };
  }
  if (type === 'polygon') {
    const preset = String(params.polygonPreset || 'hexagon');
    const radius = Number(params.radius);
    const r = Number.isFinite(radius) && radius > 0 ? radius : 8;
    if (preset === 'quarterCircle') {
      const arc = Math.max(2, Math.round(Number(params.arcSegments) || 8));
      return {
        profile: { type: 'polygon', preset: 'quarterCircle', radius: r, arcSegments: arc },
        contours: quarterCircleFilletContours(r, arc),
      };
    }
    if (preset === 'custom' && Array.isArray(params.points)) {
      const pts = normalizeClosedPolyline(params.points);
      return {
        profile: { type: 'polygon', preset: 'custom', points: pts },
        contours: [pts],
      };
    }
    const sidesMap = { triangle: 3, square: 4, pentagon: 5, hexagon: 6 };
    const sides = sidesMap[preset] || Math.max(3, Math.round(Number(params.sides) || 6));
    return {
      profile: { type: 'polygon', preset, sides, radius: r },
      contours: regularPolygonContours(sides, r),
    };
  }
  throw new Error(`buildProfileFromParams: unknown profileType "${type}"`);
}

/**
 * Map UV contours onto a plane frame → closed world polylines (each loop closed).
 * @param {PlaneFrame} plane
 * @param {number[][][]} contours
 * @returns {number[][][]} world XYZ rings (first===last for LineLoop)
 */
export function contoursToWorldRings(plane, contours) {
  if (!plane?.center || !plane?.x || !plane?.y) {
    throw new Error('contoursToWorldRings: plane needs center/x/y');
  }
  const rings = [];
  for (const loop of contours || []) {
    if (!loop?.length) continue;
    const ring = loop.map(([u, v]) => [
      plane.center[0] + u * plane.x[0] + v * plane.y[0],
      plane.center[1] + u * plane.x[1] + v * plane.y[1],
      plane.center[2] + u * plane.x[2] + v * plane.y[2],
    ]);
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-9) {
      ring.push([a[0], a[1], a[2]]);
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Assemble a reusable cross-section value (client / golden mirror of makeCrossSection).
 * @param {PlaneFrame} plane
 * @param {ProfileDesc|object} profileOrParams
 * @returns {{ kind: string, plane: PlaneFrame, profile: ProfileDesc, contours: number[][][] }}
 */
export function assembleCrossSection(plane, profileOrParams) {
  if (!plane || !plane.center || !plane.normal || !plane.x || !plane.y) {
    throw new Error('makeCrossSection: plane must be a workplaneFromFace frame (center/normal/x/y)');
  }
  let profile;
  let contours;
  if (profileOrParams && profileOrParams.type && Array.isArray(profileOrParams.contours)) {
    profile = { ...profileOrParams };
    contours = profileOrParams.contours.map((pts) => normalizeClosedPolyline(pts));
    delete profile.contours;
  } else if (profileOrParams && Array.isArray(profileOrParams) && Array.isArray(profileOrParams[0])) {
    // bare contours or bare point list
    const raw = typeof profileOrParams[0][0] === 'number'
      ? [profileOrParams]
      : profileOrParams;
    contours = raw.map((pts) => normalizeClosedPolyline(pts));
    profile = { type: 'polygon', preset: 'custom', points: contours[0] };
  } else if (profileOrParams && profileOrParams.type === 'circle') {
    contours = circleContours(profileOrParams.radius, profileOrParams.segments);
    profile = { type: 'circle', radius: profileOrParams.radius, segments: profileOrParams.segments || 32 };
  } else if (profileOrParams && profileOrParams.type === 'rectangle') {
    contours = rectangleContours(
      profileOrParams.width,
      profileOrParams.height,
      profileOrParams.centered !== false,
    );
    profile = {
      type: 'rectangle',
      width: profileOrParams.width,
      height: profileOrParams.height,
      centered: profileOrParams.centered !== false,
    };
  } else if (profileOrParams && profileOrParams.type === 'polygon' && profileOrParams.points) {
    const pts = normalizeClosedPolyline(profileOrParams.points);
    contours = [pts];
    profile = { type: 'polygon', preset: 'custom', points: pts };
  } else {
    const built = buildProfileFromParams(profileOrParams || { profileType: 'circle', radius: 5 });
    profile = built.profile;
    contours = built.contours;
  }
  return {
    kind: 'crossSection',
    plane: {
      center: plane.center.slice(),
      normal: plane.normal.slice(),
      x: plane.x.slice(),
      y: plane.y.slice(),
    },
    profile,
    contours,
  };
}

/**
 * Preview payload for Viewport while editing params.
 * @param {object|null} faceClassification classifySelectedFace result or null
 * @param {object} params modal values
 * @returns {{ plane: PlaneFrame, rings: number[][][], profile: ProfileDesc }|null}
 */
export function buildCrossSectionPreview(faceClassification, params) {
  try {
    const plane = faceClassification && faceClassification.type === 'planar'
      ? planeFrameFromFaceData(faceClassification)
      : defaultTopPlaneFrame(
        faceClassification?.center || [0, 0, 0],
      );
    // Snap origin to face center (same as emitFaceWorkplaneLines)
    if (faceClassification?.center) {
      const pc = faceClassification.center;
      const off =
        (pc[0] - plane.center[0]) * plane.normal[0]
        + (pc[1] - plane.center[1]) * plane.normal[1]
        + (pc[2] - plane.center[2]) * plane.normal[2];
      plane.center = [
        pc[0] - off * plane.normal[0],
        pc[1] - off * plane.normal[1],
        pc[2] - off * plane.normal[2],
      ];
    }
    const { profile, contours } = buildProfileFromParams(params);
    const rings = contoursToWorldRings(plane, contours);
    return { plane, rings, profile };
  } catch {
    return null;
  }
}

export const CROSS_SECTION_REFUSE_NON_PLANAR =
  'Cross-section plane requires a planar face (single-click). '
  + 'Cylindrical / irregular faces are not supported for the plane — '
  + 'clear the selection to use the default +Z top face, or pick a flat face.';
