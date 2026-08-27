import {
  buildWasmVtkBrickPlan,
  fullVolumeRegionToBrickUploads,
  minimumPartitionsForAxis,
  splitAxisExtents,
} from '../src/RenderingEngine/helpers/volumeTextureBrickWasm';

/** VTK SplitVolume: delta=(dim-1)/n, block i = [floor(i*delta), floor((i+1)*delta)]. */
function vtkSplitAxisExtents(dim, n) {
  const safeDim = Math.max(0, Math.floor(dim));
  const parts = Math.max(1, Math.floor(n));
  if (safeDim <= 0) {
    return [[0, -1]];
  }
  if (safeDim === 1 || parts === 1) {
    return [[0, safeDim - 1]];
  }
  const delta = (safeDim - 1) / parts;
  const ranges = [];
  for (let p = 0; p < parts; p++) {
    const start = Math.floor(p * delta);
    const end = Math.floor((p + 1) * delta);
    ranges.push([start, Math.max(start, end)]);
  }
  ranges[ranges.length - 1][1] = safeDim - 1;
  return ranges;
}

describe('volumeTextureBrickWasm', () => {
  describe('minimumPartitionsForAxis', () => {
    it('returns 1 when dim fits', () => {
      expect(minimumPartitionsForAxis(512, 2048)).toBe(1);
    });
    it('ceils dim/max3D', () => {
      expect(minimumPartitionsForAxis(2900, 2048)).toBe(2);
      expect(minimumPartitionsForAxis(4096, 2048)).toBe(2);
      expect(minimumPartitionsForAxis(4097, 2048)).toBe(3);
    });
  });

  describe('splitAxisExtents', () => {
    it('matches VTK SplitVolume for dim=512, n=8', () => {
      expect(splitAxisExtents(512, 8)).toEqual(vtkSplitAxisExtents(512, 8));
      expect(splitAxisExtents(512, 8)[0]).toEqual([0, 63]);
      expect(splitAxisExtents(512, 8)[7]).toEqual([447, 511]);
    });

    it('matches VTK SplitVolume for non-divisible dim=300, n=8', () => {
      expect(splitAxisExtents(300, 8)).toEqual(vtkSplitAxisExtents(300, 8));
      expect(splitAxisExtents(300, 8)[0]).toEqual([0, 37]);
      expect(splitAxisExtents(300, 8)[7][1]).toBe(299);
    });

    it('covers the full axis with VTK shared boundaries (dim=2900, n=2)', () => {
      const ranges = splitAxisExtents(2900, 2);
      expect(ranges).toEqual([
        [0, 1449],
        [1449, 2899],
      ]);
    });
  });

  describe('buildWasmVtkBrickPlan', () => {
    it('uses minimum strategy for 2900x512x512 → (2,1,1)', () => {
      const plan = buildWasmVtkBrickPlan([2900, 512, 512], {
        strategy: 'minimum',
        max3D: 2048,
      });
      expect(plan.vtkPartitions).toEqual([2, 1, 1]);
      expect(plan.bricked).toBe(true);
      expect(plan.bricks).toHaveLength(2);
      expect(plan.bricks[0].textureSize[0]).toBeLessThanOrEqual(2048);
      expect(plan.bricks[1].textureSize[0]).toBeLessThanOrEqual(2048);
      expect(plan.bricks[0].extent).toEqual([0, 1449, 0, 511, 0, 511]);
      expect(plan.bricks[1].extent).toEqual([1449, 2899, 0, 511, 0, 511]);
    });

    it('keeps single partition when volume fits', () => {
      const plan = buildWasmVtkBrickPlan([512, 512, 100], {
        strategy: 'minimum',
        max3D: 2048,
      });
      expect(plan.vtkPartitions).toEqual([1, 1, 1]);
      expect(plan.bricked).toBe(false);
      expect(plan.bricks).toHaveLength(1);
    });

    it('honors fixed partitions and still bumps for max3D', () => {
      const plan = buildWasmVtkBrickPlan([2900, 512, 512], {
        strategy: 'fixed',
        partitions: [1, 1, 1],
        max3D: 2048,
        maxPerAxis: 64,
      });
      // fixed (1,1,1) cannot fit X; bump X to 2
      expect(plan.vtkPartitions[0]).toBe(2);
      expect(plan.vtkPartitions[1]).toBe(1);
      expect(plan.vtkPartitions[2]).toBe(1);
    });

    it('clamps fixed partitions to axis length', () => {
      const plan = buildWasmVtkBrickPlan([4, 4, 4], {
        strategy: 'fixed',
        partitions: [8, 8, 8],
        max3D: 2048,
        maxPerAxis: 64,
      });
      expect(plan.vtkPartitions).toEqual([4, 4, 4]);
    });

    it('clamps target strategy to maxPerAxis', () => {
      const plan = buildWasmVtkBrickPlan([512, 512, 512], {
        strategy: 'target',
        targetPerAxis: 100,
        applyToAllAxes: true,
        max3D: 2048,
        maxPerAxis: 4,
      });
      expect(plan.vtkPartitions).toEqual([4, 4, 4]);
      expect(plan.bricks).toHaveLength(64);
    });

    it('maps dirty regions to brick uploads', () => {
      const plan = buildWasmVtkBrickPlan([2900, 512, 512], {
        strategy: 'minimum',
        max3D: 2048,
      });
      const uploads = fullVolumeRegionToBrickUploads(
        [1400, 1500, 0, 10, 0, 10],
        plan
      );
      expect(uploads.length).toBe(2);
      expect(uploads[0].brickIndex).toBe(0);
      expect(uploads[1].brickIndex).toBe(1);
      expect(uploads[0].localExtent[0]).toBe(1400);
      expect(uploads[1].localExtent[0]).toBe(0); // 1449 - 1449
    });
  });
});
