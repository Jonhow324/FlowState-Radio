// services/adapters/deepseek.js — DeepSeek API direct adapter
// Uses OpenAI-compatible chat/completions API

const axios = require('axios');
const logger = require('../../utils/logger');

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

class DeepSeekAdapter {
  constructor(config) {
    this.apiKey = config.deepseekApiKey || '';
    this.model = config.deepseekModel || 'deepseek-chat';
    this.timeout = 30000;
  }

  /**
   * Check if DeepSeek API is configured
   */
  async isAvailable() {
    return Boolean(this.apiKey) && this.apiKey !== 'placeholder';
  }

  /**
   * Send prompt to DeepSeek and get structured response
   * @param {string} systemPrompt - System prompt (DJ persona + context)
   * @param {string} userPrompt - User message
   * @returns {Promise<{say, play, reason, segue}>}
   */
  async think(systemPrompt, userPrompt) {
    try {
      const response = await axios.post(
        `${DEEPSEEK_BASE_URL}/v1/chat/completions`,
        {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 1000,
          response_format: { type: 'json_object' },
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeout,
        }
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from DeepSeek');
      }

      return this.parseJSON(content);
    } catch (error) {
      if (error.response) {
        logger.error('DEEPSEEK', `API error ${error.response.status}: ${error.response.data?.error?.message || 'Unknown'}`);
      } else {
        logger.error('DEEPSEEK', `Request failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Parse AI response JSON
   * New format: { say, songs: [{name, artist}], reason, segue }
   */
  parseJSON(raw) {
    const cleaned = raw
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);

    // Support both old (play: [ids]) and new (songs: [{name, artist}]) formats
    const songs = Array.isArray(parsed.songs)
      ? parsed.songs.map((s) => ({
          name: String(s.name || ''),
          artist: String(s.artist || ''),
        })).filter((s) => s.name)
      : [];

    return {
      say: parsed.say || null,
      songs,
      play: songs, // Keep for compatibility — chat.js will resolve
      reason: parsed.reason || '',
      segue: parsed.segue || null,
    };
  }
}

module.exports = DeepSeekAdapter;
