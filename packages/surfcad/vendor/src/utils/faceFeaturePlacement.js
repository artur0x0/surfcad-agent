/**
 * Slice 11/12/21/22 — Face-select → feature placement + edge pick + cross-section + sweep path.
 *
 * Classify Viewport selectedFace → planar | cylindrical | irregular.
 * Face-aware param schemas + workplane / edge snippet helpers.
 * Slice 12: resolveHoleUV (Center → u=0,v=0 on snapped workplane);
 * selected-edge emission for fillet/chamfer.
 * Slice 21: cross-section substrate plane from planar face only.
 * Slice 22: edge → ordered sweep path from Edge (or Face|Edge) selection.
 *
 * Classification (from Viewport faceData):
 *   - planar:      selectionMode === 'coplanar' (single-click coplanar region)
 *                  OR angular-tolerance with few triangles (near-flat)
 *   - cylindrical: selectionMode === 'angular-tolerance' and triangleCount >= 8
 *                  (double-click walk along a curved / tessellated wall)
 *   - irregular:   selectionMode === 'all-connected' (triple-click) or unknown
 *
 * Irregular policy (v1): refuse with a clear message — no best-fit plane.
 * Generated snippets never use illegal bare `top`; they query via
 * facesByNormal(body, normal) + closest-to-center pick, then workplaneFromFace.
 */

import {
  minSelectedEdgeLength,
  effectiveBlendEdgeLength,
  defaultEdgeBlendSize,
  edgeBlendHardMax,
  blendSliderStep,
  pathLengthFromEdges,
  FILLET_DEFAULT_RADIUS,
  sweepBlendHardMax,
} from './selectEdge.js';
import { resolveFilletStrategy } from './filletAlongPath.js';
import {
  CROSS_SECTION_REFUSE_NON_PLANAR,
} from './crossSectionSubstrate.js';
import {
  assembleSweepPath,
  SWEEP_PATH_EMPTY,
} from './edgeSweepPath.js';

/** Features that place relative to a selected face when one is active. */
export const FACE_FEATURE_IDS = new Set([
  'hole',
  'holePattern',
  'clearanceHole',
  'tapDrillHole',
  'cboreHole',
  'cskHole',
  'filletEdges',
  'chamferEdges',
  'crossSection',
  'sweepPath',
  // Shell / Draft: the pick is the opening face / the face(s) being drafted.
  'shell',
  'addDraft',
]);

/** Features that require a planar face when one is selected (Slice 21). */
export const PLANAR_ONLY_FEATURE_IDS = new Set([
  'crossSection',
  'sweepPath',
]);

export function isFaceFeature(id) {
  return FACE_FEATURE_IDS.has(id);
}

/**
 * @typedef {'planar'|'cylindrical'|'irregular'} FaceType
 * @typedef {{
 *   type: FaceType,
 *   center: number[],
 *   normal: number[],
 *   area: number,
 *   triangleCount: number,
 *   selectionMode?: string,
 *   refuseMessage?: string,
 * }} FaceClassification
 */

/**
 * Classify Viewport selectedFace payload.
 * @param {object|null|undefined} faceData
 * @returns {FaceClassification|null}
 */
export function classifySelectedFace(faceData) {
  if (!faceData || !Array.isArray(faceData.normal) || !Array.isArray(faceData.center)) {
    return null;
  }
  const normal = faceData.normal.map((v) => Number(v));
  const center = faceData.center.map((v) => Number(v));
  if (normal.some((v) => !Number.isFinite(v)) || center.some((v) => !Number.isFinite(v))) {
    return null;
  }
  const nLen = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const unit = [normal[0] / nLen, normal[1] / nLen, normal[2] / nLen];
  const triangleCount = Number(faceData.triangleCount) || 0;
  const area = Number(faceData.area) || 0;
  const mode = faceData.selectionMode || 'coplanar';

  let type = 'planar';
  if (mode === 'all-connected') {
    type = 'irregular';
  } else if (mode === 'angular-tolerance' && triangleCount >= 8) {
    type = 'cylindrical';
  } else if (mode === 'angular-tolerance' && triangleCount > 0 && triangleCount < 8) {
    type = 'planar'; // near-flat tolerance walk
  } else if (mode === 'coplanar') {
    type = 'planar';
  } else {
    type = 'irregular';
  }

  const out = {
    type,
    center,
    normal: unit,
    area,
    triangleCount,
    selectionMode: mode,
  };
  // Multi-face pick (shift-click in the viewport): every accumulated face,
  // oldest first, this one last. Shell/Draft read it; every other feature keeps
  // using `center`/`normal` and so keeps behaving as a single-face pick.
  if (Array.isArray(faceData.group) && faceData.group.length > 1) {
    const group = faceData.group
      .map((g) => {
        if (!g || !Array.isArray(g.center) || !Array.isArray(g.normal)) return null;
        const n = g.normal.map(Number);
        const c = g.center.map(Number);
        if (n.some((v) => !Number.isFinite(v)) || c.some((v) => !Number.isFinite(v))) return null;
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        return { center: c, normal: [n[0] / l, n[1] / l, n[2] / l] };
      })
      .filter(Boolean);
    if (group.length > 1) out.group = group;
  }
  if (type === 'irregular') {
    out.refuseMessage =
      'Selected face is irregular (multi-region / non-developable). ' +
      'Pick a planar face (single-click) or a cylindrical wall (double-click), ' +
      'or clear the selection to use the default top-face workplane.';
  }
  return out;
}

