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
- Start: ALWAYS the windup IMMEDIATELY before the decisive pitch. This is non-negotiable. Never start on a runner in motion, never start on a celebration, never start after contact. The highlight MUST begin with pitch movement.
- End: depends on the play:
  - Home run: end_sec = one beat after the batter crosses HOME PLATE to score. Do NOT cut when ball clears the fence — wait for her to complete the full trip around the bases.
  - Extra-base hit (double/triple): one beat after runner plants foot on the bag safely.
  - Strikeout or out: cut when the out is recorded, not after.
  - Single: one beat after runner reaches first base safely.
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

// ── TWO-PASS: Pass 1 system instructions (segmentation only, no selection) ────
const PASS1_INSTRUCTIONS = {
  hitting: `\
You are a softball video analyst. Segment this at-bat clip into chronological events.
Do NOT select a terminal play. Do NOT recommend any trim. List every observable event only.

Assign each event a sequential string ID starting from "e01", "e02", "e03", etc.

Event types: windup, pitch_ball, pitch_called_strike, pitch_swing_miss, foul, contact_fair, timeout, dead_time, other

Return STRICT JSON only. No markdown, no code fences.
{
  "at_bat_summary": "one sentence describing what happens in the clip",
  "events": [
    { "id": "e01", "type": "string", "start_sec": 0.0, "end_sec": 0.0, "description": "only what is clearly visible" }
  ]
}

CRITICAL: Describe only what you can clearly see. Do not infer, guess, or embellish.`,

  pitching: `\
You are a softball video analyst. Segment this pitching clip into chronological events.
Focus on the pitcher. List EVERY pitch, reset, dead-time, and reaction event chronologically.
Do NOT select a terminal play. Do NOT recommend any trim.

Assign each event a sequential string ID: "e01", "e02", "e03", etc.

Event types: windup, pitch_ball, pitch_called_strike, pitch_swing_miss, foul, contact_fair, contact_foul_out, timeout, dead_time, other

Return STRICT JSON only. No markdown, no code fences.
{
  "at_bat_summary": "one sentence from the pitcher's perspective",
  "events": [
    { "id": "e01", "type": "string", "start_sec": 0.0, "end_sec": 0.0, "description": "pitch type + location + result if visible" }
  ]
}

CRITICAL: Describe only what you can clearly see. Do not guess pitch type unless spin or movement is unambiguous.`,

  fielding: (position) => `\
You are a softball video analyst. Segment this defensive play clip into chronological events.
Focus on the ${position} player. List every observable event. Do NOT recommend any trim.

Assign each event a sequential string ID: "e01", "e02", "e03", etc.

Event types: ball_in_play, throw_received, scoop, tag, putout, error, timeout, dead_time, other

Return STRICT JSON only. No markdown, no code fences.
{
  "at_bat_summary": "one sentence from the ${position} player's perspective",
  "events": [
    { "id": "e01", "type": "string", "start_sec": 0.0, "end_sec": 0.0, "description": "what the ${position} player did" }
  ]
}`,
};

