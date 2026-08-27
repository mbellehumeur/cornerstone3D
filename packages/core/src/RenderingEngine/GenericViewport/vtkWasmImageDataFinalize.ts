import type {
  VtkWasmObject,
  VtkWasmTypedArrayInterface,
} from './vtkWasmRuntime';

const SCALARS_ARRAY_NAME = 'Scalars';

async function callMaybeAsync(result: unknown): Promise<unknown> {
  return await result;
}

async function getPointData(
  imageData: VtkWasmObject
): Promise<VtkWasmObject | undefined> {
  return (
    (imageData.pointData as VtkWasmObject | undefined) ??
    ((await callMaybeAsync(
      (imageData.getPointData as (() => unknown) | undefined)?.()
    )) as VtkWasmObject | undefined)
  );
}

/**
 * Resolve active / named scalars from vtkPointData. vtk-wasm may expose
 * getScalars(), a `.scalars` property, or getArray(name).
 */
async function resolveScalars(
  pointData: VtkWasmObject | undefined
): Promise<VtkWasmObject | undefined> {
  if (!pointData) {
    return undefined;
  }
  const viaGet = (await callMaybeAsync(
    (pointData.getScalars as (() => unknown) | undefined)?.()
  )) as VtkWasmObject | undefined;
  if (viaGet) {
    return viaGet;
  }
  const viaProp = pointData.scalars as VtkWasmObject | undefined;
  if (viaProp) {
    return viaProp;
  }
  const getArray = pointData.getArray as
    | ((name: string) => unknown)
    | undefined;
  if (typeof getArray === 'function') {
    const viaName = (await callMaybeAsync(
      getArray.call(pointData, SCALARS_ARRAY_NAME)
    )) as VtkWasmObject | undefined;
    if (viaName) {
      return viaName;
    }
  }
  return undefined;
}

export type FinalizeVtkWasmImageDataOptions = {
  imageData: VtkWasmObject;
  vtkArray: VtkWasmObject;
  /** Voxel count (tuples), not value count. */
  numVoxels: number;
  /** Expected number of scalar values (voxels * components). */
  expectedValueCount: number;
  dimensions: [number, number, number];
  extent: [number, number, number, number, number, number];
  origin: [number, number, number];
  spacing: [number, number, number];
  typedArrayInterface?: VtkWasmTypedArrayInterface;
  /**
   * Optional source buffer used only to verify a mid-volume sample survived
   * attach (float AllocateScalars must not remain active).
   */
  sourceForVerify?: ArrayLike<number>;
  /** Log once per process when verify succeeds. */
  logLabel?: string;
  /**
   * When true, skip setExtent/setDimensions (already applied). Still attach
   * and verify. Never call SetDimensions *after* Int16 attach.
   */
  skipGeometry?: boolean;
  /**
   * Re-applied after geometry. SetDimensions can reset direction to identity,
   * which mis-frames MPR planes and Volume3D cameras in patient space.
   */
  applyDirection?: (imageData: VtkWasmObject) => void;
};

export type FinalizeVtkWasmImageDataResult = {
  ok: boolean;
  /** Live scalars after attach — prefer this over the pre-attach handle. */
  liveScalars?: VtkWasmObject;
};

let didLogVerifyOk = false;

/**
 * Finalize vtk-wasm ImageData scalars for GPU upload.
 *
 * Order (critical for this vtk-wasm build):
 * 1. Apply geometry first (may AllocateScalars as float — temporary).
 * 2. Attach filled typed array via setScalars (replaces float).
 * 3. Never call SetDimensions after attach — that clears active scalars /
 *    frees the Int16 object id.
 * 4. Verify live getScalars + mid sample against source.
 *
 * Use `liveScalars` from the result; do not Modified/toJSTypedArray the
 * pre-attach array id after this returns.
 */
