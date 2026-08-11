import '@kitware/vtk.js/Rendering/Profiles/Volume';
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import { Events, ViewportType } from '../../../enums';
import eventTarget from '../../../eventTarget';
import type { IImageData, IImageVolume, Point2, Point3 } from '../../../types';
import createLinearRGBTransferFunction from '../../../utilities/createLinearRGBTransferFunction';
import invertRgbTransferFunction from '../../../utilities/invertRgbTransferFunction';
import { updateOpacity as updateVolumeOpacity } from '../../../utilities/colormap';
import uuidv4 from '../../../utilities/uuidv4';
import {
  canvasToWorldContextPool,
  worldToCanvasContextPool,
} from '../../helpers/vtkCanvasCoordinateTransforms';
import type {
  DataAddOptions,
  LoadedData,
  RenderPathAttachment,
  RenderPathDefinition,
  RenderPath,
} from '../ViewportArchitectureTypes';
import {
  acquireWebGPUMapperImageData,
  refreshWebGPUMapperScalars,
  releaseWebGPUMapperImageData,
} from '../webgpuMapperImageData';
import {
  acquireWebGPUViewportWindow,
  releaseWebGPUViewportWindow,
  renderWebGPUViewportWindow,
  type WebGPUViewportWindow,
} from '../Planar/webgpuViewportRenderWindow';
import type {
  Volume3DCamera,
  Volume3DDataPresentation,
  Volume3DViewportRenderContext,
  Volume3DVolumePayload,
  Volume3DVolumeRendering,
  Volume3DVtkVolumeAdapterContext,
} from './viewport3DTypes';
import applyVolume3DCamera from './applyVolume3DCamera';
import { getInitialVolume3DCamera } from './vtkVolume3DInitialCamera';
import setVtkCameraClippingRange from '../setVtkCameraClippingRange';

export const WEBGPU_VOLUME_3D_RENDER_MODE = 'webgpuVolume3d';