// ── TWO-PASS: Pass 2 system instructions (selection from events, no video) ────
const PASS2_INSTRUCTIONS = {
  hitting: `\
You are a sports video editor. You are given a list of softball events extracted from a clip.
Your ONLY job: select the best highlight play and recommend trim boundaries using event IDs from the list.
Do NOT re-analyze video. Use ONLY the events provided.

SELECTION RULES:
1. If multiple distinct plays exist, select the highest highlight value: home run > triple > double > strikeout > single > walk > out
2. Trim start: ALWAYS the "windup" event immediately before the decisive pitch — never after contact
3. Trim end by outcome:
   - home run: event after batter crosses home plate (NOT when ball clears fence — she must complete the full trip)
   - extra-base hit: event after runner reaches the bag
   - strikeout / out: event when the out is recorded
   - single: event after runner reaches first base safely

Return STRICT JSON only. No markdown, no code fences.
{
  "terminal_play": {
    "event_id": "e05",
    "outcome": "home run",
    "matches_provided_tag": false,
    "reasoning": "why this is the terminal play"
  },
  "recommended_trim": {
    "start_event_id": "e03",
    "start_boundary": "start_sec",
    "end_event_id": "e07",
    "end_boundary": "end_sec"
  },
  "caption": "1-3 sentences using only facts from the provided events"
}`,

  pitching: `\
You are a sports video editor. You are given a list of softball pitching events extracted from a clip.
Your ONLY job: identify the terminal pitch and recommend trim boundaries using event IDs.

SELECTION RULES:
1. Terminal pitch: the LAST pitch-like event before the end-of-play reaction (walk, umpire call, celebration)
2. For strikeouts: must be the THIRD strike — not strike one or two. Check that no later pitch-like event exists.
3. Trim start: "windup" event immediately before the terminal pitch
4. Trim end: umpire call or first clear reaction after the terminal pitch (not before)

Return STRICT JSON only. No markdown, no code fences.
{
  "terminal_play": {
    "event_id": "e08",
    "outcome": "strikeout",
    "matches_provided_tag": true,
    "reasoning": "why this is the terminal pitch"
  },
  "recommended_trim": {
    "start_event_id": "e07",
    "start_boundary": "start_sec",
    "end_event_id": "e09",
    "end_boundary": "end_sec"
  },
  "caption": "1-3 sentences focused on the pitcher. Only visible facts."
}`,

  fielding: (position) => `\
You are a sports video editor. You are given a list of softball fielding events for the ${position} player.
Your ONLY job: select the key play and recommend trim boundaries using event IDs.

Return STRICT JSON only. No markdown, no code fences.
{
  "terminal_play": {
    "event_id": "e03",
    "outcome": "putout",
    "matches_provided_tag": true,
    "reasoning": "why this is the key play"
  },
  "recommended_trim": {
    "start_event_id": "e02",
    "start_boundary": "start_sec",
    "end_event_id": "e04",
    "end_boundary": "end_sec"
  },
  "caption": "1-3 sentences focused on the ${position} player. Only visible facts."
}`,
};

function getPass1SystemInstruction(clipType, position) {
  if (clipType === 'pitching') return PASS1_INSTRUCTIONS.pitching;
  if (clipType === 'fielding') return PASS1_INSTRUCTIONS.fielding(position ?? 'fielder');
  return PASS1_INSTRUCTIONS.hitting;
}

function getPass2SystemInstruction(clipType, position) {
  if (clipType === 'pitching') return PASS2_INSTRUCTIONS.pitching;
  if (clipType === 'fielding') return PASS2_INSTRUCTIONS.fielding(position ?? 'fielder');
  return PASS2_INSTRUCTIONS.hitting;
}

function buildPass1UserPrompt(clipType) {
  if (clipType === 'pitching') return 'Segment this pitching clip. List every observable event chronologically.';
  if (clipType === 'fielding') return 'Segment this fielding clip. List every observable event involving the highlighted player.';
  return 'Segment this at-bat. List every observable event chronologically including every pitch, foul, contact, and reaction.';
}

function buildPass2UserPrompt(events, outcomeTag, clipType, context = '') {
  const eventsJson = JSON.stringify(events, null, 2);
  const outcomeHint = outcomeTag
    ? `\nGameChanger outcome tag: "${outcomeTag}" — use this to confirm the terminal play selection.`
    : '\nNo outcome tag provided. Select the most highlight-worthy play from the events.';
  const correctionHint = context ? `\n\nCorrection note: ${context}` : '';
  return `Here are the events extracted from the clip:\n\n${eventsJson}\n${outcomeHint}${correctionHint}\n\nSelect the terminal play and recommend trim boundaries using the event IDs above.`;
}

