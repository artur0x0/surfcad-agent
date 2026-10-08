# Failure modes and recovery

Hand-written, from the helper runtime. A failed run throws. Do not catch it and return the previous solid.

`runScript` reports `status: 'NoError'` only when the returned solid is valid. Helpers that build a feature call the same check and throw on a bad status or on a volume at or below `1e-9`. The message looks like `filletEdges: bad result (...)` or `filletEdges: result is EMPTY (volume 0) — cutter consumed the solid or inputs were degenerate`. `cut`, `move`, and `booleanBodies` say `not a valid solid`.

## Invalid manifold

Symptoms: the script throws `bad result`, `not a valid solid`, or `result is EMPTY`, or `runScript` returns a `status` other than `'NoError'`.

Causes that actually show up:

- the tool missed the solid, or it consumed the solid (a hole span that erases a thin wall, a fillet radius larger than the corner allows, a boolean with coincident faces that collapses)
- `Manifold.difference` / `subtract` where the arguments were swapped
- a `cut` or `booleanBodies` that deleted every piece (`every piece was deleted`)
- stock with zero thickness, or a `tube` whose inner radius is not smaller than the outer

Recovery:

- print `volume`, `boundingBox`, and `bodyCount` on the solid from the line before the failing call
- shrink the cutter, or move it so the intersection has volume
- for `cut`, pass `keep` or `drop`, not both, and do not drop every piece
- for `booleanBodies`, the first `{ at }` is the target and must be a centroid of a real body (`parts[].at` from the previous run)

`status()` on the wasm object is an enum (`value === 0` when valid). npm `manifold-3d` returns the string `'NoError'`. Code that compares `status()` to that string is wrong on this kernel. Trust `runScript`'s `status` string, which is already normalized to `'NoError'`.

## Fillet and chamfer failures

`filletEdges(part, edges, radius, opts)`:

- Edges must come from `convexEdges` (or otherwise carry `a`, `b`, `va`, `vb`). A hand-built edge without that data does not frame.
- A concave edge throws. Use `concaveEdges` only to find them. Rounding a concave corner adds material. `filletEdges` removes it.
- A singleton edge whose neighbour is curved throws the planar-face check. A closed chain that fits a circle skips that check and is revolved as one rim. If the radius would revolve through the rim axis, it throws rather than clipping.
- The per-edge size guard skips a singleton that is too short for the radius (`t < 0.45 * length` fails). Those skips are silent only while some other edge still cuts. If every requested edge is skipped, it throws. Do not "fix" a vanished rim by filtering out short segments. Pass the whole `convexEdges` set, or filter by orientation and position only.
- `sphericalCorners: true` does nothing at a corner that is not three equal ~90° fillets. The corner stays a cusp. That is not a failed solid.
- `relaxPlanar: true` is the loft-generator escape hatch. Leave it off on ordinary parts.

`filletAlongPath(part, path, radius, opts)`:

- `radius` must be a finite number greater than 0.
- The path is a `makeSweepPath` result, `{ points, closed }`, or a point array plus `opts.closed`.
- `sweep cutter is not a valid solid` means the profile or the path did not produce a manifold. Check that the path has more than one point and that consecutive points are not duplicates.
- `result is EMPTY (cutter consumed the solid) — reduce radius` means the cutter removed the body. Reduce `radius`.
- Leaving out the short segments of a previous blend opens a gap instead of wrapping the blend. Pass the full wire.
- `opts.profile` is `'fillet'` or `'chamfer'`. Other values are not a third profile. Anything other than `'chamfer'` is the fillet.
- A compose of several bodies is filleted on the body that owns the path. A bad compose throws `bad compose`.

`chamferEdges(part, edges, c)`:

- `c` is the leg length. At 90° it equals the face offset. At a wider angle it does not.
- Cutters run one difference per edge. The first degenerate edge throws. Split the set. A rib-root edge whose two "faces" are coplanar is a typical throw. Skip that edge on purpose.

`makeSweepPath` on edges that do not meet, or that are not a single ordered chain, will not invent a path. Select a chain (`edgesBetween(part, faceA, faceB)` or `edge(part, id)` from `boundaryEdges`).

Recovery that is safe: smaller radius, fewer edges, re-query `convexEdges` on the current solid, then run the verify loop. Recovery that hides the bug: `try/catch` that returns `part` unchanged, or dropping edges until the call stops throwing.

## Shell, face, and draft failures

- `hollow` / `shell`: thickness must be a finite number the body can inset. Too thick throws instead of returning a folded mesh. `opening: 'none'` is a closed void. An axis is `'z'`, `'-z'`, `'x'`, `'-x'`, `'y'`, `'-y'`. A `{ center, normal }` from an older solid throws and tells you to re-pick.
- `moveFace` / `deleteFace`: same re-pick rule. A distance the walls cannot absorb throws. Deleting one face of a cube throws because the side walls do not meet.
- `draftFaces` / `addDraft`: an angle the body cannot take throws. A face perpendicular to `opts.pull` throws. Change the pull or pick the side walls (`'sides'`).
- `move` and `booleanBodies`: a centroid that matches no body throws. Use `parts[].at` from a run of the current solid, not a guess from the pre-boolean box.

## Helper-name shadowing

The script is not wrapped in another function. It is the body of:

```text
new Function(...helperNames, '"use strict";\n' + script)
```

Every helper name is already a parameter. A top-level `let hollow` throws:

```text
SyntaxError: Identifier 'hollow' has already been declared
```

The same throw happens for `const`, `var`, `function`, and `class` bound to any helper name. Names that collide often: `hollow`, `shell`, `cut`, `move`, `center`, `align`, `mirror`, `edge`, `loft`, `sweep`, `tube`. Nested functions may reuse a name. The top level may not. Renaming the binding is the fix (`const wall = hollow(stock, 2, 'z')` still calls the helper). Wrapping the user script in an inner function would hide the clash and is not how `runScript` works.

`window` is also a parameter. It is only `{ __importedManifolds }`. Do not read a DOM from it.

## Sheet metal

`sheetMetalSolid` throws when the spec does not solve (a bend that cannot attach, a bad edge name). DFM failures from the catalog are separate from that throw. They show up on export:

- hard fails (`flange`, `angle`, `bend-length`, `min-hole`, `hole-edge`, `hole-bend`, `bridge`, `flat-size`, `no-bending`, `spec`, `model`) set the export blocked
- warnings (`tab-small`, `step-faceted`, `mesh-stale`, `script-extras`, and the warn level of `hole-bend`) do not block

`sheetSpecToStep` returns `{ bytes, text, stepSource, blocked, dfm, brepError }`. If `blocked` is true, read `dfm` and fix the spec. If `stepSource` is not `'spec'` on a part that has bends, the true-curve writer did not run. `brepError` says why. A faceted STEP from `exportResult(result, 'step')` without `sheetSpec` is the mesh fallback (`MANIFOLD_SOLID_BREP` still, but bends are not cylinders).

## What to do next

Change one call. Run again. Require `status === 'NoError'`, a finite box, a volume in the expected band, and the `bodyCount` you planned. Export only after that. The loop is in the skill's verify section.
