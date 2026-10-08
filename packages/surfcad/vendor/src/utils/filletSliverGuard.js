/**
 * Degenerate-tri loud-fail gates for filletAlongPath (worker + golden).
 * Keep in sync — import these rather than re-stating 80 / 0.06.
 */
export const SLIVER_MAX_ABS = 80;
export const SLIVER_MAX_FRAC = 0.06;

/** True when the mesh is scrap-sheet dirty (worker throws; golden must fail). */
export function isFilletSliverDirty(tiny, nTri) {
  return tiny > SLIVER_MAX_ABS && tiny > SLIVER_MAX_FRAC * nTri;
}
