import type { VolumeRenderer } from '@mview/webgpu-volume-standalone';
import type { ViewportPreset } from '../../../types';
import { viewportPresetToMviewAppearance } from './mviewViewportPreset';
import { MVIEW_ORTHO_DEFAULT_HALF_HEIGHT } from './mviewVolume3DCamera';

/** Mview VolumeRenderer raymarch modes (surface / composite / mip). */
export type MviewVolume3DRenderMode = 'surface' | 'composite' | 'mip';

/** Mview camera projection (orthographic default for OHIF Volume3D parity). */
export type MviewVolume3DProjection = 'perspective' | 'orthographic';

/** 0 = mview (adaptive), 1 = max density. Default 0.18 matches webgpuVolume3d look. */
export type MviewVolume3DPresentQuality = number;

/** Slider default: visually matches OHIF/webgpuVolume3d (not slider max). */
export const MVIEW_DEFAULT_PRESENT_QUALITY = 0.18;

/** End-of-drag FPS target. 0 = off. */
export const MVIEW_DEFAULT_TARGET_FPS = 30;

const MVIEW_RENDER_MODES: ReadonlySet<string> = new Set([
  'surface',
  'composite',
  'mip',
]);

const MVIEW_PROJECTIONS: ReadonlySet<string> = new Set([
  'perspective',
  'orthographic',
]);

export type MviewVolume3DEntry = {
  canvas: HTMLCanvasElement;
  renderer: VolumeRenderer;
  /** parallelScale at fit (for zoom bridge / getZoom baseline) */
  baselineParallelScale?: number;
  /** max(dims×spacing) — mview box normalization divisor */
  volumePhysicalMax?: number;
  /** Volume center in world/LPS for pan bridge */
  volumeCenter?: [number, number, number];
  /** Present quality blend: 0 = mview, 1 = OHIF (default). */
  presentQuality?: MviewVolume3DPresentQuality;
  /** End-of-drag FPS target when enabled. Default 30. */
  targetFps?: number;
  /** When false, FPS targeting is off. Default true. */
  targetFpsEnabled?: boolean;
  /** Volume scalar range used to normalize VIEWPORT_PRESET HU curves. */
  valueRange?: [number, number];
  /** Preset applied before scalars were ready; flushed after upload. */
  pendingPreset?: ViewportPreset;
};

const entries = new Map<string, MviewVolume3DEntry>();

/** @internal */
export function registerMviewVolume3D(
  viewportId: string,
  entry: MviewVolume3DEntry
): void {
  const existing = entries.get(viewportId);
  entries.set(viewportId, {
    ...existing,
    ...entry,
    valueRange: entry.valueRange ?? existing?.valueRange,
    pendingPreset: entry.pendingPreset ?? existing?.pendingPreset,
    volumePhysicalMax: entry.volumePhysicalMax ?? existing?.volumePhysicalMax,
    volumeCenter: entry.volumeCenter ?? existing?.volumeCenter,
    presentQuality: entry.presentQuality ?? existing?.presentQuality,
    targetFps: entry.targetFps ?? existing?.targetFps,
    targetFpsEnabled: entry.targetFpsEnabled ?? existing?.targetFpsEnabled,
    baselineParallelScale:
      entry.baselineParallelScale ?? existing?.baselineParallelScale,
  });
}

/** @internal */
export function unregisterMviewVolume3D(viewportId: string): void {
  entries.delete(viewportId);
}

/** @internal */
export function getMviewVolume3D(
  viewportId: string
): MviewVolume3DEntry | undefined {
  return entries.get(viewportId);
}

/** @internal */
export function setMviewVolume3DValueRange(
  viewportId: string,
  valueRange: [number, number]
): void {
  const entry = entries.get(viewportId);

  if (!entry) {
    return;
  }

  entry.valueRange = valueRange;
}

/** @internal */
export function beginMviewVolume3DInteraction(viewportId: string): boolean {
  const entry = entries.get(viewportId);

  if (!entry) {
    return false;
  }

  entry.renderer.beginInteraction();
  return true;
}

