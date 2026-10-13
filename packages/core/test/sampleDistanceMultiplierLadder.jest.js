import {
  SAMPLE_DISTANCE_MULTIPLIER_LADDER,
  clampToSampleDistanceMultiplierLadder,
  stepSampleDistanceMultiplier,
} from '../src/RenderingEngine/helpers/fpsBudgetController';

describe('sampleDistanceMultiplier ladder', () => {
  it('exposes the fixed ladder 1,2,4,8,16,32', () => {
    expect([...SAMPLE_DISTANCE_MULTIPLIER_LADDER]).toEqual([
      1, 2, 4, 8, 16, 32,
    ]);
  });

  it('snaps off-ladder values onto the nearest rung (ties prefer higher)', () => {
    expect(clampToSampleDistanceMultiplierLadder(1)).toBe(1);
    expect(clampToSampleDistanceMultiplierLadder(2)).toBe(2);
    expect(clampToSampleDistanceMultiplierLadder(3)).toBe(4);
    expect(clampToSampleDistanceMultiplierLadder(5)).toBe(4);
    expect(clampToSampleDistanceMultiplierLadder(6)).toBe(8);
    expect(clampToSampleDistanceMultiplierLadder(10)).toBe(8);
    expect(clampToSampleDistanceMultiplierLadder(12)).toBe(16);
    expect(clampToSampleDistanceMultiplierLadder(14)).toBe(16);
    expect(clampToSampleDistanceMultiplierLadder(20)).toBe(16);
    expect(clampToSampleDistanceMultiplierLadder(24)).toBe(32);
    expect(clampToSampleDistanceMultiplierLadder(100)).toBe(32);
    expect(clampToSampleDistanceMultiplierLadder(0)).toBe(1);
  });

  it('steps up one rung when EMA is mildly slower than target (below ×8)', () => {
    const targetMs = 100;
    // ema 110 → adj ~0.91 → single climb
    expect(stepSampleDistanceMultiplier(1, 110, targetMs)).toEqual({
      multiplier: 2,
      changed: true,
      settled: false,
    });
    expect(stepSampleDistanceMultiplier(2, 110, targetMs)).toEqual({
      multiplier: 4,
      changed: true,
      settled: false,
    });
  });

  it('double-steps toward ×8 but never past it in one jump', () => {
    const targetMs = 100;
    // ema ~154 → adj ~0.65 → mid double-step
    expect(stepSampleDistanceMultiplier(1, 154, targetMs)).toEqual({
      multiplier: 4,
      changed: true,
      settled: false,
    });
    expect(stepSampleDistanceMultiplier(2, 154, targetMs)).toEqual({
      multiplier: 8,
      changed: true,
      settled: false,
    });
    // From 4, double would be 16 — capped at 8
    expect(stepSampleDistanceMultiplier(4, 154, targetMs)).toEqual({
      multiplier: 8,
      changed: true,
      settled: false,
    });
  });

  it('holds at ×8 when only mildly slow; climbs one rung when very slow', () => {
    const targetMs = 100;
    // ema 110 → adj ~0.91 — soft under target, but high ladder holds
    expect(stepSampleDistanceMultiplier(8, 110, targetMs)).toEqual({
      multiplier: 8,
      changed: false,
      settled: true,
    });
    // ema 200 → adj 0.5 ≤ 0.55 — single step to 16
    expect(stepSampleDistanceMultiplier(8, 200, targetMs)).toEqual({
      multiplier: 16,
      changed: true,
      settled: false,
    });
  });

  it('from ×16 very-slow climbs one rung to ×32 (no double)', () => {
    expect(stepSampleDistanceMultiplier(16, 200, 100)).toEqual({
      multiplier: 32,
      changed: true,
      settled: false,
    });
  });

  it('stays at 32 when already at the top and still too slow', () => {
    expect(stepSampleDistanceMultiplier(32, 200, 100)).toEqual({
      multiplier: 32,
      changed: false,
      settled: false,
    });
  });

  it('steps down one rung when EMA is clearly faster than target', () => {
    const targetMs = 100;
    // ema 50 → adj 2 → too fast
    expect(stepSampleDistanceMultiplier(4, 50, targetMs)).toEqual({
      multiplier: 2,
      changed: true,
      settled: false,
    });
    expect(stepSampleDistanceMultiplier(2, 50, targetMs)).toEqual({
      multiplier: 1,
      changed: true,
      settled: false,
    });
  });

  it('holds instead of stepping down when allowStepDown is false', () => {
    expect(
      stepSampleDistanceMultiplier(4, 50, 100, { allowStepDown: false })
    ).toEqual({
      multiplier: 4,
      changed: false,
      settled: true,
    });
  });

  it('stays at 1 when already at the bottom and still too fast', () => {
    expect(stepSampleDistanceMultiplier(1, 50, 100)).toEqual({
      multiplier: 1,
      changed: false,
      settled: false,
    });
  });

  it('holds within the hysteresis band around the target', () => {
    const targetMs = 100;
    // ema 100 → adj 1 (exact)
    expect(stepSampleDistanceMultiplier(4, 100, targetMs)).toEqual({
      multiplier: 4,
      changed: false,
      settled: true,
    });
    // Mildly fast stays put (adj 1.25); step-down needs adj > 1.55
    expect(stepSampleDistanceMultiplier(4, 80, targetMs)).toEqual({
      multiplier: 4,
      changed: false,
      settled: true,
    });
  });
});
