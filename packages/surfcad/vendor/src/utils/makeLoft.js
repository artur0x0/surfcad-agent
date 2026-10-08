/**
 * Slice 28 — makeLoft (multi-profile, same workplane + offsets).
 *
 * v1 plane model: every profile is makeCrossSection on a copy of one workplane
 * whose center is translated by `offset * normal`. Planes must be parallel.
 * Independent (non-parallel) planes are a later slice.
 *
 * Does not change the legacy loft({ topCS, bottomCS, height }) cup helper.
 */

export const MAKE_LOFT_MIN_PROFILES = 2;
export const MAKE_LOFT_RESOLUTION = 64;
/** Uniform polar samples. Vertex angles are always added on top. */
export const MAKE_LOFT_POLAR_SAMPLES = 128;
export const MAKE_LOFT_EXTRUDE_SEGS = 64;
/** Same epsilon assembleLoftStations uses for coincident stations. */
export const MAKE_LOFT_COINCIDENT_EPS = 1e-6;
/** Hard ceiling: segs ≤ k × MAKE_LOFT_EXTRUDE_SEGS. Sliver offsets must not explode WASM. */
export const MAKE_LOFT_EXTRUDE_SEGS_CAP_K = 4;

/**
 * Vertical extrude divisions for the piecewise loft warp.
 *
 * A station closer than `height / segs` gets no vertex on its plane — the
 * middle profile is skipped (disjoint / wrong slice). Inflate so the
 * tightest span still has samples (`ceil(height / minSpan) * 16`), but cap
 * at k×64. Offset `step="any"` can store 1e-6; that is the coincident
 * floor, not a license for 640M divisions.
 *
 * `minSpan` is a signed delta. Negative / zero collapse to the coincident
 * floor (same 1e-6 assembleLoftStations already uses) — no second floor.
 */
export function resolveLoftExtrudeSegs(height, minSpan, opts = {}) {
  const cap = MAKE_LOFT_EXTRUDE_SEGS_CAP_K * MAKE_LOFT_EXTRUDE_SEGS;
  const requested = Math.max(
    8,
    Math.round(Number(opts.extrudeSegments) || MAKE_LOFT_EXTRUDE_SEGS),
  );
  const h = Number(height);
  const span = Math.max(MAKE_LOFT_COINCIDENT_EPS, Number(minSpan));
  let segs = Number.isFinite(requested) ? requested : MAKE_LOFT_EXTRUDE_SEGS;
  if (Number.isFinite(h) && h > 0 && Number.isFinite(span)) {
    const inflated = Math.ceil(h / span) * 16;
    if (Number.isFinite(inflated)) segs = Math.max(segs, inflated);
  }
  if (!Number.isFinite(segs) || segs < 1) segs = MAKE_LOFT_EXTRUDE_SEGS;
  return Math.min(cap, segs);
}

function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _norm(v) {
  const L = Math.hypot(v[0], v[1], v[2]);
  if (!(L > 1e-12)) return null;
  return [v[0] / L, v[1] / L, v[2] / L];
}

function _area2(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function _normalizeLoop(points, what) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error(`${what}: need ≥ 3 points for a closed polyline`);
  }
  const p = points.map((v) => [Number(v[0]), Number(v[1])]);
  if (p.some((v) => !Number.isFinite(v[0]) || !Number.isFinite(v[1]))) {
    throw new Error(`${what}: contour points must be finite [u,v]`);
  }
  const f = p[0];
  const l = p[p.length - 1];
  if (p.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) p.pop();
  if (p.length < 3) throw new Error(`${what}: need ≥ 3 distinct points`);
  if (Math.abs(_area2(p)) < 1e-12) {
    throw new Error(`${what}: degenerate profile (zero area)`);
  }
  if (_area2(p) < 0) p.reverse();
  return p;
}

function _requirePlane(plane, what) {
  if (!plane || !plane.center || !plane.normal || !plane.x || !plane.y) {
    throw new Error(`${what}: plane must be a workplaneFromFace frame (center/normal/x/y)`);
  }
}

/**
 * Copy of a workplane translated along its normal. Shared v1 loft station.
 */
