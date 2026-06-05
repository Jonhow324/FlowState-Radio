// services/adapters/opencode.js — OpenCode CLI adapter
// Spawns OpenCode CLI as a subprocess for AI reasoning

const { spawn } = require('child_process');
const logger = require('../../utils/logger');

class OpenCodeAdapter {
  constructor(config) {
    this.model = config.aiModel || 'claude-sonnet-4-6';
    this.timeout = 30000; // 30s timeout
    this.apiKey = config.anthropicApiKey || '';
  }

  /**
   * Check if OpenCode CLI is available
   */
  async isAvailable() {
    if (!this.apiKey || this.apiKey === 'sk-ant-placeholder') {
      return false;
    }
    return new Promise((resolve) => {
      const proc = spawn('opencode', ['--version'], { timeout: 5000 });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  /**
   * Send prompt to OpenCode CLI and get structured response
   * @param {string} prompt - Full assembled prompt
   * @returns {Promise<{say, play, reason, segue}>}
   */
  async think(prompt) {
    return new Promise((resolve, reject) => {
      const proc = spawn('opencode', ['run', '--json'], {
        timeout: this.timeout,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.apiKey,
          AI_MODEL: this.model,
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdin.write(prompt);
      proc.stdin.end();

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('error', (err) => {
        reject(new Error(`OpenCode spawn error: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`OpenCode exited ${code}: ${stderr.slice(0, 200)}`));
        }
        try {
          const result = this.parseJSON(stdout);
          resolve(result);
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}. Raw: ${stdout.slice(0, 300)}`));
        }
      });
    });
  }

  /**
   * Parse AI response JSON (handles markdown code blocks)
   */
  parseJSON(raw) {
    const cleaned = raw
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    return {
      say: parsed.say || null,
      play: Array.isArray(parsed.play) ? parsed.play.map(String) : [],
      reason: parsed.reason || '',
      segue: parsed.segue || null,
    };
  }
}

module.exports = OpenCodeAdapter;