/** @internal */
export function endMviewVolume3DInteraction(viewportId: string): boolean {
  const entry = entries.get(viewportId);

  if (!entry) {
    return false;
  }

  entry.renderer.endInteraction();
  return true;
}

/**
 * Drive mview trackball rotation for a mview present.
 * Returns false when this viewport is not a mview Volume3D.
 *
 * @internal
 */
export function rotateMviewVolume3D(
  viewportId: string,
  deltaX: number,
  deltaY: number,
  width: number,
  height: number
): boolean {
  const entry = entries.get(viewportId);

  if (!entry) {
    return false;
  }

  entry.renderer.rotateTrackball(deltaX, deltaY, width, height);
  return true;
}

/** @internal */
export function setMviewVolume3DCanvasVisible(
  viewportId: string,
  visible: boolean
): void {
  const entry = entries.get(viewportId);

  if (!entry) {
    return;
  }

  // Must be `block`, not `''`: canvas defaults to inline, which collapses
  // clientWidth/Height so VolumeRenderer.resize() presents a blank 1×1 frame.
  entry.canvas.style.display = visible ? 'block' : 'none';
  entry.canvas.style.pointerEvents = visible ? 'auto' : 'none';
}

/** @internal */
export function isMviewVolume3DRenderMode(
  mode: unknown
): mode is MviewVolume3DRenderMode {
  return typeof mode === 'string' && MVIEW_RENDER_MODES.has(mode);
}

/**
 * Current mview raymarch mode for a mview present, if any.
 *
 * @internal
 */
export function getMviewVolume3DRenderMode(
  viewportId: string
): MviewVolume3DRenderMode | undefined {
  const entry = entries.get(viewportId);

  if (!entry) {
    return undefined;
  }

  const mode = (
    entry.renderer as VolumeRenderer & {
      settings?: { mode?: string };
    }
  ).settings?.mode;

  return isMviewVolume3DRenderMode(mode) ? mode : 'surface';
}

/**
 * Set mview raymarch mode (surface / composite / mip).
 * Surface gets a default threshold of 0.35 (35%).
 * Returns false when this viewport is not a mview Volume3D.
 *
 * @internal
 */
export function setMviewVolume3DRenderMode(
  viewportId: string,
  mode: MviewVolume3DRenderMode
): boolean {
  const entry = entries.get(viewportId);

  if (!entry || !isMviewVolume3DRenderMode(mode)) {
    return false;
  }

  if (mode === 'surface') {
    entry.renderer.setSettings({
      mode,
      // Surface-only default; composite/MIP leave threshold unchanged.
      threshold: 0.35,
    });
  } else {
    entry.renderer.setSettings({ mode });
  }

  return true;
}

/** @internal */
export function isMviewVolume3DProjection(
  projection: unknown
): projection is MviewVolume3DProjection {
  return typeof projection === 'string' && MVIEW_PROJECTIONS.has(projection);
}

/**
 * Current mview projection for a mview present, if any.
 *
 * @internal
 */
export function getMviewVolume3DProjection(
  viewportId: string
): MviewVolume3DProjection | undefined {
  const entry = entries.get(viewportId);

  if (!entry) {
    return undefined;
  }

  const projection = entry.renderer.getCamera()?.projection;
  return isMviewVolume3DProjection(projection) ? projection : 'orthographic';
}

/**
 * Set mview projection (perspective / orthographic).
 * Switching to orthographic resets to a safe half-height when needed.
 *
 * @internal
 */
export function setMviewVolume3DProjection(
  viewportId: string,
  projection: MviewVolume3DProjection
): boolean {
  const entry = entries.get(viewportId);

  if (!entry || !isMviewVolume3DProjection(projection)) {
    return false;
  }

  if (projection === 'orthographic') {
    entry.renderer.setCamera({
      projection: 'orthographic',
      zoom: MVIEW_ORTHO_DEFAULT_HALF_HEIGHT,
    });
  } else {
    entry.renderer.setCamera({
      projection: 'perspective',
      zoom: 1.55,
    });
  }

  return true;
}

/**
 * Current mview threshold [0,1] for a mview present, if any.
 *
 * @internal
 */
