import vtkRenderWindow from '@kitware/vtk.js/Rendering/Core/RenderWindow';
import vtkRenderWindowInteractor from '@kitware/vtk.js/Rendering/Core/RenderWindowInteractor';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkWebGPURenderWindow from '@kitware/vtk.js/Rendering/WebGPU/RenderWindow';
import renderingEngineCache from '../../renderingEngineCache';
// Registers the WebGPU view-node overrides (renderer, actors, image mappers,
// textures, ...) on the WebGPU view-node factory so the scene graph can be
// built for the WebGPU view API.
import '@kitware/vtk.js/Rendering/WebGPU/Profiles/All';

/**
 * Minimal typed surface of the vtk.js WebGPU render window (the module ships
 * without type definitions). Only the members this wrapper touches.
 */
interface WebGPUView {
  setSize(width: number, height: number): void;
  getSize(): [number, number] | undefined;
  getCanvas(): HTMLCanvasElement;
  getInitialized(): boolean;
  getDevice():
    | {
        onSubmittedWorkDone(): Promise<void>;
        getHandle(): GPUDevice;
      }
    | undefined;
  onInitialized(callback: () => void): { unsubscribe(): void };
  traverseAllPasses(): void;
  delete(): void;
}

/**
 * A per-viewport WebGPU rendering context: one core vtkRenderWindow with a
 * vtk.js WebGPU view and a single renderer. The WebGPU canvas is attached to
 * the viewport element and presented directly (no CPU 2D blit).
 *
 * This intentionally does NOT go through the engine's shared offscreen
 * OpenGL multi-render-window: the render path that owns this window is
 * self-rendering (its attachment exposes `render()`), so the engine's
 * WebGL render/blit cycle never touches the viewport.
 */
export interface WebGPUViewportWindow {
  renderWindow: ReturnType<typeof vtkRenderWindow.newInstance>;
  view: WebGPUView;
  renderer: ReturnType<typeof vtkRenderer.newInstance>;
  /**
   * Detached interactor required by vtk.js WebGPU VolumePass timing
   * (`getInteractor().isAnimating()`). No DOM events are bound — Cornerstone
   * owns interaction on the visible canvas.
   */
  interactor: ReturnType<typeof vtkRenderWindowInteractor.newInstance>;
  refCount: number;
  destroyTimer?: ReturnType<typeof setTimeout>;
  /** Viewport element the WebGPU canvas is currently mounted under, if any. */
  hostElement?: HTMLElement;
  /**
   * Set when the last binding releases the window. Deferred presents and
   * initialize callbacks must bail out instead of touching deleted vtk objects.
   */
  destroyed: boolean;
}

const windowsByViewportId = new Map<string, WebGPUViewportWindow>();

// Debug handle for the experimental backend: lets devtools sessions inspect
// the detached per-viewport WebGPU windows (canvas, renderer, device state).
(globalThis as { __cs3dWebGPUWindows?: unknown }).__cs3dWebGPUWindows =
  windowsByViewportId;

/**
 * Whether WebGPU rendering can be attempted in this environment.
 * Adapter/device acquisition is asynchronous and can still fail later; this
 * is only the synchronous gate used for registration/selection.
 */
export function isWebGPURenderingAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Gets (or lazily creates) the shared WebGPU window for a viewport.
 * Reference-counted so a source binding and overlays share one device/canvas.
 */
export function acquireWebGPUViewportWindow(
  viewportId: string,
  options?: { renderingEngineId?: string }
): WebGPUViewportWindow {
  let entry = windowsByViewportId.get(viewportId);

  if (!entry) {
    const renderWindow = vtkRenderWindow.newInstance();
    const view = vtkWebGPURenderWindow.newInstance() as unknown as WebGPUView;

    renderWindow.addView(
      view as unknown as Parameters<typeof renderWindow.addView>[0]
    );

    // VolumePass.computeTiming requires a non-null interactor. Mirror the
    // offscreen OpenGL window: create + initialize without binding DOM events.
    const interactor = vtkRenderWindowInteractor.newInstance();
    interactor.setView(
      view as unknown as Parameters<typeof interactor.setView>[0]
    );
    interactor.initialize();

    const renderer = vtkRenderer.newInstance({
      background: resolveViewportBackground(
        options?.renderingEngineId,
        viewportId
      ),
    });
    renderer.getActiveCamera().setParallelProjection(true);
    renderWindow.addRenderer(renderer);

    entry = {
      renderWindow,
      view,
      renderer,
      interactor,
      refCount: 0,
      destroyed: false,
    };
    windowsByViewportId.set(viewportId, entry);
  }

  if (entry.destroyTimer) {
    clearTimeout(entry.destroyTimer);
    entry.destroyTimer = undefined;
  }
  entry.refCount += 1;
  return entry;
}

