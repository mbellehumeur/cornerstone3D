import { Events, ViewportType } from '../../../enums';
import eventTarget from '../../../eventTarget';
import type { IImageVolume } from '../../../types';
import { VIEWPORT_PRESETS } from '../../../constants';
import uuidv4 from '../../../utilities/uuidv4';
import type {
  DataAddOptions,
  LoadedData,
  RenderPathAttachment,
  RenderPathDefinition,
  RenderPath,
} from '../ViewportArchitectureTypes';
import type {
  Volume3DCamera,
  Volume3DDataPresentation,
  Volume3DViewportRenderContext,
  Volume3DVolumePayload,
} from './viewport3DTypes';
import applyVolume3DCamera from './applyVolume3DCamera';
import { getInitialVolume3DCamera } from './vtkVolume3DInitialCamera';
import { getVolumeCenterWorld } from './mviewVolume3DCamera';
import setVtkCameraClippingRange from '../setVtkCameraClippingRange';
import { setWebGPUViewportCanvasVisible } from '../Planar/webgpuViewportRenderWindow';
import { getWebGPUViewportWindow } from '../Planar/webgpuViewportRenderWindow';
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
import type { WasmVtkVolumeBrickPlan } from '../../helpers/volumeTextureBrickWasm';
import {
  applyVtkWasmVolume3DPreset,
  applyViewportPresetToVtkWasmProperty,
  flushVtkWasmVolume3DPendingPreset,
  registerVtkWasmVolume3D,
  unregisterVtkWasmVolume3D,
  setVtkWasmVolume3DCanvasVisible,
} from './vtkWasmVolume3DRegistry';

export const VTK_WASM_VOLUME_3D_RENDER_MODE = 'vtkWasmVolume3d';
const DEFAULT_VTK_WASM_PRESET_NAME = 'CT-Bone';

type Volume3DVtkWasmRendering = {
  renderMode: typeof VTK_WASM_VOLUME_3D_RENDER_MODE;
  actorEntryUID: string;
  imageVolume: IImageVolume;
  brickPlan: WasmVtkVolumeBrickPlan;
  binding: VtkWasmVolumeBinding;
  removeStreamingSubscriptions?: () => void;
};

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

/**
 * Volume3D DVR path using vtk.wasm WebGL + mapper.SetPartitions from
 * volumeTextureBrickWasm (VTK XYZ bricks, not CS3D Z-slabs).
 * @internal
 */
