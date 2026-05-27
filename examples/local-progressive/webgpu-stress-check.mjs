#!/usr/bin/env node
// webgpu-stress-check.mjs — boots stress.html?backend=webgpu in real Chrome,
// spawns entities, and confirms the WebGPU backend renders the actual pool scene
// (not capped at 14s like the browser verb). Reports backend + a steady FPS.
//   CHANNEL=chrome node examples/local-progressive/webgpu-stress-check.mjs [count]
import { chromium } from 'playwright';
const PORT = process.env.PORT || 5180;
const N = Number(process.argv[2] || 500);
const URL = `http://localhost:${PORT}/stress.html?backend=webgpu&cb=${Date.now()}`;
const browser = await chromium.launch({
  channel: process.env.CHANNEL || undefined, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'],
});
const page = await browser.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__pool && window.__pool.getStats, { timeout: 30000 });
  // turn off orbit/zoom for a stable still frame; spawn N
  await page.evaluate((n) => {
    const o=document.getElementById('orbit-cam'); if(o&&o.checked)o.click();
    const z=document.getElementById('zoom-cycle'); if(z&&z.checked)z.click();
    const btns=[...document.querySelectorAll('#panel button[data-n]')].map(b=>({b,n:+b.dataset.n})).sort((a,z)=>z.n-a.n);
    let rem=n; while(rem>0&&btns.length){const x=btns.find(y=>y.n<=rem)||btns[btns.length-1];x.b.click();rem-=x.n;}
  }, N);
  await page.waitForFunction(() => (window.__pool.getStats().inFlight||0)===0, { timeout: 45000 }).catch(()=>{});
  await page.waitForTimeout(2000);
  // sample fps a few times
  const samples = [];
  for (let i=0;i<20;i++){ samples.push(await page.evaluate(()=>window.__pool.getStats().fps)); await page.waitForTimeout(100); }
  samples.sort((a,b)=>a-b);
  const med = samples[samples.length>>1];
  const info = await page.evaluate(() => { const s=window.__pool.getStats(); return { backend: window.__backend, entities: window.__pool._entities.size, visible: s.visible, far: s.far }; });
  console.log('WEBGPU_STRESS ' + JSON.stringify({ ...info, medianFps:+med.toFixed(1), jsErrors: errs.filter(e=>e.includes('PAGEERR')).slice(0,5), n404: errs.filter(e=>e.includes('404')).length }));
} catch (e) {
  console.log('STRESS_RUNNER_ERROR ' + String(e && e.stack || e));
} finally { await browser.close(); }
