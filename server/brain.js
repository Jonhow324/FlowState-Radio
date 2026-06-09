// brain.js — Three-layer AI Brain with RAG song retrieval
// Layer 1: Intent generation (lightweight, no LLM)
// Layer 2: Vector retrieval (candidate songs from user's playlist)
// Layer 3: LLM selection & DJ script generation (DeepSeek → Rule Engine fallback)

const DeepSeekAdapter = require('./services/adapters/deepseek');
const RuleEngine = require('./services/adapters/rule-engine');
const embedding = require('./services/embedding');
const vectorStore = require('./services/vectorStore');
const logger = require('./utils/logger');

// Number of candidate songs to retrieve from vector store
const CANDIDATE_COUNT = 50;

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

  // ── Layer 1: Intent Generation ──────────────────────────────

  /**
   * Generate a natural-language "music intent" description from context.
   * This text is vectorized and used to search the user's playlist.
   * Lightweight — no LLM call needed.
   */
  generateIntent(context) {
    const parts = [];

    // Environment context (time, weather, schedule)
    if (context.environment) {
      parts.push(context.environment);
    }

    // Recent listening history for continuity
    if (context.memory) {
      // Extract just the recent plays section
      const recentMatch = context.memory.match(/### 最近播放\n([\s\S]*?)(?:###|$)/);
      if (recentMatch) {
        parts.push(`最近听了: ${recentMatch[1].trim().split('\n').slice(0, 5).join('; ')}`);
      }
    }

    // User's explicit input (if any)
    if (context.userInput && context.executionTrace?.triggerType === 'chat') {
      parts.push(`用户说: ${context.userInput}`);
    }

    // Trigger context
    const trigger = context.executionTrace?.triggerType || 'chat';
    if (trigger === 'scheduler-morning') {
      parts.push('早安时段，适合开启新一天的音乐');
    } else if (trigger === 'scheduler-refill') {
      parts.push('队列补充，延续当前播放风格');
    } else if (trigger === 'scheduler-transition') {
      parts.push('时段过渡，适当调整音乐风格');
    }

    return parts.join('。');
  }

  // ── Layer 2: Vector Retrieval ───────────────────────────────

  /**
   * Retrieve candidate songs from the vector store
   * @param {string} intentText - Music intent description
   * @returns {Promise<Array<{name, artist, tags, mood, score}>>}
   */
  async retrieveCandidates(intentText) {
    // Check prerequisites
    if (!embedding.isAvailable()) {
      logger.warn('BRAIN', 'Embedding service not available, skipping vector retrieval');
      return null;
    }

    vectorStore.load();
    if (vectorStore.size() === 0) {
      logger.warn('BRAIN', 'Vector store is empty, skipping vector retrieval');
      return null;
    }

    try {
      // Embed the intent text
      const intentVector = await embedding.embed(intentText);

      // Search for similar songs
      const results = vectorStore.search(intentVector, CANDIDATE_COUNT);
      logger.info('BRAIN', `Vector retrieval: ${results.length} candidates (top score: ${results[0]?.score?.toFixed(4) || 'N/A'})`);

      return results.map((r) => ({
        id: r.id,
        name: r.metadata.name,
        artist: r.metadata.artist,
        tags: r.metadata.tags || '',
        mood: r.metadata.mood || '',
        ncmTrackId: r.metadata.ncmTrackId || null,
        score: r.score,
      }));
    } catch (error) {
      logger.warn('BRAIN', `Vector retrieval failed: ${error.message}`);
      return null;
    }
  }

  // ── Layer 3: LLM Selection ──────────────────────────────────

  /**
   * Think with context — three-layer RAG pipeline
   * @param {object} context - Assembled context from context.js
   * @returns {Promise<{say, play, reason, segue, source, candidates}>}
   */
  async think(context) {
    // Layer 1: Generate music intent
    const intentText = this.generateIntent(context);
    logger.info('BRAIN', `Intent: "${intentText.slice(0, 80)}..."`);

    // Layer 2: Retrieve candidates from vector store
    const candidates = await this.retrieveCandidates(intentText);
    const hasVectorCandidates = candidates && candidates.length > 0;

    // Layer 3: LLM selection
    const useDeepSeek = await this.isDeepSeekAvailable();

    if (useDeepSeek) {
      try {
        logger.info('BRAIN', `Using DeepSeek API (${hasVectorCandidates ? 'RAG mode' : 'direct mode'})...`);

        // Build system prompt based on whether we have vector candidates
        const systemPrompt = hasVectorCandidates
          ? this._buildRAGPrompt(context, candidates)
          : this._buildDirectPrompt(context);

        const userPrompt = context.userInput || intentText;
        const result = await this.deepseek.think(systemPrompt, userPrompt);

        // If RAG mode, try to match LLM selections back to vector store candidates
        if (hasVectorCandidates) {
          result.songs = this._matchCandidatesToStore(result.songs, candidates);
        }

        logger.info('BRAIN', `DeepSeek responded: ${result.songs.length} songs, say: ${result.say ? 'yes' : 'no'}`);
        return { ...result, source: 'deepseek', candidates: hasVectorCandidates ? candidates.length : 0 };
      } catch (error) {
        logger.warn('BRAIN', `DeepSeek failed: ${error.message}, falling back to rule engine`);
      }
    } else {
      logger.info('BRAIN', 'DeepSeek not configured, using rule engine');
    }

    // Fallback to rule engine
    const result = this.ruleEngine.think(context);
    return { ...result, source: 'rule-engine', candidates: 0 };
  }

  // ── Prompt Builders ─────────────────────────────────────────

  /**
   * Build RAG prompt: LLM selects from pre-retrieved candidates
   */
  _buildRAGPrompt(context, candidates) {
    // Format candidate list
    const candidateList = candidates
      .map((c, i) => {
        const parts = [`${i + 1}. 《${c.name}》— ${c.artist}`];
        if (c.tags) parts.push(`[${c.tags}]`);
        if (c.mood) parts.push(c.mood.slice(0, 40));
        return parts.join(' ');
      })
      .join('\n');

    return [
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
      '## 候选歌曲（从用户歌单中检索出的最相关歌曲）',
      candidateList,
      '',
      '# 输出要求',
      '严格返回 JSON 格式：',
      '{"say": "DJ串词(自然语言，可为null)", "songs": [{"name": "歌曲名", "artist": "歌手", "transition_style": "intro|outro|none"}], "reason": "选歌理由", "segue": "过渡词(可为null)"}',
      '',
      'transition_style 说明：',
      '  - "intro": DJ 在新歌前奏（低音量）时说话，说完歌曲正式进入',
      '  - "outro": 上一首歌尾奏渐弱，DJ 总结后新歌响起',
      '  - "none": 直接切换，无 DJ 串词',
      '第一首歌建议用 "intro"，歌曲之间用 "outro" 衔接。',
      '',
      '从上面的候选歌曲列表中精选 10-20 首最适合当前场景的歌曲。',
      'songs 数组中的 name 和 artist 必须与候选列表中的完全一致，不要编造新歌。',
      '根据当前时间、天气、用户心情和最近播放记录来决定最佳选择。',
      'say 字段为每首歌的电台串词，要自然融入当前环境信息。',
    ].join('\n');
  }

  /**
   * Build direct prompt: LLM recommends freely (fallback when no vector store)
   */
  _buildDirectPrompt(context) {
    return [
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
      '{"say": "DJ串词(自然语言，可为null)", "songs": [{"name": "歌曲名", "artist": "歌手", "transition_style": "intro|outro|none"}], "reason": "选歌理由", "segue": "过渡词(可为null)"}',
      'transition_style: "intro"(新歌前奏垫底说话) 或 "outro"(旧歌尾奏渐弱后切入) 或 "none"(直接切换)。',
      'songs 数组中填入歌曲名称和歌手名，推荐 10-20 首。必须是真实存在的歌曲。',
      '根据用户的品味、当前环境、时间和记忆来选择最合适的音乐。',
      '注意：不要编造歌曲，请推荐你确认真实存在的歌曲。',
    ].join('\n');
  }

  // ── Candidate Matching ──────────────────────────────────────

  /**
   * Match LLM-selected songs back to vector store candidates.
   * Enriches each song with ncmTrackId and other metadata if available.
   */
  _matchCandidatesToStore(llmSongs, candidates) {
    if (!llmSongs || llmSongs.length === 0) return llmSongs;

    return llmSongs.map((song) => {
      // Find matching candidate by name (fuzzy: case-insensitive, trim whitespace)
      const match = candidates.find((c) => {
        const nameMatch = c.name.toLowerCase().trim() === song.name.toLowerCase().trim();
        const artistMatch = !song.artist || c.artist.toLowerCase().trim() === song.artist.toLowerCase().trim();
        return nameMatch && artistMatch;
      });

      if (match) {
        return {
          ...song,
          vectorId: match.id,
          ncmTrackId: match.ncmTrackId || null,
          tags: match.tags,
          transitionStyle: song.transition_style || song.transitionStyle || 'outro',
        };
      }

      // LLM selected a song not in candidates (shouldn't happen in RAG mode, but handle gracefully)
      logger.warn('BRAIN', `LLM selected "${song.name}" not found in candidates`);
      return {
        ...song,
        transitionStyle: song.transition_style || song.transitionStyle || 'outro',
      };
    });
  }
}

module.exports = Brain;
