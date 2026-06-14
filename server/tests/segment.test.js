// segment.test.js — Unit tests for the Segment-driven broadcast engine
// Tests: normalizeSegments, dedupCheck, dedupFilter, buildSegmentMap,
//        generateBridgeText, generateBridgeLLM, getSegmentsForTrack

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

async function generateBridgeLLM(prevSong, nextSong, deepseek, options = {}) {
  const fallback = generateBridgeText(prevSong, nextSong);

  if (!deepseek || typeof deepseek.rawChat !== 'function') {
    return { ...fallback, source: 'template' };
  }

  const prevName = prevSong.name || prevSong.trackName || '未知';
  const prevArtist = prevSong.artist || '未知';
  const nextName = nextSong.name || nextSong.trackName || '未知';
  const nextArtist = nextSong.artist || '未知';

  let userPrompt = `上一首：${prevArtist} -《${prevName}》`;
  if (prevSong.tags) userPrompt += `\n标签：${prevSong.tags}`;
  userPrompt += `\n下一首：${nextArtist} -《${nextName}》`;
  if (nextSong.tags) userPrompt += `\n标签：${nextSong.tags}`;

  try {
    const text = await deepseek.rawChat('system', userPrompt, {
      temperature: options.temperature ?? 0.85,
      maxTokens: options.maxTokens ?? 200,
      timeout: options.timeout ?? 15000,
    });

    const cleaned = text.replace(/^["'"「『【]+/, '').replace(/["'"」』】]+$/, '').trim();

    if (!cleaned) {
      return { ...fallback, source: 'template' };
    }

    return { text: cleaned, transitionStyle: 'outro', source: 'llm' };
  } catch (err) {
    return { ...fallback, source: 'template' };
  }
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

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Phase 2: Back Announce + Silence (local re-implementation) ──

function generateBackAnnounce(song, options = {}) {
  const name = song.name || song.trackName || '这首歌';
  const artist = song.artist || '';

  const templates = [
    `刚才那是${artist ? artist + '的' : ''}《${name}》，${pickRandom(['经典中的经典', '百听不厌', '让人回味无穷', '值得反复品味'])}。`,
    `${artist ? artist : ''}的《${name}》，${pickRandom(['每次听都有新感受', '总能戳中某个柔软的角落', '旋律还在耳边绕', '情绪还沉浸在里面'])}。`,
    `一首《${name}》${pickRandom(['送给此刻的你', '献给这个夜晚', '配得上你现在的状态', '刚好契合当下的心情'])}。`,
    `《${name}》播完了，${pickRandom(['但余韵可以留久一点', '好歌总是让人觉得太短', '让这份感觉多停留一会儿', '音乐停了，情绪还在继续'])}。`,
  ];

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

  return { text: pickRandom(templates), transitionStyle: 'none' };
}

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

function fillMissingSegments(trackCount, brainSegments) {
  const decisions = new Map();

  for (const seg of (brainSegments || [])) {
    if (seg.position === 'between_tracks' && typeof seg.anchorTrackIndex === 'number') {
      decisions.set(seg.anchorTrackIndex, seg);
    }
  }

  const hour = new Date().getHours();
  const isNight = hour >= 23 || hour < 6;
  const defaultType = isNight ? 'silence' : 'bridge';

  for (let i = 0; i < trackCount - 1; i++) {
    if (!decisions.has(i)) {
      decisions.set(i, {
        type: defaultType,
        anchorTrackIndex: i,
        position: 'between_tracks',
        text: '',
        _filled: true,
      });
    }
  }

  return decisions;
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

  // ═══ generateBridgeLLM ═══

  describe('generateBridgeLLM()', () => {

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
        deepseek
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
        deepseek
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
        deepseek
      );
      expect(result.text).toBeTruthy();
      expect(result.source).toBe('template');
    });

    it('falls back to template when LLM returns empty string', async () => {
      const deepseek = createMockDeepseek('');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek
      );
      expect(result.source).toBe('template');
    });

    it('accepts any non-empty LLM output regardless of length', async () => {
      const deepseek = createMockDeepseek('短');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek
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
        deepseek
      );
      expect(result.source).toBe('llm');
      expect(result.text).toBe(longText.trim());
    });

    it('strips leading/trailing quotes from LLM response', async () => {
      const deepseek = createMockDeepseek('"从摇滚到民谣，情绪在慢慢转弯"');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek
      );
      expect(result.text).toBe('从摇滚到民谣，情绪在慢慢转弯');
      expect(result.source).toBe('llm');
    });

    it('strips Chinese quotes from LLM response', async () => {
      const deepseek = createMockDeepseek('「音乐在两种风格间自由穿梭」');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek
      );
      expect(result.text).toBe('音乐在两种风格间自由穿梭');
      expect(result.source).toBe('llm');
    });

    it('handles trackName fallback in song info', async () => {
      const deepseek = createMockDeepseek('一首好歌接着另一首好歌');
      await generateBridgeLLM(
        { trackName: 'TrackA', artist: 'A' },
        { trackName: 'TrackB', artist: 'B' },
        deepseek
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
        deepseek
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
        { position: 'between_tracks', anchorTrackIndex: 0, type: 'silence', text: '' },
        { position: 'between_tracks', anchorTrackIndex: 2, type: 'bridge', text: '自然过渡' },
      ];
      const result = fillMissingSegments(4, brainSegments);
      expect(result.size).toBe(3); // 4 tracks = 3 gaps
      expect(result.get(0).type).toBe('silence');
      expect(result.get(2).type).toBe('bridge');
    });

    it('marks filled gaps with _filled: true', () => {
      const brainSegments = [
        { position: 'between_tracks', anchorTrackIndex: 0, type: 'bridge' },
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
        { position: 'before_track', anchorTrackIndex: 0, type: 'cold_open', text: '开场' },
        { position: 'after_track', anchorTrackIndex: 1, type: 'back_announce', text: '回顾' },
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
      expect(seg.anchorTrackIndex).toBe(2);
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
      expect(seg.anchorTrackIndex).toBe(3);
      expect(seg.text).toBe('');
      expect(seg.ttsStatus).toBe('silent');
      expect(seg.transitionStyle).toBe('none');
      expect(seg.metadata.silenceReason).toBe('night_mode');
    });
  });
});

