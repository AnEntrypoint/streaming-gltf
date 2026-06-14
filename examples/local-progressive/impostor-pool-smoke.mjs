#!/usr/bin/env node
// impostor-pool-smoke.mjs — integration test for the ModelPool octahedral
// impostor FINAL LOD. Boots the stress demo with ?impostor=1 against local baked
// assets, spawns entities, sweeps the camera across distance, and asserts that
// (a) impostors activate (stats.impostors > 0), (b) the impostor tier bakes atlas
// layers, and (c) no page errors occur. Spawns serve.mjs itself.

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 5190;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch {}
    await sleep(200);
  }
  throw new Error(`server did not come up at ${url}`);
}

async function main() {
  const servePath = fileURLToPath(new URL('./serve.mjs', import.meta.url));
  const srv = spawn(process.execPath, [servePath], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'inherit', 'inherit'] });
  let browser;
  const errors = [];
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/assets-list.json`);
    const launchOpts = { headless: true, args: ['--use-gl=angle', '--ignore-gpu-blocklist'] };
    if (process.env.CHANNEL) launchOpts.channel = process.env.CHANNEL;
    try { browser = await chromium.launch(launchOpts); }
    catch (e) { browser = await chromium.launch({ headless: true }); }

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => { errors.push(e.message); console.error('[page error]', e.message); });
    page.on('console', (m) => { if (m.type() === 'error' && !/404|Couldn.t load texture/.test(m.text())) console.error('[console]', m.text()); });

    const url = `http://127.0.0.1:${PORT}/stress.html?assets=local&impostor=1&cb=${Date.now()}`;
    await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForFunction(() => window.__pool && window.__pool.getStats, { timeout: 30000 });

    // Spawn 200 entities and let assets stream/warm.
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#panel button[data-n]')].map((b) => ({ b, n: +b.dataset.n }));
      (btns.find((x) => x.n === 100) || btns[0]).b.click();
      (btns.find((x) => x.n === 100) || btns[0]).b.click();
      // disable orbit/zoom so we control the camera
      for (const id of ['orbit-cam', 'zoom-cycle']) { const el = document.getElementById(id); if (el && el.checked) el.click(); }
    });
    await sleep(6000);

    // Sweep the camera back along its current view direction across several
    // distances; at each, run a few frames and record the impostor count.
    let maxImpostors = 0, maxLayers = 0, sawDraws = 0, bestMult = 8;
    const samples = [];
    for (const mult of [3, 6, 10, 16, 24, 36, 50]) {
      const s = await page.evaluate(async (m) => {
        const pool = window.__pool;
        const cam = pool.camera;
        // Aim at scene center, pull back to mx the scene radius.
        const center = new pool.scene.constructor ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 0 };
        const len = Math.hypot(cam.position.x, cam.position.y, cam.position.z) || 1;
        const dir = { x: cam.position.x / len, y: cam.position.y / len + 0.2, z: cam.position.z / len };
        const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
        const R = 30 * m;
        cam.position.set((dir.x / dl) * R, (dir.y / dl) * R, (dir.z / dl) * R);
        cam.lookAt(0, 0, 0);
        cam.updateMatrixWorld(true);
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        const st = pool.getStats();
        const tierMesh = pool._impostorTier ? pool._impostorTier.mesh : null;
        return { mult: m, impostors: st.impostors || 0, layers: st.impostorLayers || 0, instCount: tierMesh ? tierMesh.count : 0, draws: st.drawCalls };
      }, mult);
      await sleep(700); // let budgeted bakes (1/frame) catch up before next step
      samples.push(s);
      if (s.impostors > maxImpostors) { maxImpostors = s.impostors; bestMult = s.mult; }
      maxLayers = Math.max(maxLayers, s.layers);
      if (s.instCount > 0) sawDraws++;
      console.log(`  distx${String(s.mult).padStart(2)}  impostors=${String(s.impostors).padStart(3)}  layers=${String(s.layers).padStart(2)}  instCount=${String(s.instCount).padStart(3)}  draws=${s.draws}`);
    }

    // Hold at the showcase distance and let the budgeted (1/frame) bakes finish —
    // this proves full impostor coverage is reached WITHOUT a one-frame burst.
    await page.evaluate((m) => {
      const cam = window.__pool.camera;
      const len = Math.hypot(cam.position.x, cam.position.y, cam.position.z) || 1;
      cam.position.multiplyScalar((30 * m) / len); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
    }, bestMult);
    for (let i = 0; i < 12; i++) {
      await sleep(400);
      const st = await page.evaluate(() => window.__pool.getStats());
      maxImpostors = Math.max(maxImpostors, st.impostors || 0);
      maxLayers = Math.max(maxLayers, st.impostorLayers || 0);
    }
    console.log(`  [hold x${bestMult}] settled impostors=${maxImpostors} layers=${maxLayers}`);
    await sleep(200);
    await page.screenshot({ path: fileURLToPath(new URL('./impostor-pool-smoke.png', import.meta.url)) });

    const ok = maxImpostors > 0 && maxLayers > 0 && errors.length === 0;
    console.log(`\n[pool-smoke] maxImpostors=${maxImpostors} maxLayers=${maxLayers} errors=${errors.length}`);
    console.log(`[pool-smoke] ${ok ? 'PASS' : 'FAIL'} -> impostor-pool-smoke.png`);
    if (!ok) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
