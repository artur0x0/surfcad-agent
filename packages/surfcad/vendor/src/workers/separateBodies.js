/**
 * Separate bodies (Merge bodies toggle).
 *
 * `part.add(solid, { merge: false })` keeps `solid` as its own body in the
 * part: Manifold.compose, no boolean. decompose() splits it back out, the
 * viewer's meshBodyComponents sees two components, and booleanBodies() can
 * still fuse them later. Bare `part.add(solid)` (and `{ merge: true }`) is
 * the plain union it always was.
 *
 * Composed bodies may overlap. Manifold's own boolean on such a solid fuses
 * the overlapping bodies wherever the other operand reaches their overlap
 * (a Subtract through the overlap returned one body). So when the receiver
 * has bodies whose boxes overlap, add / subtract / intersect run per body:
 *   - subtract / intersect: each body the tool's box reaches is cut alone;
 *     the rest are kept as they are; the pieces are composed again.
 *   - add (merge on): the tool unions with every body it actually joins
 *     (raw union of that body + tool collapses to fewer components). Bodies
 *     it does not touch stay separate. No touched body → the tool becomes a
 *     body of its own, the same as a disjoint union does today.
 * A receiver that is one body, or whose bodies do not overlap, takes the
 * original method untouched, so every single-body script is bit-identical.
 *
 * Installed once on the embind prototype (Manifold.prototype is a wrapper).
 */

const OVERLAP_EPS = 1e-6;

function del(m) {
  if (!m) return;
  try { if (typeof m.delete === 'function') m.delete(); } catch (_) { /* freed */ }
}

function boxOf(m) {
  const b = m.boundingBox();
  return { min: [...b.min], max: [...b.max] };
}

/** Boxes share a positive volume (a touching cut plane is not an overlap). */
export function boxesOverlap(a, b, eps = OVERLAP_EPS) {
  for (let k = 0; k < 3; k++) {
    const lo = Math.max(a.min[k], b.min[k]);
    const hi = Math.min(a.max[k], b.max[k]);
    if (!(hi - lo > eps)) return false;
  }
  return true;
}

/** Boxes meet (contact counts: an Extrude sitting on a face must merge). */
function boxesMeet(a, b, eps = 1e-5) {
  for (let k = 0; k < 3; k++) {
    if (a.min[k] > b.max[k] + eps || b.min[k] > a.max[k] + eps) return false;
  }
  return true;
}

function componentCount(m) {
  let parts = null;
  try { parts = m.decompose(); } catch (_) { return 1; }
  const n = Array.isArray(parts) ? parts.length : 1;
  if (Array.isArray(parts)) for (const p of parts) if (p !== m) del(p);
  return n;
}

/**
 * Bodies of `m` when at least two of them overlap; otherwise null (and the
 * decompose copies are freed).
 */
export function overlappingBodies(m) {
  if (!m || typeof m.decompose !== 'function') return null;
  let parts = null;
  try { parts = m.decompose(); } catch (_) { return null; }
  if (!Array.isArray(parts) || parts.length < 2) {
    if (Array.isArray(parts)) for (const p of parts) if (p !== m) del(p);
    return null;
  }
  const boxes = parts.map(boxOf);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i], boxes[j])) return { bodies: parts, boxes };
    }
  }
  for (const p of parts) del(p);
  return null;
}

export function installSeparateBodies(module) {
  const { Manifold } = module;
  const probe = Manifold.cube([1, 1, 1]);
  const proto = Object.getPrototypeOf(probe);
  del(probe);
  if (!proto || proto.__separateBodies) return;
  const rawAdd = proto.add;
  const rawSubtract = proto.subtract;
  const rawIntersect = proto.intersect;
  const isSolid = (o) => o && typeof o === 'object' && typeof o.decompose === 'function';

  const perBodyCut = (self, other, raw) => {
    if (!isSolid(other)) return raw.call(self, other);
    const split = overlappingBodies(self);
    if (!split) return raw.call(self, other);
    const toolBox = boxOf(other);
    const kept = [];
    const intersect = raw === rawIntersect;
    for (let i = 0; i < split.bodies.length; i++) {
      const body = split.bodies[i];
      if (!boxesMeet(split.boxes[i], toolBox)) {
        if (intersect) del(body);
        else kept.push(body);
        continue;
      }
      const out = raw.call(body, other);
      del(body);
      if (out.isEmpty()) del(out);
      else kept.push(out);
    }
    if (!kept.length) return raw.call(self, other);
    if (kept.length === 1) return kept[0];
    const res = Manifold.compose(kept);
    for (const k of kept) del(k);
    return res;
  };

  const mergeAdd = (self, other) => {
    const split = overlappingBodies(self);
    if (!split) return rawAdd.call(self, other);
    const toolBox = boxOf(other);
    const toolParts = componentCount(other);
    const touched = [];
    const untouched = [];
    let single = null;
    for (let i = 0; i < split.bodies.length; i++) {
      const body = split.bodies[i];
      if (!boxesMeet(split.boxes[i], toolBox)) {
        untouched.push(body);
        continue;
      }
      const u = rawAdd.call(body, other);
      if (componentCount(u) < 1 + toolParts) {
        touched.push(body);
        if (touched.length === 1) single = u;
        else del(u);
      } else {
        del(u);
        untouched.push(body);
      }
    }
    let joined;
    if (!touched.length) {
      joined = other;
    } else if (touched.length === 1) {
      joined = single;
      del(touched[0]);
    } else {
      del(single);
      joined = Manifold.union([...touched, other]);
      for (const t of touched) del(t);
    }
    const res = Manifold.compose([joined, ...untouched]);
    for (const b of untouched) del(b);
    if (joined !== other) del(joined);
    return res;
  };

  proto.add = function add(other, opts) {
    if (opts && typeof opts === 'object' && opts.merge === false) {
      if (!isSolid(other)) throw new Error('add: { merge: false } needs a solid');
      return Manifold.compose([this, other]);
    }
    if (!isSolid(other)) return rawAdd.call(this, other);
    return mergeAdd(this, other);
  };
  proto.subtract = function subtract(other) {
    return perBodyCut(this, other, rawSubtract);
  };
  proto.intersect = function intersect(other) {
    return perBodyCut(this, other, rawIntersect);
  };
  Object.defineProperty(proto, '__separateBodies', { value: true });
}