function resolveEventIds(result) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const rt = result?.recommended_trim ?? {};
  const tp = result?.terminal_play ?? {};

  // Already in timestamp format (single-pass or already resolved)
  if (rt.start_sec != null && rt.end_sec != null) return result;
  if (!rt.start_event_id && !rt.end_event_id) return result;

  const eventMap = new Map(events.map(e => [e.id, e]));
  const startEvent = eventMap.get(rt.start_event_id);
  const endEvent = eventMap.get(rt.end_event_id);
  const terminalEvent = eventMap.get(tp.event_id);

  const startSec = startEvent?.[rt.start_boundary ?? 'start_sec'] ?? startEvent?.start_sec;
  const endSec = endEvent?.[rt.end_boundary ?? 'end_sec'] ?? endEvent?.end_sec;

  return {
    ...result,
    terminal_play: {
      ...tp,
      event_index: terminalEvent ? events.findIndex(e => e.id === tp.event_id) + 1 : (tp.event_index ?? null),
      start_sec: terminalEvent?.start_sec ?? tp.start_sec ?? null,
      end_sec: terminalEvent?.end_sec ?? tp.end_sec ?? null,
    },
    recommended_trim: {
      ...rt,
      start_sec: startSec ?? null,
      end_sec: endSec ?? null,
    },
  };
}

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
    : 'No outcome tag provided. Watch the ENTIRE clip like a sportscaster. This clip may contain multiple plays or at-bats. Step 1: identify ALL significant plays. Step 2: rank them by highlight value — home run > triple > double > strikeout > single > walk > fly out > ground out. Step 3: select ONLY the single highest-value play for the highlight reel. Return only that play\'s events and trim. Set terminal_play.outcome to the selected play outcome. Set matches_provided_tag to false.';
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

