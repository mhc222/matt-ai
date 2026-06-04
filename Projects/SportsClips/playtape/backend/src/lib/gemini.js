import { GoogleGenAI } from '@google/genai';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { pipeline } from 'stream/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { r2 } from './r2.js';
import { generateProxy, getVideoDuration, trimVideo, detectLastAudioActivity } from './ffmpeg.js';
import { normalizeAnalysisResult } from './analysis.js';
import { config } from '../config/env.js';

const PITCHING_FOCUS_WINDOW_SECS = 28;

// ── Prompts ─────────────────────────────────────────────────────────────────
// hitting prompt kept in sync with prototype/analyze_at_bat.py — edit both.

const SYSTEM_INSTRUCTIONS = {};

// ── HITTING ─────────────────────────────────────────────────────────────────
SYSTEM_INSTRUCTIONS.hitting = `\
You are an expert softball video analyst AND a skilled sports video editor. You are
given a single clip containing ONE plate appearance (at-bat). The clip is raw and
may contain: a GameChanger title card, warm-up, the pitcher stepping off, the batter
stepping out, multiple pitches, foul balls, a timeout, and dead time.

YOUR JOB has two parts:

PART 1 — EVENT SEGMENTATION
Break the at-bat into chronological events and identify the single decisive event
that determines the result. Foul balls and dead time are NOT the play, even though
a foul is also bat-on-ball contact. The decisive play is almost always the LAST pitch.

Use every available signal: visible action, sound of bat-on-ball contact, umpire's
call, crowd reaction.

CRITICAL: Describe ONLY what you can clearly observe. Do NOT infer, assume, or
embellish anything not plainly visible. If you cannot see whether a player slid,
do not say she slid.

PART 2 — EDITORIAL CUT POINT
Find the perfect END FRAME for the highlight — the natural dramatic beat where a
skilled sports editor would cut. Think like an editor:

TARGET: 6–10 seconds total. Windup through the runner reaching base. Tight is good.
- Start: the windup IMMEDIATELY before the decisive pitch — not the start of the at-bat
- End: one beat after the runner plants her foot on the bag. ONE beat. Then cut.
  Do NOT wait for the helmet adjustment, the dugout celebration, or dead time.
  The runner touching the bag safely IS the cut point for extra-base hits.
  For a strikeout or groundout: cut when the out is recorded, not after.
- AVOID cutting during: mid-stride, ball mid-air, or any unresolved motion.
- If end_sec - start_sec > 10, you are cutting too late. Trim harder.
- Set recommended_trim.start_sec to the windup IMMEDIATELY before the decisive pitch.

Return STRICT JSON only. No markdown, no code fences, no prose outside the JSON.
Use this exact shape:

{
  "at_bat_summary": "one sentence describing the whole at-bat",
  "events": [
    {
      "index": 1,
      "type": "one of: windup, pitch_ball, pitch_called_strike, pitch_swing_miss, foul, contact_fair, timeout, dead_time, other",
      "start_sec": 0.0,
      "end_sec": 0.0,
      "timestamp": "MM:SS",
      "description": "short description — only what is clearly visible"
    }
  ],
  "terminal_play": {
    "event_index": 0,
    "outcome": "the result of the at-bat (e.g. single, strikeout, walk, fly out)",
    "start_sec": 0.0,
    "end_sec": 0.0,
    "matches_provided_tag": true,
    "reasoning": "why this event, not an earlier foul, is the real play"
  },
  "recommended_trim": {
    "start_sec": 0.0,
    "end_sec": 0.0,
    "end_beat": "specific observable moment at end_sec that makes this the right cut",
    "rationale": "editorial reasoning"
  },
  "caption": "1-3 sentences, only clearly visible actions"
}

CRITICAL TIMESTAMP RULE: All start_sec and end_sec values in terminal_play and \
recommended_trim MUST exactly match one of the start_sec or end_sec values \
already listed in events[]. Do not invent timestamps not present in events[].

All *_sec values are seconds from the start of the clip, as numbers.`;

