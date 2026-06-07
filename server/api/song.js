// api/song.js — Song-related endpoints
// GET /api/song/url?id=xxx — Get play URL for a song
// POST /api/song/add — Add song(s) to queue with metadata

const express = require('express');
const router = express.Router();
const ncm = require('../services/ncm');
const state = require('../state');
const logger = require('../utils/logger');

/**
 * GET /api/song/url?id=123456
 * Returns the audio play URL for a specific track
 */
router.get('/url', async (req, res) => {
  const trackId = req.query.id;
  if (!trackId) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    if (!ncm.isHealthy()) {
      return res.status(503).json({ error: '音乐服务暂时不可用', code: 'NCM_UNAVAILABLE' });
    }
    const url = await ncm.getSongUrl(trackId);
    if (!url) {
      return res.status(404).json({ error: 'Song URL not available (may be VIP-only or region-locked)' });
    }
    res.json({ trackId, url });
  } catch (error) {
    logger.error('SONG', `Failed to get URL for ${trackId}: ${error.message}`);
    res.status(502).json({ error: '获取播放链接失败', code: 'URL_FETCH_FAILED' });
  }
});

/**
 * POST /api/song/add
 * Body: { trackIds: ["id1", "id2"], playNow?: boolean }
 * Fetches metadata from NCM, adds to queue, optionally plays first track
 */
router.post('/add', async (req, res) => {
  const { trackIds, playNow = false } = req.body;

  if (!trackIds || !Array.isArray(trackIds) || trackIds.length === 0) {
    return res.status(400).json({ error: 'trackIds array is required' });
  }

  try {
    // Fetch song details from NCM
    const details = await ncm.getSongDetail(trackIds);
    if (details.length === 0) {
      return res.status(404).json({ error: 'No songs found for given IDs' });
    }

    // Store metadata and add to queue
    for (const track of details) {
      state.setTrackMeta(track.trackId, track);
    }

    state.addToQueue(
      details.map((t) => ({
        trackId: t.trackId,
        trackName: t.trackName,
        artist: t.artist,
      })),
      'manual',
      'User added from search'
    );

    logger.info('SONG', `Added ${details.length} track(s) to queue`);

    // Broadcast queue update
    const broadcast = req.app.get('broadcast');
    if (broadcast) {
      broadcast({ type: 'queue-update', data: { queue: state.getQueue() } });
    }

    // If playNow, start playing the first track
    let playUrl = null;
    if (playNow) {
      const first = state.shiftQueue();
      if (first) {
        playUrl = await ncm.getSongUrl(first.track_id);
        state.updateCurrentState({
          now_playing_track_id: first.track_id,
          now_playing_started: new Date().toISOString(),
          is_playing: true,
        });
        state.logPlay(first.track_id, first.track_name, first.artist, 'manual', 'User selected');

        if (broadcast) {
          const meta = state.getTrackMeta(first.track_id);
          broadcast({
            type: 'now-playing',
            data: {
              trackId: first.track_id,
              trackName: meta?.track_name || first.track_name,
              artist: meta?.artist || first.artist,
              albumArt: meta?.album_art || null,
              url: playUrl,
            },
          });
        }
      }
    }

    res.json({
      success: true,
      added: details.length,
      playNow: playNow ? {
        trackId: details[0].trackId,
        trackName: details[0].trackName,
        artist: details[0].artist,
        albumArt: details[0].albumArt,
        url: playUrl,
      } : null,
    });
  } catch (error) {
    logger.error('SONG', `Failed to add tracks: ${error.message}`);
    res.status(502).json({ error: '添加歌曲失败，音乐服务可能暂时不可用', code: 'ADD_FAILED' });
  }
});

module.exports = router;
