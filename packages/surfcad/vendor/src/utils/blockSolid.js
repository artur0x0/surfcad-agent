/**
 * Block solids: cube, rounded box, cylinder, sphere, tube, hex prism.
 *
 * The helper sheet and the viewport preview share this spec. Pose is
 * rotate-then-translate about the origin, in degrees, matching
 * Manifold.rotate / Manifold.translate. An identity pose is left off the
 * script so a pop that does not move the solid still emits the old line.
 */

export const BLOCK_SOLID_IDS = Object.freeze([
  'cube',
  'roundedBox',
  'cylinder',
  'sphere',
  'tube',
  'hexPrism',
]);

export const BLOCK_POSE_PARAMS = Object.freeze([
  { name: 'x', type: 'number', default: 0, label: 'Pos X', min: -500, max: 500, step: 1 },
  { name: 'y', type: 'number', default: 0, label: 'Pos Y', min: -500, max: 500, step: 1 },
  { name: 'z', type: 'number', default: 0, label: 'Pos Z', min: -500, max: 500, step: 1 },
  { name: 'rx', type: 'number', default: 0, label: 'Rot X', min: -360, max: 360, step: 1 },
  { name: 'ry', type: 'number', default: 0, label: 'Rot Y', min: -360, max: 360, step: 1 },
  { name: 'rz', type: 'number', default: 0, label: 'Rot Z', min: -360, max: 360, step: 1 },
]);

export function isBlockSolidId(id) {
  return BLOCK_SOLID_IDS.includes(id);
}

/** A typed number still in progress (`-`, `.`). Preview keeps the last solid. */
export function blockParamsPending(params) {
  if (!params || typeof params !== 'object') return false;
  for (const v of Object.values(params)) {
    if (v === '' || v === '-' || v === '.' || v === '-.') return true;
  }
  return false;
}

