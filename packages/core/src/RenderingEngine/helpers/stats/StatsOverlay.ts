import renderingEngineCache from '../../renderingEngineCache';
import {
  RenderModesPanel,
  type RenderModePanelBinding,
} from './RenderModesPanel';
import { MviewTargetFpsPanel } from './MviewTargetFpsPanel';
import { MaxTexturesPanel } from './MaxTexturesPanel';
import { StatsPanel } from './StatsPanel';
import type { Panel, StatsInstance, PerformanceWithMemory } from './types';
import { PanelType } from './enums';
import { STATS_CONFIG, PANEL_CONFIGS, CONVERSION } from './constants';
import {
  getMviewVolume3D,
  getMviewVolume3DTargetFps,
  getMviewVolume3DTargetFpsEnabled,
} from '../../GenericViewport/Volume3D/mviewVolume3DRegistry';

/**
 * Singleton class for managing the stats overlay.
 * Provides FPS, MS, and memory usage monitoring.
 * Credits: https://github.com/mrdoob/stats.js/blob/master/LICENSE
 */
export class StatsOverlay implements StatsInstance {
  private static instance: StatsOverlay | null = null;

  public dom: HTMLDivElement | null = null;
  private startTime: number = 0;
  private lastUpdateTime: number = 0;
  private frameCount = 0;
  private panels: Map<PanelType, Panel> = new Map();
  private metricsColumn: HTMLDivElement | null = null;
  private bindingsColumn: HTMLDivElement | null = null;
  private animationFrameId: number | null = null;
  private isSetup = false;
  private dragPointerId: number | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private readonly handlePointerDown = (event: PointerEvent) =>
    this.onPointerDown(event);
  private readonly handlePointerMove = (event: PointerEvent) =>
    this.onPointerMove(event);
  private readonly handlePointerUp = (event: PointerEvent) =>
    this.onPointerUp(event);

  private constructor() {}

  /**
   * Gets the singleton instance of StatsOverlay.
   */
  public static getInstance(): StatsOverlay {
    if (!StatsOverlay.instance) {
      StatsOverlay.instance = new StatsOverlay();
    }
    return StatsOverlay.instance;
  }

  /**
   * Sets up the stats overlay and starts the animation loop.
   */
  public setup(): void {
    if (this.isSetup) {
      return;
    }

    try {
      // Initialize DOM and timing
      this.dom = this.createOverlayElement();
      this.startTime = performance.now();
      this.lastUpdateTime = this.startTime;

      // Initialize panels (all stacked vertically; no cycling).
      this.initializePanels();

      // Apply styles and add to DOM
      this.applyOverlayStyles();
      this.attachCloseButton();
      this.restorePosition();
      this.attachDragHandlers();
      document.body.appendChild(this.dom);
      this.startLoop();
      this.isSetup = true;
    } catch (error) {
      console.warn('Failed to setup stats overlay:', error);
    }
  }

  /**
   * Cleans up the stats overlay by removing it from the DOM and stopping the animation loop.
   */
  public cleanup(): void {
    this.stopLoop();
    this.detachDragHandlers();

    if (this.dom && this.dom.parentNode) {
      this.dom.parentNode.removeChild(this.dom);
    }

    this.dom = null;
    this.metricsColumn = null;
    this.bindingsColumn = null;
    this.panels.clear();
    this.isSetup = false;
  }

  /**
   * No-op retained for backwards compatibility with the {@link StatsInstance}
   * contract. Panels are always stacked vertically and all visible.
   */
  public showPanel(_panelType: number): void {
    // All panels are rendered together -- nothing to toggle.
  }

  /**
   * Updates the stats display.
   */
  public update(): void {
    this.startTime = this.updateStats();
  }

  /**
   * Creates the overlay DOM element.
   */
  private createOverlayElement(): HTMLDivElement {
    return document.createElement('div');
  }

  /**
   * Applies styles to the overlay element.
   */
  private applyOverlayStyles(): void {
    Object.assign(this.dom.style, STATS_CONFIG.OVERLAY_STYLES);
    // Anchor for the absolute close button.
    this.dom.style.position = 'fixed';
  }

