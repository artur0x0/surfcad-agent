import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '../packages/surfcad');

test('npm pack --dry-run includes the wasm and the catalogs', () => {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: pkg,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw.slice(raw.indexOf('[')));
  const paths = parsed[0].files.map((file) => file.path);
  for (const required of [
    'vendor/built/manifold.wasm',
    'vendor/built/manifold.js',
    'vendor/src/lib/surfcad/catalog/helpers.json',
    'vendor/src/lib/surfcad/catalog/manifold.json',
    'vendor/src/lib/surfcad/catalog/assembly.schema.json',
    'vendor/src/lib/surfcad/catalog/sheet-metal.json',
    'vendor/src/lib/surfcad/catalog/sync-files.json',
    'index.js',
    'UPSTREAM',
  ]) {
    assert.ok(paths.includes(required), `pack missing ${required}`);
  }
});
