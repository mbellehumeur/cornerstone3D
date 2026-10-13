import { getEnabledElementByViewportId } from '../../getEnabledElement';
import ViewportType from '../../enums/ViewportType';
import type { IViewport } from '../../types/IViewport';
import type { ActorEntry } from '../../types/IActor';
import {
  clampToSampleDistanceMultiplierLadder,
  DEFAULT_START_SAMPLE_DISTANCE_MULTIPLIER,
  FAST_CLIMB_CAP_MULTIPLIER,
  normalizeTargetFps,
  stepSampleDistanceMultiplier,
  updateEmaMs,
  VOLUME_3D_DEFAULT_TARGET_FPS,
} from './fpsBudgetController';

export {
  VOLUME_3D_DEFAULT_TARGET_FPS,
  VOLUME_3D_MIN_TARGET_FPS,
  VOLUME_3D_MAX_TARGET_FPS,
  SAMPLE_DISTANCE_MULTIPLIER_LADDER,
  DEFAULT_START_SAMPLE_DISTANCE_MULTIPLIER,
  FAST_CLIMB_CAP_MULTIPLIER,
} from './fpsBudgetController';

/** Fixed interactive sample-distance factor (legacy rotate ×2). */
export const VOLUME_3D_DEFAULT_INTERACTIVE_SAMPLE_DISTANCE_FACTOR = 2;

export type Volume3DInteractiveQualityPolicy =
  | 'fixedSampleDistance'
  | 'targetFps';

export type Volume3DTargetFpsPhase = 'idle' | 'steer' | 'settled';

export type Volume3DTargetFpsSnapshot = {
  enabled: boolean;
  policy: Volume3DInteractiveQualityPolicy;
  interacting: boolean;
  phase: Volume3DTargetFpsPhase;
  targetFps: number;
  targetMs: number;
  emaFps: number;
  emaMs: number;
  sampleDistanceMultiplier: number;
  lastGoodSampleDistanceMultiplier: number;
  sampleDistance: number;
  dragFrames: number;
};

/** Steer multiplier every N presents (EMA still updates every present). */
const MULTIPLIER_UPDATE_EVERY_N_PRESENTS = 2;
/** Fast mid-ladder climb cooldown (new multiplier still below ×8). */
const MULTIPLIER_COOLDOWN_AFTER_STEP_UP_MID = 1;
/** Slow high-ladder climb cooldown (new multiplier at/above ×8). */
const MULTIPLIER_COOLDOWN_AFTER_STEP_UP_HIGH = 8;
/** Longer cooldown after stepping down to avoid thrashing quality. */
const MULTIPLIER_COOLDOWN_AFTER_STEP_DOWN = 6;

type MapperSampleDistance = {
  mapper: {
    getSampleDistance?: () => number;
    setSampleDistance?: (distance: number) => void;
  };
  baselineSampleDistance: number;
};

type Volume3DTargetFpsEntry = {
  targetFps: number;
  /** True when Target FPS / IFD is opted in. */
  enabled: boolean;
  policy: Volume3DInteractiveQualityPolicy;
  interacting: boolean;
  sampleDistanceMultiplier: number;
  lastGoodSampleDistanceMultiplier: number;
  emaMs: number;
  /** performance.now() at the end of the last recorded present. */
  lastPresentMs: number;
  dragFrameCount: number;
  /** Presents remaining before the next ladder steer is allowed. */
  multiplierCooldownPresents: number;
  /**
   * Once true, this drag only climbs/holds — no step-down.
   * False at drag start so a resumed lastGood multiplier can ease down.
   */
  hasClimbedThisDrag: boolean;
  skipNextDt: boolean;
  lastUpdateSettled: boolean;
  baselineMappers: MapperSampleDistance[];
};

const entries = new Map<string, Volume3DTargetFpsEntry>();

function isLegacyVolume3DViewport(viewport: IViewport | undefined): boolean {
  // Only the classic VolumeViewport3D class (`type === volume3d`), not
  // VOLUME_3D_NEXT / GenericViewport remaps.
  return viewport?.type === ViewportType.VOLUME_3D;
}