  private attachCloseButton(): void {
    if (!this.dom) {
      return;
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'cs3d-stats-overlay-close';
    close.setAttribute('aria-label', 'Close stats overlay');
    close.title = 'Close HUD (Ctrl+Shift+D)';
    close.textContent = '×';
    Object.assign(close.style, {
      position: 'absolute',
      top: '2px',
      right: '2px',
      zIndex: '1',
      width: '22px',
      height: '22px',
      margin: '0',
      padding: '0',
      border: '1px solid rgba(255, 255, 255, 0.35)',
      borderRadius: '3px',
      background: 'rgba(0, 0, 0, 0.65)',
      color: '#fff',
      fontSize: '16px',
      fontWeight: '700',
      lineHeight: '18px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
    });

    close.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.cleanup();
    });

    this.dom.appendChild(close);
  }

  /**
   * Initializes all panels.
   */
  private initializePanels(): void {
    this.initializePanelColumns();

    // Always create FPS and MS panels
    const fpsPanel = new StatsPanel(
      PANEL_CONFIGS[PanelType.FPS].name,
      PANEL_CONFIGS[PanelType.FPS].foregroundColor,
      PANEL_CONFIGS[PanelType.FPS].backgroundColor
    );
    this.addPanel(PanelType.FPS, fpsPanel);

    const msPanel = new StatsPanel(
      PANEL_CONFIGS[PanelType.MS].name,
      PANEL_CONFIGS[PanelType.MS].foregroundColor,
      PANEL_CONFIGS[PanelType.MS].backgroundColor
    );
    this.addPanel(PanelType.MS, msPanel);

    // Only create memory panel if available
    if (this.isMemoryAvailable()) {
      const memPanel = new StatsPanel(
        PANEL_CONFIGS[PanelType.MEMORY].name,
        PANEL_CONFIGS[PanelType.MEMORY].foregroundColor,
        PANEL_CONFIGS[PanelType.MEMORY].backgroundColor
      );
      this.addPanel(PanelType.MEMORY, memPanel);
    }

    this.addPanel(PanelType.RENDER_MODES, new RenderModesPanel());
    this.addPanel(PanelType.MVIEW_TARGET_FPS, new MviewTargetFpsPanel());
    this.addPanel(PanelType.MAX_TEXTURES, new MaxTexturesPanel());
  }

  private initializePanelColumns(): void {
    this.metricsColumn = document.createElement('div');
    this.metricsColumn.style.cssText = `
      display:flex;
      flex-direction:column;
      flex:0 0 auto;
    `;

    this.bindingsColumn = document.createElement('div');
    this.bindingsColumn.style.cssText = `
      display:flex;
      flex-direction:column;
      flex:0 1 auto;
      min-width:0;
    `;

    this.dom.appendChild(this.metricsColumn);
    this.dom.appendChild(this.bindingsColumn);
  }

  /**
   * Checks if memory monitoring is available.
   */
  private isMemoryAvailable(): boolean {
    const perf = performance as PerformanceWithMemory;
    return perf.memory !== undefined;
  }

  /**
   * Adds a panel to the overlay.
   */
  private addPanel(type: PanelType, panel: Panel): void {
    const column =
      type === PanelType.RENDER_MODES ||
      type === PanelType.MVIEW_TARGET_FPS ||
      type === PanelType.MAX_TEXTURES
        ? this.bindingsColumn
        : this.metricsColumn;

    (column ?? this.dom).appendChild(panel.dom);
    this.panels.set(type, panel);
  }

  /**
   * Starts the animation frame loop.
   */
  private startLoop(): void {
    const loop = () => {
      this.update();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  /**
   * Stops the animation frame loop.
   */
  private stopLoop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Updates all stats panels.
   */
  private updateStats(): number {
    this.frameCount++;
    const currentTime = performance.now();
    const deltaTime = currentTime - this.startTime;

    // Update MS panel
    const msPanel = this.panels.get(PanelType.MS);
    if (msPanel) {
      msPanel.update(deltaTime, STATS_CONFIG.MAX_MS_VALUE);
    }

    // Update FPS panel every second
    if (currentTime >= this.lastUpdateTime + STATS_CONFIG.UPDATE_INTERVAL) {
      const fps =
        (this.frameCount * CONVERSION.MS_PER_SECOND) /
        (currentTime - this.lastUpdateTime);

      const fpsPanel = this.panels.get(PanelType.FPS);
      if (fpsPanel) {
        fpsPanel.update(fps, STATS_CONFIG.MAX_FPS_VALUE);
      }

      this.lastUpdateTime = currentTime;
      this.frameCount = 0;

      // Update memory panel if available
      this.updateMemoryPanel();
      this.updateRenderModesPanel();
    }

    // Refresh mview Target FPS every frame so budget steering is visible live.
    this.updateMviewTargetFpsPanel();
    this.updateMaxTexturesPanel();

    return currentTime;
  }

  /**
   * Pushes mview Target FPS / budget stats for each mview Volume3D viewport.
   */
  private updateMviewTargetFpsPanel(): void {
    const panel = this.panels.get(PanelType.MVIEW_TARGET_FPS);

    if (!(panel instanceof MviewTargetFpsPanel)) {
      return;
    }

    const entries = [];

    for (const renderingEngine of renderingEngineCache.getAll()) {
      if (!renderingEngine || renderingEngine.hasBeenDestroyed) {
        continue;
      }

      for (const viewport of renderingEngine.getViewports()) {
        const entry = getMviewVolume3D(viewport.id);
        if (!entry?.renderer) {
          continue;
        }

        const stats = (entry.renderer.getStats?.() ?? {}) as Partial<{
          targetFps: number;
          budgetPx: number;
          minPx: number;
          targetFpsPhase: 'off' | 'ready' | 'learn' | 'steer';
          lastDragAvgFps: number;
          lastDragFrames: number;
          fps: number;
          lastDragScale: number;
          scale: number;
          lastDragSteps: number;
          steps: number;
          interacting: boolean;
          gpuVendor: string;
          gpuArchitecture: string;
          gpuAdapterType: string;
          performanceTier: string;
        }>;
        const targeting =
          getMviewVolume3DTargetFpsEnabled(viewport.id) !== false;
        const configured =
          getMviewVolume3DTargetFps(viewport.id) ?? Number(stats.targetFps);
        const targetFps = Number(configured) || 0;
        // Interactive controller budget only (never still profile ceiling).
        const budgetPx = Number(stats.budgetPx) || 0;
        const minPx = Number(stats.minPx) || 0;
        const emaFps = Number(stats.lastDragAvgFps) || Number(stats.fps) || 0;
        const scale = Number(stats.lastDragScale) || Number(stats.scale) || 0;
        const steps = Number(stats.lastDragSteps) || Number(stats.steps) || 0;
        const dragFrames = Number(stats.lastDragFrames) || 0;
        const rawPhase = stats.targetFpsPhase;
        const phase =
          rawPhase === 'ready' ||
          rawPhase === 'learn' ||
          rawPhase === 'steer' ||
          rawPhase === 'off'
            ? rawPhase
            : targeting
              ? 'steer'
              : 'off';

        entries.push({
          viewportId: `${renderingEngine.id}/${viewport.id}`,
          targetFps: targeting ? targetFps : 0,
          targeting,
          interacting: Boolean(stats.interacting),
          phase: targeting ? phase : 'off',
          emaFps,
          budgetPx,
          minPx,
          scale,
          steps,
          dragFrames,
          gpuVendor: String(stats.gpuVendor || ''),
          gpuArchitecture: String(stats.gpuArchitecture || ''),
          gpuAdapterType: String(stats.gpuAdapterType || ''),
          performanceTier: String(stats.performanceTier || ''),
        });
      }
    }

    panel.setContent(entries);
  }

  private updateMaxTexturesPanel(): void {
    const panel = this.panels.get(PanelType.MAX_TEXTURES);

    if (!(panel instanceof MaxTexturesPanel)) {
      return;
    }

    const entries = [];

    for (const renderingEngine of renderingEngineCache.getAll()) {
      if (!renderingEngine || renderingEngine.hasBeenDestroyed) {
        continue;
      }

      for (const viewport of renderingEngine.getViewports()) {
        const entry = getMviewVolume3D(viewport.id);
        if (!entry?.renderer) {
          continue;
        }

        const stats = (entry.renderer.getStats?.() ?? {}) as Partial<{
          sourceDimensions: [number, number, number] | null;
          activeDimensions: [number, number, number] | null;
          downsampleScale: number;
          maxTextureDimension3D: number;
          volumeMode: 'coarseFull' | 'roiRefined';
          roiSourceDimensions: [number, number, number] | null;
          visibleSourceDimensions: [number, number, number] | null;
          visibleSourceTotal: [number, number, number] | null;
          visibleSliceRange: [number, number] | null;
          vtkVisibleSourceDimensions: [number, number, number] | null;
          vtkVisibleSliceRange: [number, number] | null;
          volumeWorkBusy: boolean;
          volumeWorkLabel: string;
          lastVolumeReloadMs: number;
          isLossy: boolean;
        }>;

        entries.push({
          viewportId: `${renderingEngine.id}/${viewport.id}`,
          sourceDimensions: Array.isArray(stats.sourceDimensions)
            ? stats.sourceDimensions
            : null,
          activeDimensions: Array.isArray(stats.activeDimensions)
            ? stats.activeDimensions
            : null,
          downsampleScale: Number(stats.downsampleScale) || 1,
          maxTextureDimension3D: Number(stats.maxTextureDimension3D) || 0,
          volumeMode: stats.volumeMode,
          roiSourceDimensions: Array.isArray(stats.roiSourceDimensions)
            ? stats.roiSourceDimensions
            : null,
          visibleSourceDimensions: Array.isArray(stats.visibleSourceDimensions)
            ? stats.visibleSourceDimensions
            : null,
          visibleSourceTotal: Array.isArray(stats.visibleSourceTotal)
            ? stats.visibleSourceTotal
            : null,
          visibleSliceRange: Array.isArray(stats.visibleSliceRange)
            ? stats.visibleSliceRange
            : null,
          vtkVisibleSourceDimensions: Array.isArray(
            stats.vtkVisibleSourceDimensions
          )
            ? stats.vtkVisibleSourceDimensions
            : null,
          vtkVisibleSliceRange: Array.isArray(stats.vtkVisibleSliceRange)
            ? stats.vtkVisibleSliceRange
            : null,
          volumeWorkBusy: Boolean(stats.volumeWorkBusy),
          volumeWorkLabel: stats.volumeWorkLabel || '',
          lastVolumeReloadMs: Number(stats.lastVolumeReloadMs) || 0,
          isLossy:
            typeof stats.isLossy === 'boolean' ? stats.isLossy : undefined,
        });
      }
    }

    panel.setContent(entries);
  }

  /**
   * Collects every viewport's GenericViewport binding debug state from the
   * rendering engine cache and pushes a role-aware list to the bindings panel.
   */
  private updateRenderModesPanel(): void {
    const panel = this.panels.get(PanelType.RENDER_MODES);

    if (!(panel instanceof RenderModesPanel)) {
      return;
    }

    const entries: Array<{
      renderingEngineId: string;
      viewportId: string;
      viewportType: string;
      bindings: RenderModePanelBinding[];
    }> = [];

    for (const renderingEngine of renderingEngineCache.getAll()) {
      if (!renderingEngine || renderingEngine.hasBeenDestroyed) {
        continue;
      }

      for (const viewport of renderingEngine.getViewports()) {
        const debugViewport = viewport as unknown as DebugBindingsViewport;
        const renderModes = debugViewport._debug?.renderModes;

        entries.push({
          renderingEngineId: renderingEngine.id,
          viewportId: viewport.id,
          viewportType: viewport.type,
          bindings: this.getViewportBindingDebugEntries(
            debugViewport,
            (renderModes as Record<string, string> | undefined) ?? {}
          ),
        });
      }
    }

    panel.setContent(entries);
  }

  private getViewportBindingDebugEntries(
    viewport: DebugBindingsViewport,
    renderModes: Record<string, string>
  ): RenderModePanelBinding[] {
    const actors = viewport.getActors?.() ?? [];
    const sourceDataId = viewport.getSourceDataId?.();
    const renderModeEntries = Object.entries(renderModes);

    if (renderModeEntries.length) {
      return renderModeEntries.map(([dataId, renderMode]) => {
        const role = resolveBindingRole(viewport, dataId, sourceDataId);
        const actor =
          role === 'source'
            ? viewport.getDefaultActor?.()
            : findActorForDataId(actors, dataId);

        return {
          actorUID: actor?.uid,
          dataId,
          referencedId: actor?.referencedId,
          renderMode,
          role,
          ...getActorScalarInfo(actor),
        };
      });
    }

    // Legacy viewports do not expose a GenericViewport `_debug.renderModes`
    // map, so derive the rows directly from the actors. This lets the debug
    // overlay show the same actor UID / referencedId info for legacy viewports
    // (e.g. to compare whether a labelmap actor is reused or recreated across
    // slices) instead of an empty bindings panel.
    return actors.map((actor) => {
      const dataId = actor.representationUID ?? actor.uid ?? '';

      return {
        actorUID: actor.uid,
        dataId,
        referencedId: actor.referencedId,
        renderMode: '-',
        role: resolveBindingRole(viewport, dataId, sourceDataId),
        ...getActorScalarInfo(actor),
      };
    });
  }

  /**
   * Updates the memory panel if available.
   */
  private updateMemoryPanel(): void {
    const memPanel = this.panels.get(PanelType.MEMORY);
    if (!memPanel) {
      return;
    }

    const perf = performance as PerformanceWithMemory;
    if (perf.memory) {
      const memoryMB = perf.memory.usedJSHeapSize / CONVERSION.BYTES_TO_MB;
      const maxMemoryMB = perf.memory.jsHeapSizeLimit / CONVERSION.BYTES_TO_MB;
      memPanel.update(memoryMB, maxMemoryMB);
    }
  }

  private attachDragHandlers(): void {
    this.dom?.addEventListener('pointerdown', this.handlePointerDown);
  }

  private detachDragHandlers(): void {
    this.dom?.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.dom || event.button !== 0) {
      return;
    }
    // Don't start a drag from the close button.
    if (
      event.target instanceof Element &&
      event.target.closest('.cs3d-stats-overlay-close')
    ) {
      return;
    }

    this.dragPointerId = event.pointerId;
    const rect = this.dom.getBoundingClientRect();
    this.dragOffsetX = event.clientX - rect.left;
    this.dragOffsetY = event.clientY - rect.top;

    this.setPosition(rect.left, rect.top);

    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
    event.preventDefault();
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.dragPointerId !== event.pointerId || !this.dom) {
      return;
    }

    this.setPosition(
      event.clientX - this.dragOffsetX,
      event.clientY - this.dragOffsetY
    );
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.dragPointerId !== event.pointerId || !this.dom) {
      return;
    }

    this.dragPointerId = null;
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);

    const rect = this.dom.getBoundingClientRect();
    this.savePosition(rect.left, rect.top);
  }

  private setPosition(left: number, top: number): void {
    if (!this.dom) {
      return;
    }

    const clamped = this.clampToViewport(left, top);
    this.dom.style.left = `${clamped.left}px`;
    this.dom.style.top = `${clamped.top}px`;
    this.dom.style.right = 'auto';
    this.dom.style.bottom = 'auto';
  }

  private clampToViewport(
    left: number,
    top: number
  ): { left: number; top: number } {
    if (!this.dom) {
      return { left, top };
    }

    const width = this.dom.offsetWidth;
    const height = this.dom.offsetHeight;
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);

    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  private restorePosition(): void {
    const saved = this.readSavedPosition();
    if (!saved) {
      return;
    }

    this.setPosition(saved.left, saved.top);
  }

  private readSavedPosition(): { left: number; top: number } | null {
    try {
      const raw = window.localStorage.getItem(
        STATS_CONFIG.POSITION_STORAGE_KEY
      );
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as { left?: number; top?: number };
      if (
        typeof parsed?.left !== 'number' ||
        typeof parsed?.top !== 'number' ||
        !Number.isFinite(parsed.left) ||
        !Number.isFinite(parsed.top)
      ) {
        return null;
      }

      return { left: parsed.left, top: parsed.top };
    } catch {
      return null;
    }
  }

  private savePosition(left: number, top: number): void {
    try {
      window.localStorage.setItem(
        STATS_CONFIG.POSITION_STORAGE_KEY,
        JSON.stringify({ left, top })
      );
    } catch {
      // Storage may be unavailable (private mode, quota exceeded); ignore.
    }
  }
}

