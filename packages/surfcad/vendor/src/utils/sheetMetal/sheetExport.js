/**
 * S5 export bundle: DFM verdict + flat DXF + STEP, both from the sheet spec.
 * STEP is an exact B-rep (`sheetBrep.js`: true cylinders at every bend). The
 * last built mesh is only a fallback when the spec cannot be folded into one
 * shell. Hard DFM fails block every download and the SCS order.
 */
import { checkSheetDfm } from './sheetDfm.js';
import { sheetFlatDxf } from './sheetFlat.js';
import { brepToStep, meshToStep } from './stepExport.js';
import { buildSheetBrep, countersinkOf } from './sheetBrep.js';
import { bendAllowance, normalizeSheetSpec, solveSheet } from './sheetModel.js';
import { SHEET_METAL_BEGIN, SHEET_METAL_END } from './sheetMetalScript.js';

export function sheetFileBase(partName, sku) {
  const clean = (s) => String(s || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return [clean(partName) || 'sheet', clean(sku)].filter(Boolean).join('-');
}

/** Signed mesh volume (mm³). */
export function meshVolume(mesh) {
  const np = mesh?.numProp || 3;
  const p = mesh?.vertProperties;
  const t = mesh?.triVerts;
  if (!p || !t) return 0;
  let v = 0;
  for (let i = 0; i + 2 < t.length; i += 3) {
    const a = t[i] * np;
    const b = t[i + 1] * np;
    const c = t[i + 2] * np;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/**
 * Expected solid volume from the flat pattern: area·t, minus through holes
 * and each countersink's cone beyond its hole, plus each bend zone's
 * (sector − BA strip) difference θ·L·(t²/2 + r·t) − BA·t·L.
 */
export function sheetExpectedVolume(rawSpec, flat) {
  const spec = normalizeSheetSpec(rawSpec);
  const { t, r } = spec;
  let v = flat.area * t - flat.holes.reduce((s, h) => s + Math.PI * h.r * h.r * t, 0);
  for (const h of spec.holes) {
    const csk = countersinkOf(h, t);
    if (!csk) continue;
    const R = (Number(h.d) || 0) / 2;
    const { depth, rTop } = csk;
    v -= (Math.PI * depth / 3) * (R * R + R * rTop + rTop * rTop) - Math.PI * R * R * depth;
  }
  for (const b of solveSheet(spec).bends) {
    const L = b.q1 - b.q0;
    v += (b.theta / 2) * ((r + t) ** 2 - r ** 2) * L - bendAllowance(spec, b.angle) * t * L;
  }
  return v;
}

/**
 * True when the part script has code outside the sheet-metal block (other
 * than comments and `return part;`): the 3D part then differs from what
 * the spec exports.
 */
export function sheetScriptHasExtras(script) {
  const s = String(script ?? '');
  const i = s.indexOf(SHEET_METAL_BEGIN);
  const j = i >= 0 ? s.indexOf(SHEET_METAL_END, i) : -1;
  if (i < 0 || j < 0) return false;
  const rest = `${s.slice(0, i)}\n${s.slice(j + SHEET_METAL_END.length)}`
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\breturn\s+part\s*;?/g, '')
    .replace(/\s+/g, '');
  return rest.length > 0;
}

/**
 * { dfm, flat, files: { dxf, step }, blocked, stepSource, meshStale }.
 * STEP comes from the spec (`stepSource: 'spec'`). Only when the B-rep
 * cannot be built does it fall back to `mesh` (the last built mesh;
 * `stepSource: 'mesh'`), and only then is a mesh/spec volume mismatch
 * flagged `mesh-stale`. `script` (the part script) flags edits outside the
 * sheet block (`script-extras`): those are in the 3D part, not in the files.
 * `exactStep: false` forces the mesh fallback (goldens).
 */
export function buildSheetExport(spec, { mesh = null, script = null, partName = '', timestamp, exactStep = true, unit = 'mm' } = {}) {
  const dfm = checkSheetDfm(spec, { unit });
  const issues = [...dfm.issues];
  const flat = dfm.flat;
  const base = sheetFileBase(partName, spec?.sku);
  let step = null;
  let stepSource = null;
  let brepError = null;
  if (flat && exactStep) {
    try {
      const brep = buildSheetBrep(spec);
      step = { name: `${base}.step`, mime: 'model/step', ...brepToStep(brep, { name: base, timestamp }), stats: brep.stats };
      stepSource = 'spec';
    } catch (err) {
      brepError = String(err?.message || err);
    }
  }
  let meshStale = false;
  if (!step && mesh?.vertProperties) {
    step = { name: `${base}.step`, mime: 'model/step', ...meshToStep(mesh, { name: base, timestamp }) };
    stepSource = 'mesh';
    issues.push({ level: 'warn', rule: 'step-faceted', message: 'Exact bends could not be built for this sheet — STEP uses the faceted 3D part, so SendCutSend may not see the bends.', featureId: null });
    if (flat) {
      const want = sheetExpectedVolume(spec, flat);
      const got = meshVolume(mesh);
      // Faceting moves this a little; 5% means a different part.
      meshStale = !(want > 0) || Math.abs(got - want) / want > 0.05;
      if (meshStale) {
        issues.push({ level: 'warn', rule: 'mesh-stale', message: 'The 3D part does not match the sheet spec (run pending or script edited) — this STEP uses the 3D part.', featureId: null });
      }
    }
  }
  if (sheetScriptHasExtras(script)) {
    issues.push({ level: 'warn', rule: 'script-extras', message: 'The part script has edits outside the sheet-metal block. DXF and STEP are built from the sheet spec and do not include them.', featureId: null });
  }
  const files = {
    dxf: flat ? { name: `${base}-flat.dxf`, mime: 'application/dxf', text: sheetFlatDxf(flat) } : null,
    step,
  };
  const fails = issues.filter((x) => x.level === 'fail').length;
  return { dfm: { ...dfm, issues, warns: issues.length - fails }, flat, files, blocked: fails > 0, stepSource, brepError, meshStale };
}
