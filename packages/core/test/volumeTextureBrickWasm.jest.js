import {
  brickExtentsAabb,
  bricksIntersectingIjkPlane,
  buildWasmVtkBrickPlan,
  fullVolumeRegionToBrickUploads,
  ijkBoxVoxelCount,
  minimumPartitionsForAxis,
  refineBrickPlanForByteBudget,
  shouldUseDenseWasmBricks,
  splitAxisExtents,
  estimateVolumeScalarBytes,
  VTK_WASM_BRICK_PRESETS,
  resolveVtkWasmBrickPresetFromOptions,
  isVtkWasmBrickPresetId,
} from '../src/RenderingEngine/helpers/volumeTextureBrickWasm';
import { copyIjkBoxIntoDenseBrick } from '../src/RenderingEngine/GenericViewport/vtkWasmBrickedVolumeBinding';

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

    it('uses minimum strategy for 2500x512x512 → (2,1,1), 2 bricks', () => {
      const plan = buildWasmVtkBrickPlan([2500, 512, 512], {
        strategy: 'minimum',
        max3D: 2048,
      });
      expect(plan.vtkPartitions).toEqual([2, 1, 1]);
      expect(plan.bricked).toBe(true);
      expect(plan.bricks).toHaveLength(2);
      expect(plan.bricks[0].textureSize[0]).toBeLessThanOrEqual(2048);
      expect(plan.bricks[1].textureSize[0]).toBeLessThanOrEqual(2048);
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

    it('fixed 8x8x8 yields 512 bricks for large CT', () => {
      const plan = buildWasmVtkBrickPlan([512, 512, 2948], {
        strategy: 'fixed',
        partitions: [8, 8, 8],
        max3D: 2048,
      });
      expect(plan.vtkPartitions).toEqual([8, 8, 8]);
      expect(plan.bricks).toHaveLength(512);
      for (const b of plan.bricks) {
        expect(
          b.textureSize[0] * b.textureSize[1] * b.textureSize[2]
        ).toBeLessThan(512 * 512 * 2948);
      }
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

  describe('dense brick helpers', () => {
    it('estimates Int16 CT bytes', () => {
      expect(estimateVolumeScalarBytes([512, 512, 2948], 2)).toBe(1545601024);
    });

    it('flags large volumes for dense bricks', () => {
      expect(shouldUseDenseWasmBricks([512, 512, 100], 2)).toBe(false);
      expect(shouldUseDenseWasmBricks([512, 512, 2948], 2)).toBe(true);
    });

    it('intersects axial plane with a subset of 8x8x8 bricks', () => {
      const plan = buildWasmVtkBrickPlan([512, 512, 2948], {
        strategy: 'fixed',
        partitions: [8, 8, 8],
        max3D: 2048,
      });
      const hits = bricksIntersectingIjkPlane(
        plan,
        [256, 256, 1474],
        [0, 0, 1],
        2
      );
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThan(plan.bricks.length);
      const aabb = brickExtentsAabb(hits);
      expect(aabb).not.toBeNull();
      expect(ijkBoxVoxelCount(aabb)).toBeLessThan(512 * 512 * 2948);
    });

    it('refines plan so bricks fit a byte budget', () => {
      const plan = buildWasmVtkBrickPlan([512, 512, 2948], {
        strategy: 'minimum',
        max3D: 2048,
      });
      const refined = refineBrickPlanForByteBudget(
        plan,
        2,
        1,
        64 * 1024 * 1024
      );
      let maxBytes = 0;
      for (const b of refined.bricks) {
        const [sx, sy, sz] = b.textureSize;
        maxBytes = Math.max(maxBytes, sx * sy * sz * 2);
      }
      expect(maxBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    });

    it('does not refine fixed partition grids', () => {
      const plan = buildWasmVtkBrickPlan([512, 512, 2948], {
        strategy: 'fixed',
        partitions: [8, 8, 8],
        max3D: 2048,
      });
      const refined = refineBrickPlanForByteBudget(plan, 2, 1, 1024);
      expect(refined.vtkPartitions).toEqual([8, 8, 8]);
      expect(refined.bricks).toHaveLength(512);
    });

    it('copies IJK box into a dense brick buffer', () => {
      const dims = [4, 4, 4];
      const src = new Int16Array(4 * 4 * 4);
      for (let i = 0; i < src.length; i++) {
        src[i] = i;
      }
      const extent = [1, 2, 1, 2, 1, 2];
      const dest = new Int16Array(2 * 2 * 2);
      copyIjkBoxIntoDenseBrick(src, dest, dims, extent, 1);
      // source (i,j,k)=(1,1,1) → index ((1*4+1)*4+1)=21
      expect(dest[0]).toBe(21);
      expect(dest.length).toBe(8);
    });
  });

  describe('readWasmBrickPartitionOptionsForPath', () => {
    it('merges global and MPR override', () => {
      const initModule = require('../src/init');
      const spy = jest.spyOn(initModule, 'getConfiguration').mockReturnValue({
        rendering: {
          vtkWasm: {
            volumeTextureBrickling: true,
            brickPartitions: {
              strategy: 'target',
              targetPerAxis: 8,
              applyToAllAxes: true,
            },
            brickPartitionsMpr: {
              strategy: 'fixed',
              partitions: [8, 8, 8],
            },
          },
        },
      });

      const {
        readWasmBrickPartitionOptionsForPath,
      } = require('../src/RenderingEngine/helpers/volumeTextureBrickWasm');

      expect(readWasmBrickPartitionOptionsForPath('mpr')).toMatchObject({
        strategy: 'fixed',
        partitions: [8, 8, 8],
        targetPerAxis: 8,
        applyToAllAxes: true,
      });
      expect(readWasmBrickPartitionOptionsForPath('volume3d')).toMatchObject({
        strategy: 'target',
        targetPerAxis: 8,
        applyToAllAxes: true,
      });

      spy.mockRestore();
    });

    it('mpr fixed vs volume3d target on 512x512x258', () => {
      const mprPlan = buildWasmVtkBrickPlan([512, 512, 258], {
        strategy: 'fixed',
        partitions: [8, 8, 8],
        max3D: 2048,
      });
      const vol3dPlan = buildWasmVtkBrickPlan([512, 512, 258], {
        strategy: 'target',
        targetPerAxis: 8,
        applyToAllAxes: true,
        max3D: 2048,
      });
      expect(mprPlan.vtkPartitions).toEqual([8, 8, 8]);
      expect(vol3dPlan.vtkPartitions).toEqual([8, 8, 8]);
      expect(mprPlan.strategy).toBe('fixed');
      expect(vol3dPlan.strategy).toBe('target');
    });
  });

  describe('VTK_WASM_BRICK_PRESETS', () => {
    it('maps options back to preset ids', () => {
      expect(
        resolveVtkWasmBrickPresetFromOptions(VTK_WASM_BRICK_PRESETS.minimal)
      ).toBe('minimal');
      expect(
        resolveVtkWasmBrickPresetFromOptions(VTK_WASM_BRICK_PRESETS['2x2x2'])
      ).toBe('2x2x2');
      expect(
        resolveVtkWasmBrickPresetFromOptions(VTK_WASM_BRICK_PRESETS['4x4x4'])
      ).toBe('4x4x4');
      expect(
        resolveVtkWasmBrickPresetFromOptions(VTK_WASM_BRICK_PRESETS['8x8x8'])
      ).toBe('8x8x8');
      expect(
        resolveVtkWasmBrickPresetFromOptions({
          strategy: 'fixed',
          partitions: [3, 3, 3],
        })
      ).toBeUndefined();
    });

    it('validates preset ids', () => {
      expect(isVtkWasmBrickPresetId('minimal')).toBe(true);
      expect(isVtkWasmBrickPresetId('8x8x8')).toBe(true);
      expect(isVtkWasmBrickPresetId('invalid')).toBe(false);
    });

    it('builds expected brick counts from presets on 2500x512x512', () => {
      const minimal = buildWasmVtkBrickPlan([2500, 512, 512], {
        ...VTK_WASM_BRICK_PRESETS.minimal,
        max3D: 2048,
      });
      expect(minimal.bricks).toHaveLength(2);

      const fixed2 = buildWasmVtkBrickPlan([2500, 512, 512], {
        ...VTK_WASM_BRICK_PRESETS['2x2x2'],
        max3D: 2048,
      });
      expect(fixed2.bricks).toHaveLength(8);
    });
  });
});
