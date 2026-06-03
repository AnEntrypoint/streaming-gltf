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

## VRM support

VRM avatars load through `@pixiv/three-vrm` v3 (a peer dependency). When a baked
GLB carries the `VRMC_vrm` extension, the `GLTFLoader` is registered with
`VRMLoaderPlugin` and the parsed `gltf.userData.vrm` runtime is driven each frame
by `pool.update()` — humanoid bones, spring bones, expressions, and look-at all
animate. The HUD in the example reports the detected humanoid bone count.

What works:

- Full humanoid / spring-bone / expression / look-at runtime on a VRM avatar.
- Progressive mesh + texture LOD on the avatar's primitives, exactly as for any
  other model. Sibling LOD chunks are loaded **without** the VRM plugin
  (`includeVrm: false`), so MToon material setup runs once on the root only.
- MToon materials are LOD-swapped safely: texture-LOD application matches strictly
  by texture name against the material's existing slots, so it never stamps a
  foreign bitmap into an MToon slot.

Multi-driver — every instance animates independently. `@pixiv/three-vrm` v3
exposes no skeleton-rebind clone (`VRM.prototype` is `[constructor, update]` only;
there is no `vrm.clone()` / `VRMUtils.clone`), and its humanoid/spring-bone/
expression managers bind the bones of the scene they were parsed against. Rather
than share one runtime, the pool retains the asset's raw GLB bytes and **re-parses
an independent VRM per driven entity** — each gets its own scene, its own humanoid/
spring-bone/expression managers, and is driven independently by `vrm.update(dt)`.
N pooled instances of one VRM all animate (distinct spring physics, distinct
expressions); none freeze in bind pose. Per-instance parses are concurrency-bounded
(heavy work) and queue when the limit is reached. This mirrors how a multiplayer
host parses one VRM per player.

`entity.dispose()` runs `VRMUtils.deepDispose()` on that entity's own VRM scene,
freeing its spring/collider/expression GPU resources without touching siblings.
`pool.dispose()` tears the pool down (every entity, then every asset).

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
    (meshopt decimation + sharp texture resizing + a `EP_progressive_lod`
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

## glTF extension: `EP_progressive_lod`

The bake pipeline emits a glTF extension, **`EP_progressive_lod`**, that
declares the progressive LOD ladder (per-mesh and per-texture) the renderer
consumes. The base glTF always carries the *coarsest* LOD, and the extension is
declared in `extensionsUsed` — never `extensionsRequired` — so a viewer that
does not implement it simply renders that coarse base and ignores the rest. Two
storage modes are covered by one extension, discriminated by a `storage` field:
`sibling-file` (higher LODs in sibling files, `bake-progressive.mjs`) and
`single-glb-range` (all LODs packed as `bufferView` byte ranges in one GLB,
range-fetched on demand, `bake-streaming.mjs`).

- Spec + JSON Schema: [`extensions/EP_progressive_lod/`](extensions/EP_progressive_lod/README.md)
- Conformance check: `node tools/validate-extension.mjs <model.glb>`

**Registration status:** the `EP` vendor prefix is *not yet registered* with
the Khronos glTF extension registry; the name is provisional until a
registration PR to [KhronosGroup/glTF](https://github.com/KhronosGroup/glTF)
lands. Assets baked before the rename (payload under `extras.LOCAL_progressive`)
are still read by the runtime via a compatibility fallback.

## Notes

- The renderer is draw-call-bound at scale; the FAR tier collapses many distinct
  models into a single `THREE.BatchedMesh` draw and the FPS controller adjusts
  LOD *distance* (not a global ceiling) to hold the target frame rate.
- Baked `output_*/` assets are git-ignored (regenerate with the bake tools).
