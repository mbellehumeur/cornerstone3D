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
    setTransferFunction(points: FuberlinTransferPoint[]): void;
    setSettings(settings: FuberlinSettingsPatch): void;
    setCamera(camera?: FuberlinCameraPatch): void;
    getCamera(): FuberlinCameraState;
    setQualityProfiles(quality?: {
      interactive?: {
        pixelBudget?: number;
        minimumScale?: number;
        steps?: number;
      };
      still?: {
        pixelBudget?: number;
        minimumScale?: number;
        steps?: number;
      };
    }): void;
    rotateTrackball(
      deltaX: number,
      deltaY: number,
      width: number,
      height: number
    ): void;
    beginInteraction(): void;
    endInteraction(): void;
    requestRender(): void;
    render(): void;
    dispose(): void;
  }
}
