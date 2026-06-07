import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// nock intercepts HTTP at the Node.js http/https module level and is
// fully compatible with axios (including follow-redirects).
const nock = require('nock');

// ── Load real modules (no vi.mock needed — nock handles HTTP) ────
const cache = require('../utils/cache');
const config = require('../config');
const ncm = require('../services/ncm');

// The NCM service talks to whatever URL config.ncmApiUrl points to.
// We MUST use the same base URL for nock or the interceptor won't match.
const NCM_API_BASE = config.ncmApiUrl;

// ── Lifecycle ─────────────────────────────────────────────────────

beforeEach(() => {
  ncm.recordSuccess(); // reset health state
  nock.cleanAll();     // clear pending interceptors
});

afterEach(() => {
  nock.cleanAll();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────
// 1. Health check logic
// ─────────────────────────────────────────────────────────────────
describe('isHealthy', () => {
  it('should start healthy', () => {
    expect(ncm.isHealthy()).toBe(true);
  });

  it('should remain healthy with fewer than 5 consecutive failures', () => {
    ncm.recordFail();
    ncm.recordFail();
    ncm.recordFail();
    ncm.recordFail();
    // 4 failures -- still below threshold of 5
    expect(ncm.isHealthy()).toBe(true);
  });

  it('should become unhealthy after 5 consecutive failures', () => {
    for (let i = 0; i < 5; i++) {
      ncm.recordFail();
    }
    expect(ncm.isHealthy()).toBe(false);
  });

  it('should remain unhealthy for failures beyond the threshold', () => {
    for (let i = 0; i < 8; i++) {
      ncm.recordFail();
    }
    expect(ncm.isHealthy()).toBe(false);
  });

  it('should recover after the cooldown window elapses', () => {
    for (let i = 0; i < 5; i++) {
      ncm.recordFail();
    }
    expect(ncm.isHealthy()).toBe(false);

    // Advance Date.now() past the 30 000 ms recovery window
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 30001);

    expect(ncm.isHealthy()).toBe(true);
  });

  it('should NOT recover before the cooldown window elapses', () => {
    for (let i = 0; i < 5; i++) {
      ncm.recordFail();
    }

    const now = Date.now();
    // Only 29 seconds -- still within the 30 s window
    vi.spyOn(Date, 'now').mockReturnValue(now + 29999);

    expect(ncm.isHealthy()).toBe(false);
  });

  it('should reset failure counter after recovery so new failures start fresh', () => {
    // Drive it unhealthy
    for (let i = 0; i < 5; i++) {
      ncm.recordFail();
    }
    expect(ncm.isHealthy()).toBe(false);

    // Fast-forward past cooldown
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 30001);
    expect(ncm.isHealthy()).toBe(true); // triggers reset

    // One new failure should NOT make it unhealthy (counter was reset)
    ncm.recordFail();
    expect(ncm.isHealthy()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. recordFail / recordSuccess counters
// ─────────────────────────────────────────────────────────────────
describe('recordFail / recordSuccess', () => {
  it('recordSuccess resets the consecutive failure counter', () => {
    ncm.recordFail();
    ncm.recordFail();
    ncm.recordFail();
    ncm.recordSuccess();

    // After reset, 4 more failures should keep it healthy (total < 5)
    ncm.recordFail();
    ncm.recordFail();
    ncm.recordFail();
    ncm.recordFail();
    expect(ncm.isHealthy()).toBe(true);
  });

  it('recordSuccess after reaching threshold allows recovery without cooldown', () => {
    for (let i = 0; i < 5; i++) {
      ncm.recordFail();
    }
    expect(ncm.isHealthy()).toBe(false);

    ncm.recordSuccess();
    expect(ncm.isHealthy()).toBe(true);
  });

  it('alternating fail/success never reaches threshold', () => {
    for (let i = 0; i < 20; i++) {
      ncm.recordFail();
      ncm.recordSuccess(); // resets every time
    }
    expect(ncm.isHealthy()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. search() -- result mapping (nock intercepts HTTP)
// ─────────────────────────────────────────────────────────────────
describe('search', () => {
  it('returns properly mapped results from the NCM API response', async () => {
    nock(NCM_API_BASE)
      .get('/search')
      .query({ keywords: 'rock classics', limit: '2' })
      .reply(200, {
        result: {
          songs: [
            {
              id: 12345,
              name: 'Bohemian Rhapsody',
              artists: [{ name: 'Queen' }],
              album: {
                name: 'A Night at the Opera',
                artist: { img1v1Url: 'https://img.example.com/queen.jpg' },
              },
              duration: 354960,
            },
            {
              id: 67890,
              name: 'Stairway to Heaven',
              artists: [{ name: 'Led Zeppelin' }],
              album: {
                name: 'Led Zeppelin IV',
                artist: { img1v1Url: 'https://img.example.com/zep.jpg' },
              },
              duration: 482133,
            },
          ],
        },
      });

    const results = await ncm.search('rock classics', 2);

    expect(results).toEqual([
      {
        trackId: '12345',
        trackName: 'Bohemian Rhapsody',
        artist: 'Queen',
        album: 'A Night at the Opera',
        albumArt: 'https://img.example.com/queen.jpg',
        duration: 354, // 354960 ms -> 354 s
      },
      {
        trackId: '67890',
        trackName: 'Stairway to Heaven',
        artist: 'Led Zeppelin',
        album: 'Led Zeppelin IV',
        albumArt: 'https://img.example.com/zep.jpg',
        duration: 482, // 482133 ms -> 482 s
      },
    ]);
  });

  it('joins multiple artists with " / "', async () => {
    nock(NCM_API_BASE)
      .get('/search')
      .query(true)
      .reply(200, {
        result: {
          songs: [
            {
              id: 111,
              name: 'Collab Song',
              artists: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Charlie' }],
              album: { name: 'Collaborations', artist: { img1v1Url: null } },
              duration: 200000,
            },
          ],
        },
      });

    const results = await ncm.search('collab');
    expect(results[0].artist).toBe('Alice / Bob / Charlie');
  });

  it('returns an empty array when API returns no songs', async () => {
    nock(NCM_API_BASE)
      .get('/search')
      .query(true)
      .reply(200, { result: { songs: [] } });

    const results = await ncm.search('nonexistent song');
    expect(results).toEqual([]);
  });

  it('handles missing result.songs gracefully', async () => {
    nock(NCM_API_BASE)
      .get('/search')
      .query(true)
      .reply(200, {});

    const results = await ncm.search('whatever');
    expect(results).toEqual([]);
  });

  it('maps duration to whole seconds (floored)', async () => {
    nock(NCM_API_BASE)
      .get('/search')
      .query(true)
      .reply(200, {
        result: {
          songs: [
            {
              id: 999,
              name: 'Short Track',
              artists: [{ name: 'Test' }],
              album: { name: 'Test Album', artist: {} },
              duration: 1500, // 1.5 s -> floor -> 1
            },
          ],
        },
      });

    const results = await ncm.search('short');
    expect(results[0].duration).toBe(1);
  });

  it('defaults artist to "Unknown" when artists array is missing', async () => {
    nock(NCM_API_BASE)
      .get('/search')
      .query(true)
      .reply(200, {
        result: {
          songs: [
            {
              id: 555,
              name: 'Mystery Track',
              album: { name: '', artist: {} },
              duration: 10000,
            },
          ],
        },
      });

    const results = await ncm.search('mystery');
    expect(results[0].artist).toBe('Unknown');
  });

  it('uses default limit of 10 when not specified', async () => {
    nock(NCM_API_BASE)
      .get('/search')
      .query((q) => q.limit === '10' && q.keywords === 'test')
      .reply(200, { result: { songs: [] } });

    const results = await ncm.search('test');
    expect(results).toEqual([]);
    expect(nock.isDone()).toBe(true); // confirms the nock interceptor was matched
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. getSongUrl -- caching behaviour
// ─────────────────────────────────────────────────────────────────
describe('getSongUrl', () => {
  let cacheGetSpy;
  let cacheSetSpy;

  beforeEach(() => {
    // Spy on the real cache so we can control/observe it
    cacheGetSpy = vi.spyOn(cache, 'get');
    cacheSetSpy = vi.spyOn(cache, 'set');
    // Default: cache miss
    cacheGetSpy.mockReturnValue(undefined);
  });

  afterEach(() => {
    cacheGetSpy.mockRestore();
    cacheSetSpy.mockRestore();
    // Clean up any keys written during tests
    cache.delete('url:123:320000');
    cache.delete('url:456:320000');
    cache.delete('url:100:128000');
    cache.delete('url:200:320000');
  });

  it('returns the URL from the API on a cache miss', async () => {
    nock(NCM_API_BASE)
      .get('/song/url')
      .query({ id: '123', br: '320000' })
      .reply(200, {
        data: [{ url: 'https://music.example.com/song123.mp3' }],
      });

    const url = await ncm.getSongUrl('123', 320000);

    expect(url).toBe('https://music.example.com/song123.mp3');
    // Verify cache was checked with the correct key
    expect(cacheGetSpy).toHaveBeenCalledWith('url:123:320000');
    // Verify URL was stored in cache with 15-minute TTL
    expect(cacheSetSpy).toHaveBeenCalledWith(
      'url:123:320000',
      'https://music.example.com/song123.mp3',
      15 * 60 * 1000,
    );
  });

  it('uses cache on second call and does NOT call the API again', async () => {
    const cachedUrl = 'https://music.example.com/cached-song.mp3';

    // Only register ONE interceptor -- if a second HTTP call is made,
    // nock will throw (no matching interceptor), proving the cache worked.
    nock(NCM_API_BASE)
      .get('/song/url')
      .query({ id: '456', br: '320000' })
      .once()
      .reply(200, {
        data: [{ url: cachedUrl }],
      });

    // First call -- cache miss, API responds
    await ncm.getSongUrl('456', 320000);

    // Second call -- simulate cache hit
    cacheGetSpy.mockReturnValueOnce(cachedUrl);
    const url = await ncm.getSongUrl('456', 320000);

    expect(url).toBe(cachedUrl);
    // The nock interceptor was consumed exactly once
    expect(nock.isDone()).toBe(true);
    // cache.set called only once (from the first call)
    expect(cacheSetSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when the API provides no URL', async () => {
    nock(NCM_API_BASE)
      .get('/song/url')
      .query(true)
      .reply(200, {
        data: [{ url: null }],
      });

    const url = await ncm.getSongUrl('789', 320000);

    expect(url).toBeNull();
    // Should NOT cache a null URL
    expect(cacheSetSpy).not.toHaveBeenCalled();
  });

  it('returns null when API response data array is empty', async () => {
    nock(NCM_API_BASE)
      .get('/song/url')
      .query(true)
      .reply(200, { data: [] });

    const url = await ncm.getSongUrl('000', 128000);

    expect(url).toBeNull();
    expect(cacheSetSpy).not.toHaveBeenCalled();
  });

  it('uses the correct cache key format including bit rate', async () => {
    nock(NCM_API_BASE)
      .get('/song/url')
      .query(true)
      .reply(200, {
        data: [{ url: 'https://music.example.com/hq.mp3' }],
      });

    await ncm.getSongUrl('100', 128000);

    expect(cacheGetSpy).toHaveBeenCalledWith('url:100:128000');
    expect(cacheSetSpy).toHaveBeenCalledWith(
      'url:100:128000',
      'https://music.example.com/hq.mp3',
      15 * 60 * 1000,
    );
  });

  it('sends correct query params (id + br) to the API', async () => {
    nock(NCM_API_BASE)
      .get('/song/url')
      .query((q) => q.id === '200' && q.br === '320000')
      .reply(200, {
        data: [{ url: 'https://music.example.com/default.mp3' }],
      });

    await ncm.getSongUrl('200');

    expect(nock.isDone()).toBe(true); // confirms correct params were sent
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. getSongDetail -- batch details
// ─────────────────────────────────────────────────────────────────
describe('getSongDetail', () => {
  it('returns an empty array for empty input', async () => {
    const result = await ncm.getSongDetail([]);
    expect(result).toEqual([]);
  });

  it('returns an empty array for null/undefined input', async () => {
    expect(await ncm.getSongDetail(null)).toEqual([]);
    expect(await ncm.getSongDetail(undefined)).toEqual([]);
  });

  it('maps batch detail response correctly', async () => {
    nock(NCM_API_BASE)
      .get('/song/detail')
      .query((q) => q.ids === '1001,1002')
      .reply(200, {
        songs: [
          {
            id: 1001,
            name: 'Song A',
            ar: [{ name: 'Artist A' }, { name: 'Artist B' }],
            al: { name: 'Album A', picUrl: 'https://img.example.com/a.jpg' },
            dt: 240500,
          },
          {
            id: 1002,
            name: 'Song B',
            ar: [{ name: 'Solo Artist' }],
            al: { name: 'Album B', picUrl: 'https://img.example.com/b.jpg' },
            dt: 180000,
          },
        ],
      });

    const results = await ncm.getSongDetail(['1001', '1002']);

    expect(results).toEqual([
      {
        trackId: '1001',
        trackName: 'Song A',
        artist: 'Artist A / Artist B',
        album: 'Album A',
        albumArt: 'https://img.example.com/a.jpg',
        duration: 240,
      },
      {
        trackId: '1002',
        trackName: 'Song B',
        artist: 'Solo Artist',
        album: 'Album B',
        albumArt: 'https://img.example.com/b.jpg',
        duration: 180,
      },
    ]);
  });

  it('sends comma-separated IDs in the query string', async () => {
    nock(NCM_API_BASE)
      .get('/song/detail')
      .query((q) => q.ids === '1001,1002,1003')
      .reply(200, { songs: [] });

    await ncm.getSongDetail(['1001', '1002', '1003']);

    expect(nock.isDone()).toBe(true); // confirms correct ids param
  });

  it('joins multiple artists with " / " using the detail format (ar field)', async () => {
    nock(NCM_API_BASE)
      .get('/song/detail')
      .query(true)
      .reply(200, {
        songs: [
          {
            id: 2001,
            name: 'Trio Song',
            ar: [{ name: 'X' }, { name: 'Y' }, { name: 'Z' }],
            al: { name: 'Group Album', picUrl: null },
            dt: 300000,
          },
        ],
      });

    const results = await ncm.getSongDetail(['2001']);
    expect(results[0].artist).toBe('X / Y / Z');
  });
});
