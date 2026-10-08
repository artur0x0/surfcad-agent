/**
 * SendCutSend (SCS) catalog + engineering specs — the sheet-metal contract.
 *
 * Source: https://sendcutsend.com/llm-search-specs/ links two public CDN
 * JSON files (versioned in the file name). The CDN answers
 * `Access-Control-Allow-Origin: *`, so the browser fetches them directly —
 * no proxy. Both files carry `_meta.schema_version`; it is treated as soft:
 * unknown fields are ignored and missing fields become null.
 *
 * catalog.materials[]  { sku, name, category, grade, thickness, out_of_stock,
 *                        available_services[], min/max_part_size, … }
 * specs.materials[]    { sku, general_specs{gauge}, cutting_specs{min_hole_size,
 *                        min_bridge_size, min_hole_to_edge}, bending_specs{…}, … }
 *
 * Joined on `sku` into one normalized record per SKU (see normalizeScsSku).
 * All SCS lengths are inches; `thicknessMm` is the only mm field (the
 * kernel works in mm).
 */

export const SCS_CATALOG_URL = 'https://cdn.sendcutsend.com/specs/sendcutsend-catalog-v1.2.json';
export const SCS_SPECS_URL = 'https://cdn.sendcutsend.com/specs/sendcutsend-specs-v1.2.json';
export const SCS_SOURCE_PAGE = 'https://sendcutsend.com/llm-search-specs/';
export const SCS_ORDER_URL = 'https://app.sendcutsend.com/';
/** Refresh at most daily; older cache is "stale" but still usable offline. */
export const SCS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SCS_FETCH_TIMEOUT_MS = 15000;
export const IN_TO_MM = 25.4;

