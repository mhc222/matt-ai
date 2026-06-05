import { randomUUID } from 'node:crypto';
import { pipeline } from 'stream/promises';
import { requireAuth } from '../plugins/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { r2, uploadUrl, downloadUrl } from '../lib/r2.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { enqueueClip } from '../queue/index.js';
import { config } from '../config/env.js';

export default async function clipRoutes(app) {
  // Step 1: Extension gets presigned R2 URL + clipId (no file upload yet)
  app.post('/clips/presign', async (req, reply) => {
    let userId;
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === config.uploadApiKey) {
      userId = config.uploadTestUserId;
    } else {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { outcomeTag = null, clipType = 'hitting', position = null } = req.body ?? {};
    const clipId = randomUUID();
    const key = `raw/${userId}/${clipId}.mp4`;
    const putUrl = await uploadUrl(key);
    const { error: dbErr } = await supabaseAdmin.from('clips').insert({
      id: clipId, user_id: userId, source_key: key,
      outcome_tag: outcomeTag, status: 'pending',
    });
    if (dbErr) return reply.code(500).send({ error: dbErr.message });
    return { clipId, uploadUrl: putUrl };
  });

  // Step 2: Extension calls this after R2 upload completes
  app.post('/clips/:id/enqueue', async (req, reply) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== config.uploadApiKey) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params;
    const { error: dbErr } = await supabaseAdmin.from('clips')
      .update({ status: 'pending' }).eq('id', id);
    if (dbErr) return reply.code(500).send({ error: dbErr.message });
    const { data: clip } = await supabaseAdmin.from('clips').select('source_key,outcome_tag').eq('id', id).single();
    await enqueueClip(id, clip.source_key, clip.outcome_tag, 'hitting', null);
    return { status: 'queued' };
  });


  // Direct upload from share extension: multipart video → R2 → Supabase → queue
  // Auth: Bearer JWT (Supabase) OR X-Api-Key header (for testing)
  app.post('/clips/upload', async (req, reply) => {
    // Auth: try JWT first, fall back to API key
    let userId;
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === config.uploadApiKey) {
      userId = config.uploadTestUserId;
    } else {
      try {
        await requireAuth(req, reply);
        userId = req.user.id;
      } catch {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    }

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no file' });

    const clipId = randomUUID();
    const key = `raw/${userId}/${clipId}.mp4`;

    const chunks = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    await r2.send(new PutObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
      Body: buffer,
      ContentType: 'video/mp4',
      ContentLength: buffer.length,
    }));

    const outcomeTag = req.body?.outcomeTag ?? null;
    const clipType   = req.body?.clipType   ?? 'hitting';
    const position   = req.body?.position   ?? null;

    const { error: dbErr } = await supabaseAdmin.from('clips').insert({
      id: clipId,
      user_id: userId,
      source_key: key,
      outcome_tag: outcomeTag,
      status: 'pending',
    });
    if (dbErr) return reply.code(500).send({ error: dbErr.message });

    await enqueueClip(clipId, key, outcomeTag, clipType, position);

    return { clipId, status: 'queued' };
  });
  // 1) App requests a place to upload the raw video.
  app.post('/clips/upload-url', { preHandler: requireAuth }, async (req, reply) => {
    const clipId = randomUUID();
    const key = `raw/${req.user.id}/${clipId}.mp4`;

    const { error } = await supabaseAdmin.from('clips').insert({
      id: clipId,
      user_id: req.user.id,
      source_key: key,
      status: 'awaiting_upload',
    });
    if (error) return reply.code(500).send({ error: error.message });

    const url = await uploadUrl(key);
    return { clipId, key, uploadUrl: url };
  });

  // 2) After upload finishes, kick off detect -> trim.
  app.post('/clips/:id/process', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const { data: clip, error } = await supabaseAdmin
      .from('clips').select('*').eq('id', id).eq('user_id', req.user.id).single();
    if (error || !clip) return reply.code(404).send({ error: 'clip not found' });

    await supabaseAdmin.from('clips').update({ status: 'queued' }).eq('id', id);
    await enqueueClip(clip.id, clip.source_key);
    return { clipId: id, status: 'queued' };
  });

  // 3) List the user's clips, newest first.
  app.get('/clips', { preHandler: requireAuth }, async (req, reply) => {
    const { data, error } = await supabaseAdmin
      .from('clips').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) return reply.code(500).send({ error: error.message });
    return { clips: data };
  });

  // 4) One clip plus a temporary playable URL for the finished highlight.
  app.get('/clips/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const { data: clip, error } = await supabaseAdmin
      .from('clips').select('*').eq('id', id).eq('user_id', req.user.id).single();
    if (error || !clip) return reply.code(404).send({ error: 'clip not found' });

    const playbackUrl = clip.output_key ? await downloadUrl(clip.output_key) : null;
    return { clip, playbackUrl };
  });
}
