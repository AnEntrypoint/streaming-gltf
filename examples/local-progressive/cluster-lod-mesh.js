// Runtime cluster-LOD mesh (EP_cluster_lod consumer).
//
// Wraps a single unified geometry (one mesh / one primitive, the full-res LOD0 in
// geometry.index + the coarse LOD1..N indices appended) plus the per-cluster
// metadata parsed from extras.EP_cluster_lod. Each frame it:
//   1. frustum-culls clusters by their bounding AABB (CPU) -- NOT the bounding
//      sphere: a sphere fitted to thin flat geometry (floor/wall/panel slabs
//      ~0.1-0.2m thick) is small and centered, under-covering the slab's actual
//      in-plane extent, which false-culls near frustum edges (parts pop in/out
//      as the camera moves). The AABB is exact-fit to the same LOD0 vertices and
//      was already computed + stored per cluster (meshlet-codec.js's `c.aabb`),
//      so this swaps the test, not the source data. The bounding sphere is still
//      used for the LOD projected-size estimate below (cheap distance/radius
//      proxy, not a cull test, so its under-coverage doesn't matter there).
//   2. picks a LOD per visible cluster from projected screen size,
//   3. accumulates the chosen index sub-ranges as geometry GROUPS, and
//   4. lets three's normal render pipeline issue one drawElements call PER
//      GROUP against the unified element buffer. NOT a raw WEBGL_multi_draw
//      call: three's object.onBeforeRender (where this class hooks in) fires
//      BEFORE renderBufferDirect binds the mesh's VAO, so a manual gl draw
//      here would run against stale/wrong buffer state (see _render()'s
//      inline comment for the GL_INVALID failure mode this replaced). Groups
//      still land in ONE render pass with correct attributes and no extra
//      buffers or double-draws -- just not collapsed into a single GPU
//      submission the way a true multi-draw extension call would.
//
// The whole index buffer = LOD0 of every cluster, so if this object is ever drawn
// by the stock three pipeline (no onBeforeRender override applied) it still renders
// the correct full-resolution mesh.

import * as THREE from 'three';
import { parseClusterLod } from './meshlet-codec.js';

const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _size = new THREE.Vector2();

// Per-frame cache of the camera-only inputs shared by every ClusterLodMesh instance drawn in the
// same renderer.render() call: projScreen/frustum/camPos/screen-height/tanHalf depend only on
// (renderer, camera), not on this.matrixWorld, so N instances recomputing them per frame is pure
// waste. Keyed on renderer.info.render.frame -- camera/renderer state cannot change between
// onBeforeRender calls within one render() pass.
let _camCache = { renderer: null, camera: null, frame: -1, sh: 1080, tanHalf: 1 };

// thresholds: projected sphere radius (px-ish, screenH * r / dist) above which a
// given LOD is used. Index i is chosen when projected size > thresholds[i].
// Descending: big on screen -> LOD0, small -> coarsest.
const DEFAULT_LOD_THRESHOLDS = [120, 40]; // LOD0 if >120, LOD1 if >40, else LOD2

export class ClusterLodMesh extends THREE.Mesh {
  // geometry: BufferGeometry whose .index already contains [LOD0 ... | coarse ...]
  //   concatenated (lod0Count = number of LOD0 indices; coarse indices follow).
  // clusterSet: output of parseClusterLod(extras) with cluster.lods[].stream/offset/count.
  // opts: { lodThresholds, screenHeight, hysteresis }
  constructor(geometry, material, clusterSet, opts = {}) {
    super(geometry, material);
    this.clusterSet = clusterSet;
    this.lod0Count = opts.lod0Count != null ? opts.lod0Count : _inferLod0Count(clusterSet);
    this.lodThresholds = opts.lodThresholds || DEFAULT_LOD_THRESHOLDS;
    this._screenHeight = opts.screenHeight || 1080;
    this._hyst = opts.hysteresis != null ? opts.hysteresis : 0.15;
    this._curLod = new Int8Array(clusterSet.clusters.length).fill(-1);

    // Per-frame scratch (sized to worst case = every cluster drawn).
    const n = clusterSet.clusters.length;
    this._starts = new Int32Array(n); // byte offsets into element buffer
    this._counts = new Int32Array(n);
    this._drawCount = 0;

    this._ext = null;
    this._extProbed = false;
    // Pooled geometry.groups objects -- mutated in place each frame instead of clearGroups()+
    // addGroup() reallocating one {start,count,materialIndex} object per visible cluster per frame.
    // _groupPool is the growable backing store (objects never discarded); _groupView is the
    // per-frame slice handed to three (a fresh array each frame, but its elements are pooled objects).
    this._groupPool = [];

    // Live stats for the browser witness.
    this.stats = { visibleClusters: 0, drawnTris: 0, totalTris: 0, multiDrawSubmissions: 0, ext: null };
    for (const c of clusterSet.clusters) this.stats.totalTris += c.lods[0].count / 3;

    // Take over drawing.
    this.onBeforeRender = this._render.bind(this);
    this.frustumCulled = false; // we cull per-cluster ourselves
  }