export class VtkWasmVolume3DRenderPath
  implements RenderPath<Volume3DViewportRenderContext>
{
  private handle?: VtkWasmViewportHandle;
  private renderWindow?: VtkWasmObject;
  private wasmRenderer?: VtkWasmObject;
  private volumeMapper?: VtkWasmObject;
  private volume?: VtkWasmObject;
  private binding?: VtkWasmVolumeBinding;

  async addData(
    ctx: Volume3DViewportRenderContext,
    data: LoadedData,
    _options: DataAddOptions
  ): Promise<RenderPathAttachment<Volume3DDataPresentation>> {
    const payload = data as unknown as LoadedData<Volume3DVolumePayload>;
    const imageVolume = payload.imageVolume;

    const handle = await createVtkWasmViewportHandle(
      ctx.viewport.element,
      'vtk-wasm-volume3d-canvas'
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
      !vtk.vtkGPUVolumeRayCastMapper ||
      !vtk.vtkVolume ||
      !vtk.vtkVolumeProperty
    ) {
      handle.dispose();
      throw new Error('[vtkWasm] GPU volume classes missing from wasm bundle');
    }

    const binding = bindVtkWasmVolume(
      vtk,
      imageVolume,
      handle.session.typedArrayInterface
    );
    this.binding = binding;
    // Single-shot upload: only marshal when the volume is already complete.
    // Progressive per-slice full re-uploads OOM the wasm heap on bricked CTs.
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
    const renderer = vtk.vtkRenderer({
      background: [0, 0, 0],
    }) as VtkWasmObject;
    const mapper = vtk.vtkGPUVolumeRayCastMapper() as VtkWasmObject;
    const volume = vtk.vtkVolume() as VtkWasmObject;
    const property = vtk.vtkVolumeProperty() as VtkWasmObject;

    const defaultPreset = VIEWPORT_PRESETS.find(
      (entry) => entry.name === DEFAULT_VTK_WASM_PRESET_NAME
    );
    if (defaultPreset) {
      await applyViewportPresetToVtkWasmProperty(vtk, property, defaultPreset);
    }

    await invoke(renderWindow, 'addRenderer', renderer);
    await invoke(mapper, 'setInputData', binding.imageData);
    await binding.applyPartitions(mapper);
    await invoke(volume, 'setMapper', mapper);
    await invoke(volume, 'setProperty', property);
    await invoke(renderer, 'addVolume', volume);

    this.renderWindow = renderWindow;
    this.wasmRenderer = renderer;
    this.volumeMapper = mapper;
    this.volume = volume;

    registerVtkWasmVolume3D(ctx.viewportId, {
      canvas: handle.canvas,
      brickPlan: binding.brickPlan,
      vtk,
      volumeProperty: property,
      volumeCenter: getVolumeCenterWorld(
        imageVolume.imageData ?? {
          getOrigin: () => imageVolume.origin,
          getDimensions: () => imageVolume.dimensions,
          getSpacing: () => imageVolume.spacing,
        }
      ) as [number, number, number] | undefined,
      requestRender: () => {
        void this.renderAsync();
      },
    });
    // HP may have applied a preset before registration completed.
    flushVtkWasmVolume3DPendingPreset(ctx.viewportId);

    const webgpuWindow = getWebGPUViewportWindow(ctx.viewportId);
    if (webgpuWindow) {
      setWebGPUViewportCanvasVisible(webgpuWindow, false);
    }

    ctx.display.activateRenderMode(VTK_WASM_VOLUME_3D_RENDER_MODE);
    handle.canvas.style.visibility = 'visible';

    const initialCamera = getInitialVolume3DCamera(ctx, imageVolume);
    if (initialCamera) {
      applyVolume3DCamera(ctx, initialCamera, { resetClippingRange: true });
      await this.applyCameraToWasm(initialCamera);
      const entry = getVtkWasmVolume3D(ctx.viewportId);
      if (entry && typeof initialCamera.parallelScale === 'number') {
        entry.baselineParallelScale = initialCamera.parallelScale;
      }
    } else {
      setVtkCameraClippingRange(ctx.vtk.renderer.getActiveCamera());
      ctx.vtk.renderer.resetCameraClippingRange();
      await invoke(renderer, 'resetCamera');
      await invoke(renderer, 'resetCameraClippingRange');
    }

    if (binding.hasScalars()) {
      await this.renderAsync();
    }

    const uploadAndPresent = () => {
      void binding.refreshScalars().then((ok) => {
        if (ok) {
          void this.renderAsync();
          ctx.display.requestRender();
        }
      });
    };

    const rendering: Volume3DVtkWasmRendering = {
      renderMode: VTK_WASM_VOLUME_3D_RENDER_MODE,
      actorEntryUID: uuidv4(),
      imageVolume,
      brickPlan: binding.brickPlan,
      binding,
      removeStreamingSubscriptions: subscribeToVolumeEvents(
        payload.volumeId,
        (eventType) => {
          // One full upload after load — no progressive re-marshals.
          if (eventType === Events.IMAGE_VOLUME_LOADING_COMPLETED) {
            uploadAndPresent();
          }
        }
      ),
    };

    imageVolume.load?.(() => {
      uploadAndPresent();
    });

    return {
      rendering,
      updateDataPresentation: () => {
        /* VOI/presets can be wired to vtkVolumeProperty in a follow-up */
      },
      applyViewState: (camera) => {
        this.applyViewState(ctx, camera as Volume3DCamera);
      },
      getFrameOfReferenceUID: () =>
        rendering.imageVolume.metadata?.FrameOfReferenceUID,
      getImageData: () => rendering.imageVolume as never,
      render: () => {
        void this.renderAsync();
      },
      resize: () => {
        void this.resizePresent(ctx);
      },
      removeData: () => {
        rendering.removeStreamingSubscriptions?.();
        unregisterVtkWasmVolume3D(ctx.viewportId);
        this.handle?.dispose();
        this.handle = undefined;
        this.renderWindow = undefined;
        this.wasmRenderer = undefined;
        this.volumeMapper = undefined;
        this.volume = undefined;
        this.binding = undefined;
      },
    };
  }

  private applyViewState(
    ctx: Volume3DViewportRenderContext,
    camera: Volume3DCamera
  ): void {
    // setViewState already wrote the vtk-js camera. Do not re-apply with
    // resetClippingRange here — the OpenGL renderer has no volume props, so
    // that reset produces a bogus clippingRange that then blanks the wasm
    // present when synced.
    void this.applyCameraToWasm(camera).then(() => this.renderAsync());
  }

  private async applyCameraToWasm(
    camera: Partial<Volume3DCamera>
  ): Promise<void> {
    const renderer = this.wasmRenderer;
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

    // Sync pose/projection only. Never copy CS clippingRange — on rotate,
    // getRuntimeCamera() reads the empty vtk-js scene's reset range and that
    // clips the wasm volume out of view.
    if (camera.parallelProjection !== undefined) {
      await invoke(
        cam,
        'setParallelProjection',
        camera.parallelProjection ? 1 : 0
      );
    }
    if (camera.viewUp) {
      await invoke(cam, 'setViewUp', ...camera.viewUp);
    }
    if (camera.focalPoint) {
      await invoke(cam, 'setFocalPoint', ...camera.focalPoint);
    }
    if (camera.position) {
      await invoke(cam, 'setPosition', ...camera.position);
    }
    if (camera.parallelScale !== undefined) {
      await invoke(cam, 'setParallelScale', camera.parallelScale);
    }
    if (camera.viewAngle !== undefined) {
      await invoke(cam, 'setViewAngle', camera.viewAngle);
    }

    cam.$set?.({
      ...(camera.parallelProjection !== undefined
        ? { parallelProjection: camera.parallelProjection ? 1 : 0 }
        : {}),
      ...(camera.viewUp ? { viewUp: camera.viewUp } : {}),
      ...(camera.focalPoint ? { focalPoint: camera.focalPoint } : {}),
      ...(camera.position ? { position: camera.position } : {}),
      ...(camera.parallelScale !== undefined
        ? { parallelScale: camera.parallelScale }
        : {}),
      ...(camera.viewAngle !== undefined
        ? { viewAngle: camera.viewAngle }
        : {}),
    });

    await invoke(renderer, 'resetCameraClippingRange');
  }

  private async renderAsync(): Promise<void> {
    // Avoid VTK "No scalars named "" or with id -1" spam while streaming /
    // after a failed realloc on bricked volumes.
    if (!this.binding?.hasScalars()) {
      return;
    }
    await invoke(this.renderWindow, 'render');
  }
}

/** @internal */
export class VtkWasmVolume3DPath
  implements
    RenderPathDefinition<
      Volume3DViewportRenderContext,
      Volume3DViewportRenderContext
    >
{
  readonly id = 'volume3d:vtk-wasm-volume';
  readonly type = ViewportType.VOLUME_3D_NEXT;

  matches(data: LoadedData, options: DataAddOptions): boolean {
    return (
      data.type === 'image' &&
      options.renderMode === VTK_WASM_VOLUME_3D_RENDER_MODE
    );
  }

  createRenderPath() {
    return new VtkWasmVolume3DRenderPath();
  }

  selectContext(rootContext: Volume3DViewportRenderContext) {
    return rootContext;
  }
}

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

// re-export for callers that hide canvas
export { setVtkWasmVolume3DCanvasVisible };
