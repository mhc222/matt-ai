#!/usr/bin/env node
/**
 * Full local pipeline test — no R2, no queue, no Supabase.
 * Analysis + trim → output file saved locally.
 * Usage: node test-local-pipeline.js <clip.mp4> [outcomeTag] [clipType]
 */
import 'dotenv/config';
import { generateProxy, trimVideo, findGameplayStart, LEAD_IN, TAIL, MAX_SECS } from './src/lib/ffmpeg.js';
import { analyzeAtBat } from './src/lib/gemini.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const [,, clipPath, outcomeTag = null, clipType = 'pitching'] = process.argv;
if (!clipPath) {
  console.error('Usage: node test-local-pipeline.js <clip.mp4> [outcomeTag] [clipType]');
  process.exit(1);
}

// LEAD_IN, TAIL, MAX_SECS imported from ffmpeg.js — single source of truth

const ts = Date.now();
const tmpProxy = path.join(os.tmpdir(), `playtape-lp-proxy-${ts}.mp4`);
const outFile  = path.join(os.homedir(), `Desktop/playtape-highlight-${ts}.mp4`);

console.log(`[test] clip=${clipPath} outcome=${outcomeTag} type=${clipType}`);
console.log(`[test] generating proxy...`);
await generateProxy(clipPath, tmpProxy);
console.log(`[test] proxy ready (${(fs.statSync(tmpProxy).size / 1e6).toFixed(1)}MB)`);

console.log(`[test] analyzing...`);
const result = await analyzeAtBat(tmpProxy, outcomeTag, clipType);

const rt = result.recommended_trim ?? {};
const tp = result.terminal_play ?? {};
console.log(`\n[test] outcome=${tp.outcome}  trim=${rt.start_sec}s -> ${rt.end_sec}s`);
console.log(`[test] caption: ${result.caption}`);

const leadIn  = LEAD_IN[clipType]  ?? LEAD_IN.hitting;
const tail    = TAIL[clipType]    ?? TAIL.hitting;
const maxSecs = MAX_SECS[clipType] ?? MAX_SECS.hitting;

let start = Math.max(0, (rt.start_sec ?? 0) - leadIn);
let end   = (rt.end_sec ?? 0) + tail;
if (end - start > maxSecs) {
  end = start + maxSecs;
  console.log(`[test] capped to ${maxSecs}s`);
}

const gameplayStart = await findGameplayStart(clipPath);
if (gameplayStart > 0) {
  console.log(`[test] gameplay starts at ${gameplayStart.toFixed(2)}s`);
  start = Math.max(start, gameplayStart);
}

console.log(`[test] trimming RAW: ${start.toFixed(2)}s -> ${end.toFixed(2)}s`);
await trimVideo(clipPath, start, end, outFile);

fs.unlink(tmpProxy, () => {});

console.log(`\n✓ DONE`);
console.log(`  output: ${outFile}`);
console.log(`  duration: ${(end - start).toFixed(2)}s`);
console.log(`  outcome: ${tp.outcome}`);
console.log(`  caption: ${result.caption}`);