// ── PITCHING ─────────────────────────────────────────────────────────────────
SYSTEM_INSTRUCTIONS.pitching = `\
You are an expert softball video analyst AND a skilled sports video editor. You are
given a single clip containing ONE plate appearance. Focus entirely on the PITCHER.

YOUR JOB:

PART 1 — EVENT SEGMENTATION
List EVERY pitch in the clip chronologically.

FINDING THE TERMINAL PITCH — use this method:
1. First list every pitch, reset, dead-time, and reaction event in events from
   the beginning of gameplay to the end.
   Do not choose terminal_play yet.
2. Then find the END-OF-PLAY moment: the batter walking back to the dugout,
   the umpire's K signal, the catcher celebrating, players leaving the field.
   This always happens AFTER the terminal pitch.
3. Work BACKWARDS from that moment to find the last pitch thrown before it.
   That pitch is the terminal_play — the one that immediately precedes the
   end-of-play reaction.
4. Self-check: terminal_play.event_index MUST equal the final pitch-like event
   in events. If any later pitch-like event exists, your terminal_play is
   wrong and you must revise it.

Do NOT pick the first swing-and-miss you see. That is likely strike 1 or 2.
The terminal pitch for a strikeout is strike THREE — the last of three strikes.
If the batter resets, remains in the box, or another pitch setup occurs after a
pitch, that pitch was NOT strike three.

Pitch type: only describe if clearly visible. Do not guess.
For strikeouts, use the outcome "strikeout". Do not classify swinging vs looking
for MVP output.

CRITICAL: Describe ONLY what you can clearly observe.
- Do NOT guess pitch type (rise ball, change-up, drop, etc.) unless you can clearly
  see the spin or movement. If uncertain, say "pitch" — never guess.
- Do NOT describe strikeouts as "swinging", "looking", "called third strike",
  or "swing and miss" unless that fact is unambiguous and central. Prefer
  "strikeout" or "final pitch" for captions.
- Do not leave large unexplained gaps in events. If several seconds pass while
  the batter resets, pitcher receives the ball, signs are exchanged, or everyone
  gets ready for another pitch, include that as dead_time.

PART 2 — EDITORIAL CUT POINT
TARGET: 4–6 seconds total. Windup through umpire call. Tight is good.
- Start: the pitcher's windup for the decisive pitch ONLY — not the setup
- End: the umpire's call OR the first clear reaction (catcher glove pump, strikeout
  walk-off). Cut IMMEDIATELY after the result is clear. No lingering.
- Do NOT include dead time, warm-up, or anything after the play resolves.
- If end_sec - start_sec > 8, you are cutting too late. Trim harder.

Return STRICT JSON only. No markdown, no code fences.

{
  "at_bat_summary": "one sentence from pitcher's perspective",
  "events": [
    {
      "index": 1,
      "type": "one of: windup, pitch_ball, pitch_called_strike, pitch_swing_miss, foul, contact_fair, contact_foul_out, timeout, dead_time, other",
      "start_sec": 0.0,
      "end_sec": 0.0,
      "timestamp": "MM:SS",
      "description": "pitch type + location + result if visible"
    }
  ],
  "terminal_play": {
    "event_index": 0,
    "outcome": "strikeout | walk | hit | fly_out | ground_out | line_out | other",
    "start_sec": 0.0,
    "end_sec": 0.0,
    "matches_provided_tag": true,
    "reasoning": "why this is the final pitch"
  },
  "recommended_trim": {
    "start_sec": 0.0,
    "end_sec": 0.0,
    "end_beat": "specific visible moment — e.g. 'pitcher pumps fist, catcher tosses ball back'",
    "rationale": "editorial reasoning"
  },
  "caption": "1-3 sentences focused on the pitcher and generic result. Only visible facts."
}

CRITICAL TIMESTAMP RULE: All start_sec and end_sec values in terminal_play and \
recommended_trim MUST exactly match one of the start_sec or end_sec values \
already listed in events[]. Do not invent timestamps not present in events[].

All *_sec values are seconds from the start of the clip, as numbers.`;

