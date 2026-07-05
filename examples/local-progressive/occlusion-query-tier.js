// OcclusionQueryTier — WebGL2-native GPU occlusion culling for entity roots.
//
// Frustum culling alone (model-pool.js's per-entity sphere test) only rejects
// what's OUTSIDE the view volume; a fully in-frustum entity hidden behind
// another (a wall, a denser model, a cluster of neighbors) still gets its full
// draw submitted every frame. This tier adds the missing "cull each other"
// step using WebGL2's built-in occlusion query objects (gl.beginQuery /
// gl.endQuery with ANY_SAMPLES_PASSED_CONSERVATIVE) — no compute shaders, no
// depth-pyramid infrastructure, works on the stock WebGL2 context this
// renderer already requires.
//
// Two-frame-latency pattern (avoids a GPU sync stall): frame N issues one
// cheap bounding-box depth-only query per frustum-visible entity; frame N+1
// reads back last frame's results (non-blocking — GL guarantees availability
// eventually, we just skip until it's ready) and hides entities whose query
// returned zero samples passed. A freshly-queried-but-not-yet-resolved entity
// stays visible (fail open) so nothing pops out for a frame while its first
// query is in flight.
//
// Query cost scales with entity count, not scene complexity (one query per
// candidate, box geometry, depth-write-disabled, color-write-disabled), so
// this is only enabled for scenes above a size where the query overhead is
// smaller than the geometry it skips (see shouldEnable()).

import * as THREE from 'three';

const _box = new THREE.Box3();
const _boxMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: true })
);
_boxMesh.frustumCulled = false;
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

