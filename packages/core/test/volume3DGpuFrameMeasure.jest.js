import {
  isPositiveFiniteMs,
  shouldMeasureVolume3DPresent,
} from '../src/RenderingEngine/helpers/volume3DTargetFps';

describe('Volume3D present measure helpers', () => {
  it('accepts only finite positive milliseconds', () => {
    expect(isPositiveFiniteMs(16.7)).toBe(true);
    expect(isPositiveFiniteMs(0.1)).toBe(true);
    expect(isPositiveFiniteMs(0)).toBe(false);
    expect(isPositiveFiniteMs(-1)).toBe(false);
    expect(isPositiveFiniteMs(NaN)).toBe(false);
    expect(isPositiveFiniteMs(Infinity)).toBe(false);
    expect(isPositiveFiniteMs(undefined)).toBe(false);
    expect(isPositiveFiniteMs('12')).toBe(true);
  });

  it('does not measure presents for unknown viewports', () => {
    expect(shouldMeasureVolume3DPresent('no-such-viewport')).toBe(false);
  });
});
