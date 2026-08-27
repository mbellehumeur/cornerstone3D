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

/**
 * vtk-wasm SetExtent takes a single Int32[6] array (see vtkCartesianGrid.json),
 * not six separate args. Prefer camelCase then PascalCase.
 */
export async function setVtkWasmImageDataExtent(
  imageData: VtkWasmObject,
  extentArr: number[]
): Promise<void> {
  const plain = [
    extentArr[0] | 0,
    extentArr[1] | 0,
    extentArr[2] | 0,
    extentArr[3] | 0,
    extentArr[4] | 0,
    extentArr[5] | 0,
  ];
  imageData.$set?.({ extent: plain });

  try {
    const setExtent = (imageData as Record<string, unknown>).setExtent;
    if (typeof setExtent === 'function') {
      await callMaybeAsync(
        (setExtent as (extent: number[]) => unknown).call(imageData, plain)
      );
      return;
    }
    const SetExtent = (imageData as Record<string, unknown>).SetExtent;
    if (typeof SetExtent === 'function') {
      await callMaybeAsync(
        (SetExtent as (extent: number[]) => unknown).call(imageData, plain)
      );
    }
  } catch (error) {
    console.warn('[vtkWasm] setExtent(array) failed', error);
  }
}

function parseDims3(dims: unknown): [number, number, number] {
  if (Array.isArray(dims) && dims.length >= 3) {
    return [Number(dims[0]), Number(dims[1]), Number(dims[2])];
  }
  if (dims && typeof dims === 'object') {
    const o = dims as { 0?: number; 1?: number; 2?: number };
    return [Number(o[0] ?? 0), Number(o[1] ?? 0), Number(o[2] ?? 0)];
  }
  return [0, 0, 0];
}

/**
 * True when live ImageData dims × comps match the attached typed view and
 * scalar bpp matches the source element size (blocks float texImage3D vs Int16).
 */
