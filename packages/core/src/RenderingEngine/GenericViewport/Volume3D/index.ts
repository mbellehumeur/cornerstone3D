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
export { FUBERLIN_VOLUME_3D_RENDER_MODE } from './FuberlinVolume3DRenderPath';
export {
  beginFuberlinVolume3DInteraction,
  endFuberlinVolume3DInteraction,
  getFuberlinVolume3D,
  getFuberlinVolume3DRenderMode,
  isFuberlinVolume3DRenderMode,
  rotateFuberlinVolume3D,
  setFuberlinVolume3DRenderMode,
} from './fuberlinVolume3DRegistry';
export type { FuberlinVolume3DRenderMode } from './fuberlinVolume3DRegistry';
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
