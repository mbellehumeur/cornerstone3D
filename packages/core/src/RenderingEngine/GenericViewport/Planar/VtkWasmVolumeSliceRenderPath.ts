import { Events, ViewportStatus, ViewportType } from '../../../enums';
import eventTarget from '../../../eventTarget';
import triggerEvent from '../../../utilities/triggerEvent';
import uuidv4 from '../../../utilities/uuidv4';
import type { IImageVolume, VOIRange } from '../../../types';
import type {
  DataAddOptions,
  LoadedData,
  RenderPathAttachment,
  RenderPathDefinition,
  RenderPath,
} from '../ViewportArchitectureTypes';
import type {
  PlanarViewState,
  PlanarDataPresentation,
  PlanarPayload,
  PlanarResolvedICamera,
  PlanarViewportRenderContext,
} from './PlanarViewportTypes';
import { triggerPlanarVolumeNewImage } from './planarImageEvents';
import { resolvePlanarRenderPathProjection } from './planarRenderPathProjection';
import type { PlanarRendering } from './planarRuntimeTypes';
import {
  createVtkWasmViewportHandle,
  resizeVtkWasmCanvas,
  syncVtkWasmRenderWindowSize,
  type VtkWasmObject,
  type VtkWasmViewportHandle,
} from '../vtkWasmRuntime';
import {
  bindVtkWasmVolume,
  type VtkWasmVolumeBinding,
} from '../vtkWasmVolumeBinding';
import { getVolumeScalarArray } from '../webgpuMapperImageData';
import type { WasmVtkVolumeBrickPlan } from '../../helpers/volumeTextureBrickWasm';

export const VTK_WASM_VOLUME_RENDER_MODE = 'vtkWasmVolume';
export const VTK_WASM_PLANAR_CANVAS_CLASS = 'vtk-wasm-planar-canvas';

type PlanarVtkWasmVolumeSliceRendering = {
  renderMode: typeof VTK_WASM_VOLUME_RENDER_MODE;
  actorEntryUID: string;
  actor: unknown;
  overlayOrder: number;
  imageVolume: IImageVolume;
  imageIds: string[];
  acquisitionOrientation: PlanarPayload['acquisitionOrientation'];
  mapper: unknown;
  currentImageIdIndex: number;
  maxImageIdIndex: number;
  defaultVOIRange: VOIRange | undefined;
  dataPresentation: PlanarDataPresentation | undefined;
  brickPlan: WasmVtkVolumeBrickPlan;
  binding: VtkWasmVolumeBinding;
  removeStreamingSubscriptions?: () => void;
};

function asProjectionRendering(
  rendering: PlanarVtkWasmVolumeSliceRendering
): PlanarRendering {
  return rendering as unknown as PlanarRendering;
}

async function invoke(
  target: VtkWasmObject | undefined,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = target?.[method];
  if (typeof fn !== 'function') {
    return undefined;
  }
  return await (fn as (...a: unknown[]) => unknown).apply(target, args);
}

function resolveVolumeVoiRange(
  imageVolume: IImageVolume
): VOIRange | undefined {
  const voxelManager = imageVolume.voxelManager as
    | { getRange?: () => number[] }
    | undefined;
  const scalarRange = voxelManager?.getRange?.();
  if (
    scalarRange?.length === 2 &&
    Number.isFinite(scalarRange[0]) &&
    Number.isFinite(scalarRange[1]) &&
    scalarRange[1] > scalarRange[0]
  ) {
    return { lower: scalarRange[0], upper: scalarRange[1] };
  }
  return undefined;
}

/**
 * Planar MPR render path backed by vtk.wasm WebGL.
 * @internal
 */