/**
 * Resolves the viewport's configured background so the WebGPU renderer
 * clears with the same color the WebGL offscreen renderer would use.
 */
function resolveViewportBackground(
  renderingEngineId: string | undefined,
  viewportId: string
): [number, number, number] {
  try {
    const viewport = renderingEngineId
      ? renderingEngineCache.get(renderingEngineId)?.getViewport(viewportId)
      : undefined;
    const background = (
      viewport as { defaultOptions?: { background?: [number, number, number] } }
    )?.defaultOptions?.background;

    return background ?? [0, 0, 0];
  } catch {
    return [0, 0, 0];
  }
}

/**
 * Returns the live WebGPU window for a viewport without changing its
 * reference count. Used by viewports that need to pin camera/canvas helpers
 * onto the same renderer the render path draws with.
 */
export function getWebGPUViewportWindow(
  viewportId: string
): WebGPUViewportWindow | undefined {
  const entry = windowsByViewportId.get(viewportId);

  if (!entry || entry.destroyed) {
    return undefined;
  }

  return entry;
}

/**
 * Marks the detached WebGPU interactor as animating so vtk.js WebGPU
 * VolumePass can use its interaction-scale (small) viewport.
 *
 * Uses `switchToXRAnimation` rather than `requestAnimation`: Cornerstone owns
 * presents on the WebGPU canvas, and an interactor RAF loop would double-render
 * and fake a high frame rate that collapses adaptive scale back to full-res.
 *
 * (vtk.js .d.ts still names these VR*; runtime exposes XR*.)
 */
export function beginWebGPUViewportAnimation(viewportId: string): boolean {
  const entry = windowsByViewportId.get(viewportId);

  if (!entry || entry.destroyed) {
    return false;
  }

  if (entry.interactor.isAnimating()) {
    return true;
  }

  const interactor = entry.interactor as typeof entry.interactor & {
    switchToXRAnimation(): void;
  };
  interactor.switchToXRAnimation();
  return true;
}

/**
 * Clears the interaction-animating flag and leaves the next Cornerstone present
 * at full resolution (VolumePass `_useSmallViewport` off).
 */
export function endWebGPUViewportAnimation(viewportId: string): boolean {
  const entry = windowsByViewportId.get(viewportId);

  if (!entry || entry.destroyed) {
    return false;
  }

  if (!entry.interactor.isAnimating()) {
    return false;
  }

  const interactor = entry.interactor as typeof entry.interactor & {
    returnFromXRAnimation(): void;
  };
  interactor.returnFromXRAnimation();
  return true;
}

/**
 * Mounts the vtk WebGPU canvas into `container` as the visible present
 * surface (absolute, full-bleed). Idempotent when already attached.
 */
export function attachWebGPUViewportCanvas(
  entry: WebGPUViewportWindow,
  container: HTMLElement
): HTMLCanvasElement {
  const canvas = entry.view.getCanvas();

  canvas.style.display = '';
  canvas.style.height = '100%';
  canvas.style.inset = '0';
  canvas.style.pointerEvents = 'auto';
  canvas.style.position = 'absolute';
  canvas.style.width = '100%';
  canvas.style.zIndex = '0';

  if (canvas.parentElement !== container) {
    container.appendChild(canvas);
  }

  entry.hostElement = container;
  return canvas;
}

/** Hides or shows an already-attached WebGPU canvas without unmounting it. */
export function setWebGPUViewportCanvasVisible(
  entry: WebGPUViewportWindow,
  visible: boolean
): void {
  const canvas = entry.view.getCanvas();
  canvas.style.display = visible ? '' : 'none';
  canvas.style.pointerEvents = visible ? 'auto' : 'none';
}

