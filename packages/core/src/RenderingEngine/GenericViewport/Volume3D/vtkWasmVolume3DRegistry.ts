import type { ViewportPreset } from '../../../types';
import type { WasmVtkVolumeBrickPlan } from '../../helpers/volumeTextureBrickWasm';
import type { VtkWasmNamespace, VtkWasmObject } from '../vtkWasmRuntime';

export type VtkWasmVolume3DEntry = {
  canvas: HTMLCanvasElement;
  brickPlan?: WasmVtkVolumeBrickPlan;
  vtk?: VtkWasmNamespace;
  volumeProperty?: VtkWasmObject;
  requestRender?: () => void;
  pendingPreset?: ViewportPreset;
  /** World-space volume center for trackball orbit (vtk-js scene has no props). */
  volumeCenter?: [number, number, number];
  /** Fit parallel scale captured at mount (empty vtk-js resetCamera would use ~1). */
  baselineParallelScale?: number;
};

const registry = new Map<string, VtkWasmVolume3DEntry>();

async function invoke(
  target: VtkWasmObject | undefined,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = target?.[method];
  if (typeof fn !== 'function') {
    return undefined;
  }
  return await (fn as (...a: unknown[]) => unknown).apply(target, args);
}

function getShiftRange(colorTransferArray: number[]): {
  shiftRange: [number, number];
  min: number;
  max: number;
} {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < colorTransferArray.length; i += 4) {
    min = Math.min(min, colorTransferArray[i]);
    max = Math.max(max, colorTransferArray[i]);
  }
  const center = (max - min) / 2;
  return {
    shiftRange: [-center, center],
    min,
    max,
  };
}

/**
 * Apply a Cornerstone VIEWPORT_PRESET to a vtk-wasm volume property.
 * Mirrors utilities/applyPreset.ts (same HU shift/rescale as vtk-js).
 */
export async function applyViewportPresetToVtkWasmProperty(
  vtk: VtkWasmNamespace,
  property: VtkWasmObject,
  preset: ViewportPreset
): Promise<boolean> {
  if (!vtk.vtkColorTransferFunction || !vtk.vtkPiecewiseFunction) {
    return false;
  }

  const colorTransferArray = preset.colorTransfer
    .split(' ')
    .splice(1)
    .map(parseFloat);
  const { shiftRange } = getShiftRange(colorTransferArray);
  const min = shiftRange[0];
  const width = shiftRange[1] - shiftRange[0];

  const cfun = vtk.vtkColorTransferFunction();
  await invoke(cfun, 'removeAllPoints');
  for (let i = 0; i < colorTransferArray.length; i += 4) {
    const norm = (colorTransferArray[i] - min) / width;
    const x = norm * width + shiftRange[0];
    await invoke(
      cfun,
      'addRGBPoint',
      x,
      colorTransferArray[i + 1],
      colorTransferArray[i + 2],
      colorTransferArray[i + 3]
    );
  }
  await invoke(property, 'setRGBTransferFunction', 0, cfun);

  const scalarOpacityArray = preset.scalarOpacity
    .split(' ')
    .splice(1)
    .map(parseFloat);
  const ofun = vtk.vtkPiecewiseFunction();
  await invoke(ofun, 'removeAllPoints');
  for (let i = 0; i < scalarOpacityArray.length; i += 2) {
    const norm = (scalarOpacityArray[i] - min) / width;
    const x = norm * width + shiftRange[0];
    await invoke(ofun, 'addPoint', x, scalarOpacityArray[i + 1]);
  }
  await invoke(property, 'setScalarOpacity', 0, ofun);

  // vtk.wasm exposes gradient opacity as a piecewise function (not vtk-js
  // per-component min/max setters). String is
  // "N minValue minOpacity maxValue maxOpacity" — same as applyPreset.ts.
  const gradientParts = preset.gradientOpacity
    .split(' ')
    .splice(1)
    .map(parseFloat);
  if (gradientParts.length >= 4 && vtk.vtkPiecewiseFunction) {
    const gfun = vtk.vtkPiecewiseFunction();
    await invoke(gfun, 'removeAllPoints');
    await invoke(gfun, 'addPoint', gradientParts[0], gradientParts[1]);
    await invoke(gfun, 'addPoint', gradientParts[2], gradientParts[3]);
    await invoke(property, 'setGradientOpacity', 0, gfun);
    // (component, disable) — 0 means use gradient opacity.
    await invoke(property, 'setDisableGradientOpacity', 0, 0);
  }

  if (preset.interpolation === '1') {
    await invoke(property, 'setInterpolationTypeToLinear');
  }

  // Native vtkVolumeProperty setters take (component, value) — not vtk-js's
  // single-arg forms. Wrong arity silently no-ops and leaves a faint default.
  await invoke(property, 'setShade', 0, preset.shade === '1' ? 1 : 0);
  await invoke(property, 'setAmbient', 0, parseFloat(preset.ambient));
  await invoke(property, 'setDiffuse', 0, parseFloat(preset.diffuse));
  await invoke(property, 'setSpecular', 0, parseFloat(preset.specular));
  await invoke(
    property,
    'setSpecularPower',
    0,
    parseFloat(preset.specularPower)
  );

  return true;
}

export function registerVtkWasmVolume3D(
  viewportId: string,
  entry: VtkWasmVolume3DEntry
): void {
  registry.set(viewportId, entry);
}

export function unregisterVtkWasmVolume3D(viewportId: string): void {
  registry.delete(viewportId);
}

export function getVtkWasmVolume3D(
  viewportId: string
): VtkWasmVolume3DEntry | undefined {
  return registry.get(viewportId);
}

export function setVtkWasmVolume3DCanvasVisible(
  viewportId: string,
  visible: boolean
): void {
  const entry = registry.get(viewportId);
  if (!entry) {
    return;
  }
  entry.canvas.style.display = visible ? 'block' : 'none';
  entry.canvas.style.visibility = visible ? 'visible' : 'hidden';
}

/**
 * Apply a VIEWPORT_PRESET to a registered vtk-wasm Volume3D viewport.
 * Returns true when handled (applied or stashed) so OHIF does not fall through
 * to the vtk-js actor path.
 */
export function applyVtkWasmVolume3DPreset(
  viewportId: string,
  preset: ViewportPreset
): boolean {
  const entry = registry.get(viewportId);
  if (!entry) {
    return false;
  }

  if (!entry.vtk || !entry.volumeProperty) {
    entry.pendingPreset = preset;
    return true;
  }

  entry.pendingPreset = undefined;
  void applyViewportPresetToVtkWasmProperty(
    entry.vtk,
    entry.volumeProperty,
    preset
  ).then((ok) => {
    if (ok) {
      entry.requestRender?.();
    }
  });
  return true;
}

export function flushVtkWasmVolume3DPendingPreset(viewportId: string): boolean {
  const entry = registry.get(viewportId);
  if (!entry?.pendingPreset) {
    return false;
  }
  return applyVtkWasmVolume3DPreset(viewportId, entry.pendingPreset);
}
