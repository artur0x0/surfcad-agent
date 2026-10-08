/** Absolute path of the vendored `built/manifold.js` factory inside this package. */
export const modulePath: string;

/** Absolute path of `built/manifold.wasm`, resolved from this package directory. */
export const wasmPath: string;

export interface BoundingBox {
  min: number[];
  max: number[];
}

export interface BodyPart {
  index: number;
  at: number[];
}

export interface MeshData {
  numProp: number;
  vertProperties: number[];
  triVerts: number[];
  numRun?: number;
  runIndex?: number[];
  runOriginalID?: number[];
  runFeature?: unknown;
  faceID?: number[] | null;
}

export interface RunScriptResult {
  manifold: object;
  mesh: MeshData;
  volume: number;
  surfaceArea: number | null;
  /** `'NoError'` when the solid is valid. */
  status: string;
  tris: number;
  boundingBox: BoundingBox;
  bodyCentroids: number[][];
  bodyCount: number;
  parts: BodyPart[];
}

export interface KernelOptions {
  /** Already constructed Manifold module. */
  manifold?: object;
  /** Alias of `manifold`. */
  module?: object;
  /** Path to a `manifold.js` factory. Defaults to this package's vendored factory. */
  modulePath?: string;
  /** Wasm file for that factory. Defaults to this package's `manifold.wasm`. */
  wasmPath?: string;
  locateFile?: (file: string, scriptDirectory?: string) => string;
  setup?: boolean;
  importedModels?: Record<string, unknown>;
}

export interface StepBytes {
  bytes: Uint8Array;
  text: string;
  stepSource: string;
  faces?: number;
}

export interface SheetStepResult {
  bytes: Uint8Array;
  text: string;
  /** `'spec'` when the true-curve sheet writer ran. */
  stepSource: string;
  blocked: boolean;
  dfm: unknown;
  brepError: string | null;
}

export interface ExportOptions {
  name?: string;
  unit?: string;
  title?: string;
  designer?: string;
  /** When set for `'step'`, folds the sheet spec into true-curve STEP. */
  sheetSpec?: object;
  exactStep?: boolean;
  partName?: string;
}

/** Manifold API plus the 71 SurfCAD helpers. */
export function helperScope(mod?: object): Record<string, unknown>;

/** Helper implementations injected into every script. */
export const HELPER_FUNCTIONS: Record<string, (...args: never[]) => unknown>;

/**
 * Load the custom Manifold build shipped with this package, unless `opts`
 * already names a module or factory.
 */
export function loadManifold(opts?: KernelOptions): Promise<object>;

/**
 * Evaluate `source` as a SurfCAD script. The script must return a Manifold.
 * A top-level binding that reuses a helper name throws.
 */
export function runScript(source: string, opts?: KernelOptions): Promise<RunScriptResult>;

/** Binary STL bytes. */
export function meshToStl(mesh: MeshData | object): Uint8Array;

/** Uncompressed 3MF (OPC zip) bytes. */
export function meshTo3mfBytes(mesh: MeshData | object, opts?: ExportOptions): Promise<Uint8Array>;

/** Faceted STEP AP214. Curved faces stay tessellated. */
export function meshToStepBytes(mesh: MeshData | object, opts?: ExportOptions): StepBytes;

/**
 * Sheet-metal STEP. Default `exactStep` writes real cylinders at bends
 * when the spec folds.
 */
export function sheetSpecToStep(spec: object, opts?: ExportOptions & {
  mesh?: MeshData | object | null;
  script?: string | null;
}): SheetStepResult;

/**
 * Export a `runScript` result. `format` is `'stl'`, `'3mf'`, or `'step'`.
 * Pass `sheetSpec` on a step export to request the true-curve writer.
 */
export function exportResult(
  result: RunScriptResult | { mesh?: MeshData | object },
  format: 'stl' | '3mf' | 'step',
  opts?: ExportOptions,
): Promise<Uint8Array>;
