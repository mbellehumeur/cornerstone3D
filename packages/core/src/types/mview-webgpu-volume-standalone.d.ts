declare module '@mview/webgpu-volume-standalone' {
  export type FuberlinTransferPoint = {
    x: number;
    color: [number, number, number];
    alpha: number;
  };

  export type FuberlinVolumeDescriptor = {
    data: ArrayBufferView;
    dimensions: [number, number, number];
    spacing: [number, number, number];
    valueRange?: [number, number];
    sourceFormat?: 'r16float';
    label?: string;
    originalDimensions?: [number, number, number];
    volumeMode?: 'coarseFull' | 'roiRefined';
    roiSourceDimensions?: [number, number, number];
  };

  export type FuberlinVolumeSliceUpdate = {
    data: ArrayBufferView;
    dimensions: [number, number, number];
    sliceIndices: number[];
    /** When set, write converted source planes to these GPU depth indices. */
    destSliceIndices?: number[];
    valueRange?: [number, number];
  };

  export type MaxTextureReduceMode = 'uniform' | 'zSkip';

  export type MaxTextureResamplePlan = {
    enabled: boolean;
    mode: MaxTextureReduceMode;
    originalDimensions: number[];
    targetDimensions: number[];
    targetSpacing: number[];
    uniformScale: number;
    maxTextureDimension3D: number;
    strideZ?: number;
    dstToSrcZ?: Uint32Array;
    forcedUniformReason?: string;
  };

  export type FuberlinCameraState = {
    orientation: number[];
    zoom: number;
    panX: number;
    panY: number;
    projection: 'perspective' | 'orthographic';
  };

  export type FuberlinCameraPatch = Partial<{
    orientation: number[];
    rotationX: number;
    rotationY: number;
    zoom: number;
    panX: number;
    panY: number;
    projection: 'perspective' | 'orthographic';
  }>;

  export type FuberlinSettingsPatch = Partial<{
    mode: 'surface' | 'composite' | 'mip';
    threshold: number;
    opacity: number;
    shade: boolean;
    background: [number, number, number];
  }>;

  export class VolumeRenderer {
    static isSupported(): boolean;
    constructor(canvas: HTMLCanvasElement, options?: Record<string, unknown>);
    maxTextureReduceMode?: MaxTextureReduceMode;
    initialize(): Promise<VolumeRenderer>;
    setVolume(volume: FuberlinVolumeDescriptor): Promise<void>;
    updateVolumeSlices(update: FuberlinVolumeSliceUpdate): Promise<void>;
    setTransferFunction(points: FuberlinTransferPoint[]): void;
    setSettings(settings: FuberlinSettingsPatch): void;
    setCamera(camera?: FuberlinCameraPatch): void;
    getCamera(): FuberlinCameraState;
    refreshVisibleRoiStats?(): void;
    setQualityProfiles(quality?: {
      interactive?: {
        pixelBudget?: number;
        minimumScale?: number;
        maximumScale?: number;
        steps?: number;
      };
      still?: {
        pixelBudget?: number;
        minimumScale?: number;
        maximumScale?: number;
        steps?: number;
      };
    }): void;
    setTargetFps(fps: number): void;
    getTargetFps(): number;
    setTargetFpsProbeReady(ready: boolean): void;
    scheduleTargetFpsProbe(): void;
    runTargetFpsProbe(generation?: number): Promise<number | null>;
    waitForGpuIdle(): Promise<void>;
    getMaxTextureDimension3D?(): number;
    shouldDisableVolumeCaches?(): boolean;
    getStats(): {
      fps: number;
      frameMs: number;
      gpuWaitMs: number;
      width: number;
      height: number;
      steps: number;
      scale: number;
      mode: string;
      interacting: boolean;
      targetFps: number;
      budgetPx: number;
      minPx: number;
      targetFpsPhase: 'off' | 'ready' | 'learn' | 'steer';
      probeBudgetPx: number;
      probeStatus: '' | 'ok' | 'fast' | 'flat' | 'slow' | 'fallback';
      lastDragAvgFps: number;
      lastDragFrames: number;
      lastDragBudgetFrom: number;
      lastDragBudgetTo: number;
      lastDragScale: number;
      lastDragSteps: number;
      sourceDimensions?: [number, number, number] | null;
      activeDimensions?: [number, number, number] | null;
      activeSpacing?: [number, number, number] | null;
      downsampleScale?: number;
      maxTextureDimension3D?: number;
      volumeMode?: 'coarseFull' | 'roiRefined';
      roiSourceDimensions?: [number, number, number] | null;
      visibleSourceDimensions?: [number, number, number] | null;
      visibleSourceTotal?: [number, number, number] | null;
      visibleSliceRange?: [number, number] | null;
      volumeWorkBusy?: boolean;
      volumeWorkLabel?: string;
      lastVolumeReloadMs?: number;
      /** True when GPU volume is downsampled vs source / ROI native. */
      isLossy?: boolean;
    };
    rotateTrackball(
      deltaX: number,
      deltaY: number,
      width: number,
      height: number
    ): void;
    beginInteraction(): void;
    endInteraction(): void;
    attachViewRefineSource?(source: {
      sourceDimensions?: [number, number, number];
      sourceSpacing?: [number, number, number];
      getScalars?: () => ArrayLike<number> | undefined;
      /** True when every source K in [ijkMin[2], ijkMax[2]] is in the progressive assembly. */
      areSourceSlicesReady?: (ijkMin: number[], ijkMax: number[]) => boolean;
      getNativeR16?: () => Uint16Array | undefined;
      getValueRange?: () => [number, number] | undefined;
      indexToWorld?: (ijk: number[]) => number[];
      label?: string;
      coarsePlan?: unknown;
      getCoarseScalars?: () => ArrayLike<number> | undefined;
      isCoarseComplete?: () => boolean;
      releaseCoarseCpuBuffers?: () => void;
      fullVolumeCenter?: [number, number, number];
      fullVolumePhysicalMax?: number;
      getVtkVisibleRoi?: () => unknown;
    }): void;
    requestRender(): void;
    render(): void;
    dispose(): void;
  }

  export function convertScalarVolumeToHalfFloatChunk(
    data: ArrayBufferView,
    dimensions: [number, number, number],
    valueRange: [number, number] | undefined,
    zStart: number,
    zCount: number,
    dst: Uint16Array
  ): { valueRange: [number, number]; zEnd: number };

  export function convertScalarVolumeToHalfFloat(
    data: ArrayBufferView,
    dimensions: [number, number, number],
    valueRange?: [number, number]
  ): {
    data: Uint16Array;
    valueRange: [number, number];
    dimensions: [number, number, number];
  };

  export function shouldUseLowMemoryMaxTextureCap(
    env?: Navigator | null
  ): boolean;

  export function isAndroidOrTablet(env?: Navigator | null): boolean;

  export function resolveEffectiveMaxTextureDimension3D(
    deviceLimit: number,
    options?: {
      maxTextureDimension3DCap?: number | false | null | 'device';
      env?: Navigator | null;
    }
  ): number;

  export function estimateR16TextureBytes(
    dimensions: number[] | null | undefined
  ): number;

  export function shrinkBrickToR16ByteBudget(
    brick: {
      ijkMin: number[];
      ijkMax: number[];
      roiDimensions: number[];
      roiSpacing: number[];
      centerIjk: number[];
    },
    sourceDimensions: number[],
    maxBytes: number
  ):
    | {
        ijkMin: number[];
        ijkMax: number[];
        roiDimensions: number[];
        roiSpacing: number[];
        centerIjk: number[];
      }
    | undefined;

  export function normalizeMaxTextureReduceMode(
    mode: unknown
  ): MaxTextureReduceMode;

  export function buildZSkipDstToSrcMap(
    srcDepth: number,
    dstDepth: number
  ): Uint32Array;

  export function buildUniformResamplePlan(
    dimensions: number[],
    spacing: number[],
    maxTextureDimension3D: number
  ): MaxTextureResamplePlan;

  export function buildZSkipResamplePlan(
    dimensions: number[],
    spacing: number[],
    maxTextureDimension3D: number
  ): MaxTextureResamplePlan;

  export function buildMaxTextureResamplePlan(
    dimensions: number[],
    spacing: number[],
    maxTextureDimension3D: number,
    mode?: MaxTextureReduceMode | string
  ): MaxTextureResamplePlan;

  export function packZSkippedSlices(
    source: ArrayBufferView,
    sourceDimensions: number[],
    plan: MaxTextureResamplePlan
  ): ArrayBufferView;

  export function resampleScalarVolumeNearest(
    source: ArrayBufferView,
    sourceDimensions: number[],
    targetDimensions: number[]
  ): Float32Array;

  export const LOW_MEMORY_MAX_TEXTURE_DIMENSION_3D: number;
  export const LOW_MEMORY_ROI_MAX_TEXTURE_DIMENSION_3D: number;
  export const LOW_MEMORY_ROI_MAX_BYTES: number;
}
