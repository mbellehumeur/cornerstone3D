import type { IImageVolume } from '../../types';
import {
  buildWasmVtkBrickPlan,
  fullVolumeRegionToBrickUploads,
  ijkBoxVoxelCount,
  shouldUseDenseWasmBricks,
  wasmPartitionsNeedContiguousBricks,
  type WasmIjkBox,
  type WasmVtkBrickPartitionOptions,
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
  bindVtkWasmBrickedVolume,
  copyIjkBoxIntoDenseBrick,
} from './vtkWasmBrickedVolumeBinding';
import {
  finalizeVtkWasmImageDataScalars,
  SCALARS_ARRAY_NAME,
  verifyVtkWasmImageDataGpuReady,
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

export type VtkWasmRefreshScalarsOptions = {
  /** Rebuild brick ImageData even if already uploaded (load-complete). */
  force?: boolean;
};

export type BindVtkWasmVolumeOptions = {
  brickPartitionOptions?: WasmVtkBrickPartitionOptions;
};

export type CreateVtkWasmVolumeBindingOptions = BindVtkWasmVolumeOptions;

export type VtkWasmVolumeBinding = {
  mode?: 'single' | 'denseBricks';
  brickPlan: WasmVtkVolumeBrickPlan;
  imageData: VtkWasmObject;
  /**
   * Dense multi-brick Volume3D: vtkMultiBlockDataSet for
   * vtkMultiBlockVolumeMapper (preferred over per-brick volumes).
   */
  multiBlock?: VtkWasmObject;
  /** Prefer MultiBlockVolumeMapper when true (multi-brick dense). */
  useMultiBlockInput?: boolean;
  /**
   * Fallback Volume3D: one GPUVolumeRayCastMapper + vtkVolume per brick
   * when MultiBlock mapper is unavailable. False for single-brick plans.
   */
  useMultiVolumeInput?: boolean;
  getBrickImageDatas?: () => VtkWasmObject[];
  /** Dense multi-brick: how many bricks uploaded vs planned. */
  getBrickUploadStatus?: () => { uploaded: number; total: number };
  /** True once point-data scalars have been successfully attached. */
  hasScalars: () => boolean;
  /**
   * True when ImageReslice can bind a real volume/slab (not the dense MPR stub).
   * Single path: same as hasScalars. Dense multi-brick: after syncMprPlane stitch.
   */
  hasMprInput?: () => boolean;
  /** Apply SetPartitions on a volume mapper when supported. */
  applyPartitions: (mapper: VtkWasmObject) => void | Promise<void>;
  /**
   * Upload scalars once (or refresh in place). Uses heap `alloc` + pointer
   * `setArray` and fills brick-by-brick — never `toVTKAoSArray` / JS TypedArray
   * through the serializer (those OOM on bricked volumes).
   */
  refreshScalars: (
    dirtyBox?: WasmIjkBox,
    options?: VtkWasmRefreshScalarsOptions
  ) => Promise<boolean>;
  /**
   * Dense-brick MPR: stitch bricks intersecting the world plane into imageData.
   */
  syncMprPlane?: (
    originWorld: [number, number, number],
    normalWorld: [number, number, number],
    halfThicknessMm?: number
  ) => Promise<boolean>;
  /** MPR display ImageData (thin slab); Volume3D keeps using {@link imageData}. */
  getMprImageData?: () => VtkWasmObject;
  dispose?: () => void;
};

function getExpectedScalarLength(
  imageVolume: IImageVolume,
  dimensions: [number, number, number]
): number {
  const imageDataMeta = imageVolume.imageData?.get?.('numberOfComponents') as
    | { numberOfComponents?: number }
    | undefined;
  const components = Math.max(1, imageDataMeta?.numberOfComponents ?? 1);
  return dimensions[0] * dimensions[1] * dimensions[2] * components;
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

async function callMaybeAsync(result: unknown): Promise<unknown> {
  return await result;
}

async function allocatePointerBackedArrayForCount(
  numValues: number,
  typedPrototype: MarshallableTypedArray,
  numberOfComponents: number,
  vtk: VtkWasmNamespace,
  typedArrayInterface?: VtkWasmTypedArrayInterface
): Promise<VtkWasmObject | undefined> {
  const heap = typedArrayInterface;
  if (!heap?.alloc || !heap.toSizeType) {
    console.warn(
      '[vtkWasm] typedArrayInterface.alloc unavailable; cannot upload MPR slab'
    );
    return undefined;
  }
  const ctorName = vtkArrayCtorName(typedPrototype);
  const arrayCtor = vtk[ctorName];
  if (!arrayCtor) {
    console.warn(`[vtkWasm] missing ${ctorName}; MPR slab not uploaded`);
    return undefined;
  }
  const byteLength = numValues * typedPrototype.BYTES_PER_ELEMENT;
  let pointer: number | bigint;
  try {
    pointer = heap.alloc(byteLength);
  } catch (error) {
    console.warn('[vtkWasm] heap.alloc failed for MPR slab', error);
    return undefined;
  }
  if (pointer === undefined || pointer === null) {
    return undefined;
  }
  const dataArray = arrayCtor({
    numberOfComponents,
    name: SCALARS_ARRAY_NAME,
  }) as VtkWasmObject;
  const setName = dataArray.setName as ((n: string) => unknown) | undefined;
  setName?.(SCALARS_ARRAY_NAME);
  const setNumberOfComponents = dataArray.setNumberOfComponents as
    | ((n: number) => unknown)
    | undefined;
  setNumberOfComponents?.(numberOfComponents);
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
    console.warn('[vtkWasm] MPR slab setArray(pointer) failed', error);
    return undefined;
  }
  return dataArray;
}

/**
 * Invoke a vtk-wasm method if present. Returns false when the Proxy rejects
 * the name (typed builds throw instead of returning undefined).
 */
async function tryInvokeMapper(
  mapper: VtkWasmObject,
  method: string,
  ...args: unknown[]
): Promise<boolean> {
  try {
    const fn = (mapper as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      return false;
    }
    await callMaybeAsync(
      (fn as (...a: unknown[]) => unknown).apply(mapper, args)
    );
    return true;
  } catch {
    return false;
  }
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

function worldToIjkForMpr(
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

function worldNormalToIjkForMpr(
  imageVolume: IImageVolume,
  originWorld: [number, number, number],
  normalWorld: [number, number, number]
): [number, number, number] {
  const p0 = worldToIjkForMpr(imageVolume, originWorld);
  const p1 = worldToIjkForMpr(imageVolume, [
    originWorld[0] + normalWorld[0],
    originWorld[1] + normalWorld[1],
    originWorld[2] + normalWorld[2],
  ]);
  return [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
}

function brickWorldOriginForMpr(
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

function thinSlabBoxAroundPlaneForMpr(
  dimensions: [number, number, number],
  planeIjk: [number, number, number],
  normalIjk: [number, number, number],
  halfThicknessIndex: number
): WasmIjkBox {
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
}

/**
 * Copy one IJK brick region from a full-volume source into a same-layout dest.
 */
function copyIjkBoxIntoVolume(
  source: MarshallableTypedArray,
  dest: MarshallableTypedArray & {
    set: (array: ArrayLike<number>, offset?: number) => void;
  },
  dimensions: [number, number, number],
  extent: [number, number, number, number, number, number],
  numberOfComponents: number
): void {
  const [dx, dy] = dimensions;
  const [i0, i1, j0, j1, k0, k1] = extent;
  const rowTuples = i1 - i0 + 1;
  const rowLen = rowTuples * numberOfComponents;
  if (rowLen <= 0) {
    return;
  }

  for (let k = k0; k <= k1; k++) {
    for (let j = j0; j <= j1; j++) {
      const start = ((k * dy + j) * dx + i0) * numberOfComponents;
      dest.set(source.subarray(start, start + rowLen), start);
    }
  }
}

/**
 * Build vtk ImageData in a wasm session and attach a VTK partition brick plan.
 * Prefers stock mapper.SetPartitions for Volume3D streaming.
 *
 * Scalar upload: heap `alloc` + pointer `setArray` + brick-chunked fill.
 * Avoids `toVTKAoSArray` / serializer paths that `bad_alloc` on large volumes.
 */
export function bindVtkWasmVolume(
  vtk: VtkWasmNamespace,
  imageVolume: IImageVolume,
  typedArrayInterface?: VtkWasmTypedArrayInterface,
  options?: BindVtkWasmVolumeOptions
): VtkWasmVolumeBinding {
  const dimensions = imageVolume.dimensions as [number, number, number];
  // Plain arrays only: TypedArrays JSON-serialize as objects and fail
  // vtk-wasm DeserializeJSON (type must be array).
  const spacing = clonePoint3(imageVolume.spacing);
  const origin = clonePoint3(imageVolume.origin);
  const direction = (imageVolume.direction ??
    imageVolume.imageData?.getDirection?.()) as number[] | undefined;
  const brickPlan = buildWasmVtkBrickPlan(
    dimensions,
    options?.brickPartitionOptions
  );

  if (!vtk.vtkImageData) {
    throw new Error('[vtkWasm] vtkImageData is not available in this bundle');
  }

  // Do NOT pass dimensions into the ctor — that AllocateScalars as float and
  // makes GPU volume texImage3D request 4× bytes against an Int16 buffer.
  const imageData = vtk.vtkImageData({
    spacing,
    origin,
  });
  const [dx, dy, dz] = dimensions;
  const extent = [
    0,
    Math.max(0, dx - 1),
    0,
    Math.max(0, dy - 1),
    0,
    Math.max(0, dz - 1),
  ];
  imageData.$set?.({
    spacing,
    origin,
  });

  if (direction && direction.length >= 9) {
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
  }

  const applyDirection = (target: VtkWasmObject): void => {
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
      const setDirectionMatrix = target.setDirectionMatrix as
        | ((m: unknown) => unknown)
        | undefined;
      if (setDirectionMatrix) {
        setDirectionMatrix(matrix);
      } else {
        target.$set?.({ directionMatrix: matrix });
      }
    } else {
      target.$set?.({ direction: dir9 });
    }
  };

  let scalarsArray: VtkWasmObject | undefined;
  let geometryPublished = false;
  let refreshInFlight: Promise<boolean> | null = null;
  let pendingDirtyBox: WasmIjkBox | undefined;
  let pendingRefresh = false;

  const getPointData = async (): Promise<VtkWasmObject | undefined> => {
    return (
      (imageData.pointData as VtkWasmObject | undefined) ??
      ((await callMaybeAsync(
        (imageData.getPointData as (() => unknown) | undefined)?.()
      )) as VtkWasmObject | undefined)
    );
  };

  const getDestView = (
    typed: MarshallableTypedArray
  ):
    | (MarshallableTypedArray & {
        set: (array: ArrayLike<number>, offset?: number) => void;
      })
    | undefined => {
    if (!scalarsArray || !typedArrayInterface) {
      return undefined;
    }
    try {
      if (typedArrayInterface.toJSTypedArray) {
        return typedArrayInterface.toJSTypedArray(scalarsArray) as
          | (MarshallableTypedArray & {
              set: (array: ArrayLike<number>, offset?: number) => void;
            })
          | undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  /**
   * Create an empty VTK AoS array backed by a heap allocation, then
   * `setArray(pointer, size, save=0)` so VTK owns the memory. Never passes a
   * JS TypedArray into setArray (serializer / bad_alloc on large volumes).
   */
  const allocatePointerBackedArray = async (
    typed: MarshallableTypedArray,
    numberOfComponents: number
  ): Promise<VtkWasmObject | undefined> => {
    const heap = typedArrayInterface;
    if (!heap?.alloc || !heap.toSizeType) {
      console.warn(
        '[vtkWasm] typedArrayInterface.alloc unavailable; cannot upload scalars'
      );
      return undefined;
    }

    const ctorName = vtkArrayCtorName(typed);
    const arrayCtor = vtk[ctorName];
    if (!arrayCtor) {
      console.warn(`[vtkWasm] missing ${ctorName}; scalars not uploaded`);
      return undefined;
    }

    const numValues = typed.length;
    const byteLength = numValues * typed.BYTES_PER_ELEMENT;
    let pointer: number | bigint;
    try {
      pointer = heap.alloc(byteLength);
    } catch (error) {
      console.warn('[vtkWasm] heap.alloc failed for volume scalars', error);
      return undefined;
    }
    if (pointer === undefined || pointer === null) {
      console.warn('[vtkWasm] heap.alloc returned null');
      return undefined;
    }

    const dataArray = arrayCtor({
      numberOfComponents,
      name: SCALARS_ARRAY_NAME,
    }) as VtkWasmObject;
    // Prefer ctor kwargs / method invoke — never assign `.numberOfTuples`
    // (session property set re-deserializes and hits Hash type errors).
    const setName = dataArray.setName as ((n: string) => unknown) | undefined;
    setName?.(SCALARS_ARRAY_NAME);
    const setNumberOfComponents = dataArray.setNumberOfComponents as
      | ((n: number) => unknown)
      | undefined;
    setNumberOfComponents?.(numberOfComponents);

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
      // save=0 → VTK frees the pointer with the array.
      // setArray also establishes NumberOfValues / NumberOfTuples from size.
      await callMaybeAsync(setArray(pointer, heap.toSizeType(numValues), 0));
    } catch (error) {
      try {
        heap.free?.(pointer);
      } catch {
        // ignore
      }
      disposeVtkObject(dataArray);
      console.warn('[vtkWasm] setArray(pointer) failed', error);
      return undefined;
    }

    return dataArray;
  };

  const fillScalarsFromSource = (
    typed: MarshallableTypedArray,
    numberOfComponents: number,
    dirtyBox?: WasmIjkBox
  ): boolean => {
    const dest = getDestView(typed);
    if (!dest || dest.length !== typed.length) {
      return false;
    }

    if (dirtyBox) {
      const uploads = fullVolumeRegionToBrickUploads(dirtyBox, brickPlan);
      if (uploads.length) {
        for (const upload of uploads) {
          copyIjkBoxIntoVolume(
            typed,
            dest,
            dimensions,
            upload.fullExtent,
            numberOfComponents
          );
        }
        return true;
      }
    }

    if (brickPlan.bricked && brickPlan.bricks.length > 1) {
      // Brick-chunked fill: avoids one giant TypedArray operation through
      // serdes; still writes into the single ImageData buffer SetPartitions
      // expects.
      for (const brick of brickPlan.bricks) {
        copyIjkBoxIntoVolume(
          typed,
          dest,
          dimensions,
          brick.extent,
          numberOfComponents
        );
      }
    } else {
      dest.set(typed);
    }
    return true;
  };

  const fillStandaloneArray = (
    dest: MarshallableTypedArray & {
      set: (array: ArrayLike<number>, offset?: number) => void;
    },
    typed: MarshallableTypedArray,
    numberOfComponents: number,
    dirtyBox?: WasmIjkBox
  ): void => {
    if (dirtyBox) {
      const uploads = fullVolumeRegionToBrickUploads(dirtyBox, brickPlan);
      if (uploads.length) {
        for (const upload of uploads) {
          copyIjkBoxIntoVolume(
            typed,
            dest,
            dimensions,
            upload.fullExtent,
            numberOfComponents
          );
        }
        return;
      }
    }
    if (brickPlan.bricked && brickPlan.bricks.length > 1) {
      for (const brick of brickPlan.bricks) {
        copyIjkBoxIntoVolume(
          typed,
          dest,
          dimensions,
          brick.extent,
          numberOfComponents
        );
      }
      return;
    }
    dest.set(typed);
  };

  const uploadScalarsOnce = async (dirtyBox?: WasmIjkBox): Promise<boolean> => {
    const scalars = getVolumeScalarArray(imageVolume);
    if (!scalars || scalars.length <= 0) {
      return !!scalarsArray;
    }

    const expectedLength = getExpectedScalarLength(imageVolume, dimensions);
    if (scalars.length < expectedLength) {
      return !!scalarsArray;
    }

    const typed = toMarshallableTypedArray(scalars);
    const imageDataMeta = imageVolume.imageData?.get?.('numberOfComponents') as
      | { numberOfComponents?: number }
      | undefined;
    const numberOfComponents = Math.max(
      1,
      imageDataMeta?.numberOfComponents ?? 1
    );
    const numVoxels = dx * dy * dz;

    // Reuse existing pointer-backed buffer when possible (in-place brick fill).
    if (scalarsArray) {
      if (fillScalarsFromSource(typed, numberOfComponents, dirtyBox)) {
        await callMaybeAsync(
          (scalarsArray.modified as (() => unknown) | undefined)?.()
        );
        await callMaybeAsync(
          (imageData.modified as (() => unknown) | undefined)?.()
        );
        const pointData = await getPointData();
        await callMaybeAsync(
          (
            pointData?.setActiveScalars as
              | ((name: string) => unknown)
              | undefined
          )?.(SCALARS_ARRAY_NAME)
        );
        return true;
      }
      // Dead / mismatched proxy — drop JS handle and recreate (do not $delete;
      // ImageData may already own a replacement).
      scalarsArray = undefined;
    }

    const next = await allocatePointerBackedArray(typed, numberOfComponents);
    if (!next) {
      return false;
    }

    // Fill while `next` is a live standalone object (before setScalars).
    const destBeforeAttach = typedArrayInterface?.toJSTypedArray?.(next) as
      | (MarshallableTypedArray & {
          set: (array: ArrayLike<number>, offset?: number) => void;
        })
      | undefined;
    if (!destBeforeAttach || destBeforeAttach.length !== typed.length) {
      disposeVtkObject(next);
      return false;
    }
    fillStandaloneArray(destBeforeAttach, typed, numberOfComponents, dirtyBox);

    // Attach → setNumberOfTuples → geometry → verify live scalars.
    // Never keep/use the pre-geometry handle after finalize.
    const finalized = await finalizeVtkWasmImageDataScalars({
      imageData,
      vtkArray: next,
      numVoxels,
      expectedValueCount: expectedLength,
      dimensions,
      extent: extent as [number, number, number, number, number, number],
      origin,
      spacing,
      typedArrayInterface,
      sourceForVerify: typed,
      logLabel: 'mode=single',
      skipGeometry: geometryPublished,
      applyDirection,
    });
    if (!finalized.ok || !finalized.liveScalars) {
      // Do not $delete `next` if ImageData may own it after a partial attach.
      return false;
    }

    scalarsArray = finalized.liveScalars;
    geometryPublished = true;
    return true;
  };

  const refreshScalars = async (
    dirtyBox?: WasmIjkBox,
    _options?: { force?: boolean }
  ): Promise<boolean> => {
    if (dirtyBox) {
      pendingDirtyBox = dirtyBox;
    } else {
      pendingDirtyBox = undefined;
    }
    pendingRefresh = true;

    while (pendingRefresh) {
      if (!refreshInFlight) {
        refreshInFlight = (async () => {
          let ok = !!scalarsArray;
          while (pendingRefresh) {
            pendingRefresh = false;
            const box = pendingDirtyBox;
            pendingDirtyBox = undefined;
            ok = await uploadScalarsOnce(box);
          }
          return ok;
        })().finally(() => {
          refreshInFlight = null;
        });
      }
      await refreshInFlight;
    }
    return !!scalarsArray;
  };

  const applyPartitions = async (mapper: VtkWasmObject) => {
    // vtk-wasm Proxies throw TypeError on unknown method/property access when
    // types are loaded — never use typeof/optional-chain probes.
    const [nx, ny, nz] = brickPlan.vtkPartitions;
    await tryInvokeMapper(mapper, 'setScalarModeToUsePointData');
    await tryInvokeMapper(mapper, 'setArrayName', SCALARS_ARRAY_NAME);

    if (nx <= 1 && ny <= 1 && nz <= 1) {
      return;
    }

    // Gate SetPartitions on Int16 (or source) bpp + dims matching the view.
    // Float AllocateScalars left active → brick texImage3D requests 4× bytes.
    const imageDataMeta = imageVolume.imageData?.get?.('numberOfComponents') as
      | { numberOfComponents?: number }
      | undefined;
    const numberOfComponents = Math.max(
      1,
      imageDataMeta?.numberOfComponents ?? 1
    );
    const expectedValueCount =
      dimensions[0] * dimensions[1] * dimensions[2] * numberOfComponents;
    const sourceScalars = getVolumeScalarArray(imageVolume);
    const expectedBpe =
      (sourceScalars as { BYTES_PER_ELEMENT?: number } | null)
        ?.BYTES_PER_ELEMENT ?? 2;

    const ready = await verifyVtkWasmImageDataGpuReady(imageData, {
      expectedValueCount,
      expectedBytesPerElement: expectedBpe,
      typedArrayInterface,
      liveScalars: scalarsArray,
    });
    if (!ready) {
      console.warn(
        `[vtkWasm] refusing SetPartitions(${nx},${ny},${nz}) — ImageData not GPU-ready; fix attach/refresh first`
      );
      return;
    }

    const setOk = await tryInvokeMapper(mapper, 'setPartitions', nx, ny, nz);
    if (!setOk) {
      try {
        mapper.$set?.({ partitions: [nx, ny, nz] });
      } catch {
        // ImageResliceMapper and similar have no partitions property.
      }
    }
  };

  const imageDataMeta = imageVolume.imageData?.get?.('numberOfComponents') as
    | { numberOfComponents?: number }
    | undefined;
  const numberOfComponents = Math.max(
    1,
    imageDataMeta?.numberOfComponents ?? 1
  );

  let mprImageData: VtkWasmObject | undefined;
  let mprScalars: VtkWasmObject | undefined;
  let mprSlabReady = false;
  let lastMprKey = '';

  const buildSlabImageData = async (
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
    const slabOrigin = brickWorldOriginForMpr(origin, spacing, direction, [
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

    const slabImage = vtk.vtkImageData({
      spacing,
      origin: slabOrigin,
    }) as VtkWasmObject;
    applyDirection(slabImage);

    const finalized = await finalizeVtkWasmImageDataScalars({
      imageData: slabImage,
      vtkArray,
      numVoxels,
      expectedValueCount,
      dimensions: dims,
      extent,
      origin: slabOrigin,
      spacing,
      typedArrayInterface,
      sourceForVerify,
      logLabel: 'mode=single-mpr-slab',
      applyDirection,
    });
    if (!finalized.ok || !finalized.liveScalars) {
      disposeVtkObject(slabImage);
      return undefined;
    }
    return { imageData: slabImage, liveScalars: finalized.liveScalars };
  };

  const syncMprPlane = async (
    originWorld: [number, number, number],
    normalWorld: [number, number, number],
    halfThicknessMm = 2
  ): Promise<boolean> => {
    if (!(await refreshScalars(undefined, { force: false }))) {
      return false;
    }

    const planeIjk = worldToIjkForMpr(imageVolume, originWorld);
    const normalIjk = worldNormalToIjkForMpr(
      imageVolume,
      originWorld,
      normalWorld
    );
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

    const stitchBox = thinSlabBoxAroundPlaneForMpr(
      dimensions,
      planeIjk,
      normalIjk,
      halfThicknessIndex
    );
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

    const nextScalars = await allocatePointerBackedArrayForCount(
      stitchValues,
      typed,
      numberOfComponents,
      vtk,
      typedArrayInterface
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

    const built = await buildSlabImageData(stitchBox, nextScalars, dest);
    if (!built) {
      disposeVtkObject(nextScalars);
      console.warn('[vtkWasm] MPR single slab finalize failed');
      return false;
    }

    const previous = mprImageData;
    mprImageData = built.imageData;
    mprScalars = built.liveScalars;
    if (previous && previous !== built.imageData) {
      disposeVtkObject(previous);
    }
    mprSlabReady = true;
    lastMprKey = key;
    console.info(
      `[vtkWasm] MPR single slab ready dims=${stitchBox[1] - stitchBox[0] + 1}x` +
        `${stitchBox[3] - stitchBox[2] + 1}x${stitchBox[5] - stitchBox[4] + 1}`
    );
    return true;
  };

  return {
    mode: 'single',
    brickPlan,
    imageData,
    useMultiBlockInput: false,
    useMultiVolumeInput: false,
    hasScalars: () => !!scalarsArray,
    hasMprInput: () => mprSlabReady && !!mprScalars,
    getMprImageData: () =>
      mprSlabReady && mprImageData ? mprImageData : imageData,
    applyPartitions,
    refreshScalars: async (dirtyBox?, options?) => {
      if (options?.force) {
        lastMprKey = '';
        mprSlabReady = false;
      }
      return refreshScalars(dirtyBox, options);
    },
    syncMprPlane,
    dispose: () => {
      disposeVtkObject(mprImageData);
      mprImageData = undefined;
      mprScalars = undefined;
      mprSlabReady = false;
    },
  };
}

/**
 * Choose dense per-brick pool or single full-AoS upload.
 *
 * Dense when:
 * - full AoS would exceed maxScalarBytes, or
 * - partitions need X/Y splits (WebGL cannot SetPartitions-stride upload;
 *   see wasmPartitionsNeedContiguousBricks).
 *
 * Z-only SetPartitions on a single AoS remains valid under the scalar budget.
 */
export function createVtkWasmVolumeBinding(
  vtk: VtkWasmNamespace,
  imageVolume: IImageVolume,
  typedArrayInterface?: VtkWasmTypedArrayInterface,
  options?: CreateVtkWasmVolumeBindingOptions
): VtkWasmVolumeBinding {
  const dimensions = imageVolume.dimensions as [number, number, number];
  const scalars = getVolumeScalarArray(imageVolume);
  const maybeBpe = (scalars as unknown as { BYTES_PER_ELEMENT?: number } | null)
    ?.BYTES_PER_ELEMENT;
  const bytesPerElement =
    typeof maybeBpe === 'number' && maybeBpe > 0 ? maybeBpe : 2;
  const imageDataMeta = imageVolume.imageData?.get?.('numberOfComponents') as
    | { numberOfComponents?: number }
    | undefined;
  const numberOfComponents = Math.max(
    1,
    imageDataMeta?.numberOfComponents ?? 1
  );

  const scalarBytes =
    dimensions[0] *
    dimensions[1] *
    dimensions[2] *
    bytesPerElement *
    numberOfComponents;

  const partitionOptions = options?.brickPartitionOptions;
  const bindOptions: BindVtkWasmVolumeOptions = {
    brickPartitionOptions: partitionOptions,
  };

  // Plan first so XY-partition WebGL limits can force dense under budget.
  const planned = buildWasmVtkBrickPlan(dimensions, partitionOptions);
  const overBudget = shouldUseDenseWasmBricks(
    dimensions,
    bytesPerElement,
    numberOfComponents
  );
  const needsContiguous = wasmPartitionsNeedContiguousBricks(
    planned.vtkPartitions
  );
  const useDense = overBudget || needsContiguous;
  if (needsContiguous && !overBudget) {
    console.info(
      `[vtkWasm] dense bricks required for partitions=${planned.vtkPartitions.join('x')} ` +
        `(WebGL SetPartitions cannot stride-upload X/Y splits)`
    );
  }

  const binding = useDense
    ? (bindVtkWasmBrickedVolume(
        vtk,
        imageVolume,
        typedArrayInterface,
        bindOptions
      ) as VtkWasmVolumeBinding)
    : bindVtkWasmVolume(vtk, imageVolume, typedArrayInterface, bindOptions);

  // One-shot path log so Volume3D / MPR issues are easy to attribute.
  console.info(
    `[vtkWasm] volume binding mode=${binding.mode ?? 'single'} ` +
      `strategy=${binding.brickPlan.strategy} ` +
      `dims=${dimensions.join('x')} scalarBytes=${scalarBytes} ` +
      `partitions=${binding.brickPlan.vtkPartitions.join('x')} ` +
      `useMultiBlock=${binding.useMultiBlockInput === true} ` +
      `useMultiVolume=${binding.useMultiVolumeInput === true}`
  );

  return binding;
}

/**
 * Convert a list of dirty full-volume slice indices into an IJK box for uploads.
 * Assumes Z-major frame indices (Cornerstone volume frame = k).
 */
export function dirtySlicesToIjkBox(
  frameIndices: number[],
  dimensions: [number, number, number]
): WasmIjkBox | null {
  if (!frameIndices.length) {
    return null;
  }
  let k0 = Infinity;
  let k1 = -Infinity;
  for (const k of frameIndices) {
    k0 = Math.min(k0, k);
    k1 = Math.max(k1, k);
  }
  return [0, dimensions[0] - 1, 0, dimensions[1] - 1, k0, k1];
}
