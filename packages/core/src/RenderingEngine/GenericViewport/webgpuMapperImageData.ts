import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import cache from '../../cache/cache';
import type { IImageVolume } from '../../types';

type MapperImageDataEntry = {
  imageData: ReturnType<typeof vtkImageData.newInstance>;
  refCount: number;
  refreshedAfterLoad: boolean;
  /** Set when IMAGE_VOLUME_LOADING_COMPLETED has been observed at least once. */
  loadCompletedSeen: boolean;
  /** Cheap fingerprint of last uploaded scalars; skip GPU dirty when unchanged. */
  scalarFingerprint?: string;
};

const mapperImageDataByVolumeId = new Map<string, MapperImageDataEntry>();

/**
 * Cheap content fingerprint (length + sparse samples). Avoids full-buffer
 * compares when getCompleteScalarDataArray allocates a new TypedArray each call.
 */
function fingerprintScalars(values: ArrayLike<number>): string {
  const n = values.length;
  if (n === 0) {
    return '0';
  }
  let sum = 0;
  const stride = Math.max(1, Math.floor(n / 32));
  for (let i = 0; i < n; i += stride) {
    sum = (sum + (Number(values[i]) | 0)) | 0;
  }
  return `${n}:${Number(values[0])}:${Number(values[n >> 1])}:${Number(values[n - 1])}:${sum}`;
}

/**
 * Shared mapper-input imageData per volume. Materializing voxel data is a full
 * copy (cornerstone volumes are image-backed and own no contiguous array), so
 * all render paths using the same volume should share one instance.
 */
export function acquireWebGPUMapperImageData(
  volumeId: string,
  imageVolume: IImageVolume
): MapperImageDataEntry {
  let entry = mapperImageDataByVolumeId.get(volumeId);

  if (!entry) {
    const imageData = createMapperImageData(imageVolume);
    const scalars = imageData.getPointData().getScalars()?.getData?.();
    const dims =
      imageVolume.dimensions ?? imageVolume.imageData?.getDimensions?.();
    const expectedVoxels =
      dims && dims.length >= 3 ? Math.max(1, dims[0] * dims[1] * dims[2]) : 0;
    const componentsMeta = imageVolume.imageData?.get?.(
      'numberOfComponents'
    ) as { numberOfComponents?: number } | undefined;
    const components = Math.max(1, componentsMeta?.numberOfComponents ?? 1);
    const expectedLength = expectedVoxels * components;
    const complete =
      Boolean(scalars) &&
      expectedLength > 0 &&
      (scalars as ArrayLike<number>).length >= expectedLength;

    entry = {
      imageData,
      refCount: 0,
      // Skip post-load rematerialize when create already has a full buffer.
      refreshedAfterLoad: complete,
      loadCompletedSeen: complete,
      scalarFingerprint:
        scalars && (scalars as ArrayLike<number>).length > 0
          ? fingerprintScalars(scalars as ArrayLike<number>)
          : undefined,
    };
    mapperImageDataByVolumeId.set(volumeId, entry);
  }

  entry.refCount += 1;
  return entry;
}

export function releaseWebGPUMapperImageData(volumeId: string): void {
  const entry = mapperImageDataByVolumeId.get(volumeId);

  if (!entry) {
    return;
  }

  entry.refCount -= 1;

  if (entry.refCount <= 0) {
    mapperImageDataByVolumeId.delete(volumeId);
    entry.imageData.delete();
  }
}

/**
 * Re-materializes voxel data into the mapper scalar array, invalidating the
 * cached GPU texture after progressive load completion.
 *
 * @returns `true` when scalars were successfully updated (GPU dirty).
 */
