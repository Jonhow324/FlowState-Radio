// services/ncm.js — NeteaseCloudMusic API wrapper

const axios = require('axios');
const config = require('../config');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const NCM_BASE = config.ncmApiUrl;
const NCM_COOKIE = config.ncmCookie || '';

// Axios instance with NCM-specific config
const ncmClient = axios.create({
  baseURL: NCM_BASE,
  timeout: 15000,
  headers: NCM_COOKIE ? { 'Cookie': NCM_COOKIE } : {},
});

// Log NCM API errors
ncmClient.interceptors.response.use(
  (res) => res,
  (err) => {
    logger.error('NCM', `API error: ${err.message}`, {
      url: err.config?.url,
      status: err.response?.status,
    });
    return Promise.reject(err);
  }
);

/**
 * Search songs
 * @param {string} keyword - Search keyword
 * @param {number} limit - Max results (default 10)
 * @returns {Promise<Array>} - Array of {trackId, trackName, artist, album, albumArt, duration}
 */
async function search(keyword, limit = 10) {
  const res = await ncmClient.get('/search', {
    params: { keywords: keyword, limit },
  });

  const songs = res.data?.result?.songs || [];
  return songs.map((s) => ({
    trackId: String(s.id),
    trackName: s.name,
    artist: s.artists?.map((a) => a.name).join(' / ') || 'Unknown',
    album: s.album?.name || '',
    albumArt: s.album?.artist?.img1v1Url || null,
    duration: Math.floor((s.duration || 0) / 1000),
  }));
}

/**
 * Get song play URL
 * @param {string} trackId - NeteaseCloudMusic song ID
 * @param {number} br - Bit rate (default 320000 = 320kbps)
 * @returns {Promise<string|null>} - Audio URL or null
 */
async function getSongUrl(trackId, br = 320000) {
  // Check cache first (URLs are valid ~20 min)
  const cacheKey = `url:${trackId}:${br}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await ncmClient.get('/song/url', {
    params: { id: trackId, br },
  });

  const data = res.data?.data?.[0];
  const url = data?.url || null;

  if (url) {
    // Cache for 15 minutes
    cache.set(cacheKey, url, 15 * 60 * 1000);
  }

  return url;
}

/**
 * Get song lyrics
 * @param {string} trackId - Song ID
 * @returns {Promise<{lyric: string, tlyric: string|null}>}
 */
async function getLyric(trackId) {
  const cacheKey = `lyric:${trackId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await ncmClient.get('/lyric', {
    params: { id: trackId },
  });

  const result = {
    lyric: res.data?.lrc?.lyric || '',
    tlyric: res.data?.tlyric?.lyric || null,
  };

  // Cache lyrics for 1 hour
  cache.set(cacheKey, result, 60 * 60 * 1000);
  return result;
}

/**
 * Get song details (batch)
 * @param {string[]} trackIds - Array of song IDs
 * @returns {Promise<Array>} - Array of track details
 */
async function getSongDetail(trackIds) {
  if (!trackIds || trackIds.length === 0) return [];

  const idsStr = trackIds.join(',');
  const res = await ncmClient.get('/song/detail', {
    params: { ids: idsStr },
  });

  const songs = res.data?.songs || [];
  return songs.map((s) => ({
    trackId: String(s.id),
    trackName: s.name,
    artist: s.ar?.map((a) => a.name).join(' / ') || 'Unknown',
    album: s.al?.name || '',
    albumArt: s.al?.picUrl || null,
    duration: Math.floor((s.dt || 0) / 1000),
  }));
}

/**
 * Get playlist detail
 * @param {string} playlistId - Playlist ID
 * @returns {Promise<{name, tracks}>}
 */
async function getPlaylistDetail(playlistId) {
  const res = await ncmClient.get('/playlist/detail', {
    params: { id: playlistId },
  });

  const playlist = res.data?.playlist;
  if (!playlist) return null;

  return {
    name: playlist.name,
    trackCount: playlist.trackCount,
    tracks: (playlist.trackIds || []).map((t) => String(t.id)),
  };
}

/**
 * Get tracks from a playlist (with full details)
 * @param {string} playlistId - Playlist ID
 * @returns {Promise<Array>} - Array of track details
 */
async function getTracksFromPlaylist(playlistId) {
  const playlist = await getPlaylistDetail(playlistId);
  if (!playlist || !playlist.tracks.length) return [];

  // Fetch details in batches of 50
  const batches = [];
  for (let i = 0; i < playlist.tracks.length; i += 50) {
    batches.push(playlist.tracks.slice(i, i + 50));
  }

  const results = [];
  for (const batch of batches) {
    const details = await getSongDetail(batch);
    results.push(...details);
  }

  return results;
}

/**
 * Get recommended songs (requires login cookie)
 * @returns {Promise<Array>}
 */
async function getRecommend() {
  try {
    const res = await ncmClient.get('/recommend/songs');
    const songs = res.data?.data?.dailySongs || [];
    return songs.map((s) => ({
      trackId: String(s.id),
      trackName: s.name,
      artist: s.ar?.map((a) => a.name).join(' / ') || 'Unknown',
      album: s.al?.name || '',
      albumArt: s.al?.picUrl || null,
      duration: Math.floor((s.dt || 0) / 1000),
    }));
  } catch (err) {
    logger.warn('NCM', 'Recommend API failed (may need login cookie)', err.message);
    return [];
  }
}

module.exports = {
  search,
  getSongUrl,
  getLyric,
  getSongDetail,
  getPlaylistDetail,
  getTracksFromPlaylist,
  getRecommend,
};
