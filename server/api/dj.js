// api/dj.js — DJ switching endpoint
// POST /api/dj/switch — Switch DJ persona {dj: 'zh' | 'en'}

const express = require('express');
const router = express.Router();
const state = require('../state');
const logger = require('../utils/logger');

router.post('/switch', (req, res) => {
  const { dj } = req.body;

  if (!dj || !['zh', 'en'].includes(dj)) {
    return res.status(400).json({ error: 'DJ must be "zh" or "en"' });
  }

  state.updateCurrentState({ active_dj: dj });
  logger.info('DJ', `Switched to ${dj === 'zh' ? 'Chinese' : 'English'} DJ`);

  const welcomeMessages = {
    zh: '嘿！我是 Claudio，你的中文电台 DJ，接下来让我为你选歌吧。',
    en: "Hey there! DJ Claudio here, your smooth English radio host. Let's get the music going.",
  };

  res.json({
    success: true,
    activeDj: dj,
    welcomeMessage: welcomeMessages[dj],
  });
});

module.exports = router;
