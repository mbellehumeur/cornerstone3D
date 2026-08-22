import type { Point3 } from '../../../types';

export type VolumeDims3 = [number, number, number];

export type VisibleVolumeRoi = {
  ijkMin: VolumeDims3;
  ijkMax: VolumeDims3;
  roiDimensions: VolumeDims3;
  roiSpacing: VolumeDims3;
  roiWorldCenter: Point3;
  /** Fraction of full source extent covered on each IJK axis. */
  coverageFraction: VolumeDims3;
};

export type ComputeVisibleVolumeRoiParams = {
  focalPoint: Point3;
  position: Point3;
  viewPlaneNormal: Point3;
  viewUp: Point3;
  parallelScale: number;
  clippingRange: [number, number];
  aspect: number;
  sourceDimensions: VolumeDims3;
  sourceSpacing: VolumeDims3;
  imageData: {
    getBounds?: () => number[];
    /** VTK/CS often return gl-matrix vec3 (Float32Array), not a tuple. */
    worldToIndex?: (world: Point3) => Point3 | ArrayLike<number>;
    indexToWorld?: (index: Point3, dest?: Point3) => Point3 | ArrayLike<number>;
  };
  paddingVoxels?: number;
};

/** Extra ROI compute diagnostics in the browser console. */
export const ROI_COMPUTE_DEBUG = false;

function logRoiCompute(
  message: string,
  details?: Record<string, unknown>
): void {
  if (!ROI_COMPUTE_DEBUG) {
    return;
  }
  if (details) {
    console.log(`[MviewVolume3D][ROI][compute] ${message}`, details);
    return;
  }
  console.log(`[MviewVolume3D][ROI][compute] ${message}`);
}

function normalize(v: Point3): Point3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len < 1e-8) {
    return [0, 0, 0];
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Point3, b: Point3): Point3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addScaled(
  origin: Point3,
  a: Point3,
  sa: number,
  b: Point3,
  sb: number
): Point3 {
  return [
    origin[0] + a[0] * sa + b[0] * sb,
    origin[1] + a[1] * sa + b[1] * sb,
    origin[2] + a[2] * sa + b[2] * sb,
  ];
}

function readContinuousIndex(
  imageData: ComputeVisibleVolumeRoiParams['imageData'],
  world: Point3
): Point3 | undefined {
  if (typeof imageData.worldToIndex !== 'function') {
    return undefined;
  }
  const ijk = imageData.worldToIndex(world);
  const i = Number((ijk as ArrayLike<number>)[0]);
  const j = Number((ijk as ArrayLike<number>)[1]);
  const k = Number((ijk as ArrayLike<number>)[2]);
  if (!Number.isFinite(i) || !Number.isFinite(j) || !Number.isFinite(k)) {
    return undefined;
  }
  return [i, j, k];
}

function volumeBoundsCorners(bounds: number[]): Point3[] {
  const [x0, x1, y0, y1, z0, z1] = bounds;
  return [
    [x0, y0, z0],
    [x1, y0, z0],
    [x0, y1, z0],
    [x1, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x0, y1, z1],
    [x1, y1, z1],
  ];
}

/**
 * Map a world point to orthographic view coordinates:
 * u/v lateral offsets from focalPoint; w depth from camera along viewDir.
 */
function worldToViewUvW(
  world: Point3,
  focalPoint: Point3,
  position: Point3,
  right: Point3,
  up: Point3,
  viewDir: Point3
): Point3 {
  const fromFocal = sub(world, focalPoint);
  return [
    dot(fromFocal, right),
    dot(fromFocal, up),
    dot(sub(world, position), viewDir),
  ];
}

/** Inverse of worldToViewUvW for a given depth w. */
function viewUvWToWorld(
  u: number,
  v: number,
  w: number,
  focalPoint: Point3,
  position: Point3,
  right: Point3,
  up: Point3,
  viewDir: Point3
): Point3 {
  const onFocal = addScaled(focalPoint, right, u, up, v);
  const wOnFocal = dot(sub(onFocal, position), viewDir);
  return [
    onFocal[0] + viewDir[0] * (w - wOnFocal),
    onFocal[1] + viewDir[1] * (w - wOnFocal),
    onFocal[2] + viewDir[2] * (w - wOnFocal),
  ];
}