export async function finalizeVtkWasmImageDataScalars(
  options: FinalizeVtkWasmImageDataOptions
): Promise<FinalizeVtkWasmImageDataResult> {
  const {
    imageData,
    vtkArray,
    numVoxels,
    expectedValueCount,
    dimensions,
    extent,
    origin,
    spacing,
    typedArrayInterface,
    sourceForVerify,
    logLabel,
    skipGeometry = false,
    applyDirection,
  } = options;

  const [dx, dy, dz] = dimensions;

  // --- 1. Geometry first (once). Temporary float scalars are OK. ---
  if (!skipGeometry) {
    const extentArr = [
      extent[0],
      extent[1],
      extent[2],
      extent[3],
      extent[4],
      extent[5],
    ];
    const originArr = [origin[0], origin[1], origin[2]];
    const spacingArr = [spacing[0], spacing[1], spacing[2]];

    // Prefer $set for extent — method setters were no-op'ing on some vtk-wasm
    // builds, leaving dims=[0,0,0] / empty bounds and a blue-only viewport.
    imageData.$set?.({
      extent: extentArr,
      origin: originArr,
      spacing: spacingArr,
    });

    const setExtent = imageData.setExtent as
      | ((...args: number[]) => unknown)
      | undefined;
    if (typeof setExtent === 'function') {
      await callMaybeAsync(
        setExtent(
          extentArr[0],
          extentArr[1],
          extentArr[2],
          extentArr[3],
          extentArr[4],
          extentArr[5]
        )
      );
    }
    const setOrigin = imageData.setOrigin as
      | ((x: number, y: number, z: number) => unknown)
      | undefined;
    if (typeof setOrigin === 'function') {
      await callMaybeAsync(setOrigin(originArr[0], originArr[1], originArr[2]));
    }
    const setSpacing = imageData.setSpacing as
      | ((x: number, y: number, z: number) => unknown)
      | undefined;
    if (typeof setSpacing === 'function') {
      await callMaybeAsync(
        setSpacing(spacingArr[0], spacingArr[1], spacingArr[2])
      );
    }

    // Verify; if still empty, force dimensions (may AllocateScalars float —
    // setScalars below replaces them).
    const dimsAfter =
      (await callMaybeAsync(
        (imageData.getDimensions as (() => unknown) | undefined)?.()
      )) ?? imageData.dimensions;
    const d0 = Array.isArray(dimsAfter)
      ? Number(dimsAfter[0])
      : Number((dimsAfter as { 0?: number })?.[0] ?? 0);
    if (!d0) {
      console.warn(
        `[vtkWasm] finalize: dims still empty after extent $set; forcing setDimensions(${dx},${dy},${dz})`
      );
      const setDimensions = imageData.setDimensions as
        | ((x: number, y: number, z: number) => unknown)
        | undefined;
      if (typeof setDimensions === 'function') {
        await callMaybeAsync(setDimensions(dx, dy, dz));
      } else {
        imageData.$set?.({ dimensions: [dx, dy, dz] });
      }
    }
  }

  // SetDimensions can reset direction to identity — restore patient frame.
  applyDirection?.(imageData);

  // --- 2. Attach Int16 (or other typed) after geometry is final. ---
  const pointData = await getPointData(imageData);
  if (!pointData?.setScalars) {
    console.warn('[vtkWasm] finalize: no pointData.setScalars');
    return { ok: false };
  }

  // Method invoke only — property/$set of NumberOfTuples re-deserializes.
  const setNumberOfTuples = vtkArray.setNumberOfTuples as
    | ((n: number) => unknown)
    | undefined;
  if (typeof setNumberOfTuples === 'function') {
    try {
      await callMaybeAsync(setNumberOfTuples.call(vtkArray, numVoxels));
    } catch {
      // setArray may already have sized the buffer.
    }
  }

  await callMaybeAsync(
    (pointData.setScalars as (a: unknown) => unknown)(vtkArray)
  );
  await callMaybeAsync(
    (pointData.setActiveScalars as ((name: string) => unknown) | undefined)?.(
      SCALARS_ARRAY_NAME
    )
  );

  // Re-fetch pointData after setScalars (session may refresh proxies).
  const pointDataAfter = await getPointData(imageData);
  await callMaybeAsync(
    (
      pointDataAfter?.setActiveScalars as
        | ((name: string) => unknown)
        | undefined
    )?.(SCALARS_ARRAY_NAME)
  );

  const liveScalars = await resolveScalars(pointDataAfter ?? pointData);
  if (!liveScalars) {
    // Fallback: trust the array we just attached if the session still has it.
    console.warn(
      '[vtkWasm] finalize: getScalars empty after attach; using attached array handle'
    );
  }
  const scalarsForVerify = liveScalars ?? vtkArray;

  let view: ArrayBufferView | undefined;
  try {
    view = typedArrayInterface?.toJSTypedArray?.(scalarsForVerify);
  } catch (error) {
    console.warn(
      '[vtkWasm] finalize: toJSTypedArray failed after attach',
      error
    );
    return { ok: false };
  }
  if (
    !view ||
    typeof (view as unknown as { length?: number }).length !== 'number'
  ) {
    console.warn('[vtkWasm] finalize: no typed view after attach');
    return { ok: false };
  }
  const length = (view as unknown as { length: number }).length;
  if (length !== expectedValueCount) {
    console.warn(
      `[vtkWasm] finalize: scalar length ${length} != expected ${expectedValueCount}`
    );
    return { ok: false };
  }

  if (sourceForVerify && sourceForVerify.length >= expectedValueCount) {
    const mid = expectedValueCount >> 1;
    const srcMid = Number(sourceForVerify[mid]);
    const dstMid = Number((view as unknown as ArrayLike<number>)[mid]);
    if (srcMid !== 0 && dstMid === 0) {
      console.warn(
        `[vtkWasm] finalize: mid sample wiped (src=${srcMid} dst=${dstMid}) — float AllocateScalars still active after setScalars`
      );
      return { ok: false };
    }
  }

  await callMaybeAsync((imageData.modified as (() => unknown) | undefined)?.());

  // Final geometry check — mapper needs non-zero dims/bounds.
  const dimsFinal =
    (await callMaybeAsync(
      (imageData.getDimensions as (() => unknown) | undefined)?.()
    )) ?? imageData.dimensions;
  const boundsFinal =
    (await callMaybeAsync(
      (imageData.getBounds as (() => unknown) | undefined)?.()
    )) ?? imageData.bounds;
  const dFinal = Array.isArray(dimsFinal)
    ? [Number(dimsFinal[0]), Number(dimsFinal[1]), Number(dimsFinal[2])]
    : [0, 0, 0];
  if (!dFinal[0] || !dFinal[1] || !dFinal[2]) {
    console.warn(
      `[vtkWasm] finalize: dims still ${JSON.stringify(dimsFinal)} after scalars; re-$set extent`
    );
    imageData.$set?.({
      extent: [
        extent[0],
        extent[1],
        extent[2],
        extent[3],
        extent[4],
        extent[5],
      ],
      origin: [origin[0], origin[1], origin[2]],
      spacing: [spacing[0], spacing[1], spacing[2]],
    });
    await callMaybeAsync(
      (imageData.modified as (() => unknown) | undefined)?.()
    );
  }

  if (!didLogVerifyOk) {
    didLogVerifyOk = true;
    const mid = expectedValueCount >> 1;
    const samples = [
      Number((view as unknown as ArrayLike<number>)[0]),
      Number((view as unknown as ArrayLike<number>)[mid]),
      Number((view as unknown as ArrayLike<number>)[expectedValueCount - 1]),
    ];
    const srcMid =
      sourceForVerify && sourceForVerify.length > mid
        ? Number(sourceForVerify[mid])
        : undefined;
    const dimsLog =
      (await callMaybeAsync(
        (imageData.getDimensions as (() => unknown) | undefined)?.()
      )) ?? dimsFinal;
    console.info(
      `[vtkWasm] scalars ready${logLabel ? ` ${logLabel}` : ''} dims=${dx}x${dy}x${dz} ` +
        `liveDims=${JSON.stringify(dimsLog)} bounds=${JSON.stringify(boundsFinal)} ` +
        `length=${length} samples=[${samples.join(',')}]${
          srcMid !== undefined ? ` srcMid=${srcMid}` : ''
        }`
    );
  }

  return { ok: true, liveScalars: scalarsForVerify };
}

export { SCALARS_ARRAY_NAME };
