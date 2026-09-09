import { Events, ViewportType } from '../../../enums';
import eventTarget from '../../../eventTarget';
import type { IImageVolume } from '../../../types';
import { VIEWPORT_PRESETS } from '../../../constants';
import clonePoint3 from '../../../utilities/clonePoint3';
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
  type VtkWasmRenderingBackend,
  type VtkWasmViewportHandle,
} from '../vtkWasmRuntime';
import {
  createVtkWasmVolumeBinding,
  type VtkWasmVolumeBinding,
} from '../vtkWasmVolumeBinding';
import { setVtkWasmImageDataExtent } from '../vtkWasmImageDataFinalize';
import {
  readWasmBrickPartitionOptionsForPath,
  type WasmVtkVolumeBrickPlan,
} from '../../helpers/volumeTextureBrickWasm';
import {
  applyViewportPresetToVtkWasmProperty,
  flushVtkWasmVolume3DPendingPreset,
  getVtkWasmVolume3D,
  registerVtkWasmVolume3D,
  unregisterVtkWasmVolume3D,
  setVtkWasmVolume3DCanvasVisible,
} from './vtkWasmVolume3DRegistry';

export const VTK_WASM_VOLUME_3D_RENDER_MODE = 'vtkWasmVolume3d';
export const VTK_WASM_WEBGPU_VOLUME_3D_RENDER_MODE = 'vtkWasmWebgpuVolume3d';

export type VtkWasmVolume3DRenderModeId =
  | typeof VTK_WASM_VOLUME_3D_RENDER_MODE
  | typeof VTK_WASM_WEBGPU_VOLUME_3D_RENDER_MODE;

export function isVtkWasmVolume3DRenderMode(
  renderMode: unknown
): renderMode is VtkWasmVolume3DRenderModeId {
  return (
    renderMode === VTK_WASM_VOLUME_3D_RENDER_MODE ||
    renderMode === VTK_WASM_WEBGPU_VOLUME_3D_RENDER_MODE
  );
}

const DEFAULT_VTK_WASM_PRESET_NAME = 'CT-Bone';

type Volume3DVtkWasmRendering = {
  renderMode: VtkWasmVolume3DRenderModeId;
  actorEntryUID: string;
  imageVolume: IImageVolume;
  brickPlan: WasmVtkVolumeBrickPlan;
  binding: VtkWasmVolumeBinding;
  removeStreamingSubscriptions?: () => void;
};