// ── FIELDING ─────────────────────────────────────────────────────────────────
SYSTEM_INSTRUCTIONS.fielding = (position) => `\
You are an expert softball video analyst AND a skilled sports video editor. You are
given a clip of a defensive play. The player you are highlighting plays ${position}.

YOUR JOB:

PART 1 — EVENT SEGMENTATION
Find the moment(s) where the ${position} player is directly involved in the play:
receiving a throw, fielding a ground ball, making a scoop, applying a tag, or
recording a putout. Ignore players not involved in the play.

CRITICAL: Describe ONLY what is clearly visible. Do not guess at difficulty of
a play unless you can clearly see the ball's path and the fielder's footwork.

PART 2 — EDITORIAL CUT POINT
- Start: the ball is put in play (bat contact or throw released toward ${position})
- End: the ${position} player completes the play and the umpire makes the call,
  OR the play fails and the result is clear. Cut on the umpire's call or the
  fielder's follow-through settling.

Return STRICT JSON only. No markdown, no code fences.

{
  "at_bat_summary": "one sentence from the ${position} player's perspective",
  "events": [
    {
      "index": 1,
      "type": "one of: ball_in_play, throw_received, scoop, tag, putout, error, timeout, dead_time, other",
      "start_sec": 0.0,
      "end_sec": 0.0,
      "timestamp": "MM:SS",
      "description": "what the ${position} player did — only clearly visible actions"
    }
  ],
  "terminal_play": {
    "event_index": 0,
    "outcome": "putout | error | other",
    "start_sec": 0.0,
    "end_sec": 0.0,
    "matches_provided_tag": true,
    "reasoning": "why this is the key play"
  },
  "recommended_trim": {
    "start_sec": 0.0,
    "end_sec": 0.0,
    "end_beat": "specific visible moment — e.g. '${position} player holds glove up after umpire call'",
    "rationale": "editorial reasoning"
  },
  "caption": "1-3 sentences focused on the ${position} player's role. Only visible facts."
}

CRITICAL TIMESTAMP RULE: All start_sec and end_sec values in terminal_play and \
recommended_trim MUST exactly match one of the start_sec or end_sec values \
already listed in events[]. Do not invent timestamps not present in events[].

All *_sec values are seconds from the start of the clip, as numbers.`;

function buildUserPrompt(outcomeTag, clipType = 'hitting', context = '') {
  const prefix = clipType === 'pitching' ? 'Analyze this pitching clip.'
    : clipType === 'fielding' ? 'Analyze this fielding clip.'
    : 'Analyze this at-bat.';
  const contextText = context ? `${context} ` : '';

  if (outcomeTag && clipType === 'pitching') {
    return (
      `${prefix} ${contextText}The GameChanger outcome tag is "${outcomeTag}". Use it to identify the terminal pitch. ` +
      'For pitching clips, the terminal pitch is the final pitch-like event in events, immediately before the end-of-play reaction. ' +
      'If the tag is Strikeout, choose strike three only; do not choose an earlier strike. Set matches_provided_tag accordingly.'
    );
  }

  const base = outcomeTag
    ? `The GameChanger outcome tag is "${outcomeTag}". Use it to identify the terminal play. Set matches_provided_tag accordingly.`
    : 'No outcome tag provided — infer the result and set matches_provided_tag to false.';
  return `${prefix} ${contextText}${base}`;
}

function getSystemInstruction(clipType = 'hitting', position = null) {
  if (clipType === 'pitching') return SYSTEM_INSTRUCTIONS.pitching;
  if (clipType === 'fielding') return SYSTEM_INSTRUCTIONS.fielding(position ?? 'fielder');
  return SYSTEM_INSTRUCTIONS.hitting;
}

// ── Gemini helpers ───────────────────────────────────────────────────────────

