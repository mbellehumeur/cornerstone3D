import { getConfiguration } from '../../init';
import { getMaxTextureDimension3D } from './volumeTextureBricks';

/** VTK-style partition grid counts per axis. */
export interface WasmVtkBrickPartitions {
  x: number;
  y: number;
  z: number;
}

export type WasmVtkBrickPartitionStrategy = 'minimum' | 'target' | 'fixed';

export interface WasmVtkBrickPartitionOptions {
  strategy?: WasmVtkBrickPartitionStrategy;
  /** Used when strategy === 'target' (per axis aim, before max3D bump). */
  targetPerAxis?: number;
  /** Used when strategy === 'fixed'. */
  partitions?: [number, number, number];
  /** Clamp per axis; default 64 → max grid 64^3. */
  maxPerAxis?: number;
  minPerAxis?: number;
  /** If true, target applies on axes that already fit max3D too. */
  applyToAllAxes?: boolean;
  max3D?: number;
}

export interface WasmVtkVolumeBrick {
  index: number;
  ijk: [number, number, number];
  /** Inclusive IJK extent: [i0, i1, j0, j1, k0, k1]. */
  extent: [number, number, number, number, number, number];
  textureSize: [number, number, number];
}

export interface WasmVtkVolumeBrickPlan {
  dimensions: [number, number, number];
  partitions: WasmVtkBrickPartitions;
  bricked: boolean;
  max3D: number;
  strategy: WasmVtkBrickPartitionStrategy;
  bricks: WasmVtkVolumeBrick[];
  /** Passed through to mapper.SetPartitions */
  vtkPartitions: [number, number, number];
}

/** Inclusive IJK box: [i0, i1, j0, j1, k0, k1]. */
export type WasmIjkBox = [number, number, number, number, number, number];

export interface WasmBrickRegionUpload {
  brickIndex: number;
  /** Intersection of dirty box with brick, in full-volume IJK. */
  fullExtent: WasmIjkBox;
  /** Same region in brick-local coordinates (origin at brick extent min). */
  localExtent: WasmIjkBox;
}

export const DEFAULT_WASM_BRICK_MAX_PER_AXIS = 64;

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function readConfigOptions(): WasmVtkBrickPartitionOptions {
  const cfg = getConfiguration()?.rendering?.vtkWasm?.brickPartitions ?? {};
  return { ...cfg };
}

export function isWasmVolumeTextureBricklingEnabled(): boolean {
  const flag = getConfiguration()?.rendering?.vtkWasm?.volumeTextureBrickling;
  return flag !== false;
}

/**
 * Partitions needed on one axis so each brick size ≤ max3D.
 */
export function minimumPartitionsForAxis(dim: number, max3D: number): number {
  const safeDim = Math.max(0, Math.floor(dim));
  const safeMax = Math.max(1, Math.floor(max3D));
  if (safeDim <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(safeDim / safeMax));
}

function resolveAxisCount(
  dim: number,
  max3D: number,
  strategy: WasmVtkBrickPartitionStrategy,
  options: WasmVtkBrickPartitionOptions,
  fixedAxisValue: number | undefined,
  applyToAllAxes: boolean
): number {
  const minPerAxis = Math.max(1, options.minPerAxis ?? 1);
  const maxPerAxis = Math.max(
    minPerAxis,
    options.maxPerAxis ?? DEFAULT_WASM_BRICK_MAX_PER_AXIS
  );
  const minForFit = minimumPartitionsForAxis(dim, max3D);

  let n: number;
  if (strategy === 'fixed' && typeof fixedAxisValue === 'number') {
    n = fixedAxisValue;
  } else if (strategy === 'target') {
    const target = Math.max(1, options.targetPerAxis ?? minForFit);
    if (applyToAllAxes || dim > max3D) {
      n = target;
    } else {
      n = 1;
    }
  } else {
    // minimum
    n = minForFit;
  }

  n = clampInt(n, minPerAxis, maxPerAxis);
  // Always raise so each brick fits max3D (may still fail if maxPerAxis too low).
  if (n < minForFit) {
    n = clampInt(minForFit, minPerAxis, maxPerAxis);
  }
  return n;
}

/**
 * Split `dim` into `n` contiguous inclusive ranges covering 0..dim-1.
 */
