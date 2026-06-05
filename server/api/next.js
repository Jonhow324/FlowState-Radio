// api/next.js — GET /api/next
// Prefetch next track in queue

const express = require('express');
const router = express.Router();
const state = require('../state');

router.get('/', (req, res) => {
  const queue = state.getQueue();

  if (queue.length === 0) {
    return res.json({ next: null, queue: [] });
  }

  const next = queue[0];
  const meta = state.getTrackMeta(next.track_id);

  res.json({
    next: {
      position: next.position,
      trackId: next.track_id,
      trackName: meta?.track_name || next.track_name,
      artist: meta?.artist || next.artist,
      albumArt: meta?.album_art || null,
      duration: meta?.duration || null,
      aiReason: next.ai_reason,
    },
    queue: queue.slice(1).map((item) => ({
      position: item.position,
      trackId: item.track_id,
      trackName: item.track_name,
      artist: item.artist,
    })),
  });
});

module.exports = router;
