// api/now.js — GET /api/now
// Get current playback state

const express = require('express');
const router = express.Router();
const state = require('../state');

router.get('/', (req, res) => {
  const currentState = state.getCurrentState();
  const queueLength = state.getQueueLength();

  let trackMeta = null;
  if (currentState.now_playing_track_id) {
    trackMeta = state.getTrackMeta(currentState.now_playing_track_id);
  }

  res.json({
    track: trackMeta || {
      trackId: currentState.now_playing_track_id,
      trackName: null,
      artist: null,
      album: null,
      albumArt: null,
    },
    progress: currentState.now_playing_started
      ? Math.floor((Date.now() - new Date(currentState.now_playing_started).getTime()) / 1000)
      : 0,
    mood: currentState.current_mood,
    isPlaying: Boolean(currentState.is_playing),
    volume: currentState.volume,
    activeDj: currentState.active_dj,
    queueLength,
  });
});

module.exports = router;
