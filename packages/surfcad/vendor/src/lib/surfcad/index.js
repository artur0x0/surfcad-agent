/**
 * Node entry for the SurfCAD helper runtime.
 *
 * The browser worker (`src/workers/sandboxWorker.js`) binds the same module.
 * The kernel is the shipped `built/manifold.js` factory (custom embind build),
 * not the npm `manifold-3d` package. Pass `manifold` / `module` to inject one,
 * or `modulePath` (and optional `wasmPath`) to load another copy of that factory.
 */
import { pathToFileURL } from 'node:url';
import {
  initializeManifold,
  bindManifoldModule,
  loadBundledManifold,
  manifoldReady,
  runPreparedScript,
  helperScope,
  HELPER_FUNCTIONS,
  getManifoldModule,
} from './runtime.js';

export {
  helperScope,
  HELPER_FUNCTIONS,
  getManifoldModule,
  bindManifoldModule,
  initializeManifold,
  loadBundledManifold,
  manifoldReady,
};

/**
 * Resolve a Manifold module.
 * - `manifold` or `module`: use this instance (already constructed).
 * - `modulePath`: dynamic-import that ESM factory (file path). `wasmPath` or
 *   `locateFile` is forwarded to the factory.
 * - otherwise: the shipped `built/manifold.js` next to this repo.
 * Does not call setup(); `runScript` / `bindManifoldModule` do.
 */
export async function loadManifold(opts = {}) {
  if (opts?.manifold) return opts.manifold;
  if (opts?.module) return opts.module;
  if (opts?.modulePath) {
    const href = pathToFileURL(opts.modulePath).href;
    const imported = await import(href);
    const factory = imported.default ?? imported;
    if (typeof factory !== 'function') {
      throw new Error(`loadManifold: ${opts.modulePath} has no factory default export`);
    }
    const args = {};
    if (typeof opts.locateFile === 'function') args.locateFile = opts.locateFile;
    else if (opts.wasmPath) args.locateFile = () => opts.wasmPath;
    return factory(args);
  }
  return loadBundledManifold(opts);
}

/**
 * Run a user script the way the app's worker does and return the solid.
 * Evaluation is `executeScript`: `"use strict"` plus `new Function` whose
 * parameters are the helper names, so a top-level `let hollow` still shadows
 * the helper. Feature-trace hooks and the limited `window` import bag are
 * injected the same way. Worker global lockdown (blocking `fetch` on the
 * worker global) is not applied here; it would freeze the host process.
 *
 * @param {string} source
 * @param {object} [opts]
 * @param {object} [opts.manifold] injected Manifold module instance
 * @param {object} [opts.module] alias of manifold
 * @param {string} [opts.modulePath] path to a manifold.js factory
 * @param {string} [opts.wasmPath] WASM file for that factory
 * @param {object} [opts.importedModels] filename → meshData, as the worker execute message
 * @returns {Promise<{ manifold, mesh, volume, surfaceArea, status, tris, boundingBox, bodyCentroids, bodyCount, parts }>}
 */
export async function runScript(source, opts = {}) {
  if (opts?.manifold || opts?.module) {
    bindManifoldModule(opts.manifold || opts.module, { setup: opts.setup !== false });
  } else if (opts?.modulePath || opts?.wasmPath || typeof opts?.locateFile === 'function') {
    const mod = await loadManifold(opts);
    bindManifoldModule(mod, { setup: opts.setup !== false });
  } else if (!manifoldReady()) {
    await initializeManifold();
  }
  return runPreparedScript(source, opts);
}

export {
  meshToStl,
  meshTo3mfBytes,
  meshToStepBytes,
  sheetSpecToStep,
  exportResult,
} from './export.js';
