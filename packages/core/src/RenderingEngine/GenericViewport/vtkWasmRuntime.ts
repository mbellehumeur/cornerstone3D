import { getConfiguration } from '../../init';
import { peerImport } from '../../init';

export type VtkWasmNamespace = {
  vtkRenderWindow?: (props?: object) => VtkWasmObject;
  vtkRenderer?: (props?: object) => VtkWasmObject;
  vtkCamera?: (props?: object) => VtkWasmObject;
  vtkImageData?: (props?: object) => VtkWasmObject;
  vtkVolume?: (props?: object) => VtkWasmObject;
  vtkGPUVolumeRayCastMapper?: (props?: object) => VtkWasmObject;
  vtkVolumeProperty?: (props?: object) => VtkWasmObject;
  vtkPiecewiseFunction?: (props?: object) => VtkWasmObject;
  vtkColorTransferFunction?: (props?: object) => VtkWasmObject;
  vtkImageSlice?: (props?: object) => VtkWasmObject;
  vtkImageResliceMapper?: (props?: object) => VtkWasmObject;
  vtkPlane?: (props?: object) => VtkWasmObject;
  vtkDataArray?: (props?: object) => VtkWasmObject;
  vtkMatrix3x3?: (props?: object) => VtkWasmObject;
  [key: string]: ((props?: object) => VtkWasmObject) | undefined;
};

export type VtkWasmObject = {
  /** Batch property update (vtk-wasm). Not vtk-js `set`. */
  $set?: (props: Record<string, unknown>) => void;
  $id?: number;
  $delete?: () => void;
  [key: string]: unknown;
};

export type VtkWasmTypedArrayInterface = {
  /** `malloc` — caller owns until free or transfer via setArray(save=0). */
  alloc?: (byteLength: number) => number | bigint;
  free?: (pointer: number | bigint) => void;
  toSizeType?: (value: number) => number | bigint;
  viewAt?: (
    pointer: number | bigint,
    length: number,
    TypedArrayConstructor: new (
      buffer: ArrayBufferLike,
      byteOffset: number,
      length: number
    ) => ArrayBufferView
  ) => ArrayBufferView;
  copyToHeap?: (typedArray: ArrayBufferView) => number | bigint;
  toVTKAoSArray: (
    typedArray: ArrayBufferView,
    numberOfComponents?: number,
    name?: string
  ) => VtkWasmObject;
  /** View onto an existing vtk DataArray's wasm heap storage (no copy). */
  toJSTypedArray?: (vtkArray: VtkWasmObject) => ArrayBufferView;
};

export type VtkWasmStandaloneSession = {
  vtk: VtkWasmNamespace;
  /** Kitware order: key first (must start with `!`), then canvas. */
  registerCanvas: (key: string, canvas: HTMLCanvasElement) => string;
  dispose: () => void;
  typedArrayInterface?: VtkWasmTypedArrayInterface;
  native?: unknown;
};

export type VtkWasmRuntime = {
  createStandaloneSession: () => VtkWasmStandaloneSession;
  dispose: () => void;
};

type LoadAsync = (options: {
  url?: string;
  urlIsGzip?: boolean;
  rendering?: 'webgl' | 'webgpu';
  exec?: 'sync' | 'async';
}) => Promise<VtkWasmRuntime>;

let runtimePromise: Promise<VtkWasmRuntime> | null = null;
let cachedRuntime: VtkWasmRuntime | null = null;

const DEFAULT_VTK_WASM_BUNDLE_URL =
  'https://raw.githack.com/Kitware/vtk-wasm/dist/latest/vtk-wasm32-emscripten.tar.gz';

/** Same-origin tar.gz (embeds types/ → method table). Prefer over bare directory. */
const DEFAULT_SAME_ORIGIN_VTK_WASM_TAR =
  '/vtk-wasm/vtk-wasm32-emscripten.tar.gz';

export function getVtkWasmBundleUrl(): string {
  return (
    getConfiguration()?.rendering?.vtkWasm?.url ?? DEFAULT_VTK_WASM_BUNDLE_URL
  );
}

