import { tasks } from '@trigger.dev/sdk/v3';

// Hand one clip to the detect-then-trim pipeline.
export function enqueueClip(clipId, sourceKey, outcomeTag = null, clipType = 'hitting', position = null) {
  return tasks.trigger('process-clip', { clipId, sourceKey, outcomeTag, clipType, position });
}
