#!/usr/bin/env node
// webgpu-probe.mjs — feasibility probe for the WebGPU render path.
// Loads webgpu-probe.html in real Chrome (CHANNEL=chrome, hardware WebGPU) and
// reports whether a WebGPURenderer can render a scene built with the standard
// three module's Mesh/Material/BatchedMesh. This is the make-or-break check
// for the dual-backend architecture. Not capped at 14s like the browser verb.
//
//   CHANNEL=chrome node examples/local-progressive/webgpu-probe.mjs
//
// Requires the dev server running (node serve.mjs) on PORT (default 5180).
import { chromium } from 'playwright';

const PORT = process.env.PORT || 5180;
const URL = `http://localhost:${PORT}/webgpu-probe.html?cb=${Date.now()}`;
const channel = process.env.CHANNEL || undefined;

const browser = await chromium.launch({
  channel,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'],
});
const page = await browser.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__probe, { timeout: 30000 }).catch(() => {});
  const probe = await page.evaluate(() => window.__probe || { err: 'no __probe set within 30s' });
  console.log('WEBGPU_PROBE ' + JSON.stringify({ ...probe, consoleErrors: errs.slice(0, 8) }, null, 2));
} catch (e) {
  console.log('PROBE_RUNNER_ERROR ' + String(e && e.stack || e));
} finally {
  await browser.close();
}
