import type { IImageVolume } from '../../types';
import {
  buildWasmVtkBrickPlan,
  fullVolumeRegionToBrickUploads,
  type WasmIjkBox,
  type WasmVtkVolumeBrickPlan,
} from '../helpers/volumeTextureBrickWasm';
import type {
  VtkWasmNamespace,
  VtkWasmObject,
  VtkWasmTypedArrayInterface,
} from './vtkWasmRuntime';
import { getVolumeScalarArray } from './webgpuMapperImageData';

const SCALARS_ARRAY_NAME = 'Scalars';

type MarshallableTypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

export type VtkWasmVolumeBinding = {
  brickPlan: WasmVtkVolumeBrickPlan;
  imageData: VtkWasmObject;
  /** True once point-data scalars have been successfully attached. */
  hasScalars: () => boolean;
  /** Apply SetPartitions on a volume mapper when supported. */
  applyPartitions: (mapper: VtkWasmObject) => void | Promise<void>;
  /**
   * Upload scalars once (or refresh in place). Uses heap `alloc` + pointer
   * `setArray` and fills brick-by-brick — never `toVTKAoSArray` / JS TypedArray
   * through the serializer (those OOM on bricked volumes).
   */
  refreshScalars: (dirtyBox?: WasmIjkBox) => Promise<boolean>;
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
  const spacing = imageVolume.spacing as [number, number, number];
  const origin = imageVolume.origin as [number, number, number];
  const direction = (imageVolume.direction ??
    imageVolume.imageData?.getDirection?.()) as number[] | undefined;
  const brickPlan = buildWasmVtkBrickPlan(dimensions);

  if (!vtk.vtkImageData) {
    throw new Error('[vtkWasm] vtkImageData is not available in this bundle');
  }

  const imageData = vtk.vtkImageData({
    dimensions,
    spacing,
    origin,
  });
  imageData.$set?.({
    dimensions,
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

  let scalarsArray: VtkWasmObject | undefined;
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

  const attachScalars = async (vtkArray: VtkWasmObject): Promise<boolean> => {
    const pointData = await getPointData();
    if (!pointData?.setScalars) {
      return false;
    }
    await callMaybeAsync(
      (pointData.setScalars as (a: unknown) => unknown)(vtkArray)
    );
    await callMaybeAsync(
      (pointData.setActiveScalars as ((name: string) => unknown) | undefined)?.(
        SCALARS_ARRAY_NAME
      )
    );
    await callMaybeAsync(
      (imageData.modified as (() => unknown) | undefined)?.()
    );
    return true;
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
    (dataArray as { name?: string }).name = SCALARS_ARRAY_NAME;
    dataArray.numberOfComponents = numberOfComponents;

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
    }

    const previous = scalarsArray;
    const next = await allocatePointerBackedArray(typed, numberOfComponents);
    if (!next) {
      return !!previous;
    }

    const attached = await attachScalars(next);
    if (!attached) {
      disposeVtkObject(next);
      return !!previous;
    }

    scalarsArray = next;
    if (!fillScalarsFromSource(typed, numberOfComponents, dirtyBox)) {
      // Attached but could not view — still better than no scalars.
      console.warn('[vtkWasm] attached scalars but failed to fill view');
    } else {
      await callMaybeAsync(
        (scalarsArray.modified as (() => unknown) | undefined)?.()
      );
      await callMaybeAsync(
        (imageData.modified as (() => unknown) | undefined)?.()
      );
    }

    if (previous && previous !== next) {
      disposeVtkObject(previous);
    }
    return true;
  };

  const refreshScalars = async (dirtyBox?: WasmIjkBox): Promise<boolean> => {
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
    const [nx, ny, nz] = brickPlan.vtkPartitions;
    if (typeof mapper.setPartitions === 'function') {
      await callMaybeAsync(
        (mapper.setPartitions as (...args: number[]) => unknown)(nx, ny, nz)
      );
    } else {
      mapper.$set?.({ partitions: [nx, ny, nz] });
    }
    await callMaybeAsync(
      (mapper.setScalarModeToUsePointData as (() => unknown) | undefined)?.()
    );
    await callMaybeAsync(
      (mapper.setArrayName as ((name: string) => unknown) | undefined)?.(
        SCALARS_ARRAY_NAME
      )
    );
  };

  return {
    brickPlan,
    imageData,
    hasScalars: () => !!scalarsArray,
    applyPartitions,
    refreshScalars,
  };
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
