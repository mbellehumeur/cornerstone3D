import {
  getVolume3DProjectionSnapshot,
  volume3DProjectionAdapter,
} from './volume3DProjectionAdapter';

export { DefaultVolume3DDataProvider } from './DefaultVolume3DDataProvider';
export {
  createDefaultVolume3DRenderPaths,
  createVolume3DRenderPathResolver,
} from './Volume3DRenderPathResolver';
export { WEBGPU_VOLUME_3D_RENDER_MODE } from './WebGPUVolume3DRenderPath';
export { MVIEW_VOLUME_3D_RENDER_MODE } from './MviewVolume3DRenderPath';
export { SLICERLIVE_VOLUME_3D_RENDER_MODE } from './SlicerLiveVolume3DRenderPath';
export {
  applyMviewVolume3DPreset,
  beginMviewVolume3DInteraction,
  endMviewVolume3DInteraction,
  flushMviewVolume3DPendingPreset,
  reapplyMviewVolume3DPreset,
  MVIEW_DEFAULT_PRESENT_QUALITY,
  MVIEW_DEFAULT_TARGET_FPS,
  MVIEW_DEFAULT_MIN_BUDGET_PX,
  MVIEW_MIN_BUDGET_PX_FLOOR,
  MVIEW_MIN_BUDGET_PX_CEILING,
  getMviewVolume3D,
  getMviewVolume3DPresentQuality,
  getMviewVolume3DPresentQualityProfiles,
  getMviewVolume3DProjection,
  getMviewVolume3DRenderMode,
  getMviewVolume3DTargetFps,
  getMviewVolume3DTargetFpsEnabled,
  getMviewVolume3DMinBudgetPx,
  getMviewVolume3DThreshold,
  isMviewVolume3DPresentQuality,
  isMviewVolume3DProjection,
  isMviewVolume3DRenderMode,
  rotateMviewVolume3D,
  setMviewVolume3DPresentQuality,
  setMviewVolume3DProjection,
  setMviewVolume3DRenderMode,
  setMviewVolume3DTargetFps,
  setMviewVolume3DTargetFpsEnabled,
  setMviewVolume3DMinBudgetPx,
  setMviewVolume3DThreshold,
  setMviewVolume3DValueRange,
} from './mviewVolume3DRegistry';
export type {
  MviewVolume3DPresentQuality,
  MviewVolume3DPresentQualityProfiles,
  MviewVolume3DProjection,
  MviewVolume3DQualityProfileSnapshot,
  MviewVolume3DRenderMode,
} from './mviewVolume3DRegistry';
export { viewportPresetToMviewAppearance } from './mviewViewportPreset';
export type { MviewPresetAppearance } from './mviewViewportPreset';
export {
  applySlicerLiveVolume3DPreset,
  beginSlicerLiveVolume3DInteraction,
  endSlicerLiveVolume3DInteraction,
  flushSlicerLiveVolume3DPendingPreset,
  getSlicerLiveVolume3D,
  getSlicerLiveVolume3DAccumulate,
  getSlicerLiveVolume3DAutoSampleStep,
  getSlicerLiveVolume3DClim,
  getSlicerLiveVolume3DCropEnabled,
  getSlicerLiveVolume3DInteractionQuality,
  getSlicerLiveVolume3DLighting,
  getSlicerLiveVolume3DMotionBudget,
  getSlicerLiveVolume3DProjection,
  getSlicerLiveVolume3DSampleStep,
  getSlicerLiveVolume3DSettleSamples,
  getSlicerLiveVolume3DShade,
  getSlicerLiveVolume3DShadeCoeffs,
  getSlicerLiveVolume3DTargetMs,
  getSlicerLiveVolume3DVolumeOpacity,
  isSlicerLiveVolume3DProjection,
  setSlicerLiveVolume3DAccumulate,
  setSlicerLiveVolume3DClim,
  setSlicerLiveVolume3DCropEnabled,
  setSlicerLiveVolume3DInteractionQuality,
  setSlicerLiveVolume3DLighting,
  setSlicerLiveVolume3DMotionBudget,
  setSlicerLiveVolume3DProjection,
  setSlicerLiveVolume3DSampleStep,
  setSlicerLiveVolume3DSettleSamples,
  setSlicerLiveVolume3DShade,
  setSlicerLiveVolume3DShadeCoeffs,
  setSlicerLiveVolume3DTargetMs,
  setSlicerLiveVolume3DValueRange,
  setSlicerLiveVolume3DVolumeOpacity,
  setSlicerLiveVolume3DSegmentation,
  setSlicerLiveVolume3DSegmentAppearance,
  beginSlicerLiveVolume3DSegmentation,
  updateSlicerLiveVolume3DSegmentationSlices,
  finalizeSlicerLiveVolume3DSegmentation,
  clearSlicerLiveVolume3DSegmentation,
} from './slicerLiveVolume3DRegistry';
export type {
  SlicerLiveVolume3DLighting,
  SlicerLiveVolume3DProjection,
} from './slicerLiveVolume3DRegistry';
export { viewportPresetToSlicerLiveAppearance } from './slicerLiveViewportPreset';
export type { SlicerLivePresetAppearance } from './slicerLiveViewportPreset';
export {
  armVolume3DInteraction,
  ensureVolume3DInteractionStarted,
} from './volume3DInteraction';
/**
 * Lower-level 3D projection helpers for custom synchronizers and tooling.
 * This namespace is less stable than the core viewport API while the generic
 * projection service settles.
 *
 * @experimental Advanced helper namespace; prefer `viewportProjection` for
 * stable application-level presentation reads and writes.
 */
export const volume3DProjection = {
  adapter: volume3DProjectionAdapter,
  getSnapshot: getVolume3DProjectionSnapshot,
};
export type {
  Volume3DProjectionPresentation,
  Volume3DProjectionRequest,
  Volume3DProjectionSnapshot,
} from './volume3DProjectionAdapter';
export { default } from './viewport3D';
export type {
  Volume3DCamera,
  Volume3DDataPresentation,
  Volume3DPresentationProps,
  Volume3DProperties,
  Volume3DRenderMode,
  Volume3DRequestedRenderMode,
  Volume3DSetDataOptions,
  VolumeViewport3DInput,
} from './viewport3DTypes';
