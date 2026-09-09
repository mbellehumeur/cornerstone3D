import {
  __resetVtkWasmRuntimeForTests,
  getVtkWasmLoadOptions,
  isVtkWasmJspiAvailable,
  isVtkWasmWebgpuAvailable,
  loadVtkWasmRuntime,
  resolveVtkWasmBundleUrl,
} from '../src/RenderingEngine/GenericViewport/vtkWasmRuntime';
import { getConfiguration, setConfiguration } from '../src/init';

describe('vtkWasmRuntime JSPI dual-bundle selection', () => {
  let savedConfig;
  let originalSuspending;

  beforeEach(() => {
    savedConfig = getConfiguration();
    originalSuspending = WebAssembly.Suspending;
    __resetVtkWasmRuntimeForTests();
  });

  afterEach(() => {
    if (originalSuspending === undefined) {
      delete WebAssembly.Suspending;
    } else {
      WebAssembly.Suspending = originalSuspending;
    }
    setConfiguration(savedConfig);
    __resetVtkWasmRuntimeForTests();
  });

  it('resolveVtkWasmBundleUrl picks jspi vs compat from JSPI flag', () => {
    expect(
      resolveVtkWasmBundleUrl(
        {
          jspiUrl: '/vtk-wasm/jspi/a.tar.gz',
          compatUrl: '/vtk-wasm/compat/b.tar.gz',
        },
        true
      )
    ).toBe('/vtk-wasm/jspi/a.tar.gz');
    expect(
      resolveVtkWasmBundleUrl(
        {
          jspiUrl: '/vtk-wasm/jspi/a.tar.gz',
          compatUrl: '/vtk-wasm/compat/b.tar.gz',
        },
        false
      )
    ).toBe('/vtk-wasm/compat/b.tar.gz');
  });

  it('resolveVtkWasmBundleUrl honors single url override', () => {
    expect(
      resolveVtkWasmBundleUrl(
        {
          url: '/forced.tar.gz',
          jspiUrl: '/vtk-wasm/jspi/a.tar.gz',
          compatUrl: '/vtk-wasm/compat/b.tar.gz',
        },
        false
      )
    ).toBe('/forced.tar.gz');
  });

  it('resolveVtkWasmBundleUrl uses same-origin defaults', () => {
    expect(resolveVtkWasmBundleUrl({}, true)).toBe(
      '/vtk-wasm/jspi/vtk-wasm32-emscripten.tar.gz'
    );
    expect(resolveVtkWasmBundleUrl({}, false)).toBe(
      '/vtk-wasm/compat/vtk-9.7.0-wasm32-emscripten.tar.gz'
    );
  });

  it('getVtkWasmLoadOptions uses compat URL and sync when JSPI missing', () => {
    delete WebAssembly.Suspending;
    expect(isVtkWasmJspiAvailable()).toBe(false);

    setConfiguration({
      ...savedConfig,
      rendering: {
        ...savedConfig.rendering,
        vtkWasm: {
          jspiUrl: '/vtk-wasm/jspi/vtk-wasm32-emscripten.tar.gz',
          compatUrl: '/vtk-wasm/compat/vtk-9.7.0-wasm32-emscripten.tar.gz',
          urlIsGzip: true,
        },
      },
    });

    const options = getVtkWasmLoadOptions('webgl');
    expect(options.url).toBe(
      '/vtk-wasm/compat/vtk-9.7.0-wasm32-emscripten.tar.gz'
    );
    expect(options.exec).toBe('sync');
    expect(options.rendering).toBe('webgl');
  });

  it('getVtkWasmLoadOptions uses jspi URL when Suspending exists', () => {
    WebAssembly.Suspending = function Suspending() {};
    expect(isVtkWasmJspiAvailable()).toBe(true);

    setConfiguration({
      ...savedConfig,
      rendering: {
        ...savedConfig.rendering,
        vtkWasm: {
          jspiUrl: '/vtk-wasm/jspi/vtk-wasm32-emscripten.tar.gz',
          compatUrl: '/vtk-wasm/compat/vtk-9.7.0-wasm32-emscripten.tar.gz',
        },
      },
    });

    const options = getVtkWasmLoadOptions('webgl');
    expect(options.url).toBe('/vtk-wasm/jspi/vtk-wasm32-emscripten.tar.gz');
    expect(options.exec).toBe('sync');
  });

  it('isVtkWasmWebgpuAvailable is false without JSPI', async () => {
    delete WebAssembly.Suspending;
    await expect(isVtkWasmWebgpuAvailable()).resolves.toBe(false);
  });

  it('loadVtkWasmRuntime(webgpu) throws without JSPI', async () => {
    delete WebAssembly.Suspending;
    await expect(loadVtkWasmRuntime('webgpu')).rejects.toThrow(/JSPI/);
  });
});
