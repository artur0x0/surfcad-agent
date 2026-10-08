# Modeling workflow

Hand-written. Units are millimetres. The script `return`s a Manifold. Helper names and signatures are in [helpers](helpers.md). The kernel methods are in [manifold-api](manifold-api.md).

## Decomposition

Split the product on manufacturing boundaries.

- One bent sheet is one part: a `sheetSpec` and `sheetMetalSolid`. Do not model the bend as a boolean.
- One plate with holes is one part, even if `cut` or `add(..., { merge: false })` leaves several bodies.
- Fasteners are not modelled as threads. Use `clearanceHole` or `tapDrillHole` at the size token (`'M4'`, `'M3'`). A printed or turned standoff is its own part (`hexPrism` or `tube`) with a bore.
- A copy of another part's solid inside this script is `externalBody`. It is a frozen snapshot, not a live link. The assembly document still lists each instance as its own row.

Name the parts before writing. Write the `.surf.json` paths to match the files you will add. See [assembly format](assembly-format.md).

## Datums

Pick one datum per part and keep every later number on it.

- A centred `Manifold.cube([x, y, z], true)` has its datum at the origin. The top face is `z = size[2] / 2`.
- `Manifold.cylinder(height, r, r, segments)` and `hexPrism(radius, height)` sit on `z = 0` and grow toward `+z` (the centre flag defaults off). `hexPrism` is a 6-segment cylinder: `radius` is the circumradius.
- `tube` / `rectTube` extrude from `z = 0` to `height` unless `rectTube` is passed `{ center: true }`.
- A face frame comes from `workplaneFromFace(part, facesByNormal(part, [0, 0, 1])[0])`. `hole` and `holePattern` take `(u, v)` on that frame, in millimetres, from the face centre. `u` follows `frame.x`, `v` follows `frame.y`.
- Assembly `position` and `externalBody(..., { offset })` are translations in millimetres, in the same coordinate system. They are not a second datum hidden inside the part script.

Write the expected bounding box next to the datum (for a centred 80×50×6 plate: x from -40 to 40, y from -25 to 25, z from -3 to 3). The verify loop compares `boundingBox` to that.

## Helper idioms

Call helpers as bare names. A typical plate:

```javascript
let part = Manifold.cube([80, 50, 6], true);
const top = facesByNormal(part, [0, 0, 1])[0];
const frame = workplaneFromFace(part, top);
part = holePattern(part, frame, {
  n: 2, m: 2, spacingU: 64, spacingV: 34, dia: 4.5, u0: 0, v0: 0,
});
const vertical = convexEdges(part).filter((e) => Math.abs(e.tangent[2]) > 0.99);
part = filletEdges(part, vertical, 2);
return part;
```

`holePattern` centres the grid on the face centre plus `(u0, v0)`. `span` defaults to `holeSpan(part, frame)`, which is long enough to exit the face. Pass an explicit `span` when the hole must stop short.

`convexEdges` returns feature edges with the vertex fields `filletEdges` and `chamferEdges` need. Filter that array. Do not build `{ va, vb }` by hand unless you also have the adjacent-face data the helper asks for.

`facesByNormal(part, [0, 0, 1])` is the current solid. After a fillet or a shell, call it again.

Raw Manifold stays appropriate for a drill you would rather express as a cylinder, a `Manifold.difference` of two explicit solids, and `Manifold.hull`. Prefer `clearanceHole(part, frame, u, v, 'M4')` when the diameter should come from the fastener table (`fastenerClearanceDia`, fits `'close' | 'normal' | 'loose'`).

## Ordering

Re-query edges after each step. The reasons are properties of these helpers, not style.

**Booleans before blends.** `filletEdges` and `chamferEdges` consume the current mesh. A hole drilled after a corner fillet leaves a sharp hole, which is what a clearance hole should be. A hole drilled before a "fillet every convex edge" call feeds the hole rim into the fillet. Filter to the edges you mean, or fillet first and drill second.

**`filletEdges` is convex and mostly planar.** The radius is a number, or an array parallel to the edge list. `opts.sphericalCorners: true` applies only where three filleted edges meet at about 90° with equal radii. `opts.relaxPlanar: true` skips the curved-face assert so a loft generator can use the per-segment cutter. A closed loop of short edges that fits a circle is filleted as one revolved cutter. Do not strip those short edges first. An open curved run still uses the per-edge size guard (`t < 0.45 * edgeLength`) and can skip edges. If every edge is skipped, it throws.

