import type { IImageVolume } from '../../types';
import {
  buildWasmVtkBrickPlan,
  estimateVolumeScalarBytes,
  getWasmScalarBudgetBytes,
  ijkBoxVoxelCount,
  refineBrickPlanForByteBudget,
  type WasmIjkBox,
  type WasmVtkVolumeBrick,
  type WasmVtkVolumeBrickPlan,
} from '../helpers/volumeTextureBrickWasm';
import clonePoint3 from '../../utilities/clonePoint3';
import type {
  VtkWasmNamespace,
  VtkWasmObject,
  VtkWasmTypedArrayInterface,
} from './vtkWasmRuntime';
import { getVolumeScalarArray } from './webgpuMapperImageData';
import {
  finalizeVtkWasmImageDataScalars,
  SCALARS_ARRAY_NAME,
} from './vtkWasmImageDataFinalize';

type MarshallableTypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

export type VtkWasmBrickedVolumeBinding = {
  mode: 'denseBricks';
  brickPlan: WasmVtkVolumeBrickPlan;
  /** Stitched / active ImageData for ImageResliceMapper (MPR). */
  imageData: VtkWasmObject;
  /**
   * Multi-brick Volume3D: vtkMultiBlockDataSet of contiguous brick ImageDatas
   * for vtkMultiBlockVolumeMapper (one volume actor).
   */
  multiBlock: VtkWasmObject | undefined;
  /** True when Volume3D should feed multiBlock to vtkMultiBlockVolumeMapper. */
  useMultiBlockInput: boolean;
  /**
   * Fallback Volume3D path: one GPUVolumeRayCastMapper per brick when
   * MultiBlock mapper is unavailable.
   */
  useMultiVolumeInput: boolean;
  getBrickImageDatas: () => VtkWasmObject[];
  hasScalars: () => boolean;
  /** True once ImageReslice has a real slab (stitched or single-brick), not the empty stub. */
  hasMprInput: () => boolean;
  /** No-op — geometry is already split into bricks. */
  applyPartitions: (mapper: VtkWasmObject) => void | Promise<void>;
  /**
   * Upload dense bricks from the CS volume (all bricks for Volume3D, or
   * ensure pool ready). Never allocates one full-volume WASM buffer.
   */
  refreshScalars: (
    dirtyBox?: WasmIjkBox,
    options?: { force?: boolean }
  ) => Promise<boolean>;
  /**
   * MPR: select bricks intersecting the world plane, stitch into `imageData`.
   * Call after plane changes (and after refreshScalars once loaded).
   */
  syncMprPlane: (
    originWorld: [number, number, number],
    normalWorld: [number, number, number],
    halfThicknessMm?: number
  ) => Promise<boolean>;
  dispose: () => void;
};

async function callMaybeAsync(result: unknown): Promise<unknown> {
  return await result;
}

function disposeVtkObject(obj: VtkWasmObject | undefined): void {
  if (!obj) {
    return;
  }
  try {
    obj.$delete?.();
  } catch {
    // ignore
  }
}

function toMarshallableTypedArray(
  scalars: ArrayLike<number>
): MarshallableTypedArray {
  if (
    scalars instanceof Float32Array ||
    scalars instanceof Float64Array ||
    scalars instanceof Int8Array ||
    scalars instanceof Uint8Array ||
    scalars instanceof Int16Array ||
    scalars instanceof Uint16Array ||
    scalars instanceof Int32Array ||
    scalars instanceof Uint32Array
  ) {
    return scalars;
  }
  return Float32Array.from(scalars as ArrayLike<number>);
}

function vtkArrayCtorName(typed: MarshallableTypedArray): string {
  if (typed instanceof Float64Array) {
    return 'vtkTypeFloat64Array';
  }
  if (typed instanceof Int16Array) {
    return 'vtkTypeInt16Array';
  }
  if (typed instanceof Uint16Array) {
    return 'vtkTypeUInt16Array';
  }
  if (typed instanceof Int8Array) {
    return 'vtkTypeInt8Array';
  }
  if (typed instanceof Uint8Array) {
    return 'vtkTypeUInt8Array';
  }
  if (typed instanceof Int32Array) {
    return 'vtkTypeInt32Array';
  }
  if (typed instanceof Uint32Array) {
    return 'vtkTypeUInt32Array';
  }
  return 'vtkTypeFloat32Array';
}