export class VtkWasmVolumeSliceRenderPath
  implements RenderPath<PlanarViewportRenderContext>
{
  private handle?: VtkWasmViewportHandle;
  private renderWindow?: VtkWasmObject;
  private renderer?: VtkWasmObject;
  private mapper?: VtkWasmObject;
  private actor?: VtkWasmObject;
  private slicePlane?: VtkWasmObject;
  private imageProperty?: VtkWasmObject;
  private binding?: VtkWasmVolumeBinding;

  async addData(
    ctx: PlanarViewportRenderContext,
    data: LoadedData,
    _options: DataAddOptions
  ): Promise<RenderPathAttachment<PlanarDataPresentation>> {
    const payload = data as unknown as LoadedData<PlanarPayload>;
    const imageVolume = payload.imageVolume;
    if (!imageVolume) {
      throw new Error('[vtkWasm] volume MPR requires a prepared image volume');
    }

    const handle = await createVtkWasmViewportHandle(
      ctx.viewport.element,
      VTK_WASM_PLANAR_CANVAS_CLASS
    );
    this.handle = handle;
    const [canvasW, canvasH] = resizeVtkWasmCanvas(
      handle.canvas,
      ctx.viewport.element
    );

    const { vtk } = handle;
    if (
      !vtk.vtkRenderWindow ||
      !vtk.vtkRenderer ||
      !vtk.vtkImageResliceMapper ||
      !vtk.vtkImageSlice ||
      !vtk.vtkPlane
    ) {
      handle.dispose();
      throw new Error(
        '[vtkWasm] ImageReslice / ImageSlice classes missing from wasm bundle'
      );
    }

    const binding = bindVtkWasmVolume(
      vtk,
      imageVolume,
      handle.session.typedArrayInterface
    );
    this.binding = binding;
    const alreadyLoaded = Boolean(
      (imageVolume as { loadStatus?: { loaded?: boolean } }).loadStatus?.loaded
    );
    if (alreadyLoaded) {
      await binding.refreshScalars();
    }

    const renderWindow = vtk.vtkRenderWindow({
      canvasSelector: handle.canvasKey,
      size: [canvasW, canvasH],
    }) as VtkWasmObject;
    await syncVtkWasmRenderWindowSize(renderWindow, canvasW, canvasH);
    const renderer = vtk.vtkRenderer() as VtkWasmObject;
    const mapper = vtk.vtkImageResliceMapper() as VtkWasmObject;
    const actor = vtk.vtkImageSlice() as VtkWasmObject;
    const slicePlane = vtk.vtkPlane() as VtkWasmObject;

    await invoke(renderWindow, 'addRenderer', renderer);
    await invoke(mapper, 'setInputData', binding.imageData);
    await invoke(mapper, 'setSlicePlane', slicePlane);
    await invoke(actor, 'setMapper', mapper);
    await invoke(renderer, 'addActor', actor);

    const imageProperty = (await invoke(actor, 'getProperty')) as
      | VtkWasmObject
      | undefined;
    this.imageProperty = imageProperty ?? (actor.property as VtkWasmObject);

    const defaultVOIRange = resolveVolumeVoiRange(imageVolume);
    if (defaultVOIRange) {
      await this.applyVoiRange(defaultVOIRange);
    }

    // SetPartitions is volume ray-cast only; vtkImageResliceMapper has no such API.

    this.renderWindow = renderWindow;
    this.renderer = renderer;
    this.mapper = mapper;
    this.actor = actor;
    this.slicePlane = slicePlane;

    ctx.display.activateRenderMode(VTK_WASM_VOLUME_RENDER_MODE);
    handle.canvas.style.visibility = 'visible';
    handle.canvas.style.display = 'block';

    const rendering: PlanarVtkWasmVolumeSliceRendering = {
      renderMode: VTK_WASM_VOLUME_RENDER_MODE,
      actorEntryUID: uuidv4(),
      actor: actor as never,
      overlayOrder: 0,
      imageVolume,
      imageIds: payload.imageIds,
      acquisitionOrientation: payload.acquisitionOrientation,
      mapper: mapper as never,
      currentImageIdIndex: payload.initialImageIdIndex ?? 0,
      maxImageIdIndex: payload.imageIds.length - 1,
      defaultVOIRange,
      dataPresentation: undefined,
      brickPlan: binding.brickPlan,
      binding,
    };

    const uploadAndPresent = () => {
      void Promise.resolve(binding.refreshScalars()).then(async (ok) => {
        if (!ok) {
          return;
        }
        if (!rendering.defaultVOIRange) {
          const range = resolveVolumeVoiRange(imageVolume);
          if (range) {
            rendering.defaultVOIRange = range;
            await this.applyVoiRange(range);
          }
        }
        await this.syncFromViewState(ctx, rendering, data.id);
        ctx.display.renderNow();
      });
    };

    rendering.removeStreamingSubscriptions = subscribeToVolumeEvents(
      payload.volumeId,
      (eventType) => {
        if (eventType === Events.IMAGE_VOLUME_LOADING_COMPLETED) {
          uploadAndPresent();
        }
      }
    );

    imageVolume.load?.(() => {
      uploadAndPresent();
    });

    // Initial camera + slice plane so the first present is not an empty scene.
    await this.syncFromViewState(ctx, rendering, data.id);

    if (binding.hasScalars()) {
      await invoke(renderWindow, 'render');
    }

    triggerPlanarVolumeNewImage(ctx, {
      camera: ctx.viewport.getViewState(),
      acquisitionOrientation: rendering.acquisitionOrientation,
      imageIds: rendering.imageIds,
      imageIdIndex: rendering.currentImageIdIndex,
      maxImageIdIndex: rendering.maxImageIdIndex,
    });

    return {
      rendering,
      updateDataPresentation: (props) => {
        rendering.dataPresentation = props as
          | PlanarDataPresentation
          | undefined;
        const voi =
          rendering.dataPresentation?.voiRange ?? rendering.defaultVOIRange;
        if (voi) {
          void this.applyVoiRange(voi).then(() => this.render(ctx, data.id));
        }
      },
      applyViewState: (camera) => {
        void this.syncFromViewState(
          ctx,
          rendering,
          data.id,
          camera as PlanarViewState | undefined
        ).then(() => this.render(ctx, data.id));
      },
      getFrameOfReferenceUID: () =>
        rendering.imageVolume.metadata?.FrameOfReferenceUID,
      getImageData: () => buildPlanarVolumeImageData(rendering.imageVolume),
      render: () => {
        void this.renderAsync(ctx, data.id);
      },
      resize: () => {
        if (this.handle) {
          const [w, h] = resizeVtkWasmCanvas(
            this.handle.canvas,
            ctx.viewport.element
          );
          void syncVtkWasmRenderWindowSize(this.renderWindow, w, h).then(
            async () => {
              await this.syncFromViewState(ctx, rendering, data.id);
              await this.renderAsync(ctx, data.id);
            }
          );
          return;
        }
        void this.renderAsync(ctx, data.id);
      },
      removeData: () => {
        rendering.removeStreamingSubscriptions?.();
        this.handle?.dispose();
        this.handle = undefined;
        this.renderWindow = undefined;
        this.renderer = undefined;
        this.mapper = undefined;
        this.actor = undefined;
        this.slicePlane = undefined;
        this.imageProperty = undefined;
        this.binding = undefined;
      },
    };
  }

  private async applyVoiRange(voiRange: VOIRange): Promise<void> {
    const property = this.imageProperty;
    if (!property) {
      return;
    }
    const window = voiRange.upper - voiRange.lower;
    const level = (voiRange.upper + voiRange.lower) / 2;
    if (!(window > 0) || !Number.isFinite(level)) {
      return;
    }
    await invoke(property, 'setColorWindow', window);
    await invoke(property, 'setColorLevel', level);
    property.$set?.({ colorWindow: window, colorLevel: level });
  }

  private async applyCameraToWasm(
    camera: PlanarResolvedICamera
  ): Promise<void> {
    const renderer = this.renderer;
    if (!renderer) {
      return;
    }

    let cam = renderer.activeCamera as VtkWasmObject | undefined;
    if (!cam) {
      cam = (await invoke(renderer, 'getActiveCamera')) as
        | VtkWasmObject
        | undefined;
    }
    if (!cam) {
      await invoke(renderer, 'resetCamera');
      await invoke(renderer, 'resetCameraClippingRange');
      return;
    }

    await invoke(cam, 'setParallelProjection', 1);
    if (camera.viewUp) {
      await invoke(cam, 'setViewUp', ...camera.viewUp);
    }
    if (camera.focalPoint) {
      await invoke(cam, 'setFocalPoint', ...camera.focalPoint);
    }
    if (camera.position) {
      await invoke(cam, 'setPosition', ...camera.position);
    }
    if (typeof camera.parallelScale === 'number') {
      await invoke(cam, 'setParallelScale', camera.parallelScale);
    }
    // Do not call setDirectionOfProjection — vtkOpenGLCamera in vtk-wasm has
    // no such method; position + focalPoint imply the look direction.

    cam.$set?.({
      parallelProjection: 1,
      ...(camera.viewUp ? { viewUp: camera.viewUp } : {}),
      ...(camera.focalPoint ? { focalPoint: camera.focalPoint } : {}),
      ...(camera.position ? { position: camera.position } : {}),
      ...(typeof camera.parallelScale === 'number'
        ? { parallelScale: camera.parallelScale }
        : {}),
    });

    await invoke(renderer, 'resetCameraClippingRange');
  }

  private async syncFromViewState(
    ctx: PlanarViewportRenderContext,
    rendering: PlanarVtkWasmVolumeSliceRendering,
    dataId: string,
    cameraInput?: PlanarViewState
  ): Promise<void> {
    ctx.display.activateRenderMode(VTK_WASM_VOLUME_RENDER_MODE);
    if (this.handle?.canvas) {
      this.handle.canvas.style.visibility = 'visible';
      this.handle.canvas.style.display = 'block';
    }

    const camera = cameraInput ?? ctx.viewport.getViewState();
    const projection = resolvePlanarRenderPathProjection({
      ctx,
      dataId,
      rendering: asProjectionRendering(rendering),
      viewState: camera,
    });
    if (!projection || !this.slicePlane) {
      return;
    }

    const cam = projection.isSourceBinding
      ? projection.resolvedICamera
      : projection.activeSourceICamera;

    if (cam.focalPoint && cam.viewPlaneNormal) {
      await invoke(this.slicePlane, 'setOrigin', ...cam.focalPoint);
      await invoke(this.slicePlane, 'setNormal', ...cam.viewPlaneNormal);
      this.slicePlane.$set?.({
        origin: cam.focalPoint,
        normal: cam.viewPlaneNormal,
      });
    }

    if (projection.isSourceBinding) {
      await this.applyCameraToWasm(projection.resolvedICamera);
    } else {
      await this.applyCameraToWasm(projection.activeSourceICamera);
    }

    rendering.currentImageIdIndex = projection.currentImageIdIndex;
    rendering.maxImageIdIndex = projection.maxImageIdIndex;
  }

  private async renderAsync(
    ctx: PlanarViewportRenderContext,
    dataId: string
  ): Promise<void> {
    if (!ctx.viewport.isCurrentDataId(dataId) || !this.renderWindow) {
      return;
    }
    if (!this.binding?.hasScalars()) {
      return;
    }
    await invoke(this.renderWindow, 'render');
    ctx.display.markRendered();
    triggerEvent(ctx.viewport.element, Events.IMAGE_RENDERED, {
      element: ctx.viewport.element,
      viewportId: ctx.viewportId,
      renderingEngineId: ctx.renderingEngineId,
      viewportStatus: ViewportStatus.RENDERED,
    });
  }

  private render(ctx: PlanarViewportRenderContext, dataId: string): void {
    void this.renderAsync(ctx, dataId);
  }
}

