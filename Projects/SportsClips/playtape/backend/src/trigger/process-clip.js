import { task, logger } from '@trigger.dev/sdk';
import { supabaseAdmin } from '../lib/supabase.js';
import { downloadAndAnalyze } from '../lib/gemini.js';
import { processClip } from '../lib/ffmpeg.js';

export const processClipTask = task({
  id: 'process-clip',
  maxDuration: 300,
  run: async ({ clipId, sourceKey, outcomeTag = null, clipType = 'hitting', position = null }) => {
    logger.log('step 1: mark processing', { clipId });
    await supabaseAdmin.from('clips').update({ status: 'processing' }).eq('id', clipId);

    logger.log('step 2: analyze', { sourceKey, clipType });
    const result = await downloadAndAnalyze(sourceKey, outcomeTag, clipType, position);
    const tp = result.terminal_play ?? {};
    const rt = result.recommended_trim ?? {};
    logger.log('step 2 done', { outcome: tp.outcome });

    logger.log('step 3: processClip');
    const outputKey = await processClip(sourceKey, result, clipType);
    logger.log('step 3 done', { outputKey });

    await supabaseAdmin
      .from('clips')
      .update({
        status: 'done',
        output_key: outputKey,
        clip_type: clipType,
        position,
        detected_label: tp.outcome ?? null,
        confidence: tp.matches_provided_tag ? 1.0 : 0.8,
        start_sec: rt.start_sec ?? null,
        end_sec: rt.end_sec ?? null,
        caption: result.caption ?? null,
      })
      .eq('id', clipId);

    return { clipId, outputKey, outcome: tp.outcome };
  },
});
