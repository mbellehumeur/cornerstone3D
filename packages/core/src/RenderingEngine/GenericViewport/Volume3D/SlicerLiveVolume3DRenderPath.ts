import { SlicerLiveVolumeRenderer } from '@slicerlive/webgpu-render';
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
} from './mviewVolume3DCamera';
import {
  applySlicerLiveVolume3DPreset,
  flushSlicerLiveVolume3DPendingPreset,
  registerSlicerLiveVolume3D,
  setSlicerLiveVolume3DValueRange,
  unregisterSlicerLiveVolume3D,
} from './slicerLiveVolume3DRegistry';
import { VIEWPORT_PRESETS } from '../../../constants';
import type {
  Volume3DCamera,
  Volume3DDataPresentation,
  Volume3DSlicerLiveRendering,
  Volume3DViewportRenderContext,
  Volume3DVolumePayload,
} from './viewport3DTypes';
import { getInitialVolume3DCamera } from './vtkVolume3DInitialCamera';
import applyVolume3DCamera from './applyVolume3DCamera';
import setVtkCameraClippingRange from '../setVtkCameraClippingRange';
import { setWebGPUViewportCanvasVisible } from '../Planar/webgpuViewportRenderWindow';
import { getWebGPUViewportWindow } from '../Planar/webgpuViewportRenderWindow';

export const SLICERLIVE_VOLUME_3D_RENDER_MODE = 'slicerLiveVolume3d';

const DEFAULT_SLICERLIVE_PRESET_NAME = 'CT-Bone';

