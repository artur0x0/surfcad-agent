---
name: surfcad
description: "Build complete SurfCAD assemblies on the Manifold kernel, in millimetres: multi-part .surf.json models, booleans, fillets, chamfers, shells, lofts, and sheet metal. Use when the user wants a real part or assembly designed, changed, checked, or exported to STL, 3MF, or STEP."
license: Apache-2.0
compatibility: Node.js 20 or newer for the vendored surfcad package. The surfcad MCP server (npx -y surfcad-mcp@0.1.0) runs the verify loop when connected. No API keys.
metadata:
  version: "0.1.0"
  homepage: "https://github.com/artur0x0/surfcad-agent"
allowed-tools: Read Write Bash
---

# SurfCAD

SurfCAD (surfcad.com) models solids on a custom Manifold kernel. You bring the model. There is no SurfCAD API key.

This skill is for a finished assembly, not a demo cube. Plan the parts, write each script in millimetres, keep the assembly document in sync, and do not stop until the verify loop below passes.

The helper library is the npm package `surfcad`. Its kernel is the vendored `built/manifold.js` and `built/manifold.wasm`, not npm `manifold-3d`. Read the catalogs through these references (one level down):

- [Helpers](references/helpers.md) — all 71 injected helpers, grouped, with signatures, parameters, and examples
- [Manifold API](references/manifold-api.md) — `Manifold`, `CrossSection`, `Mesh`, and the module functions on this build
- [Assembly format](references/assembly-format.md) — `.surf.json`, `{ id, path }`, the `// @surf-id` header, the `local-` prefix
- [Sheet metal](references/sheet-metal.md) — spec, script markers, DFM rules, true-curve STEP
- [Modeling workflow](references/modeling-workflow.md) — decomposition, datums, helper order
- [Failure modes](references/failure-modes.md) — invalid solids, fillet failures, helper-name shadowing, how to recover
- [Examples](references/examples.md) — complete runnable scripts, including a multi-part assembly

## 1. Plan the assembly before writing solids

Decompose the product into parts that are manufactured separately. A bent cover is one sheet-metal part. A machined plate and the posts on it are different parts even when they touch. Name a datum on each part (usually the centre of the mating face, or a corner the drawing already uses) and write every number in millimetres.

For each part, decide:

- stock primitive (`Manifold.cube`, `Manifold.cylinder`, `Manifold.sphere`, `hexPrism`, `tube` / `rectTube`, `roundedBox`, or a loft)
- the features that remove or add material (holes, pockets, bosses, ribs)
- the blends last (fillet or chamfer), after the topology they apply to exists
- whether the part is sheet metal (a spec passed to `sheetMetalSolid`) instead of a stack of booleans

One part is one script. The script `return`s a Manifold. Several bodies in that return are still one part when they were composed on purpose (`add(..., { merge: false })` or `Manifold.compose`). Separate manufactured pieces belong in separate scripts, referenced from `.surf.json`.

## 2. Helpers first, raw Manifold when the helper does not exist

`runScript` evaluates the script as the body of `new Function` in strict mode. The parameters are the Manifold API plus every name in `HELPER_FUNCTIONS`. Call those names directly. Do not import them.

Prefer a helper when one exists. It knows the kernel's face ids, the dihedral, and the empty-solid checks:

- walls: `hollow` (the finished shell) or `shell` (the cavity you subtract)
- draft: `addDraft`, `draftFaces`
- holes on a face frame: `hole`, `holePattern`, `clearanceHole`, `tapDrillHole`, `cboreHole`, `cskHole`
- blends: `filletEdges` on `convexEdges`; `filletAlongPath` on a `makeSweepPath`; `chamferEdges` for an equal-leg chamfer
- placement: `workplaneFromFace`, `placeOnFace`, `placeInFrame`, `transformByFrame`
- patterns: `array3D`, `polarArray`, `mirror`
- another part's solid, frozen: `externalBody`
- a boolean of bodies you pick by centroid: `booleanBodies`
- sheet metal: `sheetMetalSolid(sheetSpec)`

Use raw `Manifold` for stock and for booleans the helpers do not cover: `Manifold.cube`, `Manifold.cylinder`, `Manifold.union`, `Manifold.difference`, `Manifold.intersection`, and `part.add` / `part.subtract` / `part.intersect`. `part.add(other, { merge: false })` keeps both bodies. `Manifold.compose` does the same.

Do not call npm-only Manifold methods that this build does not ship. The method list is [manifold-api.md](references/manifold-api.md). `status()` on this wasm is an enum object. Compare the `runScript` result field `status` to `"NoError"`. Do not compare `manifold.status()` to the string `"NoError"`.

