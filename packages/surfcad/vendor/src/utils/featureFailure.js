/**
 * Which feature a failed run failed in (feature strip red border).
 *
 * The worker runs the script as `new Function(...scope, '"use strict";\n' + script)`.
 * A throw from a helper called by the script still has one frame in that
 * anonymous function: the script line that made the call. The worker maps
 * that frame to a 1-based script line (calibrated once against a probe, so
 * the engine's header lines do not matter) and sends it with the error.
 * The line is then mapped to the marked feature block that contains it.
 *
 * That line is only a fallback. Safari / WebKit frames for a `new Function`
 * body do not reliably name `<anonymous>:L:C` (iPhone Safari never marked a
 * chip), so the worker also TRACKS which marked block is running:
 * `instrumentFeatureBlocks` puts `;__featureEnter(i);` in front of each
 * begin marker and `;__featureLeave(i);` in front of its end marker, on the
 * same lines (no line moves, so `scriptLine` still maps). A throw while a
 * block is open carries that block's id (`featureId`) and text
 * (`featureBlock`). Nothing open (syntax error, a bad `return`, code outside
 * every block) carries none, so no chip is marked. The id wins over the line.
 */
import { parseFeatureMarkers } from './featureMarkers.js';

/** Frames of the `new Function` body: V8 `<anonymous>:L:C`, Firefox `> Function:L:C`. */
const ANON_FRAME = /(?:<anonymous>|> Function):(\d+):(\d+)/;

/** Raw line of the first anonymous-function frame in `stack`, or null. */
export function anonymousFrameLine(stack) {
  const m = ANON_FRAME.exec(String(stack || ''));
  if (!m) return null;
  const line = Number(m[1]);
  return Number.isFinite(line) && line > 0 ? line : null;
}

/**
 * Engine header offset for `new Function` bodies: a throw on body line 2
 * (script line 1, after "use strict") reports at `probeLine`.
 * @returns {number|null}
 */
export function calibrateScriptLineOffset() {
  try {
    new Function('a', '"use strict";\nthrow new Error("probe");')();
  } catch (err) {
    const line = anonymousFrameLine(err?.stack);
    if (line != null) return line - 1;
  }
  return null;
}

/** 1-based script line of the failing call, or null when the stack has none. */
export function scriptLineFromStack(stack, offset) {
  const raw = anonymousFrameLine(stack);
  if (raw == null || !Number.isFinite(offset)) return null;
  const line = raw - offset;
  return line >= 1 ? line : null;
}

/** Character offset of the start of 1-based `line` (clamped to the script). */
export function lineStartOffset(script, line) {
  const text = String(script || '');
  let at = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return at;
}

/**
 * The marked feature that holds the failing line, or null.
 * @returns {{ id: string, kind: string, typeIndex: number, block: string }|null}
 */
export function failedFeatureFor(script, line) {
  const text = String(script || '');
  if (!text || !(Number(line) >= 1)) return null;
  const at = lineStartOffset(text, Number(line));
  const lineEnd = text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at);
  const hit = parseFeatureMarkers(text).find((f) => f.startOffset <= lineEnd && at < f.endOffset);
  if (!hit) return null;
  return {
    id: hit.id,
    kind: hit.kind,
    typeIndex: hit.typeIndex,
    block: text.slice(hit.startOffset, hit.endOffset),
  };
}

/**
 * Ids of strip chips to draw as failed in `script`. A chip keeps the red
 * border while its block text is the one that failed; editing that block
 * (or a run that succeeds) clears it. Another part's script does not match.
 *
 * @param {string} script   the strip's script
 * @param {{ id: string, block: string }|null} failure
 * @returns {Set<string>}
 */
export function failedFeatureIds(script, failure) {
  const out = new Set();
  if (!failure?.id || typeof failure.block !== 'string') return out;
  const text = String(script || '');
  for (const f of parseFeatureMarkers(text)) {
    if (f.id === failure.id && text.slice(f.startOffset, f.endOffset) === failure.block) out.add(f.id);
  }
  return out;
}

// ── Feature-block tracking (engine-independent; primary mapping) ─────────

