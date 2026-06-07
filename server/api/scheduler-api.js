// api/scheduler.js — Scheduler control endpoints
// POST /api/scheduler/plan — trigger daily plan
// POST /api/scheduler/briefing — trigger morning briefing
// POST /api/scheduler/refill — trigger queue refill
// GET /api/scheduler/status — get scheduler status

const express = require('express');
const router = express.Router();
const scheduler = require('../scheduler');
const state = require('../state');
const logger = require('../utils/logger');

// Trigger daily plan
router.post('/plan', async (req, res) => {
  try {
    logger.info('API', 'Manual trigger: daily plan');
    const plan = await scheduler.triggerPlan();
    res.json({ success: true, plan });
  } catch (error) {
    logger.error('API', `Plan trigger failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Trigger morning briefing
router.post('/briefing', async (req, res) => {
  try {
    logger.info('API', 'Manual trigger: morning briefing');
    await scheduler.triggerBriefing();
    res.json({ success: true, message: 'Morning briefing sent' });
  } catch (error) {
    logger.error('API', `Briefing trigger failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Trigger queue refill
router.post('/refill', async (req, res) => {
  try {
    logger.info('API', 'Manual trigger: queue refill');
    await scheduler.triggerRefill();
    res.json({ success: true, queueLength: state.getQueueLength() });
  } catch (error) {
    logger.error('API', `Refill trigger failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get scheduler status
router.get('/status', (req, res) => {
  const queueLength = state.getQueueLength();
  const todayPlan = state.getTodayPlan();
  const currentState = state.getCurrentState();

  res.json({
    schedulerRunning: scheduler.tasks.length > 0,
    taskCount: scheduler.tasks.length,
    queueLength,
    hasTodayPlan: !!todayPlan,
    todayPlanSummary: todayPlan?.summary || null,
    isPlaying: currentState?.is_playing || false,
    ttsAvailable: require('../tts').isAvailable(),
  });
});

module.exports = router;
