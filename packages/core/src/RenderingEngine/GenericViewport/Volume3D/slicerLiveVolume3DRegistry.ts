import type { SlicerLiveVolumeRenderer } from '@slicerlive/webgpu-render';
import type { ViewportPreset } from '../../../types';
import { viewportPresetToSlicerLiveAppearance } from './slicerLiveViewportPreset';

export type SlicerLiveVolume3DEntry = {
  canvas: HTMLCanvasElement;
  renderer: SlicerLiveVolumeRenderer;
  baselineParallelScale?: number;
  volumePhysicalMax?: number;
  volumeCenter?: [number, number, number];
  valueRange?: [number, number];
  pendingPreset?: ViewportPreset;
};

const entries = new Map<string, SlicerLiveVolume3DEntry>();

/** @internal */
export function registerSlicerLiveVolume3D(
  viewportId: string,
  entry: SlicerLiveVolume3DEntry
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
export function unregisterSlicerLiveVolume3D(viewportId: string): void {
  entries.delete(viewportId);
}

/** @internal */
export function getSlicerLiveVolume3D(
  viewportId: string
): SlicerLiveVolume3DEntry | undefined {
  return entries.get(viewportId);
}

/** @internal */
export function setSlicerLiveVolume3DValueRange(
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
export function beginSlicerLiveVolume3DInteraction(
  viewportId: string
): boolean {
  const entry = entries.get(viewportId);
  if (!entry) {
    return false;
  }
  entry.renderer.beginInteraction();
  return true;
}

/** @internal */
export function endSlicerLiveVolume3DInteraction(viewportId: string): boolean {
  const entry = entries.get(viewportId);
  if (!entry) {
    return false;
  }
  entry.renderer.endInteraction();
  return true;
}

/** @internal */
export function setSlicerLiveVolume3DCanvasVisible(
  viewportId: string,
  visible: boolean
): void {
  const entry = entries.get(viewportId);
  if (!entry) {
    return;
  }
  entry.canvas.style.display = visible ? 'block' : 'none';
  entry.canvas.style.pointerEvents = visible ? 'auto' : 'none';
}

/** @internal */
export function applySlicerLiveVolume3DPreset(
  viewportId: string,
  preset: ViewportPreset
): boolean {
  const entry = entries.get(viewportId);
  if (!entry) {
    return false;
  }

  // Stash until scalars exist so OHIF does not fall through to VTK actor path.
  if (!entry.valueRange) {
    entry.pendingPreset = preset;
    return true;
  }

  const appearance = viewportPresetToSlicerLiveAppearance(preset);
  if (!appearance) {
    entry.pendingPreset = preset;
    return true;
  }

  entry.pendingPreset = undefined;
  entry.renderer.setTransferFunctions(appearance);
  return true;
}

/** @internal */
export function flushSlicerLiveVolume3DPendingPreset(
  viewportId: string
): boolean {
  const entry = entries.get(viewportId);
  if (!entry?.pendingPreset || !entry.valueRange) {
    return false;
  }
  return applySlicerLiveVolume3DPreset(viewportId, entry.pendingPreset);
}

export type SlicerLiveVolume3DProjection = 'orthographic' | 'perspective';

const SLICERLIVE_PROJECTIONS: ReadonlySet<string> = new Set([
  'orthographic',
  'perspective',
]);

export type SlicerLiveVolume3DLighting = {
  ambient?: number;
  diffuse?: number;
  specular?: number;
};

/** @internal */
export function isSlicerLiveVolume3DProjection(
  value: unknown
): value is SlicerLiveVolume3DProjection {
  return typeof value === 'string' && SLICERLIVE_PROJECTIONS.has(value);
}

/** @internal */
export function getSlicerLiveVolume3DProjection(
  viewportId: string
): SlicerLiveVolume3DProjection | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getParallelProjection()
    ? 'orthographic'
    : 'perspective';
}

/** @internal */
export function setSlicerLiveVolume3DProjection(
  viewportId: string,
  projection: SlicerLiveVolume3DProjection
): boolean {
  const entry = entries.get(viewportId);
  if (!entry || !isSlicerLiveVolume3DProjection(projection)) {
    return false;
  }
  const parallel = projection === 'orthographic';
  entry.renderer.setParallelProjection(parallel);
  return true;
}

/** @internal */
export function getSlicerLiveVolume3DShade(
  viewportId: string
): boolean | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getShade();
}

/** @internal */
export function setSlicerLiveVolume3DShade(
  viewportId: string,
  shade: boolean
): boolean {
  const entry = entries.get(viewportId);
  if (!entry) {
    return false;
  }
  entry.renderer.setShade(Boolean(shade));
  return true;
}

/** @internal */
export function getSlicerLiveVolume3DLighting(
  viewportId: string
): { ambient: number; diffuse: number; specular: number } | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  const [ambient, diffuse, specular] = entry.renderer.getShadeCoeffs();
  return { ambient, diffuse, specular };
}

