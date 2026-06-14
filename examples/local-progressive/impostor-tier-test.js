// impostor-tier-test.js — validate OctahedralImpostorTier: bake several DISTINCT
// difficult GLBs into separate atlas-array layers, place a grid of instances
// (mixing assets), and confirm they all render in ONE draw call with the correct
// per-asset atlas. Exposes window.__tier for Playwright.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OctahedralImpostorTier } from './octahedral-impostor-tier.js';

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a4252);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);

const tier = new OctahedralImpostorTier(renderer, { grid: 8, cellPx: 128, maxLayers: 32, maxInstances: 4096 });
scene.add(tier.mesh);

const loader = new GLTFLoader();
const loadGLB = (url) => new Promise((res, rej) => loader.load(url, (g) => res(g.scene), undefined, rej));

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
}
addEventListener('resize', resize);

let gridSpan = 6;
function frame(t) {
  requestAnimationFrame(frame);
  resize();
  const a = t * 0.0003, d = gridSpan * 1.6;
  camera.position.set(Math.sin(a) * d, d * 0.4, Math.cos(a) * d);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// Normalize a loaded scene to unit radius centered at origin, return the root.
function normalize(root) {
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  const k = 1 / (0.5 * box.getSize(new THREE.Vector3()).length() || 1);
  root.scale.setScalar(k);
  root.position.copy(c).multiplyScalar(-k);
  root.updateWorldMatrix(true, true);
  return root;
}

async function run(names) {
  const assets = [];
  for (let i = 0; i < names.length; i++) {
    const root = normalize(await loadGLB(`/glb_fixed/${names[i]}`));
    assets.push({ url: names[i], root });
  }

  // Place a square grid of instances, cycling through the distinct assets so the
  // single InstancedMesh holds a MIX of atlas layers.
  const cols = Math.ceil(Math.sqrt(names.length * 9));
  gridSpan = cols * 1.2;
  let n = 0; const placed = [];
  for (let gz = 0; gz < cols; gz++) {
    for (let gx = 0; gx < cols; gx++) {
      const asset = assets[n % assets.length];
      const cx = (gx - (cols - 1) / 2) * 2.4;
      const cz = (gz - (cols - 1) / 2) * 2.4;
      const entity = { id: n };
      const desc = tier.bakeAsset(asset, asset.root);
      const id = desc ? tier.acquire(entity, desc.layer, cx, 0, cz, desc.radius) : -1;
      placed.push({ id, layer: id >= 0 ? tier._layerAttr.array[id] : -1 });
      n++;
    }
  }

  // Render once and read draw-call count for the tier mesh.
  renderer.render(scene, camera);
  const drawCalls = renderer.info.render.calls;
  const tris = renderer.info.render.triangles;

  // Coverage: scan the framebuffer for non-background pixels.
  const gl = renderer.getContext();
  const W = canvas.width, H = canvas.height;
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const bg = [58, 66, 82];
  let nonBg = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (Math.abs(buf[o] - bg[0]) + Math.abs(buf[o + 1] - bg[1]) + Math.abs(buf[o + 2] - bg[2]) > 30) nonBg++;
  }
  const coverage = nonBg / (W * H);

  const layers = tier._nextLayer;
  const ok = drawCalls === 1 && layers === assets.length && coverage > 0.02;
  hud.textContent = `tier draw calls: ${drawCalls}  (want 1)\nlayers baked: ${layers} / assets ${assets.length}\ninstances: ${n}\ntris: ${tris}\ncoverage: ${(coverage * 100).toFixed(1)}%\nresult: ${ok ? 'OK' : 'FAIL'}`;
  return { ok, drawCalls, layers, assets: assets.length, instances: n, tris, coverage };
}

async function init() {
  const all = await fetch('/glb_fixed-list.json').then((r) => r.json()).catch(() => []);
  window.__tier = { run, all, tier, ready: true };
  window.__dbg = { scene, camera, renderer, tier, THREE };
  hud.textContent = `${all.length} models available — call window.__tier.run([names])`;
}
init();