function getNumberOfComponents(imageVolume: IImageVolume): number {
  const imageDataMeta = imageVolume.imageData?.get?.('numberOfComponents') as
    | { numberOfComponents?: number }
    | undefined;
  return Math.max(1, imageDataMeta?.numberOfComponents ?? 1);
}

/**
 * Copy a full-volume IJK box into a dense brick-sized dest (local 0-based).
 */
export function copyIjkBoxIntoDenseBrick(
  source: MarshallableTypedArray,
  dest: MarshallableTypedArray & {
    set: (array: ArrayLike<number>, offset?: number) => void;
  },
  volumeDimensions: [number, number, number],
  extent: WasmIjkBox,
  numberOfComponents: number
): void {
  const [dx, dy] = volumeDimensions;
  const [i0, i1, j0, j1, k0, k1] = extent;
  const brickDx = i1 - i0 + 1;
  const brickDy = j1 - j0 + 1;
  const rowLen = brickDx * numberOfComponents;
  if (rowLen <= 0) {
    return;
  }

  for (let k = k0; k <= k1; k++) {
    for (let j = j0; j <= j1; j++) {
      const srcStart = ((k * dy + j) * dx + i0) * numberOfComponents;
      const destStart =
        ((k - k0) * brickDy + (j - j0)) * brickDx * numberOfComponents;
      dest.set(source.subarray(srcStart, srcStart + rowLen), destStart);
    }
  }
}

function brickWorldOrigin(
  volumeOrigin: [number, number, number],
  spacing: [number, number, number],
  direction: number[] | undefined,
  ijk: [number, number, number]
): [number, number, number] {
  const [i, j, k] = ijk;
  const [sx, sy, sz] = spacing;
  if (direction && direction.length >= 9) {
    const d = direction;
    return [
      volumeOrigin[0] + (d[0] * i * sx + d[1] * j * sy + d[2] * k * sz),
      volumeOrigin[1] + (d[3] * i * sx + d[4] * j * sy + d[5] * k * sz),
      volumeOrigin[2] + (d[6] * i * sx + d[7] * j * sy + d[8] * k * sz),
    ];
  }
  return [
    volumeOrigin[0] + i * sx,
    volumeOrigin[1] + j * sy,
    volumeOrigin[2] + k * sz,
  ];
}

function worldToIjk(
  imageVolume: IImageVolume,
  world: [number, number, number]
): [number, number, number] {
  const imageData = imageVolume.imageData as
    | {
        worldToIndex?: (
          w: [number, number, number]
        ) => [number, number, number] | ArrayLike<number>;
      }
    | undefined;
  if (typeof imageData?.worldToIndex === 'function') {
    const ijk = imageData.worldToIndex(world);
    return [Number(ijk[0]), Number(ijk[1]), Number(ijk[2])];
  }
  const origin = imageVolume.origin as [number, number, number];
  const spacing = imageVolume.spacing as [number, number, number];
  return [
    (world[0] - origin[0]) / spacing[0],
    (world[1] - origin[1]) / spacing[1],
    (world[2] - origin[2]) / spacing[2],
  ];
}