## 3. Order booleans, fillets, chamfers, shells, and lofts

Build in this order. Re-query edges and faces after every boolean. An edge list from the previous solid is not valid on the next one.

1. Stock, centred or seated on the datum. Record the bounding box you expect.
2. Large features: bosses, ribs, pockets, `cut`, `booleanBodies`. `cut` keeps pieces as separate bodies. Pass `keep` or `drop`, not both.
3. Holes, after the face they sit on exists. Take the frame from `workplaneFromFace`. `clearanceHole` and `tapDrillHole` look up the drill diameter from the size token (`'M4'`, `'M3'`, `'#8-32'`).
4. Convex fillets and chamfers on the edges that exist now. `filletEdges(part, convexEdges(part), radius)` or a filter of those edges (a vertical corner has `Math.abs(e.tangent[2]) > 0.99`). `opts.sphericalCorners: true` rounds a box corner where three equal fillets meet. `chamferEdges(part, edges, c)` uses `c` as the leg length and applies one difference per edge.
5. Shell or hollow after the outer fillets when the wall has to follow the blend. `hollow(part, thickness, opening)` returns the walls. `opening` is `'+z'`-style `'z'` / `'-z'` / `'x'` / `'-y'`, `'none'`, a face from `facesByNormal`, or a `{ center, normal }` pick. A thickness the body cannot take throws. A fillet after the hollow is a cavity corner: keep its radius below the wall.
6. Concave (interior) edges are not `filletEdges` input. `filletEdges` throws on a concave edge. `concaveEdges` lists them. Rounding them adds material; `filletAlongPath` sweeps a cutter and subtracts, so it does not round a concave corner.
7. Lofts: `makeLoft` of two or more `makeCrossSection` values on parallel planes (`offsetPlaneFrame` along the same normal), then `placeInFrame`. The legacy `loft({ bottomCS, topCS, height })` is the two-section form. Profiles come from `profileCircle`, `profileRectangle`, `profilePolygon`.

`filletAlongPath(part, makeSweepPath(edges), radius)` is the sweep fillet for a closed rim, a curved-adjacent edge, or a second blend along a path. `opts.profile: 'chamfer'` sweeps an equal-leg chamfer instead. Do not drop the short tessellation segments of a circular rim before filleting. `filletEdges` already treats a closed circular chain as one revolved cutter.

Details and the reasons for this order are in [modeling workflow](references/modeling-workflow.md).

## 4. Multi-part assemblies and `.surf.json`

Each manufactured part is a script file. The first line is the stable id:

```text
// @surf-id local-2026-10-08-01-00-00-0001-a11a
```

The id matches `YYYY-MM-DD-HH-MM-SS-NNNN-hhhh` (four hex digits at the end). The `local-` prefix means the part has not been pushed. Drop `local-` only when the id is the pushed one. Do not invent a second shape.

The assembly file is `assemblies/<Name>/.surf.json`:

- `format` is `surfcad.assembly` and `version` is `1`
- `parts[]` rows reference scripts by `{ id, path }`. `path` is repo-relative (`assemblies/<Name>/<Part>.js` or `parts/<Part>.js`). The script body is not inlined.
- `position` is `[x, y, z]` millimetres, the row's translation in the assembly
- a copied row sets `copiedFrom` to the source surf id and uses its own id
- `sheetMetal.sku` is required when the row is bound to a sheet SKU

The row `id` and the script's `// @surf-id` are the same id for that file. A second instance of a part is another row with its own id, `copiedFrom`, the same `path`, and its own `position`.

To check fit in one headless run, build each part in a function and place copies with `externalBody(fn, { offset })`. `externalBody` freezes the solid. Editing the source later does not update the copy. `booleanBodies` picks bodies by vertex centroid (`{ at: [x, y, z] }`) when a part already contains several bodies.

The field list is [assembly format](references/assembly-format.md). A full base, standoff, `.surf.json`, and five-body check script are in [examples](references/examples.md).

## 5. Sheet metal and DFM

A sheet part is a spec, not a hollowed box. The script carries a marked block:

```javascript
// --- sheet-metal begin ---
const sheetSpec = { v: 1, sku: 'ALU-090', t: 1.63, r: 1.5, k: 0.44, plane: 'XY', width: 80, height: 50, bends: [], tabs: [], holes: [] };
let part = sheetMetalSolid(sheetSpec);
// --- sheet-metal end ---
return part;
```

