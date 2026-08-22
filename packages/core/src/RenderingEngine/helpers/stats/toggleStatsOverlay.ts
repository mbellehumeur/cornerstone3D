import { StatsOverlay } from './index';
import {
  refreshMviewVolume3DVisibleRoiStats,
  setMviewVolume3DStatsOverlayEnabled,
} from '../../GenericViewport/Volume3D/mviewVolume3DRegistry';

/**
 * Whether the cornerstone stats/debug overlay is currently visible.
 */
export function isStatsOverlayVisible(): boolean {
  return StatsOverlay.dom != null;
}

/**
 * Toggles the stats overlay (FPS / MS / MB + render-mode bindings panel).
 * @returns the new visibility state
 */
export function toggleStatsOverlay(): boolean {
  if (isStatsOverlayVisible()) {
    StatsOverlay.cleanup();
    setMviewVolume3DStatsOverlayEnabled(false);
    return false;
  }

  StatsOverlay.setup();
  setMviewVolume3DStatsOverlayEnabled(true);
  refreshMviewVolume3DVisibleRoiStats();
  return true;
}

/**
 * Shows or hides the stats overlay.
 * @returns the resulting visibility state
 */
export function setStatsOverlayEnabled(enabled: boolean): boolean {
  if (enabled) {
    if (!isStatsOverlayVisible()) {
      StatsOverlay.setup();
    }
    setMviewVolume3DStatsOverlayEnabled(true);
    refreshMviewVolume3DVisibleRoiStats();
    return true;
  }

  if (isStatsOverlayVisible()) {
    StatsOverlay.cleanup();
  }
  setMviewVolume3DStatsOverlayEnabled(false);
  return false;
}
