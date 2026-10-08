// ISO metric coarse + common UNC fastener hole diameters (mm).
// Puzzle vocabulary for SurfCAD MVP: clearance / tap-drill lookups.
// Sources: standard metric clearance (ISO 273 close/medium/coarse ≈ CadQuery
// Close/Normal/Loose) and recommended tap-drill for ISO metric coarse /
// UNC ~75% thread. Keep scripts/golden/smoke_slice01.mjs expectations in sync.

/**
 * Metric ISO coarse. Keys use '_' for decimal (M2_5 = M2.5).
 * tap = recommended tap drill Ø; close/normal/loose = clearance Ø.
 */
export const FASTENER_METRIC = Object.freeze({
  M1_6: { major: 1.6, tap: 1.25, close: 1.8, normal: 1.8, loose: 2.0 },
  M2:   { major: 2,   tap: 1.6,  close: 2.2, normal: 2.4, loose: 2.6 },
  M2_5: { major: 2.5, tap: 2.05, close: 2.7, normal: 2.9, loose: 3.1 },
  M3:   { major: 3,   tap: 2.5,  close: 3.2, normal: 3.4, loose: 3.6 },
  M4:   { major: 4,   tap: 3.3,  close: 4.3, normal: 4.5, loose: 4.8 },
  M5:   { major: 5,   tap: 4.2,  close: 5.3, normal: 5.5, loose: 5.8 },
  M6:   { major: 6,   tap: 5.0,  close: 6.4, normal: 6.6, loose: 7.0 },
  M8:   { major: 8,   tap: 6.8,  close: 8.4, normal: 9.0, loose: 10.0 },
  M10:  { major: 10,  tap: 8.5,  close: 10.5, normal: 11.0, loose: 12.0 },
  M12:  { major: 12,  tap: 10.2, close: 13.0, normal: 14.0, loose: 15.0 },
  M16:  { major: 16,  tap: 14.0, close: 17.0, normal: 18.0, loose: 19.0 },
  M20:  { major: 20,  tap: 17.5, close: 21.0, normal: 22.0, loose: 24.0 },
});

/** UNC / imperial (inch nominal → mm diameters). */
export const FASTENER_UNC = Object.freeze({
  '#4-40':   { major: 2.8448, tap: 2.2606, close: 3.048, normal: 3.175, loose: 3.556 },
  '#6-32':   { major: 3.5052, tap: 2.7178, close: 3.658, normal: 3.797, loose: 4.216 },
  '#8-32':   { major: 4.1656, tap: 3.4544, close: 4.318, normal: 4.496, loose: 4.978 },
  '#10-24':  { major: 4.8260, tap: 3.797,  close: 4.978, normal: 5.182, loose: 5.563 },
  '#10-32':  { major: 4.8260, tap: 4.0894, close: 4.978, normal: 5.182, loose: 5.563 },
  '1/4-20':  { major: 6.35,   tap: 5.1054, close: 6.53,  normal: 6.75,  loose: 7.14 },
  '5/16-18': { major: 7.9375, tap: 6.5278, close: 8.33,  normal: 8.43,  loose: 9.0 },
  '3/8-16':  { major: 9.525,  tap: 7.9375, close: 9.93,  normal: 10.0,  loose: 10.5 },
});

const FIT_ALIASES = Object.freeze({
  close: 'close', tight: 'close', fine: 'close',
  normal: 'normal', medium: 'normal', standard: 'normal',
  loose: 'loose', coarse: 'loose', free: 'loose',
});

function metricDisplayKey(key) {
  return key.replace('_', '.');
}

/**
 * Normalize a fastener size token to a table key + series.
 * Accepts: 'M3', 'm3', 3, '3', 'M2.5', 'M2_5', '#8-32', '1/4-20'.
 */
export function resolveFastenerSize(size) {
  if (size == null || size === '') {
    throw new Error(`fastener size: expected e.g. 'M3' or '#8-32' (got ${JSON.stringify(size)})`);
  }

  if (typeof size === 'number') {
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`fastener size: numeric size must be > 0 (got ${size})`);
    }
    const key = `M${String(size).replace('.', '_')}`;
    const entry = FASTENER_METRIC[key];
    if (!entry) {
      throw new Error(
        `fastener size: unknown metric M${size} — supported: ${listFastenerSizes().metric.join(', ')}`,
      );
    }
    return { key, series: 'metric', entry };
  }

  const raw = String(size).trim();
  const upper = raw.toUpperCase();

  // Metric: M3 / m3 / 3 / M2.5 / M2_5
  const m = upper.match(/^M?\s*(\d+(?:[._]\d+)?)$/);
  if (m) {
    const key = `M${m[1].replace('.', '_')}`;
    const entry = FASTENER_METRIC[key];
    if (!entry) {
      throw new Error(
        `fastener size: unknown metric '${raw}' — supported: ${listFastenerSizes().metric.join(', ')}`,
      );
    }
    return { key, series: 'metric', entry };
  }

  // UNC
  const uncKey = raw.replace(/\s+/g, '');
  for (const k of Object.keys(FASTENER_UNC)) {
    if (k.toLowerCase() === uncKey.toLowerCase()) {
      return { key: k, series: 'unc', entry: FASTENER_UNC[k] };
    }
  }
  throw new Error(
    `fastener size: unknown '${raw}' — metric: ${listFastenerSizes().metric.join(', ')}; unc: ${listFastenerSizes().unc.join(', ')}`,
  );
}

export function normalizeClearanceFit(fit = 'normal') {
  const k = String(fit ?? 'normal').toLowerCase().trim();
  const n = FIT_ALIASES[k];
  if (!n) {
    throw new Error(`clearance fit: expected 'close'|'normal'|'loose' (got ${JSON.stringify(fit)})`);
  }
  return n;
}

/** Clearance diameter (mm) for a fastener size + fit. */
export function fastenerClearanceDia(size, fit = 'normal') {
  const { entry, key } = resolveFastenerSize(size);
  const f = normalizeClearanceFit(fit);
  const dia = entry[f];
  if (!(dia > 0)) throw new Error(`fastenerClearanceDia: no ${f} clearance for ${metricDisplayKey(key)}`);
  return dia;
}

/** Tap-drill diameter (mm) for a fastener size. */
export function fastenerTapDrillDia(size) {
  const { entry, key } = resolveFastenerSize(size);
  if (!(entry.tap > 0)) {
    throw new Error(`fastenerTapDrillDia: no tap drill for ${metricDisplayKey(key)}`);
  }
  return entry.tap;
}

/** Major / nominal diameter (mm). */
export function fastenerMajorDia(size) {
  return resolveFastenerSize(size).entry.major;
}

export function listFastenerSizes() {
  return {
    metric: Object.keys(FASTENER_METRIC).map(metricDisplayKey),
    unc: Object.keys(FASTENER_UNC),
  };
}
