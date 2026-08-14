declare module '@slicerlive/webgpu-render' {
  export type TF = number[][];

  export type SlicerLiveVolumeDescriptor = {
    data: ArrayBufferView;
    dimensions: [number, number, number];
    spacing: [number, number, number];
    origin?: [number, number, number];
    direction?: number[] | ArrayLike<number>;
    ijkToWorld?: number[] | ArrayLike<number>;
    valueRange?: [number, number];
    label?: string;
  };

  export type SlicerLiveVolumeSliceUpdate = {
    data: ArrayBufferView;
    dimensions: [number, number, number];
    sliceIndices: number[];
    valueRange?: [number, number];
  };

  export type SlicerLiveCameraState = {
    position: [number, number, number];
    focalPoint: [number, number, number];
    viewUp: [number, number, number];
    parallelScale?: number;
    viewAngle?: number;
    parallelProjection?: boolean;
  };

  export type SlicerLiveTransferFunctions = {
    colorTF: TF;
    opacityTF: TF;
    clim: [number, number];
    shade?: boolean;
    shadeCoeffs?: [number, number, number, number];
  };

  export const TARGET_MS_PRESETS: readonly [8, 16, 33];

  export class SlicerLiveVolumeRenderer {
    static isSupported(): boolean;
    constructor(canvas: HTMLCanvasElement);
    initialize(): Promise<SlicerLiveVolumeRenderer>;
    setVolume(volume: SlicerLiveVolumeDescriptor): Promise<void>;
    updateVolumeSlices(update: SlicerLiveVolumeSliceUpdate): Promise<void>;
    setSegmentation(
      seg: SlicerLiveSegmentationDescriptor | null
    ): Promise<void>;
    beginSegmentation(begin: SlicerLiveSegmentationBegin): Promise<void>;
    updateSegmentationSlices(
      update: SlicerLiveSegmentationSliceUpdate
    ): Promise<void>;
    finalizeSegmentation(): Promise<void>;
    clearSegmentation(): void;
    setSegmentAppearance(appearances: SlicerLiveSegmentAppearance[]): boolean;
    setTransferFunctions(tf: SlicerLiveTransferFunctions): void;
    setCamera(camera: Partial<SlicerLiveCameraState>): void;
    getParallelProjection(): boolean;
    setParallelProjection(parallel: boolean): void;
    getShade(): boolean;
    setShade(enabled: boolean): void;
    getVolumeOpacity(): number;
    setVolumeOpacity(opacity: number): void;
    getShadeCoeffs(): [number, number, number, number];
    setShadeCoeffs(coeffs: [number, number, number, number]): void;
    getInteractionQuality(): number;
    setInteractionQuality(quality: number): void;
    getMotionBudget(): number;
    setMotionBudget(quality: number): void;
    getMotionBudgetPx(): number;
    setMotionBudgetPx(budgetPx: number): void;
    getTargetMs(): number;
    setTargetMs(ms: number): void;
    getSampleStep(): number;
    getAutoSampleStep(): number;
    setSampleStep(stepMm: number): void;
    getAccumulate(): boolean;
    setAccumulate(enabled: boolean): void;
    getSettleSamples(): number;
    setSettleSamples(count: number): void;
    getClim(): [number, number];
    setClim(clim: [number, number]): void;
    getCropEnabled(): boolean;
    setCropEnabled(enabled: boolean): void;
    getCropBox(): SlicerLiveCropBox | null;
    setCropBox(
      lo: [number, number, number],
      hi: [number, number, number]
    ): void;
    pickCropHandle(
      cssX: number,
      cssY: number,
      cssW: number,
      cssH: number
    ): SlicerLiveCropHandle | null;
    setCropHover(handleId: number | null): void;
    beginCropDrag(handleId: number): boolean;
    updateCropDrag(
      cssX: number,
      cssY: number,
      cssW: number,
      cssH: number
    ): boolean;
    endCropDrag(): void;
    beginInteraction(): void;
    endInteraction(): void;
    requestRender(): void;
    render(): void;
    dispose(): void;
  }

  export type SlicerLiveCropHandle = {
    id: number;
    cursor: string;
  };

  export type SlicerLiveCropBox = {
    lo: [number, number, number];
    hi: [number, number, number];
  };

  export type SlicerLiveSegmentAppearance = {
    num: number;
    color?: [number, number, number];
    opacity: number;
  };

  export type SlicerLiveSegmentationDescriptor = {
    lab: Uint8Array;
    dimensions: [number, number, number];
    ijkToWorld: number[] | ArrayLike<number>;
    colors: Array<[number, number, number, number]>;
    names?: Record<number, string>;
  };

  export type SlicerLiveSegmentationBegin = {
    dimensions: [number, number, number];
    ijkToWorld: number[] | ArrayLike<number>;
    colors: Array<[number, number, number, number]>;
    names?: Record<number, string>;
  };

  export type SlicerLiveSegmentationSliceUpdate = {
    lab: Uint8Array;
    dimensions: [number, number, number];
    sliceIndices: number[];
  };

  export function lutFromTransferFunctions(
    colorTF: TF,
    opacityTF: TF,
    clim: [number, number]
  ): Uint8Array;
  export function interpTF(tf: TF, s: number, comps: number): number[];
  export class BudgetController {
    constructor(opts?: {
      targetMs?: number;
      minPx?: number;
      maxPx?: number;
      startPx?: number;
    });
    budgetPx: number;
    targetMs: number;
    update(measuredMs: number): void;
    scale(w: number, h: number): number;
  }
  export function initDevice(): Promise<{
    adapter: GPUAdapter;
    device: GPUDevice;
    features: Set<string>;
  }>;
}
