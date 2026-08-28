import { vec3 } from 'gl-matrix';
import type vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import { Events, ViewportType } from '../../../enums';
import triggerEvent from '../../../utilities/triggerEvent';
import type {
  ActorEntry,
  ICamera,
  IImageData,
  Point2,
  Point3,
  ViewReference,
  ViewReferenceSpecifier,
} from '../../../types';
import type ViewportInputOptions from '../../../types/ViewportInputOptions';
import renderingEngineCache from '../../renderingEngineCache';
import type {
  DataAddOptions,
  LoadedData,
  ViewportDataBinding,
} from '../ViewportArchitectureTypes';
import GenericViewport from '../GenericViewport';
import {
  getDimensionGroupReferenceContext,
  type GenericViewportReferenceContext,
} from '../genericViewportReferenceCompatibility';
import {
  getGenericViewportImageDisplaySet,
  isGenericViewportImageDisplaySet,
} from '../genericViewportDisplaySetAccess';
import { DefaultVolume3DDataProvider } from './DefaultVolume3DDataProvider';
import { createVolume3DRenderPathResolver } from './Volume3DRenderPathResolver';
import Volume3DResolvedView from './Volume3DResolvedView';
import applyVolume3DCamera from './applyVolume3DCamera';
import {
  getVolume3DProjectionSnapshot,
  type Volume3DProjectionSnapshot,
} from './volume3DProjectionAdapter';
import type {
  Volume3DCamera,
  Volume3DPayload,
  Volume3DDataPresentation,
  Volume3DMviewRendering,
  Volume3DRenderMode,
  Volume3DRegisteredDataSet,
  Volume3DRendering,
  Volume3DVolumePayload,
  Volume3DVolumeRendering,
  Volume3DSetDataOptions,
  Volume3DViewportRenderContext,
  VolumeViewport3DInput,
} from './viewport3DTypes';
import {
  attachWebGPUViewportCanvas,
  getWebGPUViewportWindow,
  setWebGPUViewportCanvasVisible,
} from '../Planar/webgpuViewportRenderWindow';
import { WEBGPU_VOLUME_3D_RENDER_MODE } from './WebGPUVolume3DRenderPath';
import { MVIEW_VOLUME_3D_RENDER_MODE } from './MviewVolume3DRenderPath';
import { SLICERLIVE_VOLUME_3D_RENDER_MODE } from './SlicerLiveVolume3DRenderPath';
import {
  isVtkWasmVolume3DRenderMode,
  VTK_WASM_VOLUME_3D_RENDER_MODE,
  VTK_WASM_WEBGPU_VOLUME_3D_RENDER_MODE,
} from './VtkWasmVolume3DRenderPath';
import {
  getVtkWasmVolume3D,
  setVtkWasmVolume3DCanvasVisible,
} from './vtkWasmVolume3DRegistry';
import {
  summaryFromBrickPlan,
  type VtkWasmBrickSummary,
} from '../vtkWasmBrickDisplay';
import type { WasmVtkVolumeBrickPlan } from '../../helpers/volumeTextureBrickWasm';
import type { VtkWasmVolumeBinding } from '../vtkWasmVolumeBinding';
import {
  iCameraToMviewCamera,
  parallelScaleToMviewOrthoZoom,
} from './mviewVolume3DCamera';
import {
  getMviewVolume3D,
  setMviewVolume3DCanvasVisible,
} from './mviewVolume3DRegistry';
import {
  getSlicerLiveVolume3D,
  setSlicerLiveVolume3DCanvasVisible,
} from './slicerLiveVolume3DRegistry';

class VolumeViewport3D extends GenericViewport<
  Volume3DCamera,
  Volume3DDataPresentation,
  Volume3DViewportRenderContext
