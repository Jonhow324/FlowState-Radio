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
   * Build the rhythm guide section for prompts.
   * Teaches the LLM to make rhythm decisions based on persona + time + song flow.
   */
  _buildRhythmGuide() {
    return [
      '## 节奏控制（非常重要）',
      '你是电台主持人，不是每两首歌之间都要说话。请根据以下原则决定节奏：',
      '',
      '### 时段节奏规则',
      '- 早晨 7-9: 轻快简洁，每 2-3 首歌之间说一次，简短就好',
      '- 上午 9-12: 用户在工作，少说话多放歌，大部分间隙留白，偶尔一句过渡',
      '- 午间 12-14: 轻松随意，可以说可以不说，看歌曲搭配',
      '- 下午 14-18: 适中节奏，每 1-2 首歌之间说一次',
      '- 晚上 18-22: 最自由的时段，可以展开聊，歌曲间过渡自然',
      '- 深夜 22-6: 安静私密，大量留白，只在特别有话想说时才开口',
      '',
      '### 歌曲流节奏',
      '- 同一歌手/风格连续播放时，留白让音乐自己说话',
      '- 情绪型歌曲（ambient/post-rock/纯音乐）前后适合留白',
      '- 风格跳跃大的歌曲之间适合用 bridge 过渡',
      '- 如果连续 3 首都没说话，可以插一句简短的',
      '',
      '### segments 中的 rhythm 字段（必须覆盖所有间隙）',
      '你必须在 segments 数组中为每一个歌曲间隙做出节奏决策，不允许留空：',
      '  - type: "bridge"（需要过渡串词，系统自动生成文本，无需你写 text）',
      '  - type: "silence"（刻意留白，不说话，text 留空字符串 ""）',
      '  - type: "cold_open"（第一首歌前的开场白，anchor=0，**必须写 text**）',
      '  - type: "back_announce"（一首歌播完后的回味，系统自动生成，text 留空字符串 ""）',
      '',
      '重要：bridge 和 back_announce 的话术由系统独立生成，你只需决定**类型**和**位置**，text 字段留空字符串即可。',
      '',
      'N 首歌 = 1 个 cold_open + (N-1) 个 between_tracks 间隙决策。',
      '每个 between_tracks 间隙必须有且仅有一个 segment（bridge 或 silence）。',
      '你可以额外添加 back_announce，但不是必须的。',
      '你的节奏决策将直接驱动电台播出，系统不会做额外判断。',
    ].join('\n');
  }

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
      '{"say": "DJ开场串词(自然语言，可为null)", "songs": [{"name": "歌曲名", "artist": "歌手", "transition_style": "intro|outro|none"}], "segments": [{"type": "cold_open|bridge|silence|back_announce", "text": "仅cold_open需要填写开场白，其余类型留空字符串", "anchor": 0, "position": "before_track|between_tracks|after_track"}], "reason": "选歌理由"}',
      '',
      'segments 说明（推荐提供，控制电台节奏）：',
      '  - type: "cold_open"(开场白) | "bridge"(串场) | "silence"(留白) | "back_announce"(歌曲回味)',
      '  - position: "before_track" | "between_tracks" | "after_track"',
      '  - anchor: 锚定歌曲的索引号（从0开始）',
      '  - text: 仅 cold_open 需要写开场白文本；bridge/silence/back_announce 留空字符串 ""',
      '  如果不提供 segments，系统会自动生成串场。',
      '',
      'transition_style 说明：',
      '  - "intro": DJ 在新歌前奏（低音量）时说话，说完歌曲正式进入',
      '  - "outro": 上一首歌尾奏渐弱，DJ 总结后新歌响起',
      '  - "none": 直接切换，无 DJ 串词',
      '第一首歌建议用 "intro"，歌曲之间用 "outro" 衔接。',
      '',
      '从上面的候选歌曲列表中精选 10-20 首最适合当前场景的歌曲。',
      'songs 数组内的 name 和 artist 必须与候选列表中的完全一致，不要编造新歌。',
      '根据当前时间、天气、用户心情和最近播放记录来决定最佳选择。',
      'say 字段为每首歌的电台串词，要自然融入当前环境信息。',
      '',
      this._buildRhythmGuide(),
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
      '{"say": "DJ开场串词(自然语言，可为null)", "songs": [{"name": "歌曲名", "artist": "歌手", "transition_style": "intro|outro|none"}], "segments": [{"type": "cold_open|bridge|silence|back_announce", "text": "仅cold_open需要填写开场白，其余类型留空字符串", "anchor": 0, "position": "before_track|between_tracks|after_track"}], "reason": "选歌理由"}',
      'segments 为节奏控制字段。type: "cold_open"(开场白) | "bridge"(串场) | "silence"(留白) | "back_announce"(回味)。不提供则系统自动生成。',
      'transition_style: "intro"(新歌前奏垫底说话) 或 "outro"(旧歌尾奏渐弱后切入) 或 "none"(直接切换)。',
      'songs 数组中填入歌曲名称和歌手名，推荐 10-20 首。必须是真实存在的歌曲。',
      '根据用户的品味、当前环境、时间和记忆来选择最合适的音乐。',
      '注意：不要编造歌曲，请推荐你确认真实存在的歌曲。',
      '',
      this._buildRhythmGuide(),
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
