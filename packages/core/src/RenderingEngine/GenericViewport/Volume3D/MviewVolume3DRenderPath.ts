import {
  VolumeRenderer,
  convertScalarVolumeToHalfFloatChunk,
  buildMaxTextureResamplePlan,
  buildZSkipDstToSrcMap,
  normalizeMaxTextureReduceMode,
  resampleScalarVolumeNearest,
} from '@mview/webgpu-volume-standalone';
import { Events, ViewportType } from '../../../enums';
import eventTarget from '../../../eventTarget';
import type { IImageData, IImageVolume } from '../../../types';
import cache from '../../../cache/cache';
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
  iCameraToMviewCamera,
  pitchVolume3DCameraUp90,
} from './mviewVolume3DCamera';
import { computeVisibleVolumeRoi } from './mviewVolume3DRoi';
import { isStatsOverlayVisible } from '../../helpers/stats/toggleStatsOverlay';
import {
  applyMviewVolume3DPreset,
  flushMviewVolume3DPendingPreset,
  reapplyMviewVolume3DPreset,
  MVIEW_DEFAULT_PRESENT_QUALITY,
  MVIEW_DEFAULT_TARGET_FPS,
  getMviewVolume3DPresentQuality,
  getMviewVolume3DProjection,
  getMviewVolume3D,
  getMviewVolume3DTargetFps,
  getMviewVolume3DTargetFpsEnabled,
  registerMviewVolume3D,
  setMviewVolume3DPresentQuality,
  setMviewVolume3DTargetFps,
  setMviewVolume3DTargetFpsEnabled,
  setMviewVolume3DValueRange,
  unregisterMviewVolume3D,
} from './mviewVolume3DRegistry';
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
const PROGRESSIVE_FRAME_SLICE_BUDGET = 5;
const PROGRESSIVE_BURST_DEBOUNCE_MS = 40;
const PROGRESSIVE_RENDER_MIN_INTERVAL_MS = 500;
const PROGRESSIVE_LOG_EVERY_UPDATES = 30;
/** Reveal as soon as this many authoritative slices are on the GPU. */
const PROGRESSIVE_EARLY_REVEAL_MIN_SLICES = 1;

type VolumeDims3 = [number, number, number];
type MaxTextureReduceMode = 'uniform' | 'zSkip';
type VolumeResamplePlan = {
  enabled: boolean;
  mode: MaxTextureReduceMode;
  originalDimensions: VolumeDims3;
  targetDimensions: VolumeDims3;
  targetSpacing: VolumeDims3;
  uniformScale: number;
  maxTextureDimension3D: number;
  strideZ?: number;
  dstToSrcZ?: Uint32Array;
  forcedUniformReason?: string;
};

function normalizeVolumeDims(
  dimensions: number[] | undefined
): VolumeDims3 | undefined {
  if (!dimensions || dimensions.length < 3) {
    return;
  }
  const normalized = dimensions.slice(0, 3).map((value) => Math.floor(value));
  if (normalized.some((value) => !Number.isFinite(value) || value <= 0)) {
    return;
  }
  return normalized as VolumeDims3;
}

function normalizeVolumeSpacing(
  spacing: number[] | undefined
): VolumeDims3 | undefined {
  if (!spacing || spacing.length < 3) {
    return;
  }
  const normalized = spacing
    .slice(0, 3)
    .map((value) => Number(value))
    .map((value) => (Number.isFinite(value) && value > 0 ? value : 1));
  return normalized as VolumeDims3;
}

function getRendererTextureLimit(renderer: VolumeRenderer): number {
  const withGetter = renderer as unknown as {
    getMaxTextureDimension3D?: () => number;
    device?: { limits?: { maxTextureDimension3D?: number } };
  };
  if (typeof withGetter.getMaxTextureDimension3D === 'function') {
    const effective = Number(withGetter.getMaxTextureDimension3D());
    if (Number.isFinite(effective) && effective > 0) {
      return effective;
    }
  }
  const candidate = withGetter.device?.limits?.maxTextureDimension3D;
  if (Number.isFinite(candidate) && (candidate as number) > 0) {
    return candidate as number;
  }
  return 2048;
}

function resolveMaxTextureReduceMode(): MaxTextureReduceMode {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(
      'maxTextureReduce'
    );
    if (fromUrl) {
      return normalizeMaxTextureReduceMode(fromUrl) as MaxTextureReduceMode;
    }
  } catch {
    // ignore
  }
  return 'zSkip';
}

/** Default on (center-out); `?progressiveZ=off` restores FIFO upload order. */
function isProgressiveCenterOutEnabled(): boolean {
  try {
    const value = new URLSearchParams(window.location.search).get(
      'progressiveZ'
    );
    if (value === 'off' || value === '0' || value === 'false') {
      return false;
    }
  } catch {
    // ignore
  }
  return true;
}

/**
 * Pull up to `budget` indices from `readyQueue` in center-out order.
 * Mutates `readyQueue`.
 */
function pickCenterOutSlices(
  readyQueue: number[],
  budget: number,
  depth: number,
  enabled: boolean
): number[] {
  if (!readyQueue.length || budget <= 0) {
    return [];
  }
  if (!enabled) {
    return readyQueue.splice(0, budget);
  }

  const center = Math.max(0, depth - 1) / 2;
  readyQueue.sort((a, b) => {
    const da = Math.abs(a - center);
    const db = Math.abs(b - center);
    if (da !== db) {
      return da - db;
    }
    return a - b;
  });
  return readyQueue.splice(0, budget);
}

function progressiveEarlyRevealThreshold(_depth: number): number {
  return PROGRESSIVE_EARLY_REVEAL_MIN_SLICES;
}

type ZSkipProgressiveUploadBatch = {
  data: ArrayBufferView;
  dimensions: [number, number, number];
  sliceIndices: number[];
};

function isZSkipResamplePlan(
  plan: VolumeResamplePlan | undefined
): plan is VolumeResamplePlan & { mode: 'zSkip' } {
  return Boolean(plan?.enabled && plan.mode === 'zSkip');
}

/**
 * Pack only the source Z planes needed for this progressive batch (zSkip).
 * Avoids a full native `srcProgressiveData` buffer.
 */
