/**
 * SendCutSend DFM for a sheet spec. Limits come from the SKU (embedded in
 * the spec). Hard fails block export / order; soft warnings only inform.
 *
 * Rules (mm):
 *  hard  min-hole      hole Ø < SCS min_hole_size
 *  hard  bridge        hole-to-hole web < SCS min_bridge_size
 *  hard  hole-edge     hole edge to a free panel edge < SCS min_hole_to_edge
 *  hard  hole-bend     tapped hole centre → bend line < SCS min_hole_cl_to_bend_line
 *  soft  hole-bend     any hole edge within 2.5·t + r of a bend (may distort)
 *  hard  flange        flange length < SCS min_flange_length_after_bend
 *  hard  angle         bend angle outside SCS min … max_bend_angle
 *  hard  bend-length   bend line longer than SCS max_bend_length
 *  hard  no-bending    bends on a SKU without the bending service
 *  hard  flat-size     flat pattern outside SCS min / max flat (bent) or part size
 *  soft  tab-small     tab width or depth < max(t, min bridge)
 */
import { normalizeSheetSpec, solveSheet } from './sheetModel.js';
import { sheetFlatPattern } from './sheetFlat.js';
import { formatSheetLength, formatSheetPair } from './sheetUnits.js';

function fitsSize(size, lim, { min = false } = {}) {
  if (!Array.isArray(lim)) return true;
  const a = [...size].sort((x, y) => x - y);
  const b = [...lim].sort((x, y) => x - y);
  return min ? a[0] >= b[0] - 1e-6 && a[1] >= b[1] - 1e-6 : a[0] <= b[0] + 1e-6 && a[1] <= b[1] + 1e-6;
}

/**
 * `unit` formats messages only ('mm' default, or 'in'). Limits and the
 * spec stay millimetres either way.
 */