function resolveViewport(viewportId: string): IViewport | undefined {
  return getEnabledElementByViewportId(viewportId)?.viewport;
}

function ensureEntry(viewportId: string): Volume3DTargetFpsEntry | undefined {
  const existing = entries.get(viewportId);
  if (existing) {
    return existing;
  }

  const viewport = resolveViewport(viewportId);
  if (!viewport || !isLegacyVolume3DViewport(viewport)) {
    return undefined;
  }

  const entry: Volume3DTargetFpsEntry = {
    targetFps: VOLUME_3D_DEFAULT_TARGET_FPS,
    enabled: false,
    policy: 'fixedSampleDistance',
    interacting: false,
    sampleDistanceMultiplier: DEFAULT_START_SAMPLE_DISTANCE_MULTIPLIER,
    lastGoodSampleDistanceMultiplier: 0,
    emaMs: 0,
    lastPresentMs: 0,
    dragFrameCount: 0,
    multiplierCooldownPresents: 0,
    hasClimbedThisDrag: false,
    skipNextDt: false,
    lastUpdateSettled: false,
    baselineMappers: [],
  };
  entries.set(viewportId, entry);
  return entry;
}

function captureBaselineMappers(viewport: IViewport): MapperSampleDistance[] {
  const actors =
    typeof (viewport as { getActors?: () => ActorEntry[] }).getActors ===
    'function'
      ? (viewport as { getActors: () => ActorEntry[] }).getActors()
      : [];

  const baselines: MapperSampleDistance[] = [];
  for (const actorEntry of actors) {
    const actor = actorEntry?.actor as
      | { getMapper?: () => MapperSampleDistance['mapper'] }
      | undefined;
    const mapper = actor?.getMapper?.();
    if (!mapper?.getSampleDistance || !mapper?.setSampleDistance) {
      continue;
    }
    baselines.push({
      mapper,
      baselineSampleDistance: mapper.getSampleDistance(),
    });
  }
  return baselines;
}

/** Live VTK sample distance for overlays (first volume mapper). */
function resolveSampleDistance(
  entry: Volume3DTargetFpsEntry,
  viewportId: string
): number {
  const held = entry.baselineMappers[0]?.mapper?.getSampleDistance?.();
  if (typeof held === 'number' && Number.isFinite(held) && held > 0) {
    return held;
  }

  const viewport = resolveViewport(viewportId);
  if (!viewport) {
    return 0;
  }

  const actors =
    typeof (viewport as { getActors?: () => ActorEntry[] }).getActors ===
    'function'
      ? (viewport as { getActors: () => ActorEntry[] }).getActors()
      : [];

  for (const actorEntry of actors) {
    const actor = actorEntry?.actor as
      | { getMapper?: () => MapperSampleDistance['mapper'] }
      | undefined;
    const distance = actor?.getMapper?.()?.getSampleDistance?.();
    if (
      typeof distance === 'number' &&
      Number.isFinite(distance) &&
      distance > 0
    ) {
      return distance;
    }
  }
  return 0;
}

/**
 * Resolve the fixed-policy interactive sample-distance multiplier.
 * Accepts a finite number > 0; otherwise returns the default ×2.
 */
export function resolveFixedSampleDistanceFactor(
  sampleDistanceFactor?: number
): number {
  const factor = Number(sampleDistanceFactor);
  if (Number.isFinite(factor) && factor > 0) {
    return factor;
  }
  return VOLUME_3D_DEFAULT_INTERACTIVE_SAMPLE_DISTANCE_FACTOR;
}

function applySampleDistanceMultiplier(
  entry: Volume3DTargetFpsEntry,
  multiplier: number
) {
  for (const { mapper, baselineSampleDistance } of entry.baselineMappers) {
    mapper.setSampleDistance?.(baselineSampleDistance * multiplier);
  }
}

