// segment.test.js — Unit tests for the Segment-driven broadcast engine
// Tests: normalizeSegments, dedupCheck, dedupFilter, buildSegmentMap,
//        generateBridgeText, generateBridgeLLM, getSegmentsForTrack

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import seg from '../services/segmentEngine.js';

const {
  normalizeSegments,
  dedupCheck,
  dedupFilter,
  buildSegmentMap,
  generateBridgeText,
  generateBridgeLLM,
  generateBackAnnounce,
  getSegmentsForTrack,
  fillMissingSegments,
  buildBackAnnounceSegment,
  buildSilenceSegment,
  normalizeBridgeOutput,
  checkBridgeDedup,
  charOverlap,
  recordBridgeText,
  resetBridgeHistory,
  VALID_TYPES,
  VALID_POSITIONS,
  COLD_OPEN_PARTS,
} = seg;

// ── Silence console during tests ─────────────────────────────
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

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
      expect(result[0].position).toBe('immediate');
      expect(result[1].position).toBe('immediate');
      expect(result[0].afterTrackIndex).toBeNull();
      expect(result[0].beforeTrackIndex).toBeNull();
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
      expect(result[0].beforeTrackIndex).toBe(0);
      expect(result[0].afterTrackIndex).toBeNull();
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
      expect(result[0].afterTrackIndex).toBe(sampleTracks.length - 1);
      expect(result[0].beforeTrackIndex).toBeNull();
      expect(result[1].afterTrackIndex).toBe(0);
      expect(result[1].beforeTrackIndex).toBe(1);
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

    it('immediate segments have null indices and correct ID format', () => {
      const raw = [{ type: 'quick_touch', text: '随感', position: 'immediate' }];
      const result = normalizeSegments(raw, sampleTracks);
      expect(result[0].position).toBe('immediate');
      expect(result[0].afterTrackIndex).toBeNull();
      expect(result[0].beforeTrackIndex).toBeNull();
      expect(result[0].id).toMatch(/^seg:quick_touch:immediate:\d+$/);
    });

    it('immediate position from raw input is preserved when tracks exist', () => {
      const raw = [
        { type: 'cold_open', text: '开场', position: 'immediate' },
        { type: 'bridge', text: '过渡', anchor: 0 },
      ];
      const result = normalizeSegments(raw, sampleTracks);
      expect(result[0].position).toBe('immediate');
      expect(result[0].afterTrackIndex).toBeNull();
      expect(result[0].beforeTrackIndex).toBeNull();
      expect(result[1].position).toBe('between_tracks');
      expect(result[1].afterTrackIndex).toBe(0);
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

    it('builds a map keyed by position:index', () => {
      const segments = [
        { position: 'before_track', beforeTrackIndex: 0, afterTrackIndex: null, type: 'cold_open' },
        { position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 1, type: 'bridge' },
        { position: 'after_track', afterTrackIndex: 1, beforeTrackIndex: null, type: 'back_announce' },
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
        { position: 'before_track', beforeTrackIndex: 0, afterTrackIndex: null, text: 'first' },
        { position: 'before_track', beforeTrackIndex: 0, afterTrackIndex: null, text: 'second' },
      ];
      const map = buildSegmentMap(segments);
      expect(map.size).toBe(1);
      expect(map.get('before_track:0').text).toBe('second');
    });

    it('skips immediate segments (not bound to any track)', () => {
      const segments = [
        { position: 'immediate', afterTrackIndex: null, beforeTrackIndex: null, type: 'quick_touch' },
        { position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 1, type: 'bridge' },
      ];
      const map = buildSegmentMap(segments);
      expect(map.size).toBe(1);
      expect(map.has('between_tracks:0')).toBe(true);
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

  // ═══ generateBridgeLLM ═══

  describe('generateBridgeLLM()', () => {
    beforeEach(() => resetBridgeHistory());

    // Mock bridgeContext to avoid personaLoader → stationState dependency
    const mockBC = { persona: 'Test DJ persona', timeContext: '晚上好', recentPlays: '' };

    function createMockDeepseek(response) {
      return {
        rawChat: vi.fn().mockResolvedValue(response),
      };
    }

    function createFailingDeepseek(error) {
      return {
        rawChat: vi.fn().mockRejectedValue(new Error(error)),
      };
    }

    it('returns LLM-generated text with source: "llm" on success', async () => {
      const deepseek = createMockDeepseek('从摇滚到民谣，情绪在慢慢转弯');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek,
        { bridgeContext: mockBC }
      );
      expect(result.text).toBe('从摇滚到民谣，情绪在慢慢转弯');
      expect(result.source).toBe('llm');
      expect(result.transitionStyle).toBe('outro');
    });

    it('calls rawChat with correct user prompt', async () => {
      const deepseek = createMockDeepseek('音乐在两种风格间自由穿梭');
      await generateBridgeLLM(
        { name: 'SongA', artist: 'ArtistA', tags: 'rock' },
        { name: 'SongB', artist: 'ArtistB', tags: 'jazz' },
        deepseek,
        { bridgeContext: mockBC }
      );
      expect(deepseek.rawChat).toHaveBeenCalledTimes(1);
      const userPrompt = deepseek.rawChat.mock.calls[0][1];
      expect(userPrompt).toContain('SongA');
      expect(userPrompt).toContain('ArtistA');
      expect(userPrompt).toContain('SongB');
      expect(userPrompt).toContain('ArtistB');
      expect(userPrompt).toContain('rock');
      expect(userPrompt).toContain('jazz');
    });

    it('falls back to template when deepseek is null', async () => {
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        null
      );
      expect(result.text).toBeTruthy();
      expect(result.source).toBe('template');
    });

    it('falls back to template when deepseek has no rawChat method', async () => {
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        { think: () => {} }
      );
      expect(result.source).toBe('template');
    });

    it('falls back to template when LLM throws an error', async () => {
      const deepseek = createFailingDeepseek('API timeout');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek,
        { bridgeContext: mockBC }
      );
      expect(result.text).toBeTruthy();
      expect(result.source).toBe('template');
    });

    it('falls back to template when LLM returns empty string', async () => {
      const deepseek = createMockDeepseek('');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek,
        { bridgeContext: mockBC }
      );
      expect(result.source).toBe('template');
    });

    it('accepts any non-empty LLM output regardless of length', async () => {
      const deepseek = createMockDeepseek('短');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek,
        { bridgeContext: mockBC }
      );
      expect(result.source).toBe('llm');
      expect(result.text).toBe('短');
    });

    it('accepts long LLM output without truncation', async () => {
      const longText = '这是一段非常非常长的文字，'.repeat(20);
      const deepseek = createMockDeepseek(longText);
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek,
        { bridgeContext: mockBC }
      );
      expect(result.source).toBe('llm');
      expect(result.text).toBe(longText.trim());
    });

    it('strips leading/trailing quotes from LLM response', async () => {
      const deepseek = createMockDeepseek('"从摇滚到民谣，情绪在慢慢转弯"');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek,
        { bridgeContext: mockBC }
      );
      expect(result.text).toBe('从摇滚到民谣，情绪在慢慢转弯');
      expect(result.source).toBe('llm');
    });

    it('strips Chinese quotes from LLM response', async () => {
      const deepseek = createMockDeepseek('「音乐在两种风格间自由穿梭」');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek,
        { bridgeContext: mockBC }
      );
      expect(result.text).toBe('音乐在两种风格间自由穿梭');
      expect(result.source).toBe('llm');
    });

    it('handles trackName fallback in song info', async () => {
      const deepseek = createMockDeepseek('一首好歌接着另一首好歌');
      await generateBridgeLLM(
        { trackName: 'TrackA', artist: 'A' },
        { trackName: 'TrackB', artist: 'B' },
        deepseek,
        { bridgeContext: mockBC }
      );
      const userPrompt = deepseek.rawChat.mock.calls[0][1];
      expect(userPrompt).toContain('TrackA');
      expect(userPrompt).toContain('TrackB');
    });

    it('omits tags line when song has no tags', async () => {
      const deepseek = createMockDeepseek('自然过渡一句话');
      await generateBridgeLLM(
        { name: 'A', artist: 'B' },
        { name: 'C', artist: 'D' },
        deepseek,
        { bridgeContext: mockBC }
      );
      const userPrompt = deepseek.rawChat.mock.calls[0][1];
      expect(userPrompt).not.toContain('标签');
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
        { position: 'before_track', beforeTrackIndex: 0, afterTrackIndex: null, type: 'cold_open', text: '开场' },
      ];
      const map = buildSegmentMap(segments);
      const result = getSegmentsForTrack(map, 0);
      expect(result.beforeTrack).not.toBeNull();
      expect(result.beforeTrack.type).toBe('cold_open');
      expect(result.afterTrack).toBeNull();
    });

    it('finds bridge segment (between_tracks) for track', () => {
      const segments = [
        { position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 1, type: 'bridge', text: '过渡' },
      ];
      const map = buildSegmentMap(segments);
      // Track index 1 should find between_tracks:0 as its beforeTrack
      const result = getSegmentsForTrack(map, 1);
      expect(result.beforeTrack).not.toBeNull();
      expect(result.beforeTrack.type).toBe('bridge');
    });

    it('finds after_track segment', () => {
      const segments = [
        { position: 'after_track', afterTrackIndex: 2, beforeTrackIndex: null, type: 'back_announce', text: '回顾' },
      ];
      const map = buildSegmentMap(segments);
      const result = getSegmentsForTrack(map, 2);
      expect(result.afterTrack).not.toBeNull();
      expect(result.afterTrack.type).toBe('back_announce');
    });

    it('prefers cold_open over bridge for beforeTrack', () => {
      const segments = [
        { position: 'before_track', beforeTrackIndex: 0, afterTrackIndex: null, type: 'cold_open', text: '开场' },
        // between_tracks:-1 doesn't make sense but let's test at track 0
      ];
      const map = buildSegmentMap(segments);
      const result = getSegmentsForTrack(map, 0);
      expect(result.beforeTrack.type).toBe('cold_open');
    });
  });

  // ═══ generateBackAnnounce (Phase 2) ═══

  describe('generateBackAnnounce()', () => {

    it('returns text and transitionStyle: none', () => {
      const result = generateBackAnnounce({ name: '晴天', artist: '周杰伦' });
      expect(result.text).toBeTruthy();
      expect(typeof result.text).toBe('string');
      expect(result.transitionStyle).toBe('none');
    });

    it('includes song name in the text', () => {
      for (let i = 0; i < 10; i++) {
        const result = generateBackAnnounce({ name: '七里香', artist: '周杰伦' });
        expect(result.text).toContain('七里香');
      }
    });

    it('generates softer commentary for ambient/instrumental tracks', () => {
      const result = generateBackAnnounce({
        name: 'Weightless', artist: 'Marconi Union', tags: 'ambient',
      });
      expect(result.text).toBeTruthy();
      expect(result.transitionStyle).toBe('none');
      // Should be one of the ambient templates
      const hasAmbientFlavor = result.text.includes('旋律') || result.text.includes('不需要语言');
      expect(hasAmbientFlavor).toBe(true);
    });

    it('handles missing artist gracefully', () => {
      const result = generateBackAnnounce({ name: 'Unknown Song' });
      expect(result.text).toBeTruthy();
      expect(result.text).toContain('Unknown Song');
    });

    it('handles missing name with fallback', () => {
      const result = generateBackAnnounce({});
      expect(result.text).toContain('这首歌');
    });
  });

  // ═══ fillMissingSegments ═══

  describe('fillMissingSegments()', () => {

    it('returns a Map with decisions for all gaps', () => {
      const result = fillMissingSegments(5, []);
      expect(result.size).toBe(4); // 5 tracks = 4 gaps
    });

    it('preserves Brain explicit decisions', () => {
      const brainSegments = [
        { position: 'between_tracks', afterTrackIndex: 0, type: 'silence', text: '' },
        { position: 'between_tracks', afterTrackIndex: 2, type: 'bridge', text: '自然过渡' },
      ];
      const result = fillMissingSegments(4, brainSegments);
      expect(result.size).toBe(3); // 4 tracks = 3 gaps
      expect(result.get(0).type).toBe('silence');
      expect(result.get(2).type).toBe('bridge');
    });

    it('marks filled gaps with _filled: true', () => {
      const brainSegments = [
        { position: 'between_tracks', afterTrackIndex: 0, type: 'bridge' },
      ];
      const result = fillMissingSegments(3, brainSegments);
      expect(result.get(0)._filled).toBeUndefined(); // Brain decision
      expect(result.get(1)._filled).toBe(true); // Filled
    });

    it('returns empty Map for single track', () => {
      const result = fillMissingSegments(1, []);
      expect(result.size).toBe(0);
    });

    it('returns empty Map for zero tracks', () => {
      const result = fillMissingSegments(0, []);
      expect(result.size).toBe(0);
    });

    it('handles null brainSegments', () => {
      const result = fillMissingSegments(3, null);
      expect(result.size).toBe(2);
    });

    it('ignores non-between_tracks segments', () => {
      const brainSegments = [
        { position: 'before_track', beforeTrackIndex: 0, type: 'cold_open', text: '开场' },
        { position: 'after_track', afterTrackIndex: 1, type: 'back_announce', text: '回顾' },
      ];
      const result = fillMissingSegments(3, brainSegments);
      expect(result.size).toBe(2);
      expect(result.get(0)._filled).toBe(true);
      expect(result.get(1)._filled).toBe(true);
    });

    it('filled gaps default to silence during night hours', () => {
      const originalDate = global.Date;
      const mockHour = 23; // 11pm
      global.Date = class extends originalDate {
        constructor(...args) {
          if (args.length === 0) {
            super(2026, 5, 14, mockHour, 0, 0);
          } else {
            super(...args);
          }
        }
        static now() { return new originalDate(2026, 5, 14, mockHour, 0, 0).getTime(); }
      };
      try {
        const result = fillMissingSegments(3, []);
        expect(result.get(0).type).toBe('silence');
      } finally {
        global.Date = originalDate;
      }
    });
  });

  // ═══ buildBackAnnounceSegment (Phase 2) ═══

  describe('buildBackAnnounceSegment()', () => {

    it('creates a valid back_announce segment', () => {
      const seg = buildBackAnnounceSegment(
        { name: '晴天', artist: '周杰伦' }, 2, 'test'
      );
      expect(seg.type).toBe('back_announce');
      expect(seg.position).toBe('after_track');
      expect(seg.afterTrackIndex).toBe(2);
      expect(seg.beforeTrackIndex).toBeNull();
      expect(seg.ttsStatus).toBe('pending');
      expect(seg.text).toBeTruthy();
      expect(seg.id).toContain('back_announce');
    });

    it('includes prevSong in metadata', () => {
      const seg = buildBackAnnounceSegment(
        { name: '红豆', artist: '王菲' }, 1
      );
      expect(seg.metadata.prevSong).toEqual({ name: '红豆', artist: '王菲' });
    });
  });

  // ═══ buildSilenceSegment (Phase 2) ═══

  describe('buildSilenceSegment()', () => {

    it('creates a valid silence segment', () => {
      const seg = buildSilenceSegment(3, 'night_mode', 'test');
      expect(seg.type).toBe('silence');
      expect(seg.position).toBe('between_tracks');
      expect(seg.afterTrackIndex).toBe(3);
      expect(seg.beforeTrackIndex).toBeNull();
      expect(seg.text).toBe('');
      expect(seg.ttsStatus).toBe('silent');
      expect(seg.transitionStyle).toBe('none');
      expect(seg.metadata.silenceReason).toBe('night_mode');
    });

    it('accepts optional nextIndex for beforeTrackIndex', () => {
      const seg = buildSilenceSegment(2, 'same_artist', 'test', 3);
      expect(seg.afterTrackIndex).toBe(2);
      expect(seg.beforeTrackIndex).toBe(3);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// normalizeBridgeOutput() — Normalization Pipeline Tests
// ══════════════════════════════════════════════════════════════

describe('normalizeBridgeOutput()', () => {
  beforeEach(() => resetBridgeHistory());
  const fallback = { text: '模板fallback文本', source: 'template' };

  it('cleans leading/trailing quotes', () => {
    const result = normalizeBridgeOutput('"这首歌的旋律真动人"', fallback);
    expect(result.text).toBe('这首歌的旋律真动人');
    expect(result.source).toBe('llm');
  });

  it('cleans Chinese quotes', () => {
    const result = normalizeBridgeOutput('「从爵士到民谣的过渡」', fallback);
    expect(result.text).toBe('从爵士到民谣的过渡');
  });

  it('strips numbering prefix', () => {
    const result = normalizeBridgeOutput('1. 这首歌的贝斯线很特别', fallback);
    expect(result.text).toBe('这首歌的贝斯线很特别');
  });

  it('strips markdown code blocks', () => {
    const result = normalizeBridgeOutput('```一首歌的过渡```', fallback);
    expect(result.text).toBe(fallback.text);
    expect(result.source).toBe('template');
  });

  it('accepts any non-empty output', () => {
    const result = normalizeBridgeOutput('短', fallback);
    expect(result.source).toBe('llm');
    expect(result.text).toBe('短');
  });

  it('accepts long output without truncation', () => {
    const longText = '这是一段很长的文字描述歌曲的过渡和连接。' + '后面还有很多内容。'.repeat(50);
    const result = normalizeBridgeOutput(longText, fallback);
    expect(result.source).toBe('llm');
    expect(result.text).toBe(longText.trim());
  });

  it('handles null input', () => {
    const result = normalizeBridgeOutput(null, fallback);
    expect(result.source).toBe('template');
  });

  it('handles empty string input', () => {
    const result = normalizeBridgeOutput('', fallback);
    expect(result.source).toBe('template');
  });
});

// ══════════════════════════════════════════════════════════════
// checkBridgeDedup() — Bridge Text Deduplication Tests
// ══════════════════════════════════════════════════════════════

describe('checkBridgeDedup()', () => {
  beforeEach(() => resetBridgeHistory());

  it('allows text with empty history', () => {
    const result = checkBridgeDedup('新的过渡文字');
    expect(result.allowed).toBe(true);
  });

  it('blocks exact duplicates', () => {
    recordBridgeText('从安静到温柔的过渡');
    const result = checkBridgeDedup('从安静到温柔的过渡');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('exact_duplicate');
  });

  it('blocks very similar texts', () => {
    recordBridgeText('周杰伦的歌总是让人想起青春');
    const result = checkBridgeDedup('周杰伦的歌总让人回忆起青春');
    expect(result.allowed).toBe(false);
  });

  it('allows sufficiently different texts', () => {
    recordBridgeText('从摇滚到民谣的风格转变');
    const result = checkBridgeDedup('深夜的爵士乐像一杯红酒');
    expect(result.allowed).toBe(true);
  });

  it('handles null text', () => {
    recordBridgeText('some history');
    const result = checkBridgeDedup(null);
    expect(result.allowed).toBe(true);
  });
});

describe('charOverlap()', () => {
  it('returns high overlap for identical strings (unique chars / length)', () => {
    // "hello" has 4 unique chars {h,e,l,o}, overlap = 4/5 = 0.8
    expect(charOverlap('hello', 'hello')).toBeCloseTo(0.8);
  });

  it('returns 0 for completely different strings', () => {
    expect(charOverlap('abc', 'xyz')).toBe(0);
  });

  it('handles different lengths', () => {
    const overlap = charOverlap('ab', 'abcd');
    expect(overlap).toBe(1); // Both chars of shorter found in longer
  });

  it('handles empty strings', () => {
    expect(charOverlap('', 'test')).toBe(0);
    expect(charOverlap('test', '')).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// personaLoader — Basic Structure Tests
// ══════════════════════════════════════════════════════════════

describe('personaLoader bridge persona', () => {
  const BRIDGE_PERSONA_ZH = [
    '你是 FlowState，一个私人音乐电台 DJ。',
    '风格：温暖、自然、有见地，像朋友在耳边轻声聊天。',
    '绝不用播音腔、套话开头、空泛赞美、鸡汤语、emoji。',
    '细节胜过空话——提到具体的旋律、歌词、编曲巧思。',
    '沉默也是表达——不是每个间隙都需要填满。',
  ].join('\n');

  it('contains key persona traits', () => {
    expect(BRIDGE_PERSONA_ZH).toContain('FlowState');
    expect(BRIDGE_PERSONA_ZH).toContain('温暖');
    expect(BRIDGE_PERSONA_ZH).toContain('自然');
  });

  it('includes forbidden patterns', () => {
    expect(BRIDGE_PERSONA_ZH).toContain('播音腔');
    expect(BRIDGE_PERSONA_ZH).toContain('emoji');
    expect(BRIDGE_PERSONA_ZH).toContain('空泛');
  });

  it('mentions silence as expression', () => {
    expect(BRIDGE_PERSONA_ZH).toContain('沉默');
  });
});

describe('COLD_OPEN_PARTS', () => {
  const COLD_OPEN_PARTS = ['anchor', 'heart', 'turn', 'image', 'invitation'];

  it('has exactly 5 parts', () => {
    expect(COLD_OPEN_PARTS).toHaveLength(5);
  });

  it('includes all narrative arc elements', () => {
    expect(COLD_OPEN_PARTS).toContain('anchor');
    expect(COLD_OPEN_PARTS).toContain('heart');
    expect(COLD_OPEN_PARTS).toContain('turn');
    expect(COLD_OPEN_PARTS).toContain('image');
    expect(COLD_OPEN_PARTS).toContain('invitation');
  });

  it('starts with anchor (scene setting)', () => {
    expect(COLD_OPEN_PARTS[0]).toBe('anchor');
  });

  it('ends with invitation (call to connection)', () => {
    expect(COLD_OPEN_PARTS[COLD_OPEN_PARTS.length - 1]).toBe('invitation');
  });
});
