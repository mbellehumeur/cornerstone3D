import type { FuberlinTransferPoint } from '@mview/webgpu-volume-standalone';
import type { ViewportPreset } from '../../../types';

export type MviewPresetAppearance = {
  points: FuberlinTransferPoint[];
  /** Normalized [0,1] surface/MIP threshold (default 0.35). */
  threshold: number;
  shade: boolean;
};

const DEFAULT_SURFACE_THRESHOLD = 0.35;

/**
 * Convert a Cornerstone VIEWPORT_PRESET (HU color/opacity curves) into mview
 * transfer points in the volume's normalized scalar space, matching the mview
 * demo `ctBoneTransferPointsForRange` logic for any preset.
 */
export function viewportPresetToMviewAppearance(
  preset: ViewportPreset,
  valueRange: [number, number]
): MviewPresetAppearance | undefined {
  const min = Number(valueRange[0]);
  const max = Number(valueRange[1]);
  const width = max - min;

  if (!Number.isFinite(min) || !Number.isFinite(max) || width <= 0) {
    return undefined;
  }

  const colorParts = preset.colorTransfer.split(' ').map(Number).slice(1);
  const opacityParts = preset.scalarOpacity.split(' ').map(Number).slice(1);

  const byHu = new Map<
    number,
    { color: [number, number, number]; alpha: number }
  >();

  for (let i = 0; i + 3 < colorParts.length; i += 4) {
    const hu = colorParts[i];
    byHu.set(hu, {
      color: [colorParts[i + 1], colorParts[i + 2], colorParts[i + 3]],
      alpha: 0,
    });
  }

  for (let i = 0; i + 1 < opacityParts.length; i += 2) {
    const hu = opacityParts[i];
    const alpha = opacityParts[i + 1];
    const existing = byHu.get(hu) || {
      color: [1, 1, 1] as [number, number, number],
      alpha: 0,
    };
    existing.alpha = alpha;
    byHu.set(hu, existing);
  }

  const points: FuberlinTransferPoint[] = [...byHu.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hu, value]) => ({
      x: Math.max(0, Math.min(1, (hu - min) / width)),
      color: value.color,
      alpha: value.alpha,
    }));

  if (!points.length || points[0].x > 0) {
    points.unshift({ x: 0, color: [0, 0, 0], alpha: 0 });
  }

  if (points[points.length - 1].x < 1) {
    const last = points[points.length - 1];
    points.push({ x: 1, color: [...last.color], alpha: last.alpha });
  }

  // Fixed surface/MIP default — do not derive from first non-zero TF opacity
  // (CT-Bone and similar presets land near ~0.29 and override the UI default).
  const threshold = DEFAULT_SURFACE_THRESHOLD;

  return {
    points,
    threshold,
    shade: preset.shade === '1',
  };
}
