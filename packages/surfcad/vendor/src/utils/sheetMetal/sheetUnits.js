/**
 * Sheet-metal display units. The spec, sliders' stored values, and the
 * kernel stay millimetres. The UI converts at inputs, sliders, readouts,
 * and DFM text. The choice persists in localStorage.
 */
import { IN_TO_MM } from '../scs/scsCatalog.js';

export const SHEET_DISPLAY_UNIT_KEY = 'surfcad.sheetMetal.displayUnit';

export function normalizeSheetDisplayUnit(unit) {
  return unit === 'in' ? 'in' : 'mm';
}

export function loadSheetDisplayUnit(storage = globalThis.localStorage) {
  try {
    return normalizeSheetDisplayUnit(storage?.getItem?.(SHEET_DISPLAY_UNIT_KEY));
  } catch {
    return 'mm';
  }
}

export function saveSheetDisplayUnit(unit, storage = globalThis.localStorage) {
  const next = normalizeSheetDisplayUnit(unit);
  try {
    storage?.setItem?.(SHEET_DISPLAY_UNIT_KEY, next);
  } catch {
    /* private mode / no storage */
  }
  return next;
}

/** Display number → millimetres. Non-finite input (blank) stays non-finite. */
export function displayToMm(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  return normalizeSheetDisplayUnit(unit) === 'in' ? n * IN_TO_MM : n;
}

/**
 * Millimetres → the number a slider or input shows.
 * Inches round to 0.0001 in (~0.0025 mm) so the field stays stable.
 */
export function displaySheetNumber(mm, unit) {
  const n = Number(mm);
  if (!Number.isFinite(n)) return 0;
  if (normalizeSheetDisplayUnit(unit) !== 'in') return n;
  return Number((n / IN_TO_MM).toFixed(4));
}

/** Slider step in the display unit. Sub-millimetre mm steps stay ≥ 0.001 in. */
export function displaySheetStep(stepMm, unit) {
  const step = Number(stepMm) > 0 ? Number(stepMm) : 0.5;
  if (normalizeSheetDisplayUnit(unit) !== 'in') return step;
  return Math.max(0.001, Number((step / IN_TO_MM).toFixed(3)));
}

/** `12.50 mm` or `0.492 in`. Angles are not lengths — don't pass them here. */
export function formatSheetLength(mm, unit = 'mm', mmDigits = 2) {
  const n = Number(mm);
  if (!Number.isFinite(n)) return '';
  if (normalizeSheetDisplayUnit(unit) === 'in') return `${(n / IN_TO_MM).toFixed(3)} in`;
  return `${n.toFixed(mmDigits)} mm`;
}

/** `10.00 × 6.00 mm` or `0.394 × 0.236 in`. */
export function formatSheetPair(pair, unit = 'mm', mmDigits = 1) {
  if (!Array.isArray(pair)) return '';
  const u = normalizeSheetDisplayUnit(unit);
  const body = pair
    .map((n) => formatSheetLength(n, u, mmDigits).replace(/ (mm|in)$/, ''))
    .join(' × ');
  return `${body} ${u}`;
}
