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
  resolveSegmentTTS,
  dedupCheck,
  dedupFilter,
  getSegmentsForTrack,
  buildSegmentMap,
  VALID_TYPES,
  VALID_POSITIONS,
};
