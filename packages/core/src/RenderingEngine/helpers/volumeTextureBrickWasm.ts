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

/** Prefer dense per-brick WASM allocs when full AoS would exceed this (bytes). */
export const DEFAULT_WASM_SCALAR_BUDGET_BYTES = 512 * 1024 * 1024;

/** Target max bytes per dense brick when forcing a grid for large volumes. */
export const DEFAULT_WASM_MAX_BRICK_BYTES = 64 * 1024 * 1024;

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
 * True when config (or overrides) requests an explicit fixed partition grid.
 * Fixed controls the partition counts for SetPartitions (single) or the dense
 * brick plan (when over maxScalarBytes) — it does not force dense binding.
 */
export function isFixedWasmBrickPartitionsStrategy(
  options?: WasmVtkBrickPartitionOptions
): boolean {
  const merged: WasmVtkBrickPartitionOptions = {
    ...readConfigOptions(),
    ...options,
  };
  return (
    merged.strategy === 'fixed' &&
    Array.isArray(merged.partitions) &&
    merged.partitions.length === 3
  );
}

/**
 * Full-volume scalar byte length (AoS).
 */
export function estimateVolumeScalarBytes(
  dimensions: readonly [number, number, number] | number[],
  bytesPerElement: number,
  numberOfComponents = 1
): number {
  const dx = Math.max(0, Math.floor(dimensions[0] ?? 0));
  const dy = Math.max(0, Math.floor(dimensions[1] ?? 0));
  const dz = Math.max(0, Math.floor(dimensions[2] ?? 0));
  const bpp = Math.max(1, Math.floor(bytesPerElement));
  const comps = Math.max(1, Math.floor(numberOfComponents));
  return dx * dy * dz * bpp * comps;
}

export function getWasmScalarBudgetBytes(): number {
  const cfg = getConfiguration()?.rendering?.vtkWasm as
    | { maxScalarBytes?: number }
    | undefined;
  const n = cfg?.maxScalarBytes;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return DEFAULT_WASM_SCALAR_BUDGET_BYTES;
}

/**
 * True when a single contiguous WASM AoS alloc is likely to fail / should be
 * avoided — use dense per-brick ImageData instead.
 */
export function shouldUseDenseWasmBricks(
  dimensions: readonly [number, number, number] | number[],
  bytesPerElement: number,
  numberOfComponents = 1
): boolean {
  if (!isWasmVolumeTextureBricklingEnabled()) {
    return false;
  }
  return (
    estimateVolumeScalarBytes(dimensions, bytesPerElement, numberOfComponents) >
    getWasmScalarBudgetBytes()
  );
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
  // Never more partitions than voxels on this axis (SetPartitions(8) on dim=4 is invalid).
  if (dim > 0) {
    n = Math.min(n, Math.max(1, Math.floor(dim)));
  }
  return n;
}

/**
 * Split `dim` into `n` inclusive ranges covering 0..dim-1.
 * Matches VTK `vtkVolumeTexture::SplitVolume` for point-data extent [0, dim-1]:
 *   delta = (dim - 1) / n
 *   block i: [floor(i*delta), floor((i+1)*delta)]
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
  if (safeDim === 1 || parts === 1) {
    return [[0, safeDim - 1]];
  }
  const delta = (safeDim - 1) / parts;
  const ranges: Array<[number, number]> = [];
  for (let p = 0; p < parts; p++) {
    const start = Math.floor(p * delta);
    const end = Math.floor((p + 1) * delta);
    ranges.push([start, Math.max(start, end)]);
  }
  // Ensure last block ends at dim-1 (float edge cases).
  ranges[ranges.length - 1][1] = safeDim - 1;
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

function buildPlanWithPartitions(
  dims: [number, number, number],
  nx: number,
  ny: number,
  nz: number,
  max3D: number,
  strategy: WasmVtkBrickPartitionStrategy
): WasmVtkVolumeBrickPlan {
  const [dx, dy, dz] = dims;
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
 * Build a VTK-style XYZ partition brick plan for the wasm render path.
 * Does not use OpenGL Z-slab `buildZBrickPlan`.
 * When `volumeTextureBrickling` is false, returns a single full-volume brick.
 */
export function buildWasmVtkBrickPlan(
  dimensions: readonly [number, number, number] | number[],
  options: WasmVtkBrickPartitionOptions = {}
): WasmVtkVolumeBrickPlan {
  const dx = Math.max(0, Math.floor(dimensions[0]));
  const dy = Math.max(0, Math.floor(dimensions[1]));
  const dz = Math.max(0, Math.floor(dimensions[2]));
  const dims: [number, number, number] = [dx, dy, dz];
  const max3D = Math.max(
    1,
    Math.floor(
      options.max3D ?? readConfigOptions().max3D ?? getMaxTextureDimension3D()
    )
  );

  if (!isWasmVolumeTextureBricklingEnabled()) {
    return buildPlanWithPartitions(dims, 1, 1, 1, max3D, 'minimum');
  }

  const merged: WasmVtkBrickPartitionOptions = {
    ...readConfigOptions(),
    ...options,
  };

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

  return buildPlanWithPartitions(dims, nx, ny, nz, max3D, strategy);
}

/**
 * Increase partitions until the largest brick is ≤ maxBrickBytes (when possible).
 */
