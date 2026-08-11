import { VolumeRenderer } from '@mview/webgpu-volume-standalone';
import { Events, ViewportType } from '../../../enums';
import eventTarget from '../../../eventTarget';
import type { IImageData, IImageVolume } from '../../../types';
import uuidv4 from '../../../utilities/uuidv4';
import type {
  DataAddOptions,
  LoadedData,
  RenderPathAttachment,
  RenderPathDefinition,
  RenderPath,
} from '../ViewportArchitectureTypes';
import { getVolumeScalarArray } from '../webgpuMapperImageData';
import {
  getVolumeCenterWorld,
  getVolumePhysicalMax,
  iCameraToFuberlinCamera,
  pitchVolume3DCameraUp90,
} from './fuberlinVolume3DCamera';
import {
  applyFuberlinVolume3DPreset,
  flushFuberlinVolume3DPendingPreset,
  FUBERLIN_DEFAULT_PRESENT_QUALITY,
  getFuberlinVolume3DPresentQuality,
  getFuberlinVolume3DProjection,
  registerFuberlinVolume3D,
  setFuberlinVolume3DPresentQuality,
  setFuberlinVolume3DValueRange,
  unregisterFuberlinVolume3D,
} from './fuberlinVolume3DRegistry';
import { VIEWPORT_PRESETS } from '../../../constants';
import type {
  Volume3DCamera,
  Volume3DDataPresentation,
  Volume3DFuberlinRendering,
  Volume3DViewportRenderContext,
  Volume3DVolumePayload,
} from './viewport3DTypes';
import { getInitialVolume3DCamera } from './vtkVolume3DInitialCamera';
import applyVolume3DCamera from './applyVolume3DCamera';
import setVtkCameraClippingRange from '../setVtkCameraClippingRange';
import { setWebGPUViewportCanvasVisible } from '../Planar/webgpuViewportRenderWindow';
import { getWebGPUViewportWindow } from '../Planar/webgpuViewportRenderWindow';

export const FUBERLIN_VOLUME_3D_RENDER_MODE = 'fuberlinVolume3D';

const DEFAULT_FUBERLIN_PRESET_NAME = 'CT-Bone';

/**
 * When true: apply +90° pitch about screen-right once after scalars upload
 * (same camera update path TrackballRotate uses via setViewState sync).
 * When false: keep the previous mount-time pitch in addData.
 * Flip to false to revert if this causes orientation problems.
 */
const APPLY_FUBERLIN_POST_LOAD_PITCH_UP_90 = true;

