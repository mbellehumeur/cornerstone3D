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
import {
  getVolumeScalarArray,
  materializeVolumeScalarsProgressive,
} from '../webgpuMapperImageData';
import {
  getVolumeCenterWorld,
  getVolumePhysicalMax,
  iCameraToMviewCamera,
  pitchVolume3DCameraUp90,
} from './mviewVolume3DCamera';
import {
  applyMviewVolume3DPreset,
  flushMviewVolume3DPendingPreset,
  MVIEW_DEFAULT_PRESENT_QUALITY,
  MVIEW_DEFAULT_TARGET_FPS,
  getMviewVolume3DPresentQuality,
  getMviewVolume3DProjection,
  getMviewVolume3DTargetFps,
  getMviewVolume3DTargetFpsEnabled,
  registerMviewVolume3D,
  setMviewVolume3DPresentQuality,
  setMviewVolume3DTargetFps,
  setMviewVolume3DTargetFpsEnabled,
  setMviewVolume3DValueRange,
  unregisterMviewVolume3D,
} from './mviewVolume3DRegistry';
import { setStatsOverlayEnabled } from '../../helpers/stats/toggleStatsOverlay';
import { VIEWPORT_PRESETS } from '../../../constants';
import type {
  Volume3DCamera,
  Volume3DDataPresentation,
  Volume3DMviewRendering,
  Volume3DViewportRenderContext,
  Volume3DVolumePayload,
} from './viewport3DTypes';
import { getInitialVolume3DCamera } from './vtkVolume3DInitialCamera';
import applyVolume3DCamera from './applyVolume3DCamera';
import setVtkCameraClippingRange from '../setVtkCameraClippingRange';
import { setWebGPUViewportCanvasVisible } from '../Planar/webgpuViewportRenderWindow';
import { getWebGPUViewportWindow } from '../Planar/webgpuViewportRenderWindow';

export const MVIEW_VOLUME_3D_RENDER_MODE = 'mviewVolume3d';

const DEFAULT_MVIEW_PRESET_NAME = 'CT-Bone';

/**
 * When true: apply +90° pitch about screen-right once after scalars upload
 * (same camera update path TrackballRotate uses via setViewState sync).
 * When false: keep the previous mount-time pitch in addData.
 * Flip to false to revert if this causes orientation problems.
 */
/**
 * When true, pitch the camera +90° about screen-right after volume upload so
 * mview IJK yaw matches TrackballRotate. Leave false to match OHIF /
 * webgpuVolume3d load orientation.
 */
const APPLY_MVIEW_POST_LOAD_PITCH_UP_90 = false;