/** @internal */
export function setSlicerLiveVolume3DLighting(
  viewportId: string,
  lighting: SlicerLiveVolume3DLighting
): boolean {
  const entry = entries.get(viewportId);
  if (!entry) {
    return false;
  }
  const current = entry.renderer.getShadeCoeffs();
  const next: [number, number, number, number] = [
    Number.isFinite(lighting.ambient) ? Number(lighting.ambient) : current[0],
    Number.isFinite(lighting.diffuse) ? Number(lighting.diffuse) : current[1],
    Number.isFinite(lighting.specular) ? Number(lighting.specular) : current[2],
    current[3],
  ];
  entry.renderer.setShadeCoeffs(next);
  return true;
}

/** @internal */
export function getSlicerLiveVolume3DInteractionQuality(
  viewportId: string
): number | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getInteractionQuality();
}

/** @internal */
export function setSlicerLiveVolume3DInteractionQuality(
  viewportId: string,
  quality: number
): boolean {
  const entry = entries.get(viewportId);
  if (!entry || !Number.isFinite(quality)) {
    return false;
  }
  entry.renderer.setInteractionQuality(quality);
  return true;
}

/** @internal */
export function getSlicerLiveVolume3DTargetMs(
  viewportId: string
): number | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getTargetMs();
}

/** @internal */
export function setSlicerLiveVolume3DTargetMs(
  viewportId: string,
  targetMs: number
): boolean {
  const entry = entries.get(viewportId);
  if (!entry || !Number.isFinite(targetMs) || targetMs <= 0) {
    return false;
  }
  entry.renderer.setTargetMs(targetMs);
  return true;
}

/** @internal — 0..1 motion budget (aliases interaction quality). */
export function getSlicerLiveVolume3DMotionBudget(
  viewportId: string
): number | undefined {
  return getSlicerLiveVolume3DInteractionQuality(viewportId);
}

/** @internal */
export function setSlicerLiveVolume3DMotionBudget(
  viewportId: string,
  budget: number
): boolean {
  return setSlicerLiveVolume3DInteractionQuality(viewportId, budget);
}

/** @internal */
export function getSlicerLiveVolume3DSampleStep(
  viewportId: string
): number | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getSampleStep();
}

/** @internal */
export function getSlicerLiveVolume3DAutoSampleStep(
  viewportId: string
): number | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getAutoSampleStep();
}

/** @internal */
export function setSlicerLiveVolume3DSampleStep(
  viewportId: string,
  stepMm: number
): boolean {
  const entry = entries.get(viewportId);
  if (!entry || !Number.isFinite(stepMm) || stepMm <= 0) {
    return false;
  }
  entry.renderer.setSampleStep(stepMm);
  return true;
}

/** @internal */
export function getSlicerLiveVolume3DAccumulate(
  viewportId: string
): boolean | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getAccumulate();
}

/** @internal */
export function setSlicerLiveVolume3DAccumulate(
  viewportId: string,
  enabled: boolean
): boolean {
  const entry = entries.get(viewportId);
  if (!entry) {
    return false;
  }
  entry.renderer.setAccumulate(Boolean(enabled));
  return true;
}

/** @internal */
export function getSlicerLiveVolume3DSettleSamples(
  viewportId: string
): number | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getSettleSamples();
}

/** @internal */
export function setSlicerLiveVolume3DSettleSamples(
  viewportId: string,
  count: number
): boolean {
  const entry = entries.get(viewportId);
  if (!entry || !Number.isFinite(count)) {
    return false;
  }
  entry.renderer.setSettleSamples(count);
  return true;
}

/** @internal — ImageField shade [ka, kd, ks, shininess]. */
export function getSlicerLiveVolume3DShadeCoeffs(
  viewportId: string
): [number, number, number, number] | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getShadeCoeffs();
}

/** @internal */
export function setSlicerLiveVolume3DShadeCoeffs(
  viewportId: string,
  coeffs: [number, number, number, number]
): boolean {
  const entry = entries.get(viewportId);
  if (!entry || !Array.isArray(coeffs) || coeffs.length < 4) {
    return false;
  }
  const next: [number, number, number, number] = [
    Number(coeffs[0]),
    Number(coeffs[1]),
    Number(coeffs[2]),
    Number(coeffs[3]),
  ];
  if (next.some((v) => !Number.isFinite(v))) {
    return false;
  }
  entry.renderer.setShadeCoeffs(next);
  return true;
}

/** @internal */
export function getSlicerLiveVolume3DClim(
  viewportId: string
): [number, number] | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getClim();
}

/** @internal */
export function setSlicerLiveVolume3DClim(
  viewportId: string,
  clim: [number, number]
): boolean {
  const entry = entries.get(viewportId);
  if (!entry || !Array.isArray(clim) || clim.length < 2) {
    return false;
  }
  entry.renderer.setClim([Number(clim[0]), Number(clim[1])]);
  return true;
}

/** @internal */
export function getSlicerLiveVolume3DCropEnabled(
  viewportId: string
): boolean | undefined {
  const entry = entries.get(viewportId);
  if (!entry) {
    return undefined;
  }
  return entry.renderer.getCropEnabled();
}

/** @internal */
export function setSlicerLiveVolume3DCropEnabled(
  viewportId: string,
  enabled: boolean
): boolean {
  const entry = entries.get(viewportId);
  if (!entry) {
    return false;
  }
  entry.renderer.setCropEnabled(Boolean(enabled));
  return true;
}
