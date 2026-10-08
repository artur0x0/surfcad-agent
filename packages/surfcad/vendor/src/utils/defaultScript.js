// utils/defaultScript.js - Default CAD script for new users

export const DEFAULT_SCRIPT = `// --- cube begin ---
let box1 = Manifold.cube([40, 30, 20], true);
let part = box1;
// --- cube end ---
// --- fillet-mode begin ---
const selEdges = edgesBetween(part, 3, 5); // boundary edge 9
const path = makeSweepPath(selEdges); // edge→sweep path
part = filletAlongPath(part, path, 4); // sweep fillet wedge
// --- fillet-mode end ---
// --- fillet-mode begin ---
const selEdges2 = [{ a: 30, b: 32, va: [20, 15, -10], vb: [20, 15, 6], length: 16, key: "coh-9-0", n0: [0, 1, 0], n1: [1, 0, 0], pts: [[20, 15, -10], [20, 15, 6]] }, { a: 37, b: 32, va: [20, 14.787721, 7.285758], vb: [20, 15, 6], length: 1.307362, key: "coh-11-3", n0: [1, 0, 0], n1: [0, 0.986644, 0.162894], pts: [[20, 14.787721, 7.285758], [20, 14.965779, 6.522105], [20, 15, 6]] }, { a: 55, b: 37, va: [20, 13.828427, 8.828427], vb: [20, 14.787721, 7.285758], length: 1.830587, key: "coh-11-2", n0: [1, 0, 0], n1: [0, 0.812847, 0.582477], pts: [[20, 13.828427, 8.828427], [20, 14.173413, 8.435045], [20, 14.464102, 8], [20, 14.787721, 7.285758]] }, { a: 44, b: 55, va: [20, 12.769155, 9.587491], vb: [20, 13.828427, 8.828427], length: 1.307362, key: "coh-11-1", n0: [1, 0, 0], n1: [0, 0.582477, 0.812847], pts: [[20, 12.769155, 9.587491], [20, 13.222281, 9.325878], [20, 13.828427, 8.828427]] }, { a: 31, b: 44, va: [20, 11, 10], vb: [20, 12.769155, 9.587491], length: 1.830587, key: "coh-11-0", n0: [1, 0, 0], n1: [0, 0.162894, 0.986644], pts: [[20, 11, 10], [20, 11.522105, 9.965779], [20, 12.035276, 9.863704], [20, 12.769155, 9.587491]] }, { a: 29, b: 31, va: [20, -15, 10], vb: [20, 11, 10], length: 26, key: "coh-10-0", n0: [0, 0, 1], n1: [1, 0, 0], pts: [[20, -15, 10], [20, 11, 10]] }];
const path2 = makeSweepPath(selEdges2); // edge→sweep path
part = filletAlongPath(part, path2, 4.83, { variableProfile: true }); // hard: variable-profile inscribed-arc sweep (C3)
// --- fillet-mode end ---
// --- contour-mode loft begin ---
const fr = { center: [0, 0, 10], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
const xs2 = makeCrossSection(fr, profileCircle(5, 64));
const xs3 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
part = part.add(placeInFrame(fr, makeLoft([xs2, xs3])));
// --- contour-mode loft end ---
// --- fillet-mode begin ---
const selEdges3 = [{ a: 12908, b: 16964, va: [4.634159, 2.780495, 11.230769], vb: [10, 6, 30], length: 19.78488, key: "coh-54-0", n0: [0.694953, 0.648815, -0.309968], n1: [0.857619, 0.406588, -0.314922], pts: [[4.634159, 2.780495, 11.230769], [10, 6, 30]] }];
const path3 = makeSweepPath(selEdges3); // edge→sweep path
part = filletAlongPath(part, path3, 1.98, { variableProfile: true }); // hard: variable-profile inscribed-arc sweep (C3)
// --- fillet-mode end ---
// --- fillet-mode begin ---
const selEdges4 = [{ a: 4028, b: 4037, va: [-20, 15, -10], vb: [-20, 15, 6], length: 16, key: "coh-4-0", n0: [-1, 0, 0], n1: [0, 1, 0], pts: [[-20, 15, -10], [-20, 15, 6]] }, { a: 4037, b: 4052, va: [-20, 15, 6], vb: [-20, 14.695518, 7.530734], length: 1.569675, key: "coh-9-0", n0: [-1, 0, 0], n1: [0, 0.986644, 0.162894], pts: [[-20, 15, 6], [-20, 14.965779, 6.522105], [-20, 14.863704, 7.035276], [-20, 14.695518, 7.530734]] }, { a: 4052, b: 4046, va: [-20, 14.695518, 7.530734], vb: [-20, 13.637383, 9.00736], length: 1.830027, key: "coh-9-1", n0: [-1, 0, 0], n1: [0, 0.812847, 0.582477], pts: [[-20, 14.695518, 7.530734], [-20, 14.325878, 8.222281], [-20, 14.173413, 8.435045], [-20, 13.637383, 9.00736]] }, { a: 4046, b: 4034, va: [-20, 13.637383, 9.00736], vb: [-20, 12.530734, 9.695518], length: 1.308203, key: "coh-9-2", n0: [-1, 0, 0], n1: [0, 0.52807, 0.849201], pts: [[-20, 13.637383, 9.00736], [-20, 13.435045, 9.173413], [-20, 13, 9.464102], [-20, 12.530734, 9.695518]] }, { a: 4034, b: 4066, va: [-20, 12.530734, 9.695518], vb: [-20, 11, 10], length: 1.569675, key: "coh-9-3", n0: [-1, 0, 0], n1: [0, 0.162894, 0.986644], pts: [[-20, 12.530734, 9.695518], [-20, 12.035276, 9.863704], [-20, 11.522105, 9.965779], [-20, 11, 10]] }, { a: 1, b: 4066, va: [-20, -15, 10], vb: [-20, 11, 10], length: 26, key: "coh-6-0", n0: [0, 0, 1], n1: [-1, 0, 0], pts: [[-20, -15, 10], [-20, 11, 10]] }];
const path4 = makeSweepPath(selEdges4); // edge→sweep path
part = filletAlongPath(part, path4, 4.83, { variableProfile: true }); // hard: variable-profile inscribed-arc sweep (C3)
// --- fillet-mode end ---
// --- hole begin ---
const selFace = (() => {
  const _c = [0, 15, -2];
  let _cands = facesByNormal(part, [0, 1, 0], 25);
  if (!_cands.length) _cands = facesByNormal(part, [0, 1, 0], 45);
  if (!_cands.length) throw new Error('Selected face not found on body after geometry changes — re-pick the planar face, then Hole/Clearance (normal [0, 1, 0])');
  let _best = _cands[0], _bd = Infinity;
  for (const _f of _cands) {
    const _d = (_f.center[0]-_c[0])**2 + (_f.center[1]-_c[1])**2 + (_f.center[2]-_c[2])**2;
    if (_d < _bd) { _bd = _d; _best = _f; }
  }
  return _best;
})();
const fr2 = workplaneFromFace(part, selFace);
// Snap origin to selected face center (projected onto plane) so Center → u=0,v=0 hits pick.
(() => {
  const _pc = [0, 15, -2];
  const _off = (_pc[0]-fr2.center[0])*fr2.normal[0] + (_pc[1]-fr2.center[1])*fr2.normal[1] + (_pc[2]-fr2.center[2])*fr2.normal[2];
  fr2.center = [_pc[0]-_off*fr2.normal[0], _pc[1]-_off*fr2.normal[1], _pc[2]-_off*fr2.normal[2]];
})();
const span = holeSpan(part, fr2);
part = clearanceHole(part, fr2, 0, 0, 'M3', span, 'normal');
// --- hole end ---
return part;
`;

export default DEFAULT_SCRIPT;
