import type { ViewportPreset } from '../../../types';
import type { TF } from '@slicerlive/webgpu-render';

export type SlicerLivePresetAppearance = {
  colorTF: TF;
  opacityTF: TF;
  clim: [number, number];
  shade: boolean;
  /** ImageField [ka, kd, ks, shininess] from OHIF ambient/diffuse/specular. */
  shadeCoeffs?: [number, number, number, number];
};

/**
 * Convert a Cornerstone VIEWPORT_PRESET into SlicerLive transfer functions.
 * Clim spans the preset's color TF HU range (not the volume valueRange).
 */
export function viewportPresetToSlicerLiveAppearance(
  preset: ViewportPreset
): SlicerLivePresetAppearance | undefined {
  const colorParts = preset.colorTransfer.split(' ').map(Number).slice(1);
  const opacityParts = preset.scalarOpacity.split(' ').map(Number).slice(1);

  const colorTF: TF = [];
  for (let i = 0; i + 3 < colorParts.length; i += 4) {
    colorTF.push([
      colorParts[i],
      colorParts[i + 1],
      colorParts[i + 2],
      colorParts[i + 3],
    ]);
  }

  const opacityTF: TF = [];
  for (let i = 0; i + 1 < opacityParts.length; i += 2) {
    opacityTF.push([opacityParts[i], opacityParts[i + 1]]);
  }

  if (!colorTF.length || !opacityTF.length) {
    return undefined;
  }

  const clim: [number, number] = [
    colorTF[0][0],
    colorTF[colorTF.length - 1][0],
  ];

  if (!(clim[1] > clim[0])) {
    return undefined;
  }

  const shade = preset.shade === '1';
  const ambient = Number(preset.ambient);
  const diffuse = Number(preset.diffuse);
  const specular = Number(preset.specular);
  const specularPower = Number(preset.specularPower);

  const shadeCoeffs: [number, number, number, number] | undefined = shade
    ? [
        Number.isFinite(ambient) ? ambient : 0.25,
        Number.isFinite(diffuse) ? diffuse : 0.75,
        Number.isFinite(specular) ? specular : 0.5,
        Number.isFinite(specularPower) ? specularPower : 24,
      ]
    : undefined;

  return {
    colorTF,
    opacityTF,
    clim,
    shade,
    shadeCoeffs,
  };
}