/** @internal */
export class MviewVolume3DRenderPath
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
        '[MviewVolume3D] WebGPU is not available in this browser'
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
      targetFps: MVIEW_DEFAULT_TARGET_FPS,
      camera: {
        projection: 'orthographic',
        zoom: 0.55,
      },
    });
    await renderer.initialize();
    // Show Cornerstone stats overlay (includes MVIEW TARGET FPS panel).
    setStatsOverlayEnabled(true);
    // Progressive path: defer the GPU probe until the volume is fully loaded.
    renderer.setTargetFpsProbeReady?.(false);
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

    registerMviewVolume3D(ctx.viewportId, {
      canvas,
      renderer,
      volumePhysicalMax: this.volumePhysicalMax,
      volumeCenter: this.volumeCenter,
    });
    // ~0.25 matches webgpuVolume3d default look; slider max (1) is denser than OHIF.
    setMviewVolume3DPresentQuality(
      ctx.viewportId,
      getMviewVolume3DPresentQuality(ctx.viewportId) ??
        MVIEW_DEFAULT_PRESENT_QUALITY
    );
    setMviewVolume3DTargetFps(
      ctx.viewportId,
      getMviewVolume3DTargetFps(ctx.viewportId) ?? MVIEW_DEFAULT_TARGET_FPS
    );
    setMviewVolume3DTargetFpsEnabled(
      ctx.viewportId,
      getMviewVolume3DTargetFpsEnabled(ctx.viewportId) ?? true
    );

    // Seed CT-Bone until OHIF/HP applies a specific preset (or after upload).
    const defaultPreset = VIEWPORT_PRESETS.find(
      (entry) => entry.name === DEFAULT_MVIEW_PRESET_NAME
    );
    if (defaultPreset) {
      applyMviewVolume3DPreset(ctx.viewportId, defaultPreset);
    }
    // Hide any leftover vtk-WebGPU present canvas that could cover ours.
    const webgpuWindow = getWebGPUViewportWindow(ctx.viewportId);
    if (webgpuWindow) {
      setWebGPUViewportCanvasVisible(webgpuWindow, false);
    }

    ctx.display.activateRenderMode(MVIEW_VOLUME_3D_RENDER_MODE);
    // Keep block — empty display string reverts to inline and blanks mview.
    // Stay hidden until the first progressive slice patch (or finish upload).
    canvas.style.display = 'block';
    canvas.style.visibility = 'hidden';
    canvas.style.zIndex = '1';
    this.resizeCanvas(canvas, ctx.viewport.element);

    const initialCamera = getInitialVolume3DCamera(
      { ...ctx, vtk: ctx.vtk },
      imageVolume
    );

    if (initialCamera) {
      // Optional +90° pitch runs once after first upload when
      // APPLY_MVIEW_POST_LOAD_PITCH_UP_90 (see revealIfUploaded). Default is off
      // so load orientation matches OHIF / webgpuVolume3d.
      const cameraToApply = initialCamera;
      applyVolume3DCamera(ctx, cameraToApply, { resetClippingRange: true });
      this.baselineParallelScale = cameraToApply.parallelScale;
      registerMviewVolume3D(ctx.viewportId, {
        canvas,
        renderer,
        baselineParallelScale: this.baselineParallelScale,
        volumePhysicalMax: this.volumePhysicalMax,
        volumeCenter: this.volumeCenter,
      });
      this.applyMviewCamera(cameraToApply);
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

    let uploadQueue: Promise<unknown> = Promise.resolve();
    /** Stops progressive scheduling / duplicate finish; set at start of finish. */
    let streamingClosed = false;
    let progressiveRaf = 0;
    let postLoadPitchApplied = false;
    const dimensions =
      imageVolume.dimensions ?? imageVolume.imageData?.getDimensions?.();
    const depth = dimensions && dimensions.length >= 3 ? dimensions[2] : 0;
    const uploadedSlices =
      depth > 0 ? new Uint8Array(depth) : new Uint8Array(0);
    let targetFpsProbeArmed = false;

    const countUploadedSlices = () => {
      let count = 0;
      for (let i = 0; i < uploadedSlices.length; i++) {
        if (uploadedSlices[i]) {
          count += 1;
        }
      }
      return count;
    };

    const isGpuVolumeComplete = () =>
      depth > 0 && countUploadedSlices() >= depth;

    const markAllSlicesUploaded = () => {
      uploadedSlices.fill(1);
    };

    const armTargetFpsProbe = async () => {
      if (targetFpsProbeArmed || !this.renderer) {
        return;
      }
      if (!isGpuVolumeComplete()) {
        return;
      }
      targetFpsProbeArmed = true;
      streamingClosed = true;
      if (progressiveRaf) {
        cancelAnimationFrame(progressiveRaf);
        progressiveRaf = 0;
      }
      this.applyPresentQuality();
      await this.renderer.waitForGpuIdle?.();
      if (!this.renderer) {
        return;
      }
      this.renderer.setTargetFpsProbeReady?.(true);
    };

    const revealCanvas = () => {
      canvas.style.visibility = '';
    };

    const syncValueRange = () => {
      const voxelManager = imageVolume.voxelManager as
        | { getRange?: () => number[] }
        | undefined;
      const range = voxelManager?.getRange?.();
      if (this.viewportId && range && range.length === 2) {
        setMviewVolume3DValueRange(this.viewportId, [range[0], range[1]]);
        flushMviewVolume3DPendingPreset(this.viewportId);
      }
      return range && range.length === 2
        ? ([range[0], range[1]] as [number, number])
        : undefined;
    };

    const runUpload = <T>(task: () => Promise<T>): Promise<T> => {
      const next = uploadQueue.then(task, task);
      uploadQueue = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    };

    const applyPostLoadPitchIfNeeded = () => {
      if (!APPLY_MVIEW_POST_LOAD_PITCH_UP_90 || postLoadPitchApplied) {
        return;
      }
      postLoadPitchApplied = true;
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
      this.applyMviewCamera(pitched);
      if (
        typeof pitched.parallelScale === 'number' &&
        Number.isFinite(pitched.parallelScale)
      ) {
        this.baselineParallelScale = pitched.parallelScale;
      }
    };

    const revealIfUploaded = (uploaded: boolean) => {
      if (!uploaded || !this.renderer) {
        return;
      }
      this.volumeUploaded = true;
      applyPostLoadPitchIfNeeded();
      revealCanvas();
      this.renderer.requestRender();
      ctx.display.renderNow();
    };

    // Allocate a zero-filled GPU volume immediately so progressive slice
    // patches have a texture to write into (geometry/camera ready).
    void runUpload(async () => {
      this.resizeCanvas(canvas, ctx.viewport.element);
      await this.allocateEmptyVolume(renderer, imageVolume);
      return false;
    });

    const uploadNewSlices = async (): Promise<boolean> => {
      if (!this.renderer) {
        return false;
      }

      this.resizeCanvas(canvas, ctx.viewport.element);

      const progressive = materializeVolumeScalarsProgressive(imageVolume);
      if (!progressive || !ArrayBuffer.isView(progressive.data)) {
        return false;
      }

      const newIndices: number[] = [];
      for (const z of progressive.loadedSliceIndices) {
        if (!uploadedSlices[z]) {
          newIndices.push(z);
        }
      }

      if (newIndices.length === 0) {
        return isGpuVolumeComplete();
      }

      const valueRange = syncValueRange();
      try {
        await this.renderer.updateVolumeSlices({
          data: progressive.data as unknown as ArrayBufferView,
          dimensions: progressive.dimensions,
          sliceIndices: newIndices,
          valueRange,
        });
        for (const z of newIndices) {
          uploadedSlices[z] = 1;
        }
        return true;
      } catch (error) {
        console.error('[MviewVolume3D] updateVolumeSlices failed', error);
        return false;
      }
    };

    const scheduleProgressiveRefresh = () => {
      if (streamingClosed || progressiveRaf) {
        return;
      }
      progressiveRaf = requestAnimationFrame(() => {
        progressiveRaf = 0;
        if (streamingClosed) {
          return;
        }
        void runUpload(async () => {
          const uploaded = await uploadNewSlices();
          if (isGpuVolumeComplete()) {
            await armTargetFpsProbe();
          }
          return uploaded;
        }).then(revealIfUploaded);
      });
    };

    const finishStreaming = async (reason: string) => {
      if (targetFpsProbeArmed) {
        return;
      }

      const uploaded = await runUpload(async () => {
        const patched = await uploadNewSlices();
        if (isGpuVolumeComplete()) {
          return true;
        }
        // CS3D reports complete but GPU still sparse — full scalar fallback.
        const full = await this.uploadVolume(this.renderer!, imageVolume);
        if (full) {
          markAllSlicesUploaded();
        }
        return full || patched;
      });

      if (isGpuVolumeComplete()) {
        revealIfUploaded(true);
        await armTargetFpsProbe();
        return;
      }

      if (uploaded) {
        revealIfUploaded(true);
        return;
      }

      console.warn(
        `[MviewVolume3D] No scalars after ${reason}; volume may be empty`
      );
    };

    const rendering: Volume3DMviewRendering = {
      renderMode: MVIEW_VOLUME_3D_RENDER_MODE,
      actorEntryUID: uuidv4(),
      defaultVOIRange,
      imageVolume,
      renderer,
      removeStreamingSubscriptions: subscribeToVolumeEvents(
        payload.volumeId,
        (eventType) => {
          if (eventType === Events.IMAGE_VOLUME_LOADING_COMPLETED) {
            void finishStreaming('load-completed');
            return;
          }

          // Progressive per-slice patches (coalesced to one rAF).
          scheduleProgressiveRefresh();
        }
      ),
    };

    // StreamingImageVolume.load() ignores new callbacks while already loading
    // (DefaultVolume3DDataProvider starts load first). Hook the in-flight
    // callback list when possible, otherwise call load() normally.
    attachVolumeLoadCallback(imageVolume, () => {
      void finishStreaming('load-callback');
    });

    // If some frames already arrived before we subscribed, upload them now.
    scheduleProgressiveRefresh();

    // Volume already fully loaded (cached) — finish immediately.
    const loadStatus = (imageVolume as { loadStatus?: { loaded?: boolean } })
      .loadStatus;
    if (loadStatus?.loaded) {
      void finishStreaming('already-loaded');
    }

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
        if (progressiveRaf) {
          cancelAnimationFrame(progressiveRaf);
          progressiveRaf = 0;
        }
        streamingClosed = true;
        this.removeData(ctx, rendering);
      },
    };
  }

  private updateDataPresentation(
    rendering: Volume3DMviewRendering,
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
    this.applyMviewCamera(viewState);
  }

  private applyMviewCamera(camera: Partial<Volume3DCamera> | undefined): void {
    if (!this.renderer || !camera || !this.viewportId) {
      return;
    }

    const projection = getMviewVolume3DProjection(this.viewportId);
    const patch = iCameraToMviewCamera(camera, {
      direction: this.volumeDirection,
      volumePhysicalMax: this.volumePhysicalMax,
      volumeCenter: this.volumeCenter,
      baselineParallelScale: this.baselineParallelScale,
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
    rendering: Volume3DMviewRendering
  ): void {
    rendering.removeStreamingSubscriptions?.();
    unregisterMviewVolume3D(ctx.viewportId);
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
    canvas.dataset.mviewVolume3d = 'true';
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

  private applyPresentQuality(): void {
    if (!this.viewportId) {
      return;
    }
    const quality =
      getMviewVolume3DPresentQuality(this.viewportId) ??
      MVIEW_DEFAULT_PRESENT_QUALITY;
    setMviewVolume3DPresentQuality(this.viewportId, quality);
  }

  private async allocateEmptyVolume(
    renderer: VolumeRenderer,
    imageVolume: IImageVolume
  ): Promise<boolean> {
    const dimensions =
      imageVolume.dimensions ?? imageVolume.imageData?.getDimensions?.();
    const spacing =
      imageVolume.spacing ?? imageVolume.imageData?.getSpacing?.();

    if (!dimensions || !spacing || dimensions.length < 3) {
      return false;
    }

    const [dx, dy, dz] = dimensions;
    const total = Math.max(1, dx * dy * dz);
    const voxelManager = imageVolume.voxelManager as
      | { getRange?: () => number[] }
      | undefined;
    const range = voxelManager?.getRange?.();

    try {
      // Zero r16float scaffold — skip full scalar→half convert on allocate.
      await renderer.setVolume({
        data: new Uint16Array(total),
        dimensions: dimensions as [number, number, number],
        spacing: spacing as [number, number, number],
        valueRange:
          range && range.length === 2
            ? ([range[0], range[1]] as [number, number])
            : ([0, 1] as [number, number]),
        sourceFormat: 'r16float',
        label: imageVolume.volumeId,
      });
      // setVolume arms the probe for standalone/full uploads; keep it off
      // until every progressive slice is on the GPU.
      renderer.setTargetFpsProbeReady?.(false);
      this.applyPresentQuality();
      return true;
    } catch (error) {
      console.error('[MviewVolume3D] allocateEmptyVolume failed', error);
      return false;
    }
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
        '[MviewVolume3D] Scalar buffer is not a TypedArray; skipping upload'
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
        setMviewVolume3DValueRange(this.viewportId, [range[0], range[1]]);
        flushMviewVolume3DPendingPreset(this.viewportId);
      }

      // Re-apply present quality now that volume dims/spacing exist so OHIF
      // still steps can match createVolumeMapper sample density.
      this.applyPresentQuality();

      return true;
    } catch (error) {
      console.error('[MviewVolume3D] setVolume failed', error);
      return false;
    }
  }
}

/** @internal */
export class MviewVolume3DPath
  implements
    RenderPathDefinition<
      Volume3DViewportRenderContext,
      Volume3DViewportRenderContext
    >
{
  readonly id = 'volume3d:mview-volume';
  readonly type = ViewportType.VOLUME_3D_NEXT;

  matches(data: LoadedData, options: DataAddOptions): boolean {
    return (
      data.type === 'image' &&
      options.renderMode === MVIEW_VOLUME_3D_RENDER_MODE
    );
  }

  createRenderPath() {
    return new MviewVolume3DRenderPath();
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