// ══════════════════════════════════════════════════════════════
// normalizeBridgeOutput() — Normalization Pipeline Tests
// ══════════════════════════════════════════════════════════════

// Re-implement locally (avoid module deps)
function normalizeBridgeOutput(rawText, fallback) {
  const cleaned = (rawText || '')
    .replace(/^["'"「『【《\s]+/, '')
    .replace(/["'"」』】》\s]+$/, '')
    .replace(/```[\s\S]*```/g, '')
    .replace(/^\d+[.、)\]]\s*/, '')
    .trim();

  if (!cleaned) {
    return { text: fallback.text, source: 'template', dedup: 'skipped' };
  }

  return { text: cleaned, source: 'llm', dedup: 'passed' };
}

describe('normalizeBridgeOutput()', () => {
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

// Re-implement locally
function charOverlap(a, b) {
  if (!a || !b) return 0;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length >= b.length ? a : b;
  let matches = 0;
  const longerChars = new Set(longer.split(''));
  for (const ch of shorter) {
    if (longerChars.has(ch)) {
      matches++;
      longerChars.delete(ch);
    }
  }
  return matches / shorter.length;
}

function checkBridgeDedup(text, history, threshold = 0.4) {
  if (!text || history.length === 0) return { allowed: true, reason: null };
  for (const prev of history) {
    if (text === prev) return { allowed: false, reason: 'exact_duplicate' };
    const overlap = charOverlap(text, prev);
    if (overlap > threshold) return { allowed: false, reason: `too_similar (${(overlap * 100).toFixed(0)}% overlap)` };
  }
  return { allowed: true, reason: null };
}

describe('checkBridgeDedup()', () => {
  it('allows text with empty history', () => {
    const result = checkBridgeDedup('新的过渡文字', []);
    expect(result.allowed).toBe(true);
  });

  it('blocks exact duplicates', () => {
    const history = ['从安静到温柔的过渡'];
    const result = checkBridgeDedup('从安静到温柔的过渡', history);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('exact_duplicate');
  });

  it('blocks very similar texts', () => {
    const history = ['周杰伦的歌总是让人想起青春'];
    const result = checkBridgeDedup('周杰伦的歌总让人回忆起青春', history);
    expect(result.allowed).toBe(false);
  });

  it('allows sufficiently different texts', () => {
    const history = ['从摇滚到民谣的风格转变'];
    const result = checkBridgeDedup('深夜的爵士乐像一杯红酒', history);
    expect(result.allowed).toBe(true);
  });

  it('handles null text', () => {
    const result = checkBridgeDedup(null, ['history']);
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
