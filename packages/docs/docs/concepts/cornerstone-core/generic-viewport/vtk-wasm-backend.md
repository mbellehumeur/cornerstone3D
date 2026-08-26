---
id: vtk-wasm-backend
title: vtk.wasm Render Backend (experimental)
summary: Opt-in Planar MPR and Volume3D paths using Kitware vtk.wasm WebGL with VTK XYZ partition brickling
---

# vtk.wasm Render Backend (experimental)

Cornerstone can render Planar **MPR** and **Volume3D** through Kitware
**vtk.wasm** (WebGL). Large volumes use VTK’s native **XYZ partition**
brickling (`SetPartitions`), planned in JavaScript by
`volumeTextureBrickWasm` — not the OpenGL Z-slab brickling in
`volumeTextureBricks`.

## Opt-in registration

```ts
import {
  registerVtkWasmRenderBackend,
  setRenderBackend,
  Enums,
  VTK_WASM_VOLUME_3D_RENDER_MODE,
} from '@cornerstonejs/core';

await registerVtkWasmRenderBackend();
setRenderBackend(Enums.RenderBackends.VTK_WASM);

// Volume3D:
viewport.setDisplaySets([{ ... , options: { renderMode: VTK_WASM_VOLUME_3D_RENDER_MODE } }]);
```

Requires `@kitware/vtk-wasm` (optional peer) or
`init({ peerImport: (id) => import(id) })` that can load it.

## OHIF defaults and corner menu

In OHIF Viewers, the cornerstone extension registers vtk-wasm at init
(graceful fallback if the package is missing):

1. `await registerVtkWasmRenderBackend()` when `isVtkWasmAvailable()`.
2. Default planar backend: `setRenderBackend('vtkWasm')` when config/URL
   does not already set `viewportRendering`.
3. Default Volume3D path: `vtkWasmVolume3d` (config
   `genericViewports.renderMode` / corner-menu override).

App config (e.g. `default.js` / `dev.js`):

```js
genericViewports: {
  enabled: true,
  renderMode: 'vtkWasmVolume3d',
  viewportRendering: 'vtkWasm',
},
```

Volume3D corner menu includes **next-vtk-wasm (WebGL)** when registration
succeeded; omit the entry if wasm is unavailable. MPR is not switched by
that menu — it follows the planar `renderBackend` / `viewportRendering`
setting.

Without `@kitware/vtk-wasm`, init warns and falls back to `vtkVolume3d` /
`gpu`; the app still loads.

## Configuration

```ts
init({
  rendering: {
    vtkWasm: {
      url: '/vtk-wasm/vtk-wasm32-emscripten.tar.gz', // same-origin recommended
      volumeTextureBrickling: true,
      brickPartitions: {
        strategy: 'minimum', // or 'target' | 'fixed'
        maxPerAxis: 64,
        // targetPerAxis: 8,
        // partitions: [2, 1, 1],
      },
    },
  },
});
```

- **`minimum`** (default): fewest partitions so each brick fits `max3D`.
- **`maxPerAxis`**: clamp (default 64 → grid up to 64³).
- Partition strategy never skips a bump required to fit `max3D`.

## Deployment

- Serve `.wasm` as `application/wasm`.
- Prefer same-origin bundle URL; if CDN, extend CSP `connect-src`.
- No COOP/COEP required for WebGL.

### OHIF same-origin assets

Rspack rewrites Kitware’s dynamic `import(url)` unless `webpackIgnore` is
applied (see `.webpack/loaders/vtkWasmWebpackIgnore.js`).

Ship the Kitware `.tar.gz` under `platform/app/public/vtk-wasm/` (embeds
`types/` so the method table is built — a bare directory load only looks for
`vtk-methods.json` and will fall back to unsafe name guessing):

```bash
# from Viewers repo root
node scripts/fetch-vtk-wasm.mjs
```

Init sets `rendering.vtkWasm.url` to
`/vtk-wasm/vtk-wasm32-emscripten.tar.gz` with `urlIsGzip: true`
(override via `genericViewports.vtkWasmUrl`). Restart `npm run dev` after
fetching so CopyPlugin picks up the files.

Bindings must use vtk-wasm conventions (`$set`, `canvasSelector`,
`typedArrayInterface.toVTKAoSArray` / `pointData.setScalars`) — not vtk-js
`set` / `setContainer` / `setScalars(array)`.

## Limits (v1)

- Stack `image` mode throws (MPR + Volume3D only).
- OpenGL Z-slab brickling remains a separate path (`volumeTextureBricks`).
- VTK multi-pass partitions can be slower than one-pass Z-slabs for VR.
