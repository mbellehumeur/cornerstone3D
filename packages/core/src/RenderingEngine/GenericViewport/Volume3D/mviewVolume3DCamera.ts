import type { MviewCameraPatch } from '@mview/webgpu-volume-standalone';
import type { ICamera, Point3 } from '../../../types';
import type { Volume3DCamera } from './viewport3DTypes';

export type MviewCameraConvertOptions = {
  /**
   * Volume direction cosines (9 floats: I, J, K axis directions in world).
   * Required to map CS LPS/world camera axes into mview's IJK-aligned volume space.
   */
  direction?: ArrayLike<number> | number[];
  /**
   * max(dims × spacing) in mm — mview normalizes the volume box by this length.
   * When set with `parallelScale` and orthographic projection, framing matches
   * VTK half-height (guarded to a safe range).
   */
  volumePhysicalMax?: number;
  /**
   * Fit-time VTK parallelScale. Used when the live parallelScale is suspiciously
   * small (empty-scene resetCamera) so we do not clamp garbage up to MIN zoom.
   */
  baselineParallelScale?: number;
  /** Volume center in world/LPS (same frame as camera.focalPoint). */
  volumeCenter?: Point3;
  /**
   * When true, also map parallelScale → zoom and focal offset → pan.
   * Perspective mode should leave mview zoom/pan alone.
   */
  includeFraming?: boolean;
};

/** Safe mview orthographic half-height (volume-normalized). */
export const MVIEW_ORTHO_DEFAULT_HALF_HEIGHT = 0.55;

const ORTHO_HALF_HEIGHT_MIN = 0.05;
/** Allow zoom-out past ~2× volume half-height so HUD/ROI match VTK. */
const ORTHO_HALF_HEIGHT_MAX = 8;
const ORTHO_PAN_MAX = 2;

/**
 * Map VTK parallelScale (mm half-height) → mview ortho zoom (volume-normalized).
 * Empty-scene resetCamera leaves parallelScale ≈ 1; only then fall back to the
 * mount-time baseline. Do not treat intentional zoom-in (small halfHeight) as
 * bogus or the present will ignore ZoomTool while the overlay still updates.
 */
export function parallelScaleToMviewOrthoZoom(
  parallelScale: number,
  physicalMax: number,
  baselineParallelScale?: number
): number {
  const looksLikeEmptyReset =
    typeof baselineParallelScale === 'number' &&
    Number.isFinite(baselineParallelScale) &&
    baselineParallelScale > 20 &&
    parallelScale > 0 &&
    parallelScale < Math.min(5, baselineParallelScale * 0.05);

  const scale = looksLikeEmptyReset ? baselineParallelScale! : parallelScale;
  const halfHeight = scale / physicalMax;

  return Math.min(
    ORTHO_HALF_HEIGHT_MAX,
    Math.max(ORTHO_HALF_HEIGHT_MIN, halfHeight)
  );
}

/**
 * Pitch a CS / VTK Volume3D camera +90° about screen-right.
 *
 * mview's IJK-aligned present needs this offset vs the default Volume3D preset
 * (e.g. coronal). Applying it to the **VTK camera** (once at mount / reset)
 * keeps CS and mview in the same frame so TrackballRotate left/right stays yaw
 * instead of becoming roll about the view axis.
 */
export function pitchVolume3DCameraUp90<
  T extends Partial<Volume3DCamera | ICamera>,
>(camera: T): T {
  const viewPlaneNormal = camera.viewPlaneNormal as Point3 | undefined;
  const viewUp = camera.viewUp as Point3 | undefined;

  if (!viewPlaneNormal || !viewUp) {
    return camera;
  }

  const vpn = normalize(viewPlaneNormal);
  const up = normalize(viewUp);
  // +90° about right = up×vpn: vpn' = -up, up' = vpn
  const newVpn: Point3 = [-up[0], -up[1], -up[2]];
  const newUp: Point3 = [vpn[0], vpn[1], vpn[2]];

  const focalPoint = camera.focalPoint as Point3 | undefined;
  const position = camera.position as Point3 | undefined;
  let newPosition = position;

  if (focalPoint && position) {
    const distance = Math.hypot(
      position[0] - focalPoint[0],
      position[1] - focalPoint[1],
      position[2] - focalPoint[2]
    );
    newPosition = [
      focalPoint[0] + distance * newVpn[0],
      focalPoint[1] + distance * newVpn[1],
      focalPoint[2] + distance * newVpn[2],
    ];
  }

  return {
    ...camera,
    viewPlaneNormal: newVpn,
    viewUp: newUp,
    position: newPosition,
  };
}

/**
 * Longest physical volume edge (mm). Matches mview's box normalization divisor.
 */
export function getVolumePhysicalMax(args: {
  dimensions?: ArrayLike<number> | number[];
  spacing?: ArrayLike<number> | number[];
}): number | undefined {
  const { dimensions, spacing } = args;

  if (!dimensions || dimensions.length < 3 || !spacing || spacing.length < 3) {
    return undefined;
  }

  const physical = [
    Number(dimensions[0]) * Number(spacing[0]),
    Number(dimensions[1]) * Number(spacing[1]),
    Number(dimensions[2]) * Number(spacing[2]),
  ];

  if (!physical.every((value) => Number.isFinite(value) && value > 0)) {
    return undefined;
  }

  return Math.max(...physical);
}

/**
 * World-space center of volume bounds (or origin fallback).
 */