export function offsetPlaneFrame(plane, offset) {
  _requirePlane(plane, 'offsetPlaneFrame');
  const w = Number(offset);
  if (!Number.isFinite(w)) {
    throw new Error('offsetPlaneFrame: offset must be finite');
  }
  const n = plane.normal;
  return {
    center: [
      plane.center[0] + n[0] * w,
      plane.center[1] + n[1] * w,
      plane.center[2] + n[2] * w,
    ],
    normal: plane.normal.slice(),
    x: plane.x.slice(),
    y: plane.y.slice(),
  };
}

export function resampleContour(contour, n) {
  if (!Array.isArray(contour) || contour.length < 2) return contour ? contour.slice() : [];
  const count = Math.max(2, Math.round(Number(n) || 2));
  const lengths = [0];
  for (let i = 1; i < contour.length; i++) {
    const dx = contour[i][0] - contour[i - 1][0];
    const dy = contour[i][1] - contour[i - 1][1];
    lengths.push(lengths[i - 1] + Math.hypot(dx, dy));
  }
  const dxClose = contour[0][0] - contour[contour.length - 1][0];
  const dyClose = contour[0][1] - contour[contour.length - 1][1];
  lengths.push(lengths[lengths.length - 1] + Math.hypot(dxClose, dyClose));
  const total = lengths[lengths.length - 1];
  if (!(total > 1e-12)) return contour.slice(0, count);

  const resampled = [];
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    let seg = 0;
    while (seg < lengths.length - 1 && target > lengths[seg + 1]) seg++;
    const s0 = lengths[seg];
    const s1 = lengths[seg + 1];
    const frac = Math.abs(s1 - s0) < 1e-12 ? 0 : (target - s0) / (s1 - s0);
    const idx0 = seg % contour.length;
    const idx1 = (seg + 1) % contour.length;
    resampled.push([
      contour[idx0][0] + frac * (contour[idx1][0] - contour[idx0][0]),
      contour[idx0][1] + frac * (contour[idx1][1] - contour[idx0][1]),
    ]);
  }
  return resampled;
}

export function rotateContour(contour, deg) {
  if (!contour?.length) return contour;
  const rad = (Number(deg) || 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return contour.map((p) => [
    p[0] * cos - p[1] * sin,
    p[0] * sin + p[1] * cos,
  ]);
}

function _radialSpreadRatio(contour) {
  let minR = Infinity;
  let maxR = 0;
  for (const p of contour) {
    const r = Math.hypot(p[0], p[1]);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  if (!(maxR > 1e-9)) return 0;
  return (maxR - minR) / maxR;
}

/** High-resolution, almost-constant radius → circle (or a very round station). */
function _isRoundStation(contour) {
  if (!contour || contour.length < 12) return false;
  return _radialSpreadRatio(contour) < 0.02;
}

/** Angle of the outermost vertex (first one wins ties — the authored start). */
function _primaryCornerAngle(contour) {
  let bestI = 0;
  let bestR = -1;
  for (let i = 0; i < contour.length; i++) {
    const r = Math.hypot(contour[i][0], contour[i][1]);
    if (r > bestR + 1e-8) {
      bestR = r;
      bestI = i;
    }
  }
  return Math.atan2(contour[bestI][1], contour[bestI][0]);
}

/**
 * Rotate `top` onto `bottom` when both are cornered polygons (45° rect test).
 * A round station returns 0: spinning a rectangle to match a circle's
 * arc-length samples is what left the loft off-angle to the standard views.
 */
function _alignRotationDeg(bottom, top) {
  if (_isRoundStation(bottom) || _isRoundStation(top)) return 0;
  const delta = _primaryCornerAngle(bottom) - _primaryCornerAngle(top);
  let deg = delta * 180 / Math.PI;
  while (deg > 180) deg -= 360;
  while (deg < -180) deg += 360;
  return deg;
}

function _angleOf(x, y) {
  let a = Math.atan2(y, x);
  if (a < 0) a += Math.PI * 2;
  if (a >= Math.PI * 2 - 1e-12) a = 0;
  return a;
}

/**
 * Angle-indexed boundary tables. Uniform angles + arc-length sample angles
 * + exact vertex angles, ray-hit so a rectangle corner is a table entry
 * even when it falls between the other profile's samples.
 */
function _polarTables(stations, sampleN) {
  const raw = [];
  const n = Math.max(16, Math.round(sampleN));
  for (let i = 0; i < n; i++) raw.push((i / n) * Math.PI * 2);
  for (const s of stations) {
    const arc = resampleContour(s.contour, n);
    const pts = arc.concat(s.contour);
    for (const p of pts) {
      if (Math.hypot(p[0], p[1]) > 1e-8) raw.push(_angleOf(p[0], p[1]));
    }
  }
  raw.sort((a, b) => a - b);
  const angles = [];
  for (const a of raw) {
    if (!angles.length || a - angles[angles.length - 1] > 1e-4) angles.push(a);
  }
  if (angles.length > 1 && (angles[0] + Math.PI * 2) - angles[angles.length - 1] < 1e-4) {
    angles.pop();
  }
  const kept = [];
  const tables = stations.map(() => []);
  for (const a of angles) {
    const hits = stations.map((s) => _contourRayHit(s.contour, Math.cos(a), Math.sin(a)));
    if (hits.some((h) => !h)) continue;
    kept.push(a);
    hits.forEach((h, i) => tables[i].push(h));
  }
  if (kept.length < 3) {
    throw new Error('makeLoft: could not build an angle table (profiles must contain the plane origin)');
  }
  return { angles: kept, tables };
}

function _lookupPolar(table, angles, angle) {
  const n = angles.length;
  const a0 = angles[0];
  const aN = angles[n - 1];
  if (angle < a0 || angle > aN) {
    const start = aN;
    const end = a0 + Math.PI * 2;
    const span = end - start;
    let t = span > 1e-12 ? ((angle < a0 ? angle + Math.PI * 2 : angle) - start) / span : 0;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const p0 = table[n - 1];
    const p1 = table[0];
    return [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])];
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (angles[mid] <= angle) lo = mid;
    else hi = mid;
  }
  const span = angles[hi] - angles[lo];
  const t = span > 1e-12 ? (angle - angles[lo]) / span : 0;
  const p0 = table[lo];
  const p1 = table[hi];
  return [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])];
}