function intersectRanges(
  aMin: number,
  aMax: number,
  bMin: number,
  bMax: number
): [number, number] | undefined {
  const min = Math.max(aMin, bMin);
  const max = Math.min(aMax, bMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    return undefined;
  }
  return [min, max];
}

/**
 * Compute visible ROI from mview VolumeRenderer camera + active volume dims.
 * Matches the orthographic frustum in shaders.js (zoom, panX, panY, aspect).
 */
export function computeVisibleVolumeRoiFromMview(params: {
  zoom: number;
  panX: number;
  panY: number;
  aspect: number;
  activeDimensions: VolumeDims3;
  activeSpacing: VolumeDims3;
  sourceDimensions: VolumeDims3;
  sourceSpacing: VolumeDims3;
  imageData?: {
    indexToWorld?: (index: Point3, dest?: Point3) => Point3;
  };
  paddingVoxels?: number;
}): VisibleVolumeRoi | undefined {
  const {
    zoom,
    panX,
    panY,
    aspect,
    activeDimensions,
    activeSpacing,
    sourceDimensions,
    sourceSpacing,
    imageData,
    paddingVoxels = 3,
  } = params;

  if (
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    !Number.isFinite(aspect) ||
    aspect <= 0
  ) {
    logRoiCompute('mview: failed invalid zoom or aspect', { zoom, aspect });
    return undefined;
  }

  const physical = activeDimensions.map(
    (dim, axis) => dim * activeSpacing[axis]
  ) as VolumeDims3;
  const maxPhysical = Math.max(...physical);
  if (!Number.isFinite(maxPhysical) || maxPhysical <= 0) {
    return undefined;
  }
  const half = physical.map(
    (value) => (value / maxPhysical) * 0.5
  ) as VolumeDims3;

  const xVisMin = (-aspect - panX) * zoom;
  const xVisMax = (aspect - panX) * zoom;
  const yVisMin = (-1 - panY) * zoom;
  const yVisMax = (1 - panY) * zoom;

  const xRange = intersectRanges(xVisMin, xVisMax, -half[0], half[0]);
  const yRange = intersectRanges(yVisMin, yVisMax, -half[1], half[1]);
  const zRange: [number, number] = [-half[2], half[2]];

  if (!xRange || !yRange) {
    logRoiCompute('mview: failed lateral view does not intersect volume box', {
      viewExtents: { x: [xVisMin, xVisMax], y: [yVisMin, yVisMax] },
      boxHalf: half,
      zoom,
      panX,
      panY,
      aspect,
    });
    return undefined;
  }

  const [xMin, xMax] = xRange;
  const [yMin, yMax] = yRange;
  const [zMin, zMax] = zRange;

  const normToActiveIndex = (nx: number, axis: 0 | 1 | 2): number => {
    const dim = activeDimensions[axis];
    const h = half[axis];
    if (h <= 0) {
      return 0;
    }
    return ((nx + h) / (2 * h)) * dim;
  };

  let actMinI = Infinity;
  let actMinJ = Infinity;
  let actMinK = Infinity;
  let actMaxI = -Infinity;
  let actMaxJ = -Infinity;
  let actMaxK = -Infinity;

  for (const nx of [xMin, xMax]) {
    for (const ny of [yMin, yMax]) {
      for (const nz of [zMin, zMax]) {
        actMinI = Math.min(actMinI, normToActiveIndex(nx, 0));
        actMinJ = Math.min(actMinJ, normToActiveIndex(ny, 1));
        actMinK = Math.min(actMinK, normToActiveIndex(nz, 2));
        actMaxI = Math.max(actMaxI, normToActiveIndex(nx, 0));
        actMaxJ = Math.max(actMaxJ, normToActiveIndex(ny, 1));
        actMaxK = Math.max(actMaxK, normToActiveIndex(nz, 2));
      }
    }
  }

  const activeToSource = (activeIndex: number, axis: 0 | 1 | 2): number => {
    const srcDim = sourceDimensions[axis];
    const actDim = activeDimensions[axis];
    if (actDim <= 0) {
      return 0;
    }
    return (activeIndex * srcDim) / actDim;
  };

  const pad = Math.max(0, Math.floor(paddingVoxels));
  const ijkMin: VolumeDims3 = [
    Math.max(0, Math.floor(activeToSource(actMinI, 0)) - pad),
    Math.max(0, Math.floor(activeToSource(actMinJ, 1)) - pad),
    Math.max(0, Math.floor(activeToSource(actMinK, 2)) - pad),
  ];
  const ijkMax: VolumeDims3 = [
    Math.min(
      sourceDimensions[0] - 1,
      Math.ceil(activeToSource(actMaxI, 0)) + pad
    ),
    Math.min(
      sourceDimensions[1] - 1,
      Math.ceil(activeToSource(actMaxJ, 1)) + pad
    ),
    Math.min(
      sourceDimensions[2] - 1,
      Math.ceil(activeToSource(actMaxK, 2)) + pad
    ),
  ];

  if (ijkMin[0] > ijkMax[0] || ijkMin[1] > ijkMax[1] || ijkMin[2] > ijkMax[2]) {
    logRoiCompute('mview: failed empty source IJK after map', {
      activeIndexExtents: {
        i: [actMinI, actMaxI],
        j: [actMinJ, actMaxJ],
        k: [actMinK, actMaxK],
      },
      ijkMin,
      ijkMax,
    });
    return undefined;
  }

  const [dimI, dimJ, dimK] = sourceDimensions;
  const roiDimensions: VolumeDims3 = [
    ijkMax[0] - ijkMin[0] + 1,
    ijkMax[1] - ijkMin[1] + 1,
    ijkMax[2] - ijkMin[2] + 1,
  ];

  const centerIjk: Point3 = [
    (ijkMin[0] + ijkMax[0]) * 0.5,
    (ijkMin[1] + ijkMax[1]) * 0.5,
    (ijkMin[2] + ijkMax[2]) * 0.5,
  ];
  let roiWorldCenter: Point3 = centerIjk;
  if (typeof imageData?.indexToWorld === 'function') {
    roiWorldCenter = imageData.indexToWorld(centerIjk) as Point3;
  }

  const coverageFraction: VolumeDims3 = [
    roiDimensions[0] / dimI,
    roiDimensions[1] / dimJ,
    roiDimensions[2] / dimK,
  ];

  logRoiCompute('mview: ok', {
    ijkMin,
    ijkMax,
    roiDimensions,
    coverageFraction,
    zoom,
    panX,
    panY,
    viewIntersection: { x: xRange, y: yRange, z: zRange },
  });

  return {
    ijkMin,
    ijkMax,
    roiDimensions,
    roiSpacing: sourceSpacing,
    roiWorldCenter,
    coverageFraction,
  };
}