export function refineBrickPlanForByteBudget(
  plan: WasmVtkVolumeBrickPlan,
  bytesPerElement: number,
  numberOfComponents = 1,
  maxBrickBytes: number = DEFAULT_WASM_MAX_BRICK_BYTES
): WasmVtkVolumeBrickPlan {
  // Fixed grids are authoritative — do not re-partition after the fact.
  if (plan.strategy === 'fixed') {
    return plan;
  }

  const bpp = Math.max(1, Math.floor(bytesPerElement));
  const comps = Math.max(1, Math.floor(numberOfComponents));
  const voxelBytes = bpp * comps;
  const maxPerAxis = DEFAULT_WASM_BRICK_MAX_PER_AXIS;
  const [dx, dy, dz] = plan.dimensions;

  let nx = plan.partitions.x;
  let ny = plan.partitions.y;
  let nz = plan.partitions.z;
  let current = plan;

  const largestBrickBytes = (p: WasmVtkVolumeBrickPlan): number => {
    let max = 0;
    for (const b of p.bricks) {
      const [sx, sy, sz] = b.textureSize;
      max = Math.max(max, sx * sy * sz * voxelBytes);
    }
    return max;
  };

  for (let guard = 0; guard < 64; guard++) {
    if (largestBrickBytes(current) <= maxBrickBytes) {
      break;
    }
    // Bump the axis with the largest current brick edge.
    let bestAxis: 0 | 1 | 2 = 0;
    let bestEdge = 0;
    for (const b of current.bricks) {
      const edges = b.textureSize;
      for (let a = 0; a < 3; a++) {
        if (edges[a] > bestEdge) {
          bestEdge = edges[a];
          bestAxis = a as 0 | 1 | 2;
        }
      }
    }
    const dimsArr = [dx, dy, dz];
    const counts = [nx, ny, nz];
    if (counts[bestAxis] >= Math.min(maxPerAxis, dimsArr[bestAxis])) {
      // Try another axis.
      const order: Array<0 | 1 | 2> = [0, 1, 2];
      let bumped = false;
      for (const a of order) {
        if (counts[a] < Math.min(maxPerAxis, dimsArr[a])) {
          counts[a] += 1;
          bumped = true;
          break;
        }
      }
      if (!bumped) {
        break;
      }
    } else {
      counts[bestAxis] += 1;
    }
    nx = counts[0];
    ny = counts[1];
    nz = counts[2];
    current = buildPlanWithPartitions(
      plan.dimensions,
      nx,
      ny,
      nz,
      plan.max3D,
      plan.strategy
    );
  }
  return current;
}

/** Bricks whose extents overlap `ijkBox`. */
export function bricksIntersectingIjkBox(
  plan: WasmVtkVolumeBrickPlan,
  ijkBox: WasmIjkBox
): WasmVtkVolumeBrick[] {
  return plan.bricks.filter((b) => extentsOverlap(ijkBox, b.extent));
}

/**
 * Bricks intersecting a plane in continuous IJK (origin + unit normal) with
 * half-thickness in index units.
 */
export function bricksIntersectingIjkPlane(
  plan: WasmVtkVolumeBrickPlan,
  planeIjk: [number, number, number],
  normalIjk: [number, number, number],
  halfThicknessIndex = 1
): WasmVtkVolumeBrick[] {
  const nLen = Math.hypot(normalIjk[0], normalIjk[1], normalIjk[2]);
  if (!(nLen > 0)) {
    return plan.bricks.slice();
  }
  const nx = normalIjk[0] / nLen;
  const ny = normalIjk[1] / nLen;
  const nz = normalIjk[2] / nLen;
  const halfT = Math.max(0, halfThicknessIndex);

  return plan.bricks.filter((brick) => {
    const [i0, i1, j0, j1, k0, k1] = brick.extent;
    const cx = (i0 + i1) * 0.5;
    const cy = (j0 + j1) * 0.5;
    const cz = (k0 + k1) * 0.5;
    const hx = (i1 - i0) * 0.5;
    const hy = (j1 - j0) * 0.5;
    const hz = (k1 - k0) * 0.5;
    const dist = Math.abs(
      (cx - planeIjk[0]) * nx +
        (cy - planeIjk[1]) * ny +
        (cz - planeIjk[2]) * nz
    );
    const r = hx * Math.abs(nx) + hy * Math.abs(ny) + hz * Math.abs(nz);
    return dist <= r + halfT;
  });
}

/** Inclusive AABB of brick extents, or null if empty. */
export function brickExtentsAabb(
  bricks: readonly WasmVtkVolumeBrick[]
): WasmIjkBox | null {
  if (!bricks.length) {
    return null;
  }
  let i0 = Infinity;
  let i1 = -Infinity;
  let j0 = Infinity;
  let j1 = -Infinity;
  let k0 = Infinity;
  let k1 = -Infinity;
  for (const b of bricks) {
    i0 = Math.min(i0, b.extent[0]);
    i1 = Math.max(i1, b.extent[1]);
    j0 = Math.min(j0, b.extent[2]);
    j1 = Math.max(j1, b.extent[3]);
    k0 = Math.min(k0, b.extent[4]);
    k1 = Math.max(k1, b.extent[5]);
  }
  return [i0, i1, j0, j1, k0, k1];
}

export function ijkBoxVoxelCount(box: WasmIjkBox): number {
  return (
    Math.max(0, box[1] - box[0] + 1) *
    Math.max(0, box[3] - box[2] + 1) *
    Math.max(0, box[5] - box[4] + 1)
  );
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
