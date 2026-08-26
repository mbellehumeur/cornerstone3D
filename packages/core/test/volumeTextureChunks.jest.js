import {
  buildZChunkPlan,
  fullSliceToBrickLocalZ,
  DEFAULT_VOLUME_TEXTURE_CHUNK_OVERLAP,
} from '../src/RenderingEngine/helpers/volumeTextureChunks';

describe('buildZChunkPlan', () => {
  it('returns a single brick when depth fits in max3D', () => {
    const plan = buildZChunkPlan([512, 512, 100], 2048, 1);
    expect(plan.chunked).toBe(false);
    expect(plan.bricks).toHaveLength(1);
    expect(plan.bricks[0]).toEqual({
      sliceStart: 0,
      sliceEnd: 99,
      depth: 100,
    });
  });

  it('splits deep Z into overlapping bricks within max3D', () => {
    const plan = buildZChunkPlan([512, 512, 2500], 2048, 1);
    expect(plan.chunked).toBe(true);
    expect(plan.bricks.length).toBeGreaterThanOrEqual(2);
    expect(plan.bricks.every((b) => b.depth <= 2048)).toBe(true);
    expect(plan.bricks[0].sliceStart).toBe(0);
    expect(plan.bricks[plan.bricks.length - 1].sliceEnd).toBe(2499);

    // Adjacent bricks share overlap slices
    for (let i = 0; i < plan.bricks.length - 1; i++) {
      const a = plan.bricks[i];
      const b = plan.bricks[i + 1];
      expect(b.sliceStart).toBe(
        a.sliceEnd - DEFAULT_VOLUME_TEXTURE_CHUNK_OVERLAP + 1
      );
    }
  });

  it('covers a soft-cap scenario used for tests (max3D=512)', () => {
    const plan = buildZChunkPlan([256, 256, 900], 512, 1);
    expect(plan.chunked).toBe(true);
    expect(plan.bricks.length).toBeGreaterThanOrEqual(2);
    expect(plan.bricks.every((b) => b.depth <= 512)).toBe(true);
    expect(plan.bricks[0].sliceEnd).toBe(511);
    expect(plan.bricks[1].sliceStart).toBe(511);
  });

  it('marks unsupportedXY when width exceeds max3D', () => {
    const plan = buildZChunkPlan([3000, 512, 100], 2048, 1);
    expect(plan.unsupportedXY).toBe(true);
    expect(plan.chunked).toBe(false);
  });

  it('maps full-volume slice index to brick-local Z', () => {
    const brick = { sliceStart: 1249, sliceEnd: 2499, depth: 1251 };
    expect(fullSliceToBrickLocalZ(1249, brick)).toBe(0);
    expect(fullSliceToBrickLocalZ(1250, brick)).toBe(1);
    expect(fullSliceToBrickLocalZ(2499, brick)).toBe(1250);
    expect(fullSliceToBrickLocalZ(1248, brick)).toBeNull();
  });
});