export function splitAxisExtents(
  dim: number,
  n: number
): Array<[number, number]> {
  const safeDim = Math.max(0, Math.floor(dim));
  const parts = Math.max(1, Math.floor(n));
  if (safeDim <= 0) {
    return [[0, -1]];
  }
  const ranges: Array<[number, number]> = [];
  for (let p = 0; p < parts; p++) {
    const start = Math.floor((p * safeDim) / parts);
    const end = Math.floor(((p + 1) * safeDim) / parts) - 1;
    ranges.push([start, Math.max(start, end)]);
  }
  return ranges;
}

function extentsOverlap(a: WasmIjkBox, b: WasmIjkBox): boolean {
  return !(
    a[1] < b[0] ||
    a[0] > b[1] ||
    a[3] < b[2] ||
    a[2] > b[3] ||
    a[5] < b[4] ||
    a[4] > b[5]
  );
}

function intersectExtents(a: WasmIjkBox, b: WasmIjkBox): WasmIjkBox | null {
  if (!extentsOverlap(a, b)) {
    return null;
  }
  return [
    Math.max(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.min(a[3], b[3]),
    Math.max(a[4], b[4]),
    Math.min(a[5], b[5]),
  ];
}

/**
 * Build a VTK-style XYZ partition brick plan for the wasm render path.
 * Does not use OpenGL Z-slab `buildZBrickPlan`.
 */
export function buildWasmVtkBrickPlan(
  dimensions: readonly [number, number, number] | number[],
  options: WasmVtkBrickPartitionOptions = {}
): WasmVtkVolumeBrickPlan {
  const merged: WasmVtkBrickPartitionOptions = {
    ...readConfigOptions(),
    ...options,
  };

  const dx = Math.max(0, Math.floor(dimensions[0]));
  const dy = Math.max(0, Math.floor(dimensions[1]));
  const dz = Math.max(0, Math.floor(dimensions[2]));
  const dims: [number, number, number] = [dx, dy, dz];

  const max3D = Math.max(
    1,
    Math.floor(merged.max3D ?? getMaxTextureDimension3D())
  );
  const strategy: WasmVtkBrickPartitionStrategy = merged.strategy ?? 'minimum';
  const applyToAllAxes = merged.applyToAllAxes === true;
  const fixed = merged.partitions;

  const nx = resolveAxisCount(
    dx,
    max3D,
    strategy,
    merged,
    fixed?.[0],
    applyToAllAxes
  );
  const ny = resolveAxisCount(
    dy,
    max3D,
    strategy,
    merged,
    fixed?.[1],
    applyToAllAxes
  );
  const nz = resolveAxisCount(
    dz,
    max3D,
    strategy,
    merged,
    fixed?.[2],
    applyToAllAxes
  );

  const xRanges = splitAxisExtents(dx, nx);
  const yRanges = splitAxisExtents(dy, ny);
  const zRanges = splitAxisExtents(dz, nz);

  const bricks: WasmVtkVolumeBrick[] = [];
  let index = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const [i0, i1] = xRanges[ix];
        const [j0, j1] = yRanges[iy];
        const [k0, k1] = zRanges[iz];
        const textureSize: [number, number, number] = [
          Math.max(0, i1 - i0 + 1),
          Math.max(0, j1 - j0 + 1),
          Math.max(0, k1 - k0 + 1),
        ];
        bricks.push({
          index,
          ijk: [ix, iy, iz],
          extent: [i0, i1, j0, j1, k0, k1],
          textureSize,
        });
        index += 1;
      }
    }
  }

  return {
    dimensions: dims,
    partitions: { x: nx, y: ny, z: nz },
    bricked: nx > 1 || ny > 1 || nz > 1,
    max3D,
    strategy,
    bricks,
    vtkPartitions: [nx, ny, nz],
  };
}

/**
 * Map a dirty full-volume IJK box to per-brick upload descriptors.
 */
export function fullVolumeRegionToBrickUploads(
  ijkBox: WasmIjkBox,
  plan: WasmVtkVolumeBrickPlan
): WasmBrickRegionUpload[] {
  const uploads: WasmBrickRegionUpload[] = [];
  for (const brick of plan.bricks) {
    const hit = intersectExtents(ijkBox, brick.extent);
    if (!hit) {
      continue;
    }
    const [i0, i1, j0, j1, k0, k1] = hit;
    const [bi0, , bj0, , bk0] = brick.extent;
    uploads.push({
      brickIndex: brick.index,
      fullExtent: hit,
      localExtent: [i0 - bi0, i1 - bi0, j0 - bj0, j1 - bj0, k0 - bk0, k1 - bk0],
    });
  }
  return uploads;
}
