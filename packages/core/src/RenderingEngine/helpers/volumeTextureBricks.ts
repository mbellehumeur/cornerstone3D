import { getConfiguration } from '../../init';
import { getRenderingCapabilities } from '../../utilities/renderingCapabilities';

/** Inclusive Z-slice range for one GPU 3D texture brick. */
export interface VolumeTextureBrick {
  /** First full-volume slice index (inclusive). */
  sliceStart: number;
  /** Last full-volume slice index (inclusive). */
  sliceEnd: number;
  /** GPU texture depth (= sliceEnd - sliceStart + 1). */
  depth: number;
}

export interface VolumeTextureBrickPlan {
  /** True when more than one brick is required. */
  bricked: boolean;
  /** Full volume depth (dimensions[2]). */
  fullDepth: number;
  /** Effective max 3D texture dimension used for the plan. */
  max3D: number;
  /** Overlap in slices between adjacent bricks (shared indices). */
  overlap: number;
  bricks: VolumeTextureBrick[];
  /**
   * True when width or height exceeds max3D (unsupported in v1).
   * Plan still returns a single full brick; GPU upload may fail.
   */
  unsupportedXY?: boolean;
}

export const DEFAULT_MAX_TEXTURE_DIMENSION_3D = 2048;
export const DEFAULT_VOLUME_TEXTURE_BRICK_OVERLAP = 1;
export const MAX_VOLUME_TEXTURE_BRICKS = 4;

/**
 * Effective max 3D texture size: GPU probe, optional soft cap from config.
 */
export function getMaxTextureDimension3D(): number {
  const capabilities = getRenderingCapabilities();
  const probed =
    capabilities.maxTextureDimension3D > 0
      ? capabilities.maxTextureDimension3D
      : DEFAULT_MAX_TEXTURE_DIMENSION_3D;

  const softCap =
    getConfiguration()?.rendering?.volumeRendering?.maxTextureDimension3DCap;

  if (typeof softCap === 'number' && softCap > 0) {
    return Math.min(probed, softCap);
  }

  return probed;
}

export function isVolumeTextureBricklingEnabled(): boolean {
  const flag =
    getConfiguration()?.rendering?.volumeRendering?.volumeTextureBrickling;
  // Auto-on when needed; allow explicit disable.
  return flag !== false;
}

/**
 * Build a Z-axis brick plan so each brick depth fits in max3D.
 * Adjacent bricks share `overlap` slices for seamless trilinear filtering.
 */
export function buildZBrickPlan(
  dimensions: readonly [number, number, number] | number[],
  max3D: number = getMaxTextureDimension3D(),
  overlap: number = DEFAULT_VOLUME_TEXTURE_BRICK_OVERLAP
): VolumeTextureBrickPlan {
  const width = dimensions[0];
  const height = dimensions[1];
  const fullDepth = dimensions[2];
  const safeOverlap = Math.max(0, Math.floor(overlap));
  const safeMax3D = Math.max(1, Math.floor(max3D));

  if (width > safeMax3D || height > safeMax3D) {
    return {
      bricked: false,
      fullDepth,
      max3D: safeMax3D,
      overlap: safeOverlap,
      unsupportedXY: true,
      bricks: [
        {
          sliceStart: 0,
          sliceEnd: fullDepth - 1,
          depth: fullDepth,
        },
      ],
    };
  }

  if (
    !isVolumeTextureBricklingEnabled() ||
    fullDepth <= safeMax3D ||
    fullDepth <= 0
  ) {
    return {
      bricked: false,
      fullDepth,
      max3D: safeMax3D,
      overlap: safeOverlap,
      bricks: [
        {
          sliceStart: 0,
          sliceEnd: Math.max(0, fullDepth - 1),
          depth: Math.max(1, fullDepth),
        },
      ],
    };
  }

  const bricks: VolumeTextureBrick[] = [];
  let sliceStart = 0;

  while (sliceStart < fullDepth && bricks.length < MAX_VOLUME_TEXTURE_BRICKS) {
    const sliceEnd = Math.min(sliceStart + safeMax3D - 1, fullDepth - 1);
    bricks.push({
      sliceStart,
      sliceEnd,
      depth: sliceEnd - sliceStart + 1,
    });

    if (sliceEnd >= fullDepth - 1) {
      break;
    }

    // Next brick starts at the last slice of this brick so `overlap` shared
    // indices exist (overlap=1 → one shared slice).
    const nextStart = sliceEnd - safeOverlap + 1;
    if (nextStart <= sliceStart) {
      // Pathological overlap >= brick size; advance by one to avoid infinite loop.
      sliceStart = sliceEnd + 1;
    } else {
      sliceStart = nextStart;
    }
  }

  // If we hit the brick cap before covering the volume, extend the last brick
  // (may exceed max3D — caller should treat as last-resort / may fail on GPU).
  const last = bricks[bricks.length - 1];
  if (last && last.sliceEnd < fullDepth - 1) {
    last.sliceEnd = fullDepth - 1;
    last.depth = last.sliceEnd - last.sliceStart + 1;
  }

  return {
    bricked: bricks.length > 1,
    fullDepth,
    max3D: safeMax3D,
    overlap: safeOverlap,
    bricks,
  };
}

/**
 * Map a full-volume frame/slice index to local Z within a brick, or null if
 * the frame is outside the brick.
 */
export function fullSliceToBrickLocalZ(
  frameIndex: number,
  brick: VolumeTextureBrick
): number | null {
  if (frameIndex < brick.sliceStart || frameIndex > brick.sliceEnd) {
    return null;
  }
  return frameIndex - brick.sliceStart;
}