export function refreshWebGPUMapperScalars(
  imageData: ReturnType<typeof vtkImageData.newInstance>,
  imageVolume: IImageVolume
): boolean {
  const scalars = imageData.getPointData().getScalars();

  if (!scalars) {
    return false;
  }

  const values = getVolumeScalarArray(imageVolume);

  if (!values) {
    // Progressive streams can briefly have no scalar backing store available.
    // Keep the previous mapper buffer and retry on the next load event.
    return false;
  }

  const nextFingerprint = fingerprintScalars(values);
  let entry =
    (imageVolume as { volumeId?: string }).volumeId != null
      ? mapperImageDataByVolumeId.get(
          (imageVolume as { volumeId?: string }).volumeId as string
        )
      : undefined;
  if (!entry) {
    for (const candidate of mapperImageDataByVolumeId.values()) {
      if (candidate.imageData === imageData) {
        entry = candidate;
        break;
      }
    }
  }

  if (entry?.scalarFingerprint === nextFingerprint) {
    // Same content as last upload — do not call modified() (avoids GPU rebuild).
    return false;
  }

  if (scalars.getData() !== values) {
    scalars.setData(values as never);
  }

  scalars.modified();
  imageData.modified();
  if (entry) {
    entry.scalarFingerprint = nextFingerprint;
  }
  return true;
}

function createMapperImageData(imageVolume: IImageVolume) {
  const sourceImageData = imageVolume.imageData;

  if (!sourceImageData) {
    throw new Error(
      '[GenericViewport] WebGPU volume rendering requires volume imageData'
    );
  }

  const imageDataMetadata = sourceImageData.get('numberOfComponents') as
    | { numberOfComponents?: number }
    | undefined;
  const numberOfComponents = imageDataMetadata?.numberOfComponents ?? 1;
  const values =
    getVolumeScalarArray(imageVolume) ??
    createEmptyScalarArray(sourceImageData, numberOfComponents);
  const scalars = vtkDataArray.newInstance({
    name: 'Pixels',
    numberOfComponents,
    values,
  });
  const mapperImageData = vtkImageData.newInstance();

  mapperImageData.setDimensions(sourceImageData.getDimensions());
  mapperImageData.setSpacing(sourceImageData.getSpacing());
  mapperImageData.setDirection(sourceImageData.getDirection());
  mapperImageData.setOrigin(sourceImageData.getOrigin());
  mapperImageData.getPointData().setScalars(scalars);

  const dataTypeMeta = sourceImageData.get('dataType') as
    | { dataType?: string }
    | string
    | undefined;
  const dataType =
    (typeof dataTypeMeta === 'string'
      ? dataTypeMeta
      : dataTypeMeta?.dataType) ??
    (values as { constructor?: { name?: string } }).constructor?.name ??
    'Float32Array';

  mapperImageData.set(
    {
      dataType,
      numberOfComponents,
    },
    true
  );

  // Match ImageVolume: store the VoxelManager instance under the voxelManager key.
  if (imageVolume.voxelManager) {
    mapperImageData.set(
      {
        voxelManager: imageVolume.voxelManager,
      },
      true
    );
  }

  return mapperImageData;
}

/**
 * Materializes contiguous scalars for WebGPU / fuberlin volume upload.
 * Image-backed streaming volumes expose `getCompleteScalarDataArray` (same as
 * `convertMapperToNotSharedMapper`), not a contiguous `getScalarData()` store.
 *
 * Note: CS `getCompleteScalarDataArray` only resolves the TypedArray constructor
 * from slice 0. Progressive loads often fill middle slices first and return an
 * empty buffer until slice 0 lands — so we fall back to assembling from any
 * cached images.
 */