/**
 * Compute the IJK voxel bounds of the volume region visible in an orthographic
 * camera view by intersecting the volume world AABB with the view slab, then
 * mapping intersection corners to IJK.
 */
export function computeVisibleVolumeRoi(
  params: ComputeVisibleVolumeRoiParams
): VisibleVolumeRoi | undefined {
  const {
    focalPoint,
    position,
    viewPlaneNormal,
    viewUp,
    parallelScale,
    clippingRange,
    aspect,
    sourceDimensions,
    sourceSpacing,
    imageData,
    paddingVoxels = 3,
  } = params;

  if (
    !Number.isFinite(parallelScale) ||
    parallelScale <= 0 ||
    !Number.isFinite(aspect) ||
    aspect <= 0
  ) {
    logRoiCompute('failed: invalid parallelScale or aspect', {
      parallelScale,
      aspect,
    });
    return undefined;
  }

  if (typeof imageData.worldToIndex !== 'function') {
    logRoiCompute('failed: imageData.worldToIndex missing');
    return undefined;
  }

  const bounds = imageData.getBounds?.();
  if (!bounds || bounds.length < 6) {
    logRoiCompute('failed: imageData.getBounds missing');
    return undefined;
  }

  const viewDir = normalize(sub(focalPoint, position));
  let right = cross(viewUp, viewDir);
  const rightLen = Math.hypot(right[0], right[1], right[2]);
  if (rightLen < 1e-6) {
    right = normalize(cross([0, 0, 1], viewDir));
    if (Math.hypot(right[0], right[1], right[2]) < 1e-6) {
      right = normalize(cross([0, 1, 0], viewDir));
    }
  } else {
    right = [right[0] / rightLen, right[1] / rightLen, right[2] / rightLen];
  }
  const upDotDir = dot(viewUp, viewDir);
  const up = normalize([
    viewUp[0] - viewDir[0] * upDotDir,
    viewUp[1] - viewDir[1] * upDotDir,
    viewUp[2] - viewDir[2] * upDotDir,
  ]);
  if (
    Math.hypot(right[0], right[1], right[2]) < 1e-6 ||
    Math.hypot(up[0], up[1], up[2]) < 1e-6 ||
    Math.hypot(viewDir[0], viewDir[1], viewDir[2]) < 1e-6
  ) {
    logRoiCompute('failed: degenerate camera basis', {
      focalPoint,
      position,
      viewUp,
      viewPlaneNormal,
    });
    return undefined;
  }

  const halfH = parallelScale;
  const halfW = parallelScale * aspect;

  let volUMin = Infinity;
  let volUMax = -Infinity;
  let volVMin = Infinity;
  let volVMax = -Infinity;
  let volWMin = Infinity;
  let volWMax = -Infinity;

  for (const corner of volumeBoundsCorners(bounds)) {
    const [u, v, w] = worldToViewUvW(
      corner,
      focalPoint,
      position,
      right,
      up,
      viewDir
    );
    volUMin = Math.min(volUMin, u);
    volUMax = Math.max(volUMax, u);
    volVMin = Math.min(volVMin, v);
    volVMax = Math.max(volVMax, v);
    volWMin = Math.min(volWMin, w);
    volWMax = Math.max(volWMax, w);
  }

  const uRange = intersectRanges(volUMin, volUMax, -halfW, halfW);
  const vRange = intersectRanges(volVMin, volVMax, -halfH, halfH);
  // Orthographic mview renders the full volume box; VTK clippingRange is often
  // wrong on the empty-scene camera used for input. Use full volume depth (w).
  const wRange = intersectRanges(volWMin, volWMax, volWMin, volWMax);

  if (!uRange || !vRange || !wRange) {
    logRoiCompute('failed: view slab does not intersect volume AABB', {
      volumeViewExtents: {
        u: [volUMin, volUMax],
        v: [volVMin, volVMax],
        w: [volWMin, volWMax],
      },
      viewFrustum: {
        u: [-halfW, halfW],
        v: [-halfH, halfH],
      },
      clippingRange,
      parallelScale,
      aspect,
    });
    return undefined;
  }

  const [uMin, uMax] = uRange;
  const [vMin, vMax] = vRange;
  const [wMin, wMax] = wRange;

  const intersectionWorldCorners: Point3[] = [];
  for (const u of [uMin, uMax]) {
    for (const v of [vMin, vMax]) {
      for (const w of [wMin, wMax]) {
        intersectionWorldCorners.push(
          viewUvWToWorld(u, v, w, focalPoint, position, right, up, viewDir)
        );
      }
    }
  }

  let minI = Infinity;
  let minJ = Infinity;
  let minK = Infinity;
  let maxI = -Infinity;
  let maxJ = -Infinity;
  let maxK = -Infinity;

  for (const world of intersectionWorldCorners) {
    const ijk = readContinuousIndex(imageData, world);
    if (!ijk) {
      logRoiCompute('failed: worldToIndex returned non-finite index', {
        world,
      });
      return undefined;
    }
    minI = Math.min(minI, ijk[0]);
    minJ = Math.min(minJ, ijk[1]);
    minK = Math.min(minK, ijk[2]);
    maxI = Math.max(maxI, ijk[0]);
    maxJ = Math.max(maxJ, ijk[1]);
    maxK = Math.max(maxK, ijk[2]);
  }

  const [dimI, dimJ, dimK] = sourceDimensions;
  const pad = Math.max(0, Math.floor(paddingVoxels));
  const ijkMin: VolumeDims3 = [
    Math.max(0, Math.floor(minI) - pad),
    Math.max(0, Math.floor(minJ) - pad),
    Math.max(0, Math.floor(minK) - pad),
  ];
  const ijkMax: VolumeDims3 = [
    Math.min(dimI - 1, Math.ceil(maxI) + pad),
    Math.min(dimJ - 1, Math.ceil(maxJ) + pad),
    Math.min(dimK - 1, Math.ceil(maxK) + pad),
  ];

  if (ijkMin[0] > ijkMax[0] || ijkMin[1] > ijkMax[1] || ijkMin[2] > ijkMax[2]) {
    logRoiCompute('failed: empty IJK bounds after clamp', {
      rawIndexExtents: {
        i: [minI, maxI],
        j: [minJ, maxJ],
        k: [minK, maxK],
      },
      ijkMin,
      ijkMax,
      sourceDimensions,
    });
    return undefined;
  }

  const roiDimensions: VolumeDims3 = [
    ijkMax[0] - ijkMin[0] + 1,
    ijkMax[1] - ijkMin[1] + 1,
    ijkMax[2] - ijkMin[2] + 1,
  ];

  const roiSpacing = sourceSpacing;
  const centerIjk: Point3 = [
    (ijkMin[0] + ijkMax[0]) * 0.5,
    (ijkMin[1] + ijkMax[1]) * 0.5,
    (ijkMin[2] + ijkMax[2]) * 0.5,
  ];
  let roiWorldCenter: Point3 = centerIjk;
  if (typeof imageData.indexToWorld === 'function') {
    const world = imageData.indexToWorld(centerIjk);
    roiWorldCenter = [
      Number((world as ArrayLike<number>)[0]),
      Number((world as ArrayLike<number>)[1]),
      Number((world as ArrayLike<number>)[2]),
    ];
  }

  const coverageFraction: VolumeDims3 = [
    roiDimensions[0] / dimI,
    roiDimensions[1] / dimJ,
    roiDimensions[2] / dimK,
  ];

  logRoiCompute('ok', {
    ijkMin,
    ijkMax,
    roiDimensions,
    coverageFraction,
    viewIntersection: { u: uRange, v: vRange, w: wRange },
  });

  return {
    ijkMin,
    ijkMax,
    roiDimensions,
    roiSpacing,
    roiWorldCenter,
    coverageFraction,
  };
}

