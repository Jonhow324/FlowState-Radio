// services/segmentEngine.js — Segment-driven broadcast engine
// Handles: segment normalization, bridge generation, dedup checking, TTS resolution
// Replaces ad-hoc filler logic with structured segment types.

const tts = require('../tts');
const logger = require('../utils/logger');

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
        anchorTrackIndex: -1,
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

    // Text
    const text = (raw.text || '').trim();

    // Silence segments have no text
    const ttsStatus = type === 'silence' ? 'silent' : (text ? 'pending' : 'silent');

    // Transition style
    const transitionStyle = raw.transition_style || raw.transitionStyle || 'outro';

    // Build metadata from adjacent tracks
    const metadata = {};
    if (position === 'between_tracks' || position === 'after_track') {
      const prevIdx = Math.max(0, anchor - (position === 'between_tracks' ? 0 : 0));
      if (tracks[prevIdx]) {
        metadata.prevSong = { name: tracks[prevIdx].name || tracks[prevIdx].trackName, artist: tracks[prevIdx].artist };
      }
    }
    if (position === 'between_tracks' || position === 'before_track') {
      const nextIdx = position === 'between_tracks' ? anchor + 1 : anchor;
      if (tracks[nextIdx]) {
        metadata.nextSong = { name: tracks[nextIdx].name || tracks[nextIdx].trackName, artist: tracks[nextIdx].artist };
      }
    }

    results.push({
      id: `seg:${type}:${anchor}:${i}`,
      type,
      position,
      anchorTrackIndex: anchor,
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

/**
 * Generate a bridge segment between two songs using LLM (DeepSeek rawChat).
 * Falls back to template-based generateBridgeText() on any failure.
 *
 * @param {object} prevSong - { name, artist, tags? }
 * @param {object} nextSong - { name, artist, tags? }
 * @param {object} deepseek - DeepSeekAdapter instance (must have rawChat)
 * @param {object} [options] - { temperature, maxTokens, timeout }
 * @returns {Promise<{ text: string, transitionStyle: string, source: 'llm'|'template' }>}
 */
async function generateBridgeLLM(prevSong, nextSong, deepseek, options = {}) {
  const fallback = generateBridgeText(prevSong, nextSong);

  // Guard: if deepseek is not provided or rawChat is missing, fall back
  if (!deepseek || typeof deepseek.rawChat !== 'function') {
    return { ...fallback, source: 'template' };
  }

  const systemPrompt = [
    '你是一个私人音乐电台DJ，风格温暖、自然、不做作。',
    '你的任务是用一句话串联两首歌之间的过渡，让听众觉得音乐在自然流动。',
    '',
    '要求：',
    '- 只输出一句话（15-60字），不要引号、不要前缀',
    '- 可以提到歌名、歌手、情绪、风格上的联系',
    '- 语气像朋友在耳边轻声说话，不要播音腔',
    '- 不要用"让我们"、"接下来"这类套话开头',
    '- 禁止使用 emoji',
  ].join('\n');

  const prevName = prevSong.name || prevSong.trackName || '未知';
  const prevArtist = prevSong.artist || '未知';
  const nextName = nextSong.name || nextSong.trackName || '未知';
  const nextArtist = nextSong.artist || '未知';

  let userPrompt = `上一首：${prevArtist} -《${prevName}》`;
  if (prevSong.tags) userPrompt += `\n标签：${prevSong.tags}`;
  userPrompt += `\n下一首：${nextArtist} -《${nextName}》`;
  if (nextSong.tags) userPrompt += `\n标签：${nextSong.tags}`;

  try {
    const text = await deepseek.rawChat(systemPrompt, userPrompt, {
      temperature: options.temperature ?? 0.9,
      maxTokens: options.maxTokens ?? 100,
      timeout: options.timeout ?? 12000,
    });

    // Validate: not empty, not too long (Chinese chars count as ~1)
    const cleaned = text.replace(/^["'"「『【]+/, '').replace(/["'"」』】]+$/, '').trim();
    if (!cleaned || cleaned.length < 5 || cleaned.length > 120) {
      logger.warn('SEGMENT', `LLM bridge too short/long (${cleaned.length} chars), falling back`);
      return { ...fallback, source: 'template' };
    }

    // If LLM accidentally included the song names in a template-like way, still accept
    return { text: cleaned, transitionStyle: 'outro', source: 'llm' };
  } catch (err) {
    logger.warn('SEGMENT', `LLM bridge generation failed: ${err.message}, falling back to template`);
    return { ...fallback, source: 'template' };
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

// ── Silence Detection ─────────────────────────────────────────

const SILENCE_CONFIG = {
  nightHoursStart: 23,       // 深夜开始：23:00
  nightHoursEnd: 6,          // 深夜结束：06:00
  nightSilenceProbability: 0.4,  // 深夜 40% 概率插入 silence
  consecutiveBridgeLimit: 3, // 连续 3 个 bridge 后考虑 silence
  emotionalTags: new Set([
    'emotional', 'ambient', 'instrumental', 'classical',
    'post-rock', 'shoegaze', 'dream pop', '冥想', '纯音乐',
    '新世纪', '氛围', '后摇', '治愈',
  ]),
};

/**
 * Decide whether a silence segment should be inserted at this position.
 *
 * @param {object} context
 * @param {object} context.prevSong - { name, artist, tags? }
 * @param {object} [context.nextSong] - { name, artist, tags? }
 * @param {number} context.consecutiveBridges - How many bridges in a row so far
 * @param {number} [context.hour] - Current hour (0-23), defaults to Date.now()
 * @returns {{ shouldSilence: boolean, reason: string|null }}
 */
function shouldSilence(context = {}) {
  const { prevSong, nextSong, consecutiveBridges = 0 } = context;
  const hour = typeof context.hour === 'number' ? context.hour : new Date().getHours();

  // Rule 1: Emotional/ambient tracks → silence lets the mood breathe
  const prevTags = ((prevSong?.tags || '') + ' ' + (prevSong?.mood || '')).toLowerCase();
  const nextTags = ((nextSong?.tags || '') + ' ' + (nextSong?.mood || '')).toLowerCase();
  const prevIsEmotional = [...SILENCE_CONFIG.emotionalTags].some(t => prevTags.includes(t));
  const nextIsEmotional = [...SILENCE_CONFIG.emotionalTags].some(t => nextTags.includes(t));

  if (prevIsEmotional) {
    return { shouldSilence: true, reason: 'emotional_prev' };
  }

  // Rule 2: Late night — reduce DJ chatter with probability
  const isNight = hour >= SILENCE_CONFIG.nightHoursStart || hour < SILENCE_CONFIG.nightHoursEnd;
  if (isNight && Math.random() < SILENCE_CONFIG.nightSilenceProbability) {
    return { shouldSilence: true, reason: 'night_mode' };
  }

  // Rule 3: Too many consecutive bridges — give listeners a breather
  if (consecutiveBridges >= SILENCE_CONFIG.consecutiveBridgeLimit) {
    return { shouldSilence: true, reason: 'bridge_fatigue' };
  }

  // Rule 4: Next track is emotional → silence as a gentle lead-in
  if (nextIsEmotional) {
    return { shouldSilence: true, reason: 'emotional_next' };
  }

  return { shouldSilence: false, reason: null };
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
    anchorTrackIndex: anchorIndex,
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
function buildSilenceSegment(anchorIndex, reason, idPrefix = 'silence') {
  return {
    id: `seg:silence:${idPrefix}:${anchorIndex}`,
    type: 'silence',
    position: 'between_tracks',
    anchorTrackIndex: anchorIndex,
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
 * @param {Map} segmentMap - stationState segments (key: "position:anchorIndex")
 * @param {number} trackIndex - Track's index in the queue
 * @returns {{ beforeTrack: Segment|null, afterTrack: Segment|null }}
 */
function getSegmentsForTrack(segmentMap, trackIndex) {
  if (!segmentMap || segmentMap.size === 0) {
    return { beforeTrack: null, afterTrack: null };
  }

  // Check for before_track and between_tracks segments
  const beforeKey = `between_tracks:${trackIndex - 1}`;
  const coldOpenKey = `before_track:${trackIndex}`;
  const beforeTrack = segmentMap.get(coldOpenKey) || segmentMap.get(beforeKey) || null;

  // Check for after_track segment
  const afterKey = `after_track:${trackIndex}`;
  const afterTrack = segmentMap.get(afterKey) || null;

  return { beforeTrack, afterTrack };
}

/**
 * Store segments in a Map keyed by "position:anchorIndex" for O(1) lookup.
 * @param {Array<Segment>} segments
 * @returns {Map<string, Segment>}
 */
function buildSegmentMap(segments) {
  const map = new Map();
  for (const seg of segments) {
    const key = `${seg.position}:${seg.anchorTrackIndex}`;
    map.set(key, seg);
  }
  return map;
}

module.exports = {
  normalizeSegments,
  generateBridgeText,
  generateBridgeLLM,
  generateBackAnnounce,
  shouldSilence,
  resolveSegmentTTS,
  dedupCheck,
  dedupFilter,
  getSegmentsForTrack,
  buildSegmentMap,
  buildBackAnnounceSegment,
  buildSilenceSegment,
  VALID_TYPES,
  VALID_POSITIONS,
  SILENCE_CONFIG,
};
