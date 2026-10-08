/**
 * Every javascript fence in the skill examples is a complete script.
 * It must return a valid solid through the vendored runtime.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScript } from '../packages/surfcad/index.js';

const examplesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../plugins/surfcad/skills/surfcad/references/examples.md',
);

function scriptsIn(markdown) {
  const out = [];
  const re = /```javascript\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(markdown))) out.push(match[1]);
  return out;
}

const sources = scriptsIn(readFileSync(examplesPath, 'utf8'));

test('examples.md has several complete scripts, including one assembly', () => {
  assert.ok(sources.length >= 4, `found ${sources.length} scripts`);
  assert.ok(sources.some((source) => source.includes('externalBody')));
  assert.ok(sources.some((source) => source.includes('.surf.json') || source.includes('@surf-id')));
});

for (const [index, source] of sources.entries()) {
  test(`examples.md script ${index + 1} is a valid solid`, async () => {
    const result = await runScript(source);
    assert.equal(result.status, 'NoError', result.status);
    assert.ok(result.volume > 0, `vol=${result.volume}`);
    assert.ok(result.bodyCount >= 1);
    for (const n of [...result.boundingBox.min, ...result.boundingBox.max]) {
      assert.ok(Number.isFinite(n));
    }
    assert.ok(result.boundingBox.max[0] > result.boundingBox.min[0]);
    const expected = source.match(/@check bodyCount (\d+)/);
    if (expected) assert.equal(result.bodyCount, Number(expected[1]));
    try { result.manifold?.delete?.(); } catch { /* already freed */ }
  });
}