export function getVolumeCenterWorld(imageData: {
  getBounds?: () => number[];
  getOrigin?: () => number[];
  getDimensions?: () => number[];
  getSpacing?: () => number[];
}): Point3 | undefined {
  const bounds = imageData.getBounds?.();

  if (bounds && bounds.length >= 6) {
    return [
      (bounds[0] + bounds[1]) * 0.5,
      (bounds[2] + bounds[3]) * 0.5,
      (bounds[4] + bounds[5]) * 0.5,
    ];
  }

  const origin = imageData.getOrigin?.();
  const dimensions = imageData.getDimensions?.();
  const spacing = imageData.getSpacing?.();

  if (
    origin &&
    origin.length >= 3 &&
    dimensions &&
    dimensions.length >= 3 &&
    spacing &&
    spacing.length >= 3
  ) {
    return [
      origin[0] + dimensions[0] * spacing[0] * 0.5,
      origin[1] + dimensions[1] * spacing[1] * 0.5,
      origin[2] + dimensions[2] * spacing[2] * 0.5,
    ];
  }

  return undefined;
}

/**
 * Map a CS / VTK Volume3D camera into an mview camera patch.
 *
 * Orientation is always mapped. Framing (zoom/pan) is included only when
 * `includeFraming` is true and values fall in a safe range — bad framing
 * previously blanked the present.
 */
export function iCameraToMviewCamera(
  camera: Partial<Volume3DCamera | ICamera>,
  options: MviewCameraConvertOptions = {}
): MviewCameraPatch | undefined {
  const viewPlaneNormal = camera.viewPlaneNormal as Point3 | undefined;
  const viewUp = camera.viewUp as Point3 | undefined;

  if (!viewPlaneNormal || !viewUp) {
    return undefined;
  }

  const zAxis = normalize(
    worldToVolumeAxis(viewPlaneNormal, options.direction)
  );
  const upAxis = normalize(worldToVolumeAxis(viewUp, options.direction));

  // Camera +X = screen right = viewUp × viewPlaneNormal (VTK / CS).
  let xAxis = normalize(cross(upAxis, zAxis));

  if (length(xAxis) < 1e-6) {
    xAxis = normalize(cross(pickPerpendicular(zAxis), zAxis));
  }

  // Camera +Y = screen-down in mview → use -viewUp so anatomy stays upright.
  const yAxis: Point3 = [-upAxis[0], -upAxis[1], -upAxis[2]];

  // Re-orthogonalize up against Z after the sign flip (keep X as right).
  const yDotZ = dot(yAxis, zAxis);
  const yOrtho = normalize([
    yAxis[0] - zAxis[0] * yDotZ,
    yAxis[1] - zAxis[1] * yDotZ,
    yAxis[2] - zAxis[2] * yDotZ,
  ]);

  const yFinal = length(yOrtho) > 1e-6 ? yOrtho : yAxis;

  const patch: MviewCameraPatch = {
    orientation: [
      xAxis[0],
      yFinal[0],
      zAxis[0],
      xAxis[1],
      yFinal[1],
      zAxis[1],
      xAxis[2],
      yFinal[2],
      zAxis[2],
    ],
  };

  if (!options.includeFraming) {
    return patch;
  }

  const parallelScale = camera.parallelScale;
  const physicalMax = options.volumePhysicalMax;

  if (
    typeof parallelScale === 'number' &&
    Number.isFinite(parallelScale) &&
    parallelScale > 0 &&
    typeof physicalMax === 'number' &&
    Number.isFinite(physicalMax) &&
    physicalMax > 0
  ) {
    patch.zoom = parallelScaleToMviewOrthoZoom(
      parallelScale,
      physicalMax,
      options.baselineParallelScale
    );
  }

  const focalPoint = camera.focalPoint as Point3 | undefined;
  const volumeCenter = options.volumeCenter;

  if (
    focalPoint &&
    volumeCenter &&
    typeof parallelScale === 'number' &&
    Number.isFinite(parallelScale) &&
    parallelScale > 0
  ) {
    const vpn = normalize(viewPlaneNormal);
    const up = normalize(viewUp);
    const right = normalize(cross(up, vpn));
    const offset: Point3 = [
      focalPoint[0] - volumeCenter[0],
      focalPoint[1] - volumeCenter[1],
      focalPoint[2] - volumeCenter[2],
    ];
    const panX = -dot(offset, right) / parallelScale;
    const panY = dot(offset, up) / parallelScale;

    if (Number.isFinite(panX) && Number.isFinite(panY)) {
      patch.panX = Math.min(ORTHO_PAN_MAX, Math.max(-ORTHO_PAN_MAX, panX));
      patch.panY = Math.min(ORTHO_PAN_MAX, Math.max(-ORTHO_PAN_MAX, panY));
    }
  }

  return patch;
}

/**
 * World/LPS vector → volume IJK axis frame using direction cosines.
 * `direction` is [Ix,Iy,Iz, Jx,Jy,Jz, Kx,Ky,Kz].
 */
function worldToVolumeAxis(
  world: Point3,
  direction?: ArrayLike<number> | number[]
): Point3 {
  if (!direction || direction.length < 9) {
    return world;
  }

  const i: Point3 = [direction[0], direction[1], direction[2]];
  const j: Point3 = [direction[3], direction[4], direction[5]];
  const k: Point3 = [direction[6], direction[7], direction[8]];

  return [dot(i, world), dot(j, world), dot(k, world)];
}

function pickPerpendicular(axis: Point3): Point3 {
  const helper: Point3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
  return normalize(cross(helper, axis));
}

function cross(a: Point3 | number[], b: Point3 | number[]): Point3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Point3 | number[], b: Point3 | number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(v: Point3 | number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Point3 | number[]): Point3 {
  const len = length(v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