export function getMviewVolume3DThreshold(
  viewportId: string
): number | undefined {
  const entry = entries.get(viewportId);

  if (!entry) {
    return undefined;
  }

  const threshold = (
    entry.renderer as VolumeRenderer & {
      settings?: { threshold?: number };
    }
  ).settings?.threshold;

  return typeof threshold === 'number' && Number.isFinite(threshold)
    ? threshold
    : undefined;
}

/**
 * Set mview surface/MIP threshold (normalized [0,1]).
 *
 * @internal
 */
export function setMviewVolume3DThreshold(
  viewportId: string,
  threshold: number
): boolean {
  const entry = entries.get(viewportId);

  if (!entry || !Number.isFinite(threshold)) {
    return false;
  }

  entry.renderer.setSettings({
    threshold: Math.max(0, Math.min(1, threshold)),
  });
  return true;
}

/** @internal */
export function isMviewVolume3DPresentQuality(
  quality: unknown
): quality is MviewVolume3DPresentQuality {
  return typeof quality === 'number' && Number.isFinite(quality);
}

/**
 * Current present-quality blend for a mview present (0 = mview, 1 = OHIF).
 *
 * @internal
 */
export function getMviewVolume3DPresentQuality(
  viewportId: string
): MviewVolume3DPresentQuality | undefined {
  const entry = entries.get(viewportId);

  if (!entry) {
    return undefined;
  }

  return isMviewVolume3DPresentQuality(entry.presentQuality)
    ? Math.min(1, Math.max(0, entry.presentQuality))
    : MVIEW_DEFAULT_PRESENT_QUALITY;
}

/**
 * Configured drag FPS target (slider value). Always >= 1; use
 * getMviewVolume3DTargetFpsEnabled for on/off.
 *
 * @internal
 */
export function getMviewVolume3DTargetFps(
  viewportId: string
): number | undefined {
  const entry = entries.get(viewportId);

  if (!entry) {
    return undefined;
  }

  const fps = Number(entry.targetFps);
  return Number.isFinite(fps) && fps > 0
    ? Math.min(240, Math.max(1, Math.round(fps)))
    : MVIEW_DEFAULT_TARGET_FPS;
}

/**
 * Whether end-of-drag FPS targeting is on. Default true.
 *
 * @internal
 */
export function getMviewVolume3DTargetFpsEnabled(
  viewportId: string
): boolean | undefined {
  const entry = entries.get(viewportId);

  if (!entry) {
    return undefined;
  }

  if (entry.targetFpsEnabled === false) {
    return false;
  }
  if (entry.targetFpsEnabled === true) {
    return true;
  }
  // Legacy: targetFps 0 meant off.
  return Number(entry.targetFps) !== 0;
}

function applyMviewVolume3DTargetFps(viewportId: string): void {
  const entry = entries.get(viewportId);

  if (!entry) {
    return;
  }

  const enabled = getMviewVolume3DTargetFpsEnabled(viewportId) !== false;
  const target =
    getMviewVolume3DTargetFps(viewportId) ?? MVIEW_DEFAULT_TARGET_FPS;
  entry.renderer.setTargetFps(enabled ? target : 0);
}

/**
 * Set the drag FPS target (slider). Does not turn the feature off.
 *
 * @internal
 */
export function setMviewVolume3DTargetFps(
  viewportId: string,
  fps: number
): boolean {
  const entry = entries.get(viewportId);

  if (!entry || !Number.isFinite(fps) || fps <= 0) {
    return false;
  }

  entry.targetFps = Math.min(240, Math.max(1, Math.round(fps)));
  applyMviewVolume3DTargetFps(viewportId);
  return true;
}

/**
 * Turn end-of-drag FPS targeting on or off. Off restores Resolution ceilings.
 *
 * @internal
 */
export function setMviewVolume3DTargetFpsEnabled(
  viewportId: string,
  enabled: boolean
): boolean {
  const entry = entries.get(viewportId);

  if (!entry) {
    return false;
  }

  entry.targetFpsEnabled = Boolean(enabled);
  applyMviewVolume3DTargetFps(viewportId);
  setMviewVolume3DPresentQuality(
    viewportId,
    entry.presentQuality ?? MVIEW_DEFAULT_PRESENT_QUALITY
  );

  return true;
}

