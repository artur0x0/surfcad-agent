/**
 * STEP AP214 writers (MANIFOLD_SOLID_BREP, mm).
 * - `brepToStep`: an exact B-rep (planes, cylinders, cones; LINE / CIRCLE
 *   edges). Sheet metal uses this via `sheetBrep.js`, so bends are true
 *   cylinders that SendCutSend reads as bends.
 * - `meshToStep`: fallback for a triangle mesh. Welds vertices, merges
 *   edge-connected coplanar triangles into planar faces; curved regions stay
 *   faceted.
 */

const stepReal = (n) => {
  const v = Math.abs(n) < 1e-12 ? 0 : n;
  let s = v.toFixed(6).replace(/0+$/, '');
  if (s.endsWith('.')) return s;
  if (!s.includes('.')) s += '.';
  return s;
};
const stepStr = (s) => `'${String(s ?? '').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_')}'`;

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** Planar faces from a triangle mesh: [{ normal, loops: [[vi…] outer, …inner] }]. */
export function meshPlanarFaces(mesh, { weldTol = 1e-5 } = {}) {
  const np = mesh.numProp || 3;
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const nIn = Math.floor(vp.length / np);
  const verts = [];
  const remap = new Int32Array(nIn);
  const grid = new Map();
  for (let i = 0; i < nIn; i++) {
    const p = [vp[i * np], vp[i * np + 1], vp[i * np + 2]];
    const k = p.map((c) => Math.round(c / weldTol)).join(',');
    let id = grid.get(k);
    if (id == null) {
      id = verts.length;
      verts.push(p);
      grid.set(k, id);
    }
    remap[i] = id;
  }
  const tris = [];
  for (let t = 0; t + 2 < tv.length; t += 3) {
    const a = remap[tv[t]];
    const b = remap[tv[t + 1]];
    const c = remap[tv[t + 2]];
    if (a === b || b === c || a === c) continue;
    const n = cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]));
    if (Math.hypot(...n) < 1e-14) continue;
    const nn = norm(n);
    tris.push({ v: [a, b, c], n: nn, d: dot(nn, verts[a]) });
  }
  // Edge → triangles, union coplanar neighbours.
  const parent = tris.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const edgeTris = new Map();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = t.v[k];
      const b = t.v[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!edgeTris.has(key)) edgeTris.set(key, []);
      edgeTris.get(key).push(i);
    }
  });
  for (const list of edgeTris.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const A = tris[list[x]];
        const B = tris[list[y]];
        if (dot(A.n, B.n) > 1 - 1e-9 && Math.abs(A.d - B.d) < 1e-6) parent[find(list[x])] = find(list[y]);
      }
    }
  }
  const groups = new Map();
  tris.forEach((t, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  });
  const faces = [];
  for (const group of groups.values()) {
    const directed = new Set();
    for (const t of group) for (let k = 0; k < 3; k++) directed.add(`${t.v[k]}_${t.v[(k + 1) % 3]}`);
    const next = new Map();
    for (const e of directed) {
      const [a, b] = e.split('_').map(Number);
      if (directed.has(`${b}_${a}`)) continue;
      if (!next.has(a)) next.set(a, []);
      next.get(a).push(b);
    }
    const n = group[0].n;
    const loops = [];
    while (next.size) {
      const [start] = next.keys();
      const loop = [start];
      let cur = start;
      let guard = directed.size + 2;
      while (guard-- > 0) {
        const outs = next.get(cur);
        if (!outs || !outs.length) break;
        const b = outs.shift();
        if (!outs.length) next.delete(cur);
        if (b === start) break;
        loop.push(b);
        cur = b;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    const area = (loop) => {
      let s = [0, 0, 0];
      for (let i = 0; i < loop.length; i++) {
        const c = cross(verts[loop[i]], verts[loop[(i + 1) % loop.length]]);
        s = [s[0] + c[0], s[1] + c[1], s[2] + c[2]];
      }
      return dot(s, n) / 2;
    };
    loops.sort((a, b) => area(b) - area(a));
    if (loops.length) faces.push({ normal: n, loops, area: loops.reduce((s, l) => s + area(l), 0) });
  }
  return { verts, faces, triangles: tris.length };
}

function perp(axis, ref) {
  const a = norm(axis);
  let r = ref ? sub(ref, a.map((x) => x * dot(ref, a))) : null;
  if (!r || Math.hypot(...r) < 1e-9) {
    const h = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    r = sub(h, a.map((x) => x * dot(h, a)));
  }
  return norm(r);
}

/** Shared AP214 product / context entities; `emit(add, point, dir)` returns the brep id. */
function stepDocument(name, timestamp, emit) {
  const lines = [];
  let id = 0;
  const add = (body) => {
    id += 1;
    lines.push(`#${id}=${body};`);
    return id;
  };
  const ctx = add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${ctx})`);
  const pctx = add(`PRODUCT_CONTEXT('',#${ctx},'mechanical')`);
  const prod = add(`PRODUCT(${stepStr(name)},${stepStr(name)},'',(#${pctx}))`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const pdf = add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pdc = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${ctx},'design')`);
  const pd = add(`PRODUCT_DEFINITION('design','',#${pdf},#${pdc})`);
  const pds = add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  const lu = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const au = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const su = add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${lu},'distance_accuracy_value','confusion accuracy')`);
  const gctx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const point = (p) => add(`CARTESIAN_POINT('',(${p.map(stepReal).join(',')}))`);
  const dir = (d) => add(`DIRECTION('',(${norm(d).map(stepReal).join(',')}))`);
  const brep = emit(add, point, dir);
  const origin = add(`AXIS2_PLACEMENT_3D('',#${point([0, 0, 0])},#${dir([0, 0, 1])},#${dir([1, 0, 0])})`);
  const rep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${stepStr(name)},(#${origin},#${brep}),#${gctx})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  const header = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('SurfCAD sheet metal part'),'2;1');",
    `FILE_NAME(${stepStr(name)},${stepStr(timestamp)},('SurfCAD'),('SurfCAD'),'SurfCAD','SurfCAD','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
  ];
  return `${[...header, ...lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n')}\n`;
}

/**
 * STEP AP214 text for an exact B-rep: { vertices, edges: [{ v1, v2, curve:
 * { type: 'line' } | { type: 'circle', center, axis, ref, radius } }],
 * faces: [{ surface: { type: 'plane' | 'cylinder' | 'cone', origin, axis,
 * ref, radius?, semiAngle? }, sameSense, loops: [[{ edge, forward }]] }] }.
 * A circle edge runs v1 → v2 counter-clockwise about its axis. Loops are
 * oriented with the material on the left seen from outside; loop 0 is outer.
 */
export function brepToStep(brep, { name = 'SurfCAD part', timestamp = new Date().toISOString().slice(0, 19) } = {}) {
  let faceCount = 0;
  const text = stepDocument(name, timestamp, (add, point, dir) => {
    const placement = (o, axis, ref) => add(`AXIS2_PLACEMENT_3D('',#${point(o)},#${dir(axis)},#${dir(perp(axis, ref))})`);
    const vIds = brep.vertices.map((p) => add(`VERTEX_POINT('',#${point(p)})`));
    const eIds = brep.edges.map((e) => {
      const A = brep.vertices[e.v1];
      const B = brep.vertices[e.v2];
      let curve;
      if (e.curve.type === 'circle') {
        curve = add(`CIRCLE('',#${placement(e.curve.center, e.curve.axis, e.curve.ref || sub(A, e.curve.center))},${stepReal(e.curve.radius)})`);
      } else {
        const v = sub(B, A);
        curve = add(`LINE('',#${point(A)},#${add(`VECTOR('',#${dir(v)},${stepReal(Math.hypot(...v))})`)})`);
      }
      return add(`EDGE_CURVE('',#${vIds[e.v1]},#${vIds[e.v2]},#${curve},.T.)`);
    });
    const faceIds = brep.faces.map((f) => {
      const bounds = f.loops.map((loop, li) => {
        const oes = loop.map((oe) => `#${add(`ORIENTED_EDGE('',*,*,#${eIds[oe.edge]},${oe.forward ? '.T.' : '.F.'})`)}`);
        const el = add(`EDGE_LOOP('',(${oes.join(',')}))`);
        return `#${add(`${li === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${el},.T.)`)}`;
      });
      const s = f.surface;
      const ax = placement(s.origin, s.axis, s.ref);
      let surf;
      if (s.type === 'plane') surf = add(`PLANE('',#${ax})`);
      else if (s.type === 'cylinder') surf = add(`CYLINDRICAL_SURFACE('',#${ax},${stepReal(s.radius)})`);
      else if (s.type === 'cone') surf = add(`CONICAL_SURFACE('',#${ax},${stepReal(s.radius)},${stepReal(s.semiAngle)})`);
      else throw new Error(`brepToStep: unknown surface ${s.type}`);
      return `#${add(`ADVANCED_FACE('',(${bounds.join(',')}),#${surf},${f.sameSense === false ? '.F.' : '.T.'})`)}`;
    });
    faceCount = faceIds.length;
    const shell = add(`CLOSED_SHELL('',(${faceIds.join(',')}))`);
    return add(`MANIFOLD_SOLID_BREP(${stepStr(name)},#${shell})`);
  });
  return { text, faces: faceCount, edges: brep.edges.length, vertices: brep.vertices.length };
}

/** STEP AP214 text for a closed triangle mesh (mm). */
export function meshToStep(mesh, { name = 'SurfCAD part', timestamp = new Date().toISOString().slice(0, 19) } = {}) {
  const { verts, faces } = meshPlanarFaces(mesh);
  let edgeCount = 0;
  let vertexCount = 0;
  const text = stepDocument(name, timestamp, (add, point, dir) => {
    const vertexIds = new Map();
    const vertexOf = (vi) => {
      if (!vertexIds.has(vi)) vertexIds.set(vi, add(`VERTEX_POINT('',#${point(verts[vi])})`));
      return vertexIds.get(vi);
    };
    const edgeIds = new Map(); // "a_b" (a<b) → EDGE_CURVE id oriented a→b
    const edgeOf = (a, b) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo}_${hi}`;
      if (!edgeIds.has(key)) {
        const v = sub(verts[hi], verts[lo]);
        const len = Math.hypot(...v);
        const vec = add(`VECTOR('',#${dir(norm(v))},${stepReal(len)})`);
        const line = add(`LINE('',#${point(verts[lo])},#${vec})`);
        edgeIds.set(key, add(`EDGE_CURVE('',#${vertexOf(lo)},#${vertexOf(hi)},#${line},.T.)`));
      }
      return { id: edgeIds.get(key), same: a === lo };
    };
    const faceIds = [];
    for (const f of faces) {
      const bounds = f.loops.map((loop, li) => {
        const oes = loop.map((a, i) => {
          const e = edgeOf(a, loop[(i + 1) % loop.length]);
          return `#${add(`ORIENTED_EDGE('',*,*,#${e.id},${e.same ? '.T.' : '.F.'})`)}`;
        });
        const el = add(`EDGE_LOOP('',(${oes.join(',')}))`);
        return `#${add(`${li === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${el},.T.)`)}`;
      });
      const p0 = verts[f.loops[0][0]];
      const p1 = verts[f.loops[0][1]];
      const ref = norm(sub(p1, p0));
      const ax = add(`AXIS2_PLACEMENT_3D('',#${point(p0)},#${dir(f.normal)},#${dir(ref)})`);
      const plane = add(`PLANE('',#${ax})`);
      faceIds.push(`#${add(`ADVANCED_FACE('',(${bounds.join(',')}),#${plane},.T.)`)}`);
    }
    const shell = add(`CLOSED_SHELL('',(${faceIds.join(',')}))`);
    edgeCount = edgeIds.size;
    vertexCount = vertexIds.size;
    return add(`MANIFOLD_SOLID_BREP(${stepStr(name)},#${shell})`);
  });
  return { text, faces: faces.length, edges: edgeCount, vertices: vertexCount };
}
