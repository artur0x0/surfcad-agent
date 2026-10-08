/**
 * Sheet-metal script block. The part script stays the source of truth:
 * one marked block holds the sheet spec (JSON) and builds the solid.
 */
import { newPartStarterScript } from '../helperPaletteSnippets.js';
import { DEFAULT_SCRIPT } from '../defaultScript.js';

export const SHEET_METAL_BEGIN = '// --- sheet-metal begin ---';
export const SHEET_METAL_END = '// --- sheet-metal end ---';

export function hasSheetMetalBlock(script) {
  const s = String(script || '');
  const i = s.indexOf(SHEET_METAL_BEGIN);
  return i >= 0 && s.indexOf(SHEET_METAL_END, i) > i;
}

/**
 * Can sheet-metal mode write into this part without clobbering work?
 * Empty, the new-part starter cube, the demo script, or an existing
 * sheet-metal block → yes. Anything else → Start makes a new part.
 */
export function sheetMetalReady(script) {
  const s = String(script ?? '').trim();
  if (!s) return true;
  if (hasSheetMetalBlock(s)) return true;
  return s === newPartStarterScript().trim() || s === DEFAULT_SCRIPT.trim();
}

const SPEC_LINE = /const sheetSpec\s*=\s*(\{.*\});/;

/** Block text for a spec (one JSON line so diffs stay one-line per edit). */
export function sheetMetalBlock(spec) {
  const label = [spec.material, spec.sku].filter(Boolean).join(' · ');
  return [
    SHEET_METAL_BEGIN,
    `// SendCutSend ${label} — edit in Sheet Metal mode`,
    `const sheetSpec = ${JSON.stringify(spec)};`,
    'let part = sheetMetalSolid(sheetSpec);',
    SHEET_METAL_END,
  ].join('\n');
}

/** Parse the spec back out of a script (null when absent / unreadable). */
export function readSheetMetalSpec(script) {
  const s = String(script || '');
  const i = s.indexOf(SHEET_METAL_BEGIN);
  if (i < 0) return null;
  const j = s.indexOf(SHEET_METAL_END, i);
  if (j < 0) return null;
  const m = s.slice(i, j).match(SPEC_LINE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Write the spec into a buffer: replace the existing block, or take over a
 * sheet-ready buffer (empty / starter). Anything else refuses (App makes a
 * new part before it gets here).
 */
export function composeSheetMetalCommit(buffer, spec) {
  const s = String(buffer ?? '');
  const block = sheetMetalBlock(spec);
  if (hasSheetMetalBlock(s)) {
    const i = s.indexOf(SHEET_METAL_BEGIN);
    const j = s.indexOf(SHEET_METAL_END, i) + SHEET_METAL_END.length;
    return { ok: true, buffer: `${s.slice(0, i)}${block}${s.slice(j)}` };
  }
  if (sheetMetalReady(s)) return { ok: true, buffer: `${block}\n` };
  return { ok: false, message: 'This part has other features — start sheet metal on a new part.' };
}