export async function verifyVtkWasmImageDataGpuReady(
  imageData: VtkWasmObject,
  options: {
    expectedValueCount: number;
    expectedBytesPerElement: number;
    typedArrayInterface?: VtkWasmTypedArrayInterface;
    liveScalars?: VtkWasmObject;
  }
): Promise<boolean> {
  const {
    expectedValueCount,
    expectedBytesPerElement,
    typedArrayInterface,
    liveScalars: liveScalarsOpt,
  } = options;

  const dimsRaw =
    (await callMaybeAsync(
      (imageData.getDimensions as (() => unknown) | undefined)?.()
    )) ?? imageData.dimensions;
  const [dx, dy, dz] = parseDims3(dimsRaw);
  if (!dx || !dy || !dz) {
    console.warn(
      `[vtkWasm] GPU-ready check: empty dims=${JSON.stringify(dimsRaw)}`
    );
    return false;
  }

  const pointData = await getPointData(imageData);
  const liveScalars = liveScalarsOpt ?? (await resolveScalars(pointData));
  if (!liveScalars || !typedArrayInterface?.toJSTypedArray) {
    console.warn('[vtkWasm] GPU-ready check: no live scalars view');
    return false;
  }

  let view: ArrayBufferView | undefined;
  try {
    view = typedArrayInterface.toJSTypedArray(liveScalars);
  } catch (error) {
    console.warn('[vtkWasm] GPU-ready check: toJSTypedArray failed', error);
    return false;
  }
  const viewLen = (view as unknown as { length?: number } | undefined)?.length;
  if (!view || typeof viewLen !== 'number') {
    console.warn('[vtkWasm] GPU-ready check: invalid typed view');
    return false;
  }
  const length = viewLen;
  if (length !== expectedValueCount) {
    console.warn(
      `[vtkWasm] GPU-ready check: length ${length} != expected ${expectedValueCount}`
    );
    return false;
  }

  const comps = Math.max(
    1,
    Math.round(expectedValueCount / Math.max(1, dx * dy * dz))
  );
  if (dx * dy * dz * comps !== expectedValueCount) {
    console.warn(
      `[vtkWasm] GPU-ready check: dims ${dx}x${dy}x${dz}×${comps} != length ${expectedValueCount}`
    );
    return false;
  }

  const bpe = (view as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT;
  if (typeof bpe === 'number' && bpe !== expectedBytesPerElement) {
    console.warn(
      `[vtkWasm] GPU-ready check: view bpp ${bpe} != expected ${expectedBytesPerElement} (float AllocateScalars still active?)`
    );
    return false;
  }

  // VTK_FLOAT=10, VTK_DOUBLE=11 — partitioned texImage3D will request 4×/8× bytes.
  try {
    const getScalarType = (imageData as Record<string, unknown>).getScalarType;
    if (typeof getScalarType === 'function') {
      const scalarType = await callMaybeAsync(
        (getScalarType as () => unknown).call(imageData)
      );
      const st = Number(scalarType);
      if (st === 10 || st === 11) {
        console.warn(
          `[vtkWasm] GPU-ready check: ImageData scalarType=${st} is float/double; refusing GPU upload`
        );
        return false;
      }
    }
  } catch {
    // Method missing / proxy throw — rely on view BYTES_PER_ELEMENT above.
  }

  return true;
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
 * 1. Apply geometry first via setExtent(single array) (may AllocateScalars as
 *    float — temporary). Prefer extent-only over SetDimensions.
 * 2. Attach filled typed array via setScalars (replaces float).
 * 3. Never call SetDimensions after attach — that clears active scalars /
 *    frees the Int16 object id and causes texImage3D bpp mismatches under
 *    SetPartitions.
 * 4. Verify live getScalars + mid sample + GPU-ready asserts.
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

  // --- 1. Geometry first (once). Temporary float scalars are OK. ---
  if (!skipGeometry) {
    // Prefer SetExtent(single array) — six-arg SetExtent is a no-op on vtk-wasm
    // and leaves dims empty, then setDimensions AllocateScalars as float.
    imageData.$set?.({
      extent: extentArr,
      origin: originArr,
      spacing: spacingArr,
    });
    await setVtkWasmImageDataExtent(imageData, extentArr);

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
    // setScalars below replaces them). Prefer extent-only when possible.
    const dimsAfter =
      (await callMaybeAsync(
        (imageData.getDimensions as (() => unknown) | undefined)?.()
      )) ?? imageData.dimensions;
    const [d0] = parseDims3(dimsAfter);
    if (!d0) {
      console.warn(
        `[vtkWasm] finalize: dims still empty after setExtent(array); forcing setDimensions(${dx},${dy},${dz})`
      );
      const setDimensions = imageData.setDimensions as
        | ((x: number, y: number, z: number) => unknown)
        | undefined;
      if (typeof setDimensions === 'function') {
        await callMaybeAsync(setDimensions(dx, dy, dz));
      } else {
        // Last resort before attach only — never after Int16 setScalars.
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
  // After Int16 attach: only re-setExtent(array). Never $set({ dimensions })
  // (that AllocateScalars float → texImage3D bpp mismatch under SetPartitions).
  let dimsFinal =
    (await callMaybeAsync(
      (imageData.getDimensions as (() => unknown) | undefined)?.()
    )) ?? imageData.dimensions;
  const boundsFinal =
    (await callMaybeAsync(
      (imageData.getBounds as (() => unknown) | undefined)?.()
    )) ?? imageData.bounds;
  let dFinal = parseDims3(dimsFinal);
  if (!dFinal[0] || !dFinal[1] || !dFinal[2]) {
    console.warn(
      `[vtkWasm] finalize: dims still ${JSON.stringify(dimsFinal)} after scalars; re-setExtent(array) only`
    );
    await setVtkWasmImageDataExtent(imageData, extentArr);
    imageData.$set?.({
      origin: originArr,
      spacing: spacingArr,
    });
    await callMaybeAsync(
      (imageData.modified as (() => unknown) | undefined)?.()
    );
    dimsFinal =
      (await callMaybeAsync(
        (imageData.getDimensions as (() => unknown) | undefined)?.()
      )) ?? imageData.dimensions;
    dFinal = parseDims3(dimsFinal);
  }

  const expectedBpe =
    (sourceForVerify as { BYTES_PER_ELEMENT?: number } | undefined)
      ?.BYTES_PER_ELEMENT ??
    (view as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ??
    2;

  const gpuReady = await verifyVtkWasmImageDataGpuReady(imageData, {
    expectedValueCount,
    expectedBytesPerElement: expectedBpe,
    typedArrayInterface,
    liveScalars: scalarsForVerify,
  });
  if (!gpuReady) {
    console.warn('[vtkWasm] finalize: GPU-ready asserts failed after attach');
    return { ok: false };
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
        `length=${length} bpe=${expectedBpe} samples=[${samples.join(',')}]${
          srcMid !== undefined ? ` srcMid=${srcMid}` : ''
        }`
    );
  }

  return { ok: true, liveScalars: scalarsForVerify };
}

export { SCALARS_ARRAY_NAME };
