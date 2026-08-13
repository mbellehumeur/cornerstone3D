import { describe, expect, it, afterEach } from '@jest/globals';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import cache from '../src/cache/cache';
import {
  acquireWebGPUMapperImageData,
  isVolumeScalarsReadyForUpload,
  refreshWebGPUMapperScalars,
  releaseWebGPUMapperImageData,
} from '../src/RenderingEngine/GenericViewport/webgpuMapperImageData';

function createSourceImageData(dims = [4, 4, 4]) {
  const imageData = vtkImageData.newInstance();
  imageData.setDimensions(dims);
  imageData.setSpacing([1, 1, 1]);
  imageData.setOrigin([0, 0, 0]);
  imageData.setDirection([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  imageData.set({ numberOfComponents: 1, dataType: 'Int16Array' }, true);
  return imageData;
}

function createVolumeWithScalars({
  volumeId,
  dims = [4, 4, 4],
  loadStatus,
  scalarValues,
}) {
  const imageData = createSourceImageData(dims);
  const voxelCount = dims[0] * dims[1] * dims[2];
  const values = scalarValues ?? new Int16Array(voxelCount).fill(100);

  return {
    volumeId,
    dimensions: dims,
    imageData,
    loadStatus,
    imageIds: Array.from(
      { length: dims[2] },
      (_, i) => `${volumeId}-slice-${i}`
    ),
    voxelManager: {
      getCompleteScalarDataArray: () => values,
    },
  };
}

describe('webgpuMapperImageData', () => {
  afterEach(() => {
    releaseWebGPUMapperImageData('vol-placeholder');
    releaseWebGPUMapperImageData('vol-partial');
    releaseWebGPUMapperImageData('vol-loaded');
    releaseWebGPUMapperImageData('vol-static');
    releaseWebGPUMapperImageData('vol-refresh');
    jest.restoreAllMocks();
  });

  describe('isVolumeScalarsReadyForUpload', () => {
    it('returns false for placeholder or partial readiness', () => {
      const volume = { loadStatus: { loaded: true } };
      expect(isVolumeScalarsReadyForUpload(volume, 'placeholder')).toBe(false);
      expect(isVolumeScalarsReadyForUpload(volume, 'partial')).toBe(false);
    });

    it('requires loadStatus.loaded for streaming volumes', () => {
      const volume = { loadStatus: { loaded: false } };
      expect(isVolumeScalarsReadyForUpload(volume, 'complete')).toBe(false);

      volume.loadStatus.loaded = true;
      expect(isVolumeScalarsReadyForUpload(volume, 'complete')).toBe(true);
    });

    it('accepts complete scalars for static volumes without loadStatus', () => {
      expect(isVolumeScalarsReadyForUpload({}, 'complete')).toBe(true);
    });
  });

  describe('acquireWebGPUMapperImageData', () => {
    it('does not mark placeholder streaming volumes as refreshedAfterLoad', () => {
      const imageVolume = {
        volumeId: 'vol-placeholder',
        dimensions: [4, 4, 4],
        imageData: createSourceImageData(),
        loadStatus: { loaded: false, loading: true },
        imageIds: ['a', 'b', 'c', 'd'],
      };

      const entry = acquireWebGPUMapperImageData(
        imageVolume.volumeId,
        imageVolume
      );

      expect(entry.refreshedAfterLoad).toBe(false);
      expect(entry.loadCompletedSeen).toBe(false);
      releaseWebGPUMapperImageData(imageVolume.volumeId);
    });

    it('does not mark partial cached slices as refreshedAfterLoad while loading', () => {
      const imageVolume = {
        volumeId: 'vol-partial',
        dimensions: [2, 2, 4],
        imageData: createSourceImageData([2, 2, 4]),
        loadStatus: { loaded: false, loading: true },
        imageIds: ['slice-0', 'slice-1', 'slice-2', 'slice-3'],
      };

      jest.spyOn(cache, 'getImage').mockImplementation((imageId) => {
        if (imageId !== 'slice-1') {
          return undefined;
        }

        return {
          voxelManager: {
            getScalarData: () => new Int16Array(4).fill(42),
          },
        };
      });

      const entry = acquireWebGPUMapperImageData(
        imageVolume.volumeId,
        imageVolume
      );

      expect(entry.refreshedAfterLoad).toBe(false);
      releaseWebGPUMapperImageData(imageVolume.volumeId);
    });

    it('marks loaded streaming volumes with complete scalars as refreshedAfterLoad', () => {
      const imageVolume = createVolumeWithScalars({
        volumeId: 'vol-loaded',
        loadStatus: { loaded: true, loading: false },
      });

      const entry = acquireWebGPUMapperImageData(
        imageVolume.volumeId,
        imageVolume
      );

      expect(entry.refreshedAfterLoad).toBe(true);
      expect(entry.loadCompletedSeen).toBe(true);
      releaseWebGPUMapperImageData(imageVolume.volumeId);
    });

    it('marks static volumes with complete scalars as refreshedAfterLoad', () => {
      const dims = [4, 4, 4];
      const imageData = createSourceImageData(dims);
      const values = new Int16Array(64).fill(200);
      const scalars = vtkDataArray.newInstance({
        name: 'Pixels',
        numberOfComponents: 1,
        values,
      });
      imageData.getPointData().setScalars(scalars);

      const imageVolume = {
        volumeId: 'vol-static',
        dimensions: dims,
        imageData,
        imageIds: [],
        voxelManager: {
          getCompleteScalarDataArray: () => values,
        },
      };

      const entry = acquireWebGPUMapperImageData(
        imageVolume.volumeId,
        imageVolume
      );

      expect(entry.refreshedAfterLoad).toBe(true);
      releaseWebGPUMapperImageData(imageVolume.volumeId);
    });
  });

  describe('refreshWebGPUMapperScalars', () => {
    it('updates mapper scalars after load completes following a placeholder acquire', () => {
      const dims = [2, 2, 2];
      const imageVolume = {
        volumeId: 'vol-refresh',
        dimensions: dims,
        imageData: createSourceImageData(dims),
        loadStatus: { loaded: false, loading: true },
        imageIds: [],
      };

      const entry = acquireWebGPUMapperImageData(
        imageVolume.volumeId,
        imageVolume
      );
      expect(entry.refreshedAfterLoad).toBe(false);

      const loadedValues = new Int16Array(8).fill(777);
      imageVolume.loadStatus = { loaded: true, loading: false };
      imageVolume.voxelManager = {
        getCompleteScalarDataArray: () => loadedValues,
      };

      const refreshed = refreshWebGPUMapperScalars(
        entry.imageData,
        imageVolume
      );

      expect(refreshed).toBe(true);
      expect(entry.imageData.getPointData().getScalars().getData()).toEqual(
        loadedValues
      );

      releaseWebGPUMapperImageData(imageVolume.volumeId);
    });
  });
});
