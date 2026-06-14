// services/segmentEngine.js — Segment-driven broadcast engine
// Handles: segment normalization, bridge generation, dedup checking, TTS resolution
// Replaces ad-hoc filler logic with structured segment types.

const tts = require('../tts');
const logger = require('../utils/logger');
const promptBuilders = require('../promptBuilders');

// ── Segment Types ─────────────────────────────────────────────
const VALID_TYPES = new Set([
  'cold_open',      // Opening narration before first song
  'bridge',         // Inter-track transition
  'back_announce',  // Post-song commentary
  'quick_touch',    // Brief comment / lightweight transition
  'silence',        // Intentional silence (no TTS)
]);

const VALID_POSITIONS = new Set([
  'before_track',
  'between_tracks',
  'after_track',
]);

// ── Normalization ─────────────────────────────────────────────

/**
 * Normalize raw LLM segment output into validated Segment objects.
 * LLM output is untrusted — enforce strict validation.
 *
 * @param {Array} rawSegments - Raw segments from LLM JSON
 * @param {Array} tracks - Confirmed track list [{name, artist, trackId}]
 * @returns {Array<Segment>} Normalized segments
 */
function normalizeSegments(rawSegments, tracks) {
  if (!Array.isArray(rawSegments)) return [];
  if (!tracks || tracks.length === 0) {
    // No tracks — demote all track-bound segments to immediate or drop them
    return rawSegments
      .filter((s) => s.type === 'cold_open' || s.type === 'quick_touch')
      .map((s, i) => ({
        id: `seg:immediate:${i}`,
        type: VALID_TYPES.has(s.type) ? s.type : 'quick_touch',
        position: 'before_track',
        afterTrackIndex: null,
        beforeTrackIndex: null,
        text: (s.text || '').trim(),
        ttsUrl: null,
        ttsStatus: 'pending',
        transitionStyle: 'none',
        metadata: {},
      }));
  }

  const maxIndex = tracks.length - 1;
  const results = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i];

    // Type whitelist — unknown types demote to quick_touch
    const type = VALID_TYPES.has(raw.type) ? raw.type : 'quick_touch';

    // Position — default based on type
    let position = VALID_POSITIONS.has(raw.position) ? raw.position : null;
    if (!position) {
      if (type === 'cold_open') position = 'before_track';
      else if (type === 'bridge') position = 'between_tracks';
      else if (type === 'back_announce') position = 'after_track';
      else position = 'between_tracks';
    }

    // Anchor index — clamp to valid range
    let anchor = typeof raw.anchor === 'number' ? raw.anchor : i;
    anchor = Math.max(0, Math.min(anchor, maxIndex));

    // Dual indexing — afterTrackIndex (prev track) + beforeTrackIndex (next track)
    let afterTrackIndex = null;
    let beforeTrackIndex = null;
    switch (position) {
      case 'between_tracks':
        afterTrackIndex = anchor;
        beforeTrackIndex = anchor + 1 <= maxIndex ? anchor + 1 : null;
        break;
      case 'after_track':
        afterTrackIndex = anchor;
        break;
      case 'before_track':
        beforeTrackIndex = anchor;
        break;
      default:
        afterTrackIndex = anchor;
        break;
    }

    // Text
    const text = (raw.text || '').trim();

    // Silence segments have no text
    const ttsStatus = type === 'silence' ? 'silent' : (text ? 'pending' : 'silent');

    // Transition style
    const transitionStyle = raw.transition_style || raw.transitionStyle || 'outro';

    // Build metadata from adjacent tracks
    const metadata = {};
    if (afterTrackIndex !== null && tracks[afterTrackIndex]) {
      metadata.prevSong = { name: tracks[afterTrackIndex].name || tracks[afterTrackIndex].trackName, artist: tracks[afterTrackIndex].artist };
    }
    if (beforeTrackIndex !== null && tracks[beforeTrackIndex]) {
      metadata.nextSong = { name: tracks[beforeTrackIndex].name || tracks[beforeTrackIndex].trackName, artist: tracks[beforeTrackIndex].artist };
    }

    results.push({
      id: `seg:${type}:${afterTrackIndex ?? beforeTrackIndex}:${i}`,
      type,
      position,
      afterTrackIndex,
      beforeTrackIndex,
      text,
      ttsUrl: null,
      ttsStatus,
      transitionStyle,
      metadata,
    });
  }

  return results;
}

