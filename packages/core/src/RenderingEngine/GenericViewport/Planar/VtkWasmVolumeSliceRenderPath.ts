import { Events, ViewportStatus, ViewportType } from '../../../enums';
import eventTarget from '../../../eventTarget';
import clonePoint3 from '../../../utilities/clonePoint3';
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
import { getDefaultVolumeVOIRange } from '../../helpers/setDefaultVolumeVOI';
import { triggerPlanarVolumeNewImage } from './planarImageEvents';
import { getCpuEquivalentParallelScale } from './planarAdapterCoordinateTransforms';
import { extractOrthogonalVolumeSlice } from './orthogonalVolumeSliceExtract';
import { resolvePlanarRenderPathProjection } from './planarRenderPathProjection';
import type { PlanarRendering } from './planarRuntimeTypes';
import {
  createVtkWasmViewportHandle,
  resizeVtkWasmCanvas,
  syncVtkWasmRenderWindowSize,
  type VtkWasmNamespace,
  type VtkWasmObject,
  type VtkWasmViewportHandle,
} from '../vtkWasmRuntime';
import {
  createVtkWasmVolumeBinding,
  type VtkWasmVolumeBinding,
} from '../vtkWasmVolumeBinding';
import {
  SCALARS_ARRAY_NAME,
  setVtkWasmImageDataExtent,
} from '../vtkWasmImageDataFinalize';
import { getVolumeScalarArray } from '../webgpuMapperImageData';
import {
  readWasmBrickPartitionOptionsForPath,
  type WasmVtkVolumeBrickPlan,
} from '../../helpers/volumeTextureBrickWasm';

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
  if (!target) {
    return undefined;
  }
  // vtk-wasm Proxies throw on unknown property access — never use target[method]
  // without try/catch.
  let fn: unknown;
  try {
    fn = target[method];
  } catch {
    return undefined;
  }
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    return await (fn as (...a: unknown[]) => unknown).apply(target, args);
  } catch (error) {
    console.warn(`[vtkWasm] invoke ${method} failed`, error);
    return undefined;
  }
}

function fallbackVolumeVoiRange(imageVolume: IImageVolume): VOIRange {
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
  // CT soft-tissue fallback — wasm ImageProperty defaults (255/127.5) blank HU data.
  return { lower: -160, upper: 240 };
}

async function resolveDefaultVolumeVoiRange(
  imageVolume: IImageVolume
): Promise<VOIRange> {
  const fromMetadata = await getDefaultVolumeVOIRange(imageVolume);
  if (
    fromMetadata &&
    Number.isFinite(fromMetadata.lower) &&
    Number.isFinite(fromMetadata.upper) &&
    fromMetadata.upper > fromMetadata.lower
  ) {
    return fromMetadata;
  }
  return fallbackVolumeVoiRange(imageVolume);
}

function effectiveVolumeVoiRange(
  imageVolume: IImageVolume,
  rendering?: Pick<
    PlanarVtkWasmVolumeSliceRendering,
    'dataPresentation' | 'defaultVOIRange'
  >,
  defaultVoiForRebind?: VOIRange
): VOIRange {
  return (
    rendering?.dataPresentation?.voiRange ??
    rendering?.defaultVOIRange ??
    defaultVoiForRebind ??
    fallbackVolumeVoiRange(imageVolume)
  );
}

const DEFAULT_PLANAR_VIEW_UP: [number, number, number] = [0, -1, 0];