function buildZSkipProgressiveUploadBatch(
  srcZs: number[],
  srcW: number,
  srcH: number,
  sourceSliceSize: number,
  readSlice: (z: number) => ArrayLike<number> | undefined
): ZSkipProgressiveUploadBatch | undefined {
  if (!srcZs.length || !(sourceSliceSize > 0)) {
    return undefined;
  }

  const srcZToCompact = new Map<number, number>();
  const uniqueSrcZs: number[] = [];
  const remappedIndices: number[] = [];

  for (const z of srcZs) {
    const srcZ = Math.floor(Number(z));
    if (!Number.isFinite(srcZ)) {
      remappedIndices.push(0);
      continue;
    }
    let compact = srcZToCompact.get(srcZ);
    if (compact === undefined) {
      compact = uniqueSrcZs.length;
      srcZToCompact.set(srcZ, compact);
      uniqueSrcZs.push(srcZ);
    }
    remappedIndices.push(compact);
  }

  const uniqueCount = uniqueSrcZs.length;
  if (!uniqueCount) {
    return undefined;
  }

  const firstSlice = readSlice(uniqueSrcZs[0]);
  if (!firstSlice || firstSlice.length !== sourceSliceSize) {
    return undefined;
  }

  const Ctor = firstSlice.constructor as
    | (new (length: number) => ArrayBufferView & {
        set: (array: ArrayLike<number>, offset?: number) => void;
      })
    | undefined;
  if (!Ctor) {
    return undefined;
  }

  const scratch = new Ctor(sourceSliceSize * uniqueCount);
  for (let i = 0; i < uniqueSrcZs.length; i++) {
    const slice = readSlice(uniqueSrcZs[i]);
    if (!slice || slice.length !== sourceSliceSize) {
      return undefined;
    }
    scratch.set(slice as ArrayLike<number>, i * sourceSliceSize);
  }

  return {
    data: scratch,
    dimensions: [srcW, srcH, uniqueCount],
    sliceIndices: remappedIndices,
  };
}

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
  private volumeResamplePlan?: VolumeResamplePlan;
  private didLogResamplePlan = false;
  private dstScalarData?: Float32Array;
  private uploadedDstSlices?: Uint8Array;
  private dstToSrcZ?: Uint32Array;
  private srcToDstZ?: number[][];
  private srcXForDstX?: Uint32Array;
  private srcYForDstY?: Uint32Array;
  private renderContext?: Volume3DViewportRenderContext;
  private imageVolume?: IImageVolume;
  private fullVolumeCenter?: [number, number, number];
  private fullVolumePhysicalMax?: number;
  private lastViewState?: Partial<Volume3DCamera>;
  private resolveSourceScalarData?: () => ArrayLike<number> | undefined;
  private areSourceSlicesReady?: (
    ijkMin: number[],
    ijkMax: number[]
  ) => boolean;
  private readValueRange?: () => [number, number] | undefined;
  /** One-shot native scalar buffer for ROI refine (avoid rematerialize every settle). */
  private cachedNativeScalars?: ArrayLike<number>;
  /** Full native volume as HU-normalized r16float (built once after load). */
  private nativeR16?: Uint16Array;
  private nativeR16Complete = false;
  private nativeR16Z = 0;
  private nativeR16Raf = 0;
  private nativeR16Generation = 0;
  /** Clears progressive scalar assembly once nativeR16 is complete. */
  private releaseNativeScalarAssembly?: () => void;

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

    const maxTextureReduceMode = resolveMaxTextureReduceMode();
    const progressiveZEnabled = isProgressiveCenterOutEnabled();
    const renderer = new VolumeRenderer(canvas, {
      // Match OHIF Volume3D defaults (CT-Bone composite DVR).
      mode: 'composite',
      threshold: 0.35,
      opacity: 1,
      shade: true,
      background: [0, 0, 0],
      targetFps: MVIEW_DEFAULT_TARGET_FPS,
      targetFpsLearnEnabled: false,
      handleMaxTexture: true,
      maxTextureReduceMode,
      camera: {
        projection: 'orthographic',
        zoom: 0.55,
      },
      statsOverlayEnabled: isStatsOverlayVisible(),
      onViewVolumeLayoutChanged: () => {
        this.renderer?.requestRender();
        this.renderContext?.display.renderNow();
      },
    });
    await renderer.initialize();
    this.canvas = canvas;
    this.renderer = renderer;
    this.volumeUploaded = false;
    this.viewportId = ctx.viewportId;
    this.volumeResamplePlan = undefined;
    this.didLogResamplePlan = false;
    this.renderContext = ctx;
    this.imageVolume = imageVolume;
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
    this.fullVolumeCenter = this.volumeCenter
      ? [...this.volumeCenter]
      : undefined;
    this.fullVolumePhysicalMax = this.volumePhysicalMax;

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
    const sourceDimensions = normalizeVolumeDims(dimensions);
    const sourceSpacing = normalizeVolumeSpacing(
      imageVolume.spacing ?? imageVolume.imageData?.getSpacing?.()
    );
    if (sourceDimensions && sourceSpacing) {
      // Plan before progressive uploads so zSkip never allocates srcProgressiveData.
      this.getOrCreateVolumeResamplePlan(
        renderer,
        sourceDimensions,
        sourceSpacing
      );
    }
    const sourceDepth =
      dimensions && dimensions.length >= 3 ? dimensions[2] : 0;
    const uploadedSourceSlices =
      sourceDepth > 0 ? new Uint8Array(sourceDepth) : new Uint8Array(0);
    const pendingSourceSliceQueue: number[] = [];
    const pendingDstSliceQueue: number[] = [];
    let srcProgressiveData:
      | (ArrayLike<number> & {
          set?: (array: ArrayLike<number>, offset?: number) => void;
        })
      | undefined;
    let sourceSliceSize = 0;
    let progressiveFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let progressiveUpdateCount = 0;
    let progressivePrepMsTotal = 0;
    let progressiveUploadMsTotal = 0;
    // Only used when downsample mode is enabled.
    let uploadedDstCount = 0;
    /** True after a full setVolume with complete CPU scalars + final HU range. */
    let gpuVolumeFinalized = false;
    /** First range used for preview patches + TF; later slices keep this window. */
    let previewValueRange: [number, number] | undefined;
    let overviewCanvasRevealed = false;
    let lastProgressiveRenderMs = 0;

    const countUploadedSourceSlices = () => {
      let count = 0;
      for (let i = 0; i < uploadedSourceSlices.length; i++) {
        if (uploadedSourceSlices[i]) {
          count += 1;
        }
      }
      return count;
    };

    const isGpuVolumeComplete = () => {
      if (this.volumeResamplePlan?.enabled) {
        const dstDepth = this.volumeResamplePlan.targetDimensions[2];
        return dstDepth > 0 && uploadedDstCount >= dstDepth;
      }
      return sourceDepth > 0 && countUploadedSourceSlices() >= sourceDepth;
    };

    const markAllSlicesUploaded = () => {
      if (this.volumeResamplePlan?.enabled) {
        const dstDepth = this.volumeResamplePlan.targetDimensions[2];
        this.uploadedDstSlices?.fill(1);
        uploadedDstCount = dstDepth;
        return;
      }
      uploadedSourceSlices.fill(1);
    };

    const isCpuVolumeComplete = () =>
      Boolean(
        (imageVolume as { loadStatus?: { loaded?: boolean } }).loadStatus
          ?.loaded
      );

    const revealCanvas = () => {
      canvas.style.visibility = '';
    };

    const readLiveValueRange = (): [number, number] | undefined => {
      const voxelManager = imageVolume.voxelManager as
        | { getRange?: () => number[] }
        | undefined;
      const range = voxelManager?.getRange?.();
      return range && range.length === 2
        ? ([range[0], range[1]] as [number, number])
        : undefined;
    };

    const syncPreviewValueRange = () => {
      const live = readLiveValueRange();
      if (!previewValueRange && live) {
        previewValueRange = live;
        if (this.viewportId) {
          setMviewVolume3DValueRange(this.viewportId, previewValueRange);
          flushMviewVolume3DPendingPreset(this.viewportId);
        }
      }
      return previewValueRange ?? live;
    };

    this.readValueRange = () => syncPreviewValueRange();
    this.resolveSourceScalarData = () => {
      // zSkip: ROI refine reads per-slice from CS cache — never materialize full volume.
      if (isZSkipResamplePlan(this.volumeResamplePlan)) {
        return undefined;
      }
      // After native r16float is ready, ROI refine uses getNativeR16 — drop the
      // duplicate full-res scalar assembly from this path.
      if (this.nativeR16Complete && this.nativeR16) {
        return undefined;
      }
      // Progressive assembly (may be partial) — refine gates on areSourceSlicesReady.
      if (srcProgressiveData) {
        return srcProgressiveData;
      }
      if (this.cachedNativeScalars) {
        return this.cachedNativeScalars;
      }
      if (isCpuVolumeComplete()) {
        const scalars = getVolumeScalarArray(imageVolume) ?? undefined;
        if (scalars) {
          this.cachedNativeScalars = scalars;
        }
        return scalars;
      }
      return undefined;
    };
    this.areSourceSlicesReady = (ijkMin, ijkMax) => {
      if (!uploadedSourceSlices.length || sourceDepth <= 0) {
        return false;
      }
      const k0 = Math.max(0, Math.floor(Number(ijkMin?.[2]) || 0));
      const k1 = Math.min(
        sourceDepth - 1,
        Math.floor(Number(ijkMax?.[2]) || 0)
      );
      if (k1 < k0) {
        return false;
      }
      for (let k = k0; k <= k1; k++) {
        if (!uploadedSourceSlices[k]) {
          return false;
        }
      }
      return true;
    };

    const releaseNativeScalarAssembly = () => {
      srcProgressiveData = undefined;
      this.cachedNativeScalars = undefined;
    };
    this.releaseNativeScalarAssembly = releaseNativeScalarAssembly;

    const runUpload = <T>(task: () => Promise<T>): Promise<T> => {
      const next = uploadQueue.then(task, task);
      uploadQueue = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    };

    /** Pause progressive slice work while the user drags/zooms or ROI reload runs. */
    const isProgressiveLoadPaused = () => {
      const stats = renderer.getStats?.();
      return Boolean(stats?.interacting || stats?.volumeWorkBusy);
    };

    const scheduleProgressiveRefresh = () => {
      if (streamingClosed || progressiveRaf || progressiveFlushTimer) {
        return;
      }
      progressiveFlushTimer = setTimeout(() => {
        progressiveFlushTimer = null;
        progressiveRaf = requestAnimationFrame(() => {
          progressiveRaf = 0;
          if (streamingClosed) {
            return;
          }
          if (isProgressiveLoadPaused()) {
            scheduleProgressiveRefresh();
            return;
          }
          void runUpload(async () => uploadNewSlices()).then(revealIfUploaded);
        });
      }, PROGRESSIVE_BURST_DEBOUNCE_MS);
    };

    const resumeProgressiveLoad = () => {
      if (!streamingClosed && !isProgressiveLoadPaused()) {
        scheduleProgressiveRefresh();
      }
    };

    const prevOnInteractionEnd = (
      renderer as VolumeRenderer & {
        options?: { onInteractionEnd?: () => void };
      }
    ).options?.onInteractionEnd;
    (
      renderer as VolumeRenderer & {
        options: { onInteractionEnd?: () => void };
      }
    ).options.onInteractionEnd = () => {
      prevOnInteractionEnd?.();
      resumeProgressiveLoad();
    };

    const prevOnViewVolumeLayoutChanged = (
      renderer as VolumeRenderer & {
        options?: {
          onViewVolumeLayoutChanged?: (info?: {
            volumeWorkBusy?: boolean;
          }) => void;
        };
      }
    ).options?.onViewVolumeLayoutChanged;
    (
      renderer as VolumeRenderer & {
        options: {
          onViewVolumeLayoutChanged?: (info?: {
            volumeWorkBusy?: boolean;
          }) => void;
        };
      }
    ).options.onViewVolumeLayoutChanged = (info) => {
      prevOnViewVolumeLayoutChanged?.(info);
      if (info?.volumeWorkBusy !== true) {
        resumeProgressiveLoad();
      }
    };

    const appendUnique = (queue: number[], items: number[]) => {
      for (const item of items) {
        if (!queue.includes(item)) {
          queue.push(item);
        }
      }
    };

    const collectNewSourceSlices = (): number[] => {
      if (
        !sourceDimensions ||
        sourceDepth <= 0 ||
        !Array.isArray(imageVolume.imageIds)
      ) {
        return [];
      }
      const [srcW, srcH] = sourceDimensions;
      const sourceImageIds = imageVolume.imageIds;
      const newSourceIndices: number[] = [];

      for (let z = 0; z < sourceDepth; z++) {
        if (uploadedSourceSlices[z]) {
          continue;
        }
        const imageId = sourceImageIds[z];
        if (!imageId) {
          continue;
        }
        const image = cache.getImage(imageId);
        const sliceVm = image?.voxelManager as
          | { getScalarData?: () => ArrayLike<number> }
          | undefined;
        if (!sliceVm?.getScalarData) {
          continue;
        }
        let pixelData: ArrayLike<number> | undefined;
        try {
          pixelData = sliceVm.getScalarData();
        } catch {
          continue;
        }
        if (!pixelData || pixelData.length <= 0) {
          continue;
        }

        if (!sourceSliceSize) {
          const inferredComponents = Math.max(
            1,
            Math.round(pixelData.length / Math.max(srcW * srcH, 1))
          );
          sourceSliceSize = srcW * srcH * inferredComponents;
        }
        const zSkipProgressive = isZSkipResamplePlan(this.volumeResamplePlan);
        if (!zSkipProgressive) {
          if (!srcProgressiveData) {
            const ctor = pixelData.constructor as
              | (new (length: number) => ArrayLike<number> & {
                  set: (array: ArrayLike<number>, offset?: number) => void;
                })
              | undefined;
            if (!ctor) {
              continue;
            }
            srcProgressiveData = new ctor(sourceSliceSize * sourceDepth);
          }
          if (
            !srcProgressiveData?.set ||
            pixelData.length !== sourceSliceSize
          ) {
            continue;
          }
          srcProgressiveData.set(pixelData, z * sourceSliceSize);
        } else if (pixelData.length !== sourceSliceSize) {
          continue;
        }

        uploadedSourceSlices[z] = 1;
        newSourceIndices.push(z);
      }

      return newSourceIndices;
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

    const getProgressiveUploadDepth = () => {
      if (this.volumeResamplePlan?.enabled) {
        return this.volumeResamplePlan.targetDimensions[2];
      }
      return sourceDepth;
    };

    const getProgressiveUploadedCount = () => {
      if (this.volumeResamplePlan?.enabled) {
        return uploadedDstCount;
      }
      return countUploadedSourceSlices();
    };

    const resolveProgressiveRenderMinIntervalMs = () => {
      try {
        const fromUrl = new URLSearchParams(window.location.search).get(
          'progressiveRenderFps'
        );
        if (fromUrl) {
          const fps = Number(fromUrl);
          if (Number.isFinite(fps) && fps > 0) {
            return 1000 / fps;
          }
        }
      } catch {
        // ignore
      }
      return PROGRESSIVE_RENDER_MIN_INTERVAL_MS;
    };

    const revealIfUploaded = (uploaded: boolean) => {
      if (!uploaded || !this.renderer) {
        return;
      }
      this.volumeUploaded = true;
      applyPostLoadPitchIfNeeded();

      const depth = getProgressiveUploadDepth();
      const count = getProgressiveUploadedCount();
      const shouldReveal =
        !progressiveZEnabled ||
        overviewCanvasRevealed ||
        gpuVolumeFinalized ||
        isGpuVolumeComplete() ||
        count >= progressiveEarlyRevealThreshold(depth);

      const isFirstReveal = shouldReveal && !overviewCanvasRevealed;

      if (shouldReveal) {
        if (isFirstReveal) {
          console.debug(
            `[MviewVolume3D] progressive center-out early reveal ` +
              `uploaded=${count}/${depth}`
          );
        }
        overviewCanvasRevealed = true;
        revealCanvas();
        this.renderer.refreshVisibleRoiStats?.();
      }

      const forceRender =
        isFirstReveal ||
        gpuVolumeFinalized ||
        isGpuVolumeComplete() ||
        !progressiveZEnabled;
      const now = performance.now();
      const shouldRenderNow =
        forceRender ||
        now - lastProgressiveRenderMs >=
          resolveProgressiveRenderMinIntervalMs();

      if (shouldRenderNow && !isProgressiveLoadPaused()) {
        lastProgressiveRenderMs = now;
        this.renderer.requestRender();
      }
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
      if (isProgressiveLoadPaused()) {
        scheduleProgressiveRefresh();
        return false;
      }

      this.resizeCanvas(canvas, ctx.viewport.element);
      const prepStarted = performance.now();
      const newSourceIndices = collectNewSourceSlices();
      if (newSourceIndices.length) {
        appendUnique(pendingSourceSliceQueue, newSourceIndices);
      }
      const prepElapsedMs = performance.now() - prepStarted;

      const valueRange = syncPreviewValueRange();
      const downsampled = this.volumeResamplePlan?.enabled;

      if (downsampled) {
        const isZSkip = this.volumeResamplePlan.mode === 'zSkip';
        if (
          !this.uploadedDstSlices ||
          !this.dstToSrcZ ||
          !this.srcToDstZ ||
          (!isZSkip &&
            (!this.dstScalarData || !this.srcXForDstX || !this.srcYForDstY))
        ) {
          return false;
        }

        const srcDims = this.volumeResamplePlan.originalDimensions;
        const dstDims = this.volumeResamplePlan.targetDimensions;

        const [srcW, srcH, srcD] = srcDims;
        const [dstW, dstH] = dstDims;
        const srcPlane = srcW * srcH;
        const dstPlane = dstW * dstH;
        const srcAsArray = srcProgressiveData as unknown as {
          [index: number]: number;
        };

        const readSourceSlice = (z: number): ArrayLike<number> | undefined => {
          if (z < 0 || z >= srcD || !Array.isArray(imageVolume.imageIds)) {
            return undefined;
          }
          const imageId = imageVolume.imageIds[z];
          if (!imageId) {
            return undefined;
          }
          const image = cache.getImage(imageId);
          const sliceVm = image?.voxelManager as
            | { getScalarData?: () => ArrayLike<number> }
            | undefined;
          try {
            return sliceVm?.getScalarData?.();
          } catch {
            return undefined;
          }
        };

        if (!isZSkip && (!srcProgressiveData || !sourceSliceSize)) {
          return false;
        }
        if (isZSkip && !sourceSliceSize) {
          return false;
        }

        const mappedNewDstIndices: number[] = [];
        for (const zSrc of newSourceIndices) {
          if (zSrc < 0 || zSrc >= srcD) {
            continue;
          }
          const mapped = this.srcToDstZ[zSrc] ?? [];
          for (const zDst of mapped) {
            if (this.uploadedDstSlices[zDst] === 0) {
              mappedNewDstIndices.push(zDst);
            }
          }
        }
        if (mappedNewDstIndices.length) {
          appendUnique(pendingDstSliceQueue, mappedNewDstIndices);
        }
        const pendingDstIndices = pickCenterOutSlices(
          pendingDstSliceQueue,
          PROGRESSIVE_FRAME_SLICE_BUDGET,
          dstDims[2],
          progressiveZEnabled
        );

        if (pendingDstIndices.length === 0) {
          return isGpuVolumeComplete();
        }

        try {
          const uploadStarted = performance.now();
          const destZs = pendingDstIndices;
          const srcZs = pendingDstIndices.map((z) => this.dstToSrcZ![z]);

          if (isZSkip) {
            const batch = buildZSkipProgressiveUploadBatch(
              srcZs,
              srcW,
              srcH,
              sourceSliceSize,
              readSourceSlice
            );
            if (!batch) {
              return false;
            }
            await this.renderer.updateVolumeSlices({
              data: batch.data,
              dimensions: batch.dimensions,
              sliceIndices: batch.sliceIndices,
              destSliceIndices: destZs,
              valueRange,
              requestRender: false,
            });
          } else {
            // Uniform: downsample only the affected destination slices on the CPU,
            // then let VolumeRenderer convert scalar -> r16float for GPU upload.
            for (let i = 0; i < destZs.length; i++) {
              const zDst = destZs[i];
              const zSrcMapped = srcZs[i];
              const srcSliceBase = zSrcMapped * srcPlane;
              const dstSliceBase = zDst * dstPlane;
              for (let yDst = 0; yDst < dstH; yDst++) {
                const ySrc = this.srcYForDstY![yDst];
                const dstRowBase = dstSliceBase + yDst * dstW;
                const srcRowBase = srcSliceBase + ySrc * srcW;
                for (let xDst = 0; xDst < dstW; xDst++) {
                  const xSrc = this.srcXForDstX![xDst];
                  const dstIndex = dstRowBase + xDst;
                  const srcIndex = srcRowBase + xSrc;
                  const value = srcAsArray[srcIndex];
                  this.dstScalarData![dstIndex] = Number.isFinite(value)
                    ? value
                    : 0;
                }
              }
            }

            await this.renderer.updateVolumeSlices({
              data: this.dstScalarData as unknown as ArrayBufferView,
              dimensions: dstDims,
              sliceIndices: destZs,
              valueRange,
              requestRender: false,
            });
          }
          const uploadElapsedMs = performance.now() - uploadStarted;

          // Mark authoritative slices uploaded.
          for (const zDst of pendingDstIndices) {
            if (this.uploadedDstSlices[zDst] === 0) {
              this.uploadedDstSlices[zDst] = 1;
              uploadedDstCount += 1;
            }
          }
          if (pendingDstSliceQueue.length > 0) {
            scheduleProgressiveRefresh();
          }
          progressiveUpdateCount += 1;
          progressivePrepMsTotal += prepElapsedMs;
          progressiveUploadMsTotal += uploadElapsedMs;
          if (progressiveUpdateCount % PROGRESSIVE_LOG_EVERY_UPDATES === 0) {
            console.debug(
              `[MviewVolume3D] progressive ${isZSkip ? 'zSkip' : 'downsample'} avg prep=${(
                progressivePrepMsTotal / progressiveUpdateCount
              ).toFixed(2)}ms avg upload=${(
                progressiveUploadMsTotal / progressiveUpdateCount
              ).toFixed(2)}ms`
            );
          }
          return true;
        } catch (error) {
          console.error('[MviewVolume3D] updateVolumeSlices failed', error);
          return false;
        }
      }

      if (!srcProgressiveData || !sourceDimensions) {
        return false;
      }
      const newIndices = pickCenterOutSlices(
        pendingSourceSliceQueue,
        PROGRESSIVE_FRAME_SLICE_BUDGET,
        sourceDepth,
        progressiveZEnabled
      );
      if (newIndices.length === 0) {
        return isGpuVolumeComplete();
      }

      try {
        const uploadStarted = performance.now();
        const destZs = newIndices;
        const srcZs = newIndices;
        await this.renderer.updateVolumeSlices({
          data: srcProgressiveData as unknown as ArrayBufferView,
          dimensions: sourceDimensions,
          sliceIndices: srcZs,
          destSliceIndices: destZs,
          valueRange,
          requestRender: false,
        });
        for (const z of newIndices) {
          uploadedSourceSlices[z] = 1;
        }
        const uploadElapsedMs = performance.now() - uploadStarted;
        if (pendingSourceSliceQueue.length > 0) {
          scheduleProgressiveRefresh();
        }
        progressiveUpdateCount += 1;
        progressivePrepMsTotal += prepElapsedMs;
        progressiveUploadMsTotal += uploadElapsedMs;
        if (progressiveUpdateCount % PROGRESSIVE_LOG_EVERY_UPDATES === 0) {
          console.debug(
            `[MviewVolume3D] progressive direct avg prep=${(
              progressivePrepMsTotal / progressiveUpdateCount
            ).toFixed(2)}ms avg upload=${(
              progressiveUploadMsTotal / progressiveUpdateCount
            ).toFixed(2)}ms`
          );
        }
        return true;
      } catch (error) {
        console.error('[MviewVolume3D] updateVolumeSlices failed', error);
        return false;
      }
    };

    const finishStreaming = async (reason: string) => {
      if (gpuVolumeFinalized) {
        return;
      }

      const uploaded = await runUpload(async () => {
        if (gpuVolumeFinalized) {
          return true;
        }
        if (!isCpuVolumeComplete()) {
          return uploadNewSlices();
        }
        const full = await this.uploadVolume(this.renderer!, imageVolume);
        if (full) {
          markAllSlicesUploaded();
          gpuVolumeFinalized = true;
          streamingClosed = true;
          if (progressiveRaf) {
            cancelAnimationFrame(progressiveRaf);
            progressiveRaf = 0;
          }
          if (progressiveFlushTimer) {
            clearTimeout(progressiveFlushTimer);
            progressiveFlushTimer = null;
          }
          this.renderer?.setProgressivePreviewActive?.(false);
          revealIfUploaded(true);
          kickNativeR16IfReady();
          this.renderer?.prewarmInteractivePresent?.();
        }
        return full;
      });

      if (gpuVolumeFinalized) {
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

    const kickNativeR16IfReady = () => {
      // zSkip: skip full native r16 cache; ROI converts from CS scalars on demand.
      if (isZSkipResamplePlan(this.volumeResamplePlan)) {
        this.releaseNativeScalarAssembly?.();
        this.nativeR16 = undefined;
        this.nativeR16Complete = false;
        return;
      }
      if (this.nativeR16Complete) {
        return;
      }
      const dims =
        sourceDimensions ??
        (this.volumeResamplePlan?.originalDimensions as
          | [number, number, number]
          | undefined);
      if (!dims || dims.length !== 3) {
        return;
      }
      const scalars = this.resolveSourceScalarData?.();
      if (!scalars) {
        return;
      }
      // Progressive buffer is full-length while still filling; convert only when
      // every source K is present (or native path already complete elsewhere).
      if (
        this.areSourceSlicesReady &&
        !this.areSourceSlicesReady(
          [0, 0, 0],
          [dims[0] - 1, dims[1] - 1, dims[2] - 1]
        )
      ) {
        return;
      }
      this.scheduleNativeR16Convert(
        scalars,
        [dims[0], dims[1], dims[2]],
        this.readValueRange?.()
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
    renderer.setProgressivePreviewActive?.(true);
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
        if (progressiveFlushTimer) {
          clearTimeout(progressiveFlushTimer);
          progressiveFlushTimer = null;
        }
        streamingClosed = true;
        this.renderer?.setProgressivePreviewActive?.(false);
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
    this.lastViewState = viewState;
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
    this.renderContext = undefined;
    this.imageVolume = undefined;
    this.resolveSourceScalarData = undefined;
    this.areSourceSlicesReady = undefined;
    this.readValueRange = undefined;
    this.cachedNativeScalars = undefined;
    this.releaseNativeScalarAssembly = undefined;
    this.stopNativeR16Convert();
    this.nativeR16 = undefined;
    this.nativeR16Complete = false;
    this.nativeR16Z = 0;
    this.lastViewState = undefined;
    this.dstScalarData = undefined;
    this.uploadedDstSlices = undefined;
    this.dstToSrcZ = undefined;
    this.srcToDstZ = undefined;
    this.srcXForDstX = undefined;
    this.srcYForDstY = undefined;

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

  private updateRegistryFraming(): void {
    if (!this.viewportId) {
      return;
    }
    const existing = getMviewVolume3D(this.viewportId);
    if (!existing) {
      return;
    }
    registerMviewVolume3D(this.viewportId, {
      ...existing,
      volumePhysicalMax: this.volumePhysicalMax,
      volumeCenter: this.volumeCenter,
    });
  }

  /** Read one native source Z plane from the CS image cache (no full-volume copy). */
  private readImageVolumeSourceSlice(z: number): ArrayLike<number> | undefined {
    const imageVolume = this.imageVolume;
    if (!imageVolume || !Array.isArray(imageVolume.imageIds)) {
      return undefined;
    }
    const dimensions = normalizeVolumeDims(
      imageVolume.dimensions ?? imageVolume.imageData?.getDimensions?.()
    );
    if (!dimensions || dimensions.length < 3) {
      return undefined;
    }
    const sourceDepth = dimensions[2];
    if (z < 0 || z >= sourceDepth) {
      return undefined;
    }
    const imageId = imageVolume.imageIds[z];
    if (!imageId) {
      return undefined;
    }
    const image = cache.getImage(imageId);
    const sliceVm = image?.voxelManager as
      | { getScalarData?: () => ArrayLike<number> }
      | undefined;
    try {
      return sliceVm?.getScalarData?.();
    } catch {
      return undefined;
    }
  }

  private async finalizeZSkipDownsampleVolume(
    renderer: VolumeRenderer,
    plan: VolumeResamplePlan,
    valueRange: [number, number] | undefined
  ): Promise<boolean> {
    const dstDepth = plan.targetDimensions[2];
    const pendingDstSlices: number[] = [];
    if (this.uploadedDstSlices) {
      for (let z = 0; z < dstDepth; z++) {
        if (!this.uploadedDstSlices[z]) {
          pendingDstSlices.push(z);
        }
      }
    } else {
      for (let z = 0; z < dstDepth; z++) {
        pendingDstSlices.push(z);
      }
    }

    if (!pendingDstSlices.length) {
      return true;
    }

    const [srcW, srcH] = plan.originalDimensions;
    const dstToSrc =
      this.dstToSrcZ ??
      plan.dstToSrcZ ??
      buildZSkipDstToSrcMap(plan.originalDimensions[2], dstDepth);
    const srcZs = pendingDstSlices.map((zDst) => dstToSrc[zDst]);

    const firstSlice = this.readImageVolumeSourceSlice(srcZs[0] ?? 0);
    if (!firstSlice || firstSlice.length <= 0) {
      return false;
    }
    const sourceSliceSize = firstSlice.length;

    try {
      const batch = buildZSkipProgressiveUploadBatch(
        srcZs,
        srcW,
        srcH,
        sourceSliceSize,
        (z) => this.readImageVolumeSourceSlice(z)
      );
      if (!batch) {
        return false;
      }
      await renderer.updateVolumeSlices({
        data: batch.data,
        dimensions: batch.dimensions,
        sliceIndices: batch.sliceIndices,
        destSliceIndices: pendingDstSlices,
        valueRange,
      });
      if (this.uploadedDstSlices) {
        for (const z of pendingDstSlices) {
          this.uploadedDstSlices[z] = 1;
        }
      }
      return true;
    } catch (error) {
      console.error('[MviewVolume3D] zSkip finalize update failed', error);
      return false;
    }
  }

  private syncViewRefineSource(renderer: VolumeRenderer): void {
    const plan = this.volumeResamplePlan;
    const imageVolume = this.imageVolume;
    if (!plan?.enabled || !imageVolume) {
      return;
    }

    const spacing = normalizeVolumeSpacing(
      imageVolume.spacing ?? imageVolume.imageData?.getSpacing?.()
    );
    const imageData = imageVolume.imageData;
    if (!spacing || !imageData) {
      return;
    }

    const attach = (
      renderer as VolumeRenderer & {
        attachViewRefineSource?: (source: Record<string, unknown>) => void;
      }
    ).attachViewRefineSource;
    attach?.call(renderer, {
      sourceDimensions: plan.originalDimensions,
      sourceSpacing: spacing,
      getScalars: () => this.resolveSourceScalarData?.(),
      readSourceSlice:
        plan.mode === 'zSkip'
          ? (z: number) => this.readImageVolumeSourceSlice(z)
          : undefined,
      areSourceSlicesReady: (ijkMin: number[], ijkMax: number[]) =>
        this.areSourceSlicesReady?.(ijkMin, ijkMax) === true,
      getNativeR16: () =>
        this.nativeR16Complete && this.nativeR16 ? this.nativeR16 : undefined,
      getValueRange: () => this.readValueRange?.(),
      indexToWorld: (ijk: number[]) =>
        imageData.indexToWorld(ijk as [number, number, number]),
      label: imageVolume.volumeId,
      coarsePlan: plan,
      getCoarseScalars: () =>
        plan.mode === 'zSkip' ? undefined : this.dstScalarData,
      isCoarseComplete: () => this.isCoarseDstComplete(),
      releaseCoarseCpuBuffers: () => {
        if (plan.mode !== 'zSkip') {
          this.dstScalarData = undefined;
        }
        this.uploadedDstSlices = undefined;
        this.dstToSrcZ = undefined;
        this.srcToDstZ = undefined;
        this.srcXForDstX = undefined;
        this.srcYForDstY = undefined;
      },
      fullVolumeCenter: this.fullVolumeCenter,
      fullVolumePhysicalMax: this.fullVolumePhysicalMax,
      getVtkVisibleRoi: () => this.computeVtkVisibleVolumeRoi(),
    });
  }

  private stopNativeR16Convert(): void {
    this.nativeR16Generation += 1;
    if (this.nativeR16Raf) {
      cancelAnimationFrame(this.nativeR16Raf);
      this.nativeR16Raf = 0;
    }
  }

  /**
   * Background-convert complete native scalars to r16float so ROI refine is memcpy.
   * Does not block progressive coarse display or Target FPS probe.
   */
  private scheduleNativeR16Convert(
    scalars: ArrayLike<number>,
    dimensions: [number, number, number],
    valueRange: [number, number] | undefined
  ): void {
    if (isZSkipResamplePlan(this.volumeResamplePlan)) {
      this.nativeR16 = undefined;
      this.nativeR16Complete = false;
      this.releaseNativeScalarAssembly?.();
      return;
    }
    if (this.nativeR16Complete && this.nativeR16) {
      this.releaseNativeScalarAssembly?.();
      return;
    }
    const [w, h, d] = dimensions;
    const voxelCount = w * h * d;
    if (!(voxelCount > 0) || scalars.length < voxelCount) {
      return;
    }

    this.stopNativeR16Convert();
    const generation = this.nativeR16Generation;
    if (!this.nativeR16 || this.nativeR16.length !== voxelCount) {
      this.nativeR16 = new Uint16Array(voxelCount);
      this.nativeR16Z = 0;
    }
    this.nativeR16Complete = false;

    const slicesPerFrame = 12;
    const step = () => {
      this.nativeR16Raf = 0;
      if (generation !== this.nativeR16Generation || !this.nativeR16) {
        return;
      }
      // Pause while ROI reload or camera drag so convert does not fight uploads.
      const renderer = this.renderer;
      const stats = renderer?.getStats?.();
      if (stats?.volumeWorkBusy || stats?.interacting) {
        this.nativeR16Raf = requestAnimationFrame(step);
        return;
      }
      const remaining = d - this.nativeR16Z;
      if (remaining <= 0) {
        this.nativeR16Complete = true;
        this.releaseNativeScalarAssembly?.();
        return;
      }
      const count = Math.min(slicesPerFrame, remaining);
      try {
        convertScalarVolumeToHalfFloatChunk(
          scalars as unknown as ArrayBufferView,
          dimensions,
          valueRange,
          this.nativeR16Z,
          count,
          this.nativeR16
        );
      } catch (error) {
        console.warn('[MviewVolume3D] native r16 convert failed', error);
        this.nativeR16 = undefined;
        this.nativeR16Complete = false;
        return;
      }
      this.nativeR16Z += count;
      if (this.nativeR16Z >= d) {
        this.nativeR16Complete = true;
        this.releaseNativeScalarAssembly?.();
        return;
      }
      this.nativeR16Raf = requestAnimationFrame(step);
    };
    this.nativeR16Raf = requestAnimationFrame(step);
  }

  /** VTK/world frustum ∩ volume AABB → native IJK visible ROI at settle. */
  private computeVtkVisibleVolumeRoi() {
    const plan = this.volumeResamplePlan;
    const imageVolume = this.imageVolume;
    const ctx = this.renderContext;
    const imageData = imageVolume?.imageData;
    if (!plan?.enabled || !imageVolume || !ctx?.vtk?.renderer || !imageData) {
      return undefined;
    }

    const spacing = normalizeVolumeSpacing(
      imageVolume.spacing ?? imageData.getSpacing?.()
    );
    if (!spacing) {
      return undefined;
    }

    const canvas = this.canvas;
    const aspect =
      canvas && canvas.height > 0 ? canvas.width / canvas.height : 1;
    const cam = ctx.vtk.renderer.getActiveCamera();
    const clipping = cam.getClippingRange() as [number, number];

    return computeVisibleVolumeRoi({
      focalPoint: [...cam.getFocalPoint()] as [number, number, number],
      position: [...cam.getPosition()] as [number, number, number],
      viewPlaneNormal: [...cam.getViewPlaneNormal()] as [
        number,
        number,
        number,
      ],
      viewUp: [...cam.getViewUp()] as [number, number, number],
      parallelScale: cam.getParallelScale(),
      clippingRange: [Number(clipping[0]), Number(clipping[1])],
      aspect,
      sourceDimensions: plan.originalDimensions,
      sourceSpacing: spacing,
      imageData,
    });
  }

  private async allocateEmptyVolume(
    renderer: VolumeRenderer,
    imageVolume: IImageVolume
  ): Promise<boolean> {
    const dimensions = normalizeVolumeDims(
      imageVolume.dimensions ?? imageVolume.imageData?.getDimensions?.()
    );
    const spacing = normalizeVolumeSpacing(
      imageVolume.spacing ?? imageVolume.imageData?.getSpacing?.()
    );

    if (!dimensions || !spacing) {
      return false;
    }

    const plan = this.getOrCreateVolumeResamplePlan(
      renderer,
      dimensions,
      spacing
    );
    this.initializeDownsampleProgressiveState(plan);
    const [dx, dy, dz] = plan.targetDimensions;
    const total = Math.max(1, dx * dy * dz);
    const voxelManager = imageVolume.voxelManager as
      | { getRange?: () => number[] }
      | undefined;
    const range = voxelManager?.getRange?.();

    try {
      const scaffoldVolume = {
        dimensions: plan.targetDimensions,
        spacing: plan.targetSpacing,
        valueRange:
          range && range.length === 2
            ? ([range[0], range[1]] as [number, number])
            : ([0, 1] as [number, number]),
        label: imageVolume.volumeId,
        originalDimensions: plan.originalDimensions,
        volumeMode: 'coarseFull' as const,
      };
      if (plan.mode === 'zSkip') {
        const allocateScaffold = (
          renderer as VolumeRenderer & {
            allocateVolumeScaffold?: (
              volume: typeof scaffoldVolume
            ) => Promise<void>;
          }
        ).allocateVolumeScaffold;
        if (allocateScaffold) {
          await allocateScaffold.call(renderer, scaffoldVolume);
        } else {
          await renderer.setVolume({
            data: new Uint16Array(total),
            ...scaffoldVolume,
            sourceFormat: 'r16float',
          });
        }
      } else {
        // Zero r16float scaffold — skip full scalar→half convert on allocate.
        await renderer.setVolume({
          data: new Uint16Array(total),
          ...scaffoldVolume,
          sourceFormat: 'r16float',
        });
      }
      // Progressive uploads use load-time Target FPS seeding instead of probe.
      this.applyPresentQuality();
      renderer.refreshVisibleRoiStats?.();
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
    const dimensions = normalizeVolumeDims(
      imageVolume.dimensions ?? imageVolume.imageData?.getDimensions?.()
    );
    const spacing = normalizeVolumeSpacing(
      imageVolume.spacing ?? imageVolume.imageData?.getSpacing?.()
    );

    if (!dimensions || !spacing) {
      return false;
    }

    const voxelManager = imageVolume.voxelManager as
      | { getRange?: () => number[] }
      | undefined;
    const range = voxelManager?.getRange?.();
    const plan = this.getOrCreateVolumeResamplePlan(
      renderer,
      dimensions,
      spacing
    );
    const progressiveRange = this.readValueRange?.();
    const finalRange =
      range && range.length === 2
        ? ([range[0], range[1]] as [number, number])
        : undefined;
    const valueRange = progressiveRange ?? finalRange;

    if (plan.enabled && plan.mode === 'zSkip') {
      return this.finalizeZSkipDownsampleVolume(renderer, plan, valueRange);
    }

    const scalarData = getVolumeScalarArray(imageVolume);

    if (!scalarData || scalarData.length === 0) {
      return false;
    }

    if (!ArrayBuffer.isView(scalarData)) {
      console.warn(
        '[MviewVolume3D] Scalar buffer is not a TypedArray; skipping upload'
      );
      return false;
    }

    if (plan.enabled) {
      // Full completion path should not reallocate the GPU 3D texture.
      // `allocateEmptyVolume()` already created it with `plan.targetDimensions`.
      const dstDepth = plan.targetDimensions[2];
      const pendingDstSlices: number[] = [];
      if (this.uploadedDstSlices) {
        for (let z = 0; z < dstDepth; z++) {
          if (!this.uploadedDstSlices[z]) {
            pendingDstSlices.push(z);
          }
        }
      } else {
        for (let z = 0; z < dstDepth; z++) {
          pendingDstSlices.push(z);
        }
      }

      try {
        if (pendingDstSlices.length) {
          this.dstScalarData = resampleScalarVolumeNearest(
            scalarData as unknown as ArrayBufferView,
            plan.originalDimensions,
            plan.targetDimensions
          );
          await renderer.updateVolumeSlices({
            data: this.dstScalarData as unknown as ArrayBufferView,
            dimensions: plan.targetDimensions,
            sliceIndices: pendingDstSlices,
            valueRange,
          });
          if (this.uploadedDstSlices) {
            for (const z of pendingDstSlices) {
              this.uploadedDstSlices[z] = 1;
            }
          }
        }
        return true;
      } catch (error) {
        console.error(
          '[MviewVolume3D] Progressive downsample final update failed',
          error
        );
        return false;
      }
    }

    const uploadData = scalarData as unknown as ArrayBufferView;

    try {
      await renderer.setVolume({
        data: uploadData,
        dimensions: plan.targetDimensions,
        spacing: plan.targetSpacing,
        valueRange,
        label: imageVolume.volumeId,
        originalDimensions: plan.originalDimensions,
      });

      if (this.viewportId && valueRange) {
        setMviewVolume3DValueRange(this.viewportId, valueRange);
        if (!reapplyMviewVolume3DPreset(this.viewportId)) {
          flushMviewVolume3DPendingPreset(this.viewportId);
        }
      }

      // Only needed when this is the first full upload (no progressive scaffold).
      this.applyPresentQuality();

      return true;
    } catch (error) {
      console.error('[MviewVolume3D] setVolume failed', error);
      return false;
    }
  }

  private initializeDownsampleProgressiveState(plan: VolumeResamplePlan): void {
    if (!plan.enabled) {
      this.dstScalarData = undefined;
      this.uploadedDstSlices = undefined;
      this.dstToSrcZ = undefined;
      this.srcToDstZ = undefined;
      this.srcXForDstX = undefined;
      this.srcYForDstY = undefined;
      return;
    }

    const [srcW, srcH, srcD] = plan.originalDimensions;
    const [dstW, dstH, dstD] = plan.targetDimensions;

    this.uploadedDstSlices = new Uint8Array(dstD);
    this.dstToSrcZ =
      plan.dstToSrcZ instanceof Uint32Array && plan.dstToSrcZ.length >= dstD
        ? plan.dstToSrcZ
        : buildZSkipDstToSrcMap(srcD, dstD);

    this.srcToDstZ = Array.from({ length: srcD }, () => []);
    for (let zDst = 0; zDst < dstD; zDst++) {
      const zSrc = this.dstToSrcZ[zDst];
      this.srcToDstZ[zSrc].push(zDst);
    }

    if (plan.mode === 'zSkip') {
      // Native WxH planes upload directly — no coarse Float32 volume / XY maps.
      this.dstScalarData = undefined;
      this.srcXForDstX = undefined;
      this.srcYForDstY = undefined;
      return;
    }

    this.dstScalarData = new Float32Array(dstW * dstH * dstD);
    this.srcXForDstX = new Uint32Array(dstW);
    for (let xDst = 0; xDst < dstW; xDst++) {
      const xSrc = Math.min(srcW - 1, Math.floor(((xDst + 0.5) * srcW) / dstW));
      this.srcXForDstX[xDst] = xSrc;
    }

    this.srcYForDstY = new Uint32Array(dstH);
    for (let yDst = 0; yDst < dstH; yDst++) {
      const ySrc = Math.min(srcH - 1, Math.floor(((yDst + 0.5) * srcH) / dstH));
      this.srcYForDstY[yDst] = ySrc;
    }
  }

  private getOrCreateVolumeResamplePlan(
    renderer: VolumeRenderer,
    dimensions: VolumeDims3,
    spacing: VolumeDims3
  ): VolumeResamplePlan {
    if (!this.volumeResamplePlan) {
      const limit = getRendererTextureLimit(renderer);
      const mode =
        (
          renderer as VolumeRenderer & {
            maxTextureReduceMode?: MaxTextureReduceMode;
          }
        ).maxTextureReduceMode ?? resolveMaxTextureReduceMode();
      this.volumeResamplePlan = buildMaxTextureResamplePlan(
        dimensions,
        spacing,
        limit,
        mode
      ) as VolumeResamplePlan;
    }
    if (this.volumeResamplePlan.enabled && !this.didLogResamplePlan) {
      this.didLogResamplePlan = true;
      const plan = this.volumeResamplePlan;
      if (plan.mode === 'zSkip') {
        console.warn(
          `[MviewVolume3D] Auto-downsampling volume ` +
            `${plan.originalDimensions.join('x')} -> ${plan.targetDimensions.join(
              'x'
            )} ` +
            `(mode=zSkip stride=${Number(plan.strideZ ?? 0).toFixed(3)}, ` +
            `maxTextureDimension3D=${plan.maxTextureDimension3D})`
        );
      } else {
        console.warn(
          `[MviewVolume3D] Auto-downsampling volume ` +
            `${plan.originalDimensions.join('x')} -> ${plan.targetDimensions.join(
              'x'
            )} ` +
            `(mode=uniform scale=${plan.uniformScale.toFixed(4)}` +
            `${plan.forcedUniformReason ? `, forced=${plan.forcedUniformReason}` : ''}, ` +
            `maxTextureDimension3D=${plan.maxTextureDimension3D})`
        );
      }
    }
    this.syncViewRefineSource(renderer);
    return this.volumeResamplePlan;
  }

  private isCoarseDstComplete(): boolean {
    const plan = this.volumeResamplePlan;
    if (!plan?.enabled || !this.uploadedDstSlices) {
      return false;
    }
    const dstDepth = plan.targetDimensions[2];
    for (let z = 0; z < dstDepth; z++) {
      if (!this.uploadedDstSlices[z]) {
        return false;
      }
    }
    return true;
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
