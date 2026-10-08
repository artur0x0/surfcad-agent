/**
 * Install the packed tarball into a throwaway node_modules and run a solid.
 * Proves wasm resolution does not depend on the process working directory.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '../packages/surfcad');

test('node_modules install resolves wasm and runs a cube', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'surfcad-install-'));
  try {
    const raw = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tmp], {
      cwd: pkg,
      encoding: 'utf8',
    });
    const packed = JSON.parse(raw.slice(raw.indexOf('[')));
    const tgz = join(tmp, packed[0].filename);
    const proj = join(tmp, 'proj');
    mkdirSync(proj);
    writeFileSync(join(proj, 'package.json'), JSON.stringify({
      name: 'surfcad-install-probe',
      private: true,
      type: 'module',
    }));
    execFileSync('npm', ['install', '--ignore-scripts', tgz], { cwd: proj, stdio: 'inherit' });
    const out = execFileSync('node', ['--input-type=module', '-e', `
      import { runScript, wasmPath, modulePath } from 'surfcad';
      import { existsSync } from 'node:fs';
      if (!existsSync(wasmPath)) throw new Error('missing wasm ' + wasmPath);
      if (!wasmPath.includes('node_modules/surfcad/vendor/built/manifold.wasm')) {
        throw new Error('wasm not inside the installed package: ' + wasmPath);
      }
      if (!existsSync(modulePath)) throw new Error('missing factory ' + modulePath);
      const result = await runScript('return Manifold.cube([10, 20, 30], true);');
      if (result.status !== 'NoError') throw new Error(result.status);
      if (!(result.volume > 5000 && result.volume < 7000)) throw new Error('vol ' + result.volume);
      if (result.bodyCount !== 1) throw new Error('bodies ' + result.bodyCount);
      result.manifold?.delete?.();
      console.log('ok');
    `], { cwd: proj, encoding: 'utf8' });
    assert.match(out, /ok/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