/** @internal */
export class VtkWasmVolumeSlicePath
  implements
    RenderPathDefinition<
      PlanarViewportRenderContext,
      PlanarViewportRenderContext
    >
{
  readonly id = 'planar:vtk-wasm-volume';
  readonly type = ViewportType.PLANAR_NEXT;

  matches(data: LoadedData, options: DataAddOptions): boolean {
    return (
      data.type === 'image' &&
      options.renderMode === VTK_WASM_VOLUME_RENDER_MODE
    );
  }

  createRenderPath() {
    return new VtkWasmVolumeSliceRenderPath();
  }

  selectContext(rootContext: PlanarViewportRenderContext) {
    return rootContext;
  }
}

/**
 * Stack image mode stub — v1 vtk.wasm backend is MPR + Volume3D only.
 * @internal
 */
export class VtkWasmImageMapperPath
  implements
    RenderPathDefinition<
      PlanarViewportRenderContext,
      PlanarViewportRenderContext
    >
{
  readonly id = 'planar:vtk-wasm-image';
  readonly type = ViewportType.PLANAR_NEXT;

  matches(data: LoadedData, options: DataAddOptions): boolean {
    return data.type === 'image' && options.renderMode === 'vtkWasmImage';
  }

  createRenderPath(): RenderPath<PlanarViewportRenderContext> {
    return {
      async addData() {
        throw new Error(
          '[vtkWasm] Stack image mode is not supported in v1 (MPR + Volume3D only)'
        );
      },
    };
  }

  selectContext(rootContext: PlanarViewportRenderContext) {
    return rootContext;
  }
}