async function uploadAndWait(ai, filePath) {
  console.log('[gemini] uploading video...');
  const uploadResult = await ai.files.upload({
    file: filePath,
    config: { mimeType: 'video/mp4' },
  });

  let file = await ai.files.get({ name: uploadResult.name });
  while (file.state === 'PROCESSING') {
    console.log('[gemini] processing...');
    await new Promise(r => setTimeout(r, 2000));
    file = await ai.files.get({ name: file.name });
  }
  if (file.state === 'FAILED') throw new Error('Gemini file processing failed');
  console.log('[gemini] upload ready');
  return file;
}

function offsetSeconds(value, offsetSec) {
  const n = Number(value);
  return Number.isFinite(n) ? Number((n + offsetSec).toFixed(3)) : value;
}

function timestampFromSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const mins = Math.floor(n / 60);
  const secs = Math.floor(n % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function offsetTimedObject(obj, offsetSec) {
  if (!obj) return obj;
  const next = { ...obj };
  next.start_sec = offsetSeconds(next.start_sec, offsetSec);
  next.end_sec = offsetSeconds(next.end_sec, offsetSec);
  if (next.timestamp && Number.isFinite(Number(next.start_sec))) {
    next.timestamp = timestampFromSeconds(next.start_sec);
  }
  return next;
}

function offsetAnalysisTimestamps(result, offsetSec) {
  if (!offsetSec) return result;
  return {
    ...result,
    events: Array.isArray(result.events)
      ? result.events.map(event => offsetTimedObject(event, offsetSec))
      : result.events,
    terminal_play: offsetTimedObject(result.terminal_play, offsetSec),
    recommended_trim: offsetTimedObject(result.recommended_trim, offsetSec),
    analysis_window: {
      ...(result.analysis_window ?? {}),
      source_start_sec: offsetSec,
    },
  };
}

async function analyzeSingleVideo(videoPath, outcomeTag = null, clipType = 'hitting', position = null, options = {}) {
  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const file = await uploadAndWait(ai, videoPath);

  // Per-mode FPS and thinking budget
  const FPS_MAP      = { hitting: 5, pitching: 8, fielding: 3 };
  const THINKING_MAP = { hitting: 5000, pitching: 8000, fielding: 2000 };
  const fps     = options.fps ?? FPS_MAP[clipType] ?? config.gemini.fps;
  const budget  = THINKING_MAP[clipType] ?? config.gemini.thinkingBudget;
  const userPrompt = buildUserPrompt(outcomeTag, clipType, options.promptContext);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryText = attempt === 0
      ? ''
      : '\n\nYour previous response was invalid JSON. Return valid JSON only. Escape quotes inside strings. No markdown.';

    console.log(`[gemini] analyzing model=${config.gemini.model} fps=${fps} thinking=${budget}${attempt ? ' retry=1' : ''}...`);
    const response = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [{
        role: 'user',
        parts: [
          {
            fileData: { fileUri: file.uri, mimeType: 'video/mp4' },
            videoMetadata: { fps },
          },
          { text: `${userPrompt}${retryText}` },
        ],
      }],
      config: {
        systemInstruction: getSystemInstruction(clipType, position),
        responseMimeType: 'application/json',
        temperature: options.temperature ?? 1.0,
        thinkingConfig: { thinkingBudget: budget },
      },
    });

    const usage = response.usageMetadata;
    if (usage) {
      console.log(`[gemini] tokens: input=${usage.promptTokenCount} output=${usage.candidatesTokenCount}`);
    }

    let text = (response.text ?? '').trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
    }

    try {
      const result = JSON.parse(text);
      const offsetResult = offsetAnalysisTimestamps(result, options.timeOffsetSec ?? 0);
      return normalizeAnalysisResult(offsetResult, { clipType, outcomeTag });
    } catch (err) {
      if (attempt === 1) throw err;
      console.warn(`[gemini] invalid JSON response; retrying (${err.message})`);
    }
  }

  throw new Error('Gemini analysis did not return JSON');
}