// ── Bridge Generation ─────────────────────────────────────────

/**
 * Normalize and validate raw LLM bridge output.
 * Pipeline: clean → empty check → dedup → fallback chain.
 * No length constraints — let the LLM decide how much to say.
 *
 * @param {string} rawText - Raw text from LLM
 * @param {object} fallback - Template fallback result
 * @returns {{ text: string|null, source: string, dedup: string }}
 */
function normalizeBridgeOutput(rawText, fallback) {
  // Step 1: Clean — strip quotes, whitespace, markdown artifacts
  const cleaned = (rawText || '')
    .replace(/^["'"「『【《\s]+/, '')
    .replace(/["'"」』】》\s]+$/, '')
    .replace(/```[\s\S]*```/g, '')  // Remove markdown code blocks
    .replace(/^\d+[.、)\]]\s*/, '') // Remove numbering prefixes
    .trim();

  // Step 2: Empty check — only reject truly empty/gibberish output
  if (!cleaned) {
    logger.warn('SEGMENT', 'Bridge output empty after cleaning, falling back');
    return { text: fallback.text, source: 'template', dedup: 'skipped' };
  }

  // Step 3: Dedup check against recent bridge history
  const dedupResult = checkBridgeDedup(cleaned);
  if (!dedupResult.allowed) {
    logger.info('SEGMENT', `Bridge dedup blocked: ${dedupResult.reason}`);
    return { text: fallback.text, source: 'template', dedup: dedupResult.reason };
  }

  return { text: cleaned, source: 'llm', dedup: 'passed' };
}

/**
 * Generate a bridge segment between two songs using LLM (DeepSeek rawChat).
 * LLM decides text length freely — no depth parameter.
 *
 * Falls back to template-based generateBridgeText() on any failure.
 *
 * @param {object} prevSong - { name, artist, tags? }
 * @param {object} nextSong - { name, artist, tags? }
 * @param {object} deepseek - DeepSeekAdapter instance (must have rawChat)
 * @param {object} [options] - { temperature, maxTokens, timeout, bridgeContext }
 * @returns {Promise<{ text, transitionStyle, source }>}
 */
async function generateBridgeLLM(prevSong, nextSong, deepseek, options = {}) {
  const fallback = generateBridgeText(prevSong, nextSong);

  // Guard: if deepseek is not provided or rawChat is missing, fall back
  if (!deepseek || typeof deepseek.rawChat !== 'function') {
    return { ...fallback, source: 'template' };
  }

  // Build prompts using dedicated builder (lean context: persona + time + recent plays + song pair)
  const bridgeContext = options.bridgeContext || null;
  const { systemPrompt, userPrompt } = promptBuilders.buildBridgePrompt(
    prevSong, nextSong, bridgeContext
  );

  const rawOptions = {
    temperature: options.temperature ?? 0.85,
    maxTokens: options.maxTokens ?? 200,
    timeout: options.timeout ?? 15000,
  };

  try {
    const rawText = await deepseek.rawChat(systemPrompt, userPrompt, rawOptions);

    // Normalize output through validation pipeline
    const result = normalizeBridgeOutput(rawText, fallback);

    // Record in history for future dedup checks
    if (result.source === 'llm') {
      recordBridgeText(result.text);
    }

    return { text: result.text, transitionStyle: 'outro', source: result.source };
  } catch (err) {
    logger.warn('SEGMENT', `LLM bridge failed: ${err.message}, falling back to template`);
    return { ...fallback, source: 'template' };
  }
}

// ── Bridge Generation ─────────────────────────────────────────

/**
 * Generate a bridge segment between two confirmed songs.
 * Uses template-based generation (LLM bridges are generated in batch during program_start).
 * This function is for post-generation of individual bridges.
 *
 * @param {object} prevSong - { name, artist }
 * @param {object} nextSong - { name, artist }
 * @param {object} [options] - { style, context }
 * @returns {object} Segment text and transition style
 */
