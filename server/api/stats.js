// api/stats.js — GET /api/stats
// Play statistics: today/week/total counts, top artists, top tracks

const express = require('express');
const router = express.Router();
const state = require('../state');

router.get('/', (req, res) => {
  try {
    const stats = state.getPlayStats();
    const recentPlays = state.getRecentPlays(20);

    res.json({
      ...stats,
      recentPlays: recentPlays.map((p) => ({
        trackId: p.track_id,
        trackName: p.track_name || 'Unknown',
        artist: p.artist || 'Unknown',
        playedAt: p.played_at,
        source: p.source || 'unknown',
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
