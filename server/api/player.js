// api/player.js — Player control endpoints
// POST /api/player/play    — Play (optionally with trackId, fetches NCM URL)
// POST /api/player/pause   — Pause
// POST /api/player/skip    — Skip to next (fetches NCM URL for next track)
// POST /api/player/volume  — Set volume

const express = require('express');
const router = express.Router();
const state = require('../state');
const ncm = require('../services/ncm');
const scheduler = require('../scheduler');
const filler = require('../services/filler');
const logger = require('../utils/logger');

/**
 * POST /api/player/play
 * Body: { trackId?: string }
 * If trackId given: fetch URL from NCM, start playing
 * If no trackId: resume current or play next from queue
 */
router.post('/play', async (req, res) => {
  const { trackId } = req.body;
  const broadcast = req.app.get('broadcast');

  try {
    if (trackId) {
      // Play specific track — fetch URL from NCM
      if (!ncm.isHealthy()) {
        return res.status(503).json({ error: '音乐服务暂时不可用', code: 'NCM_UNAVAILABLE' });
      }
      const [url, details] = await Promise.all([
        ncm.getSongUrl(trackId),
        ncm.getSongDetail([trackId]),
      ]);

      if (!url) {
        return res.status(404).json({ error: 'Song URL not available' });
      }

      // Store metadata
      if (details.length > 0) {
        state.setTrackMeta(trackId, details[0]);
      }

      state.updateCurrentState({
        now_playing_track_id: trackId,
        now_playing_started: new Date().toISOString(),
        is_playing: true,
      });
      state.logPlay(trackId, details[0]?.trackName, details[0]?.artist, 'manual', 'User selected');

      const meta = state.getTrackMeta(trackId);
      const nowPlayingData = {
        trackId,
        trackName: meta?.track_name || details[0]?.trackName || 'Unknown',
        artist: meta?.artist || details[0]?.artist || 'Unknown',
        albumArt: meta?.album_art || details[0]?.albumArt || null,
        url,
      };

      logger.info('PLAYER', `Playing: ${nowPlayingData.trackName} - ${nowPlayingData.artist}`);

      if (broadcast) {
        broadcast({ type: 'now-playing', data: nowPlayingData });
      }

      return res.json({ success: true, nowPlaying: nowPlayingData });
    }

    // No trackId — resume or play next from queue
    const current = state.getCurrentState();
    if (current.now_playing_track_id && !current.is_playing) {
      // Resume — need to get URL again (may have expired from cache)
      let url = null;
      try {
        url = await ncm.getSongUrl(current.now_playing_track_id);
      } catch (err) {
        logger.warn('PLAYER', `Resume: cannot get URL for ${current.now_playing_track_id}: ${err.message}`);
      }
      state.updateCurrentState({ is_playing: true });

      if (broadcast) {
        broadcast({ type: 'now-playing', data: { ...state.getCurrentState(), url } });
      }

      return res.json({ success: true, action: 'resumed', url });
    }

    // Play next from queue
    // Capture previous song info before shifting
    const prevForQueueNext = current.now_playing_track_id
      ? {
          name: state.getTrackMeta(current.now_playing_track_id)?.track_name || 'Unknown',
          artist: state.getTrackMeta(current.now_playing_track_id)?.artist || 'Unknown',
          trackId: current.now_playing_track_id,
        }
      : null;

    const next = state.shiftQueue();
    if (next) {
      let url;
      try {
        url = await ncm.getSongUrl(next.track_id);
      } catch (err) {
        logger.warn('PLAYER', `Queue-next: cannot get URL for ${next.track_id}: ${err.message}`);
        return res.status(502).json({ error: 'Failed to fetch play URL', trackId: next.track_id });
      }

      const meta = state.getTrackMeta(next.track_id);
      const nextSongInfo = {
        name: meta?.track_name || next.track_name,
        artist: meta?.artist || next.artist,
      };

      // ── Segment / Filler Transition Logic ────────────────────
      let transitionStyle = next.transitionStyle || meta?.transitionStyle || 'outro';
      let fillerData = null;

      // Check for pre-generated bridge segment first
      const queueSegs = state.getAllSegments();
      let queueBridgeSeg = null;
      if (queueSegs.length > 0) {
        queueBridgeSeg = queueSegs.find(s => s.type === 'bridge' && s.ttsStatus === 'ready');
      }

      if (queueBridgeSeg && queueBridgeSeg.ttsUrl) {
        state.removeSegment(`${queueBridgeSeg.position}:${queueBridgeSeg.anchorTrackIndex}`);
        fillerData = { text: queueBridgeSeg.text, ttsUrl: queueBridgeSeg.ttsUrl, type: 'bridge' };
        transitionStyle = queueBridgeSeg.transitionStyle || 'intro';
      } else if (filler.shouldInsertFiller(scheduler._consecutivePlays)) {
        try {
          fillerData = await scheduler.generateTransition(prevForQueueNext, nextSongInfo, { silent: true });
          if (fillerData?.ttsUrl) {
            transitionStyle = 'intro';
          }
        } catch (err) {
          logger.warn('PLAYER', `Filler generation failed: ${err.message}`);
        }
      } else {
        scheduler._consecutivePlays++;
      }

      state.updateCurrentState({
        now_playing_track_id: next.track_id,
        now_playing_started: new Date().toISOString(),
        is_playing: true,
      });
      state.logPlay(next.track_id, nextSongInfo.name, nextSongInfo.artist, 'queue', 'Auto next');

      const nowPlayingData = {
        trackId: next.track_id,
        trackName: nextSongInfo.name,
        artist: nextSongInfo.artist,
        albumArt: meta?.album_art || null,
        url,
        transitionStyle,
      };

      if (fillerData?.ttsUrl) {
        nowPlayingData.ttsUrl = fillerData.ttsUrl;
        nowPlayingData.fillerText = fillerData.text;
        nowPlayingData.fillerType = fillerData.type;
      }

      // ── Phase 2: Attach afterTrack segment if available ──
      const playAfterSegs = state.getAllSegments().filter(
        s => s.type === 'back_announce' && s.ttsStatus === 'ready'
      );
      if (playAfterSegs.length > 0) {
        nowPlayingData.afterTrack = playAfterSegs[0];
      }

      if (broadcast) {
        broadcast({ type: 'now-playing', data: nowPlayingData });
      }

      // ── Rolling Queue Check ──────────────────────────────────
      scheduler.checkAndPrefetch().catch(() => {});

      return res.json({ success: true, nowPlaying: nowPlayingData });
    }

    return res.json({ success: false, reason: 'Queue is empty' });
  } catch (error) {
    logger.error('PLAYER', `Play error: ${error.message}`);
    res.status(500).json({ error: 'Play failed', code: 'PLAY_ERROR' });
  }
});