function applyFixedSampleDistanceFactor(
  entry: Volume3DTargetFpsEntry,
  sampleDistanceFactor?: number
) {
  applySampleDistanceMultiplier(
    entry,
    resolveFixedSampleDistanceFactor(sampleDistanceFactor)
  );
}

function restoreBaselineSampleDistances(entry: Volume3DTargetFpsEntry) {
  for (const { mapper, baselineSampleDistance } of entry.baselineMappers) {
    mapper.setSampleDistance?.(baselineSampleDistance);
  }
}

function resolveStartMultiplier(entry: Volume3DTargetFpsEntry): number {
  if (entry.lastGoodSampleDistanceMultiplier > 0) {
    return clampToSampleDistanceMultiplierLadder(
      entry.lastGoodSampleDistanceMultiplier
    );
  }
  return DEFAULT_START_SAMPLE_DISTANCE_MULTIPLIER;
}

function rearmLearning(entry: Volume3DTargetFpsEntry) {
  entry.emaMs = 0;
  entry.lastPresentMs = 0;
  entry.dragFrameCount = 0;
  entry.multiplierCooldownPresents = 0;
  entry.hasClimbedThisDrag = false;
  entry.skipNextDt = true;
  entry.lastUpdateSettled = false;
}

function isTargetFpsPolicyActive(entry: Volume3DTargetFpsEntry): boolean {
  return entry.policy === 'targetFps' && entry.enabled;
}

function resolvePhase(entry: Volume3DTargetFpsEntry): Volume3DTargetFpsPhase {
  if (!entry.interacting) {
    return 'idle';
  }
  if (entry.lastUpdateSettled) {
    return 'settled';
  }
  return 'steer';
}

/**
 * Set the Target FPS for a legacy Volume3D viewport.
 * Clamps to 1–60. Returns false when the viewport is not legacy Volume3D.
 * Does not enable targeting by itself — use setVolume3DTargetFpsEnabled.
 */
export function setVolume3DTargetFps(viewportId: string, fps: number): boolean {
  const entry = ensureEntry(viewportId);
  if (!entry) {
    return false;
  }
  const next = normalizeTargetFps(fps);
  const previous = entry.targetFps;
  entry.targetFps = next;
  if (next !== previous) {
    rearmLearning(entry);
  }
  return true;
}

export function getVolume3DTargetFps(viewportId: string): number | undefined {
  const entry = entries.get(viewportId) ?? ensureEntry(viewportId);
  return entry?.targetFps;
}

/**
 * Set interactive quality policy for a legacy Volume3D viewport.
 * `fixedSampleDistance` (default) applies a fixed sample-distance multiplier
 * during drag (tool `rotateSampleDistanceFactor` when provided, else ×2);
 * `targetFps` uses the discrete sample-distance ladder when also enabled via
 * setVolume3DTargetFpsEnabled.
 */
export function setVolume3DInteractiveQualityPolicy(
  viewportId: string,
  policy: Volume3DInteractiveQualityPolicy
): boolean {
  const entry = ensureEntry(viewportId);
  if (!entry) {
    return false;
  }
  if (policy !== 'fixedSampleDistance' && policy !== 'targetFps') {
    return false;
  }
  entry.policy = policy;
  if (policy === 'targetFps') {
    entry.enabled = true;
    rearmLearning(entry);
  } else {
    entry.enabled = false;
    if (entry.interacting) {
      endVolume3DInteraction(viewportId);
    }
  }
  return true;
}

export function getVolume3DInteractiveQualityPolicy(
  viewportId: string
): Volume3DInteractiveQualityPolicy | undefined {
  const entry = entries.get(viewportId) ?? ensureEntry(viewportId);
  return entry?.policy;
}

/**
 * Enable or disable interactive Target FPS for a legacy Volume3D viewport.
 * When enabled, policy becomes `targetFps`. When disabled, policy restores
 * `fixedSampleDistance` and any active interaction ends.
 */
