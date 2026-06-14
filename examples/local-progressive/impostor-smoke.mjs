#!/usr/bin/env node
// impostor-smoke.mjs — bake an octahedral impostor for every "difficult GLB" in
// the corpus and assert each produces a non-empty atlas + renders.
//
// Self-contained: spawns serve.mjs (which mounts /glb_fixed/ from GLB_FIXED_DIR,
// default C:/dev/maps/output/glb_fixed), drives impostor-test.html headless, and
// for each model calls window.__impostor.run(name) -> { ok, tris, bakeMs, coverage }.
//
// Usage:
//   node examples/local-progressive/impostor-smoke.mjs
//   CHANNEL=chrome node examples/local-progressive/impostor-smoke.mjs   # hardware GPU
//
// Exit code is non-zero if any model fails (coverage <= 1% or bake error).

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 5181; // distinct from the stress demo default
const PAGE_URL = `http://127.0.0.1:${PORT}/impostor-test.html`;
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
  const srv = spawn(process.execPath, [servePath], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/glb_fixed-list.json`);

    const launchOpts = { headless: true, args: ['--use-gl=angle', '--ignore-gpu-blocklist'] };
    if (process.env.CHANNEL) launchOpts.channel = process.env.CHANNEL;
    try { browser = await chromium.launch(launchOpts); }
    catch (e) { console.warn(`[smoke] channel launch failed (${e.message}); bundled Chromium`); browser = await chromium.launch({ headless: true }); }

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__impostor && window.__impostor.ready, { timeout: 30000 });
    const list = await page.evaluate(() => window.__impostor.list);
    console.log(`[smoke] ${list.length} models in corpus\n`);

    const renderer = await page.evaluate(() => {
      try {
        const gl = document.querySelector('canvas').getContext('webgl2');
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'no-debug-ext';
      } catch (e) { return 'err'; }
    });

    const results = [];
    for (const name of list) {
      let r;
      try {
        r = await page.evaluate((n) => window.__impostor.run(n), name);
      } catch (e) {
        r = { name, ok: false, error: String(e.message || e), coverage: 0, tris: 0, bakeMs: 0 };
      }
      await sleep(120); // let a frame render for the screenshot path
      results.push(r);
      const tag = r.ok ? 'OK ' : 'FAIL';
      console.log(`  [${tag}] ${name.padEnd(34)} tris=${String(r.tris).padStart(7)}  bake=${(r.bakeMs || 0).toFixed(0).padStart(4)}ms  coverage=${((r.coverage || 0) * 100).toFixed(1)}%${r.error ? '  err=' + r.error : ''}`);
    }

    await page.screenshot({ path: fileURLToPath(new URL('./impostor-smoke.png', import.meta.url)) });

    const passed = results.filter((r) => r.ok).length;
    const report = { ts: new Date().toISOString(), renderer, total: results.length, passed, results };
    writeFileSync(fileURLToPath(new URL('./impostor-smoke.json', import.meta.url)), JSON.stringify(report, null, 2));
    console.log(`\n[smoke] renderer: ${renderer}`);
    console.log(`[smoke] ${passed}/${results.length} passed -> impostor-smoke.json, impostor-smoke.png`);
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
