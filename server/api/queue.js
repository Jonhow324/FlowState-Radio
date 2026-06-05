// api/queue.js — GET /api/queue
// Get current play queue with metadata

const express = require('express');
const router = express.Router();
const state = require('../state');

router.get('/', (req, res) => {
  const queue = state.getQueue();

  const enriched = queue.map((item) => {
    const meta = state.getTrackMeta(item.track_id);
    return {
      position: item.position,
      trackId: item.track_id,
      trackName: meta?.track_name || item.track_name,
      artist: meta?.artist || item.artist,
      albumArt: meta?.album_art || null,
      duration: meta?.duration || null,
      aiReason: item.ai_reason,
      description: meta?.description || null,
      segueText: meta?.segue_text || null,
    };
  });

  res.json({
    queue: enriched,
    total: enriched.length,
  });
});

module.exports = router;