async function analyzeTwoPass(videoPath, outcomeTag = null, clipType = 'hitting', position = null, options = {}) {
  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const file = await uploadAndWait(ai, videoPath);

  const FPS_MAP = { hitting: 5, pitching: 8, fielding: 3 };
  const fps = options.fps ?? FPS_MAP[clipType] ?? config.gemini.fps;

  // ── Pass 1: Segmentation (minimal thinking, video in, events out) ────────
  let events = [];
  let atBatSummary = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const promptText = buildPass1UserPrompt(clipType) + (attempt > 0 ? '\n\nReturn valid JSON only.' : '');
    console.log(`[gemini] pass1 model=${config.gemini.model} fps=${fps}${attempt ? ' retry=1' : ''}...`);
    const response = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: file.uri, mimeType: 'video/mp4' }, videoMetadata: { fps } },
        { text: promptText },
      ]}],
      config: {
        systemInstruction: getPass1SystemInstruction(clipType, position),
        responseMimeType: 'application/json',
        temperature: 1.0,
        thinkingConfig: { thinkingBudget: 512 },
      },
    });
    const usage = response.usageMetadata;
    if (usage) console.log(`[gemini] pass1 tokens: input=${usage.promptTokenCount} output=${usage.candidatesTokenCount}`);
    let text = (response.text ?? '').trim().replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
    try {
      const parsed = JSON.parse(text);
      events = Array.isArray(parsed.events) ? parsed.events : [];
      atBatSummary = parsed.at_bat_summary ?? '';
      break;
    } catch (err) {
      if (attempt === 1) throw new Error(`Pass 1 JSON parse failed: ${err.message}`);
    }
  }
  if (!events.length) throw new Error('Pass 1 returned no events');

  // ── Pass 2: Selection (thinking on, text only — no video) ────────────────
  const THINKING_MAP2 = { hitting: 2048, pitching: 3072, fielding: 1024 };
  const budget2 = THINKING_MAP2[clipType] ?? 2048;
  let pass2Result = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const promptText = buildPass2UserPrompt(events, outcomeTag, clipType, options.promptContext)
      + (attempt > 0 ? '\n\nReturn valid JSON only.' : '');
    console.log(`[gemini] pass2 thinking=${budget2}${attempt ? ' retry=1' : ''}...`);
    const response = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      config: {
        systemInstruction: getPass2SystemInstruction(clipType, position),
        responseMimeType: 'application/json',
        temperature: 1.0,
        thinkingConfig: { thinkingBudget: budget2 },
      },
    });
    const usage = response.usageMetadata;
    if (usage) console.log(`[gemini] pass2 tokens: input=${usage.promptTokenCount} output=${usage.candidatesTokenCount}`);
    let text = (response.text ?? '').trim().replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
    try {
      pass2Result = JSON.parse(text);
      break;
    } catch (err) {
      if (attempt === 1) throw new Error(`Pass 2 JSON parse failed: ${err.message}`);
    }
  }

  // ── Combine + resolve event IDs to timestamps ────────────────────────────
  const combined = {
    at_bat_summary: atBatSummary,
    events,
    terminal_play: pass2Result.terminal_play ?? {},
    recommended_trim: pass2Result.recommended_trim ?? {},
    caption: pass2Result.caption ?? '',
  };
  const resolved = resolveEventIds(combined);
  const offsetResult = offsetAnalysisTimestamps(resolved, options.timeOffsetSec ?? 0);
  return normalizeAnalysisResult(offsetResult, { clipType, outcomeTag });
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
      result: await analyzeTwoPass(videoPath, outcomeTag, 'pitching', position, { promptContext: options.promptContext }),
      windowStart: 0,
      duration,
    };
  }

  const tmpFocus = path.join(os.tmpdir(), `playtape-pitch-focus-${Date.now()}.mp4`);
  const context = (options.promptContext ? options.promptContext + ' ' : '') +
    'This video is the late portion of the original clip. Earlier pitch history may be omitted. ' +
    'Find the final pitch before the plate appearance ends in this excerpt.';

  console.log(`[gemini] pitching focus window ${windowStart.toFixed(2)}s -> ${duration.toFixed(2)}s`);
  await trimVideo(videoPath, windowStart, duration, tmpFocus);
  try {
    const result = await analyzeTwoPass(tmpFocus, outcomeTag, 'pitching', position, {
      timeOffsetSec: windowStart,
      promptContext: context,
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

  let lastPitchResult = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const correctionContext = attempt === 0 || !lastPitchResult ? undefined
      : 'Your previous response had suspicious timestamps — all pitch events were compressed into less than 2 seconds, which is physically impossible. Re-analyze the focus window carefully and map each pitch event to its actual timestamp in the clip.';
    const analysis = await analyzePitchingFocus(videoPath, outcomeTag, position, PITCHING_FOCUS_WINDOW_SECS, {
      temperature: 1.0,  // never lower temp — breaks thinking mode
      promptContext: correctionContext,
    });
    const bogus = hasBogusPitchingTimeline(analysis.result, analysis.windowStart) ||
      (lastAudio !== null && isTimestampFarFromAudio(analysis.result, lastAudio));
    if (!bogus) {
      return normalizePitchingStrikeoutForMvp(analysis.result, outcomeTag);
    }
    lastPitchResult = analysis.result;
    console.warn(`[gemini] suspicious pitching timeline (attempt ${attempt + 1}/2)${attempt < 1 ? '; retrying with correction prompt' : '; exhausted retries'}`);
  }
  // Both focus window attempts bogus — widen window as last resort
  console.warn('[gemini] falling back to wider window (40s)');
  const wideAnalysis = await analyzePitchingFocus(videoPath, outcomeTag, position, 40, { temperature: 1.0 });
  return normalizePitchingStrikeoutForMvp(wideAnalysis.result, outcomeTag);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze a local video file. Returns the full Gemini result object.
 */
function hasBogusNonPitchingResult(result, videoDurationSec = null) {
  const startSec = Number(result?.recommended_trim?.start_sec);
  const endSec   = Number(result?.recommended_trim?.end_sec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return true;
  if (endSec - startSec < 0.5) return true;  // sub-half-second trim
  if (startSec < 1.0) return true;            // near-zero timestamp
  if (videoDurationSec !== null && startSec > videoDurationSec - 2) return true; // past end of video
  return false;
}

export async function analyzeAtBat(videoPath, outcomeTag = null, clipType = 'hitting', position = null) {
  if (clipType === 'pitching') {
    return analyzePitchingWindow(videoPath, outcomeTag, position);
  }

  const videoDuration = await getVideoDuration(videoPath).catch(() => null);
  let lastResult = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const correctionContext = attempt === 0 || !lastResult ? undefined
      : `Previous attempt returned start_sec=${lastResult?.recommended_trim?.start_sec?.toFixed(1)} in a ${videoDuration?.toFixed(1)}s video. All timestamps must be within the video duration. Re-analyze carefully.`;
    const result = await analyzeTwoPass(videoPath, outcomeTag, clipType, position, {
      promptContext: correctionContext,
    });
    if (!hasBogusNonPitchingResult(result, videoDuration)) return result;
    lastResult = result;
    console.warn(`[gemini] bogus ${clipType} timestamps (attempt ${attempt + 1}/2)${attempt < 1 ? '; retrying with correction prompt' : '; exhausted retries'}`);
  }
  console.warn(`[gemini] could not recover ${clipType} timestamps; using last result`);
  return lastResult;
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
