// Progressive-LOD ("PLOD") codec.
//
// One buffer per asset = an 8-byte header + a per-level offset table, followed
// by self-contained mesh levels concatenated COARSEST -> FINEST. Each level
// carries its own positions (+optional colors/normals) and a 0-based index, so
// the instant a level's bytes finish arriving over the network it is a complete,
// renderable mesh; the next level upgrades it in place. A prefix of the buffer
// that ends on a level boundary is therefore always a valid LOD.
//
// The READER half (readPlodHeader / highestAvailableLevel / readPlodLevel /
// validatePlodLevel) is dependency-free and runs in the browser on a partially
// downloaded buffer. The BUILDER half (buildPlod) lazily imports meshoptimizer
// and runs only at bake time.
//
// Byte layout (all little-endian; every offset is 4-byte aligned by
// construction):
//   header: 'PLOD'(4) | u16 version | u8 attrFlags | u8 levelCount
//   table : levelCount records of 24 bytes:
//             u32 byteOffset | u32 byteLength | u32 vertCount | u32 triCount
//             | f32 screenError(relative, world units) | u32 reserved
//   body  : per level, at byteOffset: [pos f32*3*v][col u8*4*v?][nrm f32*3*v?][idx u32*3*t]

const MAGIC = [0x50, 0x4c, 0x4f, 0x44]; // 'PLOD'
const VERSION = 1;
const FLAG_COLOR = 1 << 0;
const FLAG_NORMAL = 1 << 1;
const HEADER_FIXED_BYTES = 8;
const LEVEL_RECORD_BYTES = 24;

export const PLOD_VERSION = VERSION;

// ---------------------------------------------------------------- helpers ----
function _toU32Index(index, vertCount) {
  if (index && index.length) return index instanceof Uint32Array ? index : Uint32Array.from(index);
  // Non-indexed geometry: synthesize a sequential index so it still levels.
  const seq = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) seq[i] = i;
  return seq;
}

function _normalizeColors(colors, stride, vertCount) {
  if (!colors || !colors.length) return null;
  const out = new Uint8Array(vertCount * 4);
  const isFloat = colors instanceof Float32Array;
  const enc = isFloat ? (x) => Math.max(0, Math.min(255, Math.round(x * 255))) : (x) => x | 0;
  for (let i = 0; i < vertCount; i++) {
    const si = i * stride;
    const r = colors[si];
    const g = stride >= 2 ? colors[si + 1] : r;
    const b = stride >= 3 ? colors[si + 2] : r;
    const a = stride >= 4 ? colors[si + 3] : (isFloat ? 1 : 255);
    out[i * 4] = enc(r); out[i * 4 + 1] = enc(g); out[i * 4 + 2] = enc(b); out[i * 4 + 3] = enc(a);
  }
  return out;
}

// Compact a (subset) index into a self-contained level holding only the
// vertices it references, renumbered from 0 in first-use order.
function _compactLevel(index, srcPos, srcCol, srcNrm) {
  const remap = new Int32Array(srcPos.length / 3).fill(-1);
  const newIndex = new Uint32Array(index.length);
  let kept = 0;
  for (let i = 0; i < index.length; i++) {
    const o = index[i];
    let n = remap[o];
    if (n < 0) { n = kept++; remap[o] = n; }
    newIndex[i] = n;
  }
  const positions = new Float32Array(kept * 3);
  const colors = srcCol ? new Uint8Array(kept * 4) : null;
  const normals = srcNrm ? new Float32Array(kept * 3) : null;
  for (let o = 0; o < remap.length; o++) {
    const n = remap[o];
    if (n < 0) continue;
    positions[n * 3] = srcPos[o * 3]; positions[n * 3 + 1] = srcPos[o * 3 + 1]; positions[n * 3 + 2] = srcPos[o * 3 + 2];
    if (colors) { colors[n * 4] = srcCol[o * 4]; colors[n * 4 + 1] = srcCol[o * 4 + 1]; colors[n * 4 + 2] = srcCol[o * 4 + 2]; colors[n * 4 + 3] = srcCol[o * 4 + 3]; }
    if (normals) { normals[n * 3] = srcNrm[o * 3]; normals[n * 3 + 1] = srcNrm[o * 3 + 1]; normals[n * 3 + 2] = srcNrm[o * 3 + 2]; }
  }
  return { positions, colors, normals, index: newIndex, vertCount: kept, triCount: newIndex.length / 3 };
}

function _levelBodyBytes(vertCount, triCount, hasColor, hasNormal) {
  return vertCount * 12 + (hasColor ? vertCount * 4 : 0) + (hasNormal ? vertCount * 12 : 0) + triCount * 12;
}