/** @internal */
export class FuberlinVolume3DRenderPath
  implements RenderPath<Volume3DViewportRenderContext>
{
  private canvas?: HTMLCanvasElement;
  private renderer?: VolumeRenderer;
  private baselineParallelScale?: number;
  private volumePhysicalMax?: number;
  private volumeCenter?: [number, number, number];
  private volumeUploaded = false;
  private volumeDirection?: number[];
  private viewportId?: string;

  async addData(
    ctx: Volume3DViewportRenderContext,
    data: LoadedData,
    _options: DataAddOptions
  ): Promise<RenderPathAttachment<Volume3DDataPresentation>> {
    if (!VolumeRenderer.isSupported()) {
      throw new Error(
        '[FuberlinVolume3D] WebGPU is not available in this browser'
      );
    }

    const payload = data as unknown as LoadedData<Volume3DVolumePayload>;
    const imageVolume = payload.imageVolume;

    const canvas = this.ensureCanvas(ctx.viewport.element);
    this.resizeCanvas(canvas, ctx.viewport.element);

    const renderer = new VolumeRenderer(canvas, {
      // Match OHIF Volume3D defaults (CT-Bone composite DVR).
      mode: 'composite',
      threshold: 0.35,
      opacity: 1,
      shade: true,
      background: [0, 0, 0],
      camera: {
        projection: 'orthographic',
        zoom: 0.55,
      },
    });
    await renderer.initialize();
    this.canvas = canvas;
    this.renderer = renderer;
    this.volumeUploaded = false;
    this.viewportId = ctx.viewportId;
    this.volumeDirection = getVolumeDirection(imageVolume);
    this.volumePhysicalMax = getVolumePhysicalMax({
      dimensions: imageVolume.dimensions,
      spacing: imageVolume.spacing,
    });
    this.volumeCenter = getVolumeCenterWorld(
      imageVolume.imageData ?? {
        getOrigin: () => imageVolume.origin,
        getDimensions: () => imageVolume.dimensions,
        getSpacing: () => imageVolume.spacing,
      }
    ) as [number, number, number] | undefined;

    registerFuberlinVolume3D(ctx.viewportId, {
      canvas,
      renderer,
      volumePhysicalMax: this.volumePhysicalMax,
      volumeCenter: this.volumeCenter,
    });
    // ~0.25 matches webgpuVolume3d default look; slider max (1) is denser than OHIF.
    setFuberlinVolume3DPresentQuality(
      ctx.viewportId,
      FUBERLIN_DEFAULT_PRESENT_QUALITY
    );

    // Seed CT-Bone until OHIF/HP applies a specific preset (or after upload).
    const defaultPreset = VIEWPORT_PRESETS.find(
      (entry) => entry.name === DEFAULT_FUBERLIN_PRESET_NAME
    );
    if (defaultPreset) {
      applyFuberlinVolume3DPreset(ctx.viewportId, defaultPreset);
    }
    // Hide any leftover vtk-WebGPU present canvas that could cover ours.
    const webgpuWindow = getWebGPUViewportWindow(ctx.viewportId);
    if (webgpuWindow) {
      setWebGPUViewportCanvasVisible(webgpuWindow, false);
    }

    ctx.display.activateRenderMode(FUBERLIN_VOLUME_3D_RENDER_MODE);
    // Keep block — empty display string reverts to inline and blanks mview.
    // Stay hidden until a full post-load upload; partial scalars look like a
    // solid AABB cube in surface mode.
    canvas.style.display = 'block';
    canvas.style.visibility = 'hidden';
    canvas.style.zIndex = '1';
    this.resizeCanvas(canvas, ctx.viewport.element);

    const initialCamera = getInitialVolume3DCamera(
      { ...ctx, vtk: ctx.vtk },
      imageVolume
    );

    if (initialCamera) {
      // Pitch once after upload when APPLY_FUBERLIN_POST_LOAD_PITCH_UP_90;
      // otherwise pitch here at mount (legacy).
      const cameraToApply = APPLY_FUBERLIN_POST_LOAD_PITCH_UP_90
        ? initialCamera
        : pitchVolume3DCameraUp90(initialCamera);
      applyVolume3DCamera(ctx, cameraToApply, { resetClippingRange: true });
      this.baselineParallelScale = cameraToApply.parallelScale;
      registerFuberlinVolume3D(ctx.viewportId, {
        canvas,
        renderer,
        baselineParallelScale: this.baselineParallelScale,
        volumePhysicalMax: this.volumePhysicalMax,
        volumeCenter: this.volumeCenter,
      });
      this.applyFuberlinCamera(cameraToApply);
    } else {
      setVtkCameraClippingRange(ctx.vtk.renderer.getActiveCamera());
      ctx.vtk.renderer.resetCameraClippingRange();
    }

    const voxelManager = imageVolume.voxelManager as
      | { getRange?: () => number[] }
      | undefined;
    const scalarRange = voxelManager?.getRange?.();
    const defaultVOIRange =
      scalarRange && scalarRange.length === 2
        ? { lower: scalarRange[0], upper: scalarRange[1] }
        : undefined;

    let uploadInFlight: Promise<boolean> | undefined;
    // Match WebGPUVolume3D: full materialize+upload is expensive — do it once
    // after load completes, not on every progressive IMAGE_VOLUME_MODIFIED.
    let loadCompletedSeen = false;
    let refreshedAfterLoad = false;

    const revealCanvas = () => {
      canvas.style.visibility = '';
    };

    const refreshScalars = async (
      reason: string,
      options: { warnIfEmpty?: boolean } = {}
    ) => {
      if (!this.renderer || refreshedAfterLoad) {
        return;
      }

      // Progressive MODIFIED fires before slice 0 is cached; only warn on the
      // milestones where scalars are expected to exist.
      const warnIfEmpty =
        options.warnIfEmpty ??
        (reason === 'load-callback' || reason === 'load-completed');

      this.resizeCanvas(canvas, ctx.viewport.element);

      if (!uploadInFlight) {
        uploadInFlight = this.uploadVolume(this.renderer, imageVolume).finally(
          () => {
            uploadInFlight = undefined;
          }
        );
      }

      const uploaded = await uploadInFlight;

      // Re-check after await: load-callback and load-completed can both enter
      // before either finishes — without this, pitch runs twice (+180°).
      if (refreshedAfterLoad) {
        return;
      }

      if (uploaded) {
        this.volumeUploaded = true;
        refreshedAfterLoad = true;

        // Same +90° screen-right pitch TrackballRotate would apply about view-right.
        // Gated by APPLY_FUBERLIN_POST_LOAD_PITCH_UP_90 for easy revert.
        if (APPLY_FUBERLIN_POST_LOAD_PITCH_UP_90) {
          // Read live VTK camera (ctx.viewport has no getViewState).
          const vtkCam = ctx.vtk.renderer.getActiveCamera();
          const current = {
            clippingRange: vtkCam.getClippingRange() as [number, number],
            focalPoint: [...vtkCam.getFocalPoint()] as [number, number, number],
            parallelProjection: vtkCam.getParallelProjection(),
            parallelScale: vtkCam.getParallelScale(),
            position: [...vtkCam.getPosition()] as [number, number, number],
            viewAngle: vtkCam.getViewAngle(),
            viewPlaneNormal: [...vtkCam.getViewPlaneNormal()] as [
              number,
              number,
              number,
            ],
            viewUp: [...vtkCam.getViewUp()] as [number, number, number],
          };
          const pitched = pitchVolume3DCameraUp90(current);
          applyVolume3DCamera(ctx, pitched, { resetClippingRange: true });
          this.applyFuberlinCamera(pitched);
          if (
            typeof pitched.parallelScale === 'number' &&
            Number.isFinite(pitched.parallelScale)
          ) {
            this.baselineParallelScale = pitched.parallelScale;
          }
        }

        revealCanvas();
        this.renderer.requestRender();
        ctx.display.renderNow();
      } else if (warnIfEmpty) {
        console.warn(
          `[FuberlinVolume3D] No scalars yet (${reason}); waiting for volume events`
        );
      }
    };

    const rendering: Volume3DFuberlinRendering = {
      renderMode: FUBERLIN_VOLUME_3D_RENDER_MODE,
      actorEntryUID: uuidv4(),
      defaultVOIRange,
      imageVolume,
      renderer,
      removeStreamingSubscriptions: subscribeToVolumeEvents(
        payload.volumeId,
        (eventType) => {
          if (eventType === Events.IMAGE_VOLUME_LOADING_COMPLETED) {
            loadCompletedSeen = true;
            void refreshScalars('load-completed');
            return;
          }

          // After completion only: retry if the first materialize failed.
          // Ignore progressive MODIFIED — each upload copies+converts the
          // full volume to r16float and was ~100x slower than WebGPU.
          if (loadCompletedSeen && !refreshedAfterLoad) {
            void refreshScalars('volume-modified', { warnIfEmpty: false });
          }
        }
      ),
    };

    // StreamingImageVolume.load() ignores new callbacks while already loading
    // (DefaultVolume3DDataProvider starts load first). Hook the in-flight
    // callback list when possible, otherwise call load() normally.
    // Upload only here / on LOADING_COMPLETED — never from partial cache
    // (zero-padded slices → opaque surface cube).
    attachVolumeLoadCallback(imageVolume, () => {
      loadCompletedSeen = true;
      void refreshScalars('load-callback');
    });

    return {
      rendering,
      updateDataPresentation: (props) => {
        this.updateDataPresentation(rendering, props);
      },
      applyViewState: (camera) => {
        this.applyViewState(ctx, camera);
      },
      getFrameOfReferenceUID: () => {
        return rendering.imageVolume.metadata?.FrameOfReferenceUID;
      },
      getImageData: () => {
        return buildVolumeImageData(rendering.imageVolume);
      },
      render: () => {
        this.render();
      },
      resize: () => {
        this.resize(ctx);
      },
      removeData: () => {
        this.removeData(ctx, rendering);
      },
    };
  }

  private updateDataPresentation(
    rendering: Volume3DFuberlinRendering,
    props: unknown
  ): void {
    const presentation = props as Volume3DDataPresentation | undefined;
    const { renderer } = rendering;

    if (!presentation) {
      return;
    }

    if (presentation.visible === false) {
      if (this.canvas) {
        this.canvas.style.visibility = 'hidden';
      }
      return;
    }

    // Don't flash the zero-padded cube before the real volume is up.
    if (this.canvas) {
      this.canvas.style.visibility = this.volumeUploaded ? '' : 'hidden';
    }

    if (presentation.opacity !== undefined) {
      renderer.setSettings({ opacity: Math.max(presentation.opacity, 0.001) });
    }
  }

  private applyViewState(
    ctx: Volume3DViewportRenderContext,
    camera: unknown
  ): void {
    const viewState = camera as Partial<Volume3DCamera> | undefined;
    applyVolume3DCamera(ctx, viewState, {
      resetClippingRange: true,
    });
    this.applyFuberlinCamera(viewState);
  }

  private applyFuberlinCamera(
    camera: Partial<Volume3DCamera> | undefined
  ): void {
    if (!this.renderer || !camera || !this.viewportId) {
      return;
    }

    const projection = getFuberlinVolume3DProjection(this.viewportId);
    const patch = iCameraToFuberlinCamera(camera, {
      direction: this.volumeDirection,
      volumePhysicalMax: this.volumePhysicalMax,
      volumeCenter: this.volumeCenter,
      includeFraming: projection === 'orthographic',
    });

    if (patch) {
      this.renderer.setCamera(patch);
    }
  }

  private render(): void {
    this.renderer?.requestRender();
  }

  private resize(ctx: Volume3DViewportRenderContext): void {
    if (!this.canvas) {
      return;
    }

    this.resizeCanvas(this.canvas, ctx.viewport.element);
    this.renderer?.requestRender();
  }

  private resizeCanvas(canvas: HTMLCanvasElement, element: HTMLElement): void {
    const { clientWidth, clientHeight } = element;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(Math.max(clientWidth, 1) * dpr));
    const height = Math.max(1, Math.round(Math.max(clientHeight, 1) * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  private removeData(
    ctx: Volume3DViewportRenderContext,
    rendering: Volume3DFuberlinRendering
  ): void {
    rendering.removeStreamingSubscriptions?.();
    unregisterFuberlinVolume3D(ctx.viewportId);
    rendering.renderer.dispose();
    this.renderer = undefined;
    this.viewportId = undefined;

    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }

    this.canvas = undefined;
  }

  private ensureCanvas(container: HTMLElement): HTMLCanvasElement {
    if (this.canvas && this.canvas.parentElement === container) {
      return this.canvas;
    }

    const canvas = document.createElement('canvas');
    canvas.dataset.fuberlinVolume3d = 'true';
    canvas.style.display = 'block';
    canvas.style.height = '100%';
    canvas.style.inset = '0';
    canvas.style.pointerEvents = 'auto';
    canvas.style.position = 'absolute';
    canvas.style.width = '100%';
    canvas.style.zIndex = '1';
    container.appendChild(canvas);
    this.canvas = canvas;
    return canvas;
  }

  private async uploadVolume(
    renderer: VolumeRenderer,
    imageVolume: IImageVolume
  ): Promise<boolean> {
    const scalarData = getVolumeScalarArray(imageVolume);
    const dimensions =
      imageVolume.dimensions ?? imageVolume.imageData?.getDimensions?.();
    const spacing =
      imageVolume.spacing ?? imageVolume.imageData?.getSpacing?.();

    if (!scalarData || !dimensions || !spacing) {
      return false;
    }

    if (scalarData.length === 0) {
      return false;
    }

    if (!ArrayBuffer.isView(scalarData)) {
      console.warn(
        '[FuberlinVolume3D] Scalar buffer is not a TypedArray; skipping upload'
      );
      return false;
    }

    const voxelManager = imageVolume.voxelManager as
      | { getRange?: () => number[] }
      | undefined;
    const range = voxelManager?.getRange?.();

    try {
      await renderer.setVolume({
        data: scalarData as unknown as ArrayBufferView,
        dimensions: dimensions as [number, number, number],
        spacing: spacing as [number, number, number],
        valueRange:
          range && range.length === 2
            ? ([range[0], range[1]] as [number, number])
            : undefined,
        label: imageVolume.volumeId,
      });

      if (this.viewportId && range && range.length === 2) {
        setFuberlinVolume3DValueRange(this.viewportId, [range[0], range[1]]);
        flushFuberlinVolume3DPendingPreset(this.viewportId);
      }

      // Re-apply present quality now that volume dims/spacing exist so OHIF
      // still steps can match createVolumeMapper sample density.
      if (this.viewportId) {
        const quality =
          getFuberlinVolume3DPresentQuality(this.viewportId) ??
          FUBERLIN_DEFAULT_PRESENT_QUALITY;
        setFuberlinVolume3DPresentQuality(this.viewportId, quality);
      }

      return true;
    } catch (error) {
      console.error('[FuberlinVolume3D] setVolume failed', error);
      return false;
    }
  }
}

/** @internal */
export class FuberlinVolume3DPath
  implements
    RenderPathDefinition<
      Volume3DViewportRenderContext,
      Volume3DViewportRenderContext
    >
{
  readonly id = 'volume3d:fuberlin-volume';
  readonly type = ViewportType.VOLUME_3D_NEXT;

  matches(data: LoadedData, options: DataAddOptions): boolean {
    return (
      data.type === 'image' &&
      options.renderMode === FUBERLIN_VOLUME_3D_RENDER_MODE
    );
  }

  createRenderPath() {
    return new FuberlinVolume3DRenderPath();
  }

  selectContext(
    rootContext: Volume3DViewportRenderContext
  ): Volume3DViewportRenderContext {
    return rootContext;
  }
}

function attachVolumeLoadCallback(
  imageVolume: IImageVolume,
  callback: () => void
): void {
  const streaming = imageVolume as IImageVolume & {
    loadStatus?: {
      loading?: boolean;
      loaded?: boolean;
      callbacks?: Array<(...args: unknown[]) => void>;
    };
    load?: (cb?: (...args: unknown[]) => void) => void;
  };

  const status = streaming.loadStatus;

  if (status?.loaded) {
    callback();
    return;
  }

  if (status?.loading && Array.isArray(status.callbacks)) {
    status.callbacks.push(callback);
    return;
  }

  streaming.load?.(callback);
}

function getVolumeDirection(imageVolume: IImageVolume): number[] | undefined {
  const fromVolume = imageVolume.direction;

  if (fromVolume && fromVolume.length >= 9) {
    return Array.from(fromVolume);
  }

  const fromImageData = imageVolume.imageData?.getDirection?.();

  if (fromImageData && fromImageData.length >= 9) {
    return Array.from(fromImageData);
  }

  return undefined;
}

function subscribeToVolumeEvents(
  volumeId: string,
  onProgress: (
    eventType:
      | Events.IMAGE_VOLUME_MODIFIED
      | Events.IMAGE_VOLUME_LOADING_COMPLETED
  ) => void | Promise<void>
): () => void {
  const handleProgress = (evt: Event) => {
    const detail = (evt as CustomEvent<{ volumeId?: string }>).detail;

    if (detail?.volumeId !== volumeId) {
      return;
    }

    void onProgress(
      evt.type as
        | Events.IMAGE_VOLUME_MODIFIED
        | Events.IMAGE_VOLUME_LOADING_COMPLETED
    );
  };

  eventTarget.addEventListener(Events.IMAGE_VOLUME_MODIFIED, handleProgress);
  eventTarget.addEventListener(
    Events.IMAGE_VOLUME_LOADING_COMPLETED,
    handleProgress
  );

  return () => {
    eventTarget.removeEventListener(
      Events.IMAGE_VOLUME_MODIFIED,
      handleProgress
    );
    eventTarget.removeEventListener(
      Events.IMAGE_VOLUME_LOADING_COMPLETED,
      handleProgress
    );
  };
}

function buildVolumeImageData(
  imageVolume: IImageVolume
): IImageData | undefined {
  const vtkImageData = imageVolume.imageData;

  if (!vtkImageData) {
    return;
  }

  return {
    dimensions: vtkImageData.getDimensions(),
    spacing: vtkImageData.getSpacing(),
    origin: vtkImageData.getOrigin(),
    direction: vtkImageData.getDirection(),
    imageData: vtkImageData,
    metadata: {
      Modality: imageVolume.metadata?.Modality,
      FrameOfReferenceUID: imageVolume.metadata?.FrameOfReferenceUID,
    },
    get scalarData() {
      return getVolumeScalarArray(imageVolume) as never;
    },
    scaling: imageVolume.scaling,
    hasPixelSpacing: imageVolume.hasPixelSpacing,
    voxelManager: imageVolume.voxelManager,
  };
}