/** @internal */
export class SlicerLiveVolume3DRenderPath
  implements RenderPath<Volume3DViewportRenderContext>
{
  private canvas?: HTMLCanvasElement;
  private renderer?: SlicerLiveVolumeRenderer;
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
    if (!SlicerLiveVolumeRenderer.isSupported()) {
      throw new Error(
        '[SlicerLiveVolume3D] WebGPU is not available in this browser'
      );
    }

    const payload = data as unknown as LoadedData<Volume3DVolumePayload>;
    const imageVolume = payload.imageVolume;

    const canvas = this.ensureCanvas(ctx.viewport.element);
    this.resizeCanvas(canvas, ctx.viewport.element);

    const renderer = new SlicerLiveVolumeRenderer(canvas);
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

    registerSlicerLiveVolume3D(ctx.viewportId, {
      canvas,
      renderer,
      volumePhysicalMax: this.volumePhysicalMax,
      volumeCenter: this.volumeCenter,
    });

    const defaultPreset = VIEWPORT_PRESETS.find(
      (entry) => entry.name === DEFAULT_SLICERLIVE_PRESET_NAME
    );
    if (defaultPreset) {
      applySlicerLiveVolume3DPreset(ctx.viewportId, defaultPreset);
    }

    const webgpuWindow = getWebGPUViewportWindow(ctx.viewportId);
    if (webgpuWindow) {
      setWebGPUViewportCanvasVisible(webgpuWindow, false);
    }

    ctx.display.activateRenderMode(SLICERLIVE_VOLUME_3D_RENDER_MODE);
    canvas.style.display = 'block';
    canvas.style.visibility = 'hidden';
    canvas.style.zIndex = '1';
    this.resizeCanvas(canvas, ctx.viewport.element);

    const initialCamera = getInitialVolume3DCamera(
      { ...ctx, vtk: ctx.vtk },
      imageVolume
    );

    if (initialCamera) {
      applyVolume3DCamera(ctx, initialCamera, { resetClippingRange: true });
      this.baselineParallelScale = initialCamera.parallelScale;
      registerSlicerLiveVolume3D(ctx.viewportId, {
        canvas,
        renderer,
        baselineParallelScale: this.baselineParallelScale,
        volumePhysicalMax: this.volumePhysicalMax,
        volumeCenter: this.volumeCenter,
      });
      this.applySlicerLiveCamera(initialCamera);
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
      if (refreshedAfterLoad) {
        return;
      }

      if (uploaded) {
        this.volumeUploaded = true;
        refreshedAfterLoad = true;
        revealCanvas();
        this.renderer.requestRender();
        ctx.display.renderNow();
      } else if (warnIfEmpty) {
        console.warn(
          `[SlicerLiveVolume3D] No scalars yet (${reason}); waiting for volume events`
        );
      }
    };

    const rendering: Volume3DSlicerLiveRendering = {
      renderMode: SLICERLIVE_VOLUME_3D_RENDER_MODE,
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

          if (loadCompletedSeen && !refreshedAfterLoad) {
            void refreshScalars('volume-modified', { warnIfEmpty: false });
          }
        }
      ),
    };

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
    _rendering: Volume3DSlicerLiveRendering,
    props: unknown
  ): void {
    const presentation = props as Volume3DDataPresentation | undefined;

    if (!presentation) {
      return;
    }

    if (presentation.visible === false) {
      if (this.canvas) {
        this.canvas.style.visibility = 'hidden';
      }
      return;
    }

    if (this.canvas) {
      this.canvas.style.visibility = this.volumeUploaded ? '' : 'hidden';
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
    this.applySlicerLiveCamera(viewState);
  }

  private applySlicerLiveCamera(
    camera: Partial<Volume3DCamera> | undefined
  ): void {
    if (!this.renderer || !camera) {
      return;
    }

    const position = camera.position as [number, number, number] | undefined;
    const focalPoint = camera.focalPoint as
      | [number, number, number]
      | undefined;
    const viewUp = camera.viewUp as [number, number, number] | undefined;

    if (!position || !focalPoint || !viewUp) {
      return;
    }

    // Pose/framing from CS/VTK only — keep SlicerLive projection mode owned by
    // setSlicerLiveVolume3DProjection (VTK sync would otherwise force ortho).
    this.renderer.setCamera({
      position,
      focalPoint,
      viewUp,
      parallelScale: camera.parallelScale,
      viewAngle: camera.viewAngle,
    });
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
    rendering: Volume3DSlicerLiveRendering
  ): void {
    rendering.removeStreamingSubscriptions?.();
    unregisterSlicerLiveVolume3D(ctx.viewportId);
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
    canvas.dataset.slicerLiveVolume3d = 'true';
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
    renderer: SlicerLiveVolumeRenderer,
    imageVolume: IImageVolume
  ): Promise<boolean> {
    const scalarData = getVolumeScalarArray(imageVolume);
    const dimensions =
      imageVolume.dimensions ?? imageVolume.imageData?.getDimensions?.();
    const spacing =
      imageVolume.spacing ?? imageVolume.imageData?.getSpacing?.();
    const origin = imageVolume.origin ?? imageVolume.imageData?.getOrigin?.();

    if (!scalarData || !dimensions || !spacing) {
      return false;
    }

    if (scalarData.length === 0) {
      return false;
    }

    if (!ArrayBuffer.isView(scalarData)) {
      console.warn(
        '[SlicerLiveVolume3D] Scalar buffer is not a TypedArray; skipping upload'
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
        origin: origin as [number, number, number] | undefined,
        direction: this.volumeDirection,
        valueRange:
          range && range.length === 2
            ? ([range[0], range[1]] as [number, number])
            : undefined,
        label: imageVolume.volumeId,
      });

      if (this.viewportId && range && range.length === 2) {
        setSlicerLiveVolume3DValueRange(this.viewportId, [range[0], range[1]]);
        flushSlicerLiveVolume3DPendingPreset(this.viewportId);
      }

      return true;
    } catch (error) {
      console.error('[SlicerLiveVolume3D] setVolume failed', error);
      return false;
    }
  }
}

/** @internal */
export class SlicerLiveVolume3DPath
  implements
    RenderPathDefinition<
      Volume3DViewportRenderContext,
      Volume3DViewportRenderContext
    >
{
  readonly id = 'volume3d:slicerlive-volume';
  readonly type = ViewportType.VOLUME_3D_NEXT;

  matches(data: LoadedData, options: DataAddOptions): boolean {
    return (
      data.type === 'image' &&
      options.renderMode === SLICERLIVE_VOLUME_3D_RENDER_MODE
    );
  }

  createRenderPath() {
    return new SlicerLiveVolume3DRenderPath();
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
