import {
  armMviewVolume3DInteraction,
  ensureMviewVolume3DInteraction,
} from './mviewVolume3DRegistry';
import {
  armSlicerLiveVolume3DInteraction,
  ensureSlicerLiveVolume3DInteraction,
} from './slicerLiveVolume3DRegistry';

/** Arm interactive LOD on pointer down without switching profiles yet. */
export function armVolume3DInteraction(viewportId: string): boolean {
  return (
    armMviewVolume3DInteraction(viewportId) ||
    armSlicerLiveVolume3DInteraction(viewportId)
  );
}

/** Start interactive LOD on first drag move after armVolume3DInteraction. */
export function ensureVolume3DInteractionStarted(viewportId: string): boolean {
  if (ensureMviewVolume3DInteraction(viewportId)) {
    return true;
  }
  if (ensureSlicerLiveVolume3DInteraction(viewportId)) {
    return true;
  }
  return false;
}
