import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import type { IImageVolume } from '../../types';

type MapperImageDataEntry = {
  imageData: ReturnType<typeof vtkImageData.newInstance>;
  refCount: number;
  refreshedAfterLoad: boolean;
  /** Set when IMAGE_VOLUME_LOADING_COMPLETED has been observed at least once. */
  loadCompletedSeen: boolean;
};

const mapperImageDataByVolumeId = new Map<string, MapperImageDataEntry>();

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
    entry = {
      imageData: createMapperImageData(imageVolume),
      refCount: 0,
      refreshedAfterLoad: false,
      loadCompletedSeen: false,
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
 * @returns `true` when scalars were successfully updated.
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

  if (scalars.getData() !== values) {
    scalars.setData(values as never);
  }

  scalars.modified();
  imageData.modified();
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
 * Materializes contiguous scalars for WebGPU volume mappers.
 * Image-backed streaming volumes expose `getCompleteScalarDataArray` (same as
 * `convertMapperToNotSharedMapper`), not a contiguous `getScalarData()` store.
 */
function getVolumeScalarArray(imageVolume: IImageVolume) {
  const voxelManager = imageVolume.voxelManager as
    | {
        getCompleteScalarDataArray?: () => ArrayLike<number>;
        getScalarData?: () => ArrayLike<number>;
      }
    | undefined;

  try {
    const complete = voxelManager?.getCompleteScalarDataArray?.();
    if (complete && complete.length > 0) {
      return complete as number[];
    }
  } catch {
    // Incomplete progressive load — fall through to other sources.
  }

  const sourceScalars = imageVolume.imageData
    ?.getPointData?.()
    .getScalars?.()
    ?.getData?.();

  if (sourceScalars && sourceScalars.length > 0) {
    return sourceScalars as number[];
  }

  try {
    const values = voxelManager?.getScalarData?.();
    if (values && values.length > 0) {
      return values as number[];
    }
  } catch {
    return undefined;
  }

  return undefined;
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
