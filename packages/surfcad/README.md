# surfcad

Helper library for [SurfCAD](https://surfcad.com) on the custom Manifold kernel. Version 0.1.0. Apache-2.0.

npm `surfcad@0.0.1` is a reserved placeholder ("coming soon"). This package is the helper library and is not published from this pre-release.

The implementation is vendored from [3dculos](https://github.com/artur0x0/3dculos) at the full commit SHA in `UPSTREAM`. `node ../../scripts/sync-3dculos.mjs` (from this directory's repo root: `npm run sync`) downloads that commit and copies the `sync-files.json` file list into `vendor/`, including `vendor/built/manifold.wasm`. Do not point this package at npm `manifold-3d`. That build reports `status()` as a string. This one uses an enum.

```javascript
import { runScript, exportResult, wasmPath } from 'surfcad';

const result = await runScript(`
  const part = Manifold.cube([24, 18, 12], true);
  const vertical = convexEdges(part).filter((e) => Math.abs(e.tangent[2]) > 0.99);
  return filletEdges(part, vertical, 1.5);
`);
const stl = await exportResult(result, 'stl');
```

`wasmPath` is absolute and derived from this file's URL, so the wasm resolves when the package sits in `node_modules/surfcad`. A top-level `let hollow` in a script throws: helper names are parameters of the function that runs the script.

`runScript` returns `{ manifold, mesh, volume, surfaceArea, status, tris, boundingBox, bodyCentroids, bodyCount, parts }`. `status` is `'NoError'` when the solid is valid.
