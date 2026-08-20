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
    valueRange?: [number, number];
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
    initialize(): Promise<VolumeRenderer>;
    setVolume(volume: FuberlinVolumeDescriptor): Promise<void>;
    updateVolumeSlices(update: FuberlinVolumeSliceUpdate): Promise<void>;
    setTransferFunction(points: FuberlinTransferPoint[]): void;
    setSettings(settings: FuberlinSettingsPatch): void;
    setCamera(camera?: FuberlinCameraPatch): void;
    getCamera(): FuberlinCameraState;
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
    };
    rotateTrackball(
      deltaX: number,
      deltaY: number,
      width: number,
      height: number
    ): void;
    beginInteraction(): void;
    endInteraction(): void;
    attachViewRefineSource?(source: Record<string, unknown>): void;
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
}