// ---------------------------------------------------------------- builder ----
// geo: { positions:Float32Array, index?:Uint32Array, colors?:Float32Array|Uint8Array,
//        colorStride?:3|4, normals?:Float32Array }
// opts: { ratios?:number[], targets?:number[] (tri counts), minTris?:number }
export async function buildPlod(geo, opts = {}) {
  const srcPos = geo.positions instanceof Float32Array ? geo.positions : Float32Array.from(geo.positions);
  const vertCount = srcPos.length / 3;
  if (!vertCount) return null;
  const colorStride = geo.colorStride || (geo.colors ? geo.colors.length / vertCount : 0);
  const srcCol = _normalizeColors(geo.colors, colorStride, vertCount);
  const srcNrm = geo.normals ? (geo.normals instanceof Float32Array ? geo.normals : Float32Array.from(geo.normals)) : null;
  const fineIndex = _toU32Index(geo.index, vertCount);
  const fineTris = fineIndex.length / 3;
  if (!fineTris) return null;

  const minTris = opts.minTris || 8;
  let targets;
  if (Array.isArray(opts.targets) && opts.targets.length) {
    targets = opts.targets.slice();
  } else {
    const ratios = (Array.isArray(opts.ratios) && opts.ratios.length) ? opts.ratios.slice() : [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1];
    targets = ratios.map((r) => Math.max(minTris, Math.round(fineTris * r)));
  }
  targets = Array.from(new Set(targets.map((t) => Math.min(t, fineTris)))).sort((a, b) => a - b);
  if (targets[targets.length - 1] !== fineTris) targets.push(fineTris);

  let Simplifier = null;
  if (targets.some((t) => t < fineTris)) {
    const mod = await import('meshoptimizer');
    Simplifier = mod.MeshoptSimplifier;
    await Simplifier.ready;
  }
  const scale = Simplifier ? Simplifier.getScale(srcPos, 3) : 1;

  const built = [];
  for (const t of targets) {
    let lvlIndex, relErr;
    if (t >= fineTris) { lvlIndex = fineIndex; relErr = 0; }
    else {
      const res = Simplifier.simplify(fineIndex, srcPos, 3, t * 3, 1.0, ['LockBorder']);
      lvlIndex = res[0]; relErr = res[1];
      if (!lvlIndex.length) continue; // simplifier collapsed everything — skip
    }
    const lvl = _compactLevel(lvlIndex, srcPos, srcCol, srcNrm);
    lvl.screenError = relErr * scale;
    built.push(lvl);
  }

  // Keep only strictly-increasing tri counts coarse->fine; the finest (== source)
  // always wins its slot so the top level is full detail.
  built.sort((a, b) => a.triCount - b.triCount);
  const levels = [];
  for (const lvl of built) {
    const prev = levels[levels.length - 1];
    if (prev && lvl.triCount <= prev.triCount) {
      if (lvl.triCount === fineTris) levels[levels.length - 1] = lvl;
      continue;
    }
    levels.push(lvl);
  }
  if (!levels.length) return null;

  const hasColor = !!srcCol, hasNormal = !!srcNrm;
  const attrFlags = (hasColor ? FLAG_COLOR : 0) | (hasNormal ? FLAG_NORMAL : 0);
  const headerBytes = HEADER_FIXED_BYTES + levels.length * LEVEL_RECORD_BYTES;
  let total = headerBytes;
  const offsets = [];
  for (const lvl of levels) {
    const bodyBytes = _levelBodyBytes(lvl.vertCount, lvl.triCount, hasColor, hasNormal);
    offsets.push({ byteOffset: total, byteLength: bodyBytes });
    total += bodyBytes;
  }

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8[0] = MAGIC[0]; u8[1] = MAGIC[1]; u8[2] = MAGIC[2]; u8[3] = MAGIC[3];
  dv.setUint16(4, VERSION, true);
  dv.setUint8(6, attrFlags);
  dv.setUint8(7, levels.length);
  for (let k = 0; k < levels.length; k++) {
    const recOff = HEADER_FIXED_BYTES + k * LEVEL_RECORD_BYTES;
    const lvl = levels[k], off = offsets[k];
    dv.setUint32(recOff, off.byteOffset, true);
    dv.setUint32(recOff + 4, off.byteLength, true);
    dv.setUint32(recOff + 8, lvl.vertCount, true);
    dv.setUint32(recOff + 12, lvl.triCount, true);
    dv.setFloat32(recOff + 16, lvl.screenError || 0, true);
    dv.setUint32(recOff + 20, 0, true);
    let p = off.byteOffset;
    new Float32Array(buf, p, lvl.vertCount * 3).set(lvl.positions); p += lvl.vertCount * 12;
    if (hasColor) { new Uint8Array(buf, p, lvl.vertCount * 4).set(lvl.colors); p += lvl.vertCount * 4; }
    if (hasNormal) { new Float32Array(buf, p, lvl.vertCount * 3).set(lvl.normals); p += lvl.vertCount * 12; }
    new Uint32Array(buf, p, lvl.triCount * 3).set(lvl.index);
  }
  return buf;
}

