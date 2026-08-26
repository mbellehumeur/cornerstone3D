import {
  computeFittedVolumeSampleDistance,
  DEFAULT_MAX_SAMPLES_PER_RAY,
} from '../src/RenderingEngine/helpers/volumeSampleDistance';

function mockImageData(bounds, spacing) {
  return {
    getSpacing: () => spacing,
    getBounds: () => bounds,
  };
}

describe('computeFittedVolumeSampleDistance', () => {
  it('keeps spacing-based distance when steps fit the budget', () => {
    // Small cube: diagonal ~1.732, sampleDistance = 3/6 = 0.5 → ~4 steps
    const result = computeFittedVolumeSampleDistance(
      mockImageData([0, 1, 0, 1, 0, 1], [1, 1, 1])
    );
    expect(result.fitted).toBe(false);
    expect(result.sampleDistance).toBeCloseTo(0.5);
    expect(result.maxSamplesPerRay).toBe(DEFAULT_MAX_SAMPLES_PER_RAY);
    expect(result.computedSteps).toBeLessThanOrEqual(
      DEFAULT_MAX_SAMPLES_PER_RAY
    );
  });

  it('increases sample distance when diagonal needs too many steps', () => {
    // Long thin volume: bounds ~ 512*0.5 x 512*0.5 x 2500*0.5 mm
    const sx = 0.5;
    const sy = 0.5;
    const sz = 0.5;
    const dims = [512, 512, 2500];
    const bounds = [0, dims[0] * sx, 0, dims[1] * sy, 0, dims[2] * sz];
    const maxSamples = 512;
    const result = computeFittedVolumeSampleDistance(
      mockImageData(bounds, [sx, sy, sz]),
      { multiplier: 1, maxSamplesPerRay: maxSamples }
    );
    expect(result.fitted).toBe(true);
    expect(result.computedSteps).toBeGreaterThan(maxSamples);
    const diagonal = Math.hypot(bounds[1], bounds[3], bounds[5]);
    expect(result.sampleDistance).toBeCloseTo(diagonal / maxSamples);
    expect(Math.ceil(diagonal / result.sampleDistance)).toBeLessThanOrEqual(
      maxSamples
    );
  });
});
