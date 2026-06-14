// impostor-test.js — standalone harness to validate octahedral impostors on the
// "difficult GLBs" corpus (served at /glb_fixed/ by serve.mjs).
//
// Left = real model, right = its on-the-fly octahedral impostor (one quad). Both
// orbit together so you can eyeball silhouette/parallax agreement. Exposes
// window.__impostor for Playwright: run(name) loads a GLB, bakes, measures atlas
// coverage + bake time, and resolves with stats.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bakeOctahedralImpostor, makeImpostorMesh } from './octahedral-impostor.js';

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const pick = document.getElementById('pick');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a4252); // mid-grey so dark/untextured geo reads
scene.add(new THREE.AmbientLight(0xffffff, 1.6));
const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(1, 2, 1.5); scene.add(dl);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
const loader = new GLTFLoader();

let realRoot = null;     // current real model group (left)
let impostorMesh = null; // current impostor billboard (right)
let radius = 1, separation = 3;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
}
addEventListener('resize', resize);

function clearCurrent() {
  for (const o of [realRoot, impostorMesh]) {
    if (!o) continue;
    o.parent && o.parent.remove(o);
    o.traverse?.((n) => { n.geometry?.dispose?.(); if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach((m) => m.dispose?.()); });
  }
  realRoot = impostorMesh = null;
}

function fitCamera() {
  // Half-span across X is (separation + radius); frame snugly using live aspect
  // (recomputed in frame() so it tracks canvas resize).
  camera._halfSpan = separation + radius;
}

let t0 = 0;
function frame(t) {
  requestAnimationFrame(frame);
  resize();
  const ang = t * 0.0004;
  const halfSpan = camera._halfSpan || 2.3;
  const d = halfSpan / (Math.tan((camera.fov * Math.PI / 180) / 2) * camera.aspect) * 1.05;
  camera.position.set(Math.sin(ang) * d, d * 0.3, Math.cos(ang) * d);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

function loadGLB(url) {
  return new Promise((res, rej) => loader.load(url, (g) => res(g.scene), undefined, rej));
}

// Bake atlas coverage: fraction of atlas texels with alpha>threshold. Detects a
// blank/failed bake (coverage ~0) vs a real silhouette.
function atlasCoverage(impostor) {
  const rt = impostor.renderTarget;
  const w = rt.width, h = rt.height;
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  let nonEmpty = 0;
  for (let i = 0; i < w * h; i++) if (buf[i * 4 + 3] > 12) nonEmpty++;
  return nonEmpty / (w * h);
}

function countTris(root) {
  let tris = 0;
  root.traverse((n) => {
    if (n.isMesh && n.geometry) {
      const g = n.geometry;
      tris += (g.index ? g.index.count : (g.attributes.position?.count || 0)) / 3;
    }
  });
  return Math.round(tris);
}

async function run(name) {
  clearCurrent();
  const url = `/glb_fixed/${name}`;
  const root = await loadGLB(url);

  // Normalize to unit radius centered at origin (CS maps span thousands of
  // units and would blow past the camera far plane otherwise).
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const rawRadius = 0.5 * s.length() || 1;
  const k = 1 / rawRadius;
  root.scale.setScalar(k);
  root.position.copy(c).multiplyScalar(-k); // centered at origin after scale
  radius = 1;
  separation = radius * 1.3;
  root.position.x -= separation; // shift left
  scene.add(root);
  realRoot = root;
  fitCamera();

  const tris = countTris(root);

  // Bake from a CENTERED copy reference: re-center for baking (impostor bakes in
  // the object's own frame). We pass the centered-at-left root but the baker
  // measures its own bounds, so it's fine — center is captured in descriptor.
  // Bake against a temporary centered group so the atlas is centered.
  const bakeGroup = new THREE.Group();
  // Move root temporarily back to origin for a clean centered bake.
  const savedX = root.position.x; root.position.x = 0;
  scene.add(bakeGroup); bakeGroup.add(root);
  const tBake = performance.now();
  const impostor = bakeOctahedralImpostor(renderer, root, { grid: 8, cellPx: 128 });
  const bakeMs = performance.now() - tBake;
  // restore root to left half
  scene.add(root); root.position.x = savedX; scene.remove(bakeGroup);

  if (!impostor) {
    hud.textContent = `${name}\nBAKE FAILED (empty bounds)`;
    return { name, ok: false, tris, bakeMs, coverage: 0 };
  }

  const coverage = atlasCoverage(impostor);

  // Build the impostor billboard on the RIGHT, centered at origin offset +sep.
  impostor.center.set(separation, 0, 0); // place impostor center on the right
  impostorMesh = makeImpostorMesh(impostor);
  // scale quad to the impostor radius via geometry corner already in [-1,1]*radius
  // handled in shader using uRadius; just position via uniforms already set.
  scene.add(impostorMesh);

  const ok = coverage > 0.01 && impostor.atlas != null;
  hud.innerHTML = `<b>${name}</b>\nmeshes tris: ${tris.toLocaleString()}\nbake: ${bakeMs.toFixed(1)} ms  grid 8x8 (64 views) @128px\natlas coverage: ${(coverage * 100).toFixed(1)}%\nresult: ${ok ? 'OK' : 'FAIL'}`;
  return { name, ok, tris, bakeMs, coverage };
}

async function init() {
  const names = await fetch('/glb_fixed-list.json').then((r) => r.json()).catch(() => []);
  pick.innerHTML = '';
  for (const n of names) {
    const b = document.createElement('button');
    b.textContent = n;
    b.onclick = () => run(n);
    pick.appendChild(b);
  }
  hud.textContent = `${names.length} models — click one, or use window.__impostor.run(name)`;
  if (names.length) run(names[0]);
  window.__impostor = { run, list: names, ready: true };
  window.__dbg = { scene, camera, renderer, get realRoot() { return realRoot; }, get impostorMesh() { return impostorMesh; }, THREE };
}
init();
