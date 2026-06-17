// plod-gltf-stream.js -- progressive (".plod-style") loader for a REGULAR glTF.
//
// Consumes a single-glb-range model.streaming.glb (EP_progressive_lod, storage
// 'single-glb-range', baked coarse-first by tools/bake-streaming.mjs): it
// HTTP-Range-fetches just the JSON header, then each LOD's bufferViews coarse->
// fine, building a THREE.BufferGeometry per level. The coarse base arrives in
// ~one small range request and renders immediately; finer LODs stream in and
// swap up -- the .plod prefix/refine behaviour, but the file is a plain valid
// glTF any loader can also open whole (it renders the coarse base by default).
//
// Requires HTTP Range support on the host (serve.mjs provides it). three only.

import { BufferGeometry, BufferAttribute } from 'three';

const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const SEM_TO_ATTR = { POSITION: 'position', NORMAL: 'normal', TANGENT: 'tangent', TEXCOORD_0: 'uv', TEXCOORD_1: 'uv2', COLOR_0: 'color' };

async function fetchRange(url, start, endInclusive) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
  if (!res.ok && res.status !== 206) throw new Error(`range fetch ${url} [${start}-${endInclusive}]: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Fetch + parse the GLB JSON header via Range, returning the parsed JSON, the
// absolute byte offset where the BIN data starts, and the EP_progressive_lod
// payload. Total fetched: ~ header(20) + JSON chunk (a few KB).
export async function loadStreamingHeader(url) {
  const head = await fetchRange(url, 0, 19);
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a GLB');
  const jsonLen = dv.getUint32(12, true);
  const jsonBytes = await fetchRange(url, 20, 20 + jsonLen - 1);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));
  // GLB: header(12) + JSON chunk header(8) + JSON(jsonLen) + BIN chunk header(8) + BIN
  const binStart = 20 + jsonLen + 8;
  const ext = json.extensions && json.extensions.EP_progressive_lod;
  if (!ext || ext.storage !== 'single-glb-range') throw new Error('not a single-glb-range EP_progressive_lod GLB');
  return { url, json, binStart, ext };
}

// Range-fetch one accessor's bytes -> typed array.
async function fetchAccessor(header, accIdx) {
  const { url, json, binStart } = header;
  const a = json.accessors[accIdx];
  const bv = json.bufferViews[a.bufferView];
  const Ctor = CT[a.componentType];
  const comps = NUM_COMPONENTS[a.type];
  const byteLen = a.count * comps * Ctor.BYTES_PER_ELEMENT;
  const fileStart = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const bytes = await fetchRange(url, fileStart, fileStart + byteLen - 1);
  // Copy to an aligned buffer (Range responses are byte-aligned, typed arrays need element alignment).
  return new Ctor(bytes.slice().buffer);
}

// Build a BufferGeometry for one EP_progressive_lod mesh-LOD record by range-
// fetching only its bufferViews. `lodRec` = { ratio, indicesAcc, attrAccs }.
export async function fetchLodGeometry(header, lodRec) {
  const geo = new BufferGeometry();
  for (const [sem, accIdx] of Object.entries(lodRec.attrAccs)) {
    const arr = await fetchAccessor(header, accIdx);
    const comps = NUM_COMPONENTS[header.json.accessors[accIdx].type];
    const name = SEM_TO_ATTR[sem] || sem.toLowerCase();
    geo.setAttribute(name, new BufferAttribute(arr, comps, !!header.json.accessors[accIdx].normalized));
  }
  if (lodRec.indicesAcc != null) {
    const idx = await fetchAccessor(header, lodRec.indicesAcc);
    geo.setIndex(new BufferAttribute(idx, 1));
  }
  geo.computeBoundingSphere();
  return geo;
}

// Progressively yield geometries for mesh `meshDescIndex` COARSE -> FINE. The
// caller renders the first (coarse) immediately and swaps to each finer one as
// it arrives. Each step is a handful of Range requests for just that LOD.
export async function* streamMeshLods(header, meshDescIndex = 0) {
  const mesh = header.ext.meshes[meshDescIndex];
  if (!mesh) return;
  const lods = mesh.lods.slice().sort((a, b) => a.ratio - b.ratio); // coarse first
  for (const lodRec of lods) {
    const geometry = await fetchLodGeometry(header, lodRec);
    yield { ratio: lodRec.ratio, geometry, triCount: geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3 };
  }
}
