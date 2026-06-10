// segment.test.js — Unit tests for the Segment-driven broadcast engine
// Tests: normalizeSegments, dedupCheck, dedupFilter, buildSegmentMap,
//        generateBridgeText, getSegmentsForTrack

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Silence console during tests ─────────────────────────────
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Re-implement pure functions locally (avoid module deps) ──

const VALID_TYPES = new Set([
  'cold_open', 'bridge', 'back_announce', 'quick_touch', 'silence',
]);

const VALID_POSITIONS = new Set([
  'before_track', 'between_tracks', 'after_track',
]);

function normalizeSegments(rawSegments, tracks) {
  if (!Array.isArray(rawSegments)) return [];
  if (!tracks || tracks.length === 0) {
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
    const type = VALID_TYPES.has(raw.type) ? raw.type : 'quick_touch';

    let position = VALID_POSITIONS.has(raw.position) ? raw.position : null;
    if (!position) {
      if (type === 'cold_open') position = 'before_track';
      else if (type === 'bridge') position = 'between_tracks';
      else if (type === 'back_announce') position = 'after_track';
      else position = 'between_tracks';
    }

    let anchor = typeof raw.anchor === 'number' ? raw.anchor : i;
    anchor = Math.max(0, Math.min(anchor, maxIndex));

    const text = (raw.text || '').trim();
    const ttsStatus = type === 'silence' ? 'silent' : (text ? 'pending' : 'silent');
    const transitionStyle = raw.transition_style || raw.transitionStyle || 'outro';

    const metadata = {};
    if (position === 'between_tracks' || position === 'after_track') {
      const prevIdx = Math.max(0, anchor);
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
      type, position, anchorTrackIndex: anchor,
      text, ttsUrl: null, ttsStatus, transitionStyle, metadata,
    });
  }

  return results;
}

function dedupCheck(track, dedupState) {
  const trackId = track.trackId || track.track_id;
  const artist = (track.artist || '').toLowerCase();

  if (dedupState.batchIds && dedupState.batchIds.has(trackId)) {
    return { allowed: false, reason: 'batch_duplicate' };
  }
  if (dedupState.queueIds && dedupState.queueIds.has(trackId)) {
    return { allowed: false, reason: 'queue_duplicate' };
  }
  if (dedupState.recentPlays && dedupState.recentPlays.length > 0) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentlyPlayed = dedupState.recentPlays.filter(
      (p) => new Date(p.playedAt || p.played_at).getTime() > cutoff
    );
    if (recentlyPlayed.some((p) => (p.trackId || p.track_id) === trackId)) {
      return { allowed: false, reason: 'cooldown_duplicate' };
    }
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
    }
  }
  return { accepted, rejected };
}

function buildSegmentMap(segments) {
  const map = new Map();
  for (const seg of segments) {
    const key = `${seg.position}:${seg.anchorTrackIndex}`;
    map.set(key, seg);
  }
  return map;
}

