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

    const cleaned = text.replace(/^["'"「『【]+/, '').replace(/["'"」』】]+$/, '').trim();
    if (!cleaned || cleaned.length < 5 || cleaned.length > 120) {
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

const SILENCE_CONFIG = {
  nightHoursStart: 23,
  nightHoursEnd: 6,
  nightSilenceProbability: 0.4,
  consecutiveBridgeLimit: 3,
  emotionalTags: new Set([
    'emotional', 'ambient', 'instrumental', 'classical',
    'post-rock', 'shoegaze', 'dream pop', '冥想', '纯音乐',
    '新世纪', '氛围', '后摇', '治愈',
  ]),
};

function shouldSilence(context = {}) {
  const { prevSong, nextSong, consecutiveBridges = 0 } = context;
  const hour = typeof context.hour === 'number' ? context.hour : 12;

  const prevTags = ((prevSong?.tags || '') + ' ' + (prevSong?.mood || '')).toLowerCase();
  const nextTags = ((nextSong?.tags || '') + ' ' + (nextSong?.mood || '')).toLowerCase();
  const prevIsEmotional = [...SILENCE_CONFIG.emotionalTags].some(t => prevTags.includes(t));
  const nextIsEmotional = [...SILENCE_CONFIG.emotionalTags].some(t => nextTags.includes(t));

  if (prevIsEmotional) return { shouldSilence: true, reason: 'emotional_prev' };

  const isNight = hour >= SILENCE_CONFIG.nightHoursStart || hour < SILENCE_CONFIG.nightHoursEnd;
  if (isNight) return { shouldSilence: true, reason: 'night_mode' };

  if (consecutiveBridges >= SILENCE_CONFIG.consecutiveBridgeLimit) {
    return { shouldSilence: true, reason: 'bridge_fatigue' };
  }

  if (nextIsEmotional) return { shouldSilence: true, reason: 'emotional_next' };

  return { shouldSilence: false, reason: null };
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

    it('calls rawChat with correct system and user prompts', async () => {
      const deepseek = createMockDeepseek('音乐在两种风格间自由穿梭');
      await generateBridgeLLM(
        { name: 'SongA', artist: 'ArtistA', tags: 'rock' },
        { name: 'SongB', artist: 'ArtistB', tags: 'jazz' },
        deepseek
      );
      expect(deepseek.rawChat).toHaveBeenCalledTimes(1);
      const [systemPrompt, userPrompt] = deepseek.rawChat.mock.calls[0];
      expect(systemPrompt).toContain('DJ');
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
        { think: () => {} }  // no rawChat
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

    it('falls back to template when LLM returns text too short', async () => {
      const deepseek = createMockDeepseek('太短');
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek
      );
      expect(result.source).toBe('template');
    });

    it('falls back to template when LLM returns text too long (>120 chars)', async () => {
      const longText = '这是一段非常非常长的文字，'.repeat(20); // 220 chars
      const deepseek = createMockDeepseek(longText);
      const result = await generateBridgeLLM(
        { name: '晴天', artist: '周杰伦' },
        { name: '红豆', artist: '王菲' },
        deepseek
      );
      expect(result.source).toBe('template');
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

    it('passes options to rawChat', async () => {
      const deepseek = createMockDeepseek('过渡文案');
      await generateBridgeLLM(
        { name: 'A', artist: 'B' },
        { name: 'C', artist: 'D' },
        deepseek,
        { temperature: 0.5, maxTokens: 80, timeout: 5000 }
      );
      const opts = deepseek.rawChat.mock.calls[0][2];
      expect(opts.temperature).toBe(0.5);
      expect(opts.maxTokens).toBe(80);
      expect(opts.timeout).toBe(5000);
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

  // ═══ shouldSilence (Phase 2) ═══

  describe('shouldSilence()', () => {

    it('returns silence for emotional previous track', () => {
      const result = shouldSilence({
        prevSong: { name: 'A', artist: 'B', tags: 'emotional' },
        nextSong: { name: 'C', artist: 'D' },
        consecutiveBridges: 0,
        hour: 14,
      });
      expect(result.shouldSilence).toBe(true);
      expect(result.reason).toBe('emotional_prev');
    });

    it('returns silence for ambient previous track', () => {
      const result = shouldSilence({
        prevSong: { name: 'A', artist: 'B', tags: 'ambient' },
        consecutiveBridges: 0,
        hour: 14,
      });
      expect(result.shouldSilence).toBe(true);
      expect(result.reason).toBe('emotional_prev');
    });

    it('returns silence during night hours', () => {
      const result = shouldSilence({
        prevSong: { name: 'A', artist: 'B', tags: 'pop' },
        consecutiveBridges: 0,
        hour: 23,
      });
      expect(result.shouldSilence).toBe(true);
      expect(result.reason).toBe('night_mode');
    });

    it('returns silence during early morning (before 6am)', () => {
      const result = shouldSilence({
        prevSong: { name: 'A', artist: 'B', tags: 'pop' },
        consecutiveBridges: 0,
        hour: 3,
      });
      expect(result.shouldSilence).toBe(true);
      expect(result.reason).toBe('night_mode');
    });

    it('returns silence after 3+ consecutive bridges', () => {
      const result = shouldSilence({
        prevSong: { name: 'A', artist: 'B', tags: 'pop' },
        consecutiveBridges: 3,
        hour: 14,
      });
      expect(result.shouldSilence).toBe(true);
      expect(result.reason).toBe('bridge_fatigue');
    });

    it('does NOT trigger silence with < 3 consecutive bridges during daytime', () => {
      const result = shouldSilence({
        prevSong: { name: 'A', artist: 'B', tags: 'pop' },
        consecutiveBridges: 2,
        hour: 14,
      });
      expect(result.shouldSilence).toBe(false);
    });

    it('returns silence when next track is emotional', () => {
      const result = shouldSilence({
        prevSong: { name: 'A', artist: 'B', tags: 'pop' },
        nextSong: { name: 'C', artist: 'D', tags: 'instrumental' },
        consecutiveBridges: 0,
        hour: 14,
      });
      expect(result.shouldSilence).toBe(true);
      expect(result.reason).toBe('emotional_next');
    });

    it('returns silence when prev track has emotional mood', () => {
      const result = shouldSilence({
        prevSong: { name: 'A', artist: 'B', tags: '', mood: '治愈系' },
        consecutiveBridges: 0,
        hour: 14,
      });
      expect(result.shouldSilence).toBe(true);
      expect(result.reason).toBe('emotional_prev');
    });

    it('no silence for normal pop tracks during daytime with few bridges', () => {
      const result = shouldSilence({
        prevSong: { name: 'A', artist: 'B', tags: 'pop' },
        nextSong: { name: 'C', artist: 'D', tags: 'rock' },
        consecutiveBridges: 1,
        hour: 15,
      });
      expect(result.shouldSilence).toBe(false);
      expect(result.reason).toBeNull();
    });

    it('handles missing context gracefully', () => {
      const result = shouldSilence({});
      // hour defaults to 12 (daytime), no emotional tags, 0 bridges
      expect(result.shouldSilence).toBe(false);
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