type DebugActorEntry = {
  referencedId?: string;
  representationUID?: string;
  uid?: string;
  actor?: DebugScalarActor;
};

/**
 * Minimal structural view of an actor that exposes the image data backing it,
 * covering both VTK actors (point-data scalars) and the canvas/CPU actors used
 * for the labelmap render paths (`getScalarData` + pixel-value range).
 */
type DebugScalarActor = {
  getMapper?: () =>
    | {
        getInputData?: () => DebugScalarInputData | null | undefined;
      }
    | null
    | undefined;
};

type DebugScalarInputData = {
  getPointData?: () =>
    | {
        getScalars?: () => DebugScalarArray | null | undefined;
      }
    | null
    | undefined;
  getScalarData?: () => ArrayLike<number> | null | undefined;
  minPixelValue?: number;
  maxPixelValue?: number;
};

type DebugScalarArray = {
  getDataType?: () => string;
  getNumberOfComponents?: () => number;
  getRange?: (componentIndex?: number) => number[];
};

type DebugBindingsViewport = {
  _debug?: {
    renderModes?: unknown;
  };
  getActors?: () => DebugActorEntry[];
  getDisplaySetRole?: (
    displaySetId: string
  ) => RenderModePanelBinding['role'] | undefined;
  getDefaultActor?: () => DebugActorEntry | undefined;
  getSourceDataId?: () => string | undefined;
};