function isStrikeoutAnalysis(result, outcomeTag) {
  const text = `${outcomeTag ?? ''} ${result?.terminal_play?.outcome ?? ''}`.toLowerCase();
  return /\b(strikeout|strike out|struck out|k)\b/.test(text);
}

function normalizePitchingStrikeoutForMvp(result, outcomeTag) {
  if (!isStrikeoutAnalysis(result, outcomeTag)) return result;

  const originalOutcome = result?.terminal_play?.outcome ?? null;
  const next = {
    ...result,
    terminal_play: {
      ...(result.terminal_play ?? {}),
      outcome: 'strikeout',
      outcome_detail: originalOutcome && originalOutcome !== 'strikeout' ? originalOutcome : null,
    },
    selection_audit: {
      ...(result.selection_audit ?? {}),
      strikeout_subtype_suppressed: true,
      suppressed_outcome_detail: originalOutcome,
    },
  };

  next.caption = 'The pitcher finishes the at-bat with a strikeout.';
  return next;
}

function readTerminalWindow(result) {
  const tp = result?.terminal_play ?? {};
  const rt = result?.recommended_trim ?? {};
  const start = Number.isFinite(Number(tp.start_sec)) ? Number(tp.start_sec) : Number(rt.start_sec);
  const end = Number.isFinite(Number(tp.end_sec)) ? Number(tp.end_sec) : Number(rt.end_sec);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  return { start, end };
}

function isPitchLikeEvent(event) {
  return [
    'windup',
    'pitch_ball',
    'pitch_called_strike',
    'pitch_swing_miss',
    'foul',
    'contact_fair',
    'contact_foul_out',
  ].includes(String(event?.type ?? '').toLowerCase());
}

function hasBogusPitchingTimeline(result, windowStartSec) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const starts = events
    .map(event => Number(event.start_sec))
    .filter(Number.isFinite);
  const pitchStarts = events
    .filter(isPitchLikeEvent)
    .map(event => Number(event.start_sec))
    .filter(Number.isFinite);
  const terminalWindow = readTerminalWindow(result);

  if (starts.length < 3 || pitchStarts.length < 2 || !terminalWindow) return false;

  const totalSpan = Math.max(...starts) - Math.min(...starts);
  const pitchSpan = Math.max(...pitchStarts) - Math.min(...pitchStarts);
  const terminalOffset = terminalWindow.start - windowStartSec;
  const trimDuration = terminalWindow.end - terminalWindow.start;

  return (
    (events.length >= 5 && totalSpan < 2.0) ||
    (pitchStarts.length >= 2 && pitchSpan < 2.0) ||
    (terminalOffset < 1.0 && trimDuration < 0.5)
  );
}

async function analyzePitchingFocus(videoPath, outcomeTag, position, windowSecs, options = {}) {
  const duration = await getVideoDuration(videoPath);
  const windowStart = Math.max(0, duration - windowSecs);
  if (windowStart <= 0.5) {
    return {
      result: await analyzeSingleVideo(videoPath, outcomeTag, 'pitching', position, { temperature: options.temperature }),
      windowStart: 0,
      duration,
    };
  }

  const tmpFocus = path.join(os.tmpdir(), `playtape-pitch-focus-${Date.now()}.mp4`);
  const context = (
    'This video is the late portion of the original clip. Earlier pitch history may be omitted. ' +
    'Find the final pitch before the plate appearance ends in this excerpt.'
  );

  console.log(`[gemini] pitching focus window ${windowStart.toFixed(2)}s -> ${duration.toFixed(2)}s`);
  await trimVideo(videoPath, windowStart, duration, tmpFocus);
  try {
    const result = await analyzeSingleVideo(tmpFocus, outcomeTag, 'pitching', position, {
      timeOffsetSec: windowStart,
      promptContext: context,
      temperature: options.temperature,
    });
    return { result, windowStart, duration };
  } finally {
    fs.unlink(tmpFocus, () => {});
  }
}

function isTimestampFarFromAudio(result, lastAudioSec) {
  const startSec = Number(result?.recommended_trim?.start_sec);
  if (!Number.isFinite(startSec)) return false;
  // Terminal pitch should start within 15s before audio activity ends
  return lastAudioSec - startSec > 15;
}