/**
 * POST /api/player/pause
 */
router.post('/pause', (req, res) => {
  state.updateCurrentState({ is_playing: false });
  logger.info('PLAYER', 'Paused');

  const broadcast = req.app.get('broadcast');
  if (broadcast) {
    broadcast({ type: 'now-playing', data: state.getCurrentState() });
  }

  res.json({ success: true });
});

/**
 * POST /api/player/skip
 * Skip to next track in queue, fetch URL from NCM
 */
router.post('/skip', async (req, res) => {
  const broadcast = req.app.get('broadcast');

  try {
    // Capture previous song info before shifting
    const currentState = state.getCurrentState();
    const prevSong = currentState.now_playing_track_id
      ? {
          name: state.getTrackMeta(currentState.now_playing_track_id)?.track_name || 'Unknown',
          artist: state.getTrackMeta(currentState.now_playing_track_id)?.artist || 'Unknown',
          trackId: currentState.now_playing_track_id,
        }
      : null;

    const next = state.shiftQueue();

    if (next) {
      let url;
      try {
        url = await ncm.getSongUrl(next.track_id);
      } catch (err) {
        logger.warn('PLAYER', `Skip: cannot get URL for ${next.track_id}: ${err.message}`);
        // Put it back in the queue front
        state.prependToQueue(next);
        return res.status(502).json({ error: '音乐服务暂时不可用，跳过失败', code: 'NCM_UNAVAILABLE' });
      }

      const meta = state.getTrackMeta(next.track_id);
      const nextSongInfo = {
        name: meta?.track_name || next.track_name,
        artist: meta?.artist || next.artist,
      };

      // ── Segment / Filler Transition Logic ────────────────────
      let transitionStyle = next.transitionStyle || meta?.transitionStyle || 'outro';
      let fillerData = null;

      // Check for pre-generated bridge segment first
      const allSegs = state.getAllSegments();
      let bridgeSeg = null;
      if (allSegs.length > 0) {
        bridgeSeg = allSegs.find(s => s.type === 'bridge' && s.ttsStatus === 'ready');
      }

      if (bridgeSeg && bridgeSeg.ttsUrl) {
        // Use pre-generated bridge segment and mark as consumed
        state.removeSegment(`${bridgeSeg.position}:${bridgeSeg.anchorTrackIndex}`);
        fillerData = { text: bridgeSeg.text, ttsUrl: bridgeSeg.ttsUrl, type: 'bridge' };
        transitionStyle = bridgeSeg.transitionStyle || 'intro';
      } else if (filler.shouldInsertFiller(scheduler._consecutivePlays)) {
        // Fall back to ad-hoc filler generation
        try {
          fillerData = await scheduler.generateTransition(prevSong, nextSongInfo, { silent: true });
          if (fillerData?.ttsUrl) {
            transitionStyle = 'intro';
          }
        } catch (err) {
          logger.warn('PLAYER', `Filler generation failed: ${err.message}`);
        }
      } else {
        scheduler._consecutivePlays++;
      }

      state.updateCurrentState({
        now_playing_track_id: next.track_id,
        now_playing_started: new Date().toISOString(),
        is_playing: true,
      });
      state.logPlay(next.track_id, nextSongInfo.name, nextSongInfo.artist, 'skip', 'User skipped');

      const nowPlayingData = {
        trackId: next.track_id,
        trackName: nextSongInfo.name,
        artist: nextSongInfo.artist,
        albumArt: meta?.album_art || null,
        url,
        transitionStyle,
      };

      // Attach filler TTS info — use ttsUrl key so frontend intro/outro handler picks it up
      if (fillerData?.ttsUrl) {
        nowPlayingData.ttsUrl = fillerData.ttsUrl;
        nowPlayingData.fillerText = fillerData.text;
        nowPlayingData.fillerType = fillerData.type;
      }

      // ── Phase 2: Attach afterTrack segment if available ──
      const afterTrackSegs = state.getAllSegments().filter(
        s => s.type === 'back_announce' && s.ttsStatus === 'ready'
      );
      if (afterTrackSegs.length > 0) {
        nowPlayingData.afterTrack = afterTrackSegs[0];
      }

      logger.info('PLAYER', `Skipped to: ${nowPlayingData.trackName} [${transitionStyle}]`);

      if (broadcast) {
        broadcast({ type: 'now-playing', data: nowPlayingData });
      }

      // ── Rolling Queue Check ──────────────────────────────────
      scheduler.checkAndPrefetch().catch(() => {});

      return res.json({ success: true, nowPlaying: nowPlayingData });
    }

    // Queue empty
    state.updateCurrentState({ is_playing: false, now_playing_track_id: null });
    logger.info('PLAYER', 'Skipped — queue empty, stopped');

    if (broadcast) {
      broadcast({ type: 'now-playing', data: state.getCurrentState() });
    }

    return res.json({ success: true, nowPlaying: null });
  } catch (error) {
    logger.error('PLAYER', `Skip error: ${error.message}`);
    res.status(500).json({ error: 'Skip failed', code: 'SKIP_ERROR' });
  }
});

/**
 * POST /api/player/volume
 */
router.post('/volume', (req, res) => {
  const { volume } = req.body;
  if (typeof volume !== 'number' || volume < 0 || volume > 1) {
    return res.status(400).json({ error: 'Volume must be 0.0 ~ 1.0' });
  }
  state.updateCurrentState({ volume });
  logger.info('PLAYER', `Volume: ${volume}`);
  res.json({ success: true, volume });
});

module.exports = router;
