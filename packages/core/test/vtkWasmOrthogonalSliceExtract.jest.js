import { MPR_CAMERA_VALUES } from '../src/constants';
import { extractOrthogonalVolumeSlice } from '../src/RenderingEngine/GenericViewport/Planar/orthogonalVolumeSliceExtract';

function createKEncodedVolume(dimensions = [4, 4, 6]) {
  const [dx, dy, dz] = dimensions;
  const scalars = new Int16Array(dx * dy * dz);

  for (let k = 0; k < dz; k++) {
    for (let j = 0; j < dy; j++) {
      for (let i = 0; i < dx; i++) {
        scalars[(k * dy + j) * dx + i] = k;
      }
    }
  }

  const spacing = [1, 1, 1];
  const origin = [100, 200, 300];
  const direction = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const midWorld = [
    origin[0] + 0.5 * (dx - 1) * spacing[0],
    origin[1] + 0.5 * (dy - 1) * spacing[1],
    origin[2] + 0.5 * (dz - 1) * spacing[2],
  ];

  return {
    volume: {
      dimensions,
      spacing,
      origin,
      direction,
      voxelManager: {
        getCompleteScalarDataArray: () => scalars,
      },
    },
    midWorld,
    maxK: dz - 1,
    maxJ: dy - 1,
  };
}

describe('orthogonalVolumeSliceExtract', () => {
  it('maps sagittal viewUp so superior (max K) is at the top row', () => {
    const { volume, midWorld, maxK } = createKEncodedVolume();
    const { viewPlaneNormal, viewUp } = MPR_CAMERA_VALUES.sagittal;

    const slice = extractOrthogonalVolumeSlice(
      volume,
      midWorld,
      viewPlaneNormal,
      viewUp
    );

    expect(slice).toBeDefined();
    expect(slice.data[0]).toBe(maxK);
    expect(slice.data[slice.width * (slice.height - 1)]).toBe(0);
  });

  it('maps coronal viewUp so superior (max K) is at the top row', () => {
    const { volume, midWorld, maxK } = createKEncodedVolume();
    const { viewPlaneNormal, viewUp } = MPR_CAMERA_VALUES.coronal;

    const slice = extractOrthogonalVolumeSlice(
      volume,
      midWorld,
      viewPlaneNormal,
      viewUp
    );

    expect(slice).toBeDefined();
    expect(slice.data[0]).toBe(maxK);
    expect(slice.data[slice.width * (slice.height - 1)]).toBe(0);
  });

  it('keeps axial row order unchanged (top row at min J)', () => {
    const [dx, dy, dz] = [4, 4, 6];
    const scalars = new Int16Array(dx * dy * dz);
    for (let k = 0; k < dz; k++) {
      for (let j = 0; j < dy; j++) {
        for (let i = 0; i < dx; i++) {
          scalars[(k * dy + j) * dx + i] = j;
        }
      }
    }
    const spacing = [1, 1, 1];
    const origin = [100, 200, 300];
    const direction = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const midWorld = [
      origin[0] + 0.5 * (dx - 1) * spacing[0],
      origin[1] + 0.5 * (dy - 1) * spacing[1],
      origin[2] + 0.5 * (dz - 1) * spacing[2],
    ];
    const volume = {
      dimensions: [dx, dy, dz],
      spacing,
      origin,
      direction,
      voxelManager: {
        getCompleteScalarDataArray: () => scalars,
      },
    };
    const { viewPlaneNormal, viewUp } = MPR_CAMERA_VALUES.axial;

    const slice = extractOrthogonalVolumeSlice(
      volume,
      midWorld,
      viewPlaneNormal,
      viewUp
    );

    expect(slice).toBeDefined();
    expect(slice.data[0]).toBe(0);
    expect(slice.data[slice.width * (slice.height - 1)]).toBe(dy - 1);
  });
});
