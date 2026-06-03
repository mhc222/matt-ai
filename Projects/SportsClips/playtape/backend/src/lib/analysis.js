const PITCH_EVENT_TYPES = new Set([
  'windup',
  'pitch_ball',
  'pitch_called_strike',
  'pitch_swing_miss',
  'foul',
  'contact_fair',
  'contact_foul_out',
]);

const STRIKE_EVENT_TYPES = new Set([
  'pitch_called_strike',
  'pitch_swing_miss',
  'contact_foul_out',
]);

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase();
}

function eventStart(event) {
  return asNumber(event?.start_sec);
}

function eventEnd(event) {
  return asNumber(event?.end_sec);
}

function eventIndex(event) {
  return asNumber(event?.index);
}

function isPitchEvent(event) {
  const type = normalizeText(event?.type);
  return PITCH_EVENT_TYPES.has(type);
}

function isStrikeLikePitch(event) {
  const type = normalizeText(event?.type);
  const description = normalizeText(event?.description);
  return (
    STRIKE_EVENT_TYPES.has(type) ||
    /\b(called strike|strike three|strike 3|strikeout|swing(?:ing)? and miss|swing miss|misses)\b/.test(description)
  );
}

function isStrikeoutOutcome(outcomeTag, terminalPlay) {
  const text = normalizeText(`${outcomeTag ?? ''} ${terminalPlay?.outcome ?? ''}`);
  return /\b(strikeout|strike out|struck out|k)\b/.test(text);
}

function buildPitchEvents(events) {
  return events
    .filter(isPitchEvent)
    .map(event => ({
      event,
      start: eventStart(event),
      end: eventEnd(event),
      index: eventIndex(event),
    }))
    .filter(({ start }) => start !== null)
    .sort((a, b) => a.start - b.start);
}

function shouldMoveToSelectedPitch(selected, terminalPlay, recommendedTrim) {
  const terminalStart = asNumber(terminalPlay?.start_sec);
  const trimStart = asNumber(recommendedTrim?.start_sec);
  const terminalIndex = asNumber(terminalPlay?.event_index);

  if (terminalStart === null) return true;
  if (selected.start > terminalStart + 1.0) return true;
  if (trimStart !== null && selected.start > trimStart + 1.0) return true;
  if (terminalIndex !== null && selected.index !== null && terminalIndex !== selected.index) return true;

  return false;
}

function reconcilePitchingResult(result, outcomeTag) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const pitchEvents = buildPitchEvents(events);
  if (pitchEvents.length === 0) return result;

  const originalTerminalPlay = result.terminal_play ?? {};
  const originalTrim = result.recommended_trim ?? {};
  const strikeout = isStrikeoutOutcome(outcomeTag, originalTerminalPlay);
  const candidates = strikeout ? pitchEvents.filter(({ event }) => isStrikeLikePitch(event)) : pitchEvents;
  const selected = candidates.at(-1) ?? pitchEvents.at(-1);
  if (!selected) return result;

  const normalized = {
    ...result,
    terminal_play: { ...originalTerminalPlay },
    recommended_trim: { ...originalTrim },
  };

  const moveSelection = shouldMoveToSelectedPitch(selected, originalTerminalPlay, originalTrim);
  const selectedEnd = selected.end ?? selected.start + 2.0;

  if (moveSelection) {
    normalized.terminal_play = {
      ...normalized.terminal_play,
      event_index: selected.index ?? normalized.terminal_play.event_index ?? null,
      start_sec: selected.start,
      end_sec: selectedEnd,
      reasoning: `Backend pitching reconciliation selected the last pitch event before the play resolved: event ${selected.index ?? 'unknown'}.`,
    };

    normalized.recommended_trim = {
      ...normalized.recommended_trim,
      start_sec: selected.start,
      end_sec: Math.max(selectedEnd, selected.start + 1.0),
      end_beat: normalized.recommended_trim.end_beat ?? 'terminal pitch result becomes clear',
      rationale: 'Backend pitching reconciliation moved the trim to the last pitch event in the sequence.',
    };
  }

  if (strikeout) {
    const originalOutcome = normalized.terminal_play.outcome ?? null;
    normalized.terminal_play.outcome = 'strikeout';
    normalized.terminal_play.outcome_detail = originalOutcome && originalOutcome !== 'strikeout' ? originalOutcome : null;
    normalized.terminal_play.matches_provided_tag = true;
  }

  normalized.selection_audit = {
    ...(result.selection_audit ?? {}),
    backend_pitch_reconciled: moveSelection,
    backend_selected_event_index: selected.index ?? null,
    backend_selected_start_sec: selected.start,
  };

  return normalized;
}

export function normalizeAnalysisResult(result, { clipType = 'hitting', outcomeTag = null } = {}) {
  if (clipType !== 'pitching') return result;
  return reconcilePitchingResult(result, outcomeTag);
}
