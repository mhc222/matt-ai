import { execFile } from 'child_process';
import { promisify } from 'util';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { pipeline } from 'stream/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { r2 } from './r2.js';
import { config } from '../config/env.js';

const execFileAsync = promisify(execFile);

// Per-mode padding and hard duration caps
export const LEAD_IN  = { hitting: 0.5,  pitching: 3.5,  fielding: 0.8 };
export const TAIL     = { hitting: 2.5,  pitching: 0.5,  fielding: 4.0 };
export const MAX_SECS = { hitting: 12,   pitching: 10,   fielding: 12  };

/**
 * Detect the first scene change — reliably marks end of GameChanger title card.
 * Returns timestamp in seconds, or 0 if not found.
 */
export async function findGameplayStart(filePath, threshold = 0.25) {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-i', filePath,
    '-vf', `select=gt(scene\\,${threshold}),showinfo`,
    '-vsync', 'vfr',
    '-f', 'null', '-',
  ]).catch(e => ({ stderr: e.stderr ?? '' })); // ffmpeg exits non-zero with -f null

  for (const line of stderr.split('\n')) {
    if (line.includes('showinfo') && line.includes('pts_time:')) {
      for (const token of line.split(/\s+/)) {
        if (token.startsWith('pts_time:')) {
          const t = parseFloat(token.split(':')[1]);
          if (!isNaN(t)) return t;
        }
      }
    }
  }
  return 0;
}

/**
 * Generate a 720p/2Mbps proxy for AI analysis.
 * Proxy has identical duration/timestamps to the raw — safe to apply AI trim
 * results directly to the raw clip.
 */
export async function generateProxy(inputPath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-y', '-i', inputPath,
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-b:v', '2000k', '-maxrate', '2500k', '-bufsize', '4000k',
    '-c:a', 'aac', '-b:a', '128k',
    '-r', '30',  // keep 30fps — needed for accurate timestamp mapping
    outputPath,
  ]);
}

/**
 * Frame-accurate ffmpeg cut. Re-encodes for precision on short clips.
 */
export async function trimVideo(inputPath, startSec, endSec, outputPath) {
  await execFileAsync('ffmpeg', [
    '-y', '-i', inputPath,
    '-ss', startSec.toFixed(2),
    '-to', endSec.toFixed(2),
    '-c:v', 'libx264', '-c:a', 'aac',
    outputPath,
  ]);
}

/**
 * Returns the timestamp (seconds) when significant audio activity last ended.
 * Uses ffmpeg silencedetect — the last silence_start = end of crowd/play noise.
 * Returns null if no silence detected (whole clip is loud) or on error.
 */
export async function detectLastAudioActivity(filePath) {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-i', filePath,
    '-af', 'silencedetect=n=-25dB:d=0.3',
    '-f', 'null', '-',
  ]).catch(e => ({ stderr: e.stderr ?? '' }));

  const matches = [...stderr.matchAll(/silence_start: ([\d.]+)/g)];
  if (matches.length === 0) return null;
  return parseFloat(matches.at(-1)[1]);
}

export async function getVideoDuration(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new Error(`Could not read video duration for ${filePath}`);
  }
  return duration;
}

/**
 * Full pipeline: download from R2, detect GC card, trim, upload highlight to R2.
 * Returns the output R2 key.
 */
/**
 * Full pipeline:
 * 1. Download raw clip from R2
 * 2. Generate 720p proxy → AI analysis runs on proxy (fast, cheap)
 * 3. Apply AI timestamps to RAW clip → full-quality highlight
 * 4. Upload highlight to R2
 * Timestamps are identical between proxy and raw (same duration, same fps).
 */
export async function processClip(sourceKey, result, clipType = 'hitting') {
  const ts = Date.now();
  const tmpRaw   = path.join(os.tmpdir(), `playtape-raw-${ts}.mp4`);
  const tmpProxy = path.join(os.tmpdir(), `playtape-proxy-${ts}.mp4`);
  const tmpOut   = path.join(os.tmpdir(), `playtape-out-${ts}.mp4`);
  const outputKey = sourceKey.replace(/^raw\//, 'highlights/').replace(/\.mp4$/i, '-highlight.mp4');

  console.log(`[ffmpeg] downloading raw ${sourceKey}...`);
  const dlRes = await r2.send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: sourceKey }));
  await pipeline(dlRes.Body, fs.createWriteStream(tmpRaw));

  try {
    const rt = result.recommended_trim ?? {};
    const leadIn  = LEAD_IN[clipType]  ?? LEAD_IN.hitting;
    const tail    = TAIL[clipType]    ?? TAIL.hitting;
    const maxSecs = MAX_SECS[clipType] ?? MAX_SECS.hitting;
    let start = Math.max(0, (rt.start_sec ?? 0) - leadIn);
    let end = (rt.end_sec ?? 0) + tail;

    if (end - start > maxSecs) {
      end = start + maxSecs;
      console.log(`[ffmpeg] capped to ${maxSecs}s for ${clipType}`);
    }

    // GC card floor — run scene detection on raw (proxy not yet generated)
    const gameplayStart = await findGameplayStart(tmpRaw);
    if (gameplayStart > 0) {
      console.log(`[ffmpeg] gameplay at ${gameplayStart.toFixed(2)}s`);
      start = Math.max(start, gameplayStart);
    }

    if (end <= start) {
      throw new Error(`[ffmpeg] invalid trim: start(${start.toFixed(2)}) >= end(${end.toFixed(2)}) — bogus Gemini timestamps`);
    }

    // Cut from RAW → full quality highlight
    console.log(`[ffmpeg] trimming raw ${start.toFixed(2)}s -> ${end.toFixed(2)}s`);
    await trimVideo(tmpRaw, start, end, tmpOut);

    console.log(`[ffmpeg] uploading highlight...`);
    await r2.send(new PutObjectCommand({
      Bucket: config.r2.bucket,
      Key: outputKey,
      Body: fs.createReadStream(tmpOut),
      ContentType: 'video/mp4',
    }));

    return outputKey;
  } finally {
    for (const f of [tmpRaw, tmpProxy, tmpOut]) fs.unlink(f, () => {});
  }
}
