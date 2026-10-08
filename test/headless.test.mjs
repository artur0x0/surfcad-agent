/**
 * Mirrors 3dculos `golden:agent-headless`: filleted box, two-body assembly,
 * bent sheet. Validity, bbox, volume, body count, and non-empty STL / 3MF / STEP.
 * Imports the vendored package entry, not a relative path into 3dculos.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { exportResult, runScript, sheetSpecToStep } from '../packages/surfcad/index.js';

const sheetSpec = {
  v: 1,
  sku: 'ALU-090',
  material: 'Aluminum 5052',
  t: 1.63,
  r: 1.5,
  k: 0.44,
  limits: { bendable: true },
  plane: 'XY',
  width: 80,
  height: 50,
  bends: [{ id: 'b1', panel: 'base', edge: 'u+', angle: 90, length: 20 }],
  tabs: [],
  holes: [],
};

const filletScript = `
const part = Manifold.cube([24, 18, 12], true);
const vertical = convexEdges(part).filter((e) => Math.abs(e.tangent[2]) > 0.99);
if (vertical.length !== 4) throw new Error('expected 4 vertical edges, got ' + vertical.length);
return filletEdges(part, vertical, 1.5);
`;

const assemblyScript = `
const base = Manifold.cube([30, 20, 8], true);
const pin = Manifold.cylinder(14, 3, -1, 24, false).translate([0, 0, 4]);
return base.add(pin, { merge: false });
`;

const sheetScript = `
const sheetSpec = ${JSON.stringify(sheetSpec)};
return sheetMetalSolid(sheetSpec);
`;

function finiteBox(box) {
  if (!box?.min || !box?.max) return false;
  return [...box.min, ...box.max].every((n) => Number.isFinite(n));
}

async function expectSolid(source, { bodyCount, volumeMin, volumeMax }) {
  const result = await runScript(source);
  assert.equal(result.status, 'NoError');
  assert.ok(result.volume > volumeMin && result.volume < volumeMax, `vol=${result.volume}`);
  assert.ok(finiteBox(result.boundingBox));
  assert.ok(result.boundingBox.max[0] > result.boundingBox.min[0]);
  assert.ok(result.boundingBox.max[2] > result.boundingBox.min[2]);
  assert.equal(result.bodyCount, bodyCount);
  const stl = await exportResult(result, 'stl');
  const mf = await exportResult(result, '3mf');
  const step = await exportResult(result, 'step', { name: 'part' });
  assert.ok(stl.byteLength > 84, `stl bytes=${stl?.byteLength}`);
  assert.ok(mf.byteLength > 64 && mf[0] === 0x50 && mf[1] === 0x4b, `3mf bytes=${mf?.byteLength}`);
  const stepText = new TextDecoder().decode(step);
  assert.ok(step.byteLength > 64);
  assert.ok(stepText.includes('ISO-10303-21'));
  assert.ok(stepText.includes('MANIFOLD_SOLID_BREP'));
  try { result.manifold?.delete?.(); } catch { /* already freed */ }
  return result;
}

test('filleted box', async () => {
  await expectSolid(filletScript, { bodyCount: 1, volumeMin: 4500, volumeMax: 24 * 18 * 12 });
});

test('two-body assembly', async () => {
  await expectSolid(assemblyScript, {
    bodyCount: 2,
    volumeMin: 4800,
    volumeMax: 4800 + Math.PI * 9 * 14 + 50,
  });
});

test('bent sheet is valid and exports true-curve STEP', async () => {
  const sheet = await expectSolid(sheetScript, { bodyCount: 1, volumeMin: 1000, volumeMax: 80000 });
  const exact = sheetSpecToStep(sheetSpec, { name: 'bracket', mesh: sheet.mesh, script: sheetScript });
  const exactText = exact.text || '';
  assert.equal(exact.stepSource, 'spec');
  assert.equal(exact.blocked, false);
  assert.ok(exactText.includes('CYLINDRICAL_SURFACE'));
  assert.ok(exact.bytes.byteLength > 64);
});