/**
 * Nearest forward hit of the ray from the origin along unit (dx, dy)
 * with a closed polyline. Angular parameterisation for the loft warp:
 * a vertex at angle θ maps to the boundary point at that same angle
 * (not to an arc-length sample whose index happens to equal θ/2π).
 */
function _contourRayHit(contour, dx, dy) {
  let bestT = Infinity;
  let best = null;
  const n = contour.length;
  for (let i = 0; i < n; i++) {
    const ax = contour[i][0];
    const ay = contour[i][1];
    const bx = contour[(i + 1) % n][0];
    const by = contour[(i + 1) % n][1];
    const ex = bx - ax;
    const ey = by - ay;
    const det = dx * ey - ex * dy;
    if (Math.abs(det) < 1e-14) continue;
    const u = (ax * dy - dx * ay) / det;
    const t = (ax * ey - ex * ay) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    if (!(t > 1e-14) || t >= bestT) continue;
    bestT = t;
    best = [t * dx, t * dy];
  }
  return best;
}

function _outerContour(section, what) {
  let contours = section?.contours;
  if ((!contours || !contours.length) && typeof section?.toPolygons === 'function') {
    contours = section.toPolygons();
  }
  if (!Array.isArray(contours) || !contours.length) {
    throw new Error(`${what}: section is missing contours`);
  }
  return _normalizeLoop(contours[0], what);
}

/**
 * Normalize makeCrossSection (or { plane, contours, offset }) values into
 * ordered loft stations. Loud-fail on <2, non-parallel planes, coincident
 * offsets, or degenerate contours.
 *
 * @returns {{ ok: true, stations: object[] } | { ok: false, message: string }}
 */
