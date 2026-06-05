// api/plan.js — GET /api/plan/today
// Get today's playlist plan

const express = require('express');
const router = express.Router();
const state = require('../state');

router.get('/today', (req, res) => {
  const plan = state.getTodayPlan();

  if (!plan) {
    return res.json({
      plan: null,
      message: 'No plan for today yet. The AI will generate one at 07:00 or you can request one.',
    });
  }

  res.json({ plan });
});

module.exports = router;
