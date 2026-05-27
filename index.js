// streaming-gltf — public SDK entry.
//
// Progressive glTF LOD renderer for large scenes: a BatchedMesh "far" tier, an
// InstancedMesh "mid" tier, and a per-entity "hero" tier, with network-lazy /
// GPU-eager LOD streaming and on-GPU position lerping for cheap per-frame
// position updates.
//
// `three` is a peer dependency — provide it yourself (e.g. via an importmap
// pointing at a CDN build, or your bundler). This package does not bundle three.
//
//   import { ModelPool } from 'streaming-gltf';
//   const pool = new ModelPool({ scene, renderer, camera });
//   const e = pool.spawn(url, { position: [x, 0, z] });
//   // per-frame, after advancing the camera:
//   pool.update();
//   // sparse position targets; the GPU interpolates each frame:
//   pool.setTarget(e, x, y, z, durationMs);
//
// The bake/convert pipeline (producing model.progressive.glb) lives in
// tools/bake-*.mjs and is run via the package scripts (npm run bake:*).

export { ModelPool } from './examples/local-progressive/model-pool.js';
export { BatchedFarTier } from './examples/local-progressive/batched-far-tier.js';