/** "0.032" | 0.035 | '0.229"' | "N/A" | "" → number | null. */
export function scsNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const m = value.replace(/,/g, '').match(/-?\d*\.?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "44 x 30" | "0.375x0.25" → [44, 30] | null. */
export function scsSize(value) {
  if (typeof value !== 'string') return null;
  const parts = value.toLowerCase().split('x').map((s) => scsNumber(s.trim()));
  if (parts.length !== 2 || parts.some((n) => n == null)) return null;
  return parts;
}

const roundMm = (n) => Math.round(n * 10000) / 10000;

/**
 * One SKU = catalog row (+ specs row when present).
 * `inStock` is the in-stock filter key; `services` gates features
 * (bending → bends, tapping/countersinking/hardware → hole variants).
 */
export function normalizeScsSku(cat, spec = null) {
  if (!cat || typeof cat.sku !== 'string' || !cat.sku) return null;
  const general = spec?.general_specs || {};
  const cutting = spec?.cutting_specs || {};
  const bending = spec?.bending_specs || null;
  const thicknessIn = scsNumber(cat.thickness) ?? scsNumber(general.thickness);
  if (thicknessIn == null || thicknessIn <= 0) return null;
  const gauge = scsNumber(general.gauge);
  const services = Array.isArray(cat.available_services)
    ? [...new Set(cat.available_services.filter((s) => typeof s === 'string'))].sort()
    : [];
  const outOfStock = cat.out_of_stock === true || general.out_of_stock === true;
  // Hole-to-bend: SCS only publishes it per service (tapping / hardware);
  // "N/A" → null and DFM falls back to a soft rule.
  const holeToBendIn = scsNumber(spec?.hardware_insertion_specs?.min_hole_cl_to_bend_line)
    ?? scsNumber(spec?.tapping_specs?.min_hole_cl_to_bend_line);
  const bend = bending
    ? {
      radiusIn: scsNumber(bending.bend_radius) ?? scsNumber(bending.effective_bend_radius),
      kFactor: scsNumber(bending.k_factor),
      bendDeductionIn: scsNumber(bending.bend_deduction),
      minFlangeIn: scsNumber(bending.min_flange_length_after_bend),
      minFlangeBeforeIn: scsNumber(bending.min_flange_length_before_bend),
      maxAngleDeg: scsNumber(bending.max_bend_angle),
      minAngleDeg: scsNumber(bending.min_bend_angle),
      reliefDepthIn: scsNumber(bending.bend_relief_depth),
      minCornerReliefIn: scsNumber(bending.min_corner_relief_distance_from_bend_line),
      maxBendLengthIn: scsNumber(bending.max_bend_length),
      minFlatIn: scsSize(bending.min_flat_part_size),
      maxFlatIn: scsSize(bending.max_flat_part_size),
    }
    : null;
  return {
    sku: cat.sku,
    name: String(cat.name || cat.grade || cat.sku),
    category: String(cat.category || ''),
    group: String(cat.group || ''),
    subcategory: cat.subcategory ? String(cat.subcategory) : null,
    thicknessIn,
    thicknessMm: roundMm(thicknessIn * IN_TO_MM),
    gauge: gauge != null && gauge > 0 ? gauge : null,
    inStock: !outOfStock,
    services,
    bendable: !!bend && services.includes('bending'),
    cuttingProcess: cat.cutting_process || cutting.cutting_process || null,
    minPartIn: scsSize(cat.min_part_size || cutting.min_part_size),
    maxPartIn: scsSize(cat.max_part_size || cutting.max_part_size),
    bend,
    dfm: {
      minHoleIn: scsNumber(cutting.min_hole_size),
      minBridgeIn: scsNumber(cutting.min_bridge_size),
      minHoleToEdgeIn: scsNumber(cutting.min_hole_to_edge),
      minHoleToBendIn: holeToBendIn,
    },
    learnMoreUrl: typeof general.learn_more_url === 'string' ? general.learn_more_url : null,
  };
}

/**
 * Join catalog + specs on sku. Specs-only SKUs are dropped (not orderable);
 * catalog rows without specs still load (DFM fields null).
 */
export function joinScsCatalog(catalogJson, specsJson) {
  const materials = Array.isArray(catalogJson?.materials) ? catalogJson.materials : null;
  if (!materials) throw new Error('SCS catalog has no materials[]');
  const specBySku = new Map();
  for (const row of (Array.isArray(specsJson?.materials) ? specsJson.materials : [])) {
    if (row && typeof row.sku === 'string') specBySku.set(row.sku, row);
  }
  const seen = new Set();
  const records = [];
  for (const cat of materials) {
    if (!cat || seen.has(cat.sku)) continue;
    const rec = normalizeScsSku(cat, specBySku.get(cat.sku) || null);
    if (!rec) continue;
    seen.add(rec.sku);
    records.push(rec);
  }
  records.sort((a, b) => a.name.localeCompare(b.name) || a.thicknessIn - b.thicknessIn);
  return {
    records,
    meta: {
      catalogSchema: catalogJson?._meta?.schema_version ?? null,
      specsSchema: specsJson?._meta?.schema_version ?? null,
      generatedAt: catalogJson?._meta?.generated_at ?? null,
    },
  };
}

export function inStockSkus(records) {
  return (records || []).filter((r) => r && r.inStock);
}

export function findScsSku(records, sku) {
  return (records || []).find((r) => r.sku === sku) || null;
}

/**
 * Material dropdown: distinct names. A material with only out-of-stock
 * SKUs is still listed (`inStock: false`) so its gauges can be shown
 * disabled. Bendable names sort first.
 */
export function scsMaterialOptions(records) {
  const byName = new Map();
  for (const r of records || []) {
    if (!r?.name) continue;
    const cur = byName.get(r.name);
    if (cur) {
      cur.count += 1;
      cur.bendable = cur.bendable || r.bendable;
      cur.inStock = cur.inStock || r.inStock;
    } else {
      byName.set(r.name, {
        name: r.name, category: r.category, count: 1, bendable: !!r.bendable, inStock: !!r.inStock,
      });
    }
  }
  return [...byName.values()].sort((a, b) => (
    Number(b.bendable) - Number(a.bendable)
    || Number(b.inStock) - Number(a.inStock)
    || a.category.localeCompare(b.category)
    || a.name.localeCompare(b.name)
  ));
}

/** `0.090" · 11 ga · 2.29 mm` */
export function scsGaugeLabel(rec) {
  if (!rec) return '';
  const inch = `${rec.thicknessIn.toFixed(3)}"`;
  const ga = rec.gauge != null ? ` · ${rec.gauge} ga` : '';
  return `${inch}${ga} · ${rec.thicknessMm.toFixed(2)} mm`;
}

/**
 * Gauge dropdown for one material: every SKU, thinnest first.
 * Out-of-stock gauges stay in the list, `disabled`, labeled "out of stock".
 */
export function scsGaugeOptions(records, materialName) {
  return (records || [])
    .filter((r) => r && r.name === materialName)
    .sort((a, b) => a.thicknessIn - b.thicknessIn || Number(b.inStock) - Number(a.inStock) || a.sku.localeCompare(b.sku))
    .map((r) => {
      const bits = [scsGaugeLabel(r)];
      if (!r.bendable) bits.push('no bending');
      if (!r.inStock) bits.push('out of stock');
      return {
        sku: r.sku,
        label: bits.join(' · '),
        bendable: r.bendable,
        inStock: !!r.inStock,
        disabled: !r.inStock,
      };
    });
}

/** Start designing: only an in-stock SKU that exists in the catalog. */
export function canStartSheetMetal(records, sku) {
  const rec = findScsSku(records, sku);
  return !!(rec && rec.inStock);
}

/**
 * What persists on the part row (`part.sheetMetal`). The sku is the key;
 * the rest is a display/offline snapshot so a reload without network still
 * shows the material and thickness.
 */
export function sheetMetalBinding(rec) {
  if (!rec?.sku) return null;
  return {
    sku: rec.sku,
    name: rec.name,
    thicknessIn: rec.thicknessIn,
    gauge: rec.gauge ?? null,
  };
}

/** Validate / clean a stored binding. Anything malformed → null. */
export function normalizeSheetMetalBinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sku = typeof raw.sku === 'string' ? raw.sku.trim() : '';
  if (!sku || sku.length > 80) return null;
  const out = { sku };
  if (typeof raw.name === 'string' && raw.name.trim()) out.name = raw.name.trim().slice(0, 80);
  const t = Number(raw.thicknessIn);
  if (Number.isFinite(t) && t > 0) out.thicknessIn = t;
  const g = Number(raw.gauge);
  if (raw.gauge != null && Number.isFinite(g) && g > 0) out.gauge = g;
  return out;
}

