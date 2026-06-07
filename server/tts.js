// tts.js — TTS Voice Synthesis Pipeline (Minimax)
// Flow: text → hash → cache check → Minimax API → save mp3 → return URL path

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const logger = require('./utils/logger');

const MINIMAX_TTS_URL = 'https://api.minimax.chat/v1/t2a_v2';

class TTSService {
  constructor() {
    this.apiKey = config.minimaxApiKey || '';
    this.groupId = config.minimaxGroupId || '';
    this.voiceIdZh = config.minimaxVoiceIdZh || 'default';
    this.voiceIdEn = config.minimaxVoiceIdEn || 'default';
    this.cacheDir = config.ttsCacheDir;
    this.ensureCacheDir();
  }

  ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Check if Minimax TTS is configured
   */
  isAvailable() {
    return Boolean(this.apiKey) && this.apiKey !== 'placeholder';
  }

  /**
   * Synthesize text to audio
   * @param {string} text - Text to synthesize
   * @param {string} [lang='zh'] - Language hint ('zh' or 'en')
   * @returns {Promise<{url: string|null, cached: boolean}>}
   */
  async synthesize(text, lang = 'zh') {
    if (!text || !text.trim()) {
      return { url: null, cached: false };
    }

    // 1. Generate cache key (text hash)
    const hash = crypto.createHash('md5').update(text + lang).digest('hex');
    const filename = `${hash}.mp3`;
    const cachePath = path.join(this.cacheDir, filename);
    const urlPath = `/tts/${filename}`;

    // 2. Check cache
    if (fs.existsSync(cachePath)) {
      logger.info('TTS', `Cache hit: ${hash.slice(0, 8)}...`);
      return { url: urlPath, cached: true };
    }

    // 3. If Minimax not configured, skip TTS
    if (!this.isAvailable()) {
      logger.info('TTS', 'Minimax not configured, skipping TTS synthesis');
      return { url: null, cached: false };
    }

    // 4. Call Minimax TTS API
    try {
      logger.info('TTS', `Synthesizing: "${text.slice(0, 40)}..."`);
      const audioBuffer = await this.callMinimaxTTS(text, lang);

      // 5. Write to cache
      fs.writeFileSync(cachePath, audioBuffer);
      logger.info('TTS', `Saved: ${filename} (${(audioBuffer.length / 1024).toFixed(1)}KB)`);

      return { url: urlPath, cached: false };
    } catch (error) {
      logger.error('TTS', `Synthesis failed: ${error.message}`);
      return { url: null, cached: false };
    }
  }

  /**
   * Call Minimax TTS API
   * Supports both token plan (no Group ID needed) and standard plan
   * @param {string} text
   * @param {string} lang
   * @returns {Promise<Buffer>} Audio buffer
   */
  async callMinimaxTTS(text, lang) {
    const voiceId = lang === 'en' ? this.voiceIdEn : this.voiceIdZh;

    // Build URL: token plan doesn't need GroupId
    const url = this.groupId
      ? `${MINIMAX_TTS_URL}?GroupId=${this.groupId}`
      : MINIMAX_TTS_URL;

    const response = await axios.post(
      url,
      {
        model: 'speech-02-hd',
        text: text,
        voice_setting: {
          voice_id: voiceId,
          speed: 1.0,
          vol: 1.0,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    // Minimax T2A v2 returns JSON with hex-encoded audio
    const data = response.data;

    // Check for API errors
    if (data.base_resp?.status_code !== 0) {
      throw new Error(`Minimax API error: ${data.base_resp?.status_msg || 'Unknown'}`);
    }

    // Audio data is hex-encoded in data.audio
    const audioHex = data.data?.audio;
    if (!audioHex) {
      throw new Error('No audio data in Minimax response');
    }

    // Convert hex string to Buffer
    return Buffer.from(audioHex, 'hex');
  }

  /**
   * Get cache stats
   */
  getCacheStats() {
    try {
      const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.mp3'));
      let totalSize = 0;
      for (const file of files) {
        const stat = fs.statSync(path.join(this.cacheDir, file));
        totalSize += stat.size;
      }
      return {
        count: files.length,
        sizeMB: (totalSize / 1024 / 1024).toFixed(2),
      };
    } catch {
      return { count: 0, sizeMB: '0' };
    }
  }

  /**
   * Clear TTS cache
   */
  clearCache() {
    try {
      const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.mp3'));
      for (const file of files) {
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
      logger.info('TTS', `Cache cleared: ${files.length} files removed`);
    } catch (error) {
      logger.error('TTS', `Cache clear failed: ${error.message}`);
    }
  }
}

// Singleton instance
const ttsService = new TTSService();

module.exports = ttsService;
