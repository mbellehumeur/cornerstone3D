import type vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';

/** Default VTK volume ray-march sample budget used by Cornerstone. */
export const DEFAULT_MAX_SAMPLES_PER_RAY = 512;

export interface VolumeSampleDistanceOptions {
  /** Multiplier applied to the spacing-based default sample distance. */
  multiplier?: number;
  /** Hard cap on ray-march steps (shader + mapper). */
  maxSamplesPerRay?: number;
}

export interface VolumeSampleDistanceResult {
  sampleDistance: number;
  maxSamplesPerRay: number;
  /** Uncapped step count at the spacing-based distance before fitting. */
  computedSteps: number;
  /** True when sampleDistance was increased to fit maxSamplesPerRay. */
  fitted: boolean;
}

/**
 * Spacing-based sample distance used by OHIF / VTK volume mappers:
 * (sx+sy+sz)/6 * multiplier.
 * If the volume diagonal would need more than maxSamplesPerRay steps, the
 * distance is increased so a full ray still finishes within the budget.
 */
export function computeFittedVolumeSampleDistance(
  imageData: vtkImageData,
  options: VolumeSampleDistanceOptions = {}
): VolumeSampleDistanceResult {
  const maxSamplesPerRay = Math.max(
    1,
    Math.floor(options.maxSamplesPerRay ?? DEFAULT_MAX_SAMPLES_PER_RAY)
  );
  const multiplier = Number.isFinite(options.multiplier)
    ? Math.max(options.multiplier as number, 0.001)
    : 1;

  const spacing = imageData.getSpacing();
  const baseDistance =
    (multiplier * (spacing[0] + spacing[1] + spacing[2])) / 6;
  const sampleDistance = Math.max(baseDistance, 1e-12);

  const bounds = imageData.getBounds();
  const diagonal = Math.hypot(
    bounds[1] - bounds[0],
    bounds[3] - bounds[2],
    bounds[5] - bounds[4]
  );
  const computedSteps = Math.ceil(diagonal / sampleDistance);

  if (computedSteps <= maxSamplesPerRay) {
    return {
      sampleDistance,
      maxSamplesPerRay,
      computedSteps,
      fitted: false,
    };
  }

  return {
    sampleDistance: diagonal / maxSamplesPerRay,
    maxSamplesPerRay,
    computedSteps,
    fitted: true,
  };
}