function generateBridgeText(prevSong, nextSong, options = {}) {
  const templates = [
    `从${prevSong.artist}的《${prevSong.name}》过渡到${nextSong.artist}的《${nextSong.name}》，音乐在流动。`,
    `听完《${prevSong.name}》，接下来是${nextSong.artist}带来的《${nextSong.name}》。`,
    `《${prevSong.name}》的余韵还在，${nextSong.artist}的《${nextSong.name}》已经准备好了。`,
    `刚才那首《${prevSong.name}》很动人，这首《${nextSong.name}》也不会让你失望。`,
    `${prevSong.artist}和${nextSong.artist}，两种味道，一样好听。`,
  ];
  const text = templates[Math.floor(Math.random() * templates.length)];
  return { text, transitionStyle: 'outro' };
}

// ── LLM Bridge Generation ────────────────────────────────────

// Bridge text dedup history — tracks recent bridge texts to avoid repetition
const BRIDGE_HISTORY_MAX = 20;
let _bridgeTextHistory = [];

/**
 * Record a bridge text in history for dedup checking.
 * @param {string} text - The bridge text that was used
 */
function recordBridgeText(text) {
  if (!text) return;
  _bridgeTextHistory.unshift(text);
  if (_bridgeTextHistory.length > BRIDGE_HISTORY_MAX) {
    _bridgeTextHistory = _bridgeTextHistory.slice(0, BRIDGE_HISTORY_MAX);
  }
}

/**
 * Check if a bridge text is too similar to recent ones.
 * Uses character-level overlap as a lightweight similarity metric.
 *
 * @param {string} text - Candidate bridge text
 * @param {number} [threshold=0.4] - Max allowed overlap ratio (0-1)
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function checkBridgeDedup(text, threshold = 0.4) {
  if (!text || _bridgeTextHistory.length === 0) {
    return { allowed: true, reason: null };
  }

  for (const prev of _bridgeTextHistory) {
    // Exact match
    if (text === prev) {
      return { allowed: false, reason: 'exact_duplicate' };
    }

    // Character overlap: what fraction of the new text's chars appear in the old text
    const overlap = charOverlap(text, prev);
    if (overlap > threshold) {
      return { allowed: false, reason: `too_similar (${(overlap * 100).toFixed(0)}% overlap)` };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Reset bridge history (for testing).
 */
function resetBridgeHistory() {
  _bridgeTextHistory = [];
}

/**
 * Calculate character-level overlap ratio between two strings.
 * Returns 0 (completely different) to 1 (identical).
 */
function charOverlap(a, b) {
  if (!a || !b) return 0;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length >= b.length ? a : b;

  let matches = 0;
  const longerChars = new Set(longer.split(''));
  for (const ch of shorter) {
    if (longerChars.has(ch)) {
      matches++;
      longerChars.delete(ch); // Count each char only once
    }
  }
  return matches / shorter.length;
}

// ── Cold Open Generation (Narrative Arc) ─────────────────────

/**
 * Cold open narrative arc parts.
 * Inspired by Claudio-FM's 5-part structure for opening narrations.
 * Not every cold open needs all 5 parts — the LLM decides based on context.
 *
 * anchor:     Sets the scene ("周一晚上十点，窗外开始安静了")
 * heart:      Emotional core ("今天过得怎么样，只有你自己知道")
 * turn:       Shift in perspective ("不过没关系，接下来的时间交给音乐")
 * image:      Vivid sensory detail ("耳机里传来第一个音符的时候，世界就慢下来了")
 * invitation: Call to connection ("今晚的歌单，为你准备")
 */
const COLD_OPEN_PARTS = ['anchor', 'heart', 'turn', 'image', 'invitation'];

/**
 * Generate a cold open segment — the opening narration before the first song.
 * Uses the LLM to create a contextually rich, persona-consistent opening.
 *
 * @param {object} firstSong - { name, artist, tags? } — The first song in the set
 * @param {object} deepseek - DeepSeekAdapter instance
 * @param {object} [options] - { bridgeContext, parts: string[] }
 * @returns {Promise<{ text: string|null, parts: Array<{part, text}>, source: string }>}
 */
