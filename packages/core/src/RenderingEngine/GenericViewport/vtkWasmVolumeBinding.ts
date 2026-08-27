import type { IImageVolume } from '../../types';
import {
  buildWasmVtkBrickPlan,
  fullVolumeRegionToBrickUploads,
  shouldUseDenseWasmBricks,
  wasmPartitionsNeedContiguousBricks,
  type WasmIjkBox,
  type WasmVtkVolumeBrickPlan,
} from '../helpers/volumeTextureBrickWasm';
import clonePoint3 from '../../utilities/clonePoint3';
import type {
  VtkWasmNamespace,
  VtkWasmObject,
  VtkWasmTypedArrayInterface,
} from './vtkWasmRuntime';
import { getVolumeScalarArray } from './webgpuMapperImageData';
import { bindVtkWasmBrickedVolume } from './vtkWasmBrickedVolumeBinding';
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

export type VtkWasmVolumeBinding = {
  mode?: 'single' | 'denseBricks';
  brickPlan: WasmVtkVolumeBrickPlan;
  imageData: VtkWasmObject;
  /** Dense-brick MultiBlock (unused; prefer getBrickImageDatas). */
  multiBlock?: VtkWasmObject;
  /** @deprecated Prefer useMultiVolumeInput. */
  useMultiBlockInput?: boolean;
  /**
   * Volume3D: one GPUVolumeRayCastMapper + vtkVolume per brick.
   * False when the plan is a single brick (use one mapper like `single`).
   */
  useMultiVolumeInput?: boolean;
  getBrickImageDatas?: () => VtkWasmObject[];
  /** True once point-data scalars have been successfully attached. */
  hasScalars: () => boolean;
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
  typedArrayInterface?: VtkWasmTypedArrayInterface
): VtkWasmVolumeBinding {
  const dimensions = imageVolume.dimensions as [number, number, number];
  // Plain arrays only: TypedArrays JSON-serialize as objects and fail
  // vtk-wasm DeserializeJSON (type must be array).
  const spacing = clonePoint3(imageVolume.spacing);
  const origin = clonePoint3(imageVolume.origin);
  const direction = (imageVolume.direction ??
    imageVolume.imageData?.getDirection?.()) as number[] | undefined;
  const brickPlan = buildWasmVtkBrickPlan(dimensions);

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

  return {
    mode: 'single',
    brickPlan,
    imageData,
    useMultiBlockInput: false,
    useMultiVolumeInput: false,
    hasScalars: () => !!scalarsArray,
    applyPartitions,
    refreshScalars,
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
  typedArrayInterface?: VtkWasmTypedArrayInterface
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

  // Plan first so XY-partition WebGL limits can force dense under budget.
  const planned = buildWasmVtkBrickPlan(dimensions);
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
        typedArrayInterface
      ) as VtkWasmVolumeBinding)
    : bindVtkWasmVolume(vtk, imageVolume, typedArrayInterface);

  // One-shot path log so Volume3D / MPR issues are easy to attribute.
  console.info(
    `[vtkWasm] volume binding mode=${binding.mode ?? 'single'} ` +
      `dims=${dimensions.join('x')} scalarBytes=${scalarBytes} ` +
      `partitions=${binding.brickPlan.vtkPartitions.join('x')} ` +
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