/** Round a number for stable snippet literals. */
export function roundFaceNum(v, digits = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function formatVec3(arr, digits = 4) {
  const a = Array.isArray(arr) ? arr : [0, 0, 0];
  return `[${roundFaceNum(a[0], digits)}, ${roundFaceNum(a[1], digits)}, ${roundFaceNum(a[2], digits)}]`;
}

/**
 * Estimate cylinder axis from face normal (axis ⟂ average radial normal).
 * For common axis-aligned cylinders: pick world axis most orthogonal to normal.
 * @param {number[]} normal
 * @returns {{ axis: 'x'|'y'|'z', axisVec: number[] }}
 */
export function estimateCylinderAxis(normal) {
  const n = normal || [0, 0, 1];
  // Axis most orthogonal to radial normal = smallest |n·axis|
  const axes = [
    { axis: 'x', axisVec: [1, 0, 0], score: Math.abs(n[0]) },
    { axis: 'y', axisVec: [0, 1, 0], score: Math.abs(n[1]) },
    { axis: 'z', axisVec: [0, 0, 1], score: Math.abs(n[2]) },
  ];
  axes.sort((a, b) => a.score - b.score);
  return { axis: axes[0].axis, axisVec: axes[0].axisVec };
}

const HOLE_SIZE_OPTIONS = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'];
const HOLE_FIT_OPTIONS = ['close', 'normal', 'loose'];
const HOLE_END_OPTIONS = [
  { value: 'none', label: 'none' },
  { value: 'cbore', label: 'c-bore' },
  { value: 'csk', label: 'c-sink' },
];

/**
 * One Hole sheet: type is clearance or tap drill. Counterbore and countersink
 * are near-end and far-end options, not separate rail buttons.
 * @param {{ placement?: boolean, uv?: boolean, through?: boolean, pattern?: boolean, cylindrical?: boolean }} [opts]
 */
export function holeFeatureParamDefs(opts = {}) {
  const {
    placement = false,
    uv = true,
    through = false,
    pattern = false,
    cylindrical = false,
  } = opts;
  const params = [
    { name: 'body', type: 'body', default: 'part', label: 'Body' },
    {
      name: 'holeType', type: 'select', default: 'clearance', label: 'Type',
      options: [
        { value: 'clearance', label: 'clearance' },
        { value: 'tapDrill', label: 'tap drill' },
      ],
    },
    { name: 'size', type: 'select', default: 'M3', label: 'Size', options: HOLE_SIZE_OPTIONS },
    {
      name: 'fit', type: 'select', default: 'normal', label: 'Fit', options: HOLE_FIT_OPTIONS,
      showWhen: { field: 'holeType', values: ['clearance'] },
    },
  ];
  if (cylindrical) {
    params.push(
      { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
      { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
    );
  }
  if (placement) {
    params.push({
      name: 'placement', type: 'select', default: 'center', label: 'Placement',
      options: ['center', 'custom'],
    });
  }
  if (uv) {
    params.push(
      { name: 'u', type: 'number', default: 0, label: 'U', step: 0.5, slider: true },
      { name: 'v', type: 'number', default: 0, label: 'V', step: 0.5, slider: true },
    );
  }
  if (through) {
    params.push(
      { name: 'through', type: 'bool', default: true, label: 'Through' },
      { name: 'depth', type: 'number', default: 12, label: 'Depth', min: 0.1, step: 0.5, slider: true },
    );
  }
  if (pattern) {
    params.push(
      { name: 'usePattern', type: 'bool', default: false, label: 'n×m pattern' },
      { name: 'n', type: 'number', default: 3, label: 'Count U', min: 1, step: 1 },
      { name: 'm', type: 'number', default: 2, label: 'Count V', min: 1, step: 1 },
      { name: 'spacingU', type: 'number', default: 18, label: 'Spacing U', min: 0.1, step: 1, slider: true },
      { name: 'spacingV', type: 'number', default: 14, label: 'Spacing V', min: 0.1, step: 1, slider: true },
    );
  }
  const notPattern = { field: 'usePattern', values: [false, undefined] };
  const endFields = (side) => {
    const title = side === 'near' ? 'Near end' : 'Far end';
    const when = (kind) => (pattern
      ? [{ field: `${side}End`, values: [kind] }, notPattern]
      : { field: `${side}End`, values: [kind] });
    return [
      {
        name: `${side}End`, type: 'select', default: 'none', label: title,
        options: HOLE_END_OPTIONS,
        ...(pattern ? { showWhen: notPattern } : {}),
      },
      {
        name: `${side}CboreDia`, type: 'number', default: 6.5, label: `${title} c-bore Ø`,
        min: 0.1, step: 0.1, showWhen: when('cbore'),
      },
      {
        name: `${side}CboreDepth`, type: 'number', default: 3.5, label: `${title} c-bore depth`,
        min: 0.1, step: 0.5, showWhen: when('cbore'),
      },
      {
        name: `${side}CskDia`, type: 'number', default: 6.5, label: `${title} c-sink Ø`,
        min: 0.1, step: 0.1, showWhen: when('csk'),
      },
      {
        name: `${side}CskDepth`, type: 'number', default: 2, label: `${title} c-sink depth`,
        min: 0.1, step: 0.5, showWhen: when('csk'),
      },
    ];
  };
  params.push(...endFields('near'), ...endFields('far'));
  return params;
}

/**
 * Extra / replacement params for face-aware modal by face type + feature id.
 * Returns null for non-face features. Merges over base item.params in the UI.
 * @param {string} id
 * @param {FaceType} faceType
 * @returns {object[]|null}
 */
export function faceAwareParams(id, faceType) {
  if (!isFaceFeature(id)) return null;

  if (faceType === 'irregular') return [];

  const body = { name: 'body', type: 'body', default: 'part', label: 'Body' };
  const through = { name: 'through', type: 'bool', default: true, label: 'Through' };
  const depth = {
    name: 'depth', type: 'number', default: 12, label: 'Depth', min: 0.1, step: 0.5, slider: true,
  };

  // Shell: the pick is the OPENING. Any face type works — the wall is offset
  // from each face, so a cylindrical wall shells as happily as a planar one.
  if (id === 'shell') {
    return [
      body,
      { name: 'wall', type: 'number', default: 2.5, label: 'Wall', min: 0.1, step: 0.25, slider: true },
      {
        name: 'openScope',
        type: 'select',
        default: 'selected',
        label: 'Opening',
        options: [{ value: 'selected', label: 'selected face' }, ...SHELL_OPENING_OPTIONS],
      },
    ];
  }
  // Draft: the pick is the face (or faces) that tilt. `pull` is the draw
  // direction and `reference` names the plane that stays put.
  if (id === 'addDraft') {
    return [
      body,
      {
        name: 'draftDeg', type: 'number', default: 2, label: 'Draft °',
        min: -45, max: 45, step: 0.5, slider: true,
      },
      {
        name: 'faceScope',
        type: 'select',
        default: 'selected',
        label: 'Faces',
        options: [
          { value: 'selected', label: 'selected face(s)' },
          { value: 'sides', label: 'all side walls' },
        ],
      },
      { name: 'pull', type: 'select', default: 'z', label: 'Pull', options: DRAFT_PULL_OPTIONS },
      {
        name: 'reference',
        type: 'select',
        default: 'min',
        label: 'Reference plane',
        options: DRAFT_REFERENCE_OPTIONS,
      },
    ];
  }

  if (id === 'filletEdges') {
    return [
      body,
      { name: 'radius', type: 'number', default: 3, label: 'Radius', min: 0.01, step: 0.5, slider: true },
      { name: 'sphericalCorners', type: 'bool', default: true, label: 'Spherical corners' },
      {
        name: 'edgeScope',
        type: 'select',
        default: 'face',
        label: 'Edges',
        options: ['selected', 'face', 'allConvex'],
      },
    ];
  }
  if (id === 'chamferEdges') {
    return [
      body,
      { name: 'chamfer', type: 'number', default: 2, label: 'Chamfer', min: 0.01, step: 0.5, slider: true },
      {
        name: 'edgeScope',
        type: 'select',
        default: 'face',
        label: 'Edges',
        options: ['selected', 'face', 'allConvex'],
      },
    ];
  }

  if (faceType === 'cylindrical') {
    if (id === 'hole') {
      return holeFeatureParamDefs({ cylindrical: true, uv: false, through: true });
    }
    if (id === 'holePattern') {
      // Pattern on cylinder wall is awkward; keep axial/angle as origin + planar-style grid in tangent uv
      return [
        body,
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        { name: 'n', type: 'number', default: 3, label: 'Count U', min: 1, step: 1 },
        { name: 'm', type: 'number', default: 2, label: 'Count V', min: 1, step: 1 },
        { name: 'spacingU', type: 'number', default: 18, label: 'Spacing U', min: 0.1, step: 1, slider: true },
        { name: 'spacingV', type: 'number', default: 14, label: 'Spacing V', min: 0.1, step: 1, slider: true },
        { name: 'dia', type: 'number', default: 4, label: 'Diameter', min: 0.1, step: 0.5, slider: true },
      ];
    }
    if (id === 'clearanceHole') {
      return [
        body,
        { name: 'size', type: 'select', default: 'M3', label: 'Size', options: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'] },
        { name: 'fit', type: 'select', default: 'normal', label: 'Fit', options: ['close', 'normal', 'loose'] },
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        through,
        depth,
      ];
    }
    if (id === 'tapDrillHole') {
      return [
        body,
        { name: 'size', type: 'select', default: 'M3', label: 'Size', options: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'] },
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        through,
        depth,
      ];
    }
    if (id === 'cboreHole') {
      return [
        body,
        { name: 'diaThru', type: 'number', default: 5.5, label: 'Thru Ø', min: 0.1, step: 0.1, slider: true },
        { name: 'diaCbore', type: 'number', default: 10, label: 'Cbore Ø', min: 0.1, step: 0.1, slider: true },
        { name: 'cboreDepth', type: 'number', default: 4, label: 'Cbore depth', min: 0.1, step: 0.5, slider: true },
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        through,
        depth,
      ];
    }
    if (id === 'cskHole') {
      return [
        body,
        { name: 'diaThru', type: 'number', default: 3.4, label: 'Thru Ø', min: 0.1, step: 0.1, slider: true },
        { name: 'diaCsk', type: 'number', default: 6.5, label: 'Csk Ø', min: 0.1, step: 0.1, slider: true },
        { name: 'cskDepth', type: 'number', default: 2, label: 'Csk depth', min: 0.1, step: 0.5, slider: true },
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        through,
        depth,
      ];
    }
  }

  // ── planar ───────────────────────────────────────────────────
  const placement = {
    name: 'placement',
    type: 'select',
    default: 'center',
    label: 'Placement',
    options: ['center', 'custom'],
  };
  const uv = [
    { name: 'u', type: 'number', default: 0, label: 'U', step: 0.5, slider: true },
    { name: 'v', type: 'number', default: 0, label: 'V', step: 0.5, slider: true },
  ];
  const patternOpts = [
    { name: 'usePattern', type: 'bool', default: false, label: 'n×m pattern' },
    { name: 'n', type: 'number', default: 3, label: 'Count U', min: 1, step: 1 },
    { name: 'm', type: 'number', default: 2, label: 'Count V', min: 1, step: 1 },
    { name: 'spacingU', type: 'number', default: 18, label: 'Spacing U', min: 0.1, step: 1, slider: true },
    { name: 'spacingV', type: 'number', default: 14, label: 'Spacing V', min: 0.1, step: 1, slider: true },
  ];

  if (id === 'hole') {
    return holeFeatureParamDefs({ placement: true, uv: true, through: true, pattern: true });
  }
  if (id === 'holePattern') {
    return [
      body,
      ...uv.map((p) => ({ ...p, label: p.name === 'u' ? 'Origin U' : 'Origin V' })),
      { name: 'n', type: 'number', default: 3, label: 'Count U', min: 1, step: 1 },
      { name: 'm', type: 'number', default: 2, label: 'Count V', min: 1, step: 1 },
      { name: 'spacingU', type: 'number', default: 18, label: 'Spacing U', min: 0.1, step: 1, slider: true },
      { name: 'spacingV', type: 'number', default: 14, label: 'Spacing V', min: 0.1, step: 1, slider: true },
      { name: 'dia', type: 'number', default: 4, label: 'Diameter', min: 0.1, step: 0.5, slider: true },
    ];
  }
  if (id === 'clearanceHole') {
    return [
      body,
      { name: 'size', type: 'select', default: 'M3', label: 'Size', options: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'] },
      { name: 'fit', type: 'select', default: 'normal', label: 'Fit', options: ['close', 'normal', 'loose'] },
      placement,
      ...uv,
      through,
      depth,
      ...patternOpts,
    ];
  }
  if (id === 'tapDrillHole') {
    return [
      body,
      { name: 'size', type: 'select', default: 'M3', label: 'Size', options: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'] },
      placement,
      ...uv,
      through,
      depth,
    ];
  }
  if (id === 'cboreHole') {
    return [
      body,
      { name: 'diaThru', type: 'number', default: 5.5, label: 'Thru Ø', min: 0.1, step: 0.1, slider: true },
      { name: 'diaCbore', type: 'number', default: 10, label: 'Cbore Ø', min: 0.1, step: 0.1, slider: true },
      { name: 'cboreDepth', type: 'number', default: 4, label: 'Cbore depth', min: 0.1, step: 0.5, slider: true },
      placement,
      ...uv,
      through,
      depth,
    ];
  }
  if (id === 'cskHole') {
    return [
      body,
      { name: 'diaThru', type: 'number', default: 3.4, label: 'Thru Ø', min: 0.1, step: 0.1, slider: true },
      { name: 'diaCsk', type: 'number', default: 6.5, label: 'Csk Ø', min: 0.1, step: 0.1, slider: true },
      { name: 'cskDepth', type: 'number', default: 2, label: 'Csk depth', min: 0.1, step: 0.5, slider: true },
      placement,
      ...uv,
      through,
      depth,
    ];
  }
  return null;
}

/**
 * Seed face-aware defaults from classification (cylindrical angle/axial from pick).
 * @param {string} id
 * @param {FaceClassification} face
 * @returns {object}
 */
export function seedFaceParams(id, face) {
  const base = {};
  if (!face) return base;
  if (face.type === 'cylindrical') {
    // Angle in XY (or plane ⊥ axis) from face normal
    const { axis } = estimateCylinderAxis(face.normal);
    let angleDeg = 0;
    let axial = 0;
    if (axis === 'z') {
      angleDeg = (Math.atan2(face.normal[1], face.normal[0]) * 180) / Math.PI;
      axial = face.center[2];
    } else if (axis === 'y') {
      angleDeg = (Math.atan2(face.normal[0], face.normal[2]) * 180) / Math.PI;
      axial = face.center[1];
    } else {
      angleDeg = (Math.atan2(face.normal[2], face.normal[1]) * 180) / Math.PI;
      axial = face.center[0];
    }
    base.angleDeg = roundFaceNum(angleDeg, 1);
    base.axial = roundFaceNum(axial, 2);
  }
  // Planar Center → u/v 0,0 on workplane (origin snapped to face center).
  if (face.type === 'planar') {
    base.placement = 'center';
    base.u = 0;
    base.v = 0;
  }
  // Draft: open the sheet on a pull the picked face can actually tilt about,
  // so the first Accept is not the "a cap cannot be drafted" refusal.
  if (id === 'addDraft') {
    base.pull = draftPullForFace(face, 'z');
  }
  void id;
  return base;
}

/**
 * One face pick as a literal the kernel can resolve: `{ center: [...], normal: [...] }`.
 * shell()/hollow()/draftFaces() take this shape directly and fail loudly when it
 * no longer names a face on the body — so no resolver IIFE is needed here.
 * @param {{center: number[], normal: number[]}} face
 * @returns {string}
 */
export function facePickLiteral(face) {
  return `{ center: ${formatVec3(face.center)}, normal: ${formatVec3(face.normal)} }`;
}

/** Every face in a multi-pick (or just the one), as literals. */
export function facePickLiterals(face) {
  const list = Array.isArray(face?.group) && face.group.length > 1 ? face.group : [face];
  return list.map(facePickLiteral);
}

/** Axes the Shell / Draft sheets offer when no face is picked. */
export const SHELL_OPENING_OPTIONS = [
  { value: 'z', label: '+Z (top)' },
  { value: '-z', label: '−Z (bottom)' },
  { value: 'x', label: '+X' },
  { value: '-x', label: '−X' },
  { value: 'y', label: '+Y' },
  { value: '-y', label: '−Y' },
  { value: 'none', label: 'closed (no opening)' },
];

/** Draw direction for Draft. */
export const DRAFT_PULL_OPTIONS = [
  { value: 'z', label: '+Z' },
  { value: '-z', label: '−Z' },
  { value: 'x', label: '+X' },
  { value: '-x', label: '−X' },
  { value: 'y', label: '+Y' },
  { value: '-y', label: '−Y' },
];

/** The plane a Draft pivots about (measured along the pull direction). */
export const DRAFT_REFERENCE_OPTIONS = [
  { value: 'min', label: 'start of pull (stays put)' },
  { value: 'mid', label: 'middle' },
  { value: 'max', label: 'end of pull' },
];

/**
 * The `opening` / `faces` argument for a face-driven Shell or Draft.
 *
 * scope 'selected'  -> the picked face(s), as literals
 * scope 'sides'     -> 'sides' (every wall off the pull axis) — Draft only
 * scope 'none'      -> 'none' (closed)  — Shell only
 * anything else     -> treated as an axis string
 *
 * @param {FaceClassification|null} face
 * @param {string} scope
 * @returns {string} a JS expression
 */
export function emitFaceSelectionExpr(face, scope) {
  if (scope === 'selected' && face) {
    const lits = facePickLiterals(face);
    return lits.length > 1 ? `[${lits.join(', ')}]` : lits[0];
  }
  if (scope === 'sides' || scope === 'none' || scope === 'all') return `'${scope}'`;
  return `'${scope}'`;
}

/**
 * Default pull direction for drafting the PICKED face: a face can only tilt
 * about a line in its own plane, so the pull must be (nearly) in-plane with it —
 * the world axis with the smallest |n·axis|. Z wins ties, since a mould is
 * almost always drawn along Z.
 * @param {FaceClassification|null} face
 * @param {string} [fallback='z']
 * @returns {'x'|'y'|'z'|string}
 */
export function draftPullForFace(face, fallback = 'z') {
  if (!face || !Array.isArray(face.normal)) return fallback;
  const n = face.normal;
  const axes = [['z', Math.abs(n[2])], ['x', Math.abs(n[0])], ['y', Math.abs(n[1])]];
  axes.sort((a, b) => a[1] - b[1]);
  return axes[0][1] < 0.9 ? axes[0][0] : fallback;
}

/**
 * Emit lines that resolve selected face → workplane frame.
 * Prefers facesByNormal + closest center (stable, no illegal `top`).
 *
 * @param {string} body
 * @param {FaceClassification} face
 * @param {Set<string>} names
 * @param {(existing: Set<string>, base: string) => string} allocateUniqueName
 * @returns {{ lines: string[], faceVar: string, frVar: string }}
 */
export function emitFaceWorkplaneLines(body, face, names, allocateUniqueName) {
  const faceVar = allocateUniqueName(names, 'selFace');
  const frVar = allocateUniqueName(names, 'fr');
  // Unique temps so sequential inserts never collide with filterRedeclarations
  // (flat declaredNames used to strip mid-IIFE lines and leave orphan `});` / `}})();`).
  const cands = allocateUniqueName(names, '_cands');
  const c = allocateUniqueName(names, '_c');
  const best = allocateUniqueName(names, '_best');
  const bd = allocateUniqueName(names, '_bd');
  const f = allocateUniqueName(names, '_f');
  const d = allocateUniqueName(names, '_d');
  const pc = allocateUniqueName(names, '_pc');
  const off = allocateUniqueName(names, '_off');
  const nLit = formatVec3(face.normal);
  const cLit = formatVec3(face.center);
  // Hotfix: after adjacent fillets, c4 faces near the pick can have normals
  // a few degrees off the Viewport chip (merge / tessellation). Prefer closest
  // center among a wide normal band (25°); fall back message tells user to
  // re-pick rather than the cryptic "No face near selected normal".
  const lines = [
    `const ${faceVar} = (() => {`,
    `  const ${c} = ${cLit};`,
    `  let ${cands} = facesByNormal(${body}, ${nLit}, 25);`,
    `  if (!${cands}.length) ${cands} = facesByNormal(${body}, ${nLit}, 45);`,
    `  if (!${cands}.length) throw new Error('Selected face not found on body after geometry changes — re-pick the planar face, then Hole/Clearance (normal ${nLit})');`,
    `  let ${best} = ${cands}[0], ${bd} = Infinity;`,
    `  for (const ${f} of ${cands}) {`,
    `    const ${d} = (${f}.center[0]-${c}[0])**2 + (${f}.center[1]-${c}[1])**2 + (${f}.center[2]-${c}[2])**2;`,
    `    if (${d} < ${bd}) { ${bd} = ${d}; ${best} = ${f}; }`,
    `  }`,
    `  return ${best};`,
    `})();`,
    `const ${frVar} = workplaneFromFace(${body}, ${faceVar});`,
    `// Snap origin to selected face center (projected onto plane) so Center → u=0,v=0 hits pick.`,
    `(() => {`,
    `  const ${pc} = ${cLit};`,
    `  const ${off} = (${pc}[0]-${frVar}.center[0])*${frVar}.normal[0] + (${pc}[1]-${frVar}.center[1])*${frVar}.normal[1] + (${pc}[2]-${frVar}.center[2])*${frVar}.normal[2];`,
    `  ${frVar}.center = [${pc}[0]-${off}*${frVar}.normal[0], ${pc}[1]-${off}*${frVar}.normal[1], ${pc}[2]-${off}*${frVar}.normal[2]];`,
    `})();`,
  ];
  return { lines, faceVar, frVar };
}

/**
 * Emit span expression: through → holeSpan; else numeric depth.
 */
export function emitSpanExpr(body, frVar, params, names, allocateUniqueName, numFn) {
  const through = params.through !== false && params.through !== 'false' && params.through !== 0;
  if (through) {
    const span = allocateUniqueName(names, 'span');
    return {
      lines: [`const ${span} = holeSpan(${body}, ${frVar});`],
      spanExpr: span,
    };
  }
  const depth = numFn(params.depth, 12);
  return { lines: [], spanExpr: String(depth) };
}

/**
 * Emit edge selection for fillet/chamfer on a face.
 * Filters convexEdges whose n0/n1 aligns with face normal.
 * Fallback option: all convexEdges(body).
 *
 * @returns {{ lines: string[], edgesExpr: string }}
 */
export function emitFaceEdgeLines(body, face, params, names, allocateUniqueName) {
  const scope = params.edgeScope === 'allConvex' ? 'allConvex' : 'face';
  if (scope === 'allConvex') {
    return { lines: [], edgesExpr: `convexEdges(${body})` };
  }
  const edgesVar = allocateUniqueName(names, 'faceEdges');
  const n = allocateUniqueName(names, '_n');
  const dot = allocateUniqueName(names, '_dot');
  const ok = allocateUniqueName(names, '_ok');
  const nLit = formatVec3(face.normal);
  const lines = [
    `const ${edgesVar} = convexEdges(${body}).filter((e) => {`,
    `  const ${n} = ${nLit};`,
    `  const ${dot} = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];`,
    `  const ${ok} = (nn) => nn && ${dot}(nn, ${n}) > 0.95;`,
    `  return ${ok}(e.n0) || ${ok}(e.n1);`,
    `});`,
    `if (!${edgesVar}.length) throw new Error('No convex edges adjacent to selected face — try Edges: allConvex');`,
  ];
  return { lines, edgesExpr: edgesVar };
}

/**
 * Resolve planar hole UV for Center vs custom placement.
 * Center → { u:0, v:0 } in the face workplane (origin snapped to face.center).
 * Custom → numeric u/v from params.
 *
 * @param {object} params
 * @param {FaceClassification|null} faceCtx
 * @param {(v:any, fb:number)=>number} numFn
 * @returns {{ u: number, v: number, mode: 'center'|'custom'|'literal' }}
 */
export function resolveHoleUV(params, faceCtx, numFn = (v, fb) => {
  if (v === '' || v === null || v === undefined || v === '-' || v === '.') return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}) {
  const p = params || {};
  if (faceCtx && faceCtx.type === 'planar') {
    // Explicit placement: 'center' → always 0,0. 'custom' → params u/v.
    // No placement field (legacy / direct compose) → honor params u/v.
    if (String(p.placement) === 'center') {
      return { u: 0, v: 0, mode: 'center' };
    }
    if (String(p.placement) === 'custom') {
      return { u: numFn(p.u, 0), v: numFn(p.v, 0), mode: 'custom' };
    }
    return { u: numFn(p.u, 0), v: numFn(p.v, 0), mode: 'literal' };
  }
  return { u: numFn(p.u, 0), v: numFn(p.v, 0), mode: 'literal' };
}

/**
 * Emit edge selection from Viewport multi-select (midpoint match against convexEdges).
 * Prefer this for fillet/chamfer when the user picked edges.
 *
 * @param {string} body
 * @param {object[]} selectedEdges array of { mid: number[] }
 * @param {Set<string>} names
 * @param {(existing: Set<string>, base: string) => string} allocateUniqueName
 * @returns {{ lines: string[], edgesExpr: string, ok: boolean, message?: string }}
 */
export function emitSelectedEdgeLines(body, selectedEdges, names, allocateUniqueName) {
  const edges = Array.isArray(selectedEdges) ? selectedEdges : [];
  if (!edges.length) {
    return {
      lines: [],
      edgesExpr: '',
      ok: false,
      message:
        'No edges selected. Switch to Edge pick mode, tap edges to multi-select, then Fillet/Chamfer.',
    };
  }
  const edgesVar = allocateUniqueName(names, 'selEdges');
  // Unique temps — sequential fillet/chamfer must not share _mids/_all/_hit with a prior IIFE
  // or filterRedeclarations will strip mid-block lines and corrupt the script (Parser error).
  const mids = allocateUniqueName(names, '_mids');
  const all = allocateUniqueName(names, '_all');
  const hit = allocateUniqueName(names, '_hit');
  const m = allocateUniqueName(names, '_m');
  const midsLit = edges.map((e) => {
    const mid = e.mid || [
      ((e.va?.[0] ?? 0) + (e.vb?.[0] ?? 0)) / 2,
      ((e.va?.[1] ?? 0) + (e.vb?.[1] ?? 0)) / 2,
      ((e.va?.[2] ?? 0) + (e.vb?.[2] ?? 0)) / 2,
    ];
    return formatVec3(mid);
  }).join(', ');
  const lines = [
    `const ${edgesVar} = (() => {`,
    `  const ${mids} = [${midsLit}];`,
    `  const ${all} = convexEdges(${body});`,
    `  const ${hit} = ${all}.filter((e) => {`,
    `    const ${m} = [(e.va[0]+e.vb[0])/2, (e.va[1]+e.vb[1])/2, (e.va[2]+e.vb[2])/2];`,
    `    return ${mids}.some((p) => (${m}[0]-p[0])**2 + (${m}[1]-p[1])**2 + (${m}[2]-p[2])**2 < 0.25);`,
    `  });`,
    `  if (!${hit}.length) throw new Error('Selected edges not found on body — re-pick after geometry changes');`,
    `  return ${hit};`,
    `})();`,
  ];
  return { lines, edgesExpr: edgesVar, ok: true };
}

/**
 * Emit the picked edge wire as literals for makeSweepPath / filletAlongPath.
 * Do NOT rematch convexEdges — post-fillet G1 rails often fail the convex ball
 * probe, so mid-match drops bridges and makeSweepPath sees a disconnected set
 * even when Edge pick + Tangent selected a valid chain (~95–98 edges).
 *
 * @param {string} _body unused (kept for emitSelectedEdgeLines call-shape)
 * @param {object[]} selectedEdges
 * @param {Set<string>} names
 * @param {(existing: Set<string>, base: string) => string} allocateUniqueName
 * @returns {{ lines: string[], edgesExpr: string, ok: boolean, message?: string }}
 */
export function emitSelectedEdgeLiteralLines(_body, selectedEdges, names, allocateUniqueName) {
  const edges = Array.isArray(selectedEdges) ? selectedEdges : [];
  if (!edges.length) {
    return {
      lines: [],
      edgesExpr: '',
      ok: false,
      message:
        'No edges selected. Switch to Edge pick mode, tap edges to multi-select, then Path/Fillet.',
    };
  }
  const lits = [];
  for (const e of edges) {
    if (!e || !Array.isArray(e.va) || !Array.isArray(e.vb)) continue;
    if (!Number.isFinite(e.a) || !Number.isFinite(e.b)) continue;
    const va = formatVec3(e.va, 6);
    const vb = formatVec3(e.vb, 6);
    let length = Number(e.length);
    if (!(length > 0)) {
      length = Math.hypot(e.vb[0] - e.va[0], e.vb[1] - e.va[1], e.vb[2] - e.va[2]);
    }
    if (!(length > 1e-12)) continue;
    const key = e.key ? `, key: ${JSON.stringify(String(e.key))}` : '';
    let normals = '';
    if (Array.isArray(e.n0) && e.n0.length >= 3 && Array.isArray(e.n1) && e.n1.length >= 3) {
      normals = `, n0: ${formatVec3(e.n0, 6)}, n1: ${formatVec3(e.n1, 6)}`;
    }
    // Slice B+C: emit dense pts when present so re-run makeSweepPath keeps
    // curvature (va/vb alone are RDP chords → faceted fillet corners).
    let ptsLit = '';
    if (Array.isArray(e.pts) && e.pts.length >= 2) {
      const body = e.pts
        .filter((p) => Array.isArray(p) && p.length >= 3)
        .map((p) => formatVec3(p, 6))
        .join(', ');
      if (body) ptsLit = `, pts: [${body}]`;
    }
    lits.push(
      `{ a: ${e.a}, b: ${e.b}, va: ${va}, vb: ${vb}, length: ${+length.toFixed(6)}${key}${normals}${ptsLit} }`,
    );
  }
  if (!lits.length) {
    return {
      lines: [],
      edgesExpr: '',
      ok: false,
      message:
        'Selected edges have no usable endpoints — re-pick after geometry changes.',
    };
  }
  const edgesVar = allocateUniqueName(names, 'selEdges');
  return {
    lines: [`const ${edgesVar} = [${lits.join(', ')}];`],
    edgesExpr: edgesVar,
    ok: true,
  };
}

/**
 * Fillet / chamfer-via-sweep Accept: short face/edge helpers instead of
 * tessellation va/vb dumps. Edges without boundary ids return null so the
 * caller can keep the literal wire (Path tool, older fixtures).
 *
 * One face pair that is the only boundary between those faces →
 * `edgesBetween(part, faceA, faceB)`. Otherwise explicit `edge(part, id)`
 * so a partial chain is not widened to every edge of the pair.
 *
 * @returns {{ lines: string[], edgesExpr: string, ok: true } | null}
 */
export function emitFilletBoundaryLines(body, selectedEdges, names, allocateUniqueName) {
  const edges = Array.isArray(selectedEdges) ? selectedEdges : [];
  if (!edges.length) return null;
  const tagged = [];
  for (const edge of edges) {
    if (!edge) continue;
    if (!Number.isFinite(edge.boundaryId)) return null;
    if (!Number.isFinite(edge.faceA) || !Number.isFinite(edge.faceB)) return null;
    tagged.push(edge);
  }
  if (!tagged.length) return null;

  const ids = [];
  const seen = new Set();
  const pairs = new Map();
  let pairCount = null;
  for (const edge of tagged) {
    if (!seen.has(edge.boundaryId)) {
      seen.add(edge.boundaryId);
      ids.push(edge.boundaryId);
    }
    const fa = Math.min(edge.faceA, edge.faceB);
    const fb = Math.max(edge.faceA, edge.faceB);
    pairs.set(`${fa}:${fb}`, [fa, fb]);
    if (pairCount == null) pairCount = edge.pairCount;
    else if (edge.pairCount != null && edge.pairCount !== pairCount) pairCount = -1;
  }

  const edgesVar = allocateUniqueName(names, 'selEdges');
  const solePair = pairs.size === 1 && ids.length === 1 && (pairCount == null || pairCount === 1);
  let lines;
  if (solePair) {
    const [fa, fb] = [...pairs.values()][0];
    lines = [
      `const ${edgesVar} = edgesBetween(${body}, ${fa}, ${fb}); // boundary edge ${ids[0]}`,
    ];
  } else {
    lines = [
      `const ${edgesVar} = [${ids.join(', ')}].flatMap((id) => edge(${body}, id));`,
    ];
  }
  return { lines, edgesExpr: edgesVar, ok: true };
}

/**
 * Build a modal item view-model for face placement (or refuse).
 * Optional selectedEdges: when present, fillet/chamfer prefer edge-aware sheet.
 * @returns {{ mode: 'params'|'refuse'|'default', item?: object, face?: FaceClassification, message?: string }}
 */
export function resolveFaceModal(paletteItem, selectedFace, selectedEdges = null) {
  if (!paletteItem) return { mode: 'default' };
  const id = paletteItem.id;
  const hasEdges = Array.isArray(selectedEdges) && selectedEdges.length > 0;
  const isEdgeFeature = id === 'filletEdges' || id === 'chamferEdges';
  const isSweepPath = id === 'sweepPath';

  // Slice 22: ordered sweep path from current edge selection.
  if (isSweepPath) {
    if (!hasEdges) {
      return {
        mode: 'refuse',
        message: SWEEP_PATH_EMPTY,
      };
    }
    const ordered = assembleSweepPath(selectedEdges);
    if (!ordered.ok) {
      return {
        mode: 'refuse',
        message: ordered.message || SWEEP_PATH_EMPTY,
      };
    }
    const body = { name: 'body', type: 'body', default: 'part', label: 'Body' };
    const reverse = { name: 'reverse', type: 'bool', default: false, label: 'Reverse direction' };
    const n = selectedEdges.length;
    const loop = ordered.value.closed ? 'closed loop' : 'open chain';
    return {
      mode: 'params',
      face: selectedFace ? classifySelectedFace(selectedFace) : null,
      edges: selectedEdges,
      item: {
        ...paletteItem,
        params: [body, reverse],
        title: `${paletteItem.title} — ${n} edge${n === 1 ? '' : 's'} (${loop})`,
        _edgePlacement: true,
        _sweepPathPlacement: true,
      },
    };
  }

  // Slice 12 + polish: fillet/chamfer with user-selected edges (no face required).
  // Planar: seed/cap under kernel size guard t < 0.45·L.
  // Sweep (default / auto): NO planar size clamp — path-length defaults (r≈6 on box
  // perimeter). Tessellated prior-fillet rims must not pin the slider ~0.04.
  if (isEdgeFeature && hasEdges) {
    const body = { name: 'body', type: 'body', default: 'part', label: 'Body' };
    const edgeScope = {
      name: 'edgeScope', type: 'select', default: 'selected', label: 'Edges',
      options: ['selected', 'face', 'allConvex'],
    };
    const minL = effectiveBlendEdgeLength(selectedEdges) ?? minSelectedEdgeLength(selectedEdges);
    const pathLen = pathLengthFromEdges(selectedEdges);
    // Fillet: sweep is the universal default — open at the fixed 2 mm radius
    // (not 0.1 × path length, which grew with every picked edge).
    // Chamfer stays planar-guarded (no sweep strategy).
    const resolved = id === 'filletEdges'
      ? resolveFilletStrategy('sweep', selectedEdges)
      : 'planar';
    const useSweepSize = resolved === 'sweep';
    const blendDefault = useSweepSize
      ? FILLET_DEFAULT_RADIUS
      : (minL != null ? defaultEdgeBlendSize(minL) : (id === 'filletEdges' ? 3 : 2));
    const blendMax = useSweepSize
      ? sweepBlendHardMax(pathLen ?? minL)
      : (minL != null ? edgeBlendHardMax(minL) : undefined);
    const blendStep = blendSliderStep(blendMax);
    const blendParam = id === 'filletEdges'
      ? {
          name: 'radius', type: 'number', default: blendDefault, label: 'Radius',
          min: 0.01, step: blendStep, slider: true, ...(blendMax != null ? { max: blendMax } : {}),
        }
      : {
          name: 'chamfer', type: 'number', default: blendDefault, label: 'Chamfer',
          min: 0.01, step: blendStep, slider: true, ...(blendMax != null ? { max: blendMax } : {}),
        };
    let params;
    if (id === 'filletEdges') {
      params = [
        body,
        {
          name: 'strategy', type: 'select', default: 'sweep', label: 'Strategy',
          options: ['sweep', 'planar', 'auto'],
        },
        blendParam,
        { name: 'sphericalCorners', type: 'bool', default: true, label: 'Spherical corners' },
        {
          name: 'profile', type: 'select', default: 'fillet', label: 'Sweep profile',
          options: ['fillet', 'chamfer'],
        },
        { name: 'reverse', type: 'bool', default: false, label: 'Reverse path' },
        edgeScope,
      ];
    } else {
      params = [body, blendParam, edgeScope];
    }
    return {
      mode: 'params',
      face: selectedFace ? classifySelectedFace(selectedFace) : null,
      edges: selectedEdges,
      minEdgeLength: minL,
      item: {
        ...paletteItem,
        params,
        title: `${paletteItem.title} — ${selectedEdges.length} edge${selectedEdges.length === 1 ? '' : 's'}`,
        _edgePlacement: true,
        _minEdgeLength: minL,
        // Modal: skip planar 0.45·L clamp when Strategy resolves to sweep.
        _blendSizeGuard: !useSweepSize,
        _sweepBlendMax: sweepBlendHardMax(pathLen ?? minL),
        _pathLength: pathLen,
      },
    };
  }

  // Fillet/chamfer with no edges and no face → prompt to select edges.
  if (isEdgeFeature && !selectedFace && !hasEdges) {
    return {
      mode: 'refuse',
      message:
        'Select edges first (Edge pick mode in the viewport), then Fillet/Chamfer. ' +
        'Or select a face to fillet its adjacent convex edges.',
    };
  }

  // Slice 21: cross-section plane from planar face only.
  if (id === 'crossSection' && selectedFace) {
    const face = classifySelectedFace(selectedFace);
    if (!face) return { mode: 'default' };
    if (face.type !== 'planar') {
      return {
        mode: 'refuse',
        face,
        message: face.type === 'irregular'
          ? face.refuseMessage
          : CROSS_SECTION_REFUSE_NON_PLANAR,
      };
    }
    return {
      mode: 'params',
      face,
      edges: null,
      item: {
        ...paletteItem,
        title: `${paletteItem.title} — on planar face`,
        _facePlacement: true,
        _crossSectionPlacement: true,
      },
    };
  }

  if (!isFaceFeature(id) || !selectedFace) {
    return { mode: 'default' };
  }
  const face = classifySelectedFace(selectedFace);
  if (!face) return { mode: 'default' };
  if (face.type === 'irregular') {
    return { mode: 'refuse', face, message: face.refuseMessage };
  }
  // Catch-all for future planar-only ids (crossSection already gated earlier).
  if (PLANAR_ONLY_FEATURE_IDS.has(id) && face.type !== 'planar') {
    return { mode: 'refuse', face, message: CROSS_SECTION_REFUSE_NON_PLANAR };
  }
  const params = faceAwareParams(id, face.type);
  if (!params) return { mode: 'default' };
  const seeds = seedFaceParams(id, face);
  const minL = hasEdges && isEdgeFeature
    ? (effectiveBlendEdgeLength(selectedEdges) ?? minSelectedEdgeLength(selectedEdges))
    : null;
  const pathLenFace = hasEdges && isEdgeFeature ? pathLengthFromEdges(selectedEdges) : null;
  const useSweepSizeFace = id === 'filletEdges' && hasEdges
    && resolveFilletStrategy('sweep', selectedEdges) === 'sweep';
  const blendDefault = useSweepSizeFace
    ? FILLET_DEFAULT_RADIUS
    : (minL != null ? defaultEdgeBlendSize(minL) : null);
  const blendMax = useSweepSizeFace
    ? sweepBlendHardMax(pathLenFace ?? minL)
    : (minL != null ? edgeBlendHardMax(minL) : null);
  const blendStep = blendSliderStep(blendMax);
  // Prefer selected edges when both face + edges present for fillet/chamfer.
  const mergedParams = params.map((p) => {
    let def = seeds[p.name] !== undefined ? seeds[p.name] : p.default;
    if (p.name === 'edgeScope' && hasEdges) def = 'selected';
    if (blendDefault != null && (p.name === 'radius' || p.name === 'chamfer')) def = blendDefault;
    let next = p;
    if (def !== p.default) next = { ...next, default: def };
    else if (seeds[p.name] !== undefined) next = { ...next, default: seeds[p.name] };
    if (blendMax != null && (p.name === 'radius' || p.name === 'chamfer')) {
      next = { ...next, max: blendMax, step: blendStep, slider: true };
    }
    return next;
  });
  return {
    mode: 'params',
    face,
    edges: hasEdges ? selectedEdges : null,
    minEdgeLength: minL,
    item: {
      ...paletteItem,
      params: mergedParams,
      title: hasEdges && isEdgeFeature
        ? `${paletteItem.title} — ${selectedEdges.length} edge${selectedEdges.length === 1 ? '' : 's'}`
        : (face.group
          ? `${paletteItem.title} — on ${face.group.length} picked faces`
          : `${paletteItem.title} — on ${face.type} face`),
      _facePlacement: true,
      _edgePlacement: hasEdges && isEdgeFeature,
      _minEdgeLength: minL,
      _blendSizeGuard: hasEdges && isEdgeFeature ? !useSweepSizeFace : true,
      _sweepBlendMax: sweepBlendHardMax(pathLenFace ?? minL),
      _pathLength: pathLenFace,
    },
  };
}