/** @internal */
export class WebGPUVolume3DRenderPath
  implements RenderPath<Volume3DVtkVolumeAdapterContext>
{
  private window?: WebGPUViewportWindow;

  async addData(
    ctx: Volume3DVtkVolumeAdapterContext,
    data: LoadedData,
    _options: DataAddOptions
  ): Promise<RenderPathAttachment<Volume3DDataPresentation>> {
    const payload: Volume3DVolumePayload =
      data as unknown as LoadedData<Volume3DVolumePayload>;
    const imageVolume = payload.imageVolume;

    const window = acquireWebGPUViewportWindow(ctx.viewportId, {
      renderingEngineId: ctx.renderingEngineId,
    });
    this.window = window;
    // Strip leftover OpenGL volumes before pin — VTK removeData after a prior
    // WebGPU pin can miss its host renderer and leave actors on defaultVtk.
    const previousRenderer = ctx.vtk.renderer;
    if (previousRenderer && previousRenderer !== window.renderer) {
      for (const volume of [...previousRenderer.getVolumes()]) {
        previousRenderer.removeVolume(volume);
      }
    }
    // Pin the shared viewport vtk handle to the live WebGPU renderer/canvas so
    // getViewState/setViewState/resetCamera and path helpers all share one camera.
    this.pinContextToWindow(ctx);
    const hostRenderer = window.renderer;
    const hadVolume = hostRenderer.getVolumes().length > 0;

    const mapperImageDataEntry = acquireWebGPUMapperImageData(
      payload.volumeId,
      imageVolume
    );
    const mapperImageData = mapperImageDataEntry.imageData;

    const actor = vtkVolume.newInstance();
    const mapper = vtkVolumeMapper.newInstance();
    mapper.setInputData(mapperImageData);
    applyDefaultSampleDistance(mapper);
    actor.setMapper(mapper);
    actor.getProperty().setIndependentComponents(false);
    initializeDefaultTransferFunction(actor, imageVolume);

    ctx.display.activateRenderMode(WEBGPU_VOLUME_3D_RENDER_MODE);
    hostRenderer.addVolume(actor);
    if (!hadVolume) {
      const initialCamera = getInitialVolume3DCamera(ctx, imageVolume);

      if (initialCamera) {
        applyCamera(ctx, initialCamera);
      }
    }
    setCameraClippingRange(ctx);

    const defaultRange = actor
      .getProperty()
      .getRGBTransferFunction(0)
      .getRange();

    const rendering: Volume3DVolumeRendering = {
      renderMode: WEBGPU_VOLUME_3D_RENDER_MODE,
      actorEntryUID: uuidv4(),
      actor,
      defaultVOIRange: defaultRange
        ? { lower: defaultRange[0], upper: defaultRange[1] }
        : undefined,
      imageVolume,
      mapper,
      hostRenderer,
      removeStreamingSubscriptions: subscribeToVolumeEvents(
        payload.volumeId,
        (eventType) => {
          const shouldRefreshScalars =
            !mapperImageDataEntry.refreshedAfterLoad &&
            (eventType === Events.IMAGE_VOLUME_LOADING_COMPLETED ||
              // Retry if an earlier completion refresh failed to materialize.
              eventType === Events.IMAGE_VOLUME_MODIFIED);

          let refreshed = false;
          if (
            shouldRefreshScalars &&
            (eventType === Events.IMAGE_VOLUME_LOADING_COMPLETED ||
              mapperImageDataEntry.loadCompletedSeen)
          ) {
            if (eventType === Events.IMAGE_VOLUME_LOADING_COMPLETED) {
              mapperImageDataEntry.loadCompletedSeen = true;
            }
            refreshed = refreshWebGPUMapperScalars(
              mapperImageData,
              imageVolume
            );
            if (refreshed) {
              mapperImageDataEntry.refreshedAfterLoad = true;
              rendering.mapper.modified();
            }
          }

          // Skip full raycasts on progressive IMAGE_VOLUME_MODIFIED until
          // scalars actually rematerialize. Self-render via renderNow (like
          // planar WebGPU paths) — requestRender blits the hidden OpenGL canvas.
          if (refreshed) {
            ctx.display.renderNow();
          }
        }
      ),
    };

    imageVolume.load(() => {
      if (!mapperImageDataEntry.refreshedAfterLoad) {
        const refreshed = refreshWebGPUMapperScalars(
          mapperImageData,
          imageVolume
        );
        if (refreshed) {
          mapperImageDataEntry.refreshedAfterLoad = true;
          rendering.mapper.modified();
        }
      }
      ctx.display.renderNow();
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
        return this.getFrameOfReferenceUID(rendering);
      },
      getImageData: () => {
        return this.getImageData(rendering);
      },
      render: () => {
        this.render(ctx);
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
    rendering: Volume3DVolumeRendering,
    props: unknown
  ): void {
    applyDataPresentation(
      rendering,
      props as Volume3DDataPresentation | undefined
    );
  }

  private applyViewState(
    ctx: Volume3DVtkVolumeAdapterContext,
    camera: unknown
  ): void {
    ctx.display.activateRenderMode(WEBGPU_VOLUME_3D_RENDER_MODE);
    this.pinContextToWindow(ctx);
    applyCamera(ctx, camera as Partial<Volume3DCamera> | undefined);
  }

  private pinContextToWindow(ctx: Volume3DVtkVolumeAdapterContext): void {
    if (!this.window) {
      return;
    }

    ctx.vtk.renderer = this.window.renderer;
    ctx.vtk.canvas = this.window.view.getCanvas();
  }

  private canvasToWorld(
    ctx: Volume3DVtkVolumeAdapterContext,
    canvasPos: Point2
  ): Point3 {
    return canvasToWorldContextPool({
      canvas: ctx.vtk.canvas,
      renderer: ctx.vtk.renderer,
      canvasPos,
    });
  }

  private worldToCanvas(
    ctx: Volume3DVtkVolumeAdapterContext,
    worldPos: Point3
  ): Point2 {
    return worldToCanvasContextPool({
      canvas: ctx.vtk.canvas,
      renderer: ctx.vtk.renderer,
      worldPos,
    });
  }

  private getFrameOfReferenceUID(
    rendering: Volume3DVolumeRendering
  ): string | undefined {
    return rendering.imageVolume.metadata?.FrameOfReferenceUID;
  }

  private getImageData(
    rendering: Volume3DVolumeRendering
  ): IImageData | undefined {
    return buildVolumeImageData(rendering.imageVolume);
  }

  private render(ctx: Volume3DVtkVolumeAdapterContext): void {
    if (!this.window) {
      return;
    }

    renderWebGPUViewportWindow(this.window, ctx.cpu.canvas);
  }

  private resize(ctx: Volume3DVtkVolumeAdapterContext): void {
    this.render(ctx);
  }

  private removeData(
    ctx: Volume3DVtkVolumeAdapterContext,
    rendering: Volume3DVolumeRendering
  ): void {
    const { actor, hostRenderer, removeStreamingSubscriptions } = rendering;

    removeStreamingSubscriptions?.();
    (hostRenderer ?? this.window?.renderer)?.removeVolume(actor);
    if (this.window) {
      this.window = undefined;
      releaseWebGPUViewportWindow(ctx.viewportId);
    }
    // Unpin so a following vtkVolume3d path adds to the default OpenGL renderer.
    ctx.display.activateRenderMode('vtkVolume3d');
    releaseWebGPUMapperImageData(rendering.imageVolume.volumeId);
  }
}

/** @internal */
export class WebGPUVolume3DPath
  implements
    RenderPathDefinition<
      Volume3DViewportRenderContext,
      Volume3DVtkVolumeAdapterContext
    >
{
  readonly id = 'volume3d:webgpu-volume';
  readonly type = ViewportType.VOLUME_3D_NEXT;

  matches(data: LoadedData, options: DataAddOptions): boolean {
    return (
      data.type === 'image' &&
      options.renderMode === WEBGPU_VOLUME_3D_RENDER_MODE
    );
  }

  createRenderPath() {
    return new WebGPUVolume3DRenderPath();
  }

  selectContext(
    rootContext: Volume3DViewportRenderContext
  ): Volume3DVtkVolumeAdapterContext {
    // Share the viewport's vtk handle so pinning window.renderer in addData
    // updates getViewState/setViewState/resetCamera consumers too. A copied
    // { renderer } object left the viewport reading the hidden OpenGL camera
    // and later applyViewState clobbered the WebGPU camera → blank display.
    return {
      ...rootContext,
      vtk: rootContext.vtk,
    };
  }
}

function subscribeToVolumeEvents(
  volumeId: string,
  onProgress: (
    eventType:
      | Events.IMAGE_VOLUME_MODIFIED
      | Events.IMAGE_VOLUME_LOADING_COMPLETED
  ) => void
): () => void {
  const handleProgress = (evt: Event) => {
    const detail = (evt as CustomEvent<{ volumeId?: string }>).detail;

    if (detail?.volumeId !== volumeId) {
      return;
    }

    onProgress(
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

function applyDataPresentation(
  rendering: Volume3DVolumeRendering,
  props?: Volume3DDataPresentation
): void {
  const { actor, defaultVOIRange } = rendering;
  const property = actor.getProperty();
  const voiRange = props?.voiRange ?? defaultVOIRange;

  actor.setVisibility(props?.visible === false ? false : true);

  if (props?.opacity !== undefined) {
    try {
      updateVolumeOpacity(actor, props.opacity);
    } catch {
      // Shared opacity helper expects ImageVolume-style metadata that may not
      // match the WebGPU mapper clone; keep the actor visible.
    }
  }

  if (!voiRange) {
    return;
  }

  const transferFunction = createLinearRGBTransferFunction(voiRange);

  if (props?.invert) {
    invertRgbTransferFunction(transferFunction);
  }

  property.setRGBTransferFunction(0, transferFunction);

  if (props?.interpolationType !== undefined) {
    property.setInterpolationType(
      props.interpolationType as Parameters<
        typeof property.setInterpolationType
      >[0]
    );
  }

  if (props?.sampleDistanceMultiplier !== undefined) {
    applySampleDistanceMultiplier(
      rendering.mapper,
      props.sampleDistanceMultiplier
    );
  }
}

function applyCamera(
  ctx: Volume3DVtkVolumeAdapterContext,
  camera?: Partial<Volume3DCamera>
): void {
  applyVolume3DCamera(ctx, camera);

  if (camera && camera.clippingRange === undefined) {
    setCameraClippingRange(ctx);
  }
}

function applyDefaultSampleDistance(mapper: vtkVolumeMapper): void {
  applySampleDistanceMultiplier(mapper, 1);
  mapper.setMaximumSamplesPerRay(4000);
  // VolumePass only downscales while isAnimating && _lastScale > 1.5.
  // Default initialInteractionScale is 1.0, which never opens that gate.
  // Scale 4 → half-res per axis (1/sqrt(4)); settled frames still use full DPR
  // because isAnimating is false outside interaction.
  mapper.setInitialInteractionScale(4);
}

function applySampleDistanceMultiplier(
  mapper: vtkVolumeMapper,
  multiplier: number
): void {
  const imageData = mapper.getInputData?.();

  if (!imageData) {
    return;
  }

  const spacing = imageData.getSpacing();
  const defaultSampleDistance = (spacing[0] + spacing[1] + spacing[2]) / 6;
  const safeMultiplier = Number.isFinite(multiplier)
    ? Math.max(multiplier, 0.001)
    : 1;

  mapper.setSampleDistance(defaultSampleDistance * safeMultiplier);
}

function setCameraClippingRange(ctx: Volume3DVtkVolumeAdapterContext): void {
  // Prefer bounds-tight reset when volumes are present (same visible result as
  // wide±1e6 then reset; avoids leaving absurd near/far if reset were skipped).
  if (ctx.vtk.renderer.getVolumes().length > 0) {
    ctx.vtk.renderer.resetCameraClippingRange();
    return;
  }
  setVtkCameraClippingRange(ctx.vtk.renderer.getActiveCamera());
  ctx.vtk.renderer.resetCameraClippingRange();
}

function initializeDefaultTransferFunction(
  actor: ReturnType<typeof vtkVolume.newInstance>,
  imageVolume: IImageVolume
): void {
  const voxelManager = imageVolume.voxelManager as
    | { getRange?: () => number[] }
    | undefined;
  const scalarRange = voxelManager?.getRange?.();

  if (!scalarRange || scalarRange.length !== 2) {
    return;
  }

  const property = actor.getProperty();
  const tf = createLinearRGBTransferFunction({
    lower: scalarRange[0],
    upper: scalarRange[1],
  });
  property.setRGBTransferFunction(0, tf);

  // Seed a visible opacity ramp so the volume is not fully transparent before
  // OHIF applies a hanging-protocol preset. Avoid updateOpacity() here — it
  // reads mapper imageData voxelManager metadata in a shape that does not match
  // the WebGPU materialized clone reliably.
  const ofun = vtkPiecewiseFunction.newInstance();
  ofun.addPoint(scalarRange[0], 0.9);
  ofun.addPoint(scalarRange[1], 0.9);
  property.setScalarOpacity(0, ofun);
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
      return imageVolume.voxelManager?.getScalarData();
    },
    scaling: imageVolume.scaling,
    hasPixelSpacing: imageVolume.hasPixelSpacing,
    voxelManager: imageVolume.voxelManager,
  };
}