async function generateColdOpen(firstSong, deepseek, options = {}) {
  if (!deepseek || typeof deepseek.rawChat !== 'function') {
    return { text: null, parts: [], source: 'none' };
  }

  const bridgeContext = options.bridgeContext || null;
  const { systemPrompt, userPrompt } = promptBuilders.buildColdOpenPrompt(firstSong, bridgeContext);

  try {
    const rawText = await deepseek.rawChat(systemPrompt, userPrompt, {
      temperature: 0.85,
      maxTokens: 300,
      timeout: 20000,
    });

    // Clean output
    let cleaned = (rawText || '')
      .replace(/^["'"「『【\s]+/, '')
      .replace(/["'"」』】\s]+$/, '')
      .trim();

    // Length validation
    if (cleaned.length < 30) {
      logger.warn('SEGMENT', `Cold open too short: ${cleaned.length} chars`);
      return { text: null, parts: [], source: 'failed' };
    }
    if (cleaned.length > 300) {
      const sentenceEnd = cleaned.lastIndexOf('。', 300);
      if (sentenceEnd > 30) {
        cleaned = cleaned.slice(0, sentenceEnd + 1);
      }
    }

    // Split into narrative parts (best-effort: by sentence boundaries)
    const sentences = cleaned.split(/(?<=[。！？\n])/).filter(s => s.trim());
    const parts = sentences.map((text, i) => ({
      part: COLD_OPEN_PARTS[i] || `extra_${i}`,
      text: text.trim(),
    }));

    return { text: cleaned, parts, source: 'llm' };
  } catch (err) {
    logger.warn('SEGMENT', `Cold open generation failed: ${err.message}`);
    return { text: null, parts: [], source: 'failed' };
  }
}

// ── Back Announce Generation ──────────────────────────────────

/**
 * Generate a back_announce segment — a brief post-song commentary.
 * Played after a song ends and before the next one starts.
 *
 * @param {object} song - { name, artist, tags? }
 * @param {object} [options] - { mood, context }
 * @returns {{ text: string, transitionStyle: string }}
 */
function generateBackAnnounce(song, options = {}) {
  const name = song.name || song.trackName || '这首歌';
  const artist = song.artist || '';

  const templates = [
    `刚才那是${artist ? artist + '的' : ''}《${name}》，${pickRandom(['经典中的经典', '百听不厌', '让人回味无穷', '值得反复品味'])}。`,
    `${artist ? artist : ''}的《${name}》，${pickRandom(['每次听都有新感受', '总能戳中某个柔软的角落', '旋律还在耳边绕', '情绪还沉浸在里面'])}。`,
    `一首《${name}》${pickRandom(['送给此刻的你', '献给这个夜晚', '配得上你现在的状态', '刚好契合当下的心情'])}。`,
    `《${name}》播完了，${pickRandom(['但余韵可以留久一点', '好歌总是让人觉得太短', '让这份感觉多停留一会儿', '音乐停了，情绪还在继续'])}。`,
  ];

  // Emotional/instrumental tracks get softer commentary
  const tags = (song.tags || '').toLowerCase();
  if (tags.includes('ambient') || tags.includes('instrumental') || tags.includes('classical')) {
    return {
      text: pickRandom([
        `《${name}》的旋律渐渐散去，什么都不用说。`,
        `有些音乐不需要语言，刚才的《${name}》就是。`,
      ]),
      transitionStyle: 'none',
    };
  }

  return {
    text: pickRandom(templates),
    transitionStyle: 'none',
  };
}

// ── Missing Segment Fallback ─────────────────────────────────

/**
 * Fill missing rhythm decisions when Brain doesn't output complete segments.
 * Deterministic fallback: night → silence, daytime → bridge.
 * No LLM calls, no randomness.
 *
 * @param {number} trackCount - Number of tracks in the batch
 * @param {Array} brainSegments - Normalized segments from Brain
 * @returns {Map<number, object>} Gap index → segment decision
 */