// ----------------------------------------------------------------- reader ----
function _viewOf(src) {
  if (src instanceof ArrayBuffer) return { buffer: src, byteOffset: 0, byteLength: src.byteLength };
  if (ArrayBuffer.isView(src)) return { buffer: src.buffer, byteOffset: src.byteOffset, byteLength: src.byteLength };
  throw new Error('plod: source must be ArrayBuffer or typed-array view');
}

// Parse the header from however many bytes have arrived. Returns null until the
// fixed header AND the full level table are present (so callers can poll a
// growing buffer safely).
export function readPlodHeader(src) {
  const v = _viewOf(src);
  if (v.byteLength < HEADER_FIXED_BYTES) return null;
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  if (dv.getUint8(0) !== MAGIC[0] || dv.getUint8(1) !== MAGIC[1] || dv.getUint8(2) !== MAGIC[2] || dv.getUint8(3) !== MAGIC[3]) return null;
  const version = dv.getUint16(4, true);
  const attrFlags = dv.getUint8(6);
  const levelCount = dv.getUint8(7);
  const headerBytes = HEADER_FIXED_BYTES + levelCount * LEVEL_RECORD_BYTES;
  if (v.byteLength < headerBytes) return null;
  const levels = [];
  for (let k = 0; k < levelCount; k++) {
    const o = HEADER_FIXED_BYTES + k * LEVEL_RECORD_BYTES;
    levels.push({
      byteOffset: dv.getUint32(o, true),
      byteLength: dv.getUint32(o + 4, true),
      vertCount: dv.getUint32(o + 8, true),
      triCount: dv.getUint32(o + 12, true),
      screenError: dv.getFloat32(o + 16, true),
    });
  }
  return { version, attrFlags, levelCount, hasColor: !!(attrFlags & FLAG_COLOR), hasNormal: !!(attrFlags & FLAG_NORMAL), headerBytes, levels };
}

// Highest level index whose bytes are fully present in `bytesAvailable`, or -1.
export function highestAvailableLevel(header, bytesAvailable) {
  let hi = -1;
  for (let k = 0; k < header.levels.length; k++) {
    const L = header.levels[k];
    if (L.byteOffset + L.byteLength <= bytesAvailable) hi = k; else break;
  }
  return hi;
}

// Decode one level into fresh typed arrays (copies, so the result is alignment-
// safe and decoupled from a growing receive buffer). Returns null if the level's
// bytes have not fully arrived yet.
export function readPlodLevel(src, header, k) {
  const v = _viewOf(src);
  const L = header.levels[k];
  if (!L) return null;
  if (v.byteLength < L.byteOffset + L.byteLength) return null;
  let p = v.byteOffset + L.byteOffset;
  const positions = new Float32Array(v.buffer.slice(p, p + L.vertCount * 12)); p += L.vertCount * 12;
  let colors = null, normals = null;
  if (header.hasColor) { colors = new Uint8Array(v.buffer.slice(p, p + L.vertCount * 4)); p += L.vertCount * 4; }
  if (header.hasNormal) { normals = new Float32Array(v.buffer.slice(p, p + L.vertCount * 12)); p += L.vertCount * 12; }
  const index = new Uint32Array(v.buffer.slice(p, p + L.triCount * 12));
  return { positions, colors, normals, index, vertCount: L.vertCount, triCount: L.triCount, screenError: L.screenError };
}

// Self-consistency check used by tests and by the runtime before upload.
export function validatePlodLevel(level) {
  if (!level) return false;
  if (level.positions.length !== level.vertCount * 3) return false;
  if (level.index.length !== level.triCount * 3) return false;
  let mx = -1;
  for (let i = 0; i < level.index.length; i++) { const x = level.index[i]; if (x > mx) mx = x; }
  if (mx >= level.vertCount) return false;
  for (let i = 0; i < level.positions.length; i++) if (!Number.isFinite(level.positions[i])) return false;
  return true;
}