> {
  readonly type = ViewportType.VOLUME_3D_NEXT;
  readonly renderingEngineId: string;
  readonly canvas: HTMLCanvasElement;
  readonly cpuCanvas: HTMLCanvasElement;
  private readonly defaultVtkRenderer: vtkRenderer;
  sWidth: number;
  sHeight: number;
  defaultOptions: ViewportInputOptions;
  suppressEvents = false;

  protected renderContext: Volume3DViewportRenderContext;

  private primaryDataId?: string;
  /**
   * Camera snapshot used as the zoom=1 baseline (`parallelScale` ratio),
   * matching legacy `Viewport.getZoom` / `setZoom` for OHIF overlays/tools.
   */
  private initialCamera?: Volume3DCamera & ICamera;
  /**
   * Canvas-pixel pan accumulated by {@link setPan} relative to the last
   * {@link captureInitialCamera} / fit. Avoids deriving pan from world→canvas
   * after rotations (which would jump under PanTool's get+delta pattern).
   */
  private panOffset: Point2 = [0, 0];

  static get useCustomRenderingPipeline(): boolean {
    // Enable-time routing still uses VTK offscreen for vtkVolume3d. Instance
    // method below opts webgpu/mview presents out of OpenGL engine frames.
    return false;
  }

  /**
   * Binding-owned presents (WebGPU / mview) must not run ContextPool OpenGL
   * offscreen work — that canvas is hidden and the volume actor lives on the
   * WebGPU/mview renderer.
   */
  getUseCustomRenderingPipeline(): boolean {
    return (
      this.isWebGPUVolumeRenderModeActive() ||
      this.isMviewVolumeRenderModeActive() ||
      this.isSlicerLiveVolumeRenderModeActive() ||
      this.isVtkWasmVolumeRenderModeActive()
    );
  }

  /**
   * Engine render loop entry for custom-pipeline Volume3D modes.
   * Delegates to binding present (WebGPU traverse / mview draw).
   */
  customRenderViewportToCanvas(): void {
    this.render();
  }

  setRendered(): void {
    super.setRendered();
  }

  constructor(args: VolumeViewport3DInput) {
    super(args);
    this.renderingEngineId = args.renderingEngineId;
    this.canvas = args.canvas;
    // The 3D viewport renders VTK directly to this on-screen canvas (it has no CPU
    // canvas like PlanarViewport). When the same element previously hosted a CPU
    // PlanarViewport, that viewport hid this shared canvas (display:none) in favor of
    // its cpuCanvas; ensure it is visible again so the volume rendering is shown.
    this.canvas.style.display = '';
    this.sWidth = args.sWidth;
    this.sHeight = args.sHeight;
    this.defaultOptions = args.defaultOptions || {};
    this.element.style.position = this.element.style.position || 'relative';
    this.element.style.overflow = 'hidden';
    this.element.style.background = this.element.style.background || '#000';
    this.element.style.isolation = 'isolate';
    const viewportElement = this.element.querySelector(
      '.viewport-element'
    ) as HTMLDivElement | null;
    const cpuCanvas = document.createElement('canvas');
    cpuCanvas.style.display = 'none';
    cpuCanvas.style.height = '100%';
    cpuCanvas.style.inset = '0';
    cpuCanvas.style.pointerEvents = 'none';
    cpuCanvas.style.position = 'absolute';
    cpuCanvas.style.width = '100%';
    cpuCanvas.style.zIndex = '0';
    this.element.appendChild(cpuCanvas);
    this.cpuCanvas = cpuCanvas;
    if (viewportElement) {
      viewportElement.style.position =
        viewportElement.style.position || 'relative';
      viewportElement.style.zIndex = '1';
    }
    const cpuCanvasContext = cpuCanvas.getContext('2d');

    if (!cpuCanvasContext) {
      throw new Error('[VolumeViewport3D] Failed to initialize CPU canvas');
    }
    this.dataProvider = args.dataProvider || new DefaultVolume3DDataProvider();
    this.renderPathResolver =
      args.renderPathResolver || createVolume3DRenderPathResolver();

    const renderingEngine = renderingEngineCache.get(this.renderingEngineId);
    const renderer = renderingEngine?.getRenderer(this.id);

    if (!renderer) {
      throw new Error(
        '[VolumeViewport3D] No renderer available. Ensure WebGL is supported and the rendering engine has been properly initialized.'
      );
    }

    renderer
      .getActiveCamera()
      .setParallelProjection(this.defaultOptions.parallelProjection ?? true);
    this.defaultVtkRenderer = renderer;

    this.renderContext = {
      viewportId: this.id,
      renderingEngineId: this.renderingEngineId,
      type: '3d',
      viewport: {
        element: this.element,
        options: {
          orientation: this.defaultOptions.orientation,
          parallelProjection: this.defaultOptions.parallelProjection,
        },
      },
      display: {
        activateRenderMode: (renderMode: Volume3DRenderMode) => {
          this.setRenderModeVisibility(renderMode);
        },
        renderNow: () => {
          this.render();
        },
        requestRender: () => {
          this.requestRenderingEngineRender();
        },
      },
      cpu: {
        canvas: cpuCanvas,
        context: cpuCanvasContext,
      },
      vtk: {
        canvas: this.canvas,
        renderer,
      },
    };
    this.viewState = {
      parallelProjection: this.defaultOptions.parallelProjection ?? true,
    } as Volume3DCamera;

    this.element.setAttribute('data-viewport-uid', this.id);
    this.element.setAttribute(
      'data-rendering-engine-uid',
      this.renderingEngineId
    );
    this.setRenderModeVisibility('mviewVolume3d');
  }

  /**
   * Replaces all mounted 3D display sets with the provided ones. The first
   * entry is mounted as the source binding; subsequent entries default to the
   * overlay role unless they specify one explicitly.
   *
   * @param entries - Display sets to mount, each with its own render-mode options.
   */
  async setDisplaySets(
    ...entries: Array<{
      displaySetId: string;
      options?: Volume3DSetDataOptions;
    }>
  ): Promise<void> {
    this.removeAllData();

    for (const [index, { displaySetId, options = {} }] of entries.entries()) {
      await this.addDisplaySet(displaySetId, {
        ...options,
        role: options.role ?? (index === 0 ? 'source' : 'overlay'),
      });
    }
  }

  /**
   * Adds a single 3D display set and selects the effective 3D render mode.
   *
   * @param displaySetId - Logical display set id to add.
   * @param options - Requested 3D render-mode options.
   */
  async addDisplaySet(
    displaySetId: string,
    options: Volume3DSetDataOptions | DataAddOptions = {}
  ): Promise<void> {
    const volumeOptions = options as Volume3DSetDataOptions;
    const renderMode = this.resolveRenderMode(
      displaySetId,
      volumeOptions.renderMode
    );
    await super.addDisplaySet(displaySetId, {
      renderMode,
      role: volumeOptions.role,
    });

    if (
      isVolume3DVolumeRenderMode(renderMode) &&
      volumeOptions.role === 'source'
    ) {
      this.primaryDataId = displaySetId;
    }

    this.setDefaultDataPresentation(displaySetId, {
      visible: true,
      opacity: 1,
    });
    this.alignSpecializedVolumeFitCamera();
    this.viewState = this.getViewState();
    this.captureInitialCamera();
  }

  /**
   * Returns the rendering engine that owns this viewport.
   *
   * @returns The parent rendering engine, if it is still registered.
   */
  getRenderingEngine() {
    return renderingEngineCache.get(this.renderingEngineId);
  }

  /**
   * Returns image ids for the primary volume dataset when present.
   *
   * @returns The image ids for the primary volume dataset, if available.
   */
  getImageIds(): string[] {
    const binding = this.getCurrentBinding();

    if (!binding) {
      return [];
    }

    const data = this.getVolume3DPayload(binding);
    const rendering = this.getVolume3DRendering(binding);

    if (
      !data ||
      !isVolume3DVolumePayload(data) ||
      !(
        isVolume3DVolumeRendering(rendering) ||
        isVolume3DMviewRendering(rendering)
      )
    ) {
      return [];
    }

    return data.imageIds;
  }

  /**
   * Returns the underlying VTK renderer for direct integration points.
   *
   * @returns The VTK renderer used by this viewport.
   */
  getRenderer() {
    return this.renderContext.vtk.renderer;
  }

  /**
   * Returns the viewport canvas element. In WebGPU volume mode the visible
   * surface is the attached WebGPU canvas; otherwise the VTK OpenGL canvas.
   */
  getCanvas(): HTMLCanvasElement {
    if (this.isMviewVolumeRenderModeActive()) {
      const entry = getMviewVolume3D(this.id);
      if (entry) {
        return entry.canvas;
      }
    }

    if (this.isSlicerLiveVolumeRenderModeActive()) {
      const entry = getSlicerLiveVolume3D(this.id);
      if (entry) {
        return entry.canvas;
      }
    }

    if (this.isWebGPUVolumeRenderModeActive()) {
      const window = getWebGPUViewportWindow(this.id);
      if (window) {
        return window.view.getCanvas();
      }
    }

    if (this.isVtkWasmVolumeRenderModeActive()) {
      const entry = getVtkWasmVolume3D(this.id);
      if (entry) {
        return entry.canvas;
      }
    }

    return this.canvas;
  }

  /**
   * Active Volume3D render mode (`vtkVolume3d` | `webgpuVolume3d` |
   * `mviewVolume3d` | `vtkGeometry3d`). Used by OHIF corner menus / tools.
   * Prefers the mounted binding's render mode so the value is correct as soon
   * as data is attached (not the constructor default `mviewVolume3d`).
   */
  getActiveRenderMode(): Volume3DRenderMode {
    const binding = this.getCurrentBinding();
    const mountedMode = binding?.rendering?.renderMode;

    if (
      mountedMode === 'vtkVolume3d' ||
      mountedMode === WEBGPU_VOLUME_3D_RENDER_MODE ||
      mountedMode === MVIEW_VOLUME_3D_RENDER_MODE ||
      mountedMode === SLICERLIVE_VOLUME_3D_RENDER_MODE ||
      isVtkWasmVolume3DRenderMode(mountedMode) ||
      mountedMode === 'vtkGeometry3d'
    ) {
      return mountedMode;
    }

    return this.activeRenderMode;
  }

  /**
   * Applied vtk-wasm XYZ brick grid when the wasm Volume3D path is active.
   */
  getVtkWasmBrickSummary(): VtkWasmBrickSummary | undefined {
    if (!isVtkWasmVolume3DRenderMode(this.getActiveRenderMode())) {
      return undefined;
    }

    const rendering = this.getCurrentBinding()?.rendering as
      | {
          brickPlan?: WasmVtkVolumeBrickPlan;
          binding?: VtkWasmVolumeBinding;
        }
      | undefined;

    const brickPlan =
      rendering?.brickPlan ?? getVtkWasmVolume3D(this.id)?.brickPlan;

    if (!brickPlan) {
      return undefined;
    }

    return summaryFromBrickPlan(brickPlan, rendering?.binding?.mode);
  }

  /**
   * Returns the active VTK camera instance.
   *
   * @returns The active VTK camera object.
   */
  getVtkActiveCamera() {
    return this.getRenderer().getActiveCamera();
  }

  /**
   * Returns the current 3D camera state in the compatibility camera shape.
   *
   * @returns The current 3D camera state.
   */
  getViewState(): Volume3DCamera & ICamera {
    return this.getRuntimeCamera();
  }

  setViewState(viewStatePatch: Partial<Volume3DCamera>): void {
    if (this.isDestroyed) {
      return;
    }

    const previousCamera = this.getCameraForEvent();

    applyVolume3DCamera(this.renderContext, viewStatePatch, {
      resetClippingRange: true,
    });
    this.viewState = this.getRuntimeCamera();
    this.syncMviewCameraFromViewState();
    this.syncSlicerLiveCameraFromViewState();
    this.modified(previousCamera);
  }

  /**
   * Zoom relative to the fit parallel scale (1 = fit / baseline camera).
   * Matches legacy `Viewport.getZoom` for OHIF overlay and tool consumers.
   */
  getZoom(compareCamera = this.initialCamera): number {
    const baseline = this.getFitParallelScale() ?? compareCamera?.parallelScale;

    if (!baseline) {
      return 1;
    }

    const parallelScale = this.getVtkActiveCamera().getParallelScale();

    if (!parallelScale) {
      return 1;
    }

    return baseline / parallelScale;
  }

  /**
   * Sets zoom via parallel scale relative to the fit baseline.
   * Matches Planar / ZoomTool: optional `canvasPoint` is accepted for API
   * compatibility but ignored (no zoom-about-point yet). A Point2 must never
   * be treated as `storeAsInitialCamera`.
   */
  setZoom(value: number, canvasPointOrStore?: Point2 | boolean): void {
    if (!Number.isFinite(value) || value === 0) {
      return;
    }

    if (!this.getFitParallelScale()) {
      this.alignSpecializedVolumeFitCamera();
      if (!this.initialCamera?.parallelScale) {
        this.captureInitialCamera();
      }
    }

    const initialParallelScale = this.getFitParallelScale();

    if (!initialParallelScale) {
      return;
    }

    const nextParallelScale = initialParallelScale / value;
    this.setViewState({ parallelScale: nextParallelScale });
    this.applySpecializedVolumeFraming({
      parallelScale: nextParallelScale,
    });

    if (canvasPointOrStore === true) {
      this.captureInitialCamera();
    }
  }

  /**
   * Canvas-pixel pan relative to the last fit / {@link captureInitialCamera}.
   * Required so PanTool works on native `volume3dNext` (no getCamera).
   */
  getPan(): Point2 {
    return [this.panOffset[0], this.panOffset[1]];
  }

  /**
   * Sets absolute canvas-pixel pan.
   * For mview: screen-space pan only (do not move VTK focal/position —
   * that made TrackballRotate orbit a different center and jump on click).
   * For vtk/webgpu volume: translate focalPoint + position in the view plane.
   */
  setPan(nextPan: Point2): void {
    if (
      !Array.isArray(nextPan) ||
      !Number.isFinite(nextPan[0]) ||
      !Number.isFinite(nextPan[1])
    ) {
      return;
    }

    const deltaCanvas: Point2 = [
      nextPan[0] - this.panOffset[0],
      nextPan[1] - this.panOffset[1],
    ];

    if (Math.abs(deltaCanvas[0]) < 1e-6 && Math.abs(deltaCanvas[1]) < 1e-6) {
      this.panOffset = [nextPan[0], nextPan[1]];
      return;
    }

    this.panOffset = [nextPan[0], nextPan[1]];

    const canvasHeight =
      this.element.clientHeight || this.canvas?.clientHeight || 1;

    const specialized = getMviewVolume3D(this.id);

    if (specialized) {
      this.applySpecializedVolumeFraming({
        panCanvasAbsolute: this.panOffset,
        canvasHeight,
      });
      this.render();
      return;
    }

    const viewState = this.getViewState();
    const { focalPoint, position, viewPlaneNormal, viewUp, parallelScale } =
      viewState;

    if (
      !focalPoint ||
      !position ||
      !viewPlaneNormal ||
      !viewUp ||
      typeof parallelScale !== 'number' ||
      !Number.isFinite(parallelScale) ||
      parallelScale <= 0
    ) {
      return;
    }

    const worldPerPixel = (2 * parallelScale) / Math.max(canvasHeight, 1);

    const vpn = vec3.fromValues(
      viewPlaneNormal[0],
      viewPlaneNormal[1],
      viewPlaneNormal[2]
    );
    const up = vec3.fromValues(viewUp[0], viewUp[1], viewUp[2]);
    vec3.normalize(vpn, vpn);
    vec3.normalize(up, up);
    const right = vec3.create();
    vec3.cross(right, up, vpn);
    vec3.normalize(right, right);

    // Match PanTool: camera moves opposite to canvas drag (content follows pointer).
    const worldDelta = vec3.create();
    vec3.scaleAndAdd(
      worldDelta,
      worldDelta,
      right,
      deltaCanvas[0] * worldPerPixel
    );
    vec3.scaleAndAdd(
      worldDelta,
      worldDelta,
      up,
      -deltaCanvas[1] * worldPerPixel
    );

    this.setViewState({
      focalPoint: [
        focalPoint[0] - worldDelta[0],
        focalPoint[1] - worldDelta[1],
        focalPoint[2] - worldDelta[2],
      ],
      position: [
        position[0] - worldDelta[0],
        position[1] - worldDelta[1],
        position[2] - worldDelta[2],
      ],
    });
  }

  /**
   * Fit-time parallelScale for zoom=1: specialized present baseline, else
   * {@link initialCamera}.
   */
  private getFitParallelScale(): number | undefined {
    const specialized =
      getMviewVolume3D(this.id)?.baselineParallelScale ??
      getSlicerLiveVolume3D(this.id)?.baselineParallelScale;

    if (
      typeof specialized === 'number' &&
      Number.isFinite(specialized) &&
      specialized > 0
    ) {
      return specialized;
    }

    const initial = this.initialCamera?.parallelScale;
    if (
      typeof initial === 'number' &&
      Number.isFinite(initial) &&
      initial > 0
    ) {
      return initial;
    }

    return undefined;
  }

  /**
   * After mview/slicerLive mount, VTK may still hold an empty-scene parallelScale
   * (~1). Force the mount-time fit baseline onto the VTK camera so getZoom/setZoom
   * and framing sync share one scale.
   */
  private alignSpecializedVolumeFitCamera(): void {
    const specialized =
      getMviewVolume3D(this.id) || getSlicerLiveVolume3D(this.id);
    const baseline = specialized?.baselineParallelScale;
    if (
      typeof baseline !== 'number' ||
      !Number.isFinite(baseline) ||
      baseline <= 0
    ) {
      return;
    }

    this.getVtkActiveCamera().setParallelScale(baseline);
  }

  /**
   * Write zoom/pan straight into the specialized VolumeRenderer when active.
   * setViewState sync can miss framing if VTK scale is stale; this keeps the
   * present matched to tool updates.
   */
  private applySpecializedVolumeFraming(options: {
    parallelScale?: number;
    panCanvasAbsolute?: Point2;
    canvasHeight?: number;
  }): void {
    const entry = getMviewVolume3D(this.id);
    if (!entry) {
      return;
    }

    const projection = entry.renderer.getCamera()?.projection;
    if (projection && projection !== 'orthographic') {
      return;
    }

    const patch: { zoom?: number; panX?: number; panY?: number } = {};
    const physicalMax = entry.volumePhysicalMax;
    const parallelScale =
      options.parallelScale ?? this.getVtkActiveCamera().getParallelScale();

    if (
      typeof parallelScale === 'number' &&
      Number.isFinite(parallelScale) &&
      parallelScale > 0 &&
      typeof physicalMax === 'number' &&
      Number.isFinite(physicalMax) &&
      physicalMax > 0
    ) {
      patch.zoom = parallelScaleToMviewOrthoZoom(
        parallelScale,
        physicalMax,
        entry.baselineParallelScale
      );
    }

    if (options.panCanvasAbsolute) {
      const height = Math.max(options.canvasHeight ?? 1, 1);
      // NDC-like units: full canvas height ⇒ pan range of 2 (mview shader).
      patch.panX = (options.panCanvasAbsolute[0] * 2) / height;
      patch.panY = (options.panCanvasAbsolute[1] * 2) / height;
    }

    if (Object.keys(patch).length) {
      entry.renderer.setCamera(patch);
    }
  }

  private captureInitialCamera(): void {
    this.initialCamera = { ...this.getViewState() };
    this.panOffset = [0, 0];
  }

  protected getRuntimeCamera(): Volume3DCamera & ICamera {
    const camera = this.getRenderer().getActiveCamera();

    return {
      clippingRange: camera.getClippingRange(),
      focalPoint: camera.getFocalPoint(),
      parallelProjection: camera.getParallelProjection(),
      parallelScale: camera.getParallelScale(),
      position: camera.getPosition(),
      rotation: 0,
      viewAngle: camera.getViewAngle(),
      viewPlaneNormal: camera.getViewPlaneNormal(),
      viewUp: camera.getViewUp(),
    } as Volume3DCamera & ICamera;
  }

  getResolvedView(): Volume3DResolvedView {
    return new Volume3DResolvedView({
      camera: this.getViewState(),
      canvas: this.renderContext.vtk.canvas,
      frameOfReferenceUID: this.resolveFrameOfReferenceUID(),
      renderer: this.getRenderer(),
    });
  }

  getViewReference(
    _viewRefSpecifier: ViewReferenceSpecifier = {}
  ): ViewReference {
    const binding = this.getCurrentBinding();
    const data = binding ? this.getVolume3DPayload(binding) : undefined;
    const camera = this.getViewState();
    const FrameOfReferenceUID = this.getFrameOfReferenceUID();
    const cameraFocalPoint = camera.focalPoint as Point3 | undefined;
    const viewPlaneNormal = camera.viewPlaneNormal as Point3 | undefined;
    const viewUp = camera.viewUp as Point3 | undefined;
    const viewReference: ViewReference = {
      FrameOfReferenceUID,
      dataId: binding?.data.id,
      cameraFocalPoint,
      viewPlaneNormal,
      viewUp,
    };

    if (data && isVolume3DVolumePayload(data)) {
      viewReference.volumeId = data.volumeId;
      Object.assign(
        viewReference,
        getDimensionGroupReferenceContext(data.imageVolume)
      );
    }

    if (cameraFocalPoint && viewPlaneNormal && viewUp) {
      viewReference.planeRestriction = {
        FrameOfReferenceUID,
        point: cameraFocalPoint,
        inPlaneVector1: viewUp,
        inPlaneVector2: vec3.cross(
          vec3.create(),
          viewUp as unknown as vec3,
          viewPlaneNormal as unknown as vec3
        ) as Point3,
      };
    }

    return viewReference;
  }

  /**
   * Returns the primary volume id when the active rendering is volume-backed.
   *
   * @returns The primary volume id, if one is active.
   */
  getVolumeId(): string | undefined {
    const binding = this.getCurrentBinding();

    if (!binding) {
      return;
    }

    const data = this.getVolume3DPayload(binding);
    const rendering = this.getVolume3DRendering(binding);

    if (
      !data ||
      !isVolume3DVolumePayload(data) ||
      !(
        isVolume3DVolumeRendering(rendering) ||
        isVolume3DMviewRendering(rendering)
      )
    ) {
      return;
    }

    return data.volumeId;
  }

  /**
   * Returns whether the viewport currently contains the given volume id.
   *
   * @param volumeId - Volume id to look up in the current actors.
   * @returns `true` when a matching volume actor is present.
   */
  hasVolumeId(volumeId: string): boolean {
    return this.getActors().some(
      (actorEntry) => actorEntry.referencedId === volumeId
    );
  }

  /**
   * Returns whether any actor reference id contains the given volume URI.
   *
   * @param volumeURI - Volume URI substring to test against actor references.
   * @returns `true` when a matching actor reference is present.
   */
  hasVolumeURI(volumeURI: string): boolean {
    return this.getActors().some((actorEntry) =>
      String(actorEntry.referencedId || '').includes(volumeURI)
    );
  }

  /**
   * Returns image data from the current binding when exposed by the render
   * path.
   *
   * @returns The current image-data object, if exposed by the render path.
   */
  getImageData(): IImageData | undefined {
    return this.getCurrentBinding()?.getImageData?.() as IImageData | undefined;
  }

  /**
   * Returns all actor entries contributed by the active 3D bindings.
   *
   * @returns Actor entries for all active 3D bindings.
   */
  getActors(): ActorEntry[] {
    const actors: ActorEntry[] = [];

    for (const binding of this.bindings.values()) {
      const data = this.getVolume3DPayload(binding);

      if (!data) {
        continue;
      }

      actors.push(
        ...this.getActorEntriesForRendering(
          this.getVolume3DRendering(binding),
          data
        )
      );
    }

    return actors;
  }

  /**
   * Returns the default actor for tool integration and legacy compatibility.
   *
   * @returns The primary actor entry, if one is available.
   */
  getDefaultActor(): ActorEntry | undefined {
    const binding = this.getCurrentBinding();

    if (!binding) {
      return this.getActors()[0];
    }

    const data = this.getVolume3DPayload(binding);

    if (!data) {
      return undefined;
    }

    return this.getActorEntriesForRendering(
      this.getVolume3DRendering(binding),
      data
    )[0];
  }

  /**
   * Resets the VTK-backed view state and clipping range.
   *
   * Mirrors the legacy `VolumeViewport3D.resetCamera` semantics for the
   * options that 3D-camera tooling relies on:
   * - `resetZoom: false` keeps the current parallel scale (zoom) instead of
   *   refitting to bounds. (OrientationControllerTool animates orientation with
   *   `resetZoom: false`; VolumeCroppingControlTool also forwards options.)
   * - `resetPan: false` / `resetToCenter: false` keep the current focal point
   *   and position rather than recentering on the bounds.
   *
   * `vtkRenderer.resetCamera()` preserves the current view direction
   * (viewPlaneNormal) and viewUp - it only repositions the camera along the
   * existing direction of projection and recomputes the parallel scale - so an
   * orientation applied via `setViewState` immediately before this call is not
   * clobbered.
   *
   * @param options - Reset options matching the legacy `resetCamera` contract.
   * @returns Always `true` for compatibility with legacy viewport contracts.
   */
  resetViewState(options?: {
    resetPan?: boolean;
    resetZoom?: boolean;
    resetToCenter?: boolean;
  }): boolean {
    const {
      resetPan = true,
      resetZoom = true,
      resetToCenter = true,
    } = options || {};

    const previousCamera = this.getCameraForEvent();
    const renderer = this.getRenderer();
    const camera = renderer.getActiveCamera();

    const previousParallelScale = camera.getParallelScale();
    const previousPosition = camera.getPosition();
    const previousFocalPoint = camera.getFocalPoint();

    renderer.resetCamera();
    renderer.resetCameraClippingRange();

    // resetCamera() always recomputes the parallel scale (zoom) to fit the
    // bounds; restore the previous zoom when the caller opts out.
    if (!resetZoom) {
      camera.setParallelScale(previousParallelScale);
    } else {
      // mview/slicerLive have no VTK volume actor — resetCamera fits empty
      // bounds (~parallelScale 1) and would sync as ~10× over-zoom. Restore
      // the fit baseline captured at mount instead.
      const specializedBaseline =
        getMviewVolume3D(this.id)?.baselineParallelScale ??
        getSlicerLiveVolume3D(this.id)?.baselineParallelScale ??
        getVtkWasmVolume3D(this.id)?.baselineParallelScale;
      if (
        typeof specializedBaseline === 'number' &&
        Number.isFinite(specializedBaseline) &&
        specializedBaseline > 0
      ) {
        camera.setParallelScale(specializedBaseline);
      }
    }

    // resetCamera() recenters the focal point on the bounds; restore the
    // previous pan/center when the caller opts out of recentering.
    if (!resetPan || !resetToCenter) {
      camera.setFocalPoint(...previousFocalPoint);
      camera.setPosition(...previousPosition);
      renderer.resetCameraClippingRange();
    }

    this.viewState = this.getViewState();
    if (resetZoom) {
      this.captureInitialCamera();
    } else if (resetPan && resetToCenter) {
      this.panOffset = [0, 0];
    }
    this.syncMviewCameraFromViewState();
    this.syncSlicerLiveCameraFromViewState();
    this.render();
    this.triggerCameraModifiedEvent(previousCamera);
    this.triggerCameraResetEvent();

    return true;
  }

  /**
   * Resets the 3D view state after resize using the same behavior as
   * `resetViewState`.
   *
   * @returns Always `true` for compatibility with legacy viewport contracts.
   */
  resetViewStateForResize(): boolean {
    return this.resetViewState();
  }

  /**
   * Updates cached size state and notifies active render bindings.
   *
   * Specialized presents (mview / …) own their canvas bitmap (pixel
   * budget). VTK/OpenGL uses the element CSS size × DPR — do not read
   * `this.canvas.width` after a custom-pipeline session, or sWidth stays stuck
   * on the last adaptive present size / a display:none bitmap.
   */
  resize(): void {
    if (this.isDestroyed) {
      return;
    }

    this.syncPresentSize();

    if (this.getUseCustomRenderingPipeline()) {
      const activeCanvas = this.getCanvas();
      this.sWidth = Math.max(1, activeCanvas.width);
      this.sHeight = Math.max(1, activeCanvas.height);
    } else {
      this.syncVtkPresentSizeFromElement();
    }

    this.resizeBindings();
  }

  /**
   * Renders active 3D bindings or queues an engine-driven render.
   * Binding-owned presents (WebGPU / mview) skip the engine frame loop, so
   * fire IMAGE_RENDERED here for OHIF overlays and other consumers.
   */
  render(): void {
    if (this.isDestroyed) {
      return;
    }

    if (this.renderBindings()) {
      this.setRendered();
      this.triggerImageRenderedEvent();
      return;
    }

    this.requestRenderingEngineRender();
  }

  /**
   * Notify listeners that a Volume3D present (or mode switch) completed.
   * Custom binding renders do not go through ContextPoolRenderingEngine's
   * IMAGE_RENDERED emission.
   */
  private triggerImageRenderedEvent(): void {
    if (this.suppressEvents || this.isDestroyed) {
      return;
    }

    triggerEvent(this.element, Events.IMAGE_RENDERED, {
      element: this.element,
      viewportId: this.id,
      renderingEngineId: this.renderingEngineId,
      viewportStatus: this.viewportStatus,
    });
  }

  protected override onDestroy(): void {
    this.primaryDataId = undefined;
    this.cpuCanvas.remove();
  }

  /**
   * Resolves the current VTK-backed 3D camera through the projection adapter
   * without making the adapter responsible for mutating the viewport.
   */
  private getProjectionSnapshot(): Volume3DProjectionSnapshot {
    const snapshot = getVolume3DProjectionSnapshot({
      viewport: this,
      canvasHeight: this.canvas.clientHeight || this.element.clientHeight,
      canvasWidth: this.canvas.clientWidth || this.element.clientWidth,
      camera: this.getViewState(),
      frameOfReferenceUID: this.resolveFrameOfReferenceUID(),
      resolvedView: this.getResolvedView(),
    });

    if (!snapshot) {
      throw new Error(
        '[VolumeViewport3D] Unable to resolve projection snapshot'
      );
    }

    return snapshot;
  }

  protected getCurrentBinding() {
    if (this.primaryDataId) {
      return this.getBinding(this.primaryDataId) ?? this.getFirstBinding();
    }

    return this.getFirstBinding();
  }

  protected getReferenceViewContexts(): GenericViewportReferenceContext[] {
    const contexts: GenericViewportReferenceContext[] = [];
    const camera = this.getViewState();

    for (const [dataId, binding] of this.bindings.entries()) {
      const data = this.getVolume3DPayload(binding);
      const volumeId =
        data && isVolume3DVolumePayload(data) ? data.volumeId : undefined;

      contexts.push({
        dataId,
        dataIds: [binding.data.id],
        frameOfReferenceUID:
          binding.getFrameOfReferenceUID() ?? this.getFrameOfReferenceUID(),
        imageIds:
          data && isVolume3DVolumePayload(data) ? data.imageIds : undefined,
        volumeId,
        volumeIds: volumeId ? [volumeId] : undefined,
        cameraFocalPoint: camera.focalPoint as Point3 | undefined,
        viewPlaneNormal: camera.viewPlaneNormal as Point3 | undefined,
        ...(data && isVolume3DVolumePayload(data)
          ? getDimensionGroupReferenceContext(data.imageVolume)
          : {}),
      });
    }

    return contexts.length ? contexts : super.getReferenceViewContexts();
  }

  private requestRenderingEngineRender(): void {
    const renderingEngine = renderingEngineCache.get(this.renderingEngineId);

    if (renderingEngine) {
      renderingEngine.renderViewport(this.id);
    }
  }

  private resolveRenderMode(
    dataId: string,
    requestedRenderMode: Volume3DSetDataOptions['renderMode'] = 'auto'
  ): Volume3DRenderMode {
    if (requestedRenderMode && requestedRenderMode !== 'auto') {
      return requestedRenderMode;
    }

    const dataSet = this.getDataSet(dataId);

    if (dataSet?.imageIds?.length) {
      return 'vtkVolume3d';
    }

    return 'vtkGeometry3d';
  }

  private getDataSet(dataId: string): Volume3DRegisteredDataSet | undefined {
    const dataSet = getGenericViewportImageDisplaySet(dataId);

    if (!isVolume3DRegisteredDataSet(dataSet)) {
      return;
    }

    return dataSet;
  }

  private getVolume3DPayload(
    binding: ViewportDataBinding<Volume3DDataPresentation>
  ): LoadedData<Volume3DPayload> | undefined {
    if (!isVolume3DData(binding.data)) {
      return;
    }

    return binding.data;
  }

  private resolveFrameOfReferenceUID(): string | undefined {
    const binding = this.getCurrentBinding();

    if (!binding) {
      return;
    }

    const data = this.getVolume3DPayload(binding);
    const rendering = this.getVolume3DRendering(binding);

    if (!data) {
      return;
    }

    if (isVolume3DVolumePayload(data)) {
      return data.imageVolume.metadata?.FrameOfReferenceUID;
    }

    if (rendering.renderMode === 'vtkGeometry3d') {
      return rendering.frameOfReferenceUID;
    }
  }

  private getVolume3DRendering(
    binding: ViewportDataBinding<Volume3DDataPresentation>
  ): Volume3DRendering {
    if (!isVolume3DRendering(binding.rendering)) {
      throw new Error(
        '[VolumeViewport3D] Binding render mode is not a supported 3D rendering'
      );
    }

    return binding.rendering;
  }

  private getActorEntriesForRendering(
    rendering: Volume3DRendering,
    data: LoadedData<Volume3DPayload>
  ): ActorEntry[] {
    if (isVolume3DVolumeRendering(rendering) && isVolume3DVolumePayload(data)) {
      return [
        {
          actor: rendering.actor,
          referencedId: data.volumeId,
          uid: rendering.actorEntryUID,
        },
      ];
    }

    if (rendering.renderMode === 'vtkGeometry3d') {
      return rendering.actors;
    }

    return [];
  }

  private activeRenderMode: Volume3DRenderMode = 'mviewVolume3d';

  private setRenderModeVisibility(renderMode: Volume3DRenderMode): void {
    const modeChanged = this.activeRenderMode !== renderMode;
    this.activeRenderMode = renderMode;
    const useWebGPU = renderMode === WEBGPU_VOLUME_3D_RENDER_MODE;
    const useMview = renderMode === MVIEW_VOLUME_3D_RENDER_MODE;
    const useSlicerLive = renderMode === SLICERLIVE_VOLUME_3D_RENDER_MODE;
    const useVtkWasm = isVtkWasmVolume3DRenderMode(renderMode);
    // cpuCanvas is unused for direct WebGPU present; keep it hidden.
    this.cpuCanvas.style.display = 'none';
    this.cpuCanvas.style.pointerEvents = 'none';
    this.canvas.style.display =
      useWebGPU || useMview || useSlicerLive || useVtkWasm ? 'none' : '';

    setMviewVolume3DCanvasVisible(this.id, useMview);
    setSlicerLiveVolume3DCanvasVisible(this.id, useSlicerLive);
    setVtkWasmVolume3DCanvasVisible(this.id, useVtkWasm);

    const webgpuWindow = getWebGPUViewportWindow(this.id);

    if (useWebGPU) {
      this.syncPresentSize();
      if (webgpuWindow) {
        const gpuCanvas = attachWebGPUViewportCanvas(
          webgpuWindow,
          this.element
        );
        this.renderContext.vtk.canvas = gpuCanvas;
        this.renderContext.vtk.renderer = webgpuWindow.renderer;
      }
      if (modeChanged) {
        this.triggerImageRenderedEvent();
      }
      return;
    }

    if (webgpuWindow) {
      setWebGPUViewportCanvasVisible(webgpuWindow, false);
    }

    if (useMview || useSlicerLive || useVtkWasm) {
      this.syncPresentSize();
      const entry = useVtkWasm
        ? getVtkWasmVolume3D(this.id)
        : useSlicerLive
          ? getSlicerLiveVolume3D(this.id)
          : getMviewVolume3D(this.id);
      if (entry) {
        this.renderContext.vtk.canvas = entry.canvas;
      }
      // Keep the default VTK renderer as the camera authority for tools.
      this.renderContext.vtk.renderer = this.defaultVtkRenderer;
      if (modeChanged) {
        this.triggerImageRenderedEvent();
      }
      return;
    }

    this.renderContext.vtk.renderer = this.defaultVtkRenderer;
    this.renderContext.vtk.canvas = this.canvas;
    // Leaving mview/webgpu: canvas was display:none and sWidth may still be the
    // adaptive present size. Refresh from the element so the first OpenGL frame
    // is not skipped (clientWidth===0) or drawn at a stale budget size.
    if (modeChanged) {
      this.syncVtkPresentSizeFromElement();
      this.triggerImageRenderedEvent();
    }
  }

  /**
   * Match VTK on-screen canvas + sWidth/sHeight to the viewport element
   * (CSS size × devicePixelRatio).
   */
  private syncVtkPresentSizeFromElement(): void {
    const devicePixelRatio = window.devicePixelRatio || 1;
    const targetWidth = Math.max(
      1,
      Math.round(Math.max(this.element.clientWidth, 1) * devicePixelRatio)
    );
    const targetHeight = Math.max(
      1,
      Math.round(Math.max(this.element.clientHeight, 1) * devicePixelRatio)
    );

    this.sWidth = targetWidth;
    this.sHeight = targetHeight;

    if (
      this.canvas.width !== targetWidth ||
      this.canvas.height !== targetHeight
    ) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }
  }

  private isWebGPUVolumeRenderModeActive(): boolean {
    return this.activeRenderMode === WEBGPU_VOLUME_3D_RENDER_MODE;
  }

  private isMviewVolumeRenderModeActive(): boolean {
    return this.activeRenderMode === MVIEW_VOLUME_3D_RENDER_MODE;
  }

  private isSlicerLiveVolumeRenderModeActive(): boolean {
    return this.activeRenderMode === SLICERLIVE_VOLUME_3D_RENDER_MODE;
  }

  private isVtkWasmVolumeRenderModeActive(): boolean {
    return isVtkWasmVolume3DRenderMode(this.activeRenderMode);
  }

  private syncSlicerLiveCameraFromViewState(): void {
    if (!this.isSlicerLiveVolumeRenderModeActive()) {
      return;
    }

    const entry = getSlicerLiveVolume3D(this.id);
    if (!entry) {
      return;
    }

    const viewState = this.getViewState();
    const position = viewState.position as [number, number, number] | undefined;
    const focalPoint = viewState.focalPoint as
      | [number, number, number]
      | undefined;
    const viewUp = viewState.viewUp as [number, number, number] | undefined;

    if (!position || !focalPoint || !viewUp) {
      return;
    }

    // Pose/framing from CS/VTK only — projection mode is owned by the SlicerLive
    // renderer (menu / setSlicerLiveVolume3DProjection), not VTK's parallel flag.
    entry.renderer.setCamera({
      position,
      focalPoint,
      viewUp,
      parallelScale: viewState.parallelScale,
      viewAngle: viewState.viewAngle,
    });
  }

  private syncMviewCameraFromViewState(): void {
    if (!this.isMviewVolumeRenderModeActive()) {
      return;
    }

    const entry = getMviewVolume3D(this.id);

    if (!entry) {
      return;
    }

    const binding = this.getCurrentBinding();

    if (!binding) {
      return;
    }

    let direction: ArrayLike<number> | number[] | undefined;

    try {
      const rendering = this.getVolume3DRendering(binding);

      if (isVolume3DMviewRendering(rendering)) {
        direction =
          rendering.imageVolume.direction ??
          rendering.imageVolume.imageData?.getDirection?.();
      }
    } catch {
      // Binding not ready yet — still sync with identity volume axes.
    }

    const patch = iCameraToMviewCamera(this.getViewState(), {
      direction,
      volumePhysicalMax: entry.volumePhysicalMax,
      volumeCenter: entry.volumeCenter,
      baselineParallelScale: entry.baselineParallelScale,
      includeFraming: false,
    });

    if (!patch) {
      return;
    }

    this.applySpecializedFramingToPatch(patch, entry);
    entry.renderer.setCamera(patch);
  }

  /**
   * Ortho zoom from VTK parallelScale; pan from canvas panOffset (not focal
   * offset). Keeps rotate/zoom/pan from fighting each other on mview.
   */
  private applySpecializedFramingToPatch(
    patch: { zoom?: number; panX?: number; panY?: number },
    entry: {
      volumePhysicalMax?: number;
      baselineParallelScale?: number;
      renderer: { getCamera: () => { projection?: string } | undefined };
    }
  ): void {
    if (entry.renderer.getCamera()?.projection === 'perspective') {
      return;
    }

    const viewState = this.getViewState();
    const physicalMax = entry.volumePhysicalMax;
    const parallelScale = viewState.parallelScale;

    if (
      typeof parallelScale === 'number' &&
      Number.isFinite(parallelScale) &&
      parallelScale > 0 &&
      typeof physicalMax === 'number' &&
      Number.isFinite(physicalMax) &&
      physicalMax > 0
    ) {
      patch.zoom = parallelScaleToMviewOrthoZoom(
        parallelScale,
        physicalMax,
        entry.baselineParallelScale
      );
    }

    const height = Math.max(this.element.clientHeight || 1, 1);
    patch.panX = (this.panOffset[0] * 2) / height;
    patch.panY = (this.panOffset[1] * 2) / height;
  }

  /**
   * Sizes the WebGPU present canvas (and keeps cpuCanvas dimensions in sync
   * as a size authority for callers that still pass it into render). Bitmap
   * pixels follow CSS client size * devicePixelRatio.
   */
  private syncPresentSize(): void {
    const { clientHeight, clientWidth } = this.element;
    const devicePixelRatio = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(clientWidth * devicePixelRatio));
    const targetHeight = Math.max(
      1,
      Math.round(clientHeight * devicePixelRatio)
    );

    if (
      this.cpuCanvas.width !== targetWidth ||
      this.cpuCanvas.height !== targetHeight
    ) {
      this.cpuCanvas.width = targetWidth;
      this.cpuCanvas.height = targetHeight;
    }

    const webgpuWindow = getWebGPUViewportWindow(this.id);
    if (webgpuWindow) {
      const [currentWidth, currentHeight] = webgpuWindow.view.getSize() ?? [
        0, 0,
      ];
      if (currentWidth !== targetWidth || currentHeight !== targetHeight) {
        webgpuWindow.view.setSize(targetWidth, targetHeight);
      }
    }

    // mview canvas backing-store size is owned by VolumeRenderer.resize()
    // (pixel-budget / FPS target). Do not reset it to native DPR here.

    const slicerLive = getSlicerLiveVolume3D(this.id);
    if (slicerLive) {
      if (
        slicerLive.canvas.width !== targetWidth ||
        slicerLive.canvas.height !== targetHeight
      ) {
        slicerLive.canvas.width = targetWidth;
        slicerLive.canvas.height = targetHeight;
      }
    }

    // vtk-wasm canvas bitmap + SetSize are owned by the render-path resize
    // handler so size and GL viewport stay atomic (changing width alone blanks).
  }
}