function getVolumeWorldBounds(
  imageVolume: IImageVolume
): [number, number, number, number, number, number] | undefined {
  const vtkImage = imageVolume.imageData as
    | { getBounds?: () => number[] }
    | undefined;
  const bounds = vtkImage?.getBounds?.();
  if (bounds && bounds.length >= 6) {
    return [
      Number(bounds[0]),
      Number(bounds[1]),
      Number(bounds[2]),
      Number(bounds[3]),
      Number(bounds[4]),
      Number(bounds[5]),
    ];
  }
  const origin = imageVolume.origin as [number, number, number] | undefined;
  const spacing = imageVolume.spacing as [number, number, number] | undefined;
  const dims = imageVolume.dimensions as [number, number, number] | undefined;
  if (!origin || !spacing || !dims) {
    return undefined;
  }
  // Axis-aligned fallback (ignores direction obliquity).
  return [
    origin[0],
    origin[0] + (dims[0] - 1) * spacing[0],
    origin[1],
    origin[1] + (dims[1] - 1) * spacing[1],
    origin[2],
    origin[2] + (dims[2] - 1) * spacing[2],
  ];
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
  private didLogPresent = false;
  private imageVolumeForFrame?: IImageVolume;
  private actorInRenderer = false;
  private defaultVoiForRebind?: VOIRange;
  /** True after first successful setInputData + addActor (do not rebuild on scroll). */
  private mprInputBound = false;
  /** Ortho path via vtkImageMapper when available; else ImageResliceMapper. */
  private useImageMapper = false;
  private didLogMprDiagnostics = false;
  /** CPU fallback canvas — wasm ImageReslice paints RGB=0 in this bundle. */
  private cpuCanvas?: HTMLCanvasElement;
  private lastBlitViewUp?: [number, number, number];
  private lastBlitParallelScale?: number;

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
    this.imageVolumeForFrame = imageVolume;

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

    const binding = createVtkWasmVolumeBinding(
      vtk,
      imageVolume,
      handle.session.typedArrayInterface,
      {
        brickPartitionOptions: readWasmBrickPartitionOptionsForPath('mpr'),
      }
    );
    this.binding = binding;
    const alreadyLoaded = Boolean(
      (imageVolume as { loadStatus?: { loaded?: boolean } }).loadStatus?.loaded
    );
    if (alreadyLoaded) {
      if (binding.syncMprPlane) {
        // Dense bricks: stitch a default mid-volume plane; real plane arrives
        // in syncFromViewState. Avoids full-volume heap.alloc for multi-brick.
        const midWorld = getVolumeMidWorld(imageVolume);
        await binding.syncMprPlane(midWorld, [0, 0, 1]);
      } else {
        await binding.refreshScalars(undefined, { force: true });
      }
    }

    const renderWindow = vtk.vtkRenderWindow({
      canvasSelector: handle.canvasKey,
      size: [canvasW, canvasH],
    }) as VtkWasmObject;
    await syncVtkWasmRenderWindowSize(renderWindow, canvasW, canvasH);
    // Diagnostic clear: green proves GL presents; black = canvas not shown or no render.
    // Revert to [0,0,0] once MPR image is visible.
    const renderer = vtk.vtkRenderer({
      background: [0, 0, 0],
    }) as VtkWasmObject;
    const actor = vtk.vtkImageSlice() as VtkWasmObject;
    const slicePlane = vtk.vtkPlane() as VtkWasmObject;

    await invoke(renderWindow, 'addRenderer', renderer);
    // Do not create / wire ImageResliceMapper until scalars exist — wasm keeps
    // a sticky empty GPU path if setInputData runs on a mapper already bound
    // to the actor with no point-data scalars.

    const imageProperty = (await invoke(actor, 'getProperty')) as
      | VtkWasmObject
      | undefined;
    this.imageProperty = imageProperty ?? (actor.property as VtkWasmObject);

    const defaultVOIRange = await resolveDefaultVolumeVoiRange(imageVolume);
    this.defaultVoiForRebind = defaultVOIRange;
    if (defaultVOIRange) {
      await this.applyVoiRange(defaultVOIRange);
    }

    // SetPartitions is volume ray-cast only; vtkImageResliceMapper has no such API.

    this.renderWindow = renderWindow;
    this.renderer = renderer;
    this.mapper = undefined;
    this.actor = actor;
    this.slicePlane = slicePlane;
    this.actorInRenderer = false;

    ctx.display.activateRenderMode(VTK_WASM_VOLUME_RENDER_MODE);

    const cpuCanvas = document.createElement('canvas');
    cpuCanvas.className = `${VTK_WASM_PLANAR_CANVAS_CLASS}-cpu`;
    cpuCanvas.style.position = 'absolute';
    cpuCanvas.style.inset = '0';
    cpuCanvas.style.width = '100%';
    cpuCanvas.style.height = '100%';
    cpuCanvas.style.zIndex = '21';
    cpuCanvas.style.pointerEvents = 'none';
    cpuCanvas.style.display = 'block';
    cpuCanvas.style.visibility = 'visible';
    ctx.viewport.element.appendChild(cpuCanvas);
    this.cpuCanvas = cpuCanvas;
    resizeVtkWasmCanvas(cpuCanvas, ctx.viewport.element);

    // Keep wasm GL wired for future ImageReslice fixes; display via CPU blit.
    handle.canvas.style.display = 'none';
    handle.canvas.style.visibility = 'hidden';

    const rendering: PlanarVtkWasmVolumeSliceRendering = {
      renderMode: VTK_WASM_VOLUME_RENDER_MODE,
      actorEntryUID: uuidv4(),
      actor: actor as never,
      overlayOrder: 0,
      imageVolume,
      imageIds: payload.imageIds,
      acquisitionOrientation: payload.acquisitionOrientation,
      mapper: undefined as never,
      currentImageIdIndex: payload.initialImageIdIndex ?? 0,
      maxImageIdIndex: payload.imageIds.length - 1,
      defaultVOIRange,
      dataPresentation: undefined,
      brickPlan: binding.brickPlan,
      binding,
    };

    const uploadAndPresent = () => {
      void Promise.resolve(
        binding.syncMprPlane
          ? (async () => {
              // Single-brick: reslice uses the brick ImageData — force upload.
              // Multi-brick: stitch from CS scalars only; uploading all dense
              // bricks OOMs the WASM heap on large studies (~194MB/brick).
              const brickCount = binding.brickPlan?.bricks?.length ?? 0;
              if (brickCount <= 1) {
                await binding.refreshScalars(undefined, { force: true });
              }
              const cam = ctx.viewport.getViewState?.() as
                | {
                    focalPoint?: number[];
                    viewPlaneNormal?: number[];
                  }
                | undefined;
              if (cam?.focalPoint && cam?.viewPlaneNormal) {
                return binding.syncMprPlane!(
                  cam.focalPoint as [number, number, number],
                  cam.viewPlaneNormal as [number, number, number]
                );
              }
              return binding.syncMprPlane!(
                getVolumeMidWorld(imageVolume),
                [0, 0, 1]
              );
            })()
          : binding.refreshScalars(undefined, { force: true })
      ).then(async (ok) => {
        const mprReady =
          ok && (binding.hasMprInput?.() ?? binding.hasScalars());
        if (!mprReady) {
          console.warn(
            '[vtkWasm] MPR uploadAndPresent: no reslice input yet (stitch/upload failed)'
          );
          return;
        }
        if (!rendering.defaultVOIRange) {
          rendering.defaultVOIRange =
            await resolveDefaultVolumeVoiRange(imageVolume);
          this.defaultVoiForRebind = rendering.defaultVOIRange;
        }
        await this.applyVoiRange(
          effectiveVolumeVoiRange(
            imageVolume,
            rendering,
            this.defaultVoiForRebind
          )
        );
        // Camera + plane first, then rebind + frame + direct wasm render.
        await this.syncFromViewState(ctx, rendering, data.id);
        await this.presentMpr(binding, imageVolume, {
          voiRange: effectiveVolumeVoiRange(
            imageVolume,
            rendering,
            this.defaultVoiForRebind
          ),
        });
        ctx.display.markRendered();
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
    await this.presentMpr(binding, imageVolume, {
      voiRange: effectiveVolumeVoiRange(
        imageVolume,
        rendering,
        this.defaultVoiForRebind
      ),
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
        const voi =
          rendering.dataPresentation?.voiRange ?? rendering.defaultVOIRange;
        if (voi) {
          void this.applyVoiRange(voi).then(async () => {
            let normal: [number, number, number] = [0, 0, 1];
            if (this.slicePlane) {
              const n = (await invoke(this.slicePlane, 'getNormal')) as
                | number[]
                | undefined;
              if (n && n.length >= 3) {
                const len =
                  Math.hypot(Number(n[0]), Number(n[1]), Number(n[2])) || 1;
                normal = [
                  Number(n[0]) / len,
                  Number(n[1]) / len,
                  Number(n[2]) / len,
                ];
              }
            }
            let origin = getVolumeMidWorld(imageVolume);
            if (this.slicePlane) {
              origin = await getSlicePlaneOrigin(this.slicePlane, origin);
            }
            await this.blitVolumeSliceToCpuCanvas(
              imageVolume,
              origin,
              normal,
              voi,
              {
                viewUp: this.lastBlitViewUp,
                parallelScale: this.lastBlitParallelScale,
              }
            );
            this.render(ctx, data.id);
          });
        }
      },
      applyViewState: (camera) => {
        void this.syncFromViewState(
          ctx,
          rendering,
          data.id,
          camera as PlanarViewState | undefined
        ).then(async () => {
          if (!this.mprInputBound) {
            await this.presentMpr(binding, imageVolume, {
              voiRange: effectiveVolumeVoiRange(
                imageVolume,
                rendering,
                this.defaultVoiForRebind
              ),
            });
          } else {
            const slab = binding.getMprImageData?.() ?? binding.imageData;
            let normal: [number, number, number] = [0, 0, 1];
            if (this.slicePlane) {
              const n = (await invoke(this.slicePlane, 'getNormal')) as
                | number[]
                | undefined;
              if (n && n.length >= 3) {
                const len =
                  Math.hypot(Number(n[0]), Number(n[1]), Number(n[2])) || 1;
                normal = [
                  Number(n[0]) / len,
                  Number(n[1]) / len,
                  Number(n[2]) / len,
                ];
              }
            }
            await this.frameCameraToSlab(slab, normal);
            const voi = effectiveVolumeVoiRange(
              imageVolume,
              rendering,
              this.defaultVoiForRebind
            );
            let origin = getVolumeMidWorld(imageVolume);
            if (this.slicePlane) {
              origin = await getSlicePlaneOrigin(this.slicePlane, origin);
            }
            await this.blitVolumeSliceToCpuCanvas(
              imageVolume,
              origin,
              normal,
              voi,
              {
                viewUp: this.lastBlitViewUp,
                parallelScale: this.lastBlitParallelScale,
              }
            );
            await this.forceWasmRender();
          }
          ctx.display.markRendered();
        });
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
        rendering.binding.dispose?.();
        this.handle?.dispose();
        this.handle = undefined;
        this.renderWindow = undefined;
        this.renderer = undefined;
        this.mapper = undefined;
        this.actor = undefined;
        this.slicePlane = undefined;
        this.imageProperty = undefined;
        this.binding = undefined;
        this.imageVolumeForFrame = undefined;
        this.didLogPresent = false;
        this.actorInRenderer = false;
        this.defaultVoiForRebind = undefined;
        this.mprInputBound = false;
        this.useImageMapper = false;
        this.didLogMprDiagnostics = false;
        this.lastBlitViewUp = undefined;
        this.lastBlitParallelScale = undefined;
        this.cpuCanvas?.remove();
        this.cpuCanvas = undefined;
      },
    };
  }

  /**
   * Medical volumes sit hundreds–thousands of mm from the camera. Prefer
   * explicit near/far from a known pose (getPosition often fails on wasm).
   */
  private async applyMedicalClippingRange(
    cam: VtkWasmObject,
    position: [number, number, number],
    focalPoint: [number, number, number]
  ): Promise<{ near: number; far: number }> {
    const d = Math.hypot(
      position[0] - focalPoint[0],
      position[1] - focalPoint[1],
      position[2] - focalPoint[2]
    );
    const dist = d > 1e-3 ? d : 1;
    const near = Math.max(0.1, dist * 0.05);
    const far = Math.max(near + 1, dist * 10);
    await invoke(cam, 'setClippingRange', near, far);
    cam.$set?.({ clippingRange: [near, far] });
    return { near, far };
  }

  /**
   * Map world plane → ImageMapper slice.
   * Prefer world X/Y/Z modes (3/4/5) so the slice plane matches the camera
   * look direction in patient space (I/J/K alone often draws nothing / black).
   */
  private async applyImageMapperSlice(
    imageVolume: IImageVolume,
    originWorld: [number, number, number],
    normalWorld: [number, number, number]
  ): Promise<{ mode: number; slice: number } | undefined> {
    if (!this.mapper || !this.useImageMapper) {
      return undefined;
    }
    const ax = Math.abs(normalWorld[0]);
    const ay = Math.abs(normalWorld[1]);
    const az = Math.abs(normalWorld[2]);
    // vtk.js SlicingMode: X=3, Y=4, Z=5 (world axes)
    let mode = 5;
    let slice = originWorld[2];
    if (ax >= ay && ax >= az) {
      mode = 3;
      slice = originWorld[0];
    } else if (ay >= ax && ay >= az) {
      mode = 4;
      slice = originWorld[1];
    }

    await invoke(this.mapper, 'setSlicingMode', mode);
    await invoke(this.mapper, 'setSlice', slice);
    this.mapper.$set?.({ slicingMode: mode, slice });
    await invoke(this.mapper, 'modified');
    await invoke(this.actor, 'modified');
    console.info(
      `[vtkWasm] ImageMapper slice mode=${mode} (X3/Y4/Z5) slice=${slice.toFixed(2)} ` +
        `normal=[${normalWorld.map((v) => v.toFixed(2)).join(',')}]`
    );
    return { mode, slice };
  }

  /**
   * One-time ImageReslice / ImageMapper bind. Later scrolls only update plane/slice.
   */
  private async rebindMprInput(
    binding: VtkWasmVolumeBinding
  ): Promise<boolean> {
    if (!(binding.hasMprInput?.() ?? binding.hasScalars())) {
      return false;
    }
    if (!this.handle || !this.renderer || !this.actor || !this.slicePlane) {
      return false;
    }

    const input = binding.getMprImageData?.() ?? binding.imageData;
    await ensureWasmImageDataGeometry(input, binding.brickPlan);

    if (this.mprInputBound && this.mapper && this.actorInRenderer) {
      const input = binding.getMprImageData?.() ?? binding.imageData;
      await invoke(this.mapper, 'setInputData', input);
      await invoke(this.mapper, 'setSlicePlane', this.slicePlane);
      this.mapper.$set?.({ slicePlane: this.slicePlane });
      await invoke(this.mapper, 'setScalarModeToUsePointData');
      await invoke(this.mapper, 'setArrayName', SCALARS_ARRAY_NAME);
      await invoke(this.mapper, 'modified');
      await invoke(this.actor, 'modified');
      return true;
    }

    const { vtk } = this.handle;
    let dimsStr = '?';
    try {
      const dims = (await invoke(input, 'getDimensions')) as
        | number[]
        | undefined;
      if (dims && dims.length >= 3) {
        dimsStr = `${dims[0]}x${dims[1]}x${dims[2]}`;
        const prod = Number(dims[0]) * Number(dims[1]) * Number(dims[2]);
        if (!(prod > 0)) {
          console.warn(
            `[vtkWasm] MPR rebind refused — ImageData dims=${dimsStr}`
          );
          return false;
        }
      }
    } catch {
      // continue
    }

    // ImageMapper in this vtk-wasm build crashes renderWindow.render() with
    // RuntimeError: null function. Prefer ImageResliceMapper only.
    const imageMapperCtor = undefined;
    if (this.mapper) {
      try {
        this.mapper.$delete?.();
      } catch {
        // ignore
      }
      this.mapper = undefined;
    }
    if (this.actorInRenderer) {
      await invoke(this.renderer, 'removeActor', this.actor);
      await invoke(this.renderer, 'removeViewProp', this.actor);
      this.actorInRenderer = false;
    }

    let mapper: VtkWasmObject;
    if (typeof imageMapperCtor === 'function') {
      mapper = imageMapperCtor() as VtkWasmObject;
      this.useImageMapper = true;
      await invoke(mapper, 'setInputData', input);
      const zMid = this.imageVolumeForFrame
        ? getVolumeMidWorld(this.imageVolumeForFrame)[2]
        : 0;
      await invoke(mapper, 'setSlicingMode', 5);
      await invoke(mapper, 'setSlice', zMid);
      mapper.$set?.({ slicingMode: 5, slice: zMid });
    } else if (typeof vtk.vtkImageResliceMapper === 'function') {
      mapper = vtk.vtkImageResliceMapper() as VtkWasmObject;
      this.useImageMapper = false;
      await invoke(mapper, 'setInputData', input);
      await invoke(mapper, 'setScalarModeToUsePointData');
      await invoke(mapper, 'setArrayName', SCALARS_ARRAY_NAME);
      await invoke(mapper, 'setSlabThickness', 0);
      await invoke(mapper, 'setSlicePlane', this.slicePlane);
      mapper.$set?.({ slicePlane: this.slicePlane, slabThickness: 0 });
    } else {
      console.warn('[vtkWasm] no ImageMapper / ImageResliceMapper in bundle');
      return false;
    }

    this.mapper = mapper;

    await invoke(mapper, 'modified');
    await invoke(this.actor, 'setMapper', mapper);
    await invoke(this.actor, 'setVisibility', 1);
    await invoke(this.actor, 'modified');

    if (!this.actorInRenderer) {
      await invoke(this.renderer, 'addActor', this.actor);
      await invoke(this.renderer, 'addViewProp', this.actor);
      this.actorInRenderer = true;
    }

    this.mprInputBound = true;

    const imageProperty = (await invoke(this.actor, 'getProperty')) as
      | VtkWasmObject
      | undefined;
    if (imageProperty) {
      this.imageProperty = imageProperty;
      await invoke(imageProperty, 'setOpacity', 1);
      await invoke(imageProperty, 'setInterpolationTypeToLinear');
      await invoke(imageProperty, 'setInterpolationType', 1);
    }
    if (this.defaultVoiForRebind) {
      await this.applyVoiRange(this.defaultVoiForRebind);
    }

    if (!this.didLogMprDiagnostics) {
      this.didLogMprDiagnostics = true;
      const bounds = (await invoke(input, 'getBounds')) as number[] | undefined;
      const spacing = (await invoke(input, 'getSpacing')) as
        | number[]
        | undefined;
      const origin = (await invoke(input, 'getOrigin')) as number[] | undefined;
      const planeOrigin = (await invoke(this.slicePlane, 'getOrigin')) as
        | number[]
        | undefined;
      const planeNormal = (await invoke(this.slicePlane, 'getNormal')) as
        | number[]
        | undefined;
      console.info(
        `[vtkWasm] MPR bind ok inputDims=${dimsStr} mapper=${
          this.useImageMapper ? 'ImageMapper' : 'ImageResliceMapper'
        } bounds=${JSON.stringify(bounds)} spacing=${JSON.stringify(spacing)} ` +
          `origin=${JSON.stringify(origin)} planeOrigin=${JSON.stringify(planeOrigin)} ` +
          `planeNormal=${JSON.stringify(planeNormal)}`
      );
    } else {
      console.info(
        `[vtkWasm] MPR bind ok inputDims=${dimsStr} mapper=${
          this.useImageMapper ? 'ImageMapper' : 'ImageResliceMapper'
        }`
      );
    }
    return true;
  }

  /**
   * Update slice plane / ImageMapper index without rebuilding the mapper.
   */
  private async updateMprPlane(
    imageVolume: IImageVolume,
    origin: [number, number, number],
    normal: [number, number, number]
  ): Promise<void> {
    if (this.slicePlane) {
      await invoke(this.slicePlane, 'setOrigin', ...origin);
      await invoke(this.slicePlane, 'setNormal', ...normal);
      this.slicePlane.$set?.({ origin, normal });
      await invoke(this.slicePlane, 'modified');
    }
    if (this.useImageMapper) {
      await this.applyImageMapperSlice(imageVolume, origin, normal);
    } else if (this.mapper && this.slicePlane) {
      await invoke(this.mapper, 'setSlicePlane', this.slicePlane);
      this.mapper.$set?.({ slicePlane: this.slicePlane });
      await invoke(this.mapper, 'modified');
    }
  }

  /**
   * Bind once (if needed), update plane, render. Camera comes from syncFromViewState.
   */
  private async presentMpr(
    binding: VtkWasmVolumeBinding,
    imageVolume: IImageVolume,
    options?: {
      viewPlaneNormal?: [number, number, number];
      voiRange?: VOIRange;
    }
  ): Promise<void> {
    let normal = options?.viewPlaneNormal;
    if (!normal && this.slicePlane) {
      const n = (await invoke(this.slicePlane, 'getNormal')) as
        | number[]
        | undefined;
      if (n && n.length >= 3) {
        const len = Math.hypot(Number(n[0]), Number(n[1]), Number(n[2])) || 1;
        normal = [Number(n[0]) / len, Number(n[1]) / len, Number(n[2]) / len];
      }
    }
    if (!normal) {
      normal = [0, 0, 1];
    }

    // Keep plane origin from syncFromViewState (crosshair focal point). Do not
    // reset to volume mid — that misaligns the reslice from the CS camera.
    const planeOrigin = await getSlicePlaneOrigin(
      this.slicePlane,
      getVolumeMidWorld(imageVolume)
    );
    await this.updateMprPlane(imageVolume, planeOrigin, normal);

    if (!(await this.rebindMprInput(binding))) {
      return;
    }

    if (this.useImageMapper) {
      await this.applyImageMapperSlice(imageVolume, planeOrigin, normal);
    }

    const slabInput = binding.getMprImageData?.() ?? binding.imageData;
    await this.frameCameraToSlab(slabInput, normal);
    await this.forceWasmRender();

    const voi =
      options?.voiRange ??
      this.defaultVoiForRebind ??
      fallbackVolumeVoiRange(imageVolume);
    const renderOk = await this.blitVolumeSliceToCpuCanvas(
      imageVolume,
      planeOrigin,
      normal,
      voi,
      {
        viewUp: this.lastBlitViewUp,
        parallelScale: this.lastBlitParallelScale,
      }
    );

    if (!this.didLogPresent && this.handle?.canvas) {
      this.didLogPresent = true;
      const w = this.handle.canvas.width;
      const h = this.handle.canvas.height;
      const prop = this.imageProperty;
      const cw = prop
        ? ((await invoke(prop, 'getColorWindow')) as number | undefined)
        : undefined;
      const cl = prop
        ? ((await invoke(prop, 'getColorLevel')) as number | undefined)
        : undefined;
      const cam = this.renderer
        ? ((await invoke(this.renderer, 'getActiveCamera')) as
            | VtkWasmObject
            | undefined)
        : undefined;
      let clipStr = '?';
      if (cam) {
        const clip = (await invoke(cam, 'getClippingRange')) as
          | number[]
          | undefined;
        if (clip && clip.length >= 2) {
          clipStr = `${Number(clip[0]).toFixed(1)}..${Number(clip[1]).toFixed(1)}`;
        }
      }
      console.info(
        `[vtkWasm] MPR present canvas=${w}x${h} colorWindow=${cw} colorLevel=${cl} ` +
          `planeOrigin=[${planeOrigin.map((v) => v.toFixed(1)).join(',')}] ` +
          `normal=[${normal.map((v) => v.toFixed(2)).join(',')}] ` +
          `clip=${clipStr} renderOk=${renderOk} ` +
          `mapper=${this.useImageMapper ? 'ImageMapper' : 'ImageReslice'}`
      );
    }
  }

  /**
   * Frame parallel camera from wasm slab/ImageData bounds (not CS vtkImageData).
   */
  private async frameCameraToSlab(
    slabInput: VtkWasmObject,
    viewPlaneNormal?: [number, number, number]
  ): Promise<void> {
    const renderer = this.renderer;
    if (!renderer) {
      return;
    }
    const bounds = (await invoke(slabInput, 'getBounds')) as
      | number[]
      | undefined;
    if (!bounds || bounds.length < 6) {
      await invoke(renderer, 'resetCamera');
      return;
    }

    const cx = (bounds[0] + bounds[1]) * 0.5;
    const cy = (bounds[2] + bounds[3]) * 0.5;
    const cz = (bounds[4] + bounds[5]) * 0.5;
    const dx = Math.max(1e-3, Math.abs(bounds[1] - bounds[0]));
    const dy = Math.max(1e-3, Math.abs(bounds[3] - bounds[2]));
    const dz = Math.max(1e-3, Math.abs(bounds[5] - bounds[4]));
    const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
    const distance = Math.max(radius * 2.5, 10);

    let nx = 0;
    let ny = 0;
    let nz = 1;
    if (viewPlaneNormal) {
      const len =
        Math.hypot(
          viewPlaneNormal[0],
          viewPlaneNormal[1],
          viewPlaneNormal[2]
        ) || 1;
      nx = viewPlaneNormal[0] / len;
      ny = viewPlaneNormal[1] / len;
      nz = viewPlaneNormal[2] / len;
    }
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    let parallelScale: number;
    if (az >= ax && az >= ay) {
      parallelScale = Math.max(dx, dy) * 0.55;
    } else if (ay >= ax) {
      parallelScale = Math.max(dx, dz) * 0.55;
    } else {
      parallelScale = Math.max(dy, dz) * 0.55;
    }
    parallelScale = Math.max(parallelScale, 1);

    let viewUp: [number, number, number] = [0, 1, 0];
    if (Math.abs(nz) > 0.9) {
      viewUp = [0, 1, 0];
    } else if (Math.abs(ny) > 0.9) {
      viewUp = [0, 0, 1];
    }

    let cam = renderer.activeCamera as VtkWasmObject | undefined;
    if (!cam) {
      cam = (await invoke(renderer, 'getActiveCamera')) as
        | VtkWasmObject
        | undefined;
    }
    if (!cam) {
      return;
    }

    const position: [number, number, number] = [
      cx + nx * distance,
      cy + ny * distance,
      cz + nz * distance,
    ];
    const focalPoint: [number, number, number] = [cx, cy, cz];

    await invoke(cam, 'setParallelProjection', 1);
    await invoke(cam, 'setFocalPoint', ...focalPoint);
    await invoke(cam, 'setPosition', ...position);
    await invoke(cam, 'setViewUp', ...viewUp);
    await invoke(cam, 'setParallelScale', parallelScale);
    cam.$set?.({
      parallelProjection: 1,
      focalPoint,
      position,
      viewUp,
      parallelScale,
    });
    await this.applyMedicalClippingRange(cam, position, focalPoint);
  }

  /**
   * Frame parallel camera on the volume bounds looking along the slice normal.
   * Returns pose used for clipping/logging (avoid getPosition on wasm).
   */
  private async frameCameraToVolume(
    imageVolume: IImageVolume,
    viewPlaneNormal?: [number, number, number]
  ): Promise<
    | {
        position: [number, number, number];
        focalPoint: [number, number, number];
        parallelScale: number;
        near: number;
        far: number;
      }
    | undefined
  > {
    const renderer = this.renderer;
    if (!renderer) {
      return undefined;
    }
    const bounds = getVolumeWorldBounds(imageVolume);
    if (!bounds) {
      await invoke(renderer, 'resetCamera');
      return undefined;
    }

    const cx = (bounds[0] + bounds[1]) * 0.5;
    const cy = (bounds[2] + bounds[3]) * 0.5;
    const cz = (bounds[4] + bounds[5]) * 0.5;
    const dx = Math.max(1e-3, Math.abs(bounds[1] - bounds[0]));
    const dy = Math.max(1e-3, Math.abs(bounds[3] - bounds[2]));
    const dz = Math.max(1e-3, Math.abs(bounds[5] - bounds[4]));
    const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
    const distance = radius * 2.5;

    let nx = 0;
    let ny = 0;
    let nz = 1;
    if (viewPlaneNormal) {
      const len =
        Math.hypot(
          viewPlaneNormal[0],
          viewPlaneNormal[1],
          viewPlaneNormal[2]
        ) || 1;
      nx = viewPlaneNormal[0] / len;
      ny = viewPlaneNormal[1] / len;
      nz = viewPlaneNormal[2] / len;
    }
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    let parallelScale: number;
    if (az >= ax && az >= ay) {
      parallelScale = Math.max(dx, dy) * 0.55;
    } else if (ay >= ax) {
      parallelScale = Math.max(dx, dz) * 0.55;
    } else {
      parallelScale = Math.max(dy, dz) * 0.55;
    }

    let viewUp: [number, number, number] = [0, 1, 0];
    if (Math.abs(nz) < 0.9) {
      viewUp = [0, 0, 1];
    }

    let cam = renderer.activeCamera as VtkWasmObject | undefined;
    if (!cam) {
      cam = (await invoke(renderer, 'getActiveCamera')) as
        | VtkWasmObject
        | undefined;
    }
    if (!cam) {
      await invoke(renderer, 'resetCamera');
      return undefined;
    }

    const position: [number, number, number] = [
      cx + nx * distance,
      cy + ny * distance,
      cz + nz * distance,
    ];
    const focalPoint: [number, number, number] = [cx, cy, cz];

    await invoke(cam, 'setParallelProjection', 1);
    await invoke(cam, 'setFocalPoint', ...focalPoint);
    await invoke(cam, 'setPosition', ...position);
    await invoke(cam, 'setViewUp', ...viewUp);
    await invoke(cam, 'setParallelScale', parallelScale);
    cam.$set?.({
      parallelProjection: 1,
      focalPoint,
      position,
      viewUp,
      parallelScale,
    });
    const { near, far } = await this.applyMedicalClippingRange(
      cam,
      position,
      focalPoint
    );
    return { position, focalPoint, parallelScale, near, far };
  }

  /** CPU orthogonal slice blit — wasm ImageResliceMapper draws clear-only RGB. */
  private async blitVolumeSliceToCpuCanvas(
    imageVolume: IImageVolume,
    originWorld: [number, number, number],
    normalWorld: [number, number, number],
    voiRange: VOIRange,
    camera?: {
      parallelScale?: number;
      viewUp?: [number, number, number];
    }
  ): Promise<boolean> {
    const canvas = this.cpuCanvas;
    if (!canvas) {
      return false;
    }
    if (canvas.parentElement) {
      resizeVtkWasmCanvas(canvas, canvas.parentElement);
    }
    const viewUp =
      camera?.viewUp ?? this.lastBlitViewUp ?? DEFAULT_PLANAR_VIEW_UP;
    const slice = extractOrthogonalVolumeSlice(
      imageVolume,
      originWorld,
      normalWorld,
      viewUp
    );
    if (!slice) {
      console.warn('[vtkWasm] MPR CPU blit: slice extract failed');
      return false;
    }
    const window = voiRange.upper - voiRange.lower;
    const level = (voiRange.upper + voiRange.lower) / 2;
    if (!(window > 0)) {
      return false;
    }
    const rgba = windowLevelSliceToRgba(slice.data, window, level);
    const offscreen = document.createElement('canvas');
    offscreen.width = slice.width;
    offscreen.height = slice.height;
    const ctx = offscreen.getContext('2d');
    if (!ctx) {
      return false;
    }
    ctx.putImageData(new ImageData(rgba, slice.width, slice.height), 0, 0);

    const dest = canvas.getContext('2d');
    if (!dest) {
      return false;
    }
    dest.fillStyle = '#000';
    dest.fillRect(0, 0, canvas.width, canvas.height);

    const fitScale = getCpuEquivalentParallelScale({
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      columns: slice.width,
      rows: slice.height,
      columnPixelSpacing: slice.worldWidth / Math.max(slice.width, 1),
      rowPixelSpacing: slice.worldHeight / Math.max(slice.height, 1),
    });
    const parallelScale =
      camera?.parallelScale ?? this.lastBlitParallelScale ?? fitScale;
    const mmToPx = canvas.height / (2 * Math.max(parallelScale, 0.001));
    const dw = slice.worldWidth * mmToPx;
    const dh = slice.worldHeight * mmToPx;
    const dx = (canvas.width - dw) * 0.5;
    const dy = (canvas.height - dh) * 0.5;
    dest.imageSmoothingEnabled = true;
    dest.drawImage(offscreen, 0, 0, slice.width, slice.height, dx, dy, dw, dh);
    return true;
  }

  /** Direct vtk-wasm render — bypasses PlanarViewport / isCurrentDataId gates. */
  private async forceWasmRender(): Promise<boolean> {
    if (!this.renderWindow) {
      return false;
    }
    if (this.handle?.canvas) {
      this.handle.canvas.style.visibility = 'visible';
      this.handle.canvas.style.display = 'block';
    }
    try {
      await invoke(this.renderWindow, 'render');
      return true;
    } catch (error) {
      console.warn('[vtkWasm] MPR render failed', error);
      return false;
    }
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

    // Plain arrays only: TypedArrays JSON-serialize as objects and fail
    // vtk-wasm DeserializeJSON (type must be array).
    cam.$set?.({
      parallelProjection: 1,
      ...(camera.viewUp ? { viewUp: clonePoint3(camera.viewUp) } : {}),
      ...(camera.focalPoint
        ? { focalPoint: clonePoint3(camera.focalPoint) }
        : {}),
      ...(camera.position ? { position: clonePoint3(camera.position) } : {}),
      ...(typeof camera.parallelScale === 'number'
        ? { parallelScale: camera.parallelScale }
        : {}),
    });

    if (camera.position && camera.focalPoint) {
      await this.applyMedicalClippingRange(
        cam,
        clonePoint3(camera.position),
        clonePoint3(camera.focalPoint)
      );
    }
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
      // Still place a mid-volume axial plane so ImageReslice has something to cut.
      if (this.slicePlane) {
        const mid = getVolumeMidWorld(rendering.imageVolume);
        const normal: [number, number, number] = [0, 0, 1];
        await this.updateMprPlane(rendering.imageVolume, mid, normal);
        if (rendering.binding.syncMprPlane) {
          await rendering.binding.syncMprPlane(mid, normal);
        }
        await this.rebindMprInput(rendering.binding);
        await this.frameCameraToVolume(rendering.imageVolume, normal);
      }
      return;
    }

    const cam = projection.isSourceBinding
      ? projection.resolvedICamera
      : projection.activeSourceICamera;

    if (cam.viewUp) {
      this.lastBlitViewUp = clonePoint3(cam.viewUp);
    }
    if (typeof cam.parallelScale === 'number') {
      this.lastBlitParallelScale = cam.parallelScale;
    }

    if (cam.focalPoint && cam.viewPlaneNormal) {
      const origin = clonePoint3(cam.focalPoint);
      const normal = clonePoint3(cam.viewPlaneNormal);
      if (rendering.binding.syncMprPlane) {
        await rendering.binding.syncMprPlane(origin, normal);
      }
      await this.updateMprPlane(rendering.imageVolume, origin, normal);
      // Ensure pipeline exists once; do not rebuild mapper every scroll.
      await this.rebindMprInput(rendering.binding);
      if (this.useImageMapper) {
        await this.applyImageMapperSlice(rendering.imageVolume, origin, normal);
      }
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
    if (!this.renderWindow) {
      return;
    }
    // Prefer direct wasm render when MPR input exists. Skip isCurrentDataId —
    // that gate silently dropped presents right after stitch/load.
    if (!(this.binding?.hasMprInput?.() ?? this.binding?.hasScalars())) {
      return;
    }
    if (
      dataId &&
      typeof ctx.viewport.isCurrentDataId === 'function' &&
      !ctx.viewport.isCurrentDataId(dataId)
    ) {
      // Still paint: binding may be active while CS active-id lags during load.
    }
    await this.forceWasmRender();
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

async function ensureWasmImageDataGeometry(
  input: VtkWasmObject,
  brickPlan?: WasmVtkVolumeBrickPlan
): Promise<void> {
  let dims = (await invoke(input, 'getDimensions')) as number[] | undefined;
  const dim0 = Array.isArray(dims) ? Number(dims[0]) : 0;
  if (!dim0 && brickPlan?.dimensions) {
    const [dx, dy, dz] = brickPlan.dimensions;
    const extent = [0, dx - 1, 0, dy - 1, 0, dz - 1];
    console.warn(
      `[vtkWasm] MPR forcing ImageData extent=${extent.join(',')} before setInputData`
    );
    await setVtkWasmImageDataExtent(input, extent);
    await invoke(input, 'modified');
  }
}

async function getSlicePlaneOrigin(
  slicePlane: VtkWasmObject | undefined,
  fallback: [number, number, number]
): Promise<[number, number, number]> {
  if (!slicePlane) {
    return fallback;
  }
  const origin = (await invoke(slicePlane, 'getOrigin')) as
    | number[]
    | undefined;
  if (origin && origin.length >= 3) {
    const pt: [number, number, number] = [
      Number(origin[0]),
      Number(origin[1]),
      Number(origin[2]),
    ];
    if (pt.every((v) => Number.isFinite(v))) {
      return pt;
    }
  }
  return fallback;
}

function windowLevelSliceToRgba(
  slice: ArrayLike<number>,
  window: number,
  level: number
): Uint8ClampedArray {
  const lower = level - window / 2;
  const rgba = new Uint8ClampedArray(slice.length * 4);
  for (let i = 0; i < slice.length; i++) {
    const hu = Number(slice[i]);
    let g = ((hu - lower) / window) * 255;
    if (g < 0) {
      g = 0;
    } else if (g > 255) {
      g = 255;
    }
    const o = i * 4;
    rgba[o] = g;
    rgba[o + 1] = g;
    rgba[o + 2] = g;
    rgba[o + 3] = 255;
  }
  return rgba;
}

/** Mid-volume world point, respecting patient direction when available. */
function getVolumeMidWorld(
  imageVolume: IImageVolume
): [number, number, number] {
  const dims = imageVolume.dimensions as [number, number, number];
  const midIjk: [number, number, number] = [
    0.5 * (dims[0] - 1),
    0.5 * (dims[1] - 1),
    0.5 * (dims[2] - 1),
  ];
  const imageData = imageVolume.imageData as
    | {
        indexToWorld?: (
          ijk: [number, number, number]
        ) => [number, number, number] | ArrayLike<number>;
      }
    | undefined;
  if (typeof imageData?.indexToWorld === 'function') {
    const w = imageData.indexToWorld(midIjk);
    return [Number(w[0]), Number(w[1]), Number(w[2])];
  }
  const origin = imageVolume.origin as [number, number, number];
  const spacing = imageVolume.spacing as [number, number, number];
  const direction = imageVolume.direction as number[] | undefined;
  if (direction && direction.length >= 9) {
    const d = direction;
    const [i, j, k] = midIjk;
    const [sx, sy, sz] = spacing;
    return [
      origin[0] + (d[0] * i * sx + d[1] * j * sy + d[2] * k * sz),
      origin[1] + (d[3] * i * sx + d[4] * j * sy + d[5] * k * sz),
      origin[2] + (d[6] * i * sx + d[7] * j * sy + d[8] * k * sz),
    ];
  }
  return [
    origin[0] + midIjk[0] * spacing[0],
    origin[1] + midIjk[1] * spacing[1],
    origin[2] + midIjk[2] * spacing[2],
  ];
}
