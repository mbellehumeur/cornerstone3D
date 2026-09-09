import { getConfiguration } from '../../init';
import { peerImport } from '../../init';
import { isWebGPURenderingAvailable } from './Planar/webgpuViewportRenderWindow';

export type VtkWasmNamespace = {
  vtkRenderWindow?: (props?: object) => VtkWasmObject;
  vtkRenderWindowInteractor?: (props?: object) => VtkWasmObject;
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
  vtkImageMapper?: (props?: object) => VtkWasmObject;
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

/** Kitware loadAsync rendering backend. */
export type VtkWasmRenderingBackend = 'webgl' | 'webgpu';

type LoadAsync = (options: {
  url?: string;
  urlIsGzip?: boolean;
  rendering?: VtkWasmRenderingBackend;
  exec?: 'sync' | 'async';
}) => Promise<VtkWasmRuntime>;

type VtkWasmLoadOptions = {
  url: string;
  urlIsGzip: boolean;
  rendering: VtkWasmRenderingBackend;
  exec: 'sync' | 'async';
};

/** Runtimes are cached per (url, rendering, exec) so WebGL and WebGPU coexist. */
const runtimePromises = new Map<string, Promise<VtkWasmRuntime>>();
const cachedRuntimes = new Map<string, VtkWasmRuntime>();

let webgpuAvailabilityPromise: Promise<boolean> | null = null;

/** Same-origin JSPI bundle (run `node scripts/fetch-vtk-wasm.mjs`). */
const DEFAULT_SAME_ORIGIN_VTK_WASM_JSPI_TAR =
  '/vtk-wasm/jspi/vtk-wasm32-emscripten.tar.gz';

/** Same-origin non-JSPI sync bundle. */
const DEFAULT_SAME_ORIGIN_VTK_WASM_COMPAT_TAR =
  '/vtk-wasm/compat/vtk-9.7.0-wasm32-emscripten.tar.gz';

/**
 * True when the browser supports WebAssembly JSPI
 * (`WebAssembly.Suspending` / promising). Required for Kitware's unified
 * `latest` glue and for `exec: 'async'` / WebGPU.
 */
export function isVtkWasmJspiAvailable(): boolean {
  return (
    typeof WebAssembly !== 'undefined' &&
    typeof (WebAssembly as typeof WebAssembly & { Suspending?: unknown })
      .Suspending === 'function'
  );
}

type VtkWasmUrlConfig = {
  url?: string;
  jspiUrl?: string;
  compatUrl?: string;
};

/**
 * Resolve which vtk-wasm tar/directory URL to load.
 * - `url` alone forces a single bundle for every browser.
 * - Otherwise pick `jspiUrl` / `compatUrl` (or same-origin defaults) from JSPI.
 */
export function resolveVtkWasmBundleUrl(
  cfg?: VtkWasmUrlConfig | null,
  jspiAvailable: boolean = isVtkWasmJspiAvailable()
): string {
  if (cfg?.url) {
    return cfg.url;
  }
  if (jspiAvailable) {
    return cfg?.jspiUrl ?? DEFAULT_SAME_ORIGIN_VTK_WASM_JSPI_TAR;
  }
  return cfg?.compatUrl ?? DEFAULT_SAME_ORIGIN_VTK_WASM_COMPAT_TAR;
}

export function getVtkWasmBundleUrl(): string {
  return resolveVtkWasmBundleUrl(getConfiguration()?.rendering?.vtkWasm);
}

function runtimeCacheKey(options: VtkWasmLoadOptions): string {
  return `${options.url}|${options.rendering}|${options.exec}`;
}

/** @internal exported for tests */
export function getVtkWasmLoadOptions(
  rendering: VtkWasmRenderingBackend = 'webgl'
): VtkWasmLoadOptions {
  const cfg = getConfiguration()?.rendering?.vtkWasm;
  const url = resolveVtkWasmBundleUrl(cfg);
  // Directory URLs must not be treated as gzip tar (kitware default is true).
  const looksLikeTarGz = /\.tar\.gz(\?|#|$)/i.test(url);
  const urlIsGzip = cfg?.urlIsGzip ?? looksLikeTarGz;
  const wantsAsync = rendering === 'webgpu';
  return {
    url,
    urlIsGzip,
    rendering,
    // WebGPU requires async method execution (JSPI).
    exec: wantsAsync ? 'async' : 'sync',
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

/**
 * True when vtk-wasm can load with `rendering: 'webgpu'` in this browser.
 * Requires JSPI, `navigator.gpu`, and a successful one-shot WebGPU runtime load.
 * Result is cached for the session.
 */
export async function isVtkWasmWebgpuAvailable(): Promise<boolean> {
  if (!isVtkWasmJspiAvailable()) {
    return false;
  }
  if (!isWebGPURenderingAvailable()) {
    return false;
  }
  if (!webgpuAvailabilityPromise) {
    webgpuAvailabilityPromise = (async () => {
      try {
        if (!(await isVtkWasmAvailable())) {
          return false;
        }
        await loadVtkWasmRuntime('webgpu');
        return true;
      } catch {
        return false;
      }
    })();
  }
  return webgpuAvailabilityPromise;
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
 * Load (or reuse) the vtk.wasm runtime for the given rendering backend.
 */
export async function loadVtkWasmRuntime(
  rendering: VtkWasmRenderingBackend = 'webgl'
): Promise<VtkWasmRuntime> {
  if (rendering === 'webgpu' && !isVtkWasmJspiAvailable()) {
    throw new Error(
      '[vtkWasm] WebGPU / exec=async requires WebAssembly JSPI ' +
        '(WebAssembly.Suspending). Use WebGL wasm or a non-JSPI-capable fallback.'
    );
  }
  const options = getVtkWasmLoadOptions(rendering);
  if (options.exec === 'async' && !isVtkWasmJspiAvailable()) {
    throw new Error(
      '[vtkWasm] exec=async requires WebAssembly JSPI (WebAssembly.Suspending).'
    );
  }
  const key = runtimeCacheKey(options);
  const cached = cachedRuntimes.get(key);
  if (cached) {
    return cached;
  }
  let promise = runtimePromises.get(key);
  if (!promise) {
    promise = (async () => {
      const loadAsync = await resolveLoadAsync();
      const runtime = await loadAsync(options);
      cachedRuntimes.set(key, runtime);
      return runtime;
    })().catch((err) => {
      runtimePromises.delete(key);
      throw err;
    });
    runtimePromises.set(key, promise);
  }
  return promise;
}

export type VtkWasmViewportHandle = {
  canvas: HTMLCanvasElement;
  session: VtkWasmStandaloneSession;
  /** Emscripten canvas selector (`!…`) for `vtkRenderWindow({ canvasSelector })`. */
  canvasKey: string;
  vtk: VtkWasmNamespace;
  dispose: () => void;
};

export type CreateVtkWasmViewportHandleOptions = {
  rendering?: VtkWasmRenderingBackend;
};

/**
 * Create a standalone session bound to an overlay canvas in `element`.
 * `options.rendering` selects the Kitware loadAsync backend (webgl|webgpu).
 */
export async function createVtkWasmViewportHandle(
  element: HTMLElement,
  canvasClassName = 'vtk-wasm-canvas',
  options?: CreateVtkWasmViewportHandleOptions
): Promise<VtkWasmViewportHandle> {
  const rendering = options?.rendering ?? 'webgl';
  const runtime = await loadVtkWasmRuntime(rendering);
  const canvas = document.createElement('canvas');
  canvas.className = canvasClassName;
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.visibility = 'visible';
  // High z-index so we sit above the hidden vtk-js canvas / empty viewport chrome.
  canvas.style.zIndex = '20';
  // Let Cornerstone tools (on the viewport element) own input. If this canvas
  // captures events, vtkRenderWindowInteractor Trackball fights TrackballRotate.
  canvas.style.pointerEvents = 'none';
  canvas.style.backgroundColor = 'transparent';
  canvas.tabIndex = -1;
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
  runtimePromises.clear();
  cachedRuntimes.clear();
  webgpuAvailabilityPromise = null;
}
