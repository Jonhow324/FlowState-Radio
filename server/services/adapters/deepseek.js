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

    // Circuit breaker state
    this._failCount = 0;
    this._circuitOpen = false;
    this._circuitResetAt = 0;
    this.CIRCUIT_THRESHOLD = 3;     // Open after 3 consecutive failures
    this.CIRCUIT_COOLDOWN = 60000;  // 60s before trying again
    this.MAX_RETRIES = 2;           // Retry up to 2 times on transient errors
  }

  /**
   * Check if DeepSeek API is configured
   */
  async isAvailable() {
    return Boolean(this.apiKey) && this.apiKey !== 'placeholder';
  }

  /**
   * Check circuit breaker — returns true if we should skip DeepSeek
   */
  isCircuitOpen() {
    if (!this._circuitOpen) return false;
    // Check if cooldown has passed
    if (Date.now() >= this._circuitResetAt) {
      logger.info('DEEPSEEK', 'Circuit breaker: cooldown elapsed, attempting half-open');
      this._circuitOpen = false;
      this._failCount = 0;
      return false;
    }
    return true;
  }

  /**
   * Record a failure — opens circuit after threshold
   */
  _recordFailure() {
    this._failCount++;
    if (this._failCount >= this.CIRCUIT_THRESHOLD) {
      this._circuitOpen = true;
      this._circuitResetAt = Date.now() + this.CIRCUIT_COOLDOWN;
      logger.warn('DEEPSEEK', `Circuit breaker OPEN (${this._failCount} failures, cooldown ${this.CIRCUIT_COOLDOWN / 1000}s)`);
    }
  }

  /**
   * Record a success — resets circuit
   */
  _recordSuccess() {
    this._failCount = 0;
    this._circuitOpen = false;
  }

  /**
   * Check if an error is transient (worth retrying)
   */
  _isTransientError(error) {
    // Network errors, timeouts, and 5xx are transient
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') return true;
    if (error.response && error.response.status >= 500) return true;
    return false;
  }

  /**
   * Send prompt to DeepSeek with retry + circuit breaker
   * @param {string} systemPrompt - System prompt (DJ persona + context)
   * @param {string} userPrompt - User message
   * @returns {Promise<{say, play, reason, segue}>}
   */
  async think(systemPrompt, userPrompt) {
    // Check circuit breaker
    if (this.isCircuitOpen()) {
      throw new Error('Circuit breaker open — DeepSeek temporarily unavailable');
    }

    let lastError;
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = attempt * 1000; // 1s, 2s backoff
          logger.info('DEEPSEEK', `Retry ${attempt}/${this.MAX_RETRIES} (delay ${delay}ms)`);
          await new Promise((r) => setTimeout(r, delay));
        }

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

        // Success — reset circuit breaker
        this._recordSuccess();
        return this.parseJSON(content);
      } catch (error) {
        lastError = error;

        if (error.response) {
          logger.error('DEEPSEEK', `API error ${error.response.status}: ${error.response.data?.error?.message || 'Unknown'}`);
        } else {
          logger.error('DEEPSEEK', `Request failed: ${error.message}`);
        }

        // Only retry on transient errors
        if (!this._isTransientError(error)) {
          this._recordFailure();
          throw error;
        }

        // If this was the last retry, record failure
        if (attempt === this.MAX_RETRIES) {
          this._recordFailure();
        }
      }
    }

    throw lastError;
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
