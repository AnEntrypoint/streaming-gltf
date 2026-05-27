// batched-far-tier.js — FAR/unskinned tier rendered through a single
// THREE.BatchedMesh so hundreds of DISTINCT model geometries collapse into ONE
// draw call (renderer-native multi-draw, with graceful per-draw fallback when
// ANGLE_multi_draw is absent).
//
// Why: at 500 distinct models the measured bottleneck was ~734 draw calls
// (one InstancedBatch per distinct far asset). BatchedMesh draws many distinct
// geometries in a single bind/submit. It also does per-instance CPU frustum
// culling internally and supports SYNCHRONOUS LOD swaps via setGeometryIdAt —
// which removes the async slot-acquire / deferred-queue machinery that caused
// the "models disappear on LOD change" bugs.
//
// Integration: this exposes the same slot-ish interface the Entity code already
// calls on an instanced slot (acquireSlot / releaseSlot / setMatrixForSlot /
// setBoundSphereForSlot), so model-pool can route the unskinned tier here with
// minimal change. One BatchedMesh per vertex-color material class (we use one).

import * as THREE from 'three';

// Normalize a far geometry to the schema BatchedMesh requires (the schema is
// frozen by the first geometry added, so every geometry must match exactly in
// attribute set, itemSize and normalized flag). We force:
//   position f32x3, normal f32x3, uv f32x2, color f32x4 (NON-normalized).
// and strip everything else (uv1, tangent, the per-batch instanced attrs).
function _normalizeFarGeometry(src) {
  const pos = src.getAttribute('position');
  if (!pos) return null;
  const n = pos.count;
  const geo = new THREE.BufferGeometry();
  // position
  geo.setAttribute('position', new THREE.BufferAttribute(_asFloat32(pos), 3, false));
  // normal (compute if missing)
  let nrm = src.getAttribute('normal');
  if (nrm) {
    geo.setAttribute('normal', new THREE.BufferAttribute(_asFloat32(nrm), 3, false));
  } else {
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3, false));
    geo.computeVertexNormals();
  }
  // uv (zero-fill if missing)
  const uv = src.getAttribute('uv');
  geo.setAttribute('uv', uv
    ? new THREE.BufferAttribute(_asFloat32(uv, 2), 2, false)
    : new THREE.BufferAttribute(new Float32Array(n * 2), 2, false));
  // color — unify to f32x4 non-normalized (matches the vertex-color gamma path).
  const col = src.getAttribute('color');
  geo.setAttribute('color', _colorToFloat4(col, n));
  // index (all far geometries are indexed in this asset set)
  if (src.index) geo.setIndex(new THREE.BufferAttribute(_asUint(src.index.array), 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

function _asFloat32(attr, itemSize) {
  const is = itemSize || attr.itemSize;
  // De-normalize integer/normalized data into plain float positions/uvs.
  if (attr.array instanceof Float32Array && attr.itemSize === is && !attr.normalized) return attr.array;
  const out = new Float32Array(attr.count * is);
  for (let i = 0; i < attr.count; i++) {
    if (is >= 1) out[i * is] = attr.getX(i);
    if (is >= 2) out[i * is + 1] = attr.getY(i);
    if (is >= 3) out[i * is + 2] = attr.getZ(i);
  }
  return out;
}

// Produce a Float32 itemSize-4 color array regardless of the source layout
// (missing -> white; itemSize 3 -> alpha 1; normalized int -> 0..1 floats).
function _colorToFloat4(col, count) {
  const out = new Float32Array(count * 4);
  if (!col) { out.fill(1); return new THREE.BufferAttribute(out, 4, false); }
  for (let i = 0; i < count; i++) {
    out[i * 4 + 0] = col.getX(i);
    out[i * 4 + 1] = col.itemSize >= 2 ? col.getY(i) : col.getX(i);
    out[i * 4 + 2] = col.itemSize >= 3 ? col.getZ(i) : col.getX(i);
    out[i * 4 + 3] = col.itemSize >= 4 ? col.getW(i) : 1;
  }
  return new THREE.BufferAttribute(out, 4, false);
}

function _asUint(arr) {
  if (arr instanceof Uint32Array || arr instanceof Uint16Array) return arr;
  return new Uint32Array(arr);
}

export class BatchedFarTier {
  constructor(pool, opts = {}) {
    this.pool = pool;
    this.maxInstances = opts.maxInstances ?? 4096;
    this.maxVerts = opts.maxVerts ?? 3_000_000; // > surveyed 2.2M; Uint32 idx auto
    this.maxIndex = opts.maxIndex ?? 6_000_000; // > surveyed 4.5M
    // UNLIT vertex-color material (MeshBasicMaterial). Far/instanced dots don't
    // need lighting; unlit also removes the Lambert lighting dependency that was
    // making batched far models render dark/black (the "off-screen"/empty-screen
    // symptom was actually near-black models being counted as background). Unlit
    // shows the baked vertex colors directly. Also cheaper fragment cost (fill).
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    material.onBeforeCompile = (shader) => {
      // sRGB->linear decode moved from PER-FRAGMENT to PER-VERTEX: the baked
      // vertex colors are sRGB bytes; instead of pow(vColor,2.2) for every pixel
      // we decode once per vertex (vColor is then interpolated linear). For the
      // low-poly far tier that's far fewer pow() calls than fragments. Visually
      // ~identical (linear interpolation of decoded colors). Fragment keeps the
      // stock <color_fragment> (plain diffuseColor *= vColor).
      shader.vertexShader = shader.vertexShader.replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #if defined( USE_COLOR_ALPHA )
          vColor.rgb = pow(vColor.rgb, vec3(2.2));
        #elif defined( USE_COLOR )
          vColor = pow(vColor, vec3(2.2));
        #endif`,
      );
    };
    this.material = material;
    this.mesh = new THREE.BatchedMesh(this.maxInstances, this.maxVerts, this.maxIndex, material);
    this.mesh.frustumCulled = false;          // object-level; we cull per instance
    this.mesh.perObjectFrustumCulled = true;  // CPU per-instance sphere cull in onBeforeRender
    this.mesh.sortObjects = false;            // opaque, depth-test handles order; saves CPU
    this.mesh.name = 'batched-far-tier';
    // geometryId cache: `${assetUrl}|${meshDescIdx}|${lodIdx}` -> geometryId
    this._geometryIds = new Map();
    // entity -> instanceId
    this._instances = new Map();
    this._tmpColor = new THREE.Color();
  }

  // Lazily register a (resolved) far geometry; returns its BatchedMesh geometryId.
  _geometryIdFor(asset, meshDescIdx, lodIdx, resolvedGeo) {
    const key = `${asset.url}|${meshDescIdx}|${lodIdx}`;
    let gid = this._geometryIds.get(key);
    if (gid != null) return gid;
    const norm = _normalizeFarGeometry(resolvedGeo);
    if (!norm) return null;
    try {
      gid = this.mesh.addGeometry(norm);
    } catch (e) {
      // Out of reserved space → grow the shared buffers and retry once.
      this.mesh.setGeometrySize(this.maxVerts *= 2, this.maxIndex *= 2);
      gid = this.mesh.addGeometry(norm);
    }
    this._geometryIds.set(key, gid);
    return gid;
  }

  // Entity-facing: acquire an instance for this entity at the given geometry.
  // Returns an instanceId (used as the "slot index" by the entity code).
  acquire(entity, asset, meshDescIdx, lodIdx, resolvedGeo) {
    const gid = this._geometryIdFor(asset, meshDescIdx, lodIdx, resolvedGeo);
    if (gid == null) return -1;
    let id = this._instances.get(entity);
    if (id == null) {
      try {
        id = this.mesh.addInstance(gid);
      } catch (e) {
        this.mesh.setInstanceCount(this.maxInstances *= 2);
        id = this.mesh.addInstance(gid);
      }
      this._instances.set(entity, id);
    } else {
      // LOD change within the far tier == synchronous geometry swap. This is the
      // whole point: no release/re-acquire, no async load, no disappear.
      this.mesh.setGeometryIdAt(id, gid);
    }
    return id;
  }

  release(entity) {
    const id = this._instances.get(entity);
    if (id == null) return;
    this._instances.delete(entity);
    this.mesh.deleteInstance(id);
  }

  setMatrix(id, matrix) {
    if (id < 0) return;
    this.mesh.setMatrixAt(id, matrix);
  }

  // No-op stubs: BatchedMesh culls per instance itself from per-geometry bounds.
  flush() { /* BatchedMesh uploads matrices via its own dirty tracking */ }

  // Per-(asset,meshDescIdx,lodIdx) adapter implementing the slot interface the
  // Entity code calls (acquireSlot/releaseSlot/setMatrixForSlot/
  // setBoundSphereForSlot). It carries the resolved geometry so acquire can add
  // it to the shared BatchedMesh, and exposes `mesh` (the shared BatchedMesh)
  // for scene attachment + flush. All adapters for one tier share one mesh.
  slotAdapter(asset, meshDescIdx, lodIdx, resolvedGeo) {
    const tier = this;
    return {
      _batchedFar: true,
      mesh: tier.mesh,
      asset, meshDescIdx, lodIdx,
      acquireSlot(entity) {
        return tier.acquire(entity, asset, meshDescIdx, lodIdx, resolvedGeo);
      },
      releaseSlot(entity) { tier.release(entity); },
      setMatrixForSlot(id, matrix) { tier.setMatrix(id, matrix); },
      // BatchedMesh culls per instance from per-geometry bounds; bound-sphere
      // seeding is a no-op here (kept for interface compatibility).
      setBoundSphereForSlot() {},
      flushMatrixUpdates() {},
      flushUpdates() {},
    };
  }
}

export default { BatchedFarTier };