`sku` is the SendCutSend key. `t`, `r`, and `k` are millimetres and the k-factor. `plane` is `'XY'`, `'XZ'`, or `'YZ'`. Bends, tabs, and holes are the arrays in [sheet metal](references/sheet-metal.md). The base flange is centred, `width` by `height`.

DFM limits travel with the spec (`limits`, from the SKU) so a check does not need the network. Hard fails (flange shorter than the minimum, angle out of range, hole too small, hole too close to an edge or a bend, flat outside the sheet size, bends on a SKU that does not bend) block export. Warnings do not. `checkSheetDfm` is the in-app entry. Headless STEP goes through `sheetSpecToStep(spec, { mesh, script, name })`.

Export of a folded spec uses the true-curve writer: `stepSource === 'spec'`, and the STEP text contains `CYLINDRICAL_SURFACE`. A spec that cannot fold falls back to the faceted mesh (`stepSource` is not `'spec'`) and reports `blocked` or `brepError`. Do not add geometry outside the marked block if the DXF and STEP must match the spec. Code outside the block warns as `script-extras`.

## 6. When a run fails

Stop and read the error. Do not return the unfilleted solid and do not swallow the throw.

- `status` other than `"NoError"`, or a helper that says `result is EMPTY (volume 0)` or `not a valid solid`: the boolean ate the part or the inputs were degenerate. Shrink the cutter, confirm the tool actually intersects the target, and check `volume` and `bodyCount`.
- `filletEdges`: a singleton edge on a curved face throws. A concave edge throws. A closed circular rim that would revolve through its own axis throws. Short singleton edges can be skipped, but if every requested edge is skipped the helper throws. Pass `convexEdges` output (or a filter that still carries `a`, `b`, `va`, `vb`). Re-query after the previous feature.
- `filletAlongPath`: `sweep cutter is not a valid solid`, `result is EMPTY (cutter consumed the solid) — reduce radius`, or a bad compose. Reduce `radius`. Keep the full wire, including micro-segments on a previous blend.
- `chamferEdges`: the first degenerate edge throws. Do not chamfer every convex edge of a ribbed junction in one call. Chamfer the edges you mean.
- `hollow` / `moveFace` / `deleteFace` / `draftFaces`: a face that is no longer on the body throws. A draft of a face perpendicular to the pull throws. `deleteFace` on a cube face throws because the neighbours do not meet. Re-pick from `facesByNormal` on the current solid.
- Helper-name shadowing: a top-level `let hollow` throws `Identifier 'hollow' has already been declared`. Helpers are parameters of the function the script runs in. The same applies to `const`, `var`, `function`, and `class` with any helper name (`cut`, `move`, `shell`, `center`, `edge`, `loft`, `sweep`, …). Name the binding something else (`wall`, `cavity`, `shifted`). Do not wrap the script in another function to hide the clash.

The full list and the recovery for each is [failure modes](references/failure-modes.md).

## 7. Verify loop

Repeat this until every part and the assembly pass. Connected MCP tool names are `run`, then the measure (bbox, volume, part count), `export`, and `preview`. They read the same fields as `runScript` / `exportResult` from the `surfcad` package. If the MCP server is not connected, call that package. Do not invent a different result shape.

1. **Run** the script. A throw is a failed part. Fix it before measuring.
2. **Status.** `status === 'NoError'`.
3. **Bounding box.** `boundingBox.min` and `boundingBox.max` are finite, max is greater than min on every axis that has thickness, and the box matches the datum and the envelope you planned (millimetres).
4. **Volume.** `volume` sits in the band you expect (stock volume minus the holes and fillets you can estimate). A volume of 0 is a failure even if you forgot to read `status`.
5. **Part count.** `bodyCount` (and `parts.length`) equals the number of bodies you meant to keep. `parts[i].at` is that body's vertex centroid. A plate plus four unmerged posts is 5.
6. **Export.** `exportResult(result, 'stl' | '3mf' | 'step')` returns bytes. STL is longer than an 84-byte header. 3MF starts with the ZIP bytes `PK`. STEP text contains `ISO-10303-21` and `MANIFOLD_SOLID_BREP`. For a folded sheet, call `sheetSpecToStep` and require `stepSource === 'spec'` and `CYLINDRICAL_SURFACE` when the spec has bends and `blocked` is false.
7. **Preview** the mesh (`mesh.triVerts`, `mesh.vertProperties`) or the exported file and look at the mating faces, the open side of a shell, and the bend.

Then delete the manifold (`result.manifold.delete()`) so the next run does not leak the wasm heap.

Check every part script on its own, then the assembly positions. A part that passes alone can still collide once `position` is applied. The five-body script in [examples](references/examples.md) is the pattern for that check.
