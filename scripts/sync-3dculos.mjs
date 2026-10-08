#!/usr/bin/env node
/**
 * Vendor the pinned 3dculos SurfCAD runtime into packages/surfcad/vendor.
 *
 * Reads the full commit SHA from packages/surfcad/UPSTREAM, downloads
 * https://github.com/artur0x0/3dculos at that SHA (GitHub tarball), and
 * copies every runtimeFiles and catalogFiles path from
 * src/lib/surfcad/catalog/sync-files.json. Paths are kept, including
 * built/manifold.wasm. Writes vendor/MANIFEST.json (sha256 of each
 * copied file). Does not import the 3dculos checkout by relative path.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgRoot = join(repoRoot, 'packages/surfcad');
const upstreamPath = join(pkgRoot, 'UPSTREAM');
const vendorRoot = join(pkgRoot, 'vendor');
const REPO = 'artur0x0/3dculos';

function fail(message) {
  console.error(`sync-3dculos: ${message}`);
  process.exit(1);
}

function readPin() {
  if (!existsSync(upstreamPath)) fail(`missing ${upstreamPath}`);
  const text = readFileSync(upstreamPath, 'utf8');
  const sha = text.match(/\b([0-9a-f]{40})\b/);
  if (!sha) fail('UPSTREAM must contain one full 40-character commit SHA');
  return sha[1];
}

function findFile(root, name) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === name) hits.push(path);
    }
  };
  walk(root);
  return hits;
}

const sha = readPin();
const tarballUrl = `https://codeload.github.com/${REPO}/tar.gz/${sha}`;
const tmp = join(tmpdir(), `surfcad-sync-${sha.slice(0, 12)}-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const tarPath = join(tmp, 'upstream.tar.gz');
console.log(`sync-3dculos: fetching ${tarballUrl}`);
try {
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', tarPath, tarballUrl], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
} catch {
  fail(`could not download ${tarballUrl}`);
}

const extractRoot = join(tmp, 'src');
mkdirSync(extractRoot);
try {
  execFileSync('tar', ['-xzf', tarPath, '-C', extractRoot], { stdio: 'inherit' });
} catch {
  fail('could not extract the upstream tarball (tar required)');
}

const syncHits = findFile(extractRoot, 'sync-files.json').filter((path) =>
  path.endsWith('/src/lib/surfcad/catalog/sync-files.json'),
);
if (syncHits.length !== 1) {
  fail(`expected one src/lib/surfcad/catalog/sync-files.json, found ${syncHits.length}`);
}
const prefix = syncHits[0].slice(0, -'src/lib/surfcad/catalog/sync-files.json'.length);

let sync;
try {
  sync = JSON.parse(readFileSync(syncHits[0], 'utf8'));
} catch (err) {
  fail(`sync-files.json did not parse: ${err.message}`);
}

const runtimeFiles = sync.runtimeFiles;
const catalogFiles = sync.catalogFiles;
if (!Array.isArray(runtimeFiles) || !Array.isArray(catalogFiles)) {
  fail('sync-files.json needs runtimeFiles and catalogFiles arrays');
}
const files = [...runtimeFiles, ...catalogFiles];
if (files.length === 0) fail('sync-files.json copy list is empty');
if (!files.includes('built/manifold.wasm')) fail('sync-files.json does not list built/manifold.wasm');

const hashed = {};
rmSync(vendorRoot, { recursive: true, force: true });
for (const rel of files) {
  if (typeof rel !== 'string' || rel.startsWith('/') || rel.split('/').includes('..')) {
    fail(`refusing unsafe sync path ${rel}`);
  }
  const src = join(prefix, rel);
  if (!existsSync(src) || !statSync(src).isFile()) fail(`upstream is missing ${rel}`);
  const bytes = readFileSync(src);
  if (rel.endsWith('.wasm') && bytes.byteLength < 1000) fail(`${rel} is unexpectedly small`);
  const dest = join(vendorRoot, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  hashed[rel] = createHash('sha256').update(bytes).digest('hex');
}

const manifest = {
  upstream: `https://github.com/${REPO}`,
  commit: sha,
  algorithm: 'sha256',
  files: hashed,
};
writeFileSync(join(vendorRoot, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`sync-3dculos: vendored ${files.length} files from ${sha} into packages/surfcad/vendor`);
