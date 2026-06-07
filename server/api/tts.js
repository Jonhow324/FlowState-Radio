// api/tts.js — TTS voice management endpoints

const express = require('express');
const router = express.Router();
const state = require('../state');
const tts = require('../tts');

// Minimax voice presets mapping
const VOICE_MAP = {
  'default':          { zh: 'male-qn-qingse', en: 'male-qn-jingying' },
  'male-qn-qingse':   { zh: 'male-qn-qingse', en: 'male-qn-jingying' },
  'male-qn-jingying': { zh: 'male-qn-jingying', en: 'male-qn-jingying' },
  'male-qn-badao':    { zh: 'male-qn-badao', en: 'male-qn-jingying' },
  'female-shaonv':    { zh: 'female-shaonv', en: 'female-yujie' },
  'female-yujie':     { zh: 'female-yujie', en: 'female-yujie' },
  'female-tianmei':   { zh: 'female-tianmei', en: 'female-yujie' },
};

// GET /api/tts/voice — current voice setting
router.get('/voice', (req, res) => {
  const savedVoice = state.getPref('tts_voice');
  const voiceId = savedVoice || 'default';
  res.json({
    current: voiceId,
    zh: tts.getVoice('zh'),
    en: tts.getVoice('en'),
    available: tts.isAvailable(),
  });
});

// POST /api/tts/voice — change voice
// Body: { voiceId: 'male-qn-qingse' }
router.post('/voice', (req, res) => {
  const { voiceId } = req.body;
  if (!voiceId) {
    return res.status(400).json({ error: 'voiceId is required' });
  }

  const mapping = VOICE_MAP[voiceId];
  if (!mapping) {
    return res.status(400).json({ error: `Unknown voice: ${voiceId}`, available: Object.keys(VOICE_MAP) });
  }

  // Apply to TTS service (runtime)
  tts.setVoice(mapping.zh, 'zh');
  tts.setVoice(mapping.en, 'en');

  // Persist to database
  state.setPref('tts_voice', voiceId);

  res.json({
    success: true,
    current: voiceId,
    zh: mapping.zh,
    en: mapping.en,
  });
});

// POST /api/tts/preview — synthesize a short preview
// Body: { voiceId?: 'male-qn-qingse', text?: '自定义文本' }
router.post('/preview', async (req, res) => {
  const { voiceId, text } = req.body;
  const previewText = text || '你好，我是你的AI电台主播Claudio，今天为你带来最好听的音乐。';

  // If voiceId is provided, temporarily switch to preview it
  let prevZh, prevEn;
  if (voiceId && VOICE_MAP[voiceId]) {
    prevZh = tts.getVoice('zh');
    prevEn = tts.getVoice('en');
    tts.setVoice(VOICE_MAP[voiceId].zh, 'zh');
    tts.setVoice(VOICE_MAP[voiceId].en, 'en');
  }

  try {
    const result = await tts.synthesize(previewText, 'zh');
    res.json({ url: result.url, cached: result.cached });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // Restore previous voice if we temporarily switched
    if (prevZh !== undefined) {
      tts.setVoice(prevZh, 'zh');
      tts.setVoice(prevEn, 'en');
    }
  }
});

module.exports = router;