export default VolumeViewport3D;

function isVolume3DData(data: LoadedData): data is LoadedData<Volume3DPayload> {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const payload = data as Record<string, unknown>;

  return (
    (payload.type === 'image' &&
      (payload.renderMode === 'vtkVolume3d' ||
        payload.renderMode === WEBGPU_VOLUME_3D_RENDER_MODE ||
        payload.renderMode === MVIEW_VOLUME_3D_RENDER_MODE ||
        payload.renderMode === SLICERLIVE_VOLUME_3D_RENDER_MODE ||
        isVtkWasmVolume3DRenderMode(payload.renderMode))) ||
    (payload.type === 'geometry' && payload.renderMode === 'vtkGeometry3d')
  );
}

function isVolume3DRendering(rendering: {
  renderMode: string;
}): rendering is Volume3DRendering {
  return (
    rendering.renderMode === 'vtkVolume3d' ||
    rendering.renderMode === WEBGPU_VOLUME_3D_RENDER_MODE ||
    rendering.renderMode === MVIEW_VOLUME_3D_RENDER_MODE ||
    rendering.renderMode === SLICERLIVE_VOLUME_3D_RENDER_MODE ||
    isVtkWasmVolume3DRenderMode(rendering.renderMode) ||
    rendering.renderMode === 'vtkGeometry3d'
  );
}