/** Releases one reference; destroys the window when the last binding leaves. */
export function releaseWebGPUViewportWindow(viewportId: string): void {
  const entry = windowsByViewportId.get(viewportId);

  if (!entry) {
    return;
  }

  entry.refCount = Math.max(0, entry.refCount - 1);

  if (entry.refCount > 0 || entry.destroyed) {
    return;
  }

  // Defer destruction so rapid layout switches (MPR ↔ 3D) can reacquire the
  // same window, and so in-flight WebGPU initialize callbacks see
  // `model.deleted` / our `destroyed` flag before objects are torn down.
  entry.destroyTimer = setTimeout(() => {
    entry.destroyTimer = undefined;
    if (entry.refCount > 0 || entry.destroyed) {
      return;
    }
    entry.destroyed = true;
    windowsByViewportId.delete(viewportId);
    entry.view.getCanvas().remove();
    entry.hostElement = undefined;
    entry.renderWindow.removeRenderer(entry.renderer);
    entry.renderer.delete();
    entry.interactor.delete();
    entry.view.delete();
    entry.renderWindow.delete();
  }, 50);
}

export type WebGPUPresentSize =
  | HTMLCanvasElement
  | { width: number; height: number };

/**
 * Renders the WebGPU scene directly to the attached WebGPU canvas.
 * No CPU 2D blit and no GPU fence wait — present is the canvas itself.
 *
 * `sizeSource` supplies the bitmap size (typically the viewport's sized
 * surface or `{ width, height }` from clientSize * dpr). `onPresented` runs
 * after traverse is issued (or after the first device init + traverse).
 */
export function renderWebGPUViewportWindow(
  entry: WebGPUViewportWindow,
  sizeSource: WebGPUPresentSize,
  onPresented?: () => void
): void {
  if (entry.destroyed) {
    return;
  }

  const { view } = entry;
  const { width, height } = resolvePresentSize(sizeSource);
  const [currentWidth, currentHeight] = view.getSize() ?? [0, 0];

  if (currentWidth !== width || currentHeight !== height) {
    view.setSize(width, height);
  }

  const present = () => {
    if (entry.destroyed) {
      return;
    }

    // Handles the uninitialized case internally by queueing a traverse for
    // when the device becomes ready. vtk.js may also invoke traverse from its
    // own onInitialized callback; treat teardown races as soft fails.
    try {
      view.traverseAllPasses();
    } catch {
      return;
    }

    onPresented?.();
  };

  if (view.getInitialized()) {
    present();
    return;
  }

  // Kick device acquisition; vtk queues an internal traverse on init as well.
  try {
    view.traverseAllPasses();
  } catch {
    // Device not ready yet — wait for onInitialized below.
  }

  if (view.getInitialized()) {
    present();
    return;
  }

  const subscription = view.onInitialized(() => {
    subscription.unsubscribe();
    present();
  });
}

function resolvePresentSize(sizeSource: WebGPUPresentSize): {
  width: number;
  height: number;
} {
  if (
    typeof HTMLCanvasElement !== 'undefined' &&
    sizeSource instanceof HTMLCanvasElement
  ) {
    return {
      width: Math.max(sizeSource.width, 1),
      height: Math.max(sizeSource.height, 1),
    };
  }

  const size = sizeSource as { width: number; height: number };
  return {
    width: Math.max(size.width, 1),
    height: Math.max(size.height, 1),
  };
}

/**
 * Overrides the background clear color of a viewport's WebGPU window (e.g.
 * so examples can visually distinguish the webgpu backend from the WebGL
 * one). No-op when the viewport has no live WebGPU window.
 */
export function setWebGPUViewportBackground(
  viewportId: string,
  background: [number, number, number]
): boolean {
  const entry = windowsByViewportId.get(viewportId);

  if (!entry || entry.destroyed) {
    return false;
  }

  const current = entry.renderer.getBackground();

  if (
    current?.[0] === background[0] &&
    current?.[1] === background[1] &&
    current?.[2] === background[2]
  ) {
    return false;
  }

  entry.renderer.setBackground(...background);
  return true;
}

/**
 * Debug information about a viewport's WebGPU window (used by examples /
 * debug panels to indicate that the vtk.js WebGPU view API is active).
 */
export function getWebGPUViewportDebugInfo(viewportId: string):
  | {
      viewApi: 'WebGPU';
      initialized: boolean;
      adapter?: string;
    }
  | undefined {
  const entry = windowsByViewportId.get(viewportId);

  if (!entry) {
    return undefined;
  }

  const initialized = entry.view.getInitialized();
  let adapter: string | undefined;

  try {
    const info = entry.view.getDevice()?.getHandle()?.adapterInfo;

    if (info) {
      adapter = [info.vendor, info.architecture, info.description]
        .filter(Boolean)
        .join(' / ');
    }
  } catch {
    adapter = undefined;
  }

  return { viewApi: 'WebGPU', initialized, adapter };
}
