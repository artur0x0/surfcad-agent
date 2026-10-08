# Examples

Hand-written. Every `javascript` fence is a complete script: `runScript` can evaluate it, and the script `return`s a Manifold. Units are millimetres. The `.surf.json` fence is the assembly document, not a script.

Helper names are called, not declared. None of these scripts bind `hollow`, `shell`, `cut`, `move`, `center`, `edge`, `loft`, or `sweep` at the top level.

## Enclosure shell

Centred 60×40×28 box. Four vertical corners filleted at 3 mm, then a 2 mm wall open on `+Z`. Expected box about x ±30, y ±20, z ±14. One body.

```javascript
let part = Manifold.cube([60, 40, 28], true);
const vertical = convexEdges(part).filter((e) => Math.abs(e.tangent[2]) > 0.99);
if (vertical.length !== 4) throw new Error('expected 4 vertical edges, got ' + vertical.length);
part = filletEdges(part, vertical, 3);
part = hollow(part, 2, 'z');
return part;
```

## Lofted pedestal

Three parallel sections on `+Z`: a 40×24 rectangle, a 28×16 rectangle 18 mm up, a 6 mm radius circle at 28 mm. `makeLoft` requires those planes to share a normal. One body. The solid sits on `z = 0`.

```javascript
const frame = { center: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
const bottom = makeCrossSection(frame, profileRectangle(40, 24, true));
const mid = makeCrossSection(offsetPlaneFrame(frame, 18), profileRectangle(28, 16, true));
const top = makeCrossSection(offsetPlaneFrame(frame, 28), profileCircle(6, 32));
return placeInFrame(frame, makeLoft([bottom, mid, top]));
```

## Sheet bracket

SendCutSend-style cover, SKU `ALU-090`, 1.63 mm sheet, 80×50 base, one 20 mm flange bent 90° on `u+`. One body. STEP for this spec is `sheetSpecToStep(sheetSpec)`, and a fold reports `stepSource: 'spec'` with `CYLINDRICAL_SURFACE`. The markers are what Sheet Metal mode writes.

```javascript
// --- sheet-metal begin ---
const sheetSpec = {
  v: 1,
  sku: 'ALU-090',
  material: 'Aluminum 5052',
  t: 1.63,
  r: 1.5,
  k: 0.44,
  limits: { bendable: true },
  plane: 'XY',
  width: 80,
  height: 50,
  bends: [{ id: 'b1', panel: 'base', edge: 'u+', angle: 90, length: 20 }],
  tabs: [],
  holes: [],
};
let part = sheetMetalSolid(sheetSpec);
// --- sheet-metal end ---
return part;
```

## Assembly: sensor bracket

A centred 80×50×6 plate with 2 mm vertical fillets and four Ø4.4 through holes, plus a 12 mm hex standoff (circumradius 5 mm, Ø2.5 bore) seated on the plate's top face (`z = 3`). Four standoffs, so a merged-off compose has five bodies.

The plate script, `assemblies/sensor-bracket/base.js`:

```javascript
// @surf-id local-2026-10-08-01-00-00-0001-a11a
let part = Manifold.cube([80, 50, 6], true);
const vertical = convexEdges(part).filter((e) => Math.abs(e.tangent[2]) > 0.99);
part = filletEdges(part, vertical, 2);
const spots = [[-32, -17], [32, -17], [-32, 17], [32, 17]];
for (const [x, y] of spots) {
  const drill = Manifold.cylinder(12, 2.2, 2.2, 32).translate([x, y, -6]);
  part = part.subtract(drill);
}
return part;
```

The standoff script, `assemblies/sensor-bracket/standoff.js`. Local `z = 0` is the mating face.

```javascript
// @surf-id local-2026-10-08-01-00-00-0002-b22b
let part = hexPrism(5, 12);
const bore = Manifold.cylinder(16, 1.25, 1.25, 24).translate([0, 0, -2]);
return part.subtract(bore);
```

`assemblies/sensor-bracket/.surf.json`. Rows reference scripts by `{ id, path }`. The three extra posts are copies: their own ids, `copiedFrom` set to the standoff id, the same path, their own `position`.

```json
{
  "format": "surfcad.assembly",
  "version": 1,
  "name": "sensor-bracket",
  "activeId": "assemblies/sensor-bracket/base.js",
  "parts": [
    {
      "id": "local-2026-10-08-01-00-00-0001-a11a",
      "path": "assemblies/sensor-bracket/base.js",
      "name": "base",
      "visible": true,
      "order": 0,
      "position": [0, 0, 0]
    },
    {
      "id": "local-2026-10-08-01-00-00-0002-b22b",
      "path": "assemblies/sensor-bracket/standoff.js",
      "name": "standoff",
      "visible": true,
      "order": 1,
      "position": [-32, -17, 3]
    },
    {
      "id": "local-2026-10-08-01-00-00-0003-c33c",
      "path": "assemblies/sensor-bracket/standoff.js",
      "name": "standoff",
      "visible": true,
      "order": 2,
      "position": [32, -17, 3],
      "copiedFrom": "local-2026-10-08-01-00-00-0002-b22b"
    },
    {
      "id": "local-2026-10-08-01-00-00-0004-d44d",
      "path": "assemblies/sensor-bracket/standoff.js",
      "name": "standoff",
      "visible": true,
      "order": 3,
      "position": [-32, 17, 3],
      "copiedFrom": "local-2026-10-08-01-00-00-0002-b22b"
    },
    {
      "id": "local-2026-10-08-01-00-00-0005-e55e",
      "path": "assemblies/sensor-bracket/standoff.js",
      "name": "standoff",
      "visible": true,
      "order": 4,
      "position": [32, 17, 3],
      "copiedFrom": "local-2026-10-08-01-00-00-0002-b22b"
    }
  ]
}
```

Headless check of that stack. `externalBody` runs the standoff function and translates the solid. `merge: false` keeps the plate and the four posts as separate bodies. `@check bodyCount 5` is an assertion for the example runner, not a helper.

```javascript
// @surf-id local-2026-10-08-01-00-00-0006-f66f
// @check bodyCount 5
function basePlate() {
  let part = Manifold.cube([80, 50, 6], true);
  const vertical = convexEdges(part).filter((e) => Math.abs(e.tangent[2]) > 0.99);
  part = filletEdges(part, vertical, 2);
  const spots = [[-32, -17], [32, -17], [-32, 17], [32, 17]];
  for (const [x, y] of spots) {
    const drill = Manifold.cylinder(12, 2.2, 2.2, 32).translate([x, y, -6]);
    part = part.subtract(drill);
  }
  return part;
}
function standoff() {
  let part = hexPrism(5, 12);
  const bore = Manifold.cylinder(16, 1.25, 1.25, 24).translate([0, 0, -2]);
  return part.subtract(bore);
}
let part = basePlate();
for (const [x, y] of [[-32, -17], [32, -17], [-32, 17], [32, 17]]) {
  const post = externalBody(standoff, { offset: [x, y, 3] });
  part = part.add(post, { merge: false });
}
return part;
```