function resolveBindingRole(
  viewport: DebugBindingsViewport,
  dataId: string,
  sourceDataId?: string
): RenderModePanelBinding['role'] {
  const role = viewport.getDisplaySetRole?.(dataId);

  if (role === 'source' || role === 'overlay') {
    return role;
  }

  if (sourceDataId && dataId === sourceDataId) {
    return 'source';
  }

  return 'data';
}

function findActorForDataId(
  actors: DebugActorEntry[],
  dataId: string
): DebugActorEntry | undefined {
  return actors.find(
    (actor) =>
      actor.uid === dataId ||
      actor.representationUID === dataId ||
      actor.referencedId === dataId
  );
}

/**
 * Reads the scalar buffer type (e.g. `Uint8Array`) and value range backing an
 * actor so the debug overlay can surface what data is actually loaded. Works
 * for both VTK actors (via point-data scalars) and the canvas/CPU labelmap
 * actors (via `getScalarData` + precomputed pixel-value range).
 *
 * VTK's `getRange()` is cached per component, so polling it from the overlay
 * loop is cheap after the first computation. This is best-effort and never
 * throws -- actors without scalar image data (surfaces, geometry) simply
 * return no scalar info.
 */
function getActorScalarInfo(entry: DebugActorEntry | undefined): {
  scalarType?: string;
  scalarRange?: [number, number];
  numberOfComponents?: number;
} {
  const inputData = entry?.actor?.getMapper?.()?.getInputData?.();
  if (!inputData) {
    return {};
  }

  try {
    const scalars = inputData.getPointData?.()?.getScalars?.();
    if (scalars?.getDataType) {
      const numberOfComponents = scalars.getNumberOfComponents?.() ?? 1;
      // For multi-component (e.g. RGB) read the first component to avoid the
      // magnitude allocation that `getRange(-1)` performs.
      const range =
        numberOfComponents > 1 ? scalars.getRange?.(0) : scalars.getRange?.();

      return {
        scalarType: scalars.getDataType(),
        scalarRange: normalizeRange(range),
        numberOfComponents,
      };
    }

    const scalarData = inputData.getScalarData?.();
    if (scalarData?.constructor?.name) {
      const range =
        Number.isFinite(inputData.minPixelValue) &&
        Number.isFinite(inputData.maxPixelValue)
          ? [inputData.minPixelValue, inputData.maxPixelValue]
          : undefined;

      return {
        scalarType: scalarData.constructor.name,
        scalarRange: normalizeRange(range),
      };
    }
  } catch {
    // The debug overlay must never throw; skip scalar info on failure.
  }

  return {};
}

function normalizeRange(
  range: number[] | undefined
): [number, number] | undefined {
  if (
    !range ||
    range.length < 2 ||
    !Number.isFinite(range[0]) ||
    !Number.isFinite(range[1])
  ) {
    return undefined;
  }

  return [range[0], range[1]];
}
