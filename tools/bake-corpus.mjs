#!/usr/bin/env node
// Resumable batch baker: walks a source asset tree and bakes every UNBAKED
// model into examples/local-progressive/output_<name> via bakeProgressive (the
// regular-glTF-loader-compatible progressive format). Skips assets already baked
// (output dir exists), isolates per-asset failures, and prints a summary.
//
//   node tools/bake-corpus.mjs [srcDir] [--plod] [--limit N]
//
// srcDir defaults to C:/dev/assets. --plod also emits the optional .plod sidecar
// (BAKE_PLOD=1). --limit caps how many are baked this run (for incremental runs).

import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeProgressive } from './bake-progressive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(repoRoot, 'examples/local-progressive');

const args = process.argv.slice(2);
const srcDir = path.resolve(args.find((a) => !a.startsWith('--')) || 'C:/dev/assets');
if (args.includes('--plod')) process.env.BAKE_PLOD = '1';
const limitArg = args.find((a) => a.startsWith('--limit'));
const LIMIT = limitArg ? Number(limitArg.split('=')[1] || args[args.indexOf(limitArg) + 1]) : Infinity;

const BAKEABLE = new Set(['.glb', '.gltf', '.vrm']); // .fbx is not supported by the gltf-transform pipeline

function walk(dir, acc, depth = 0) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 4) walk(fp, acc, depth + 1); continue; }
    const ext = path.extname(e.name).toLowerCase();
    if (BAKEABLE.has(ext)) acc.push({ path: fp, base: path.basename(e.name, ext), ext });
    else if (ext === '.fbx') acc.fbx = (acc.fbx || 0) + 1;
  }
}

const models = [];
models.fbx = 0;
walk(srcDir, models);
console.log(`[bake-corpus] src=${srcDir} found ${models.length} bakeable, ${models.fbx || 0} .fbx skipped (unsupported)`);

const summary = { total: models.length, baked: 0, skipped: 0, failed: 0, fbxSkipped: models.fbx || 0, failures: [] };
let count = 0;
for (const m of models) {
  if (summary.baked >= LIMIT) break;
  const outDir = path.join(OUT_ROOT, `output_${m.base}`);
  // Resumable: skip if already baked (root present).
  if (existsSync(path.join(outDir, 'model.progressive.glb'))) { summary.skipped++; continue; }
  count++;
  try {
    await bakeProgressive(m.path, outDir);
    summary.baked++;
    if (summary.baked % 10 === 0) console.log(`[bake-corpus] progress: baked=${summary.baked} skipped=${summary.skipped} failed=${summary.failed}`);
  } catch (e) {
    summary.failed++;
    summary.failures.push({ asset: m.base, error: String(e && e.message || e).slice(0, 200) });
    console.warn(`[bake-corpus] FAILED ${m.base}: ${String(e && e.message || e).slice(0, 200)}`);
  }
}

writeFileSync(path.join(OUT_ROOT, 'bake-corpus-summary.json'), JSON.stringify(summary, null, 2));
console.log(`[bake-corpus] DONE baked=${summary.baked} skipped=${summary.skipped} failed=${summary.failed} (summary -> output_*/.. bake-corpus-summary.json)`);
