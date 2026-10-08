/**
 * Public entry for the SurfCAD helper library.
 *
 * Helpers and the custom Manifold kernel are vendored from 3dculos at the
 * commit in `./UPSTREAM` (`packages/surfcad/vendor`). This module does not
 * load npm `manifold-3d`.
 *
 * `wasmPath` is the absolute path of `vendor/built/manifold.wasm`, resolved
 * from this file's URL. That is the package directory both when the folder
 * is checked out and when it is installed under `node_modules/surfcad`, so
 * the kernel does not depend on the process working directory.
 *
 * @module surfcad
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadManifold as loadVendoredManifold,
  runScript as runVendoredScript,
} from './vendor/src/lib/surfcad/index.js';

const packageRoot = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the vendored `built/manifold.js` factory. */
export const modulePath = join(packageRoot, 'vendor', 'built', 'manifold.js');

/** Absolute path of the vendored `built/manifold.wasm` next to that factory. */
export const wasmPath = join(packageRoot, 'vendor', 'built', 'manifold.wasm');

export {
  helperScope,
  HELPER_FUNCTIONS,
  meshToStl,
  meshTo3mfBytes,
  meshToStepBytes,
  sheetSpecToStep,
  exportResult,
} from './vendor/src/lib/surfcad/index.js';

/**
 * True when the caller already chose a kernel instance or factory.
 * @param {object} [opts]
 */
function hasKernelOverride(opts) {
  return !!(
    opts
    && (opts.manifold || opts.module || opts.modulePath || opts.wasmPath || typeof opts.locateFile === 'function')
  );
}

/**
 * Options that load this package's wasm, unless the caller passed a kernel.
 * @param {object} [opts]
 */
function withPackageKernel(opts = {}) {
  if (hasKernelOverride(opts)) return opts;
  return { ...opts, modulePath, wasmPath };
}

/**
 * Resolve a Manifold module.
 * An explicit `manifold`, `module`, `modulePath`, `wasmPath`, or `locateFile`
 * is forwarded. Otherwise the vendored factory is loaded and `locateFile`
 * returns {@link wasmPath}.
 *
 * @param {object} [opts]
 * @param {object} [opts.manifold] already constructed module
 * @param {object} [opts.module] alias of `manifold`
 * @param {string} [opts.modulePath] path to a manifold.js factory
 * @param {string} [opts.wasmPath] wasm file for that factory
 * @param {Function} [opts.locateFile]
 * @returns {Promise<object>}
 */
export async function loadManifold(opts = {}) {
  return loadVendoredManifold(withPackageKernel(opts));
}

/**
 * Run a user script the way the SurfCAD worker does.
 * The script body is `"use strict"` plus the source, passed to
 * `new Function` whose parameters are the helper names. A top-level
 * `let` or `const` that reuses a helper name (for example `let hollow`)
 * is a syntax error. The script must `return` a Manifold.
 *
 * @param {string} source
 * @param {object} [opts] same kernel options as {@link loadManifold}, plus `importedModels`
 * @returns {Promise<{
 *   manifold: object,
 *   mesh: object,
 *   volume: number,
 *   surfaceArea: number|null,
 *   status: string,
 *   tris: number,
 *   boundingBox: { min: number[], max: number[] },
 *   bodyCentroids: number[][],
 *   bodyCount: number,
 *   parts: { index: number, at: number[] }[]
 * }>}
 */
export async function runScript(source, opts = {}) {
  return runVendoredScript(source, withPackageKernel(opts));
}