function worldNormalToIjk(
  imageVolume: IImageVolume,
  originWorld: [number, number, number],
  normalWorld: [number, number, number]
): [number, number, number] {
  const p0 = worldToIjk(imageVolume, originWorld);
  const p1 = worldToIjk(imageVolume, [
    originWorld[0] + normalWorld[0],
    originWorld[1] + normalWorld[1],
    originWorld[2] + normalWorld[2],
  ]);
  return [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
}

type BrickSlot = {
  brick: WasmVtkVolumeBrick;
  imageData: VtkWasmObject;
  scalarsArray?: VtkWasmObject;
  uploaded: boolean;
};

/**
 * Dense per-brick ImageData pool for large volumes / XY-partitioned WebGL.
 * Avoids one full-volume `heap.alloc`. Volume3D prefers MultiBlockVolumeMapper;
 * MPR stitches plane-hit bricks.
 */
export function bindVtkWasmBrickedVolume(
  vtk: VtkWasmNamespace,
  imageVolume: IImageVolume,
  typedArrayInterface?: VtkWasmTypedArrayInterface
): VtkWasmBrickedVolumeBinding {
  if (!vtk.vtkImageData) {
    throw new Error('[vtkWasm] vtkImageData is not available in this bundle');
  }

  const dimensions = imageVolume.dimensions as [number, number, number];
  // Plain arrays only: TypedArrays JSON-serialize as objects and fail
  // vtk-wasm DeserializeJSON (type must be array).
  const spacing = clonePoint3(imageVolume.spacing);
  const origin = clonePoint3(imageVolume.origin);
  const direction = (imageVolume.direction ??
    imageVolume.imageData?.getDirection?.()) as number[] | undefined;
  const numberOfComponents = getNumberOfComponents(imageVolume);

  let brickPlan = buildWasmVtkBrickPlan(dimensions);
  // Fixed grids are authoritative — never re-partition for a byte budget
  // (that would allocate a different brick layout than the configured grid).
  if (brickPlan.strategy !== 'fixed') {
    const sample = getVolumeScalarArray(imageVolume);
    const bytesPerElement =
      sample && 'BYTES_PER_ELEMENT' in sample
        ? (sample as MarshallableTypedArray).BYTES_PER_ELEMENT
        : 2;
    brickPlan = refineBrickPlanForByteBudget(
      brickPlan,
      bytesPerElement,
      numberOfComponents
    );
  }

  const isSingleBrick = brickPlan.bricks.length <= 1;
  const multiBlockMapperAvailable =
    typeof vtk.vtkMultiBlockVolumeMapper === 'function';
  const multiBlockCtor = vtk.vtkMultiBlockDataSet;
  const multiBlock =
    !isSingleBrick && typeof multiBlockCtor === 'function'
      ? (multiBlockCtor() as VtkWasmObject)
      : undefined;
  const useMultiBlockInput =
    !isSingleBrick && !!multiBlock && multiBlockMapperAvailable;
  const useMultiVolumeInput = !isSingleBrick && !useMultiBlockInput;
  if (!isSingleBrick && !useMultiBlockInput) {
    console.warn(
      '[vtkWasm] vtkMultiBlockVolumeMapper/DataSet unavailable; falling back to per-brick volumes'
    );
  }

  const syncMultiBlockDataset = async (): Promise<void> => {
    if (!multiBlock) {
      return;
    }
    const uploaded = slots.filter((s) => s.uploaded);
    const setNumberOfBlocks = multiBlock.setNumberOfBlocks as
      | ((n: number) => unknown)
      | undefined;
    const setBlock = multiBlock.setBlock as
      | ((i: number, block: VtkWasmObject) => unknown)
      | undefined;
    if (typeof setNumberOfBlocks === 'function') {
      await callMaybeAsync(setNumberOfBlocks.call(multiBlock, uploaded.length));
    }
    if (typeof setBlock === 'function') {
      for (let i = 0; i < uploaded.length; i++) {
        await callMaybeAsync(
          setBlock.call(multiBlock, i, uploaded[i].imageData)
        );
      }
    }
    await callMaybeAsync(
      (multiBlock.modified as (() => unknown) | undefined)?.()
    );
  };

  const applyDirection = (imageData: VtkWasmObject): void => {
    if (!direction || direction.length < 9) {
      return;
    }
    const dir9 = Array.from(direction.slice(0, 9));
    const matrixCtor = vtk.vtkMatrix3x3;
    if (typeof matrixCtor === 'function') {
      const matrix = matrixCtor() as VtkWasmObject;
      const setData = matrix.setData as
        | ((data: number[]) => unknown)
        | undefined;
      setData?.(dir9);
      const setDirectionMatrix = imageData.setDirectionMatrix as
        | ((m: unknown) => unknown)
        | undefined;
      if (setDirectionMatrix) {
        setDirectionMatrix(matrix);
      } else {
        imageData.$set?.({ directionMatrix: matrix });
      }
    } else {
      imageData.$set?.({ direction: dir9 });
    }
  };

  /**
   * Build a fully consistent ImageData offline (not yet connected to a mapper).
   *
   * Order: attach filled typed scalars → setNumberOfTuples → extent/dims →
   * verify live getScalars. Never SetDimensions before attach (float zeros)
   * and never probe the pre-geometry array id after geometry.
   */
  const buildCompleteImageData = async (
    box: WasmIjkBox,
    vtkArray: VtkWasmObject,
    sourceForVerify?: ArrayLike<number>
  ): Promise<
    { imageData: VtkWasmObject; liveScalars: VtkWasmObject } | undefined
  > => {
    const sx = box[1] - box[0] + 1;
    const sy = box[3] - box[2] + 1;
    const sz = box[5] - box[4] + 1;
    if (sx <= 0 || sy <= 0 || sz <= 0) {
      return undefined;
    }
    const brickOrigin = brickWorldOrigin(origin, spacing, direction, [
      box[0],
      box[2],
      box[4],
    ]);
    const extent: [number, number, number, number, number, number] = [
      0,
      Math.max(0, sx - 1),
      0,
      Math.max(0, sy - 1),
      0,
      Math.max(0, sz - 1),
    ];
    const dims: [number, number, number] = [sx, sy, sz];
    const expectedValueCount = sx * sy * sz * numberOfComponents;
    const numVoxels = sx * sy * sz;

    // No dimensions in the ctor — avoids float AllocateScalars before attach.
    const imageData = vtk.vtkImageData({
      spacing,
      origin: brickOrigin,
    }) as VtkWasmObject;
    applyDirection(imageData);

    const finalized = await finalizeVtkWasmImageDataScalars({
      imageData,
      vtkArray,
      numVoxels,
      expectedValueCount,
      dimensions: dims,
      extent,
      origin: brickOrigin,
      spacing,
      typedArrayInterface,
      sourceForVerify,
      logLabel: 'mode=denseBrick',
      applyDirection,
    });
    if (!finalized.ok || !finalized.liveScalars) {
      disposeVtkObject(imageData);
      return undefined;
    }

    return { imageData, liveScalars: finalized.liveScalars };
  };

  const slots: BrickSlot[] = [];
  for (const brick of brickPlan.bricks) {
    // Placeholder until first successful upload replaces imageData.
    const imageData = vtk.vtkImageData({
      dimensions: [1, 1, 1],
      spacing,
      origin,
    }) as VtkWasmObject;
    slots.push({ brick, imageData, uploaded: false });
  }

  // MPR double-buffer: always swap in a complete ImageData; never resize the
  // instance currently wired to ImageResliceMapper mid-update.
  // Do NOT pass dimensions into the ctor — that AllocateScalars as float.
  let mprImageData: VtkWasmObject = vtk.vtkImageData({
    spacing,
    origin,
  }) as VtkWasmObject;

  let refreshInFlight: Promise<boolean> | null = null;
  let pendingRefresh = false;
  let anyUploaded = false;
  let mprSlabReady = false;
  let lastMprKey = '';
  /** When volume fits the WASM budget, MPR uses one full ImageData (no thin slabs). */
  let mprFullVolumeReady = false;

  const allocatePointerBackedArray = async (
    numValues: number,
    typedPrototype: MarshallableTypedArray,
    numberOfComponentsLocal: number
  ): Promise<VtkWasmObject | undefined> => {
    const heap = typedArrayInterface;
    if (!heap?.alloc || !heap.toSizeType) {
      console.warn(
        '[vtkWasm] typedArrayInterface.alloc unavailable; cannot upload brick'
      );
      return undefined;
    }
    const ctorName = vtkArrayCtorName(typedPrototype);
    const arrayCtor = vtk[ctorName];
    if (!arrayCtor) {
      console.warn(`[vtkWasm] missing ${ctorName}; brick not uploaded`);
      return undefined;
    }
    const byteLength = numValues * typedPrototype.BYTES_PER_ELEMENT;
    let pointer: number | bigint;
    try {
      pointer = heap.alloc(byteLength);
    } catch (error) {
      console.warn('[vtkWasm] heap.alloc failed for dense brick', error);
      return undefined;
    }
    if (pointer === undefined || pointer === null) {
      return undefined;
    }
    const dataArray = arrayCtor({
      numberOfComponents: numberOfComponentsLocal,
      name: SCALARS_ARRAY_NAME,
    }) as VtkWasmObject;
    const setName = dataArray.setName as ((n: string) => unknown) | undefined;
    setName?.(SCALARS_ARRAY_NAME);
    const setNumberOfComponents = dataArray.setNumberOfComponents as
      | ((n: number) => unknown)
      | undefined;
    setNumberOfComponents?.(numberOfComponentsLocal);
    try {
      const setArray = dataArray.setArray as
        | ((
            array: number | bigint,
            size: number | bigint,
            save: number
          ) => unknown)
        | undefined;
      if (!setArray) {
        heap.free?.(pointer);
        disposeVtkObject(dataArray);
        return undefined;
      }
      await callMaybeAsync(setArray(pointer, heap.toSizeType(numValues), 0));
    } catch (error) {
      try {
        heap.free?.(pointer);
      } catch {
        // ignore
      }
      disposeVtkObject(dataArray);
      console.warn('[vtkWasm] brick setArray(pointer) failed', error);
      return undefined;
    }
    return dataArray;
  };

  const fillBrickSlot = async (
    slot: BrickSlot,
    typed: MarshallableTypedArray,
    force: boolean
  ): Promise<boolean> => {
    if (slot.uploaded && !force) {
      return true;
    }
    const [sx, sy, sz] = slot.brick.textureSize;
    const numValues = sx * sy * sz * numberOfComponents;
    if (numValues <= 0) {
      return false;
    }

    const next = await allocatePointerBackedArray(
      numValues,
      typed,
      numberOfComponents
    );
    if (!next) {
      return false;
    }
    const dest = typedArrayInterface?.toJSTypedArray?.(next) as
      | (MarshallableTypedArray & {
          set: (array: ArrayLike<number>, offset?: number) => void;
        })
      | undefined;
    if (!dest || dest.length !== numValues) {
      disposeVtkObject(next);
      return false;
    }
    copyIjkBoxIntoDenseBrick(
      typed,
      dest,
      dimensions,
      slot.brick.extent,
      numberOfComponents
    );

    const [i0, i1, j0, j1, k0, k1] = slot.brick.extent;
    const built = await buildCompleteImageData(
      [i0, i1, j0, j1, k0, k1],
      next,
      dest
    );
    if (!built) {
      disposeVtkObject(next);
      return false;
    }

    const previousImage = slot.imageData;
    slot.imageData = built.imageData;
    slot.scalarsArray = built.liveScalars;
    slot.uploaded = true;
    // Scalars are owned by ImageData (setArray save=0) — only dispose image.
    if (previousImage && previousImage !== built.imageData) {
      disposeVtkObject(previousImage);
    }
    return true;
  };

  const uploadAllBricks = async (force = false): Promise<boolean> => {
    const scalars = getVolumeScalarArray(imageVolume);
    if (!scalars || scalars.length <= 0) {
      return anyUploaded;
    }
    const expected =
      dimensions[0] * dimensions[1] * dimensions[2] * numberOfComponents;
    if (scalars.length < expected) {
      return anyUploaded;
    }
    const typed = toMarshallableTypedArray(scalars);
    let okCount = 0;
    for (const slot of slots) {
      if (await fillBrickSlot(slot, typed, force)) {
        okCount += 1;
      }
    }
    anyUploaded = okCount > 0;
    if (anyUploaded) {
      await syncMultiBlockDataset();
    }
    return anyUploaded;
  };

  /**
   * Thin AABB around the plane (full in-plane, few voxels along dominant
   * normal). Keeps ImageReslice input small vs stitching a whole brick layer.
   */
  const thinSlabBoxAroundPlane = (
    planeIjk: [number, number, number],
    normalIjk: [number, number, number],
    halfThicknessIndex: number
  ): WasmIjkBox => {
    const nLen = Math.hypot(normalIjk[0], normalIjk[1], normalIjk[2]) || 1;
    const n: [number, number, number] = [
      normalIjk[0] / nLen,
      normalIjk[1] / nLen,
      normalIjk[2] / nLen,
    ];
    let axis: 0 | 1 | 2 = 0;
    if (Math.abs(n[1]) > Math.abs(n[axis])) {
      axis = 1;
    }
    if (Math.abs(n[2]) > Math.abs(n[axis])) {
      axis = 2;
    }
    const halfT = Math.max(1, Math.ceil(halfThicknessIndex));
    const box: WasmIjkBox = [
      0,
      Math.max(0, dimensions[0] - 1),
      0,
      Math.max(0, dimensions[1] - 1),
      0,
      Math.max(0, dimensions[2] - 1),
    ];
    const c = planeIjk[axis];
    const lo = Math.max(0, Math.floor(c - halfT));
    const hi = Math.min(dimensions[axis] - 1, Math.ceil(c + halfT));
    box[axis * 2] = lo;
    box[axis * 2 + 1] = Math.max(lo, hi);
    return box;
  };

  let mprScalars: VtkWasmObject | undefined;

  /**
   * Build MPR ImageReslice input as a **new** ImageData (dims + scalars
   * consistent), then swap. Never resizes the ImageData currently connected
   * to the mapper — that caused texImage3D "ArrayBufferView not big enough".
   */
  const stitchBricksIntoMpr = async (
    stitchBox: WasmIjkBox
  ): Promise<boolean> => {
    const scalars = getVolumeScalarArray(imageVolume);
    if (!scalars || scalars.length <= 0) {
      return false;
    }
    const typed = toMarshallableTypedArray(scalars);
    const stitchVoxels = ijkBoxVoxelCount(stitchBox);
    if (stitchVoxels <= 0) {
      return false;
    }
    const stitchValues = stitchVoxels * numberOfComponents;

    const nextScalars = await allocatePointerBackedArray(
      stitchValues,
      typed,
      numberOfComponents
    );
    if (!nextScalars) {
      return false;
    }
    const dest = typedArrayInterface?.toJSTypedArray?.(nextScalars) as
      | (MarshallableTypedArray & {
          set: (array: ArrayLike<number>, offset?: number) => void;
        })
      | undefined;
    if (!dest || dest.length !== stitchValues) {
      disposeVtkObject(nextScalars);
      return false;
    }
    copyIjkBoxIntoDenseBrick(
      typed,
      dest,
      dimensions,
      stitchBox,
      numberOfComponents
    );

    const fresh = await buildCompleteImageData(stitchBox, nextScalars, dest);
    if (!fresh) {
      disposeVtkObject(nextScalars);
      return false;
    }

    const previousImage = mprImageData;
    mprImageData = fresh.imageData;
    mprScalars = fresh.liveScalars;
    if (previousImage && previousImage !== fresh.imageData) {
      disposeVtkObject(previousImage);
    }
    anyUploaded = true;
    mprSlabReady = true;
    return true;
  };

  const refreshScalars = async (
    _dirtyBox?: WasmIjkBox,
    options?: { force?: boolean }
  ): Promise<boolean> => {
    const force = options?.force === true;
    if (force) {
      // Force brick rebuild invalidates any prior MPR stitch cache.
      lastMprKey = '';
      mprFullVolumeReady = false;
      mprSlabReady = false;
    }
    pendingRefresh = true;
    while (pendingRefresh) {
      if (!refreshInFlight) {
        refreshInFlight = (async () => {
          let ok = anyUploaded;
          while (pendingRefresh) {
            pendingRefresh = false;
            // Volume3D: upload every dense brick.
            // MPR single-brick can reuse these; multi-brick MPR stitches via syncMprPlane.
            ok = await uploadAllBricks(force);
            if (ok && isSingleBrick) {
              mprSlabReady = true;
            }
          }
          return ok;
        })().finally(() => {
          refreshInFlight = null;
        });
      }
      await refreshInFlight;
    }
    return anyUploaded;
  };

  const syncMprPlane = async (
    originWorld: [number, number, number],
    normalWorld: [number, number, number],
    halfThicknessMm = 2
  ): Promise<boolean> => {
    // Single full-volume brick: ImageReslice can consume it directly (no stitch).
    if (brickPlan.bricks.length === 1) {
      const ok = await uploadAllBricks(false);
      if (ok) {
        lastMprKey = '';
        mprSlabReady = true;
        mprFullVolumeReady = true;
      }
      return ok;
    }

    // Under budget: stitch the **full** volume once. Thin slabs can miss the
    // slice plane / confuse ImageReslice; small studies used to work this way
    // on the single binding path. Volume3D still uses the brick MultiBlock.
    if (mprFullVolumeReady) {
      // Full volume already bound — plane changes only need mapper slicePlane.
      return true;
    }

    const sample = getVolumeScalarArray(imageVolume);
    const bpe =
      sample && 'BYTES_PER_ELEMENT' in sample
        ? (sample as MarshallableTypedArray).BYTES_PER_ELEMENT
        : 2;
    const fullBytes = estimateVolumeScalarBytes(
      dimensions,
      bpe,
      numberOfComponents
    );
    if (fullBytes > 0 && fullBytes <= getWasmScalarBudgetBytes()) {
      const fullBox: WasmIjkBox = [
        0,
        Math.max(0, dimensions[0] - 1),
        0,
        Math.max(0, dimensions[1] - 1),
        0,
        Math.max(0, dimensions[2] - 1),
      ];
      const ok = await stitchBricksIntoMpr(fullBox);
      if (ok) {
        mprFullVolumeReady = true;
        lastMprKey = '';
        console.info(
          `[vtkWasm] MPR full-volume input ready dims=${dimensions.join('x')} ` +
            `(under scalar budget; plane-only updates afterwards)`
        );
        return true;
      }
      console.warn(
        '[vtkWasm] MPR full-volume stitch failed; falling back to thin slab'
      );
    }

    const planeIjk = worldToIjk(imageVolume, originWorld);
    const normalIjk = worldNormalToIjk(imageVolume, originWorld, normalWorld);
    const spacingAvg =
      (Math.abs(spacing[0]) + Math.abs(spacing[1]) + Math.abs(spacing[2])) / 3;
    const halfThicknessIndex =
      spacingAvg > 0 ? Math.max(1, halfThicknessMm / spacingAvg) : 1;

    const key = `${planeIjk.map((v) => v.toFixed(2)).join(',')}|${normalIjk
      .map((v) => v.toFixed(3))
      .join(',')}|${halfThicknessIndex.toFixed(2)}`;
    if (key === lastMprKey && mprSlabReady) {
      return true;
    }

    // Prefer a thin plane slab over the full AABB of intersecting bricks
    // (an axial 8×8 layer AABB is ~full XY × Z-brick and blows texImage3D).
    const stitchBox = thinSlabBoxAroundPlane(
      planeIjk,
      normalIjk,
      halfThicknessIndex
    );
    const ok = await stitchBricksIntoMpr(stitchBox);
    if (ok) {
      lastMprKey = key;
      console.info(
        `[vtkWasm] MPR slab ready dims=${stitchBox[1] - stitchBox[0] + 1}x` +
          `${stitchBox[3] - stitchBox[2] + 1}x${stitchBox[5] - stitchBox[4] + 1}`
      );
    } else {
      console.warn('[vtkWasm] MPR syncMprPlane stitch failed');
    }
    return ok;
  };

  return {
    mode: 'denseBricks',
    brickPlan,
    get imageData() {
      // Single-brick Volume3D/MPR: expose the uploaded brick, not the MPR stub.
      if (isSingleBrick && slots[0]?.uploaded) {
        return slots[0].imageData;
      }
      return mprImageData;
    },
    get multiBlock() {
      return multiBlock;
    },
    useMultiBlockInput,
    useMultiVolumeInput,
    getBrickImageDatas: () =>
      slots.filter((s) => s.uploaded).map((s) => s.imageData),
    hasScalars: () => anyUploaded,
    hasMprInput: () =>
      isSingleBrick ? !!(slots[0]?.uploaded && mprSlabReady) : mprSlabReady,
    applyPartitions: async () => {
      // Dense bricks replace SetPartitions.
    },
    refreshScalars,
    syncMprPlane,
    dispose: () => {
      for (const slot of slots) {
        disposeVtkObject(slot.imageData);
        slot.scalarsArray = undefined;
      }
      // mprImageData may alias the single brick — avoid double-free.
      if (
        !isSingleBrick ||
        !slots[0]?.uploaded ||
        mprImageData !== slots[0].imageData
      ) {
        disposeVtkObject(mprImageData);
      }
      disposeVtkObject(multiBlock);
      mprScalars = undefined;
      anyUploaded = false;
      mprSlabReady = false;
      mprFullVolumeReady = false;
      lastMprKey = '';
    },
  };
}
