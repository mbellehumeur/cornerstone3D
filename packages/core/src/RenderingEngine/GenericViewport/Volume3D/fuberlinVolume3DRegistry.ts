import type { VolumeRenderer } from '@mview/webgpu-volume-standalone';
import type { ViewportPreset } from '../../../types';
import { viewportPresetToFuberlinAppearance } from './fuberlinViewportPreset';
import { FUBERLIN_ORTHO_DEFAULT_HALF_HEIGHT } from './fuberlinVolume3DCamera';

/** Mview VolumeRenderer raymarch modes (surface / composite / mip). */
export type FuberlinVolume3DRenderMode = 'surface' | 'composite' | 'mip';

/** Mview camera projection (orthographic default for OHIF Volume3D parity). */
export type FuberlinVolume3DProjection = 'perspective' | 'orthographic';

const FUBERLIN_RENDER_MODES: ReadonlySet<string> = new Set([
  'surface',
  'composite',
  'mip',
]);

const FUBERLIN_PROJECTIONS: ReadonlySet<string> = new Set([
  'perspective',
  'orthographic',
]);

export type FuberlinVolume3DEntry = {
  canvas: HTMLCanvasElement;
  renderer: VolumeRenderer;
  /** parallelScale at fit (for zoom bridge / getZoom baseline) */
  baselineParallelScale?: number;
  /** max(dims×spacing) — mview box normalization divisor */
  volumePhysicalMax?: number;
  /** Volume center in world/LPS for pan bridge */
  volumeCenter?: [number, number, number];
  /** Volume scalar range used to normalize VIEWPORT_PRESET HU curves. */
  valueRange?: [number, number];
  /** Preset applied before scalars were ready; flushed after upload. */
  pendingPreset?: ViewportPreset;
};

const entries = new Map<string, FuberlinVolume3DEntry>();

/** @internal */
export function registerFuberlinVolume3D(
  viewportId: string,
  entry: FuberlinVolume3DEntry
): void {
  const existing = entries.get(viewportId);
  entries.set(viewportId, {
    ...existing,
    ...entry,
    valueRange: entry.valueRange ?? existing?.valueRange,
    pendingPreset: entry.pendingPreset ?? existing?.pendingPreset,
    volumePhysicalMax: entry.volumePhysicalMax ?? existing?.volumePhysicalMax,
    volumeCenter: entry.volumeCenter ?? existing?.volumeCenter,
    baselineParallelScale:
      entry.baselineParallelScale ?? existing?.baselineParallelScale,
  });
}

/** @internal */
export function unregisterFuberlinVolume3D(viewportId: string): void {
  entries.delete(viewportId);
}

/** @internal */
export function getFuberlinVolume3D(
  viewportId: string
): FuberlinVolume3DEntry | undefined {
  return entries.get(viewportId);
}

/** @internal */
export function setFuberlinVolume3DValueRange(
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
export function beginFuberlinVolume3DInteraction(viewportId: string): boolean {
  const entry = entries.get(viewportId);

  if (!entry) {
    return false;
  }

  entry.renderer.beginInteraction();
  return true;
}

/** @internal */
export function endFuberlinVolume3DInteraction(viewportId: string): boolean {
  const entry = entries.get(viewportId);

  if (!entry) {
    return false;
  }

  entry.renderer.endInteraction();
  return true;
}

/**
 * Drive mview trackball rotation for a fuberlin present.
 * Returns false when this viewport is not a fuberlin Volume3D.
 *
 * @internal
 */
export function rotateFuberlinVolume3D(
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
export function setFuberlinVolume3DCanvasVisible(
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
export function isFuberlinVolume3DRenderMode(
  mode: unknown
): mode is FuberlinVolume3DRenderMode {
  return typeof mode === 'string' && FUBERLIN_RENDER_MODES.has(mode);
}

/**
 * Current mview raymarch mode for a fuberlin present, if any.
 *
 * @internal
 */
export function getFuberlinVolume3DRenderMode(
  viewportId: string
): FuberlinVolume3DRenderMode | undefined {
  const entry = entries.get(viewportId);

  if (!entry) {
    return undefined;
  }

  const mode = (
    entry.renderer as VolumeRenderer & {
      settings?: { mode?: string };
    }
  ).settings?.mode;

  return isFuberlinVolume3DRenderMode(mode) ? mode : 'surface';
}

/**
 * Set mview raymarch mode (surface / composite / mip).
 * Returns false when this viewport is not a fuberlin Volume3D.
 *
 * @internal
 */
export function setFuberlinVolume3DRenderMode(
  viewportId: string,
  mode: FuberlinVolume3DRenderMode
): boolean {
  const entry = entries.get(viewportId);

  if (!entry || !isFuberlinVolume3DRenderMode(mode)) {
    return false;
  }

  entry.renderer.setSettings({ mode });
  return true;
}

/** @internal */
export function isFuberlinVolume3DProjection(
  projection: unknown
): projection is FuberlinVolume3DProjection {
  return typeof projection === 'string' && FUBERLIN_PROJECTIONS.has(projection);
}

/**
 * Current mview projection for a fuberlin present, if any.
 *
 * @internal
 */
export function getFuberlinVolume3DProjection(
  viewportId: string
): FuberlinVolume3DProjection | undefined {
  const entry = entries.get(viewportId);

  if (!entry) {
    return undefined;
  }

  const projection = entry.renderer.getCamera()?.projection;
  return isFuberlinVolume3DProjection(projection) ? projection : 'orthographic';
}

/**
 * Set mview projection (perspective / orthographic).
 * Switching to orthographic resets to a safe half-height when needed.
 *
 * @internal
 */
export function setFuberlinVolume3DProjection(
  viewportId: string,
  projection: FuberlinVolume3DProjection
): boolean {
  const entry = entries.get(viewportId);

  if (!entry || !isFuberlinVolume3DProjection(projection)) {
    return false;
  }

  if (projection === 'orthographic') {
    entry.renderer.setCamera({
      projection: 'orthographic',
      zoom: FUBERLIN_ORTHO_DEFAULT_HALF_HEIGHT,
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
 * Current mview threshold [0,1] for a fuberlin present, if any.
 *
 * @internal
 */
export function getFuberlinVolume3DThreshold(
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
export function setFuberlinVolume3DThreshold(
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

/**
 * Apply a Cornerstone VIEWPORT_PRESET to a fuberlin present (composite TF).
 * If scalars are not uploaded yet, stashes the preset and returns true so OHIF
 * does not fall through to the VTK actor path.
 *
 * @internal
 */
export function applyFuberlinVolume3DPreset(
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

  const appearance = viewportPresetToFuberlinAppearance(
    preset,
    entry.valueRange
  );

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
export function flushFuberlinVolume3DPendingPreset(
  viewportId: string
): boolean {
  const entry = entries.get(viewportId);

  if (!entry?.pendingPreset || !entry.valueRange) {
    return false;
  }

  return applyFuberlinVolume3DPreset(viewportId, entry.pendingPreset);
}