function fillMissingSegments(trackCount, brainSegments) {
  const decisions = new Map();

  // First, collect Brain's explicit between_tracks decisions
  for (const seg of (brainSegments || [])) {
    if (seg.position === 'between_tracks') {
      const gapIndex = typeof seg.afterTrackIndex === 'number'
        ? seg.afterTrackIndex
        : (typeof seg.anchorTrackIndex === 'number' ? seg.anchorTrackIndex : null);
      if (gapIndex !== null) {
        decisions.set(gapIndex, seg);
      }
    }
  }

  // For missing gaps, use deterministic time-of-day rule
  const hour = new Date().getHours();
  const isNight = hour >= 23 || hour < 6;
  const defaultType = isNight ? 'silence' : 'bridge';

  for (let i = 0; i < trackCount - 1; i++) {
    if (!decisions.has(i)) {
      decisions.set(i, {
        type: defaultType,
        afterTrackIndex: i,
        beforeTrackIndex: i + 1,
        position: 'between_tracks',
        text: '',
        _filled: true, // Mark as fallback for logging
      });
    }
  }

  return decisions;
}

// ── Shared Helpers ────────────────────────────────────────────

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Segment Factories ─────────────────────────────────────────

/**
 * Build a back_announce Segment object for a confirmed track.
 * @param {object} song - { name, artist, tags? }
 * @param {number} anchorIndex - Track's index in the batch
 * @param {string} [idPrefix='back'] - ID prefix for uniqueness
 * @returns {object} Segment
 */
function buildBackAnnounceSegment(song, anchorIndex, idPrefix = 'back') {
  const info = generateBackAnnounce(song);
  return {
    id: `seg:back_announce:${idPrefix}:${anchorIndex}`,
    type: 'back_announce',
    position: 'after_track',
    afterTrackIndex: anchorIndex,
    beforeTrackIndex: null,
    text: info.text,
    ttsUrl: null,
    ttsStatus: 'pending',
    transitionStyle: info.transitionStyle,
    metadata: { prevSong: { name: song.name || song.trackName, artist: song.artist } },
  };
}

/**
 * Build a silence Segment object.
 * @param {number} anchorIndex - Track's index in the batch
 * @param {string} reason - Why silence was chosen
 * @param {string} [idPrefix='silence'] - ID prefix for uniqueness
 * @returns {object} Segment
 */
function buildSilenceSegment(anchorIndex, reason, idPrefix = 'silence', nextIndex = null) {
  return {
    id: `seg:silence:${idPrefix}:${anchorIndex}`,
    type: 'silence',
    position: 'between_tracks',
    afterTrackIndex: anchorIndex,
    beforeTrackIndex: nextIndex,
    text: '',
    ttsUrl: null,
    ttsStatus: 'silent',
    transitionStyle: 'none',
    metadata: { silenceReason: reason },
  };
}

/**
 * Synthesize TTS for a segment and update its status.
 * @param {object} segment - Segment object (mutated in place)
 * @returns {Promise<object>} Updated segment
 */
async function resolveSegmentTTS(segment) {
  if (segment.ttsStatus === 'silent' || !segment.text) {
    segment.ttsStatus = 'silent';
    return segment;
  }

  try {
    const ttsResult = await tts.synthesize(segment.text);
    segment.ttsUrl = ttsResult.url;
    segment.ttsStatus = ttsResult.url ? 'ready' : 'failed';
  } catch (err) {
    logger.warn('SEGMENT', `TTS failed for segment ${segment.id}: ${err.message}`);
    segment.ttsStatus = 'failed';
  }

  return segment;
}

// ── Dedup Checking ────────────────────────────────────────────