export function assembleLoftStations(sections) {
  try {
    if (!Array.isArray(sections) || sections.length < MAKE_LOFT_MIN_PROFILES) {
      return { ok: false, message: 'makeLoft: need at least 2 profiles' };
    }
    const raw = [];
    let baseNormal = null;
    let basePlane = null;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const what = `makeLoft: profile ${i + 1}`;
      if (!s || typeof s !== 'object') {
        return { ok: false, message: `${what}: expected a makeCrossSection value` };
      }
      const plane = s.plane;
      _requirePlane(plane, what);
      const n = _norm(plane.normal);
      if (!n) return { ok: false, message: `${what}: plane normal is degenerate` };
      if (!baseNormal) {
        baseNormal = n;
        basePlane = plane;
      } else if (Math.abs(_dot(n, baseNormal)) < 0.99) {
        return {
          ok: false,
          message:
            'makeLoft: v1 requires parallel profile planes (same workplane + offsets)',
        };
      }
      const contour = _outerContour(s, what);
      const offset = Number.isFinite(Number(s.offset))
        ? Number(s.offset)
        : _dot(_sub(plane.center, basePlane.center), baseNormal);
      if (!Number.isFinite(offset)) {
        return { ok: false, message: `${what}: offset must be finite` };
      }
      raw.push({
        index: i,
        plane,
        contour,
        offset,
        normal: n,
      });
    }
    const stations = raw.slice().sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < stations.length; i++) {
      if (Math.abs(stations[i].offset - stations[i - 1].offset) < MAKE_LOFT_COINCIDENT_EPS) {
        return {
          ok: false,
          message:
            'makeLoft: profiles share the same station offset — would be a zero-height loft',
        };
      }
    }
    return { ok: true, stations, plane: stations[0].plane };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
}

/**
 * Rotate each station to match the previous (already aligned) contour.
 * Pairwise loft used to align each span independently, so the middle
 * station was the rotated top of span i and the unrotated bottom of
 * span i+1 — a visible disjoint. One chain keeps a single contour per
 * station. `opts.align === false` leaves contours as authored (preview
 * and Confirm stay in lockstep).
 */
export function alignStationContours(stations, opts = {}) {
  const resolution = Math.max(16, Math.round(Number(opts.resolution) || MAKE_LOFT_RESOLUTION));
  const out = [];
  for (let i = 0; i < stations.length; i++) {
    const src = stations[i];
    let contour = src.contour;
    if (opts.align !== false && i > 0) {
      const prev = out[i - 1].contour;
      const rot = _alignRotationDeg(
        resampleContour(prev, resolution),
        resampleContour(contour, resolution),
      );
      contour = rotateContour(contour, rot);
    }
    out.push({ ...src, contour });
  }
  return out;
}

function _spanIndex(stations, zWorld) {
  let i = 0;
  while (i < stations.length - 2 && zWorld >= stations[i + 1].offset) i += 1;
  return i;
}

/**
 * Build a loft solid from ≥2 makeCrossSection values (or {plane,contours,offset}).
 * Result is local to the shared workplane: XY = station UV, Z along the shared
 * normal, z=0 at the lowest-offset station. Confirm places it with
 * `placeInFrame(frame, makeLoft(sections), [0, 0, minOffset])`.
 *
 * One extrusion + piecewise polar warp through every station (not pairwise
 * boolean-union). Middle stations stay on the loft path.
 *
 * Mapping (Solo Cup / legacy loft spirit): arc-length resample each station,
 * union those sample angles with every profile vertex angle, and warp an
 * angle-indexed ray-hit table. The old per-vertex ray hit only moved the
 * extruded mesh's native samples, so a circle's chords bit into rectangle
 * corners that fell between those angles. Vertex angles are in the table,
 * so corners stay sharp. A nearly circular station is not used to spin the
 * other profile — that rotation was the off-angle circle↔rect default.
 */