export function setVolume3DTargetFpsEnabled(
  viewportId: string,
  enabled: boolean
): boolean {
  const entry = ensureEntry(viewportId);
  if (!entry) {
    return false;
  }
  const next = Boolean(enabled);
  entry.enabled = next;
  entry.policy = next ? 'targetFps' : 'fixedSampleDistance';
  if (!next && entry.interacting) {
    endVolume3DInteraction(viewportId);
  }
  if (next) {
    rearmLearning(entry);
  }
  return true;
}

export function getVolume3DTargetFpsEnabled(
  viewportId: string
): boolean | undefined {
  const entry = entries.get(viewportId) ?? ensureEntry(viewportId);
  return entry?.enabled;
}

/**
 * Begin interactive LOD for a legacy Volume3D viewport.
 * Returns true when interaction quality was armed (fixed sample-distance
 * factor or Target FPS).
 *
 * Under `fixedSampleDistance`, optional `sampleDistanceFactor` (e.g. from
 * tool `rotateSampleDistanceFactor`) multiplies baseline sample distance when
 * it is a finite number > 0; otherwise the default ×2 is used.
 * Under `targetFps`, the factor is ignored; the discrete ladder is used.
 */
export function beginVolume3DInteraction(
  viewportId: string,
  options?: { sampleDistanceFactor?: number }
): boolean {
  const entry = ensureEntry(viewportId);
  const viewport = resolveViewport(viewportId);
  if (!entry || !viewport) {
    return false;
  }

  if (entry.interacting) {
    // Already armed for this interaction. Re-capturing the
    // baseline here would store a degraded sample distance.
    return true;
  }

  entry.baselineMappers = captureBaselineMappers(viewport);
  if (!entry.baselineMappers.length) {
    return false;
  }

  entry.interacting = true;

  if (isTargetFpsPolicyActive(entry)) {
    entry.sampleDistanceMultiplier = resolveStartMultiplier(entry);
    entry.skipNextDt = true;
    entry.dragFrameCount = 0;
    entry.multiplierCooldownPresents = 0;
    entry.hasClimbedThisDrag = false;
    entry.emaMs = 0;
    entry.lastPresentMs = 0;
    entry.lastUpdateSettled = false;
    applySampleDistanceMultiplier(entry, entry.sampleDistanceMultiplier);
  } else {
    // fixedSampleDistance (default)
    applyFixedSampleDistanceFactor(entry, options?.sampleDistanceFactor);
  }

  return true;
}

/**
 * End interactive LOD and restore full-quality sample distances.
 */
export function endVolume3DInteraction(viewportId: string): boolean {
  const entry = entries.get(viewportId);
  if (!entry || !entry.interacting) {
    return false;
  }

  // Remember the last multiplier used this drag so the next drag resumes
  // there (first-ever drag still starts at DEFAULT_START = 1).
  if (isTargetFpsPolicyActive(entry)) {
    entry.lastGoodSampleDistanceMultiplier = entry.sampleDistanceMultiplier;
  }

  restoreBaselineSampleDistances(entry);
  entry.baselineMappers = [];
  entry.interacting = false;
  entry.skipNextDt = false;
  return true;
}

export function isVolume3DInteracting(viewportId: string): boolean {
  return entries.get(viewportId)?.interacting === true;
}

/**
 * True when ContextPool should time this viewport's full present
 * (VTK render through blit) for Target FPS EMA.
 */
export function shouldMeasureVolume3DPresent(viewportId: string): boolean {
  const entry = entries.get(viewportId);
  return Boolean(entry?.interacting && isTargetFpsPolicyActive(entry));
}

/** Finite positive frame cost in milliseconds. */
export function isPositiveFiniteMs(value: unknown): value is number {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0;
}

/** Ignore tab-background / focus gaps that would nuke the EMA. */
const MAX_INTER_PRESENT_MS = 1000;

/**
 * Record a Volume3D present cost and step the sample-distance ladder.
 *
 * `presentMs` is wall-clock for this viewport's ContextPool present
 * (render through blit). The EMA uses
 * `max(presentMs, interPresentMs)` so a cheap GL submit cannot hide a
 * slow present cadence (other viewports, main-thread gaps, etc.).
 */