export const VTK_WASM_IMAGE_RENDER_MODE = 'vtkWasmImage';

function subscribeToVolumeEvents(
  volumeId: string,
  onProgress: (
    eventType:
      | Events.IMAGE_VOLUME_MODIFIED
      | Events.IMAGE_VOLUME_LOADING_COMPLETED,
    detail?: { imageIdIndex?: number; volumeId?: string }
  ) => void
): () => void {
  const handle = (evt: Event) => {
    const detail = (
      evt as CustomEvent<{ volumeId?: string; imageIdIndex?: number }>
    ).detail;
    if (detail?.volumeId !== volumeId) {
      return;
    }
    onProgress(
      evt.type as
        | Events.IMAGE_VOLUME_MODIFIED
        | Events.IMAGE_VOLUME_LOADING_COMPLETED,
      detail
    );
  };
  eventTarget.addEventListener(Events.IMAGE_VOLUME_MODIFIED, handle);
  eventTarget.addEventListener(Events.IMAGE_VOLUME_LOADING_COMPLETED, handle);
  return () => {
    eventTarget.removeEventListener(Events.IMAGE_VOLUME_MODIFIED, handle);
    eventTarget.removeEventListener(
      Events.IMAGE_VOLUME_LOADING_COMPLETED,
      handle
    );
  };
}

function buildPlanarVolumeImageData(imageVolume: IImageVolume) {
  return {
    dimensions: imageVolume.dimensions,
    spacing: imageVolume.spacing,
    origin: imageVolume.origin,
    direction: imageVolume.direction,
    metadata: imageVolume.metadata,
    imageData: imageVolume.imageData,
    voxelManager: imageVolume.voxelManager,
    scaling: imageVolume.scaling,
    hasPixelSpacing: true,
    getScalarData: () => getVolumeScalarArray(imageVolume),
  };
}