**`chamferEdges` is sequential.** Each edge is one difference. `c` is the leg length along each face, not the perpendicular offset (they match at 90°). The first degenerate cutter throws a named error instead of wedging the kernel. Chamfer a chosen set, not every convex edge of a crowded junction.

**`filletAlongPath` subtracts a swept cutter.** Build the path with `makeSweepPath(edges)` (or pass `{ points, closed }`). Default profile is `'fillet'`. `opts.profile: 'chamfer'` is the equal-leg sweep. The default cutter follows the dihedral of each segment. `opts.initialNormal` keeps the older 90° frame. Closed paths that fit a circle are revolved. The path has to be the full wire: skipping tessellated segments on a previous blend leaves a gap. A result with no volume throws and tells you to reduce the radius. Concave edges need material added. This helper subtracts, so it is the wrong tool for them.

**Shell after the outer blend when the wall must follow it.** `hollow(part, thickness, opening)` offsets every face inward by `thickness` and opens the faces you name. `shell` returns the cavity so `part.subtract(shell(part, thickness, opening))` still works. Both throw when the thickness does not fit, and both throw when a picked face is not on the body. A later fillet on an inner corner has to be smaller than the wall or it punches through. `getScaleRatio` is the old uniform-scale math. Do not use it to fake a wall. A scale cannot make a uniform wall on a non-cube.

**Draft after the walls exist, before you rely on edge identity.** `addDraft(part, degrees, 'z')` tilts every side wall, bottom fixed. `draftFaces` takes the faces, a signed angle, and `{ pull, reference, sense }`. Positive angle tapers inward along the pull. Drafting a cap (a face perpendicular to the pull) throws. `sense: 'taper'` keeps a hollow wall thickness. `sense: 'face'` follows each face normal.

**`moveFace` and `deleteFace` need the face on this solid.** `moveFace` offsets along the face normal and heals neighbours. `deleteFace` removes the face and heals. Neither returns an open mesh. A cube with one face deleted throws, because the four walls do not meet.

**`cut` splits bodies.** The plane is `{ normal, originOffset }` or a face `{ center, normal }` plus optional `offset` along the normal. A world-axis string such as `'z'` is rejected. `opts.keep` is `'both'`, `'+'`, or `'-'`. Bodies you do not name in `opts.bodies` stay whole. Deleting every piece throws.

**Lofts are parallel sections.** `makeCrossSection(plane, profile)` builds a section. `offsetPlaneFrame(plane, distance)` is the next plane along the same normal. `makeLoft([section, ...])` needs at least two. `placeInFrame` puts the solid back on that frame. Sections that are not parallel are outside this helper. `sweep` / `sweepPoints` carry a `CrossSection` along a path. The profile should be centred on the origin.

**Patterns last or on the stock, not in the middle of a fillet chain.** `array3D(part, counts, spacing)`, `polarArray(part, count, radius, axis)`, and `mirror(part, plane, keepOriginal)` copy the solid you pass. Fillet the seed first if every copy needs the same blend.

## Assemblies

Author each part so it returns a valid solid at its own datum. Place it in the assembly with `position`. For a headless fit check, call the part function once per instance:

```javascript
const post = externalBody(standoff, { offset: [32, 17, 3] });
part = part.add(post, { merge: false });
```

`bodyCount` is then the plate plus the posts. `booleanBodies(part, { op: 'difference', bodies: [{ at }, { at }] })` is how you boolean specific bodies inside an already composed solid. The first `{ at }` is the target. Later entries are tools. Bodies you do not name stay.

`move(part, [dx, dy, dz], { bodies: [{ at }] })` translates one body. It is not `moveFace`.

## Sheet metal

Keep the spec inside the `// --- sheet-metal begin ---` / `// --- sheet-metal end ---` block and `return` the `sheetMetalSolid`. Choose `sku`, thickness `t`, inner radius `r`, and k-factor `k` from the stock you are actually ordering. Put flange length, bend angle, hole diameter, and hole-to-bend distance where the DFM rules in [sheet metal](sheet-metal.md) can see them. Export STEP with `sheetSpecToStep`, not the faceted mesh writer, when the spec folds.
