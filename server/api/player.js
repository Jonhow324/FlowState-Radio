// api/player.js — Player control endpoints
// POST /api/player/play — Play (optionally with trackId)
// POST /api/player/pause — Pause
// POST /api/player/skip — Skip to next
// POST /api/player/volume — Set volume

const express = require('express');
const router = express.Router();
const state = require('../state');
const logger = require('../utils/logger');

// POST /play
router.post('/play', (req, res) => {
  const { trackId } = req.body;

  if (trackId) {
    // Play specific track
    state.updateCurrentState({
      now_playing_track_id: trackId,
      now_playing_started: new Date().toISOString(),
      is_playing: true,
    });
    logger.info('PLAYER', `Playing track: ${trackId}`);
  } else {
    // Resume or play next from queue
    const current = state.getCurrentState();
    if (current.now_playing_track_id && !current.is_playing) {
      // Resume
      state.updateCurrentState({ is_playing: true });
      logger.info('PLAYER', 'Resumed playback');
    } else {
      // Play next from queue
      const next = state.shiftQueue();
      if (next) {
        state.updateCurrentState({
          now_playing_track_id: next.track_id,
          now_playing_started: new Date().toISOString(),
          is_playing: true,
        });
        logger.info('PLAYER', `Playing next from queue: ${next.track_id}`);
      } else {
        logger.info('PLAYER', 'Queue is empty');
      }
    }
  }

  const broadcast = req.app.get('broadcast');
  if (broadcast) {
    broadcast({ type: 'now-playing', data: state.getCurrentState() });
  }

  res.json({ success: true, state: state.getCurrentState() });
});

// POST /pause
router.post('/pause', (req, res) => {
  state.updateCurrentState({ is_playing: false });
  logger.info('PLAYER', 'Paused playback');

  const broadcast = req.app.get('broadcast');
  if (broadcast) {
    broadcast({ type: 'now-playing', data: state.getCurrentState() });
  }

  res.json({ success: true, state: state.getCurrentState() });
});

// POST /skip
router.post('/skip', (req, res) => {
  const next = state.shiftQueue();

  if (next) {
    state.updateCurrentState({
      now_playing_track_id: next.track_id,
      now_playing_started: new Date().toISOString(),
      is_playing: true,
    });
    logger.info('PLAYER', `Skipped to: ${next.track_id}`);
  } else {
    state.updateCurrentState({ is_playing: false, now_playing_track_id: null });
    logger.info('PLAYER', 'Skipped — queue empty, stopped');
  }

  const broadcast = req.app.get('broadcast');
  if (broadcast) {
    broadcast({ type: 'now-playing', data: state.getCurrentState() });
  }

  res.json({ success: true, state: state.getCurrentState(), nextTrack: next });
});

// POST /volume
router.post('/volume', (req, res) => {
  const { volume } = req.body;

  if (typeof volume !== 'number' || volume < 0 || volume > 1) {
    return res.status(400).json({ error: 'Volume must be a number between 0.0 and 1.0' });
  }

  state.updateCurrentState({ volume });
  logger.info('PLAYER', `Volume set to: ${volume}`);

  res.json({ success: true, volume });
});

module.exports = router;
