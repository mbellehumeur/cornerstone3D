import { vec3 } from 'gl-matrix';
import type vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import { ViewportType } from '../../../enums';
import type {
  ActorEntry,
  ICamera,
  IImageData,
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
  Volume3DRenderMode,
  Volume3DRegisteredDataSet,
  Volume3DRendering,
  Volume3DVolumePayload,
  Volume3DVolumeRendering,
  Volume3DSetDataOptions,
  Volume3DViewportRenderContext,
  VolumeViewport3DInput,
} from './viewport3DTypes';
import { getWebGPUViewportWindow } from '../Planar/webgpuViewportRenderWindow';
import { WEBGPU_VOLUME_3D_RENDER_MODE } from './WebGPUVolume3DRenderPath';

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

  static get useCustomRenderingPipeline(): boolean {
    return false;
  }

  getUseCustomRenderingPipeline(): boolean {
    return false;
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
    this.setRenderModeVisibility('vtkVolume3d');
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
    this.viewState = this.getViewState();
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
      !isVolume3DVolumeRendering(rendering)
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
   * surface is `cpuCanvas` (blit target); otherwise the VTK OpenGL canvas.
   */
  getCanvas(): HTMLCanvasElement {
    if (this.isWebGPUVolumeRenderModeActive()) {
      return this.cpuCanvas;
    }

    return this.canvas;
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
    this.modified(previousCamera);
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
      !isVolume3DVolumeRendering(rendering)
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
    }

    // resetCamera() recenters the focal point on the bounds; restore the
    // previous pan/center when the caller opts out of recentering.
    if (!resetPan || !resetToCenter) {
      camera.setFocalPoint(...previousFocalPoint);
      camera.setPosition(...previousPosition);
      renderer.resetCameraClippingRange();
    }

    this.viewState = this.getViewState();
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
   */
  resize(): void {
    if (this.isDestroyed) {
      return;
    }

    this.syncCpuCanvasSize();
    const activeCanvas = this.getCanvas();
    this.sWidth = activeCanvas.width;
    this.sHeight = activeCanvas.height;

    this.resizeBindings();
  }

  /**
   * Renders active 3D bindings or queues an engine-driven render.
   */
  render(): void {
    if (this.isDestroyed) {
      return;
    }

    if (!this.renderBindings()) {
      this.requestRenderingEngineRender();
    }
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

  private setRenderModeVisibility(renderMode: Volume3DRenderMode): void {
    const useCPUCanvas = renderMode === WEBGPU_VOLUME_3D_RENDER_MODE;
    this.cpuCanvas.style.display = useCPUCanvas ? '' : 'none';
    this.cpuCanvas.style.pointerEvents = useCPUCanvas ? 'auto' : 'none';
    this.canvas.style.display = useCPUCanvas ? 'none' : '';

    if (useCPUCanvas) {
      this.syncCpuCanvasSize();
      this.renderContext.vtk.canvas = this.cpuCanvas;
      // Prefer the live WebGPU renderer when the path has already acquired it
      // so viewport camera APIs stay aligned with what is drawn.
      const window = getWebGPUViewportWindow(this.id);
      if (window) {
        this.renderContext.vtk.renderer = window.renderer;
      }
      return;
    }

    this.renderContext.vtk.renderer = this.defaultVtkRenderer;
    this.renderContext.vtk.canvas = this.canvas;
  }

  private isWebGPUVolumeRenderModeActive(): boolean {
    return this.cpuCanvas.style.display !== 'none';
  }

  /**
   * Sizes the WebGPU blit target like PlanarViewport: bitmap pixels follow
   * CSS client size * devicePixelRatio. Without this the canvas stays at the
   * browser default (300x150) and the volume blit looks empty/stretched.
   */
  private syncCpuCanvasSize(): void {
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
        payload.renderMode === WEBGPU_VOLUME_3D_RENDER_MODE)) ||
    (payload.type === 'geometry' && payload.renderMode === 'vtkGeometry3d')
  );
}

function isVolume3DRendering(rendering: {
  renderMode: string;
}): rendering is Volume3DRendering {
  return (
    rendering.renderMode === 'vtkVolume3d' ||
    rendering.renderMode === WEBGPU_VOLUME_3D_RENDER_MODE ||
    rendering.renderMode === 'vtkGeometry3d'
  );
}

function isVolume3DVolumeRenderMode(
  renderMode: unknown
): renderMode is 'vtkVolume3d' | typeof WEBGPU_VOLUME_3D_RENDER_MODE {
  return (
    renderMode === 'vtkVolume3d' || renderMode === WEBGPU_VOLUME_3D_RENDER_MODE
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
  return isVolume3DVolumeRenderMode(rendering.renderMode);
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