export function extractScalarRoi(
  source: ArrayLike<number>,
  srcDims: VolumeDims3,
  ijkMin: VolumeDims3,
  ijkMax: VolumeDims3
): Float32Array {
  const [minI, minJ, minK] = ijkMin;
  const roiW = ijkMax[0] - minI + 1;
  const roiH = ijkMax[1] - minJ + 1;
  const roiD = ijkMax[2] - minK + 1;
  const [srcW] = srcDims;
  const srcPlane = srcW * srcDims[1];
  const roiPlane = roiW * roiH;
  const dst = new Float32Array(roiW * roiH * roiD);
  const src = source as { [index: number]: number };

  for (let k = 0; k < roiD; k++) {
    const srcK = minK + k;
    const dstZBase = k * roiPlane;
    for (let j = 0; j < roiH; j++) {
      const srcJ = minJ + j;
      const dstRowBase = dstZBase + j * roiW;
      const srcRowBase = srcK * srcPlane + srcJ * srcW;
      for (let i = 0; i < roiW; i++) {
        dst[dstRowBase + i] = Number(src[srcRowBase + minI + i]) || 0;
      }
    }
  }

  return dst;
}

export function roiBoundsNear(
  a: { min: VolumeDims3; max: VolumeDims3 },
  b: { min: VolumeDims3; max: VolumeDims3 },
  tolerance = 2
): boolean {
  return (
    Math.abs(a.min[0] - b.min[0]) <= tolerance &&
    Math.abs(a.min[1] - b.min[1]) <= tolerance &&
    Math.abs(a.min[2] - b.min[2]) <= tolerance &&
    Math.abs(a.max[0] - b.max[0]) <= tolerance &&
    Math.abs(a.max[1] - b.max[1]) <= tolerance &&
    Math.abs(a.max[2] - b.max[2]) <= tolerance
  );
}

export function getVolumePhysicalMaxFromDims(
  dimensions: VolumeDims3,
  spacing: VolumeDims3
): number {
  const physical = [
    dimensions[0] * spacing[0],
    dimensions[1] * spacing[1],
    dimensions[2] * spacing[2],
  ];
  return Math.max(...physical);
}
