#!/usr/bin/env node
/**
 * test-job.js — end-to-end pipeline test
 *
 * Usage:
 *   node test-job.js /path/to/clip.mp4 "outcome"
 *   node test-job.js /path/to/clip.mp4            # outcome inferred by Gemini
 *
 * What it does:
 *   1. Upload clip to Supabase Storage (raw/)
 *   2. Insert a clips row (status: pending)
 *   3. Enqueue a BullMQ job
 *   4. Poll until status = done | failed
 *   5. Print result + highlight storage path
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createReadStream, statSync } from 'fs';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2 } from './src/lib/r2.js';
import path from 'path';
import { enqueueClip } from './src/queue/index.js';
import IORedis from 'ioredis';

const BUCKET = 'playtape-videos';
const TEST_EMAIL = 'test-worker@playtape.local';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function poll(clipId, intervalMs = 5000, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from('clips')
      .select('status, output_key, detected_label, caption, start_sec, end_sec')
      .eq('id', clipId)
      .single();
    if (error) throw error;
    process.stdout.write(`\r[poll] status=${data.status}   `);
    if (data.status === 'done' || data.status === 'failed') {
      process.stdout.write('\n');
      return data;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for clip to finish');
}

async function main() {
  const [,, clipPath, outcomeTag, clipType = 'hitting', position = null] = process.argv;
  if (!clipPath) {
    console.error('Usage: node test-job.js <clip.mp4> [outcome] [clipType] [position]');
    console.error('  clipType: hitting|pitching|fielding  (default: hitting)');
    process.exit(1);
  }

  // 0. Get or create test user
  let testUserId;
  const { data: existing } = await supabase.auth.admin.listUsers();
  const found = existing?.users?.find(u => u.email === TEST_EMAIL);
  if (found) {
    testUserId = found.id;
    console.log(`[auth] using existing test user ${testUserId}`);
  } else {
    const { data: created, error: authErr } = await supabase.auth.admin.createUser({
      email: TEST_EMAIL,
      password: 'test-password-123',
      email_confirm: true,
    });
    if (authErr) throw authErr;
    testUserId = created.user.id;
    console.log(`[auth] created test user ${testUserId}`);
  }

  const filename = path.basename(clipPath);
  const storageKey = `raw/test/${Date.now()}-${filename}`;

  // 1. Upload to R2
  console.log(`[upload] ${storageKey}...`);
  const fileSize = statSync(clipPath).size;
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET ?? 'playtape-videos',
    Key: storageKey,
    Body: createReadStream(clipPath),
    ContentType: 'video/mp4',
  }));
  console.log(`[upload] done (${(fileSize / 1e6).toFixed(1)} MB)`);

  // 2. Insert clip row
  const { data: clip, error: insErr } = await supabase
    .from('clips')
    .insert({
      user_id: testUserId,
      status: 'pending',
      source_key: storageKey,
      outcome_tag: outcomeTag ?? null,
    })
    .select('id')
    .single();
  if (insErr) throw insErr;
  console.log(`[db] clip inserted id=${clip.id}`);

  // 3. Enqueue
  // Flush stale BullMQ state before enqueuing — prevents ghost jobs from old runs
  const redis = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
  await redis.del('bull:video-processing:wait', 'bull:video-processing:active');
  await redis.quit();

  await enqueueClip(clip.id, storageKey, outcomeTag ?? null, clipType, position);
  console.log('[queue] job enqueued — worker will pick it up...\n');

  // 4. Poll
  const result = await poll(clip.id);

  // 5. Report
  if (result.status === 'failed') {
    console.error('[FAILED] check worker logs');
    process.exit(1);
  }

  console.log('\n✓ DONE');
  console.log(`  outcome   : ${result.detected_label}`);
  console.log(`  trim      : ${result.start_sec}s → ${result.end_sec}s`);
  console.log(`  highlight : ${result.output_key}`);
  console.log(`  caption   : ${result.caption}`);

  // Signed URL to view highlight from R2
  const previewUrl = await getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET ?? 'playtape-videos', Key: result.output_key }),
    { expiresIn: 3600 },
  );
  console.log(`\n  preview URL (1hr):\n  ${previewUrl}`);

  process.exit(0);
}

main().catch(err => { console.error('[error]', err.message); process.exit(1); });
