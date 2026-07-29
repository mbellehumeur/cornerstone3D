import {
  CONSTANTS,
  Enums,
  utilities as csUtils,
  type Types,
} from '@cornerstonejs/core';
import { getViewportPresentation } from './viewportPresentation';

const { RENDERING_DEFAULTS } = CONSTANTS;

type PresentationSlabViewport = Types.IViewport & {
  getSourceDataId?: () => string | undefined;
  getDisplaySetPresentation?: (
    dataId: string
  ) => { slabThickness?: number; blendMode?: Enums.BlendModes } | undefined;
  setDisplaySetPresentation?: (
    dataId: string,
    presentation: { slabThickness?: number; blendMode?: Enums.BlendModes }
  ) => void;
};

/**
 * Returns the viewport's slab thickness. Native PLANAR_NEXT stores slab on
 * display-set presentation; legacy volume viewports expose getSlabThickness().
 */
export function getSlabThicknessOrDefault(viewport: Types.IViewport): number {
  if (csUtils.isGenericViewport(viewport)) {
    const vp = viewport as PresentationSlabViewport;
    const sourceDataId = vp.getSourceDataId?.();
    const slabThickness = sourceDataId
      ? vp.getDisplaySetPresentation?.(sourceDataId)?.slabThickness
      : undefined;

    if (typeof slabThickness === 'number' && Number.isFinite(slabThickness)) {
      return Math.max(slabThickness, RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS);
    }

    return RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS;
  }
  return (viewport as Types.IVolumeViewport).getSlabThickness();
}

/**
 * Writes slab thickness (and blend mode) for a native PLANAR_NEXT viewport via
 * display-set presentation. No-ops when the viewport has no source binding.
 */
export function setNativeSlabThickness(
  viewport: Types.IViewport,
  slabThickness: number,
  blendMode: Enums.BlendModes
): void {
  if (!csUtils.isGenericViewport(viewport)) {
    return;
  }

  const vp = viewport as PresentationSlabViewport;
  const sourceDataId = vp.getSourceDataId?.();

  if (!sourceDataId || typeof vp.setDisplaySetPresentation !== 'function') {
    return;
  }

  vp.setDisplaySetPresentation(sourceDataId, {
    slabThickness,
    blendMode,
  });
  viewport.render();
}

/**
 * Navigates a native (Generic) viewport to a focal point via its view reference.
 * Native PLANAR_NEXT has no setCamera; navigating by view reference snaps to the
 * nearest slice along the view-plane normal.
 */
export function jumpToFocalPoint(
  viewport: Types.IViewport,
  cameraFocalPoint: Types.Point3
): void {
  if (csUtils.isGenericViewport(viewport)) {
    viewport.setViewReference({ cameraFocalPoint } as Types.ViewReference);
  }
}

export interface NativeSourceProperties {
  /** VOI/LUT properties read via getDisplaySetPresentation. */
  properties: Record<string, unknown>;
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  currentImageId?: string;
}

/**
 * Reads the VOI/LUT properties, rotation/flip presentation and current image id
 * from a native (Generic) source viewport, which exposes none of the legacy
 * getProperties/getViewPresentation/getCamera APIs.
 */
export function getNativeSourceProperties(
  viewport: Types.IViewport
): NativeSourceProperties {
  if (!csUtils.viewportSupportsDisplaySetPresentation(viewport)) {
    return { properties: {} };
  }
  const sourceDataId = viewport.getSourceDataId();
  const properties = {
    ...((sourceDataId
      ? (viewport.getDisplaySetPresentation(sourceDataId) as Record<
          string,
          unknown
        >)
      : {}) ?? {}),
  } as Record<string, unknown>;
  // Generic viewports expose the VOI LUT function as `voiLUTFunction`, but the
  // legacy viewport `setProperties` (used by the Magnify loupes) reads the
  // uppercase `VOILUTFunction`. Bridge the casing so a sigmoid source does not
  // silently render the loupe with a linear LUT.
  const voiLUTFunction = properties.VOILUTFunction ?? properties.voiLUTFunction;
  if (voiLUTFunction !== undefined) {
    properties.VOILUTFunction = voiLUTFunction;
  }
  const presentation = (getViewportPresentation(viewport) ?? {}) as {
    rotation?: number;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
  };
  return {
    properties,
    rotation: presentation.rotation,
    flipHorizontal: presentation.flipHorizontal,
    flipVertical: presentation.flipVertical,
    currentImageId: viewport.getCurrentImageId(),
  };
}