function num(v, fallback) {
  if (v === '' || v === null || v === undefined || v === '-' || v === '.') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

function sectionOf(v) {
  if (v == null || v === '') return 'round';
  return String(v) === 'rect' ? 'rect' : 'round';
}

function blockCombine(value) {
  const raw = value && typeof value === 'object' ? value.combine : value;
  const v = String(raw ?? 'add').toLowerCase();
  return v === 'subtract' || v === 'cut' ? 'subtract' : 'add';
}

function poseOf(p) {
  return {
    x: num(p?.x, 0),
    y: num(p?.y, 0),
    z: num(p?.z, 0),
    rx: num(p?.rx, 0),
    ry: num(p?.ry, 0),
    rz: num(p?.rz, 0),
  };
}

/**
 * Canonical size + pose for one Block pop.
 * @param {string} id
 * @param {object|null} params
 */
export function blockSpec(id, params) {
  const p = params && typeof params === 'object' ? params : {};
  const pose = poseOf(p);
  const combine = blockCombine(p);
  switch (id) {
    case 'cube':
      return {
        id,
        ...pose,
        combine,
        width: num(p.width, 40),
        depth: num(p.depth, 30),
        height: num(p.height, 20),
        center: bool(p.center, true),
      };
    case 'roundedBox':
      return {
        id,
        ...pose,
        combine,
        sx: num(p.sx, 50),
        sy: num(p.sy, 30),
        sz: num(p.sz, 20),
        edgeRadius: num(p.edgeRadius, 4),
        segments: Math.max(1, Math.round(num(p.segments, 16))),
      };
    case 'cylinder':
      return {
        id,
        ...pose,
        combine,
        height: num(p.height, 20),
        radius: num(p.radius, 10),
        segments: Math.max(3, Math.round(num(p.segments, 64))),
      };
    case 'sphere':
      return {
        id,
        ...pose,
        combine,
        radius: num(p.radius, 15),
        segments: Math.max(3, Math.round(num(p.segments, 64))),
      };
    case 'tube': {
      const section = sectionOf(p.section);
      const height = num(p.height, 40);
      if (section === 'rect') {
        return {
          id,
          ...pose,
          combine,
          section,
          height,
          width: num(p.width, 40),
          depth: num(p.depth, 20),
          wall: num(p.wall, 2.5),
          cornerRadius: num(p.cornerRadius, 0),
        };
      }
      return {
        id,
        ...pose,
        combine,
        section,
        height,
        outerRadius: num(p.outerRadius, 15),
        innerRadius: num(p.innerRadius, 10),
        segments: Math.max(3, Math.round(num(p.segments, 64))),
      };
    }
    case 'hexPrism':
      return {
        id,
        ...pose,
        combine,
        radius: num(p.radius, 12),
        height: num(p.height, 8),
      };
    default:
      throw new Error(`Unknown block solid: ${id}`);
  }
}

/** Stable key for the mesh. Mode is not part of it — Add and Subtract share a solid. */
export function blockGeomKey(spec) {
  const copy = { ...spec };
  delete copy.combine;
  return JSON.stringify(copy);
}

function lit(n) {
  if (typeof n === 'boolean') return n ? 'true' : 'false';
  if (!Number.isFinite(n) || Object.is(n, -0)) return '0';
  return String(n);
}

function applyPoseExpr(expr, spec) {
  let out = expr;
  if (spec.rx || spec.ry || spec.rz) {
    out = `${out}.rotate([${lit(spec.rx)}, ${lit(spec.ry)}, ${lit(spec.rz)}])`;
  }
  if (spec.x || spec.y || spec.z) {
    out = `${out}.translate([${lit(spec.x)}, ${lit(spec.y)}, ${lit(spec.z)}])`;
  }
  return out;
}

/** Right-hand side of the `let` the pop writes. */
export function blockSolidExpression(spec) {
  let expr;
  switch (spec.id) {
    case 'cube':
      expr = `Manifold.cube([${lit(spec.width)}, ${lit(spec.depth)}, ${lit(spec.height)}], ${lit(spec.center)})`;
      break;
    case 'roundedBox':
      expr = `roundedBox([${lit(spec.sx)}, ${lit(spec.sy)}, ${lit(spec.sz)}], ${lit(spec.edgeRadius)}, ${lit(spec.segments)})`;
      break;
    case 'cylinder':
      expr = `Manifold.cylinder(${lit(spec.height)}, ${lit(spec.radius)}, ${lit(spec.radius)}, ${lit(spec.segments)})`;
      break;
    case 'sphere':
      expr = `Manifold.sphere(${lit(spec.radius)}, ${lit(spec.segments)})`;
      break;
    case 'tube':
      if (spec.section === 'rect') {
        const opts = spec.cornerRadius > 0 ? `, { cornerRadius: ${lit(spec.cornerRadius)} }` : '';
        expr = `tube([${lit(spec.width)}, ${lit(spec.depth)}], ${lit(spec.wall)}, ${lit(spec.height)}${opts})`;
      } else {
        expr = `tube(${lit(spec.outerRadius)}, ${lit(spec.innerRadius)}, ${lit(spec.height)}, ${lit(spec.segments)})`;
      }
      break;
    case 'hexPrism':
      expr = `hexPrism(${lit(spec.radius)}, ${lit(spec.height)})`;
      break;
    default:
      throw new Error(`Unknown block solid: ${spec.id}`);
  }
  return applyPoseExpr(expr, spec);
}

/**
 * The solid the pop is editing. `track` receives every manifold this creates
 * so the preview can delete them. Does not read the cached part.
 */
export function buildBlockManifold(spec, api) {
  const track = typeof api.track === 'function' ? api.track : () => {};
  const { Manifold, roundedBox, tube, hexPrism } = api;
  let solid;
  switch (spec.id) {
    case 'cube':
      solid = Manifold.cube([spec.width, spec.depth, spec.height], !!spec.center);
      break;
    case 'roundedBox':
      solid = roundedBox([spec.sx, spec.sy, spec.sz], spec.edgeRadius, spec.segments);
      break;
    case 'cylinder':
      solid = Manifold.cylinder(spec.height, spec.radius, spec.radius, spec.segments);
      break;
    case 'sphere':
      solid = Manifold.sphere(spec.radius, spec.segments);
      break;
    case 'tube':
      if (spec.section === 'rect') {
        const opts = spec.cornerRadius > 0 ? { cornerRadius: spec.cornerRadius } : undefined;
        solid = opts
          ? tube([spec.width, spec.depth], spec.wall, spec.height, opts)
          : tube([spec.width, spec.depth], spec.wall, spec.height);
      } else {
        solid = tube(spec.outerRadius, spec.innerRadius, spec.height, spec.segments);
      }
      break;
    case 'hexPrism':
      solid = hexPrism(spec.radius, spec.height);
      break;
    default:
      throw new Error(`Unknown block solid: ${spec.id}`);
  }
  track(solid);
  if (spec.rx || spec.ry || spec.rz) {
    const turned = solid.rotate([spec.rx, spec.ry, spec.rz]);
    track(turned);
    solid = turned;
  }
  if (spec.x || spec.y || spec.z) {
    const moved = solid.translate([spec.x, spec.y, spec.z]);
    track(moved);
    solid = moved;
  }
  return solid;
}