/** Stock mview ray budgets (VolumeRenderer defaults). */
const MVIEW_STILL_STEPS = 224;
const MVIEW_STILL_PIXEL_BUDGET = 2_400_000;
const MVIEW_STILL_MINIMUM_SCALE = 0.52;
const MVIEW_STILL_MAXIMUM_SCALE = 1;
/** Full-res still present budget (webgpuVolume3d settle). */
const OHIF_PIXEL_BUDGET = 64_000_000;
const OHIF_STILL_MINIMUM_SCALE = 1;
const OHIF_STILL_MAXIMUM_SCALE = 1;
/**
 * webgpuVolume3d drag: initialInteractionScale 4 → half-res per axis,
 * plus TrackballRotateTool rotateSampleDistanceFactor 2 → half the samples.
 */
const OHIF_INTERACTIVE_SCALE = 0.5;
/** Floor for Target FPS steering (full-res ceiling when targeting is on). */
const OHIF_INTERACTIVE_MINIMUM_SCALE = 0.2;
const OHIF_INTERACTIVE_SAMPLE_FACTOR = 2;
/** WGSL raymarch loops are hard-capped at this (see shaders.js). */
const MVIEW_MAX_RAY_STEPS = 4000;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function logLerp(a: number, b: number, t: number): number {
  return Math.exp(lerp(Math.log(a), Math.log(b), t));
}

/**
 * Approximate OHIF createVolumeMapper samples along the volume diagonal:
 * sampleDistance = (sx+sy+sz)/6, max 4000 — clamped to shader hard cap.
 */
function ohifLikeStillSteps(renderer: VolumeRenderer): number {
  const volume = (
    renderer as VolumeRenderer & {
      volume?: {
        dimensions?: number[];
        spacing?: number[];
      };
    }
  ).volume;
  const dimensions = volume?.dimensions;
  const spacing = volume?.spacing;

  if (!dimensions || dimensions.length < 3 || !spacing || spacing.length < 3) {
    // Pre-upload fallback; re-applied after setVolume with real dims.
    return 1024;
  }

  const sx = Number(spacing[0]) || 1;
  const sy = Number(spacing[1]) || 1;
  const sz = Number(spacing[2]) || 1;
  const dx = (Number(dimensions[0]) || 1) * sx;
  const dy = (Number(dimensions[1]) || 1) * sy;
  const dz = (Number(dimensions[2]) || 1) * sz;
  const diagonal = Math.hypot(dx, dy, dz);
  const sampleDistance = (sx + sy + sz) / 6;
  const steps = Math.ceil(diagonal / Math.max(sampleDistance, 1e-6));

  return Math.min(MVIEW_MAX_RAY_STEPS, Math.max(16, steps));
}

/**
 * Quality profiles for still / interactive presents.
 * Target FPS off: Resolution slider blends still and forces half-res drag.
 * Target FPS on: Resolution does not apply — full-res ceilings; end-of-drag
 * budget alone lowers interactive quality (still settles at full OHIF density).
 *
 * @internal
 */
