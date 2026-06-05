// api/chat.js — POST /api/chat
// User sends a message (text or command), AI responds with {say, play[], reason}

const express = require('express');
const router = express.Router();
const state = require('../state');
const logger = require('../utils/logger');

router.post('/', async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  logger.info('CHAT', `User message: ${message}`);

  // Log user message
  state.logMessage('user', message);

  try {
    // Phase 0: Mock response (AI brain not yet integrated)
    // Phase 2: Replace with router.route(message) → brain.think(context)
    const mockResponse = {
      say: `收到你的消息了："${message}"。Claudio 的 AI 大脑还在准备中，Phase 2 接入后就能智能回复了！`,
      play: [],
      reason: 'Mock response - Phase 0',
      segue: null,
    };

    // Log Claudio's response
    state.logMessage('claudio', mockResponse.say);

    res.json(mockResponse);
  } catch (error) {
    logger.error('CHAT', 'Error processing message', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