/**
 * Check if a track should be excluded based on dedup rules.
 *
 * @param {object} track - { name, artist, trackId }
 * @param {object} dedupState - {
 *   batchIds: Set<trackId>,         // L1: tracks in current batch
 *   queueIds: Set<trackId>,         // L2: tracks in play queue
 *   recentPlays: Array<{trackId, artist, playedAt}>, // L3/L4: recent history
 * }
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function dedupCheck(track, dedupState) {
  const trackId = track.trackId || track.track_id;
  const artist = (track.artist || '').toLowerCase();

  // L1: Batch duplicate
  if (dedupState.batchIds && dedupState.batchIds.has(trackId)) {
    return { allowed: false, reason: 'batch_duplicate' };
  }

  // L2: Queue duplicate
  if (dedupState.queueIds && dedupState.queueIds.has(trackId)) {
    return { allowed: false, reason: 'queue_duplicate' };
  }

  // L3: Cooldown (24 hours)
  if (dedupState.recentPlays && dedupState.recentPlays.length > 0) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentlyPlayed = dedupState.recentPlays.filter(
      (p) => new Date(p.playedAt || p.played_at).getTime() > cutoff
    );
    if (recentlyPlayed.some((p) => (p.trackId || p.track_id) === trackId)) {
      return { allowed: false, reason: 'cooldown_duplicate' };
    }

    // L4: Artist overexposure (same artist in last 5 plays)
    const last5 = dedupState.recentPlays.slice(0, 5);
    const recentArtists = new Set(
      last5.map((p) => (p.artist || '').toLowerCase()).filter(Boolean)
    );
    if (artist && recentArtists.has(artist)) {
      return { allowed: false, reason: 'artist_overexposure' };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Filter a list of songs through the dedup state machine.
 * Returns only the songs that pass all checks.
 *
 * @param {Array} songs - [{ name, artist, trackId? }]
 * @param {object} dedupState - Same as dedupCheck
 * @returns {{ accepted: Array, rejected: Array<{song, reason}> }}
 */
function dedupFilter(songs, dedupState) {
  const accepted = [];
  const rejected = [];
  const batchIds = new Set(dedupState.batchIds || []);

  for (const song of songs) {
    const trackId = song.trackId || song.track_id || song.ncmTrackId;
    const checkState = { ...dedupState, batchIds };
    const result = dedupCheck({ ...song, trackId }, checkState);

    if (result.allowed) {
      accepted.push(song);
      if (trackId) batchIds.add(trackId);
    } else {
      rejected.push({ song, reason: result.reason });
      logger.info('SEGMENT', `Dedup rejected: "${song.name}" — ${result.reason}`);
    }
  }

  return { accepted, rejected };
}

// ── Segment Lookup ────────────────────────────────────────────

/**
 * Find segments for a specific track position.
 *
 * @param {Map} segmentMap - stationState segments (key: "position:index")
 * @param {number} trackIndex - Track's index in the queue
 * @returns {{ beforeTrack: Segment|null, afterTrack: Segment|null }}
 */
function getSegmentsForTrack(segmentMap, trackIndex) {
  if (!segmentMap || segmentMap.size === 0) {
    return { beforeTrack: null, afterTrack: null };
  }

  // Bridge: keyed by afterTrackIndex (gap after previous track = before this track)
  const bridgeKey = `between_tracks:${trackIndex - 1}`;
  const coldOpenKey = `before_track:${trackIndex}`;
  const beforeTrack = segmentMap.get(coldOpenKey) || segmentMap.get(bridgeKey) || null;

  // Back announce: keyed by afterTrackIndex (this track)
  const afterKey = `after_track:${trackIndex}`;
  const afterTrack = segmentMap.get(afterKey) || null;

  return { beforeTrack, afterTrack };
}

/**
 * Store segments in a Map keyed by "position:index" for O(1) lookup.
 * Uses afterTrackIndex for between_tracks/after_track, beforeTrackIndex for before_track.
 * @param {Array<Segment>} segments
 * @returns {Map<string, Segment>}
 */
function buildSegmentMap(segments) {
  const map = new Map();
  for (const seg of segments) {
    const index = seg.position === 'before_track'
      ? (seg.beforeTrackIndex ?? seg.afterTrackIndex)
      : (seg.afterTrackIndex ?? seg.beforeTrackIndex);
    if (index !== null && index !== undefined) {
      const key = `${seg.position}:${index}`;
      map.set(key, seg);
    }
  }
  return map;
}

module.exports = {
  normalizeSegments,
  generateBridgeText,
  generateBridgeLLM,
  generateColdOpen,
  generateBackAnnounce,
  fillMissingSegments,
  resolveSegmentTTS,
  dedupCheck,
  dedupFilter,
  getSegmentsForTrack,
  buildSegmentMap,
  buildBackAnnounceSegment,
  buildSilenceSegment,
  normalizeBridgeOutput,
  checkBridgeDedup,
  recordBridgeText,
  resetBridgeHistory,
  charOverlap,
  VALID_TYPES,
  VALID_POSITIONS,
  COLD_OPEN_PARTS,
};