export function recordVolume3DPresent(
  viewportId: string,
  presentMs: number
): void {
  const entry = entries.get(viewportId);
  if (!entry?.interacting || !isTargetFpsPolicyActive(entry)) {
    return;
  }

  const now = performance.now();

  // First sample after arming / target change: seed EMA, arm inter-present.
  if (entry.skipNextDt) {
    entry.skipNextDt = false;
    entry.lastPresentMs = now;
    if (isPositiveFiniteMs(presentMs)) {
      entry.emaMs = updateEmaMs(entry.emaMs, presentMs);
    }
    return;
  }

  const interPresentMs =
    entry.lastPresentMs > 0 ? now - entry.lastPresentMs : 0;
  entry.lastPresentMs = now;

  const cappedInter =
    interPresentMs > 0 && interPresentMs <= MAX_INTER_PRESENT_MS
      ? interPresentMs
      : 0;
  const span = isPositiveFiniteMs(presentMs) ? presentMs : 0;
  const frameMs = Math.max(span, cappedInter);
  if (!(frameMs > 0)) {
    return;
  }

  entry.dragFrameCount += 1;
  entry.emaMs = updateEmaMs(entry.emaMs, frameMs);

  if (entry.multiplierCooldownPresents > 0) {
    entry.multiplierCooldownPresents -= 1;
    return;
  }

  if (entry.dragFrameCount % MULTIPLIER_UPDATE_EVERY_N_PRESENTS !== 0) {
    return;
  }

  const targetMs = 1000 / entry.targetFps;
  // Resume from lastGood may step down while Frame EMA has headroom.
  // After any climb this drag, lock step-down for the rest of the drag.
  const result = stepSampleDistanceMultiplier(
    entry.sampleDistanceMultiplier,
    entry.emaMs,
    targetMs,
    { allowStepDown: !entry.hasClimbedThisDrag }
  );
  entry.lastUpdateSettled = result.settled;
  if (result.changed) {
    const previous = entry.sampleDistanceMultiplier;
    entry.sampleDistanceMultiplier = result.multiplier;
    applySampleDistanceMultiplier(entry, entry.sampleDistanceMultiplier);
    if (result.multiplier > previous) {
      entry.hasClimbedThisDrag = true;
      entry.multiplierCooldownPresents =
        result.multiplier >= FAST_CLIMB_CAP_MULTIPLIER
          ? MULTIPLIER_COOLDOWN_AFTER_STEP_UP_HIGH
          : MULTIPLIER_COOLDOWN_AFTER_STEP_UP_MID;
    } else {
      entry.multiplierCooldownPresents = MULTIPLIER_COOLDOWN_AFTER_STEP_DOWN;
    }
  }
  if (result.settled) {
    entry.lastGoodSampleDistanceMultiplier = entry.sampleDistanceMultiplier;
  }
}

/**
 * Read-only snapshot of Target FPS controller state for overlays / debugging.
 */
export function getVolume3DTargetFpsSnapshot(
  viewportId: string
): Volume3DTargetFpsSnapshot | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }

  const targetMs = 1000 / entry.targetFps;
  const emaMs = entry.emaMs;
  const emaFps = emaMs > 0 ? 1000 / emaMs : 0;

  return {
    enabled: entry.enabled,
    policy: entry.policy,
    interacting: entry.interacting,
    phase: resolvePhase(entry),
    targetFps: entry.targetFps,
    targetMs,
    emaFps,
    emaMs,
    sampleDistanceMultiplier: entry.sampleDistanceMultiplier,
    lastGoodSampleDistanceMultiplier: entry.lastGoodSampleDistanceMultiplier,
    sampleDistance: resolveSampleDistance(entry, viewportId),
    dragFrames: entry.dragFrameCount,
  };
}

export function unregisterVolume3DTargetFps(viewportId: string): void {
  const entry = entries.get(viewportId);
  if (!entry) {
    return;
  }
  if (entry.interacting) {
    restoreBaselineSampleDistances(entry);
  }
  entries.delete(viewportId);
}
