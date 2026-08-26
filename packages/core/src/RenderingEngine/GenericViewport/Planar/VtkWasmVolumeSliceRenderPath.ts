import { Events, ViewportStatus, ViewportType } from '../../../enums';
import eventTarget from '../../../eventTarget';
import triggerEvent from '../../../utilities/triggerEvent';
import uuidv4 from '../../../utilities/uuidv4';
import type { IImageVolume } from '../../../types';
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
  PlanarViewportRenderContext,
} from './PlanarViewportTypes';
import { triggerPlanarVolumeNewImage } from './planarImageEvents';
import { resolvePlanarRenderPathProjection } from './planarRenderPathProjection';
import type { PlanarRendering } from './planarRuntimeTypes';
import {
  createVtkWasmViewportHandle,
  resizeVtkWasmCanvas,
  syncVtkWasmRenderWindowSize,
  type VtkWasmViewportHandle,
} from '../vtkWasmRuntime';
import {
  bindVtkWasmVolume,
  type VtkWasmVolumeBinding,
} from '../vtkWasmVolumeBinding';
import { getVolumeScalarArray } from '../webgpuMapperImageData';
import type { WasmVtkVolumeBrickPlan } from '../../helpers/volumeTextureBrickWasm';

export const VTK_WASM_VOLUME_RENDER_MODE = 'vtkWasmVolume';

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
  defaultVOIRange: undefined;
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

/**
 * Planar MPR render path backed by vtk.wasm WebGL + VTK XYZ partition bricks.
 * @internal
 */
export class VtkWasmVolumeSliceRenderPath
  implements RenderPath<PlanarViewportRenderContext>
{
  private handle?: VtkWasmViewportHandle;
  private renderWindow?: ReturnType<
    NonNullable<VtkWasmViewportHandle['vtk']['vtkRenderWindow']>
  >;
  private renderer?: ReturnType<
    NonNullable<VtkWasmViewportHandle['vtk']['vtkRenderer']>
  >;
  private mapper?: ReturnType<
    NonNullable<VtkWasmViewportHandle['vtk']['vtkImageResliceMapper']>
  >;
  private actor?: ReturnType<
    NonNullable<VtkWasmViewportHandle['vtk']['vtkImageSlice']>
  >;
  private slicePlane?: ReturnType<
    NonNullable<VtkWasmViewportHandle['vtk']['vtkPlane']>
  >;

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
      'vtk-wasm-planar-canvas'
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
    const alreadyLoaded = Boolean(
      (imageVolume as { loadStatus?: { loaded?: boolean } }).loadStatus?.loaded
    );
    if (alreadyLoaded) {
      await binding.refreshScalars();
    }

    const renderWindow = vtk.vtkRenderWindow({
      canvasSelector: handle.canvasKey,
      size: [canvasW, canvasH],
    });
    await syncVtkWasmRenderWindowSize(
      renderWindow as Parameters<typeof syncVtkWasmRenderWindowSize>[0],
      canvasW,
      canvasH
    );
    const renderer = vtk.vtkRenderer();
    const mapper = vtk.vtkImageResliceMapper();
    const actor = vtk.vtkImageSlice();
    const slicePlane = vtk.vtkPlane();

    await Promise.resolve(
      (renderWindow.addRenderer as ((r: unknown) => unknown) | undefined)?.(
        renderer
      )
    );
    await Promise.resolve(
      (mapper.setInputData as ((d: unknown) => unknown) | undefined)?.(
        binding.imageData
      )
    );
    await Promise.resolve(
      (mapper.setSlicePlane as ((p: unknown) => unknown) | undefined)?.(
        slicePlane
      )
    );
    await Promise.resolve(
      (actor.setMapper as ((m: unknown) => unknown) | undefined)?.(mapper)
    );
    await Promise.resolve(
      (renderer.addActor as ((a: unknown) => unknown) | undefined)?.(actor)
    );

    // Partitions primarily affect volume ray-cast; apply when mapper supports it
    // so MPR and Volume3D share the same brick plan ABI.
    await binding.applyPartitions(mapper);

    this.renderWindow = renderWindow;
    this.renderer = renderer;
    this.mapper = mapper;
    this.actor = actor;
    this.slicePlane = slicePlane;

    ctx.display.activateRenderMode(VTK_WASM_VOLUME_RENDER_MODE);

    const uploadAndPresent = () => {
      void Promise.resolve(binding.refreshScalars()).then((ok) => {
        if (ok) {
          ctx.display.renderNow();
        }
      });
    };

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
      defaultVOIRange: undefined,
      dataPresentation: undefined,
      brickPlan: binding.brickPlan,
      binding,
      removeStreamingSubscriptions: subscribeToVolumeEvents(
        payload.volumeId,
        (eventType) => {
          if (eventType === Events.IMAGE_VOLUME_LOADING_COMPLETED) {
            uploadAndPresent();
          }
        }
      ),
    };

    imageVolume.load?.(() => {
      uploadAndPresent();
    });

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
      },
      applyViewState: (camera) => {
        this.applyViewState(ctx, rendering, data.id, camera);
      },
      getFrameOfReferenceUID: () =>
        rendering.imageVolume.metadata?.FrameOfReferenceUID,
      getImageData: () => buildPlanarVolumeImageData(rendering.imageVolume),
      render: () => this.render(ctx, data.id),
      resize: () => {
        if (this.handle) {
          const [w, h] = resizeVtkWasmCanvas(
            this.handle.canvas,
            ctx.viewport.element
          );
          void syncVtkWasmRenderWindowSize(
            this.renderWindow as Parameters<
              typeof syncVtkWasmRenderWindowSize
            >[0],
            w,
            h
          ).then(() => this.render(ctx, data.id));
          return;
        }
        this.render(ctx, data.id);
      },
      removeData: () => {
        rendering.removeStreamingSubscriptions?.();
        this.handle?.dispose();
        this.handle = undefined;
      },
    };
  }

  private applyViewState(
    ctx: PlanarViewportRenderContext,
    rendering: PlanarVtkWasmVolumeSliceRendering,
    dataId: string,
    cameraInput: unknown
  ): void {
    const camera = cameraInput as PlanarViewState | undefined;
    ctx.display.activateRenderMode(VTK_WASM_VOLUME_RENDER_MODE);

    const projection = resolvePlanarRenderPathProjection({
      ctx,
      dataId,
      rendering: asProjectionRendering(rendering),
      viewState: camera,
    });
    if (!projection || !this.slicePlane) {
      return;
    }

    const cam = projection.activeSourceICamera;
    if (cam.focalPoint && cam.viewPlaneNormal) {
      (this.slicePlane.setOrigin as ((...o: number[]) => void) | undefined)?.(
        ...cam.focalPoint
      );
      (this.slicePlane.setNormal as ((...n: number[]) => void) | undefined)?.(
        ...cam.viewPlaneNormal
      );
    }

    rendering.currentImageIdIndex = projection.currentImageIdIndex;
    rendering.maxImageIdIndex = projection.maxImageIdIndex;
  }

  private render(ctx: PlanarViewportRenderContext, dataId: string): void {
    if (!ctx.viewport.isCurrentDataId(dataId) || !this.renderWindow) {
      return;
    }
    (this.renderWindow.render as (() => void) | undefined)?.();
    ctx.display.markRendered();
    triggerEvent(ctx.viewport.element, Events.IMAGE_RENDERED, {
      element: ctx.viewport.element,
      viewportId: ctx.viewportId,
      renderingEngineId: ctx.renderingEngineId,
      viewportStatus: ViewportStatus.RENDERED,
    });
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
