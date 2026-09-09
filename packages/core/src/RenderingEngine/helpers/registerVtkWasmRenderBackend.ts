import {
  isRegisteredRenderBackend,
  registerRenderBackend,
} from './renderBackendRegistry';
import {
  VtkWasmImageMapperPath,
  VTK_WASM_IMAGE_RENDER_MODE,
  VtkWasmVolumeSlicePath,
  VTK_WASM_VOLUME_RENDER_MODE,
} from '../GenericViewport/Planar/VtkWasmVolumeSliceRenderPath';
import {
  isVtkWasmAvailable,
  isVtkWasmWebgpuAvailable,
  isVtkWasmJspiAvailable,
} from '../GenericViewport/vtkWasmRuntime';

export {
  isVtkWasmAvailable,
  isVtkWasmWebgpuAvailable,
  isVtkWasmJspiAvailable,
  VTK_WASM_VOLUME_RENDER_MODE,
  VTK_WASM_IMAGE_RENDER_MODE,
};

/**
 * Wire id of the experimental vtk.wasm (WebGL) planar render backend.
 */
export const VTK_WASM_RENDER_BACKEND = 'vtkWasm';

/**
 * Registers the experimental vtk.wasm WebGL render backend for GenericViewport
 * planar viewports. Volume mode = MPR with VTK XYZ partition bricks; image
 * mode is a stub that throws (v1 is MPR + Volume3D only).
 *
 * Not registered automatically — call from app init after ensuring
 * `@kitware/vtk-wasm` is installed (or provided via peerImport).
 *
 * @experimental
 */
export async function registerVtkWasmRenderBackend(): Promise<void> {
  if (isRegisteredRenderBackend(VTK_WASM_RENDER_BACKEND)) {
    return;
  }

  const available = await isVtkWasmAvailable();
  if (!available) {
    throw new Error(
      '[registerVtkWasmRenderBackend] @kitware/vtk-wasm is not available'
    );
  }

  registerRenderBackend({
    name: 'VTK_WASM',
    backend: VTK_WASM_RENDER_BACKEND,
    renderModes: {
      image: {
        id: VTK_WASM_IMAGE_RENDER_MODE,
        createDefinition: () => new VtkWasmImageMapperPath(),
      },
      volume: {
        id: VTK_WASM_VOLUME_RENDER_MODE,
        createDefinition: () => new VtkWasmVolumeSlicePath(),
      },
    },
    surface: 'cpu',
  });
}