async function analyzePitchingWindow(videoPath, outcomeTag = null, position = null) {
  const lastAudio = await detectLastAudioActivity(videoPath).catch(() => null);
  if (lastAudio !== null) console.log(`[gemini] last audio activity: ${lastAudio.toFixed(2)}s`);

  for (let attempt = 0; attempt < 2; attempt++) {
    const temperature = attempt === 0 ? 1.0 : 0.3;
    const analysis = await analyzePitchingFocus(videoPath, outcomeTag, position, PITCHING_FOCUS_WINDOW_SECS, { temperature });
    const bogus = hasBogusPitchingTimeline(analysis.result, analysis.windowStart) ||
      (lastAudio !== null && isTimestampFarFromAudio(analysis.result, lastAudio));
    if (!bogus) {
      return normalizePitchingStrikeoutForMvp(analysis.result, outcomeTag);
    }
    console.warn(`[gemini] suspicious pitching timeline (attempt ${attempt + 1}/2)${attempt < 1 ? '; retrying at lower temperature' : '; exhausted retries'}`);
  }
  // Both focus window attempts bogus — widen window as last resort
  console.warn('[gemini] falling back to wider window (40s)');
  const wideAnalysis = await analyzePitchingFocus(videoPath, outcomeTag, position, 40, { temperature: 0.3 });
  return normalizePitchingStrikeoutForMvp(wideAnalysis.result, outcomeTag);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze a local video file. Returns the full Gemini result object.
 */
function hasBogusNonPitchingResult(result) {
  const startSec = Number(result?.recommended_trim?.start_sec);
  const endSec   = Number(result?.recommended_trim?.end_sec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return true;
  if (endSec - startSec < 0.5) return true;  // sub-half-second trim
  if (startSec < 1.0) return true;            // near-zero timestamp
  return false;
}

export async function analyzeAtBat(videoPath, outcomeTag = null, clipType = 'hitting', position = null) {
  if (clipType === 'pitching') {
    return analyzePitchingWindow(videoPath, outcomeTag, position);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const temperature = attempt === 0 ? 1.0 : 0.3;
    const result = await analyzeSingleVideo(videoPath, outcomeTag, clipType, position, { temperature });
    if (!hasBogusNonPitchingResult(result)) return result;
    console.warn(`[gemini] bogus ${clipType} timestamps (attempt ${attempt + 1}/2)${attempt < 1 ? '; retrying at lower temperature' : '; exhausted retries'}`);
  }
  // Return last result even if bogus — processClip will guard against crash
  console.warn(`[gemini] could not recover ${clipType} timestamps; using last result`);
  return analyzeSingleVideo(videoPath, outcomeTag, clipType, position, { temperature: 0.3 });
}

/**
 * Download a clip from R2, analyze it, return the result.
 * Caller is responsible for trimming (see ffmpeg.js).
 */
export async function downloadAndAnalyze(sourceKey, outcomeTag = null, clipType = 'hitting', position = null) {
  const ts = Date.now();
  const tmpRaw   = path.join(os.tmpdir(), `playtape-src-${ts}.mp4`);
  const tmpProxy = path.join(os.tmpdir(), `playtape-proxy-${ts}.mp4`);

  console.log(`[gemini] downloading ${sourceKey}...`);
  const res = await r2.send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: sourceKey }));
  await pipeline(res.Body, fs.createWriteStream(tmpRaw));

  console.log(`[gemini] generating proxy...`);
  await generateProxy(tmpRaw, tmpProxy);
  const proxySize = fs.statSync(tmpProxy).size;
  console.log(`[gemini] proxy ready (${(proxySize / 1e6).toFixed(1)}MB)`);

  try {
    return await analyzeAtBat(tmpProxy, outcomeTag, clipType, position);
  } finally {
    for (const f of [tmpRaw, tmpProxy]) fs.unlink(f, () => {});
  }
}