  // Map a cluster lod descriptor to a byte offset into the unified element buffer.
  // stream 0 = LOD0 region (offset as-is); stream 1 = coarse region (after lod0Count).
  _byteOffset(lod, bytesPerIndex) {
    const base = lod.stream === 1 ? this.lod0Count : 0;
    return (base + lod.offset) * bytesPerIndex;
  }

  _pickLod(ci, projSize) {
    const t = this.lodThresholds;
    const cur = this._curLod[ci];
    let lod = t.length; // default coarsest
    for (let i = 0; i < t.length; i++) {
      // hysteresis: to gain detail (lower i) require clearing threshold by +margin;
      // to drop require falling below by -margin. Bias by current level.
      const goingUp = cur < 0 || cur > i;
      const eff = goingUp ? t[i] * (1 + this._hyst) : t[i] * (1 - this._hyst);
      if (projSize > eff) { lod = i; break; }
    }
    // clamp to available LODs for this cluster
    const avail = this.clusterSet.clusters[ci].lods.length;
    if (lod >= avail) lod = avail - 1;
    this._curLod[ci] = lod;
    return lod;
  }

  _render(renderer, scene, camera, geometry) {
    const index = geometry.index;
    if (!index || !this.clusterSet) return; // nothing to do; default draw renders full LOD0

    // Camera-only inputs (projScreen/frustum/camPos/screen-height/tanHalf) are identical for every
    // ClusterLodMesh drawn in this render() pass -- recompute once per frame, not once per instance.
    const frame = renderer.info.render.frame;
    if (_camCache.renderer !== renderer || _camCache.camera !== camera || _camCache.frame !== frame) {
      _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreen);
      _v.setFromMatrixPosition(camera.matrixWorld); // camera.matrixWorld is already current inside onBeforeRender; avoids getWorldPosition's redundant parent-chain re-update+decompose
      // Live viewport height from the renderer's drawing buffer (falls back to the
      // constructor value) so projected-size LOD thresholds track the real canvas.
      let sh = this._screenHeight;
      try { const sz = renderer.getDrawingBufferSize(_size); if (sz.y > 0) sh = sz.y; } catch (_) {}
      const tanHalf = camera.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) : 1;
      _camCache.renderer = renderer; _camCache.camera = camera; _camCache.frame = frame;
      _camCache.camPos = _v.clone(); _camCache.sh = sh; _camCache.tanHalf = tanHalf;
    }
    const camPos = _camCache.camPos, sh = _camCache.sh, tanHalf = _camCache.tanHalf;
    const me = this.matrixWorld.elements;
    const scale = Math.max(
      Math.hypot(me[0], me[1], me[2]),
      Math.hypot(me[4], me[5], me[6]),
      Math.hypot(me[8], me[9], me[10])
    );

    // GEOMETRY GROUPS (not a custom multiDraw). onBeforeRender runs BEFORE three binds this mesh's
    // VAO, so a custom gl draw here ran with the wrong/stale element+vertex state -> GL_INVALID
    // 'Insufficient buffer size' storms on strict drivers (ANGLE/D3D11: context degrades, FPS
    // collapse) and, when it drew, wrong normals/uvs + collapsed verts. Instead we declare which
    // index sub-ranges to draw as geometry GROUPS and let three's NORMAL pipeline draw them: three
    // sets up the full correct VAO and issues one drawElements per group, with correct attributes,
    // no double-draw, no extra buffers, and Mesh.raycast still works (it walks the full index, not
    // groups). Each group uses materialIndex 0 (single material). Per-cluster LOD selection by
    // projected size is preserved; an empty group set falls back to drawing the full index (LOD0).
    let drawnTris = 0, visible = 0, n = 0;
    const pool = this._groupPool;
    const clusters = this.clusterSet.clusters;
    for (let ci = 0; ci < clusters.length; ci++) {
      const c = clusters[ci];
      _sphere.center.set(c.sphere[0], c.sphere[1], c.sphere[2]).applyMatrix4(this.matrixWorld);
      _sphere.radius = c.sphere[3] * scale;
      // Cull test uses the per-cluster AABB (exact-fit to the cluster's LOD0 verts),
      // not the bounding sphere: a sphere under-covers thin flat geometry (slabs),
      // false-culling near frustum edges. box3.min/max in local space -> world AABB
      // via applyMatrix4 (re-fits axis-aligned bounds correctly under rotation,
      // unlike scaling a sphere radius).
      const a = c.aabb;
      _box.min.set(a[0], a[1], a[2]);
      _box.max.set(a[3], a[4], a[5]);
      _box.applyMatrix4(this.matrixWorld);
      if (!this._spointNoClusterCull && !_frustum.intersectsBox(_box)) continue;
      visible++;
      // Sphere center/radius still drive the projected-size LOD estimate (cheap
      // distance/radius proxy, not a cull test -- under-coverage doesn't matter here).
      const dist = Math.max(1e-3, _sphere.center.distanceTo(camPos));
      const projSize = (sh * _sphere.radius) / (dist * tanHalf);
      const lodIdx = this._pickLod(ci, projSize);
      const lod = c.lods[lodIdx];
      if (!lod.count) continue;
      const base = lod.stream === 1 ? this.lod0Count : 0;     // start in ELEMENTS (groups use element offsets)
      let g = pool[n];
      if (!g) { g = pool[n] = { start: 0, count: 0, materialIndex: 0 }; }
      g.start = base + lod.offset; g.count = lod.count; g.materialIndex = 0;
      n++;
      drawnTris += lod.count / 3;
    }
    // Hand three a view sized to this frame's drawn count; the backing pool objects are never
    // discarded (pool.length is untouched), so a future frame that needs MORE groups reuses them.
    const view = this._groupView || (this._groupView = []);
    view.length = n;
    for (let i = 0; i < n; i++) view[i] = pool[i];
    geometry.groups = view;
    this.stats.visibleClusters = visible;
    this.stats.drawnTris = drawnTris;
    this.stats.multiDrawSubmissions = geometry.groups.length;
  }
}

