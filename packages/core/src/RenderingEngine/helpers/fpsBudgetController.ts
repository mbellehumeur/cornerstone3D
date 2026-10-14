/**
 * Target FPS helpers for legacy Volume3D: normalize FPS, EMA frame time,
 * and a discrete sample-distance multiplier ladder.
 */

export const VOLUME_3D_DEFAULT_TARGET_FPS = 10;
/** Inclusive floor for Target FPS after normalization. */
export const VOLUME_3D_MIN_TARGET_FPS = 1;
/** Inclusive ceiling for Target FPS after normalization. */
export const VOLUME_3D_MAX_TARGET_FPS = 60;

/** Interactive sample-distance multipliers (coarser = higher). */
export const SAMPLE_DISTANCE_MULTIPLIER_LADDER = [1, 2, 4, 8, 16, 32] as const;

/** Default start rung when no last-good multiplier is remembered. */
export const DEFAULT_START_SAMPLE_DISTANCE_MULTIPLIER = 1;

/** EMA reacts reasonably quickly to present / inter-present frame cost. */
const FPS_EMA_ALPHA = 0.25;
/**
 * Asymmetric hysteresis on adj = targetMs / emaMs.
 * Prefer stepping up (coarser) when at/over target; only step down when
 * clearly faster so the ladder actually reaches 4/8 under load.
 */
const STEP_UP_BELOW_ADJ = 0.95;
const STEP_DOWN_ABOVE_ADJ = 1.55;
/** Below ×8: double-step when adj is at or below this. */
const STEP_UP_DOUBLE_BELOW_ADJ = 0.65;
/** At/above ×8: only climb when adj is at or below this (much slower). */
const STEP_UP_HIGH_BELOW_ADJ = 0.55;
/** Mid-ladder double-steps never land past this rung. */
export const FAST_CLIMB_CAP_MULTIPLIER = 8;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function normalizeTargetFps(value: unknown): number {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) {
    return VOLUME_3D_DEFAULT_TARGET_FPS;
  }
  return clamp(
    Math.round(fps),
    VOLUME_3D_MIN_TARGET_FPS,
    VOLUME_3D_MAX_TARGET_FPS
  );
}

export function updateEmaMs(previousEmaMs: number, dt: number): number {
  if (!(previousEmaMs > 0)) {
    return dt;
  }
  return (1 - FPS_EMA_ALPHA) * previousEmaMs + FPS_EMA_ALPHA * dt;
}

/**
 * Snap an arbitrary multiplier onto the nearest ladder rung
 * (ties prefer the higher rung).
 */
export function clampToSampleDistanceMultiplierLadder(value: number): number {
  const ladder = SAMPLE_DISTANCE_MULTIPLIER_LADDER;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= ladder[0]) {
    return ladder[0];
  }
  if (n >= ladder[ladder.length - 1]) {
    return ladder[ladder.length - 1];
  }

  let best: (typeof SAMPLE_DISTANCE_MULTIPLIER_LADDER)[number] = ladder[0];
  let bestDist = Math.abs(n - best);
  for (let i = 1; i < ladder.length; i++) {
    const rung = ladder[i];
    const dist = Math.abs(n - rung);
    if (dist < bestDist || (dist === bestDist && rung > best)) {
      best = rung;
      bestDist = dist;
    }
  }
  return best;
}

function ladderIndexOf(multiplier: number): number {
  const ladder = SAMPLE_DISTANCE_MULTIPLIER_LADDER;
  const snapped = clampToSampleDistanceMultiplierLadder(multiplier);
  const exact = ladder.indexOf(
    snapped as (typeof SAMPLE_DISTANCE_MULTIPLIER_LADDER)[number]
  );
  return exact >= 0 ? exact : 0;
}

/**
 * Move one ladder rung vs EMA frame time.
 * Too slow (emaMs > targetMs) → higher multiplier; too fast → lower toward 1
 * (unless `allowStepDown` is false — hold for the rest of the drag).
 */
export function stepSampleDistanceMultiplier(
  current: number,
  emaMs: number,
  targetMs: number,
  options?: { allowStepDown?: boolean }
): { multiplier: number; changed: boolean; settled: boolean } {
  const allowStepDown = options?.allowStepDown !== false;
  const ladder = SAMPLE_DISTANCE_MULTIPLIER_LADDER;
  const index = ladderIndexOf(current);
  const multiplier = ladder[index];

  if (
    !(emaMs > 0) ||
    !Number.isFinite(emaMs) ||
    !(targetMs > 0) ||
    !Number.isFinite(targetMs)
  ) {
    return { multiplier, changed: false, settled: false };
  }

  const adj = targetMs / emaMs;
  if (adj >= STEP_UP_BELOW_ADJ && adj <= STEP_DOWN_ABOVE_ADJ) {
    return { multiplier, changed: false, settled: true };
  }

  if (adj < STEP_UP_BELOW_ADJ) {
    const capIndex = ladderIndexOf(FAST_CLIMB_CAP_MULTIPLIER);

    if (multiplier >= FAST_CLIMB_CAP_MULTIPLIER) {
      // High ladder: single rung only, and only when clearly much slower.
      if (adj > STEP_UP_HIGH_BELOW_ADJ) {
        return { multiplier, changed: false, settled: true };
      }
      const nextIndex = Math.min(index + 1, ladder.length - 1);
      const next = ladder[nextIndex];
      return {
        multiplier: next,
        changed: next !== multiplier,
        settled: false,
      };
    }

    // Mid ladder: easy climb; double-step capped so we land at most on ×8.
    const climb = adj <= STEP_UP_DOUBLE_BELOW_ADJ ? 2 : 1;
    const nextIndex = Math.min(index + climb, capIndex, ladder.length - 1);
    const next = ladder[nextIndex];
    return {
      multiplier: next,
      changed: next !== multiplier,
      settled: false,
    };
  }

  // Clearly faster than target → finer sampling (optional within a drag).
  if (!allowStepDown) {
    return { multiplier, changed: false, settled: true };
  }

  const nextIndex = Math.max(index - 1, 0);
  const next = ladder[nextIndex];
  return {
    multiplier: next,
    changed: next !== multiplier,
    settled: false,
  };
}
