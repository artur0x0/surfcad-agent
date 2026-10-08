/**
 * Node-side export of a runScript mesh. No file-saver, no DOM.
 * STEP for a sheet spec uses the existing true-curve B-rep writer
 * (`sheetBrep` → `brepToStep`). Any other solid uses `meshToStep`
 * (coplanar faces merged, curved regions stay faceted).
 */
import { export3MF } from '../../utils/model-io.js';
import { meshToStep } from '../../utils/sheetMetal/stepExport.js';
import { buildSheetExport } from '../../utils/sheetMetal/sheetExport.js';

function meshArrays(mesh) {
  const np = mesh?.numProp || 3;
  const vp = mesh?.vertProperties;
  const tv = mesh?.triVerts;
  if (!vp || !tv) throw new Error('export: mesh needs vertProperties and triVerts');
  return { np, vp, tv };
}

/** Binary STL (mm, as stored). Returns a Uint8Array. */
export function meshToStl(mesh) {
  const { np, vp, tv } = meshArrays(mesh);
  const nTri = Math.floor(tv.length / 3);
  const buf = new Uint8Array(84 + nTri * 50);
  const view = new DataView(buf.buffer);
  const header = 'SurfCAD binary STL';
  for (let i = 0; i < 80; i++) buf[i] = i < header.length ? header.charCodeAt(i) : 0;
  view.setUint32(80, nTri, true);
  let o = 84;
  const vert = (index) => [
    vp[index * np],
    vp[index * np + 1],
    vp[index * np + 2],
  ];
  for (let i = 0; i < nTri; i++) {
    const a = vert(tv[i * 3]);
    const b = vert(tv[i * 3 + 1]);
    const c = vert(tv[i * 3 + 2]);
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(o, nx / len, true); o += 4;
    view.setFloat32(o, ny / len, true); o += 4;
    view.setFloat32(o, nz / len, true); o += 4;
    for (const p of [a, b, c]) {
      view.setFloat32(o, p[0], true); o += 4;
      view.setFloat32(o, p[1], true); o += 4;
      view.setFloat32(o, p[2], true); o += 4;
    }
    view.setUint16(o, 0, true); o += 2;
  }
  return buf;
}

/** 3MF package bytes (uncompressed OPC zip, same writer as the app). */
export async function meshTo3mfBytes(mesh, opts = {}) {
  meshArrays(mesh);
  const blob = await export3MF(mesh, opts.name || 'model', {
    unit: opts.unit || 'millimeter',
    title: opts.title || opts.name || 'SurfCAD part',
    designer: opts.designer || 'SurfCAD',
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Faceted STEP AP214 text, encoded as UTF-8 bytes. `{ bytes, text, stepSource }`. */
export function meshToStepBytes(mesh, opts = {}) {
  meshArrays(mesh);
  const step = meshToStep(mesh, { name: opts.name || 'SurfCAD part' });
  const text = step.text || '';
  return {
    bytes: new TextEncoder().encode(text),
    text,
    stepSource: 'mesh',
    faces: step.faces,
  };
}

/**
 * Sheet-metal STEP. `exactStep` (default true) builds cylinders at bends
 * via `buildSheetExport`. Returns `{ bytes, text, stepSource, blocked, dfm }`.
 */
export function sheetSpecToStep(spec, opts = {}) {
  const bundle = buildSheetExport(spec, {
    mesh: opts.mesh || null,
    script: opts.script || null,
    partName: opts.name || opts.partName || '',
    exactStep: opts.exactStep !== false,
    unit: opts.unit || 'mm',
  });
  const text = bundle.files?.step?.text || '';
  return {
    bytes: new TextEncoder().encode(text),
    text,
    stepSource: bundle.stepSource,
    blocked: bundle.blocked,
    dfm: bundle.dfm,
    brepError: bundle.brepError || null,
  };
}

/**
 * `format` is `'stl' | '3mf' | 'step'`.
 * For `'step'`, pass `sheetSpec` to get the true-curve writer when the spec
 * can be folded. Otherwise the mesh writer is used.
 * Returns bytes (Uint8Array). STEP also available as text via the dedicated helpers.
 */
export async function exportResult(result, format, opts = {}) {
  const mesh = result?.mesh || result;
  const kind = String(format || '').toLowerCase();
  if (kind === 'stl') return meshToStl(mesh);
  if (kind === '3mf') return meshTo3mfBytes(mesh, opts);
  if (kind === 'step') {
    if (opts.sheetSpec) return sheetSpecToStep(opts.sheetSpec, { ...opts, mesh }).bytes;
    return meshToStepBytes(mesh, opts).bytes;
  }
  throw new Error(`exportResult: format must be stl, 3mf, or step (got ${format})`);
}