function isVolume3DVolumeRenderMode(
  renderMode: unknown
): renderMode is
  | 'vtkVolume3d'
  | typeof WEBGPU_VOLUME_3D_RENDER_MODE
  | typeof MVIEW_VOLUME_3D_RENDER_MODE
  | typeof SLICERLIVE_VOLUME_3D_RENDER_MODE
  | typeof VTK_WASM_VOLUME_3D_RENDER_MODE
  | typeof VTK_WASM_WEBGPU_VOLUME_3D_RENDER_MODE {
  return (
    renderMode === 'vtkVolume3d' ||
    renderMode === WEBGPU_VOLUME_3D_RENDER_MODE ||
    renderMode === MVIEW_VOLUME_3D_RENDER_MODE ||
    renderMode === SLICERLIVE_VOLUME_3D_RENDER_MODE ||
    isVtkWasmVolume3DRenderMode(renderMode)
  );
}

function isVolume3DVolumePayload(
  data: LoadedData<Volume3DPayload>
): data is LoadedData<Volume3DVolumePayload> {
  return isVolume3DVolumeRenderMode(data.renderMode);
}

function isVolume3DVolumeRendering(
  rendering: Volume3DRendering
): rendering is Volume3DVolumeRendering {
  return (
    rendering.renderMode === 'vtkVolume3d' ||
    rendering.renderMode === WEBGPU_VOLUME_3D_RENDER_MODE
  );
}

function isVolume3DMviewRendering(
  rendering: Volume3DRendering
): rendering is Volume3DMviewRendering {
  return rendering.renderMode === MVIEW_VOLUME_3D_RENDER_MODE;
}

function isVolume3DRegisteredDataSet(
  value: unknown
): value is Volume3DRegisteredDataSet {
  if (!isGenericViewportImageDisplaySet(value)) {
    return false;
  }

  return (
    (value.geometryId === undefined || typeof value.geometryId === 'string') &&
    (value.volumeId === undefined || typeof value.volumeId === 'string') &&
    (value.geometryLoadOptions === undefined ||
      (typeof value.geometryLoadOptions === 'object' &&
        !Array.isArray(value.geometryLoadOptions)))
  );
}