export function getVolumeScalarArray(
  imageVolume: IImageVolume
): ArrayLike<number> | undefined {
  const voxelManager = imageVolume.voxelManager as
    | {
        getCompleteScalarDataArray?: () => ArrayLike<number>;
        getScalarData?: () => ArrayLike<number>;
      }
    | undefined;

  try {
    const complete = voxelManager?.getCompleteScalarDataArray?.();
    if (complete && complete.length > 0) {
      return complete;
    }
  } catch {
    // Incomplete progressive load — fall through to other sources.
  }

  const fromCache = materializeFromCachedImages(imageVolume);
  if (fromCache) {
    return fromCache;
  }

  const sourceScalars = imageVolume.imageData
    ?.getPointData?.()
    .getScalars?.()
    ?.getData?.();

  if (sourceScalars && sourceScalars.length > 0) {
    return sourceScalars;
  }

  try {
    const values = voxelManager?.getScalarData?.();
    if (values && values.length > 0) {
      return values;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Build a contiguous TypedArray from whichever volume slices are already in
 * the image cache (order-independent). Returns undefined until at least one
 * slice has scalar data.
 */
function materializeFromCachedImages(
  imageVolume: IImageVolume
): ArrayLike<number> | undefined {
  const imageIds = imageVolume.imageIds;
  const dimensions =
    imageVolume.dimensions ?? imageVolume.imageData?.getDimensions?.();

  if (!imageIds?.length || !dimensions || dimensions.length < 3) {
    return undefined;
  }

  const width = dimensions[0];
  const height = dimensions[1];
  const depth = dimensions[2];
  const imageDataMeta = imageVolume.imageData?.get?.('numberOfComponents') as
    | { numberOfComponents?: number }
    | undefined;
  const numberOfComponents = imageDataMeta?.numberOfComponents ?? 1;
  const sliceSize = width * height * numberOfComponents;
  const expectedLength = sliceSize * depth;

  let ScalarCtor:
    | (new (length: number) => ArrayLike<number> & {
        set: (array: ArrayLike<number>, offset?: number) => void;
      })
    | undefined;

  for (const imageId of imageIds) {
    const image = cache.getImage(imageId);
    const sliceVm = image?.voxelManager as
      | { getScalarData?: () => ArrayLike<number> }
      | undefined;

    if (!sliceVm?.getScalarData) {
      continue;
    }

    try {
      const pixelData = sliceVm.getScalarData();
      const ctor = pixelData?.constructor as
        | (new (length: number) => ArrayLike<number> & {
            set: (array: ArrayLike<number>, offset?: number) => void;
          })
        | undefined;

      if (ctor && pixelData && pixelData.length > 0) {
        ScalarCtor = ctor;
        break;
      }
    } catch {
      // Slice not ready yet.
    }
  }

  if (!ScalarCtor) {
    return undefined;
  }

  const scalarData = new ScalarCtor(expectedLength);
  let loadedSlices = 0;

  for (let sliceIndex = 0; sliceIndex < depth; sliceIndex++) {
    const imageId = imageIds[sliceIndex];

    if (!imageId) {
      continue;
    }

    const image = cache.getImage(imageId);
    const sliceVm = image?.voxelManager as
      | { getScalarData?: () => ArrayLike<number> }
      | undefined;

    if (!sliceVm?.getScalarData) {
      continue;
    }

    try {
      const pixelData = sliceVm.getScalarData();

      if (!pixelData || pixelData.length === 0) {
        continue;
      }

      scalarData.set(pixelData, sliceIndex * sliceSize);
      loadedSlices += 1;
    } catch {
      // Skip unloaded / errored slices.
    }
  }

  return loadedSlices > 0 ? scalarData : undefined;
}

function createEmptyScalarArray(
  sourceImageData: ReturnType<typeof vtkImageData.newInstance>,
  numberOfComponents: number
): number[] {
  const [x = 1, y = 1, z = 1] = sourceImageData.getDimensions() ?? [1, 1, 1];
  const voxelCount = Math.max(1, x * y * z * Math.max(1, numberOfComponents));
  const sourcePointData = sourceImageData.getPointData?.();
  const sourceScalars = sourcePointData?.getScalars?.();
  const sourceData = sourceScalars?.getData?.();
  const sourceArrayCtor = sourceData?.constructor as
    | (new (length: number) => ArrayLike<number>)
    | undefined;

  try {
    if (sourceArrayCtor) {
      return new sourceArrayCtor(voxelCount) as number[];
    }
  } catch {
    // Fall back below when constructor allocation fails.
  }

  return new Float32Array(voxelCount) as unknown as number[];
}