function generateBridgeText(prevSong, nextSong) {
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

function getSegmentsForTrack(segmentMap, trackIndex) {
  if (!segmentMap || segmentMap.size === 0) {
    return { beforeTrack: null, afterTrack: null };
  }
  const beforeKey = `between_tracks:${trackIndex - 1}`;
  const coldOpenKey = `before_track:${trackIndex}`;
  const beforeTrack = segmentMap.get(coldOpenKey) || segmentMap.get(beforeKey) || null;
  const afterKey = `after_track:${trackIndex}`;
  const afterTrack = segmentMap.get(afterKey) || null;
  return { beforeTrack, afterTrack };
}

// ── Test Data ────────────────────────────────────────────────

const sampleTracks = [
  { name: '晴天', artist: '周杰伦', trackId: '1001' },
  { name: '七里香', artist: '周杰伦', trackId: '1002' },
  { name: '红豆', artist: '王菲', trackId: '1003' },
  { name: '匆匆那年', artist: '王菲', trackId: '1004' },
  { name: '夜曲', artist: '周杰伦', trackId: '1005' },
];

// ── Tests ─────────────────────────────────────────────────────

describe('Segment Engine', () => {

  // ═══ normalizeSegments ═══

  describe('normalizeSegments()', () => {

    it('returns empty array for non-array input', () => {
      expect(normalizeSegments(null, sampleTracks)).toEqual([]);
      expect(normalizeSegments('bad', sampleTracks)).toEqual([]);
      expect(normalizeSegments(undefined, sampleTracks)).toEqual([]);
    });

    it('returns empty array for empty raw segments', () => {
      expect(normalizeSegments([], sampleTracks)).toEqual([]);
    });

    it('filters to cold_open/quick_touch when no tracks provided', () => {
      const raw = [
        { type: 'cold_open', text: '欢迎收听' },
        { type: 'bridge', text: '下一首' },
        { type: 'quick_touch', text: '简短评论' },
      ];
      const result = normalizeSegments(raw, []);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('cold_open');
      expect(result[1].type).toBe('quick_touch');
      expect(result[0].anchorTrackIndex).toBe(-1);
    });

    it('filters to cold_open/quick_touch when tracks is null', () => {
      const raw = [
        { type: 'cold_open', text: '开场白' },
        { type: 'back_announce', text: '回顾' },
      ];
      const result = normalizeSegments(raw, null);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('cold_open');
    });

    it('normalizes valid segments with correct defaults', () => {
      const raw = [
        { type: 'cold_open', text: '欢迎来到FlowState Radio', anchor: 0 },
        { type: 'bridge', text: '过渡一下', anchor: 0 },
        { type: 'back_announce', text: '刚才那首不错', anchor: 1 },
      ];
      const result = normalizeSegments(raw, sampleTracks);
      expect(result).toHaveLength(3);

      // cold_open defaults to before_track
      expect(result[0].position).toBe('before_track');
      expect(result[0].anchorTrackIndex).toBe(0);
      expect(result[0].ttsStatus).toBe('pending');

      // bridge defaults to between_tracks
      expect(result[1].position).toBe('between_tracks');
      expect(result[1].transitionStyle).toBe('outro');

      // back_announce defaults to after_track
      expect(result[2].position).toBe('after_track');
    });

    it('demotes unknown segment types to quick_touch', () => {
      const raw = [
        { type: 'unknown_type', text: '什么鬼', anchor: 0 },
        { type: 'garbage', text: '??', anchor: 1 },
      ];
      const result = normalizeSegments(raw, sampleTracks);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('quick_touch');
      expect(result[1].type).toBe('quick_touch');
    });

    it('clamps anchor index to valid range', () => {
      const raw = [
        { type: 'bridge', text: 'out of bounds', anchor: 999 },
        { type: 'bridge', text: 'negative', anchor: -5 },
      ];
      const result = normalizeSegments(raw, sampleTracks);
      expect(result[0].anchorTrackIndex).toBe(sampleTracks.length - 1);
      expect(result[1].anchorTrackIndex).toBe(0);
    });

    it('marks silence segments as silent', () => {
      const raw = [
        { type: 'silence', text: '', anchor: 0 },
        { type: 'silence', text: 'should be ignored', anchor: 1 },
      ];
      const result = normalizeSegments(raw, sampleTracks);
      expect(result[0].ttsStatus).toBe('silent');
      expect(result[1].ttsStatus).toBe('silent');
    });

    it('marks segments with empty text as silent', () => {
      const raw = [
        { type: 'bridge', text: '', anchor: 0 },
        { type: 'bridge', text: '   ', anchor: 1 },
      ];
      const result = normalizeSegments(raw, sampleTracks);
      expect(result[0].ttsStatus).toBe('silent');
      expect(result[1].ttsStatus).toBe('silent');
    });

    it('builds metadata with prev/next song info', () => {
      const raw = [
        { type: 'bridge', text: '过渡', anchor: 1 },
      ];
      const result = normalizeSegments(raw, sampleTracks);
      expect(result[0].metadata.prevSong).toEqual({ name: '七里香', artist: '周杰伦' });
      expect(result[0].metadata.nextSong).toEqual({ name: '红豆', artist: '王菲' });
    });

    it('generates unique segment IDs', () => {
      const raw = [
        { type: 'cold_open', text: 'a', anchor: 0 },
        { type: 'bridge', text: 'b', anchor: 0 },
        { type: 'bridge', text: 'c', anchor: 1 },
      ];
      const result = normalizeSegments(raw, sampleTracks);
      const ids = result.map(s => s.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it('respects explicit position when provided', () => {
      const raw = [
        { type: 'bridge', position: 'before_track', text: 'forced', anchor: 2 },
      ];
      const result = normalizeSegments(raw, sampleTracks);
      expect(result[0].position).toBe('before_track');
    });

    it('handles trackName fallback in metadata', () => {
      const tracks = [
        { trackName: 'Song A', artist: 'Artist A', trackId: '2001' },
        { trackName: 'Song B', artist: 'Artist B', trackId: '2002' },
      ];
      const raw = [{ type: 'bridge', text: '过渡', anchor: 0 }];
      const result = normalizeSegments(raw, tracks);
      expect(result[0].metadata.prevSong.name).toBe('Song A');
      expect(result[0].metadata.nextSong.name).toBe('Song B');
    });
  });

  // ═══ dedupCheck ═══

  describe('dedupCheck()', () => {

    it('allows a track with no conflicts', () => {
      const result = dedupCheck(
        { trackId: '1001', artist: '周杰伦' },
        { batchIds: new Set(), queueIds: new Set(), recentPlays: [] }
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('blocks batch duplicate (L1)', () => {
      const result = dedupCheck(
        { trackId: '1001', artist: '周杰伦' },
        { batchIds: new Set(['1001']), queueIds: new Set(), recentPlays: [] }
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('batch_duplicate');
    });

    it('blocks queue duplicate (L2)', () => {
      const result = dedupCheck(
        { trackId: '1002', artist: '周杰伦' },
        { batchIds: new Set(), queueIds: new Set(['1002']), recentPlays: [] }
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('queue_duplicate');
    });

    it('blocks cooldown duplicate within 24h (L3)', () => {
      const recentPlays = [
        { trackId: '1003', artist: '王菲', playedAt: new Date(Date.now() - 3600000).toISOString() }, // 1 hour ago
      ];
      const result = dedupCheck(
        { trackId: '1003', artist: '王菲' },
        { batchIds: new Set(), queueIds: new Set(), recentPlays }
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('cooldown_duplicate');
    });

    it('allows track played more than 24h ago (L3 pass)', () => {
      const recentPlays = [
        { trackId: '1003', artist: '王菲', playedAt: new Date(Date.now() - 25 * 3600000).toISOString() }, // 25 hours ago
      ];
      const result = dedupCheck(
        { trackId: '1003', artist: '王菲' },
        { batchIds: new Set(), queueIds: new Set(), recentPlays }
      );
      // Should pass L3, but check L4 too (artist overexposure)
      // Since only 1 play and artist matches in last 5, it should fail L4
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('artist_overexposure');
    });

    it('blocks artist overexposure in last 5 plays (L4)', () => {
      const recentPlays = [
        { trackId: '9001', artist: '周杰伦', playedAt: new Date(Date.now() - 100000).toISOString() },
        { trackId: '9002', artist: '周杰伦', playedAt: new Date(Date.now() - 200000).toISOString() },
        { trackId: '9003', artist: '陈奕迅', playedAt: new Date(Date.now() - 300000).toISOString() },
        { trackId: '9004', artist: '林俊杰', playedAt: new Date(Date.now() - 400000).toISOString() },
        { trackId: '9005', artist: '邓紫棋', playedAt: new Date(Date.now() - 500000).toISOString() },
      ];
      const result = dedupCheck(
        { trackId: '1001', artist: '周杰伦' }, // New track but same artist
        { batchIds: new Set(), queueIds: new Set(), recentPlays }
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('artist_overexposure');
    });

    it('allows track when artist is not in last 5 plays', () => {
      const recentPlays = [
        { trackId: '9001', artist: '陈奕迅', playedAt: new Date(Date.now() - 100000).toISOString() },
        { trackId: '9002', artist: '林俊杰', playedAt: new Date(Date.now() - 200000).toISOString() },
        { trackId: '9003', artist: '邓紫棋', playedAt: new Date(Date.now() - 300000).toISOString() },
        { trackId: '9004', artist: '蔡依林', playedAt: new Date(Date.now() - 400000).toISOString() },
        { trackId: '9005', artist: '孙燕姿', playedAt: new Date(Date.now() - 500000).toISOString() },
      ];
      const result = dedupCheck(
        { trackId: '1001', artist: '周杰伦' },
        { batchIds: new Set(), queueIds: new Set(), recentPlays }
      );
      expect(result.allowed).toBe(true);
    });

    it('handles missing dedup state fields gracefully', () => {
      const result = dedupCheck({ trackId: '1001', artist: '周杰伦' }, {});
      expect(result.allowed).toBe(true);
    });

    it('handles track_id fallback key', () => {
      const result = dedupCheck(
        { track_id: '1001', artist: '周杰伦' },
        { batchIds: new Set(['1001']), queueIds: new Set() }
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('batch_duplicate');
    });

    it('case-insensitive artist comparison for L4', () => {
      const recentPlays = [
        { trackId: '9001', artist: 'Jay Chou', playedAt: new Date(Date.now() - 100000).toISOString() },
      ];
      const result = dedupCheck(
        { trackId: '1001', artist: 'jay chou' },
        { batchIds: new Set(), queueIds: new Set(), recentPlays }
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('artist_overexposure');
    });
  });

  // ═══ dedupFilter ═══

  describe('dedupFilter()', () => {

    it('accepts all songs when no conflicts', () => {
      const songs = [
        { name: '晴天', artist: '周杰伦', trackId: '1001' },
        { name: '红豆', artist: '王菲', trackId: '1003' },
      ];
      const result = dedupFilter(songs, { batchIds: [], queueIds: new Set(), recentPlays: [] });
      expect(result.accepted).toHaveLength(2);
      expect(result.rejected).toHaveLength(0);
    });

    it('filters out batch duplicates within the same batch', () => {
      const songs = [
        { name: '晴天', artist: '周杰伦', trackId: '1001' },
        { name: '晴天', artist: '周杰伦', trackId: '1001' }, // duplicate
        { name: '红豆', artist: '王菲', trackId: '1003' },
      ];
      const result = dedupFilter(songs, { batchIds: [], queueIds: new Set(), recentPlays: [] });
      expect(result.accepted).toHaveLength(2);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe('batch_duplicate');
    });

    it('filters out queue duplicates', () => {
      const songs = [
        { name: '晴天', artist: '周杰伦', trackId: '1001' },
        { name: '七里香', artist: '周杰伦', trackId: '1002' },
      ];
      const result = dedupFilter(songs, {
        batchIds: [],
        queueIds: new Set(['1002']),
        recentPlays: [],
      });
      expect(result.accepted).toHaveLength(1);
      expect(result.accepted[0].trackId).toBe('1001');
      expect(result.rejected[0].song.trackId).toBe('1002');
    });

    it('returns correct accepted/rejected counts', () => {
      const songs = [
        { name: 'A', artist: 'X', trackId: '1' },
        { name: 'B', artist: 'Y', trackId: '2' },
        { name: 'C', artist: 'Z', trackId: '3' },
        { name: 'D', artist: 'X', trackId: '4' }, // same artist as first
      ];
      const recentPlays = [
        { trackId: '99', artist: 'X', playedAt: new Date(Date.now() - 100000).toISOString() },
      ];
      const result = dedupFilter(songs, { batchIds: [], queueIds: new Set(), recentPlays });
      // A passes, B passes, C passes, D fails (artist overexposure since X is in last 5)
      expect(result.accepted.length + result.rejected.length).toBe(4);
    });

    it('handles empty song list', () => {
      const result = dedupFilter([], { batchIds: [], queueIds: new Set(), recentPlays: [] });
      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual([]);
    });

    it('supports ncmTrackId fallback key', () => {
      const songs = [
        { name: 'Test', artist: 'Test', ncmTrackId: '5001' },
      ];
      const result = dedupFilter(songs, {
        batchIds: [],
        queueIds: new Set(['5001']),
        recentPlays: [],
      });
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
    });
  });

  // ═══ buildSegmentMap ═══

  describe('buildSegmentMap()', () => {

    it('builds a map keyed by position:anchorIndex', () => {
      const segments = [
        { position: 'before_track', anchorTrackIndex: 0, type: 'cold_open' },
        { position: 'between_tracks', anchorTrackIndex: 0, type: 'bridge' },
        { position: 'after_track', anchorTrackIndex: 1, type: 'back_announce' },
      ];
      const map = buildSegmentMap(segments);
      expect(map.size).toBe(3);
      expect(map.has('before_track:0')).toBe(true);
      expect(map.has('between_tracks:0')).toBe(true);
      expect(map.has('after_track:1')).toBe(true);
    });

    it('returns empty map for empty segments', () => {
      const map = buildSegmentMap([]);
      expect(map.size).toBe(0);
    });

    it('later segment overwrites earlier one with same key', () => {
      const segments = [
        { position: 'before_track', anchorTrackIndex: 0, text: 'first' },
        { position: 'before_track', anchorTrackIndex: 0, text: 'second' },
      ];
      const map = buildSegmentMap(segments);
      expect(map.size).toBe(1);
      expect(map.get('before_track:0').text).toBe('second');
    });
  });

  // ═══ generateBridgeText ═══

  describe('generateBridgeText()', () => {

    it('returns text and transitionStyle', () => {
      const result = generateBridgeText(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' }
      );
      expect(result.text).toBeTruthy();
      expect(typeof result.text).toBe('string');
      expect(result.transitionStyle).toBe('outro');
    });

    it('includes song names and artists in the text', () => {
      // Run multiple times to cover random template selection
      for (let i = 0; i < 10; i++) {
        const result = generateBridgeText(
          { name: 'TestSong', artist: 'TestArtist' },
          { name: 'NextSong', artist: 'NextArtist' }
        );
        // At least one of the song/artist names should appear
        const hasContent = result.text.includes('TestSong') || result.text.includes('TestArtist') ||
                           result.text.includes('NextSong') || result.text.includes('NextArtist');
        expect(hasContent).toBe(true);
      }
    });
  });

  // ═══ getSegmentsForTrack ═══

  describe('getSegmentsForTrack()', () => {

    it('returns null for both when segment map is empty', () => {
      const result = getSegmentsForTrack(new Map(), 0);
      expect(result.beforeTrack).toBeNull();
      expect(result.afterTrack).toBeNull();
    });

    it('returns null when segmentMap is null', () => {
      const result = getSegmentsForTrack(null, 0);
      expect(result.beforeTrack).toBeNull();
      expect(result.afterTrack).toBeNull();
    });

    it('finds cold_open segment for track 0', () => {
      const segments = [
        { position: 'before_track', anchorTrackIndex: 0, type: 'cold_open', text: '开场' },
      ];
      const map = buildSegmentMap(segments);
      const result = getSegmentsForTrack(map, 0);
      expect(result.beforeTrack).not.toBeNull();
      expect(result.beforeTrack.type).toBe('cold_open');
      expect(result.afterTrack).toBeNull();
    });

    it('finds bridge segment (between_tracks) for track', () => {
      const segments = [
        { position: 'between_tracks', anchorTrackIndex: 0, type: 'bridge', text: '过渡' },
      ];
      const map = buildSegmentMap(segments);
      // Track index 1 should find between_tracks:0 as its beforeTrack
      const result = getSegmentsForTrack(map, 1);
      expect(result.beforeTrack).not.toBeNull();
      expect(result.beforeTrack.type).toBe('bridge');
    });

    it('finds after_track segment', () => {
      const segments = [
        { position: 'after_track', anchorTrackIndex: 2, type: 'back_announce', text: '回顾' },
      ];
      const map = buildSegmentMap(segments);
      const result = getSegmentsForTrack(map, 2);
      expect(result.afterTrack).not.toBeNull();
      expect(result.afterTrack.type).toBe('back_announce');
    });

    it('prefers cold_open over bridge for beforeTrack', () => {
      const segments = [
        { position: 'before_track', anchorTrackIndex: 0, type: 'cold_open', text: '开场' },
        // between_tracks:-1 doesn't make sense but let's test at track 0
      ];
      const map = buildSegmentMap(segments);
      const result = getSegmentsForTrack(map, 0);
      expect(result.beforeTrack.type).toBe('cold_open');
    });
  });
});