function getVtkWasmLoadOptions(): {
  url: string;
  urlIsGzip: boolean;
  rendering: 'webgl';
  exec: 'sync';
} {
  const cfg = getConfiguration()?.rendering?.vtkWasm;
  const url = cfg?.url ?? DEFAULT_SAME_ORIGIN_VTK_WASM_TAR;
  // Directory URLs must not be treated as gzip tar (kitware default is true).
  const looksLikeTarGz = /\.tar\.gz(\?|#|$)/i.test(url);
  const urlIsGzip = cfg?.urlIsGzip ?? looksLikeTarGz;
  return {
    url,
    urlIsGzip,
    rendering: 'webgl',
    exec: 'sync',
  };
}

/**
 * True when a loader for @kitware/vtk-wasm can be resolved (peerImport or
 * dynamic import). Does not download the .wasm until {@link loadVtkWasmRuntime}.
 */
export async function isVtkWasmAvailable(): Promise<boolean> {
  try {
    await resolveLoadAsync();
    return true;
  } catch {
    return false;
  }
}

async function resolveLoadAsync(): Promise<LoadAsync> {
  // peerImport may throw (OHIF uses bare import() without an import map) or
  // return a .default that lacks loadAsync (named export only). Never let that
  // skip the bundler-resolved dynamic import below.
  try {
    const fromPeer = await peerImport('@kitware/vtk-wasm');
    if (typeof fromPeer?.loadAsync === 'function') {
      return fromPeer.loadAsync as LoadAsync;
    }
  } catch {
    // OHIF peerImport uses bare import() without an import map — fall through.
  }

  try {
    // Optional dependency — may be absent until apps install @kitware/vtk-wasm.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — package may not be installed in this workspace
    const mod = await import('@kitware/vtk-wasm');
    if (typeof mod?.loadAsync === 'function') {
      return mod.loadAsync as LoadAsync;
    }
  } catch {
    // fall through
  }

  throw new Error(
    '[vtkWasm] @kitware/vtk-wasm is not available. Install it and/or provide peerImport("@kitware/vtk-wasm"), then call registerVtkWasmRenderBackend().'
  );
}

/**
 * Load (or reuse) the vtk.wasm WebGL runtime.
 */
export async function loadVtkWasmRuntime(): Promise<VtkWasmRuntime> {
  if (cachedRuntime) {
    return cachedRuntime;
  }
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const loadAsync = await resolveLoadAsync();
      const runtime = await loadAsync(getVtkWasmLoadOptions());
      cachedRuntime = runtime;
      return runtime;
    })().catch((err) => {
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}

export type VtkWasmViewportHandle = {
  canvas: HTMLCanvasElement;
  session: VtkWasmStandaloneSession;
  /** Emscripten canvas selector (`!…`) for `vtkRenderWindow({ canvasSelector })`. */
  canvasKey: string;
  vtk: VtkWasmNamespace;
  dispose: () => void;
};

/**
 * Create a standalone WebGL session bound to an overlay canvas in `element`.
 */
export async function createVtkWasmViewportHandle(
  element: HTMLElement,
  canvasClassName = 'vtk-wasm-canvas'
): Promise<VtkWasmViewportHandle> {
  const runtime = await loadVtkWasmRuntime();
  const canvas = document.createElement('canvas');
  canvas.className = canvasClassName;
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.zIndex = '1';
  element.appendChild(canvas);

  const session = runtime.createStandaloneSession();
  // Kitware API: registerCanvas(key, canvas) — key must start with `!`.
  const canvasKey = session.registerCanvas(`!vtkWasm-${Date.now()}`, canvas);
  const vtk = session.vtk;

  return {
    canvas,
    session,
    canvasKey,
    vtk,
    dispose: () => {
      try {
        session.dispose();
      } catch {
        // ignore
      }
      canvas.remove();
    },
  };
}

export function resizeVtkWasmCanvas(
  canvas: HTMLCanvasElement,
  element: HTMLElement
): [number, number] {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(element.clientWidth * dpr));
  const height = Math.max(1, Math.round(element.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return [width, height];
}

/**
 * Keep the wasm OpenGL render-window viewport matched to the canvas bitmap.
 * Resizing only `canvas.width/height` leaves a stale GL viewport (stretched or
 * blank). Prefer vtkWindow.SetSize(width, height) — Size is a 2-int method,
 * not an array property setter.
 */
export async function syncVtkWasmRenderWindowSize(
  renderWindow: VtkWasmObject | undefined,
  width: number,
  height: number
): Promise<void> {
  if (!renderWindow || width < 1 || height < 1) {
    return;
  }
  const w = Math.round(width);
  const h = Math.round(height);

  const setSize = renderWindow.setSize as
    | ((a: number, b?: number) => unknown)
    | undefined;
  if (typeof setSize === 'function') {
    // vtkWindow::SetSize(int width, int height)
    await setSize(w, h);
  } else {
    renderWindow.$set?.({ size: [w, h] });
  }

  await (renderWindow.modified as (() => unknown) | undefined)?.();
}

/** @internal test helper */
export function __resetVtkWasmRuntimeForTests(): void {
  runtimePromise = null;
  cachedRuntime = null;
}