export function checkSheetDfm(rawSpec, { unit = 'mm' } = {}) {
  const display = unit === 'in' ? 'in' : 'mm';
  const fmt = (n) => formatSheetLength(n, display, 2);
  const spec = normalizeSheetSpec(rawSpec);
  const issues = [];
  const push = (level, rule, message, featureId = null) => issues.push({ level, rule, message, featureId });
  if (!spec) {
    push('fail', 'spec', 'Sheet spec is unreadable.');
    return { ok: false, fails: 1, warns: 0, issues };
  }
  const L = spec.limits || {};
  const t = spec.t;
  const r = spec.r;
  const solved = solveSheet(spec);
  for (const err of solved.errors) push('fail', 'model', err);

  // Bends
  if (spec.bends.length && !L.bendable) {
    push('fail', 'no-bending', `${spec.sku || 'This SKU'} has no bending service — remove bends or pick a bendable gauge.`);
  }
  for (const b of solved.bends) {
    if (L.minFlange != null && b.length < L.minFlange - 1e-6) {
      push('fail', 'flange', `Bend ${b.id}: flange ${fmt(b.length)} is below SCS min ${fmt(L.minFlange)}.`, b.id);
    }
    if (L.maxAngle != null && b.angle > L.maxAngle + 1e-6) {
      push('fail', 'angle', `Bend ${b.id}: ${b.angle}° exceeds SCS max ${L.maxAngle}°.`, b.id);
    }
    if (L.minAngle != null && b.angle < L.minAngle - 1e-6) {
      push('fail', 'angle', `Bend ${b.id}: ${b.angle}° is below SCS min ${L.minAngle}°.`, b.id);
    }
    if (L.maxBendLength != null && b.q1 - b.q0 > L.maxBendLength + 1e-6) {
      push('fail', 'bend-length', `Bend ${b.id}: bend line ${fmt(b.q1 - b.q0)} exceeds SCS max ${fmt(L.maxBendLength)}.`, b.id);
    }
  }

  // Holes
  // A tab extends material past an edge only over its span [q0, q1] (edge coords).
  const tabCovers = (panelId, edge, u, v, rad) => solved.tabs.some((tb) => {
    if (tb.panel !== panelId || tb.edge !== edge) return false;
    const q = edge === 'u+' ? v : edge === 'u-' ? -v : edge === 'v+' ? -u : u;
    return q - rad >= tb.q0 - 1e-6 && q + rad <= tb.q1 + 1e-6;
  });
  for (const h of solved.holes) {
    const d = Number(h.d) || 0;
    const rad = d / 2;
    if (L.minHole != null && d < L.minHole - 1e-6) {
      push('fail', 'min-hole', `Hole ${h.id}: Ø ${fmt(d)} is below SCS min ${fmt(L.minHole)}.`, h.id);
    }
    const p = h.panelRef;
    const u = Number(h.u) || 0;
    const v = Number(h.v) || 0;
    const sides = [
      { edge: 'u+', gap: p.u1 - u - rad },
      { edge: 'u-', gap: u - p.u0 - rad },
      { edge: 'v+', gap: p.v1 - v - rad },
      { edge: 'v-', gap: v - p.v0 - rad },
    ];
    if (sides.some((s) => s.gap < -1e-6)) {
      push('fail', 'hole-edge', `Hole ${h.id} breaks out of its face.`, h.id);
      continue;
    }
    // A flange's u- side is its own bend; base edges / flange tips may be bent too.
    const bendOn = (edge) => solved.bends.find((b) => b.panel === p.id && b.edge === edge)
      || (p.id !== 'base' && edge === 'u-' ? solved.bends.find((b) => b.id === p.id) : null);
    for (const s of sides) {
      const bend = bendOn(s.edge);
      if (bend) {
        // SCS publishes hole centreline → bend line for tapped / hardware holes.
        const cl = s.gap + rad + bend.allowance / 2;
        const need = L.minHoleToBend;
        if (h.type === 'tapped' && need != null && cl < need - 1e-6) {
          push('fail', 'hole-bend', `Tapped hole ${h.id}: ${fmt(cl)} centre to bend line; SCS needs ${fmt(need)}.`, h.id);
        } else if (s.gap < 2.5 * t + r - 1e-6) {
          push('warn', 'hole-bend', `Hole ${h.id}: ${fmt(s.gap)} from a bend — may distort (keep ≥ ${fmt(2.5 * t + r)}).`, h.id);
        }
      } else if (!tabCovers(p.id, s.edge, u, v, rad) && L.minHoleToEdge != null && s.gap < L.minHoleToEdge - 1e-6) {
        push('fail', 'hole-edge', `Hole ${h.id}: ${fmt(s.gap)} to the edge; SCS min ${fmt(L.minHoleToEdge)}.`, h.id);
      }
    }
  }
  for (let i = 0; i < solved.holes.length; i++) {
    for (let j = i + 1; j < solved.holes.length; j++) {
      const a = solved.holes[i];
      const b = solved.holes[j];
      if (a.panel !== b.panel) continue;
      const web = Math.hypot(a.u - b.u, a.v - b.v) - a.d / 2 - b.d / 2;
      if (web < 0) push('fail', 'bridge', `Holes ${a.id} and ${b.id} overlap.`, b.id);
      else if (L.minBridge != null && web < L.minBridge - 1e-6) {
        push('fail', 'bridge', `Holes ${a.id}/${b.id}: web ${fmt(web)} below SCS min bridge ${fmt(L.minBridge)}.`, b.id);
      }
    }
  }

  // Tabs
  const tabMin = Math.max(t, Number(L.minBridge) || 0);
  for (const tb of solved.tabs) {
    if (tb.width < tabMin - 1e-6 || tb.depth < tabMin - 1e-6) {
      push('warn', 'tab-small', `Tab ${tb.id} is very small (< ${fmt(tabMin)}).`, tb.id);
    }
  }

  // Flat size
  let flat = null;
  try {
    flat = sheetFlatPattern(spec);
  } catch {
    flat = null;
  }
  if (flat) {
    const bent = spec.bends.length > 0;
    const max = bent ? L.maxFlat : L.maxPart;
    const min = bent ? L.minFlat : L.minPart;
    const label = `${fmt(flat.size[0])} × ${fmt(flat.size[1])}`;
    const pairText = (pair, digits) => (display === 'in'
      ? formatSheetPair(pair, 'in', 3)
      : `${pair.map((n) => n.toFixed(digits)).join(' × ')} mm`);
    if (!fitsSize(flat.size, max)) push('fail', 'flat-size', `Flat ${label} exceeds SCS max ${pairText(max, 0)}${bent ? ' for bending' : ''}.`);
    if (!fitsSize(flat.size, min, { min: true })) push('fail', 'flat-size', `Flat ${label} is below SCS min ${pairText(min, 1)}${bent ? ' for bending' : ''}.`);
  }

  const fails = issues.filter((x) => x.level === 'fail').length;
  return { ok: fails === 0, fails, warns: issues.length - fails, issues, flat };
}