/** Scope names the instrumented script calls. Not user-visible helpers. */
export const FEATURE_TRACE_ENTER = '__featureEnter';
export const FEATURE_TRACE_LEAVE = '__featureLeave';

/** True when only spaces/tabs sit between the start of the line and `at`. */
function atLineStart(text, at) {
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return true;
}

/**
 * Add enter/leave calls around every marked block of `script`.
 *
 * Calls go on the marker lines themselves (`;__featureEnter(i);// --- … begin ---`),
 * so every script line keeps its number. The leading `;` makes a marker that
 * sits inside an expression a syntax error rather than a silent change; the
 * worker then runs the original script. Markers not at the start of a line
 * are skipped (that block is simply not tracked).
 *
 * @returns {{ script: string, features: Array<{ id: string, block: string }> }}
 *   `features[i]` is the block that `i` names in the calls.
 */
export function instrumentFeatureBlocks(script) {
  const text = String(script || '');
  const feats = parseFeatureMarkers(text);
  if (!feats.length) return { script: text, features: [] };
  const inserts = [];
  const features = feats.map((f, i) => {
    const block = text.slice(f.startOffset, f.endOffset);
    // The end marker starts where the block's last marker line does.
    const endMarkerAt = text.lastIndexOf('\n', f.endOffset - 1) + 1;
    if (atLineStart(text, f.startOffset) && endMarkerAt > f.startOffset && atLineStart(text, endMarkerAt)) {
      inserts.push({ at: f.startOffset, code: `;${FEATURE_TRACE_ENTER}(${i});` });
      inserts.push({ at: endMarkerAt, code: `;${FEATURE_TRACE_LEAVE}(${i});` });
    }
    return { id: f.id, block };
  });
  // Back to front so earlier offsets stay valid; at a shared offset the
  // leave of the earlier block runs before the enter of the next.
  inserts.sort((a, b) => b.at - a.at);
  let out = text;
  for (const ins of inserts) out = out.slice(0, ins.at) + ins.code + out.slice(ins.at);
  return { script: out, features };
}

/**
 * Open-block stack for one run. `enter(i)` pushes, `leave(i)` pops back to
 * (and including) `i`, so a block skipped by an early `leave` cannot linger.
 */
export function createFeatureTracker() {
  const open = [];
  return {
    enter(i) { open.push(i); },
    leave(i) {
      const at = open.lastIndexOf(i);
      if (at >= 0) open.length = at;
    },
    /** Innermost open block index, or null. */
    current() { return open.length ? open[open.length - 1] : null; },
  };
}

/**
 * The failed feature named by the worker's block tracking, matched in
 * `script` by id and block text (the run's script and the strip's agree on
 * ids; the text check guards against a script that changed under it). When
 * the id moved but the identical block is still there, that block is used.
 * @returns {{ id: string, kind: string, typeIndex: number, block: string }|null}
 */
export function failedFeatureForId(script, featureId, featureBlock = null) {
  const text = String(script || '');
  if (!text || typeof featureId !== 'string' || !featureId) return null;
  const feats = parseFeatureMarkers(text);
  const shape = (f) => ({
    id: f.id,
    kind: f.kind,
    typeIndex: f.typeIndex,
    block: text.slice(f.startOffset, f.endOffset),
  });
  const byId = feats.find((f) => f.id === featureId);
  if (byId && (typeof featureBlock !== 'string' || text.slice(byId.startOffset, byId.endOffset) === featureBlock)) {
    return shape(byId);
  }
  if (typeof featureBlock === 'string') {
    const same = feats.filter((f) => text.slice(f.startOffset, f.endOffset) === featureBlock);
    if (same.length === 1) return shape(same[0]);
  }
  return null;
}

/**
 * Feature a failed run outcome points at: the worker's tracked block first,
 * the stack's script line second (V8 / Firefox), else null.
 */
export function failedFeatureFromOutcome(script, { featureId = null, featureBlock = null, scriptLine = null } = {}) {
  return failedFeatureForId(script, featureId, featureBlock) || failedFeatureFor(script, scriptLine);
}
