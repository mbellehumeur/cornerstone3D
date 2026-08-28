import { vec3 } from 'gl-matrix';
import type { IImageVolume, Point3 } from '../../../types';
import { getOrthogonalVolumeSliceLayout } from './planarAdapterCoordinateTransforms';
import { getIndexMajorAxis } from './planarCPUVolumeSamplingUtils';
import { getVolumeScalarArray } from '../webgpuMapperImageData';

const DEFAULT_PLANAR_VIEW_UP: Point3 = [0, -1, 0];

export type OrthogonalVolumeSliceResult = {
  width: number;
  height: number;
  data: Int16Array | Float32Array;
  worldWidth: number;
  worldHeight: number;
};

function worldToIjkFromVolume(
  imageVolume: IImageVolume,
  world: Point3
): Point3 {
  const imageData = imageVolume.imageData as
    | {
        worldToIndex?: (w: Point3) => Point3 | ArrayLike<number>;
      }
    | undefined;
  if (typeof imageData?.worldToIndex === 'function') {
    const ijk = imageData.worldToIndex(world);
    return [Number(ijk[0]), Number(ijk[1]), Number(ijk[2])];
  }
  const origin = imageVolume.origin as Point3;
  const spacing = imageVolume.spacing as Point3;
  return [
    (world[0] - origin[0]) / spacing[0],
    (world[1] - origin[1]) / spacing[1],
    (world[2] - origin[2]) / spacing[2],
  ];
}

/**
 * CPU orthogonal slice for vtk-wasm MPR (ImageReslice in wasm draws clear-only).
 * Row/column iteration signs match {@link PlanarCPUVolumeSampler}.
 */
export function extractOrthogonalVolumeSlice(
  imageVolume: IImageVolume,
  originWorld: Point3,
  normalWorld: Point3,
  viewUp: Point3 = DEFAULT_PLANAR_VIEW_UP
): OrthogonalVolumeSliceResult | undefined {
  const scalars = getVolumeScalarArray(imageVolume);
  if (!scalars?.length) {
    return undefined;
  }
  const dims = imageVolume.dimensions as Point3;
  const spacing = imageVolume.spacing as Point3;
  const direction = imageVolume.direction as number[] | undefined;
  if (!direction || direction.length < 9) {
    return undefined;
  }
  const ijk = worldToIjkFromVolume(imageVolume, originWorld);
  const layout = getOrthogonalVolumeSliceLayout({
    dimensions: dims,
    spacing,
    direction,
    viewPlaneNormal: normalWorld,
    viewUp,
    sliceIndexIjk: ijk,
  });
  if (!layout) {
    return undefined;
  }

  const [dx, dy, dz] = dims;
  const src = scalars as Int16Array | Float32Array;
  const comps = Math.max(1, Math.round(scalars.length / (dx * dy * dz)));
  const {
    columnAxisIndex,
    rowAxisIndex,
    sliceAxisIndex,
    sliceIndex,
    columns,
    rows,
    columnPixelSpacing,
    rowPixelSpacing,
  } = layout;

  const normalizedViewUp = vec3.normalize(
    vec3.create(),
    viewUp as vec3
  ) as Point3;
  const normalizedViewPlaneNormal = vec3.normalize(
    vec3.create(),
    normalWorld as vec3
  ) as Point3;
  const right = vec3.normalize(
    vec3.create(),
    vec3.cross(
      vec3.create(),
      normalizedViewUp as vec3,
      normalizedViewPlaneNormal as vec3
    )
  ) as Point3;

  const upAxis = getIndexMajorAxis(imageVolume, viewUp);
  const rightAxis = getIndexMajorAxis(imageVolume, right);
  const rowSign = upAxis ? (-upAxis.sign as 1 | -1) : 1;
  const colSign = rightAxis ? (rightAxis.sign as 1 | -1) : 1;

  const sample = (i: number, j: number, k: number): number => {
    const idx = ((k * dy + j) * dx + i) * comps;
    return Number(src[idx] ?? 0);
  };

  const out = new Int16Array(columns * rows);
  const ijkSample: Point3 = [0, 0, 0];
  ijkSample[sliceAxisIndex] = sliceIndex;
  for (let row = 0; row < rows; row++) {
    ijkSample[rowAxisIndex] = rowSign > 0 ? row : rows - 1 - row;
    for (let col = 0; col < columns; col++) {
      ijkSample[columnAxisIndex] = colSign > 0 ? col : columns - 1 - col;
      out[row * columns + col] = sample(
        ijkSample[0],
        ijkSample[1],
        ijkSample[2]
      );
    }
  }

  return {
    width: columns,
    height: rows,
    data: out,
    worldWidth: columns * columnPixelSpacing,
    worldHeight: rows * rowPixelSpacing,
  };
}