export function buildMakeLoftSolid(Manifold, CrossSection, sections, opts = {}) {
  const assembled = assembleLoftStations(sections);
  if (!assembled.ok) throw new Error(assembled.message);
  const stations = alignStationContours(assembled.stations, opts);
  const z0 = stations[0].offset;
  const zN = stations[stations.length - 1].offset;
  const height = zN - z0;
  if (!(height > 1e-9) || !Number.isFinite(height)) {
    throw new Error('makeLoft: station spacing must be > 0');
  }
  let minSpan = height;
  for (let i = 1; i < stations.length; i++) {
    minSpan = Math.min(
      minSpan,
      Math.max(MAKE_LOFT_COINCIDENT_EPS, stations[i].offset - stations[i - 1].offset),
    );
  }
  const segs = resolveLoftExtrudeSegs(height, minSpan, opts);
  const requested = Math.round(Number(opts.resolution) || MAKE_LOFT_RESOLUTION);
  const polarN = Math.max(
    MAKE_LOFT_POLAR_SAMPLES,
    Math.min(256, Number.isFinite(requested) ? requested : MAKE_LOFT_POLAR_SAMPLES),
  );
  const { angles, tables } = _polarTables(stations, polarN);
  const bottom = tables[0];
  const bottomCS = new CrossSection([bottom]);
  const straight = Manifold.extrude
    ? Manifold.extrude(bottomCS, height, segs)
    : bottomCS.extrude(height, segs);
  const warp = (v) => {
    const x = v[0];
    const y = v[1];
    const z = v[2];
    const rOrig = Math.hypot(x, y);
    if (rOrig < 1e-8) {
      v[0] = 0;
      v[1] = 0;
      return;
    }
    const zWorld = z0 + z;
    const i = _spanIndex(stations, zWorld);
    const a = stations[i];
    const b = stations[i + 1];
    const span = b.offset - a.offset;
    let t = span > 1e-12 ? (zWorld - a.offset) / span : 1;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const angle = _angleOf(x, y);
    const hitA = _lookupPolar(tables[i], angles, angle);
    const hitB = _lookupPolar(tables[i + 1], angles, angle);
    const hitBase = _lookupPolar(tables[0], angles, angle);
    const rBottom = Math.hypot(hitBase[0], hitBase[1]);
    const scale = rBottom > 1e-9 ? rOrig / rBottom : 1;
    const tx = hitA[0] + t * (hitB[0] - hitA[0]);
    const ty = hitA[1] + t * (hitB[1] - hitA[1]);
    v[0] = tx * scale;
    v[1] = ty * scale;
  };
  const out = straight.warp(warp);
  const vol = typeof out.volume === 'function' ? out.volume() : 0;
  if (!(vol > 1e-9)) {
    throw new Error('makeLoft: result is EMPTY (volume 0) — check profiles have area and distinct offsets');
  }
  return out;
}

/**
 * Shared polar angles for the preview rings: `n` uniform angles plus every
 * station's exact vertex angles, deduped. Same idea as `_polarTables`, but
 * without the arc-length sample angles — preview only needs enough rungs to
 * read, and corners must land on a table entry so a square stays square.
 */
function _previewRingAngles(stations, sampleN) {
  const n = Math.max(8, Math.round(Number(sampleN) || 32));
  const raw = [];
  for (let i = 0; i < n; i++) raw.push((i / n) * Math.PI * 2);
  for (const s of stations) {
    for (const p of s.contour) {
      if (Math.hypot(p[0], p[1]) > 1e-8) raw.push(_angleOf(p[0], p[1]));
    }
  }
  raw.sort((a, b) => a - b);
  const angles = [];
  for (const a of raw) {
    if (!angles.length || a - angles[angles.length - 1] > 1e-4) angles.push(a);
  }
  if (angles.length > 1 && (angles[0] + Math.PI * 2) - angles[angles.length - 1] < 1e-4) {
    angles.pop();
  }
  return angles;
}

/**
 * Client / golden preview payload: UV rings + world frames.
 * Rings use the same aligned contours as makeLoft so preview ≈ Accept.
 * Null when <2 valid stations (incomplete polyline, bad offset, …).
 *
 * Rings are sampled by **shared polar angle**, not per-station arc length:
 * the solid's warp maps a boundary point to the point at the same angle on
 * the next station, so index-matched arc-length rings drew rungs that paired
 * (say) a circle's 0° sample with a square's 225° corner — a preview that
 * twisted like an hourglass while Accept built the correct part. Ray-hitting
 * one shared angle list keeps ring[i] at the same angle on every station.
 * A station the origin ray misses (origin outside the profile) falls back to
 * arc-length rings rather than dropping the preview.
 */
export function buildLoftPreviewStations(sections, sampleN = 32, opts = {}) {
  const assembled = assembleLoftStations(sections);
  if (!assembled.ok) return null;
  const aligned = alignStationContours(assembled.stations, opts);
  const n = Math.max(8, Math.round(Number(sampleN) || 32));
  const angles = _previewRingAngles(aligned, n);
  const rings = aligned.map((s) => {
    const ring = [];
    for (const a of angles) {
      const hit = _contourRayHit(s.contour, Math.cos(a), Math.sin(a));
      if (!hit) return null;
      ring.push(hit);
    }
    return ring.length >= 3 ? ring : null;
  });
  const polarOk = rings.every((r) => r);
  return {
    plane: assembled.stations[0].plane,
    stations: aligned.map((s, i) => ({
      offset: s.offset,
      plane: s.plane,
      ring: polarOk ? rings[i] : resampleContour(s.contour, n),
      contour: s.contour,
    })),
  };
}