type VtkWasmVolume3DRenderPathOptions = {
  rendering: VtkWasmRenderingBackend;
  renderMode: VtkWasmVolume3DRenderModeId;
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
 * Volume3D DVR path using vtk.wasm (WebGL or WebGPU). Large volumes use a
 * dense per-brick MultiBlock pool; small volumes use a single ImageData +
 * mapper.SetPartitions from volumeTextureBrickWasm.
 * @internal
 */
export class VtkWasmVolume3DRenderPath
  implements RenderPath<Volume3DViewportRenderContext>
{
  private readonly renderingBackend: VtkWasmRenderingBackend;
  private readonly renderMode: VtkWasmVolume3DRenderModeId;
  private handle?: VtkWasmViewportHandle;
  private renderWindow?: VtkWasmObject;
  private wasmRenderer?: VtkWasmObject;
  private volumeMapper?: VtkWasmObject;
  private volume?: VtkWasmObject;
  /** Dense-brick Volume3D: one mapper+volume per brick. */
  private brickMappers: VtkWasmObject[] = [];
  private brickVolumes: VtkWasmObject[] = [];
  private volumeProperty?: VtkWasmObject;
  /** True after brick actors have been wired once for this binding. */
  private brickVolumesSynced = false;
  private binding?: VtkWasmVolumeBinding;
  private imageVolume?: IImageVolume;
  private sampleDistance = 1;
  private opacityUnitDistance = 1;

  private volumeAddedToRenderer = false;

  constructor(options?: Partial<VtkWasmVolume3DRenderPathOptions>) {
    this.renderingBackend = options?.rendering ?? 'webgl';
    this.renderMode = options?.renderMode ?? VTK_WASM_VOLUME_3D_RENDER_MODE;
  }

  async addData(
    ctx: Volume3DViewportRenderContext,
    data: LoadedData,
    _options: DataAddOptions
  ): Promise<RenderPathAttachment<Volume3DDataPresentation>> {
    const payload = data as unknown as LoadedData<Volume3DVolumePayload>;
    const imageVolume = payload.imageVolume;

    const handle = await createVtkWasmViewportHandle(
      ctx.viewport.element,
      'vtk-wasm-volume3d-canvas',
      { rendering: this.renderingBackend }
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

    const binding = createVtkWasmVolumeBinding(
      vtk,
      imageVolume,
      handle.session.typedArrayInterface,
      {
        brickPartitionOptions: readWasmBrickPartitionOptionsForPath('volume3d'),
      }
    );
    this.binding = binding;
    this.imageVolume = imageVolume;
    // Single-shot upload: only marshal when the volume is already complete.
    // Progressive per-slice full re-uploads OOM the wasm heap on bricked CTs.
    const alreadyLoaded = Boolean(
      (imageVolume as { loadStatus?: { loaded?: boolean } }).loadStatus?.loaded
    );
    let scalarsReady = false;
    if (alreadyLoaded) {
      scalarsReady = await binding.refreshScalars();
    }

    const renderWindow = vtk.vtkRenderWindow({
      canvasSelector: handle.canvasKey,
      size: [canvasW, canvasH],
    }) as VtkWasmObject;
    await syncVtkWasmRenderWindowSize(renderWindow, canvasW, canvasH);
    const renderer = vtk.vtkRenderer({
      background: [0, 0, 0],
    }) as VtkWasmObject;

    const property = vtk.vtkVolumeProperty() as VtkWasmObject;
    this.volumeProperty = property;

    const defaultPreset = VIEWPORT_PRESETS.find(
      (entry) => entry.name === DEFAULT_VTK_WASM_PRESET_NAME
    );
    if (defaultPreset) {
      await applyViewportPresetToVtkWasmProperty(vtk, property, defaultPreset);
    }
    await invoke(property, 'setDisableGradientOpacity', 0, 1);

    await invoke(renderWindow, 'addRenderer', renderer);

    // Prove GL presents before volume scalars arrive.
    // No vtkRenderWindowInteractor: Cornerstone owns input (canvas is
    // pointer-events:none) and we present via renderAsync(). Starting the
    // wasm event loop left a rAF tick that crashed on canvas detach.
    await invoke(renderer, 'resetCamera');
    await invoke(renderWindow, 'render');

    const spacing = imageVolume.spacing as [number, number, number];
    this.sampleDistance =
      (Math.abs(spacing[0]) + Math.abs(spacing[1]) + Math.abs(spacing[2])) /
        6 || 1;
    this.opacityUnitDistance =
      (Math.abs(spacing[0]) + Math.abs(spacing[1]) + Math.abs(spacing[2])) /
        3 || 1;
    await invoke(
      property,
      'setScalarOpacityUnitDistance',
      0,
      this.opacityUnitDistance
    );

    const useMultiBlock =
      binding.useMultiBlockInput === true && !!binding.multiBlock;
    const useMultiVolume =
      !useMultiBlock &&
      binding.useMultiVolumeInput === true &&
      typeof binding.getBrickImageDatas === 'function';

    if (useMultiBlock) {
      const mapper = vtk.vtkMultiBlockVolumeMapper!() as VtkWasmObject;
      const volume = vtk.vtkVolume() as VtkWasmObject;
      // MultiBlockVolumeMapper has no SetSampleDistance (GPU ray-cast only).
      await invoke(mapper, 'setScalarModeToUsePointData');
      await invoke(mapper, 'setArrayName', 'Scalars');
      await invoke(volume, 'setMapper', mapper);
      await invoke(volume, 'setProperty', property);
      this.volumeMapper = mapper;
      this.volume = volume;
      if (scalarsReady) {
        await this.wireMultiBlockVolumeInput(binding, renderer, property);
      }
    } else if (useMultiVolume) {
      // Never setInputData(binding.imageData) here — that is the MPR stub/slab.
      if (scalarsReady) {
        const ok = await this.syncBrickVolumes(
          vtk,
          renderer,
          binding,
          property
        );
        if (!ok) {
          console.warn(
            '[vtkWasm] dense Volume3D: no brick ImageData after refresh; skipping present'
          );
        }
      }
    } else {
      // Create mapper/volume now; only addVolume after scalars exist — otherwise
      // an early render hits empty ImageData → "No scalars named """.
      const mapper = vtk.vtkGPUVolumeRayCastMapper!() as VtkWasmObject;
      const volume = vtk.vtkVolume() as VtkWasmObject;
      await invoke(mapper, 'setSampleDistance', this.sampleDistance);
      await invoke(mapper, 'setAutoAdjustSampleDistances', 0);
      await invoke(mapper, 'setScalarModeToUsePointData');
      await invoke(mapper, 'setArrayName', 'Scalars');
      await invoke(volume, 'setMapper', mapper);
      await invoke(volume, 'setProperty', property);
      this.volumeMapper = mapper;
      this.volume = volume;
      if (scalarsReady) {
        await this.wireSingleVolumeInput(binding, renderer, property);
      }
    }

    this.renderWindow = renderWindow;
    this.wasmRenderer = renderer;

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
    flushVtkWasmVolume3DPendingPreset(ctx.viewportId);
    await invoke(property, 'setDisableGradientOpacity', 0, 1);

    const webgpuWindow = getWebGPUViewportWindow(ctx.viewportId);
    if (webgpuWindow) {
      setWebGPUViewportCanvasVisible(webgpuWindow, false);
    }

    ctx.display.activateRenderMode(this.renderMode);
    handle.canvas.style.display = 'block';
    handle.canvas.style.visibility = 'visible';
    handle.canvas.style.zIndex = '20';
    handle.canvas.style.pointerEvents = 'none';
    handle.canvas.style.backgroundColor = 'transparent';
    console.info(
      `[vtkWasm] Volume3D canvas mounted ` +
        `key=${handle.canvasKey} ` +
        `bitmap=${handle.canvas.width}x${handle.canvas.height} ` +
        `client=${handle.canvas.clientWidth}x${handle.canvas.clientHeight} ` +
        `parent=${ctx.viewport.element.clientWidth}x${ctx.viewport.element.clientHeight} ` +
        `inDom=${document.body.contains(handle.canvas)} ` +
        `display=${handle.canvas.style.display} z=${handle.canvas.style.zIndex}`
    );

    const initialCamera = getInitialVolume3DCamera(ctx, imageVolume);
    if (initialCamera) {
      // Align focal with trackball volumeCenter (AABB). getInitialVolume3DCamera
      // uses getVolumeCenterIJK which can drift on tall / oblique volumes — that
      // only breaks rotation (orbit about volumeCenter), not pan/zoom.
      const entry = getVtkWasmVolume3D(ctx.viewportId);
      const center = entry?.volumeCenter;
      if (
        center &&
        initialCamera.position &&
        initialCamera.focalPoint &&
        initialCamera.viewPlaneNormal
      ) {
        const pos = initialCamera.position;
        const focal = initialCamera.focalPoint;
        const vpn = initialCamera.viewPlaneNormal;
        const distance = Math.hypot(
          pos[0] - focal[0],
          pos[1] - focal[1],
          pos[2] - focal[2]
        );
        const len = Math.hypot(vpn[0], vpn[1], vpn[2]) || 1;
        initialCamera.focalPoint = [...center] as [
          number,
          number,
          number,
        ];
        initialCamera.position = [
          center[0] + (vpn[0] / len) * distance,
          center[1] + (vpn[1] / len) * distance,
          center[2] + (vpn[2] / len) * distance,
        ];
      }
      applyVolume3DCamera(ctx, initialCamera, { resetClippingRange: true });
      await this.applyCameraToWasm(initialCamera);
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
      void binding
        .refreshScalars(undefined, { force: true })
        .then(async (ok) => {
          if (!ok || !this.wasmRenderer || !this.handle) {
            const brickStatus = binding.getBrickUploadStatus?.();
            if (brickStatus && brickStatus.total > 1) {
              console.warn(
                `[vtkWasm] Volume3D present skipped: bricksUploaded=${brickStatus.uploaded}/${brickStatus.total}`
              );
            }
            return;
          }
          const brickStatus = binding.getBrickUploadStatus?.() ?? {
            uploaded: binding.getBrickImageDatas?.()?.length ?? 0,
            total: binding.brickPlan.bricks.length,
          };
          if (
            (binding.useMultiBlockInput || binding.useMultiVolumeInput) &&
            brickStatus.uploaded < brickStatus.total
          ) {
            console.warn(
              `[vtkWasm] Volume3D present skipped: bricksUploaded=${brickStatus.uploaded}/${brickStatus.total}`
            );
            return;
          }
          if (binding.useMultiBlockInput && binding.multiBlock) {
            if (!this.volumeMapper || !this.volume) {
              const mapper = this.handle.vtk
                .vtkMultiBlockVolumeMapper!() as VtkWasmObject;
              const volume = this.handle.vtk.vtkVolume!() as VtkWasmObject;
              this.volumeMapper = mapper;
              this.volume = volume;
              await invoke(volume, 'setMapper', mapper);
              await invoke(
                volume,
                'setProperty',
                this.volumeProperty ?? property
              );
            }
            await this.wireMultiBlockVolumeInput(
              binding,
              this.wasmRenderer,
              this.volumeProperty ?? property
            );
          } else if (binding.useMultiVolumeInput) {
            // New brick ImageData instances — must rebind, not early-out on count.
            this.brickVolumesSynced = false;
            const synced = await this.syncBrickVolumes(
              this.handle.vtk,
              this.wasmRenderer,
              binding,
              this.volumeProperty ?? property
            );
            if (!synced) {
              console.warn(
                '[vtkWasm] dense Volume3D upload produced no brick ImageData'
              );
              return;
            }
          } else if (this.volumeMapper && this.volume) {
            await this.wireSingleVolumeInput(
              binding,
              this.wasmRenderer,
              this.volumeProperty ?? property
            );
          }
          if (this.volumeProperty) {
            await invoke(
              this.volumeProperty,
              'setDisableGradientOpacity',
              0,
              1
            );
          }
          // Multi-brick: keep wasm aligned with vtk-js (TrackballRotate authority).
          // frameCameraToImageVolume on wasm-only desyncs → ~90° on first drag.
          if (this.wasmRenderer) {
            if (
              binding.useMultiBlockInput === true ||
              binding.useMultiVolumeInput === true
            ) {
              // CS bounds clipping once — not resetCameraClippingRange (MultiBlock
              // prop bounds) and not per-drag updates (orbit wobble / first-drag snap).
              await this.syncWasmCameraFromVtkJs(ctx, imageVolume, {
                applyBoundsClipping: true,
              });
            } else {
              await this.frameCameraToImageVolume(imageVolume, {
                applyBoundsClipping: true,
              });
            }
          }
          if (this.handle?.canvas) {
            this.handle.canvas.style.display = 'block';
            this.handle.canvas.style.visibility = 'visible';
            this.handle.canvas.style.pointerEvents = 'none';
            this.handle.canvas.style.backgroundColor = 'transparent';
          }
          ctx.display.activateRenderMode(this.renderMode);
          const canvas = this.handle?.canvas;
          console.info(
            `[vtkWasm] Volume3D present ok mode=${binding.mode ?? 'single'} ` +
              `hasScalars=${binding.hasScalars()} ` +
              `bricksUploaded=${brickStatus.uploaded}/${brickStatus.total} ` +
              `volumeAdded=${this.volumeAddedToRenderer} ` +
              `partitions=${binding.brickPlan.vtkPartitions.join('x')} ` +
              `useMultiBlock=${binding.useMultiBlockInput === true} ` +
              `useMultiVolume=${binding.useMultiVolumeInput === true} ` +
              `canvas=${canvas?.width ?? 0}x${canvas?.height ?? 0}`
          );
          await this.renderAsync();
          await this.renderAsync();
          ctx.display.requestRender();
        });
    };

    const rendering: Volume3DVtkWasmRendering = {
      renderMode: this.renderMode,
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
        rendering.binding.dispose?.();
        unregisterVtkWasmVolume3D(ctx.viewportId);
        this.clearBrickVolumes();
        this.handle?.dispose();
        this.handle = undefined;
        this.renderWindow = undefined;
        this.wasmRenderer = undefined;
        this.volumeMapper = undefined;
        this.volume = undefined;
        this.volumeProperty = undefined;
        this.binding = undefined;
        this.imageVolume = undefined;
        this.volumeAddedToRenderer = false;
      },
    };
  }

  /**
   * Dense multi-brick: one vtkMultiBlockVolumeMapper + vtkVolume over the
   * binding's vtkMultiBlockDataSet (seamless composite vs N actors).
   */
  private async wireMultiBlockVolumeInput(
    binding: VtkWasmVolumeBinding,
    renderer: VtkWasmObject,
    property: VtkWasmObject
  ): Promise<void> {
    if (
      !this.volumeMapper ||
      !this.volume ||
      !binding.multiBlock ||
      !binding.hasScalars()
    ) {
      return;
    }

    const mb = binding.multiBlock;
    // SetInputData is typed to ImageData only — use SetInputDataObject.
    let bound = false;
    try {
      const setInputDataObject = this.volumeMapper.setInputDataObject as
        | ((port: number, data: VtkWasmObject) => unknown)
        | undefined;
      if (typeof setInputDataObject === 'function') {
        await invoke(this.volumeMapper, 'setInputDataObject', 0, mb);
        bound = true;
      }
    } catch {
      bound = false;
    }
    if (!bound) {
      try {
        await invoke(this.volumeMapper, 'setInputData', mb);
        bound = true;
      } catch (error) {
        console.warn('[vtkWasm] MultiBlockVolumeMapper setInput failed', error);
        return;
      }
    }

    await invoke(this.volumeMapper, 'setScalarModeToUsePointData');
    await invoke(this.volumeMapper, 'setArrayName', 'Scalars');
    // No setSampleDistance — not on vtkMultiBlockVolumeMapper.
    await invoke(this.volume, 'setMapper', this.volumeMapper);
    await invoke(this.volume, 'setProperty', property);
    await invoke(this.volume, 'setVisibility', 1);
    await invoke(this.volumeMapper, 'modified');
    await invoke(this.volume, 'modified');

    if (!this.volumeAddedToRenderer) {
      await invoke(renderer, 'addVolume', this.volume);
      await invoke(renderer, 'addViewProp', this.volume);
      this.volumeAddedToRenderer = true;
      console.info('[vtkWasm] Volume3D addVolume ok (MultiBlock)');
    }
  }

  /**
   * Bind scalar-backed ImageData to the single-volume mapper and add to the
   * renderer once. Safe to call repeatedly after refreshScalars.
   */
  private async wireSingleVolumeInput(
    binding: VtkWasmVolumeBinding,
    renderer: VtkWasmObject,
    property: VtkWasmObject
  ): Promise<void> {
    if (!this.volumeMapper || !this.volume || !binding.hasScalars()) {
      return;
    }
    const input = binding.getBrickImageDatas?.()?.[0] ?? binding.imageData;

    // If finalize left dims empty, re-setExtent(array) only — never
    // $set({ dimensions }) after Int16 attach (float AllocateScalars →
    // texImage3D bpp mismatch under SetPartitions).
    let dims = await invoke(input, 'getDimensions');
    const dim0 = Array.isArray(dims) ? Number(dims[0]) : 0;
    if (!dim0 && binding.brickPlan?.dimensions) {
      const [dx, dy, dz] = binding.brickPlan.dimensions;
      const extent = [0, dx - 1, 0, dy - 1, 0, dz - 1];
      console.warn(
        `[vtkWasm] Volume3D forcing ImageData extent=${extent.join(',')} before setInputData`
      );
      await setVtkWasmImageDataExtent(input, extent);
      await invoke(input, 'modified');
      dims = await invoke(input, 'getDimensions');
    }
    const spacing = await invoke(input, 'getSpacing');
    const origin = await invoke(input, 'getOrigin');
    const bounds = await invoke(input, 'getBounds');
    console.info(
      `[vtkWasm] Volume3D ImageData geom dims=${JSON.stringify(dims)} ` +
        `spacing=${JSON.stringify(spacing)} origin=${JSON.stringify(origin)} ` +
        `bounds=${JSON.stringify(bounds)}`
    );

    await invoke(this.volumeMapper, 'setInputData', input);
    await invoke(this.volumeMapper, 'setScalarModeToUsePointData');
    await invoke(this.volumeMapper, 'setArrayName', 'Scalars');
    const parts = binding.brickPlan?.vtkPartitions ?? [1, 1, 1];
    const needsPartitions = parts.some((n) => n > 1);
    if (binding.mode !== 'denseBricks' && needsPartitions) {
      // applyPartitions verifies Int16 size/type before SetPartitions.
      await binding.applyPartitions(this.volumeMapper);
    }
    // Slightly larger than spacing/6 — avoids undersampling to black on some GPUs.
    const sd = Math.max(this.sampleDistance, 0.5);
    await invoke(this.volumeMapper, 'setSampleDistance', sd);
    await invoke(this.volumeMapper, 'setAutoAdjustSampleDistances', 0);
    await invoke(this.volume, 'setMapper', this.volumeMapper);
    await invoke(this.volume, 'setProperty', property);
    await invoke(this.volume, 'setVisibility', 1);
    await invoke(this.volumeMapper, 'modified');
    await invoke(this.volume, 'modified');
    if (!this.volumeAddedToRenderer) {
      await invoke(renderer, 'addVolume', this.volume);
      // Some wasm builds route volumes through view-prop list only.
      await invoke(renderer, 'addViewProp', this.volume);
      this.volumeAddedToRenderer = true;
      console.info(`[vtkWasm] Volume3D addVolume ok sampleDistance=${sd}`);
    }
  }

  private buildFramedCameraFromImageVolume(
    imageVolume: IImageVolume
  ): Partial<Volume3DCamera> | undefined {
    const vtkImage = imageVolume.imageData as
      | { getBounds?: () => number[] }
      | undefined;
    const bounds = vtkImage?.getBounds?.();
    if (!bounds || bounds.length < 6) {
      return undefined;
    }

    const cx = (bounds[0] + bounds[1]) * 0.5;
    const cy = (bounds[2] + bounds[3]) * 0.5;
    const cz = (bounds[4] + bounds[5]) * 0.5;
    const dx = Math.max(1e-3, bounds[1] - bounds[0]);
    const dy = Math.max(1e-3, bounds[3] - bounds[2]);
    const dz = Math.max(1e-3, bounds[5] - bounds[4]);
    const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
    const parallelScale = Math.max(dy, dz) * 0.55;
    const distance = radius * 2.5;

    return {
      parallelProjection: true,
      focalPoint: [cx, cy, cz],
      // View along -Y (approx coronal) — stable default for CT.
      position: [cx, cy - distance, cz],
      viewUp: [0, 0, 1],
      parallelScale,
    };
  }

  /**
   * Position the wasm camera from Cornerstone ImageData bounds (not wasm
   * proxy bounds, which may be unset after scalar finalize). Single-brick only.
   */
  private async frameCameraToImageVolume(
    imageVolume: IImageVolume,
    options: { applyBoundsClipping?: boolean } = {}
  ): Promise<void> {
    const renderer = this.wasmRenderer;
    if (!renderer) {
      return;
    }

    const framed = this.buildFramedCameraFromImageVolume(imageVolume);
    if (!framed) {
      await invoke(renderer, 'resetCamera');
      await invoke(renderer, 'resetCameraClippingRange');
      return;
    }

    await this.applyCameraToWasm(framed, options);
    const focal = framed.focalPoint;
    console.info(
      `[vtkWasm] Volume3D camera frame center=[${focal?.[0]?.toFixed(1)},${focal?.[1]?.toFixed(1)},${focal?.[2]?.toFixed(1)}] ` +
        `parallelScale=${framed.parallelScale?.toFixed(1)}`
    );
  }

  private readVtkJsCameraPose(
    ctx: Volume3DViewportRenderContext
  ): Partial<Volume3DCamera> | undefined {
    const vtkCam = ctx.vtk.renderer.getActiveCamera();
    const position = vtkCam.getPosition?.() as Volume3DCamera['position'];
    const focalPoint = vtkCam.getFocalPoint?.() as Volume3DCamera['focalPoint'];
    if (!position || !focalPoint) {
      return undefined;
    }
    return {
      position,
      focalPoint,
      viewUp: vtkCam.getViewUp?.() as Volume3DCamera['viewUp'],
      parallelScale: vtkCam.getParallelScale?.(),
      parallelProjection: vtkCam.getParallelProjection?.(),
      viewAngle: vtkCam.getViewAngle?.(),
    };
  }

  private async syncWasmCameraFromVtkJs(
    ctx: Volume3DViewportRenderContext,
    imageVolume: IImageVolume,
    options: { applyBoundsClipping?: boolean } = {}
  ): Promise<void> {
    const pose = this.readVtkJsCameraPose(ctx);
    if (pose) {
      await this.applyCameraToWasm(pose, options);
      return;
    }
    const framed = this.buildFramedCameraFromImageVolume(imageVolume);
    if (!framed) {
      return;
    }
    applyVolume3DCamera(ctx, framed, { resetClippingRange: true });
    await this.applyCameraToWasm(framed, { applyBoundsClipping: true });
  }

  /**
   * Clip from full CS volume bounds projected on the current view axis (not
   * MultiBlock prop bounds). Use at present/resize only — not on every drag.
   */
  private async applyVolumeBoundsClippingRange(
    cam: VtkWasmObject,
    position: [number, number, number],
    focalPoint: [number, number, number]
  ): Promise<void> {
    const renderer = this.wasmRenderer;
    const bounds = this.imageVolume?.imageData?.getBounds?.();
    if (!bounds || bounds.length < 6) {
      if (renderer) {
        await invoke(renderer, 'resetCameraClippingRange');
      }
      return;
    }

    const viewDir = [
      focalPoint[0] - position[0],
      focalPoint[1] - position[1],
      focalPoint[2] - position[2],
    ];
    const viewLen = Math.hypot(viewDir[0], viewDir[1], viewDir[2]) || 1;
    viewDir[0] /= viewLen;
    viewDir[1] /= viewLen;
    viewDir[2] /= viewLen;

    const corners: [number, number, number][] = [
      [bounds[0], bounds[2], bounds[4]],
      [bounds[0], bounds[2], bounds[5]],
      [bounds[0], bounds[3], bounds[4]],
      [bounds[0], bounds[3], bounds[5]],
      [bounds[1], bounds[2], bounds[4]],
      [bounds[1], bounds[2], bounds[5]],
      [bounds[1], bounds[3], bounds[4]],
      [bounds[1], bounds[3], bounds[5]],
    ];
    let minDist = Infinity;
    let maxDist = -Infinity;
    for (const corner of corners) {
      const d =
        (corner[0] - position[0]) * viewDir[0] +
        (corner[1] - position[1]) * viewDir[1] +
        (corner[2] - position[2]) * viewDir[2];
      minDist = Math.min(minDist, d);
      maxDist = Math.max(maxDist, d);
    }

    const span = maxDist - minDist;
    const margin = Math.max(span * 0.1, 1);
    const near = Math.max(0.1, minDist - margin);
    const far = maxDist + margin;
    await invoke(cam, 'setClippingRange', near, far);
    cam.$set?.({ clippingRange: [near, far] });
  }

  private async applyBoundsClippingFromCamera(
    cam: VtkWasmObject,
    camera: Partial<Volume3DCamera>
  ): Promise<void> {
    const position = camera.position;
    const focal = camera.focalPoint;
    if (
      position &&
      position.length >= 3 &&
      focal &&
      focal.length >= 3
    ) {
      await this.applyVolumeBoundsClippingRange(
        cam,
        clonePoint3(position),
        clonePoint3(focal)
      );
      return;
    }
    const renderer = this.wasmRenderer;
    if (renderer) {
      await invoke(renderer, 'resetCameraClippingRange');
    }
  }

  private clearBrickVolumes(): void {
    for (const vol of this.brickVolumes) {
      try {
        vol.$delete?.();
      } catch {
        // ignore
      }
    }
    for (const mapper of this.brickMappers) {
      try {
        mapper.$delete?.();
      } catch {
        // ignore
      }
    }
    this.brickVolumes = [];
    this.brickMappers = [];
    this.brickVolumesSynced = false;
  }

  /**
   * One vtkGPUVolumeRayCastMapper + vtkVolume per dense brick (shared property).
   * Rebinds setInputData when brick ImageData instances are replaced after upload.
   * @returns false when no brick ImageData is available yet
   */
  private async syncBrickVolumes(
    vtk: VtkWasmViewportHandle['vtk'],
    renderer: VtkWasmObject,
    binding: VtkWasmVolumeBinding,
    property: VtkWasmObject
  ): Promise<boolean> {
    const images = binding.getBrickImageDatas?.() ?? [];
    if (!images.length || !vtk.vtkGPUVolumeRayCastMapper || !vtk.vtkVolume) {
      return false;
    }

    // Same actor count: rebind inputs (refresh replaces ImageData objects).
    if (
      this.brickVolumesSynced &&
      this.brickVolumes.length === images.length &&
      this.brickMappers.length === images.length
    ) {
      for (let i = 0; i < images.length; i++) {
        await invoke(this.brickMappers[i], 'setInputData', images[i]);
        await invoke(this.brickMappers[i], 'modified');
        await invoke(this.brickVolumes[i], 'modified');
      }
      return true;
    }

    for (const vol of this.brickVolumes) {
      await invoke(renderer, 'removeVolume', vol);
    }
    this.clearBrickVolumes();

    for (const imageData of images) {
      const mapper = vtk.vtkGPUVolumeRayCastMapper() as VtkWasmObject;
      const volume = vtk.vtkVolume() as VtkWasmObject;
      await invoke(mapper, 'setInputData', imageData);
      await invoke(mapper, 'setScalarModeToUsePointData');
      await invoke(mapper, 'setArrayName', 'Scalars');
      const sd = Math.max(this.sampleDistance, 0.5);
      await invoke(mapper, 'setSampleDistance', sd);
      await invoke(mapper, 'setAutoAdjustSampleDistances', 0);
      await invoke(volume, 'setMapper', mapper);
      await invoke(volume, 'setProperty', property);
      await invoke(renderer, 'addVolume', volume);
      this.brickMappers.push(mapper);
      this.brickVolumes.push(volume);
    }
    this.brickVolumesSynced = true;
    return true;
  }

  private applyViewState(
    _ctx: Volume3DViewportRenderContext,
    camera: Volume3DCamera
  ): void {
    // setViewState already wrote the vtk-js camera. Pose-only sync on rotate;
    // clipping is set at present/resize (MultiBlock resetCameraClippingRange
    // and per-drag bounds clipping both caused large-series orbit issues).
    void (async () => {
      await this.applyCameraToWasm(camera);
      await this.renderAsync();
    })();
  }

  private async applyCameraToWasm(
    camera: Partial<Volume3DCamera>,
    options: { applyBoundsClipping?: boolean } = {}
  ): Promise<VtkWasmObject | undefined> {
    const renderer = this.wasmRenderer;
    if (!renderer) {
      return undefined;
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
      return undefined;
    }

    // Match MPR wasm: Volume3D is parallel projection.
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
    if (camera.parallelScale !== undefined) {
      await invoke(cam, 'setParallelScale', camera.parallelScale);
    }
    if (camera.viewAngle !== undefined) {
      await invoke(cam, 'setViewAngle', camera.viewAngle);
    }

    // Plain arrays only: TypedArrays JSON-serialize as objects and fail
    // vtk-wasm DeserializeJSON (type must be array).
    cam.$set?.({
      parallelProjection: camera.parallelProjection === false ? 0 : 1,
      ...(camera.viewUp ? { viewUp: clonePoint3(camera.viewUp) } : {}),
      ...(camera.focalPoint
        ? { focalPoint: clonePoint3(camera.focalPoint) }
        : {}),
      ...(camera.position ? { position: clonePoint3(camera.position) } : {}),
      ...(camera.parallelScale !== undefined
        ? { parallelScale: camera.parallelScale }
        : {}),
      ...(camera.viewAngle !== undefined
        ? { viewAngle: camera.viewAngle }
        : {}),
    });

    if (options.applyBoundsClipping) {
      await this.applyBoundsClippingFromCamera(cam, camera);
    }
    return cam;
  }

  private async resizePresent(
    ctx: Volume3DViewportRenderContext
  ): Promise<void> {
    if (!this.handle || !this.renderWindow) {
      return;
    }

    const [w, h] = resizeVtkWasmCanvas(
      this.handle.canvas,
      ctx.viewport.element
    );
    await syncVtkWasmRenderWindowSize(this.renderWindow, w, h);

    // Re-sync pose after SetSize — canvas bitmap clears and a stale wasm
    // camera/clipping range can leave the volume blank until the next orbit.
    const vtkCam = ctx.vtk.renderer.getActiveCamera();
    await this.applyCameraToWasm(
      {
        position: vtkCam.getPosition?.() as Volume3DCamera['position'],
        focalPoint: vtkCam.getFocalPoint?.() as Volume3DCamera['focalPoint'],
        viewUp: vtkCam.getViewUp?.() as Volume3DCamera['viewUp'],
        parallelScale: vtkCam.getParallelScale?.(),
        parallelProjection: vtkCam.getParallelProjection?.(),
        viewAngle: vtkCam.getViewAngle?.(),
      },
      { applyBoundsClipping: true }
    );
    await this.renderAsync();
  }

  private async renderAsync(): Promise<void> {
    // Avoid VTK "No scalars named "" or with id -1" spam while streaming /
    // after a failed realloc on bricked volumes.
    if (!this.binding?.hasScalars()) {
      return;
    }
    const rw = this.renderWindow;
    if (!rw) {
      return;
    }
    const renderFn =
      (rw.render as ((...a: unknown[]) => unknown) | undefined) ??
      (rw.Render as ((...a: unknown[]) => unknown) | undefined);
    if (typeof renderFn !== 'function') {
      console.warn('[vtkWasm] Volume3D: renderWindow.render missing');
      return;
    }
    await renderFn.call(rw);
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
    return new VtkWasmVolume3DRenderPath({
      rendering: 'webgl',
      renderMode: VTK_WASM_VOLUME_3D_RENDER_MODE,
    });
  }

  selectContext(rootContext: Volume3DViewportRenderContext) {
    return rootContext;
  }
}

/** @internal */
export class VtkWasmWebgpuVolume3DPath
  implements
    RenderPathDefinition<
      Volume3DViewportRenderContext,
      Volume3DViewportRenderContext
    >
{
  readonly id = 'volume3d:vtk-wasm-webgpu-volume';
  readonly type = ViewportType.VOLUME_3D_NEXT;

  matches(data: LoadedData, options: DataAddOptions): boolean {
    return (
      data.type === 'image' &&
      options.renderMode === VTK_WASM_WEBGPU_VOLUME_3D_RENDER_MODE
    );
  }

  createRenderPath() {
    return new VtkWasmVolume3DRenderPath({
      rendering: 'webgpu',
      renderMode: VTK_WASM_WEBGPU_VOLUME_3D_RENDER_MODE,
    });
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
