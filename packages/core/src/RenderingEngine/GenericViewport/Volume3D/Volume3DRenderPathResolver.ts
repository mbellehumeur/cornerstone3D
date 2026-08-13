import { DefaultRenderPathResolver } from '../DefaultRenderPathResolver';
import type { RenderPathDefinition } from '../ViewportArchitectureTypes';
import { FuberlinVolume3DPath } from './FuberlinVolume3DRenderPath';
import { MviewVolume3DPath } from './MviewVolume3DRenderPath';
import { SlicerLiveVolume3DPath } from './SlicerLiveVolume3DRenderPath';
import { WebGPUVolume3DPath } from './WebGPUVolume3DRenderPath';
import { VtkGeometry3DPath } from './VtkGeometry3DRenderPath';
import { VtkVolume3DPath } from './VtkVolume3DRenderPath';

export function createDefaultVolume3DRenderPaths(): RenderPathDefinition[] {
  return [
    new VtkVolume3DPath(),
    new WebGPUVolume3DPath(),
    new MviewVolume3DPath(),
    new SlicerLiveVolume3DPath(),
    new FuberlinVolume3DPath(),
    new VtkGeometry3DPath(),
  ];
}

export function createVolume3DRenderPathResolver(
  paths: ReadonlyArray<RenderPathDefinition> = createDefaultVolume3DRenderPaths()
): DefaultRenderPathResolver {
  return new DefaultRenderPathResolver(paths);
}
