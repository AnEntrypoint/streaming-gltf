# Progressive glTF LOD renderer

A self-contained three.js renderer for large scenes of distinct glTF/GLB models
with progressive LOD streaming, plus the local pipeline that converts source
models into the progressive format it consumes.

## Live demo

**https://anentrypoint.github.io/streaming-gltf/** — the stress demo, deployed
from `examples/local-progressive/` by `.github/workflows/deploy-pages.yml`. It
ships code only: `three` loads from a CDN (importmap) and the baked models are
streamed **cross-origin** from the assets host
(`https://anentrypoint.github.io/assets/`, derived from its
`manifest.baked.json`). Override the asset source with `?assets=<baseUrl>`, or
use `?assets=local` with the dev server (`npm run demo:local`).

## SDK usage

`streaming-gltf` is an importable ES module. `three` and `@pixiv/three-vrm` are
**peer dependencies** — provide them yourself (e.g. via an importmap pointing at
a CDN build, or your bundler); they are not bundled.

```js
import { ModelPool } from 'streaming-gltf';
// or: import { BatchedFarTier } from 'streaming-gltf/batched-far-tier';

const pool = new ModelPool({ scene, renderer, camera });
const entity = pool.spawn(url, { position: [x, 0, z] });

// per frame, after advancing the camera:
pool.update();

// sparse position targets — the GPU interpolates each frame (far tier),
// so moving entities cost ~no per-frame CPU matrix writes:
pool.setTarget(entity, x, y, z, durationMs);
```

## Layout

- `examples/local-progressive/` — the renderer (latest). Entry: `stress.html` →
  `stress.js` → `model-pool.js` (+ `draw-call-batching.js`, `batched-far-tier.js`,
  `material-pool.js`, `deferred-load-queue.js`, `lod-unload-manager.js`,
  `frustum-cache.js`, `multi-draw-optimizer.js` / `multi-draw-utils.js`,
  `vertex-compression.js`, `draw-call-sorter.js`, `buffer-pool.js`,
  `lod-worker.js`). `serve.mjs` is the dev server; `measure-fps.mjs` the
  steady-state FPS harness.
- `tools/` — the conversion + download pipeline:
  - `bake-progressive.mjs` — convert one source GLB into a progressive GLB
    (meshopt decimation + sharp texture resizing + a `LOCAL_progressive`
    extension referencing sibling LOD files).
  - `bake-all.mjs` — batch-bake every model under a source dir.
  - `bake-streaming.mjs` — download + bake for the streaming workflow.
- `models/` — source models fed to the bake tools.

## Usage

Install deps once:

```
npm install
```

Convert source models into the progressive format the renderer loads
(`examples/local-progressive/output_<name>/`):

```
npm run bake:local -- models/<model>.glb examples/local-progressive/output_<name>
# or batch every model under a directory:
npm run bake:all -- models
```

Run the renderer (serves the stress demo at `/`):

```
npm run demo:local
# open http://127.0.0.1:5180/
```

Measure steady-state FPS (hardware GPU via system Chrome):

```
CHANNEL=chrome npm run measure -- 500
```

## Notes

- The renderer is draw-call-bound at scale; the FAR tier collapses many distinct
  models into a single `THREE.BatchedMesh` draw and the FPS controller adjusts
  LOD *distance* (not a global ceiling) to hold the target frame rate.
- Baked `output_*/` assets are git-ignored (regenerate with the bake tools).