function _inferLod0Count(clusterSet) {
  let n = 0;
  for (const c of clusterSet.clusters) {
    const l0 = c.lods[0];
    if (l0.stream === 0) n = Math.max(n, l0.offset + l0.count);
  }
  return n;
}

// Given a decoded primitive's geometry (LOD0 in geometry.index) and the coarse
// index typed-array (from the accessor referenced by extras.coarseIndexAccessor),
// produce ONE concatenated element buffer [LOD0 | coarse] and attach it as the
// geometry index, returning {clusterSet, lod0Count}. Tolerates absent extras
// (returns null -> caller renders the geometry as a plain full-res mesh).
export function attachClusterLod(geometry, extras, coarseIndexArray) {
  const clusterSet = parseClusterLod(extras);
  if (!clusterSet) return null;

  const lod0 = geometry.index ? geometry.index.array : null;
  if (!lod0) return null;
  const lod0Count = lod0.length;
  const coarse = coarseIndexArray || new Uint32Array(0);

  // One element buffer big enough for both; promote to Uint32 if needed.
  const maxVid = geometry.attributes.position.count - 1;
  const Ctor = maxVid > 65535 ? Uint32Array : Uint16Array;
  const combined = new Ctor(lod0Count + coarse.length);
  combined.set(lod0, 0);
  combined.set(coarse, lod0Count);
  geometry.setIndex(new THREE.BufferAttribute(combined, 1));

  return { clusterSet, lod0Count };
}