export function scsCacheFresh(entry, now = Date.now(), ttl = SCS_CACHE_TTL_MS) {
  const at = Number(entry?.fetchedAt);
  return Number.isFinite(at) && now - at >= 0 && now - at < ttl;
}

/** fetch → JSON with a timeout; throws a readable message on CORS/offline/HTTP errors. */
export async function fetchScsJson(url, { fetchImpl = globalThis.fetch, timeoutMs = SCS_FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { mode: 'cors', credentials: 'omit', signal: ctl?.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timed out' : (err?.message || String(err));
    throw new Error(`SendCutSend catalog fetch failed (${reason})`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Cache policy:
 *  - fresh cache (< 24 h) → use it, no network
 *  - else fetch both files; success → join, write cache, use it
 *  - fetch failure (offline / CORS / 5xx) → stale cache when present
 *    (`stale: true`), otherwise an empty list + error
 *  - `force` skips the fresh-cache shortcut (Retry button)
 * `cache` = { get(): entry|null, put(entry) }; `fetchJson(url)` injectable.
 */
export async function loadScsCatalog({
  cache,
  fetchJson = (url) => fetchScsJson(url),
  now = () => Date.now(),
  force = false,
} = {}) {
  let cached = null;
  try {
    cached = cache ? await cache.get() : null;
  } catch {
    cached = null;
  }
  const usable = cached && Array.isArray(cached.records) && cached.records.length ? cached : null;
  if (usable && !force && scsCacheFresh(usable, now())) {
    return { records: usable.records, meta: usable.meta || null, fetchedAt: usable.fetchedAt, source: 'cache', stale: false, error: null };
  }
  try {
    const [catalog, specs] = await Promise.all([fetchJson(SCS_CATALOG_URL), fetchJson(SCS_SPECS_URL)]);
    const joined = joinScsCatalog(catalog, specs);
    if (!joined.records.length) throw new Error('SendCutSend catalog is empty');
    const entry = { fetchedAt: now(), records: joined.records, meta: joined.meta };
    try {
      if (cache) await cache.put(entry);
    } catch {
      // Cache write is best-effort; the fresh list is still returned.
    }
    return { records: entry.records, meta: entry.meta, fetchedAt: entry.fetchedAt, source: 'network', stale: false, error: null };
  } catch (err) {
    const error = err?.message || String(err);
    if (usable) {
      return { records: usable.records, meta: usable.meta || null, fetchedAt: usable.fetchedAt, source: 'cache', stale: true, error };
    }
    return { records: [], meta: null, fetchedAt: null, source: 'none', stale: false, error };
  }
}
