// api/dj.js — DJ switching endpoint
// POST /api/dj/switch — Switch DJ persona {dj: 'zh' | 'en'}
// GET /api/dj — Get current DJ info

const express = require('express');
const router = express.Router();
const state = require('../state');
const tts = require('../tts');
const logger = require('../utils/logger');

const DJ_PROFILES = {
  zh: {
    id: 'zh',
    name: 'FlowState',
    language: 'zh',
    description: '中文电台 · 温暖亲切',
    welcomeMessage: '嘿！我是 FlowState，你的专属中文电台 DJ。切换成功，接下来让我为你选歌吧。',
  },
  en: {
    id: 'en',
    name: 'DJ FlowState',
    language: 'en',
    description: 'English Radio · Cool & Smooth',
    welcomeMessage: "Hey there! DJ FlowState here, your smooth English radio host. Switch complete — let's get the music going.",
  },
};

// GET current DJ
router.get('/', (req, res) => {
  const currentState = state.getCurrentState();
  const activeDj = currentState?.active_dj || 'zh';
  res.json({
    activeDj,
    profile: DJ_PROFILES[activeDj],
    availableDjs: Object.values(DJ_PROFILES).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
    })),
  });
});

// POST switch DJ
router.post('/switch', async (req, res) => {
  const { dj } = req.body;

  if (!dj || !['zh', 'en'].includes(dj)) {
    return res.status(400).json({ error: 'DJ must be "zh" or "en"' });
  }

  const currentState = state.getCurrentState();
  if (currentState?.active_dj === dj) {
    return res.json({
      success: true,
      activeDj: dj,
      profile: DJ_PROFILES[dj],
      message: 'Already active',
    });
  }

  state.updateCurrentState({ active_dj: dj });
  logger.info('DJ', `Switched to ${DJ_PROFILES[dj].name} (${dj})`);

  const profile = DJ_PROFILES[dj];

  // Synthesize welcome message with TTS
  let ttsUrl = null;
  try {
    const ttsResult = await tts.synthesize(profile.welcomeMessage, profile.language);
    ttsUrl = ttsResult.url;
  } catch (err) {
    logger.warn('DJ', `TTS synthesis failed: ${err.message}`);
  }

  // Broadcast DJ switch event
  const broadcast = req.app.get('broadcast');
  if (broadcast) {
    broadcast({
      type: 'dj-switch',
      data: {
        activeDj: dj,
        profile,
        ttsUrl,
      },
    });
    if (ttsUrl) {
      broadcast({ type: 'dj-talk', data: { text: profile.welcomeMessage, ttsUrl } });
    }
  }

  // Log the switch
  state.logMessage('system', `DJ switched to ${profile.name}`);

  res.json({
    success: true,
    activeDj: dj,
    profile,
    welcomeMessage: profile.welcomeMessage,
    ttsUrl,
  });
});

module.exports = router;