export function setMviewVolume3DPresentQuality(
  viewportId: string,
  quality: MviewVolume3DPresentQuality
): boolean {
  const entry = entries.get(viewportId);

  if (!entry || !isMviewVolume3DPresentQuality(quality)) {
    return false;
  }

  const t = Math.min(1, Math.max(0, quality));
  entry.presentQuality = t;

  const ohifSteps = ohifLikeStillSteps(entry.renderer);
  const targeting = getMviewVolume3DTargetFpsEnabled(viewportId) !== false;

  if (targeting) {
    entry.renderer.setQualityProfiles({
      interactive: {
        pixelBudget: OHIF_PIXEL_BUDGET,
        minimumScale: OHIF_INTERACTIVE_MINIMUM_SCALE,
        maximumScale: OHIF_STILL_MAXIMUM_SCALE,
        steps: ohifSteps,
      },
      still: {
        pixelBudget: OHIF_PIXEL_BUDGET,
        minimumScale: OHIF_STILL_MINIMUM_SCALE,
        maximumScale: OHIF_STILL_MAXIMUM_SCALE,
        steps: ohifSteps,
      },
    });
    return true;
  }

  const stillSteps = Math.round(lerp(MVIEW_STILL_STEPS, ohifSteps, t));
  entry.renderer.setQualityProfiles({
    interactive: {
      pixelBudget: OHIF_PIXEL_BUDGET,
      minimumScale: OHIF_INTERACTIVE_SCALE,
      maximumScale: OHIF_INTERACTIVE_SCALE,
      steps: Math.max(
        16,
        Math.round(stillSteps / OHIF_INTERACTIVE_SAMPLE_FACTOR)
      ),
    },
    still: {
      pixelBudget: Math.round(
        logLerp(MVIEW_STILL_PIXEL_BUDGET, OHIF_PIXEL_BUDGET, t)
      ),
      minimumScale: lerp(
        MVIEW_STILL_MINIMUM_SCALE,
        OHIF_STILL_MINIMUM_SCALE,
        t
      ),
      maximumScale: lerp(
        MVIEW_STILL_MAXIMUM_SCALE,
        OHIF_STILL_MAXIMUM_SCALE,
        t
      ),
      steps: stillSteps,
    },
  });

  return true;
}

export type MviewVolume3DQualityProfileSnapshot = {
  pixelBudget: number;
  minimumScale: number;
  maximumScale: number;
  steps: number;
};

export type MviewVolume3DPresentQualityProfiles = {
  still: MviewVolume3DQualityProfileSnapshot;
  interactive: MviewVolume3DQualityProfileSnapshot;
};

/**
 * Applied still/interactive quality profiles for the Resolution slider readout.
 *
 * @internal
 */
export function getMviewVolume3DPresentQualityProfiles(
  viewportId: string
): MviewVolume3DPresentQualityProfiles | undefined {
  const entry = entries.get(viewportId);

  if (!entry) {
    return undefined;
  }

  const quality = (
    entry.renderer as VolumeRenderer & {
      quality?: {
        still?: Partial<MviewVolume3DQualityProfileSnapshot>;
        interactive?: Partial<MviewVolume3DQualityProfileSnapshot>;
      };
    }
  ).quality;

  const still = quality?.still;
  const interactive = quality?.interactive;

  if (!still || !interactive) {
    return undefined;
  }

  return {
    still: {
      pixelBudget: Number(still.pixelBudget) || 0,
      minimumScale: Number(still.minimumScale) || 0,
      maximumScale: Number(still.maximumScale) || 1,
      steps: Number(still.steps) || 0,
    },
    interactive: {
      pixelBudget: Number(interactive.pixelBudget) || 0,
      minimumScale: Number(interactive.minimumScale) || 0,
      maximumScale: Number(interactive.maximumScale) || 1,
      steps: Number(interactive.steps) || 0,
    },
  };
}

/**
 * Apply a Cornerstone VIEWPORT_PRESET to a mview present (composite TF).
 * If scalars are not uploaded yet, stashes the preset and returns true so OHIF
 * does not fall through to the VTK actor path.
 *
 * @internal
 */
export function applyMviewVolume3DPreset(
  viewportId: string,
  preset: ViewportPreset
): boolean {
  const entry = entries.get(viewportId);

  if (!entry) {
    return false;
  }

  if (!entry.valueRange) {
    entry.pendingPreset = preset;
    return true;
  }

  const appearance = viewportPresetToMviewAppearance(preset, entry.valueRange);

  if (!appearance) {
    entry.pendingPreset = preset;
    return true;
  }

  entry.pendingPreset = undefined;
  entry.renderer.setTransferFunction(appearance.points);
  entry.renderer.setSettings({
    mode: 'composite',
    opacity: 1,
    shade: appearance.shade,
    threshold: appearance.threshold,
  });
  return true;
}

/**
 * Apply a stashed preset after volume upload when valueRange is known.
 *
 * @internal
 */
export function flushMviewVolume3DPendingPreset(viewportId: string): boolean {
  const entry = entries.get(viewportId);

  if (!entry?.pendingPreset || !entry.valueRange) {
    return false;
  }

  return applyMviewVolume3DPreset(viewportId, entry.pendingPreset);
}