export class OcclusionQueryTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
    // Minimum candidate count before queries are worth their own submission
    // cost — below this, frustum culling alone is already cheap enough.
    this.minCandidates = opts.minCandidates ?? 64;
    // Per-frame query budget: each begin/end query pair carries a real driver
    // cost on some backends (notably ANGLE/D3D11, where query objects map to
    // D3D11 async objects and each box render is its own tiny draw+state
    // round-trip). Unbounded per-candidate issue made the query machinery
    // itself a top CPU cost in large scenes. Cap issues per frame and
    // round-robin the cursor across the candidate list so every candidate
    // still refreshes, just over N/budget frames instead of every frame.
    // Verdicts are sticky between refreshes (isOccluded reads the last
    // resolved result), so slower refresh only delays flips, never pops.
    this.maxQueriesPerFrame = opts.maxQueriesPerFrame ?? 32;
    this._rrCursor = 0;
    this._records = new Map(); // entity -> { query, pending, occluded, lastBoxCenter, lastBoxSize }
    this._scene = new THREE.Scene();
    this._scene.add(_boxMesh);
    this.stats = { queried: 0, occluded: 0, resolved: 0, supported: this.isWebGL2 };
  }

  supported() {
    return this.isWebGL2;
  }

  // Called once per frame AFTER the main scene render (so the depth buffer
  // holds this frame's real occluders) with the list of frustum-visible
  // entities to test. Issues new queries for each and reads back any queries
  // whose results are now available (from a prior frame).
  runQueries(camera, candidates) {
    if (!this.isWebGL2 || !candidates.length) return;
    const gl = this.gl;

    // 1. Resolve any completed queries from previous frames first (cheap: just
    //    a getParameter poll, no stall — GL never blocks on QUERY_RESULT_AVAILABLE).
    let resolved = 0, occluded = 0;
    for (const [entity, rec] of this._records) {
      if (!rec.pending) continue;
      const available = gl.getQueryParameter(rec.query, gl.QUERY_RESULT_AVAILABLE);
      if (!available) continue;
      const passed = gl.getQueryParameter(rec.query, gl.QUERY_RESULT);
      rec.occluded = passed === 0;
      rec.pending = false;
      rec.resolves = (rec.resolves || 0) + 1;
      resolved++;
      if (rec.occluded) occluded++;
    }
    this.stats.resolved = resolved;
    this.stats.occluded = occluded;

    // 2. Issue new queries for this frame's candidates, bounded by the
    //    per-frame budget with a round-robin cursor so the whole candidate
    //    set is covered over successive frames.
    this.renderer.autoClear = false;
    const prevTarget = this.renderer.getRenderTarget();
    let queried = 0;
    const n = candidates.length;
    const budget = this.maxQueriesPerFrame;
    if (this._rrCursor >= n) this._rrCursor = 0;
    let idx = this._rrCursor;
    for (let examined = 0; examined < n && queried < budget; examined++, idx = (idx + 1) % n) {
      const entity = candidates[idx];
      let rec = this._records.get(entity);
      if (!rec) {
        rec = { query: gl.createQuery(), pending: false, occluded: false };
        this._records.set(entity, rec);
      }
      if (rec.pending) continue; // previous query still in flight, don't double-issue

      // Cache the LOCAL-space AABB once per entity (full subtree traversal +
      // geometry-bounds union is expensive and this tier's candidates are
      // static-geometry model-pool entities -- their mesh/geometry never
      // changes after creation, only entity.root's transform moves). Computed
      // ONCE by taking the current world-space box and un-transforming it by
      // the inverse of the CURRENT matrixWorld (no mutation of entity.root,
      // safe regardless of what else touches its transform this frame). Every
      // subsequent frame just re-derives the world AABB from the cached local
      // box + entity's CURRENT matrixWorld via Box3.applyMatrix4 (the standard
      // re-derive-min/max-from-basis-vectors trick) instead of a full
      // subtree retraversal.
      if (!rec.localBox) {
        entity.root.updateWorldMatrix(true, true);
        const worldBox = new THREE.Box3().setFromObject(entity.root);
        if (worldBox.isEmpty()) { rec.localBox = null; }
        else {
          const invMatrix = new THREE.Matrix4().copy(entity.root.matrixWorld).invert();
          rec.localBox = worldBox.applyMatrix4(invMatrix);
        }
      }
      if (!rec.localBox) continue;
      _box.copy(rec.localBox).applyMatrix4(entity.root.matrixWorld);
      if (_box.isEmpty()) continue;
      _box.getSize(_size);
      _box.getCenter(_center);
      _boxMesh.position.copy(_center);
      _boxMesh.scale.copy(_size).addScalar(1e-4);
      _boxMesh.updateMatrixWorld(true);

      // three.js render() takes (scene, camera) -- a bare Mesh is not a valid
      // first argument (three only walks .children, which a Mesh has none of
      // by default, so nothing actually draws and every query reads back
      // zero samples). Render the pre-built single-box _scene instead.
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, rec.query);
      this.renderer.render(this._scene, camera);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      rec.pending = true;
      queried++;
    }
    this._rrCursor = idx;
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = true;
    // Explicit flush: without it, driver-queued query commands can sit
    // unsubmitted indefinitely on some configurations (observed: queries
    // issued this way never resolved QUERY_RESULT_AVAILABLE across hundreds
    // of frames in a busy scene, despite an isolated single-query repro
    // resolving in 2-3 frames) -- flush forces the commands out of the
    // client-side queue so the GPU can actually retire them.
    if (queried > 0) gl.flush();
    this.stats.queried = queried;
  }

  // Fail-open: an entity with no resolved query yet, or one whose LAST
  // resolved query saw samples pass, is NOT occluded. `rec.occluded` already
  // holds only a resolved verdict (set exclusively in the resolve pass above
  // when QUERY_RESULT_AVAILABLE was true) -- `rec.pending` tracks whether a
  // FRESH query is currently in flight for the NEXT verdict, which is
  // orthogonal: a query is re-issued every frame a candidate is visible, so
  // requiring !pending here would almost always be false at steady state
  // (this frame's fresh query is essentially always in flight) and the
  // occlusion gate would never fire in practice.
  isOccluded(entity) {
    const rec = this._records.get(entity);
    return !!rec && rec.occluded;
  }

  // Monotonic count of resolved queries for this entity — lets consumers with
  // their own hysteresis (consecutive-hidden-resolve streaks) distinguish a
  // FRESH resolve from a stale verdict re-read, which matters now that the
  // per-frame budget means a given candidate only refreshes every
  // candidates/budget frames.
  getResolveCount(entity) {
    const rec = this._records.get(entity);
    return rec ? (rec.resolves || 0) : 0;
  }

  release(entity) {
    const rec = this._records.get(entity);
    if (!rec) return;
    this.gl.deleteQuery(rec.query);
    this._records.delete(entity);
  }

  dispose() {
    for (const rec of this._records.values()) this.gl.deleteQuery(rec.query);
    this._records.clear();
    _boxMesh.geometry.dispose();
    _boxMesh.material.dispose();
  }
}
