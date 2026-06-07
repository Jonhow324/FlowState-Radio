// brain.js — Unified Brain adapter with fallback
// Primary: DeepSeek API → Fallback: Rule Engine

const DeepSeekAdapter = require('./services/adapters/deepseek');
const RuleEngine = require('./services/adapters/rule-engine');
const logger = require('./utils/logger');

class Brain {
  constructor(config) {
    this.deepseek = new DeepSeekAdapter(config);
    this.ruleEngine = new RuleEngine(config);
    this._deepseekAvailable = null;
  }

  /**
   * Check and cache DeepSeek availability
   * Refreshes cached state if circuit breaker has reset
   */
  async isDeepSeekAvailable() {
    if (this._deepseekAvailable === null) {
      this._deepseekAvailable = await this.deepseek.isAvailable();
      logger.info('BRAIN', `DeepSeek API available: ${this._deepseekAvailable}`);
    }
    // If circuit is open, skip DeepSeek even if configured
    if (this._deepseekAvailable && this.deepseek.isCircuitOpen()) {
      return false;
    }
    return this._deepseekAvailable;
  }

  /**
   * Think with context — tries DeepSeek first, falls back to rule engine
   * @param {object} context - Assembled context from context.js
   * @returns {Promise<{say, play, reason, segue, source}>}
   */
  async think(context) {
    const useDeepSeek = await this.isDeepSeekAvailable();

    if (useDeepSeek) {
      try {
        logger.info('BRAIN', 'Using DeepSeek API...');

        // Build system prompt from context pieces
        const systemPrompt = [
          context.systemPrompt,
          '',
          '## 用户品味与作息',
          context.userCorpus,
          '',
          '## 当前环境',
          context.environment,
          '',
          '## 记忆',
          context.memory,
          '',
          '# 输出要求',
          '严格返回 JSON 格式：',
          '{"say": "DJ串词(自然语言，可为null)", "songs": [{"name": "歌曲名", "artist": "歌手"}], "reason": "选歌理由", "segue": "过渡词(可为null)"}',
          'songs 数组中填入歌曲名称和歌手名，最多推荐 3-5 首。必须是真实存在的歌曲。',
          '根据用户的品味、当前环境、时间和记忆来选择最合适的音乐。',
          '注意：不要编造歌曲，请推荐你确认真实存在的歌曲。',
        ].join('\n');

        // User prompt is the actual user input
        const userPrompt = context.userInput;

        const result = await this.deepseek.think(systemPrompt, userPrompt);
        logger.info('BRAIN', `DeepSeek responded: ${result.songs.length} songs, say: ${result.say ? 'yes' : 'no'}`);
        return { ...result, source: 'deepseek' };
      } catch (error) {
        logger.warn('BRAIN', `DeepSeek failed: ${error.message}, falling back to rule engine`);
      }
    } else {
      logger.info('BRAIN', 'DeepSeek not configured, using rule engine');
    }

    // Fallback to rule engine
    const result = this.ruleEngine.think(context);
    return { ...result, source: 'rule-engine' };
  }
}

module.exports = Brain;
