import type { FuberlinCameraPatch } from '@mview/webgpu-volume-standalone';
import type { ICamera, Point3 } from '../../../types';
import type { Volume3DCamera } from './viewport3DTypes';

export type FuberlinCameraConvertOptions = {
  /**
   * Volume direction cosines (9 floats: I, J, K axis directions in world).
   * Required to map CS LPS/world camera axes into mview's IJK-aligned volume space.
   */
  direction?: ArrayLike<number> | number[];
};

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
 * Map a CS / VTK Volume3D camera into an mview orientation patch.
 *
 * mview raymarches an IJK-aligned box (no patient-direction actor transform),
 * so viewPlaneNormal / viewUp must be converted from world → volume axes.
 *
 * The mview fragment shader flips screen-Y (`-(uv.y*2-1)`), so camera +Y is
 * screen-down. Mapping CS viewUp onto -Y keeps superior at the top of the
 * canvas. Look stays along -viewPlaneNormal so TrackballRotate yaw/pitch map
 * to screen left-right / up-down.
 *
 * Callers that need the fuberlin present offset should pitch the CS camera with
 * {@link pitchVolume3DCameraUp90} before syncing — do not bake that pitch here.
 *
 * Zoom/pan are omitted — those bridges blanked the present earlier.
 */
export function iCameraToFuberlinCamera(
  camera: Partial<Volume3DCamera | ICamera>,
  options: FuberlinCameraConvertOptions = {}
): FuberlinCameraPatch | undefined {
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

  return {
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
