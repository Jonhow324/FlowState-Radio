// services/segmentEngine.js — Segment-driven broadcast engine
// Handles: segment normalization, bridge generation, dedup checking, TTS resolution
// Replaces ad-hoc filler logic with structured segment types.

const tts = require('../tts');
const logger = require('../utils/logger');
const personaLoader = require('./personaLoader');

// ── Segment Types ─────────────────────────────────────────────
const VALID_TYPES = new Set([
  'cold_open',      // Opening narration before first song
  'bridge',         // Inter-track transition
  'back_announce',  // Post-song commentary
  'quick_touch',    // Brief comment / lightweight transition
  'silence',        // Intentional silence (no TTS)
]);

const VALID_POSITIONS = new Set([
  'before_track',
  'between_tracks',
  'after_track',
]);

// ── Normalization ─────────────────────────────────────────────

/**
 * Normalize raw LLM segment output into validated Segment objects.
 * LLM output is untrusted — enforce strict validation.
 *
 * @param {Array} rawSegments - Raw segments from LLM JSON
 * @param {Array} tracks - Confirmed track list [{name, artist, trackId}]
 * @returns {Array<Segment>} Normalized segments
 */
function normalizeSegments(rawSegments, tracks) {
  if (!Array.isArray(rawSegments)) return [];
  if (!tracks || tracks.length === 0) {
    // No tracks — demote all track-bound segments to immediate or drop them
    return rawSegments
      .filter((s) => s.type === 'cold_open' || s.type === 'quick_touch')
      .map((s, i) => ({
        id: `seg:immediate:${i}`,
        type: VALID_TYPES.has(s.type) ? s.type : 'quick_touch',
        position: 'before_track',
        anchorTrackIndex: -1,
        text: (s.text || '').trim(),
        ttsUrl: null,
        ttsStatus: 'pending',
        transitionStyle: 'none',
        metadata: {},
      }));
  }

  const maxIndex = tracks.length - 1;
  const results = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i];

    // Type whitelist — unknown types demote to quick_touch
    const type = VALID_TYPES.has(raw.type) ? raw.type : 'quick_touch';

    // Position — default based on type
    let position = VALID_POSITIONS.has(raw.position) ? raw.position : null;
    if (!position) {
      if (type === 'cold_open') position = 'before_track';
      else if (type === 'bridge') position = 'between_tracks';
      else if (type === 'back_announce') position = 'after_track';
      else position = 'between_tracks';
    }

    // Anchor index — clamp to valid range
    let anchor = typeof raw.anchor === 'number' ? raw.anchor : i;
    anchor = Math.max(0, Math.min(anchor, maxIndex));

    // Text
    const text = (raw.text || '').trim();

    // Silence segments have no text
    const ttsStatus = type === 'silence' ? 'silent' : (text ? 'pending' : 'silent');

    // Transition style
    const transitionStyle = raw.transition_style || raw.transitionStyle || 'outro';

    // Build metadata from adjacent tracks
    const metadata = {};
    if (position === 'between_tracks' || position === 'after_track') {
      const prevIdx = Math.max(0, anchor - (position === 'between_tracks' ? 0 : 0));
      if (tracks[prevIdx]) {
        metadata.prevSong = { name: tracks[prevIdx].name || tracks[prevIdx].trackName, artist: tracks[prevIdx].artist };
      }
    }
    if (position === 'between_tracks' || position === 'before_track') {
      const nextIdx = position === 'between_tracks' ? anchor + 1 : anchor;
      if (tracks[nextIdx]) {
        metadata.nextSong = { name: tracks[nextIdx].name || tracks[nextIdx].trackName, artist: tracks[nextIdx].artist };
      }
    }

    results.push({
      id: `seg:${type}:${anchor}:${i}`,
      type,
      position,
      anchorTrackIndex: anchor,
      text,
      ttsUrl: null,
      ttsStatus,
      transitionStyle,
      metadata,
    });
  }

  return results;
}

// ── Bridge Generation ─────────────────────────────────────────

/**
 * Normalize and validate raw LLM bridge output.
 * Multi-step pipeline: clean → length check → dedup → fallback chain.
 *
 * @param {string} rawText - Raw text from LLM
 * @param {'shallow'|'deep'} depth - Expected depth mode
 * @param {object} fallback - Template fallback result
 * @returns {{ text: string|null, source: string, depth: string, dedup: string }}
 */
function normalizeBridgeOutput(rawText, depth, fallback) {
  const isDeep = depth === 'deep';
  const minLen = isDeep ? 20 : 5;
  const maxLen = isDeep ? 300 : 120;

  // Step 1: Clean — strip quotes, whitespace, markdown artifacts
  let cleaned = (rawText || '')
    .replace(/^["'"「『【《\s]+/, '')
    .replace(/["'"」』】》\s]+$/, '')
    .replace(/```[\s\S]*```/g, '')  // Remove markdown code blocks
    .replace(/^\d+[.、)\]]\s*/, '') // Remove numbering prefixes
    .trim();

  // Step 2: Length validation
  if (!cleaned || cleaned.length < minLen) {
    logger.warn('SEGMENT', `Bridge (${depth}) too short: ${cleaned.length} < ${minLen} chars, falling back`);
    return { text: fallback.text, source: 'template', depth: 'shallow', dedup: 'skipped' };
  }

  // Step 3: Truncate if slightly over (graceful degradation)
  if (cleaned.length > maxLen) {
    // Try truncating at last sentence boundary
    const sentenceEnd = cleaned.lastIndexOf('。', maxLen);
    if (sentenceEnd > minLen) {
      cleaned = cleaned.slice(0, sentenceEnd + 1);
    } else {
      // Try comma boundary
      const commaEnd = cleaned.lastIndexOf('，', maxLen);
      if (commaEnd > minLen) {
        cleaned = cleaned.slice(0, commaEnd + 1);
      } else {
        logger.warn('SEGMENT', `Bridge (${depth}) too long: ${cleaned.length} > ${maxLen} chars, falling back`);
        return { text: fallback.text, source: 'template', depth: 'shallow', dedup: 'skipped' };
      }
    }
  }

  // Step 4: Dedup check against recent bridge history
  const dedupResult = checkBridgeDedup(cleaned);
  if (!dedupResult.allowed) {
    logger.info('SEGMENT', `Bridge dedup blocked: ${dedupResult.reason}`);
    // For dedup failures, use template (it's random enough to avoid repeats)
    return { text: fallback.text, source: 'template', depth: 'shallow', dedup: dedupResult.reason };
  }

  return { text: cleaned, source: 'llm', depth, dedup: 'passed' };
}

/**
 * Generate a bridge segment between two songs using LLM (DeepSeek rawChat).
 * Supports two modes:
 *   - shallow: brief one-sentence transition (default, ~75% of bridges)
 *   - deep: expanded 2-4 sentence commentary with personal angle (~25%)
 *
 * Enriched with persona, time context, play history, and user taste.
 * Falls back to template-based generateBridgeText() on any failure.
 *
 * @param {object} prevSong - { name, artist, tags? }
 * @param {object} nextSong - { name, artist, tags? }
 * @param {object} deepseek - DeepSeekAdapter instance (must have rawChat)
 * @param {object} [options] - { temperature, maxTokens, timeout, depth, expandContext, bridgeContext }
 * @returns {Promise<{ text, transitionStyle, source, depth }>}
 */
async function generateBridgeLLM(prevSong, nextSong, deepseek, options = {}) {
  const fallback = generateBridgeText(prevSong, nextSong);

  // Guard: if deepseek is not provided or rawChat is missing, fall back
  if (!deepseek || typeof deepseek.rawChat !== 'function') {
    return { ...fallback, source: 'template', depth: 'shallow' };
  }

  // Determine depth
  let depth = options.depth || 'auto';
  if (depth === 'auto') {
    const expandResult = shouldExpand(options.expandContext || {});
    depth = expandResult.shouldExpand ? 'deep' : 'shallow';
  }

  const isDeep = depth === 'deep';

  // Build enriched prompts
  const bridgeContext = options.bridgeContext || null;
  const systemPrompt = _buildBridgeSystemPrompt(depth, bridgeContext);
  const userPrompt = _buildBridgeUserPrompt(prevSong, nextSong, bridgeContext);

  const rawOptions = {
    temperature: options.temperature ?? (isDeep ? 0.85 : 0.9),
    maxTokens: options.maxTokens ?? (isDeep ? 250 : 100),
    timeout: options.timeout ?? (isDeep ? 18000 : 12000),
  };

  try {
    const rawText = await deepseek.rawChat(systemPrompt, userPrompt, rawOptions);

    // Normalize output through validation pipeline
    const result = normalizeBridgeOutput(rawText, depth, fallback);

    // Record in history for future dedup checks
    if (result.source === 'llm') {
      recordBridgeText(result.text);
    }

    return { text: result.text, transitionStyle: 'outro', source: result.source, depth: result.depth };
  } catch (err) {
    logger.warn('SEGMENT', `LLM bridge (${depth}) failed: ${err.message}, falling back to template`);
    return { ...fallback, source: 'template', depth: 'shallow' };
  }
}

// ── Bridge Generation ─────────────────────────────────────────

/**
 * Generate a bridge segment between two confirmed songs.
 * Uses template-based generation (LLM bridges are generated in batch during program_start).
 * This function is for post-generation of individual bridges.
 *
 * @param {object} prevSong - { name, artist }
 * @param {object} nextSong - { name, artist }
 * @param {object} [options] - { style, context }
 * @returns {object} Segment text and transition style
 */
function generateBridgeText(prevSong, nextSong, options = {}) {
  const templates = [
    `从${prevSong.artist}的《${prevSong.name}》过渡到${nextSong.artist}的《${nextSong.name}》，音乐在流动。`,
    `听完《${prevSong.name}》，接下来是${nextSong.artist}带来的《${nextSong.name}》。`,
    `《${prevSong.name}》的余韵还在，${nextSong.artist}的《${nextSong.name}》已经准备好了。`,
    `刚才那首《${prevSong.name}》很动人，这首《${nextSong.name}》也不会让你失望。`,
    `${prevSong.artist}和${nextSong.artist}，两种味道，一样好听。`,
  ];
  const text = templates[Math.floor(Math.random() * templates.length)];
  return { text, transitionStyle: 'outro' };
}

// ── LLM Bridge Generation ────────────────────────────────────

// Bridge text dedup history — tracks recent bridge texts to avoid repetition
const BRIDGE_HISTORY_MAX = 20;
let _bridgeTextHistory = [];

/**
 * Record a bridge text in history for dedup checking.
 * @param {string} text - The bridge text that was used
 */
function recordBridgeText(text) {
  if (!text) return;
  _bridgeTextHistory.unshift(text);
  if (_bridgeTextHistory.length > BRIDGE_HISTORY_MAX) {
    _bridgeTextHistory = _bridgeTextHistory.slice(0, BRIDGE_HISTORY_MAX);
  }
}

/**
 * Check if a bridge text is too similar to recent ones.
 * Uses character-level overlap as a lightweight similarity metric.
 *
 * @param {string} text - Candidate bridge text
 * @param {number} [threshold=0.4] - Max allowed overlap ratio (0-1)
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function checkBridgeDedup(text, threshold = 0.4) {
  if (!text || _bridgeTextHistory.length === 0) {
    return { allowed: true, reason: null };
  }

  for (const prev of _bridgeTextHistory) {
    // Exact match
    if (text === prev) {
      return { allowed: false, reason: 'exact_duplicate' };
    }

    // Character overlap: what fraction of the new text's chars appear in the old text
    const overlap = charOverlap(text, prev);
    if (overlap > threshold) {
      return { allowed: false, reason: `too_similar (${(overlap * 100).toFixed(0)}% overlap)` };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Calculate character-level overlap ratio between two strings.
 * Returns 0 (completely different) to 1 (identical).
 */
function charOverlap(a, b) {
  if (!a || !b) return 0;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length >= b.length ? a : b;

  let matches = 0;
  const longerChars = new Set(longer.split(''));
  for (const ch of shorter) {
    if (longerChars.has(ch)) {
      matches++;
      longerChars.delete(ch); // Count each char only once
    }
  }
  return matches / shorter.length;
}

/**
 * Build the system prompt for bridge generation.
 * Injects persona snippet for consistent DJ character.
 *
 * @param {'shallow'|'deep'} depth
 * @param {object} [bridgeContext] - Context from personaLoader.buildBridgeContext()
 * @returns {string} System prompt
 */
function _buildBridgeSystemPrompt(depth, bridgeContext) {
  const persona = bridgeContext?.persona || personaLoader.getBridgePersona();
  const timeContext = bridgeContext?.timeContext || personaLoader.getTimeContext();

  if (depth === 'deep') {
    return [
      persona,
      '',
      '你觉得下一首歌特别契合当下的氛围，想和听众多聊几句。',
      '',
      '请从以下角度中自然选择一个展开（不要列出角度名称，直接说）：',
      '1. 这首歌或歌手背后的创作故事、有趣轶事',
      '2. 音乐中值得细细品味的细节（某段旋律、编曲、歌词的妙处）',
      '3. 这首歌带来的情绪共鸣，为什么此刻听它格外动人',
      '4. 歌曲和当下场景/时间/心境的独特联系',
      '',
      '要求：',
      '- 2-4句话（60-200字），像跟老朋友聊天',
      '- 要有具体的细节，不要空泛的赞美或套话',
      '- 不要引号、不要前缀、不要列点',
      '- 第一句话要自然衔接上一首歌，后面的话展开聊下一首',
      '- 语气真诚，像真的在分享自己对音乐的感受',
      '',
      timeContext,
    ].join('\n');
  }

  // Shallow
  return [
    persona,
    '',
    '你的任务是用一句话串联两首歌之间的过渡，让听众觉得音乐在自然流动。',
    '',
    '要求：',
    '- 只输出一句话（15-60字），不要引号、不要前缀',
    '- 可以提到歌名、歌手、情绪、风格上的联系',
    '- 语气像朋友在耳边轻声说话',
    '- 不要用"让我们"、"接下来"这类套话开头',
    '',
    timeContext,
  ].join('\n');
}

/**
 * Build user prompt with song context + rich layers for bridge generation.
 *
 * @param {object} prevSong - { name, artist, tags? }
 * @param {object} nextSong - { name, artist, tags? }
 * @param {object} [bridgeContext] - Context from personaLoader.buildBridgeContext()
 * @returns {string}
 */
function _buildBridgeUserPrompt(prevSong, nextSong, bridgeContext) {
  const prevName = prevSong.name || prevSong.trackName || '未知';
  const prevArtist = prevSong.artist || '未知';
  const nextName = nextSong.name || nextSong.trackName || '未知';
  const nextArtist = nextSong.artist || '未知';

  const parts = [];

  // Layer 1: Recent play history (avoid repetition)
  if (bridgeContext?.recentPlays) {
    parts.push(bridgeContext.recentPlays);
  }

  // Layer 2: User taste (helps pick relevant angles)
  if (bridgeContext?.userTaste) {
    parts.push(bridgeContext.userTaste);
  }

  // Layer 3: Song pair (core context)
  if (parts.length > 0) parts.push(''); // Blank line separator

  parts.push(`上一首：${prevArtist} -《${prevName}》`);
  if (prevSong.tags) parts.push(`标签：${prevSong.tags}`);
  parts.push(`下一首：${nextArtist} -《${nextName}》`);
  if (nextSong.tags) parts.push(`标签：${nextSong.tags}`);

  return parts.join('\n');
}

/**
 * Generate a bridge segment between two songs using LLM (DeepSeek rawChat).
 * Supports two modes:
 *   - shallow: brief one-sentence transition (default, ~75% of bridges)
 *   - deep: expanded 2-4 sentence commentary with personal angle (~25%)
 *
 * The depth mode is determined internally via shouldExpand() unless overridden.
 * Falls back to template-based generateBridgeText() on any failure.
 *
 * @param {object} prevSong - { name, artist, tags? }
 * @param {object} nextSong - { name, artist, tags? }
 * @param {object} deepseek - DeepSeekAdapter instance (must have rawChat)
 * @param {object} [options] - { temperature, maxTokens, timeout, depth: 'shallow'|'deep'|'auto', expandContext }
 * @returns {Promise<{ text, transitionStyle, source, depth }>}
 */
async function generateBridgeLLM(prevSong, nextSong, deepseek, options = {}) {
  const fallback = generateBridgeText(prevSong, nextSong);

  // Guard: if deepseek is not provided or rawChat is missing, fall back
  if (!deepseek || typeof deepseek.rawChat !== 'function') {
    return { ...fallback, source: 'template', depth: 'shallow' };
  }

  // Determine depth
  let depth = options.depth || 'auto';
  if (depth === 'auto') {
    const expandResult = shouldExpand(options.expandContext || {});
    depth = expandResult.shouldExpand ? 'deep' : 'shallow';
  }

  const isDeep = depth === 'deep';
  const systemPrompt = isDeep ? DEEP_SYSTEM_PROMPT : SHALLOW_SYSTEM_PROMPT;
  const userPrompt = _buildBridgeUserPrompt(prevSong, nextSong);

  const rawOptions = {
    temperature: options.temperature ?? (isDeep ? 0.85 : 0.9),
    maxTokens: options.maxTokens ?? (isDeep ? 250 : 100),
    timeout: options.timeout ?? (isDeep ? 18000 : 12000),
  };

  try {
    const text = await deepseek.rawChat(systemPrompt, userPrompt, rawOptions);

    // Validate and clean
    const cleaned = text.replace(/^["'"「『【]+/, '').replace(/["'"」』】]+$/, '').trim();
    const minLen = isDeep ? 20 : 5;
    const maxLen = isDeep ? 300 : 120;

    if (!cleaned || cleaned.length < minLen || cleaned.length > maxLen) {
      logger.warn('SEGMENT', `LLM bridge (${depth}) ${cleaned.length} chars out of [${minLen},${maxLen}], falling back`);
      return { ...fallback, source: 'template', depth: 'shallow' };
    }

    return { text: cleaned, transitionStyle: 'outro', source: 'llm', depth };
  } catch (err) {
    logger.warn('SEGMENT', `LLM bridge (${depth}) failed: ${err.message}, falling back to template`);
    return { ...fallback, source: 'template', depth: 'shallow' };
  }
}

// ── Cold Open Generation (Narrative Arc) ─────────────────────

/**
 * Cold open narrative arc parts.
 * Inspired by Claudio-FM's 5-part structure for opening narrations.
 * Not every cold open needs all 5 parts — the LLM decides based on context.
 *
 * anchor:     Sets the scene ("周一晚上十点，窗外开始安静了")
 * heart:      Emotional core ("今天过得怎么样，只有你自己知道")
 * turn:       Shift in perspective ("不过没关系，接下来的时间交给音乐")
 * image:      Vivid sensory detail ("耳机里传来第一个音符的时候，世界就慢下来了")
 * invitation: Call to connection ("今晚的歌单，为你准备")
 */
const COLD_OPEN_PARTS = ['anchor', 'heart', 'turn', 'image', 'invitation'];

/**
 * Generate a cold open segment — the opening narration before the first song.
 * Uses the LLM to create a contextually rich, persona-consistent opening.
 *
 * @param {object} firstSong - { name, artist, tags? } — The first song in the set
 * @param {object} deepseek - DeepSeekAdapter instance
 * @param {object} [options] - { bridgeContext, parts: string[] }
 * @returns {Promise<{ text: string|null, parts: Array<{part, text}>, source: string }>}
 */
async function generateColdOpen(firstSong, deepseek, options = {}) {
  if (!deepseek || typeof deepseek.rawChat !== 'function') {
    return { text: null, parts: [], source: 'none' };
  }

  const bridgeContext = options.bridgeContext || personaLoader.buildBridgeContext();
  const persona = bridgeContext.persona || personaLoader.getBridgePersona();
  const timeContext = bridgeContext.timeContext || personaLoader.getTimeContext();
  const recentPlays = bridgeContext.recentPlays || '';

  const songName = firstSong.name || firstSong.trackName || '第一首歌';
  const songArtist = firstSong.artist || '';

  const systemPrompt = [
    persona,
    '',
    '你正在开启今天的电台节目。用一段开场白为听众设定氛围。',
    '',
    '叙事弧（自然融入，不要刻意标注）：',
    '- 定场：描述当下的时间、空间、氛围',
    '- 情感：触及听众此刻可能的状态或心情',
    '- 转折：从日常引向音乐',
    '- 画面：一个具体的感官细节',
    '- 邀请：让听众觉得这段开场是为他说的',
    '',
    '要求：',
    '- 2-4句话（90-220字）',
    '- 自然衔接第一首歌，让听众觉得音乐是开场的延续',
    '- 不要播音腔、不要"大家好欢迎来到"',
    '- 不要列点、不要标注叙事弧名称',
    '',
    timeContext,
  ].join('\n');

  const userParts = [];
  if (recentPlays) userParts.push(recentPlays);
  userParts.push('');
  userParts.push(`即将播出的第一首歌：${songArtist ? songArtist + ' - ' : ''}《${songName}》`);
  if (firstSong.tags) userParts.push(`标签：${firstSong.tags}`);

  const userPrompt = userParts.join('\n');

  try {
    const rawText = await deepseek.rawChat(systemPrompt, userPrompt, {
      temperature: 0.85,
      maxTokens: 300,
      timeout: 20000,
    });

    // Clean output
    let cleaned = (rawText || '')
      .replace(/^["'"「『【\s]+/, '')
      .replace(/["'"」』】\s]+$/, '')
      .trim();

    // Length validation
    if (cleaned.length < 30) {
      logger.warn('SEGMENT', `Cold open too short: ${cleaned.length} chars`);
      return { text: null, parts: [], source: 'failed' };
    }
    if (cleaned.length > 300) {
      const sentenceEnd = cleaned.lastIndexOf('。', 300);
      if (sentenceEnd > 30) {
        cleaned = cleaned.slice(0, sentenceEnd + 1);
      }
    }

    // Split into narrative parts (best-effort: by sentence boundaries)
    const sentences = cleaned.split(/(?<=[。！？\n])/).filter(s => s.trim());
    const parts = sentences.map((text, i) => ({
      part: COLD_OPEN_PARTS[i] || `extra_${i}`,
      text: text.trim(),
    }));

    return { text: cleaned, parts, source: 'llm' };
  } catch (err) {
    logger.warn('SEGMENT', `Cold open generation failed: ${err.message}`);
    return { text: null, parts: [], source: 'failed' };
  }
}

// ── Back Announce Generation ──────────────────────────────────

/**
 * Generate a back_announce segment — a brief post-song commentary.
 * Played after a song ends and before the next one starts.
 *
 * @param {object} song - { name, artist, tags? }
 * @param {object} [options] - { mood, context }
 * @returns {{ text: string, transitionStyle: string }}
 */
function generateBackAnnounce(song, options = {}) {
  const name = song.name || song.trackName || '这首歌';
  const artist = song.artist || '';

  const templates = [
    `刚才那是${artist ? artist + '的' : ''}《${name}》，${pickRandom(['经典中的经典', '百听不厌', '让人回味无穷', '值得反复品味'])}。`,
    `${artist ? artist : ''}的《${name}》，${pickRandom(['每次听都有新感受', '总能戳中某个柔软的角落', '旋律还在耳边绕', '情绪还沉浸在里面'])}。`,
    `一首《${name}》${pickRandom(['送给此刻的你', '献给这个夜晚', '配得上你现在的状态', '刚好契合当下的心情'])}。`,
    `《${name}》播完了，${pickRandom(['但余韵可以留久一点', '好歌总是让人觉得太短', '让这份感觉多停留一会儿', '音乐停了，情绪还在继续'])}。`,
  ];

  // Emotional/instrumental tracks get softer commentary
  const tags = (song.tags || '').toLowerCase();
  if (tags.includes('ambient') || tags.includes('instrumental') || tags.includes('classical')) {
    return {
      text: pickRandom([
        `《${name}》的旋律渐渐散去，什么都不用说。`,
        `有些音乐不需要语言，刚才的《${name}》就是。`,
      ]),
      transitionStyle: 'none',
    };
  }

  return {
    text: pickRandom(templates),
    transitionStyle: 'none',
  };
}

// ── Silence Detection ─────────────────────────────────────────

const SILENCE_CONFIG = {
  nightHoursStart: 23,           // 深夜开始：23:00
  nightHoursEnd: 6,              // 深夜结束：06:00
  nightSilenceProbability: 0.5,  // 深夜 50% 概率插入 silence (increased from 0.4)
  consecutiveBridgeLimit: 3,     // 连续 3 个 bridge 后强制 silence
  sameArtistBoost: 0.3,          // +30% silence if prev and next are same artist
  sameGenreBoost: 0.15,          // +15% silence if both tracks share genre tags
  emotionalTags: new Set([
    'emotional', 'ambient', 'instrumental', 'classical',
    'post-rock', 'shoegaze', 'dream pop', '冥想', '纯音乐',
    '新世纪', '氛围', '后摇', '治愈',
  ]),
  // Genre tags for "same genre" detection
  genreTags: new Set([
    'rock', 'pop', 'jazz', 'electronic', 'hip-hop', 'r&b', 'folk',
    'indie', 'punk', 'metal', 'blues', 'country', 'reggae',
    '摇滚', '流行', '爵士', '电子', '民谣', '嘻哈',
  ]),
};

/**
 * Decide whether a silence segment should be inserted at this position.
 *
 * Rules (in priority order):
 * 1. Emotional/ambient previous track → silence lets the mood breathe
 * 2. Same artist consecutive → let the music speak, avoid DJ over-talking
 * 3. Late night → reduce DJ chatter (probabilistic)
 * 4. Bridge fatigue → too many bridges in a row
 * 5. Same genre pair → genre flow is better without interruption
 * 6. Emotional next track → silence as a gentle lead-in
 *
 * @param {object} context
 * @param {object} context.prevSong - { name, artist, tags? }
 * @param {object} [context.nextSong] - { name, artist, tags? }
 * @param {number} context.consecutiveBridges - How many bridges in a row so far
 * @param {number} [context.hour] - Current hour (0-23), defaults to Date.now()
 * @returns {{ shouldSilence: boolean, reason: string|null }}
 */
function shouldSilence(context = {}) {
  const { prevSong, nextSong, consecutiveBridges = 0 } = context;
  const hour = typeof context.hour === 'number' ? context.hour : new Date().getHours();

  const prevTags = ((prevSong?.tags || '') + ' ' + (prevSong?.mood || '')).toLowerCase();
  const nextTags = ((nextSong?.tags || '') + ' ' + (nextSong?.mood || '')).toLowerCase();

  // Rule 1: Emotional/ambient previous track → silence lets the mood breathe
  const prevIsEmotional = [...SILENCE_CONFIG.emotionalTags].some(t => prevTags.includes(t));
  if (prevIsEmotional) {
    return { shouldSilence: true, reason: 'emotional_prev' };
  }

  // Rule 2: Same artist consecutive → let the music speak
  const prevArtist = (prevSong?.artist || '').toLowerCase().trim();
  const nextArtist = (nextSong?.artist || '').toLowerCase().trim();
  if (prevArtist && nextArtist && prevArtist === nextArtist) {
    return { shouldSilence: true, reason: 'same_artist' };
  }

  // Rule 3: Late night — reduce DJ chatter with increased probability
  const isNight = hour >= SILENCE_CONFIG.nightHoursStart || hour < SILENCE_CONFIG.nightHoursEnd;
  if (isNight && Math.random() < SILENCE_CONFIG.nightSilenceProbability) {
    return { shouldSilence: true, reason: 'night_mode' };
  }

  // Rule 4: Too many consecutive bridges — forced breather
  if (consecutiveBridges >= SILENCE_CONFIG.consecutiveBridgeLimit) {
    return { shouldSilence: true, reason: 'bridge_fatigue' };
  }

  // Rule 5: Same genre pair → genre flow is better uninterrupted
  if (prevTags && nextTags) {
    const sharedGenres = [...SILENCE_CONFIG.genreTags].filter(t => prevTags.includes(t) && nextTags.includes(t));
    if (sharedGenres.length > 0 && Math.random() < SILENCE_CONFIG.sameGenreBoost) {
      return { shouldSilence: true, reason: `same_genre (${sharedGenres[0]})` };
    }
  }

  // Rule 6: Next track is emotional → silence as a gentle lead-in
  const nextIsEmotional = [...SILENCE_CONFIG.emotionalTags].some(t => nextTags.includes(t));
  if (nextIsEmotional) {
    return { shouldSilence: true, reason: 'emotional_next' };
  }

  return { shouldSilence: false, reason: null };
}

// ── Expansion Scoring ─────────────────────────────────────────

const EXPAND_CONFIG = {
  baseProbability: 0.25,            // ~25% base chance of expansion
  emotionalBoost: 0.20,             // +20% for emotional/ambient/classical tags
  nightBoost: 0.15,                 // +15% during late night hours (22:00-05:00)
  consecutiveExpandedLimit: 1,      // Never expand 2 bridges in a row
  minGapBetweenExpansions: 2,       // At least 2 normal bridges between expansions
};

/**
 * Decide whether this bridge should be an "expanded" deep commentary.
 * Target: ~20-30% of bridges get expanded, with guards against consecutive expansions.
 *
 * @param {object} context
 * @param {object} [context.nextSong] - { name, artist, tags?, mood? }
 * @param {number} [context.consecutiveExpanded] - How many expanded bridges in a row (0 or 1)
 * @param {number} [context.bridgesSinceLastExpand] - Normal bridges since last expansion
 * @param {number} [context.hour] - Current hour (0-23)
 * @returns {{ shouldExpand: boolean, probability: number, reason: string }}
 */
function shouldExpand(context = {}) {
  const { consecutiveExpanded = 0, bridgesSinceLastExpand = 0 } = context;
  const hour = typeof context.hour === 'number' ? context.hour : new Date().getHours();

  // Hard guard: never expand 2 in a row
  if (consecutiveExpanded >= EXPAND_CONFIG.consecutiveExpandedLimit) {
    return { shouldExpand: false, probability: 0, reason: 'consecutive_limit' };
  }

  // Hard guard: need breathing room after last expansion
  if (bridgesSinceLastExpand < EXPAND_CONFIG.minGapBetweenExpansions) {
    return { shouldExpand: false, probability: 0, reason: 'too_soon' };
  }

  // Calculate probability
  let probability = EXPAND_CONFIG.baseProbability;

  // Boost for emotional/ambient songs
  const nextTags = ((context.nextSong?.tags || '') + ' ' + (context.nextSong?.mood || '')).toLowerCase();
  if (SILENCE_CONFIG.emotionalTags.some(t => nextTags.includes(t))) {
    probability += EXPAND_CONFIG.emotionalBoost;
  }

  // Boost for late night hours (more intimate, more room for depth)
  const isLateNight = hour >= 22 || hour < 5;
  if (isLateNight) {
    probability += EXPAND_CONFIG.nightBoost;
  }

  const expand = Math.random() < probability;
  return {
    shouldExpand: expand,
    probability: Math.round(probability * 100) / 100,
    reason: expand ? 'selected' : 'probability',
  };
}

// ── Shared Helpers ────────────────────────────────────────────

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Segment Factories ─────────────────────────────────────────

/**
 * Build a back_announce Segment object for a confirmed track.
 * @param {object} song - { name, artist, tags? }
 * @param {number} anchorIndex - Track's index in the batch
 * @param {string} [idPrefix='back'] - ID prefix for uniqueness
 * @returns {object} Segment
 */
function buildBackAnnounceSegment(song, anchorIndex, idPrefix = 'back') {
  const info = generateBackAnnounce(song);
  return {
    id: `seg:back_announce:${idPrefix}:${anchorIndex}`,
    type: 'back_announce',
    position: 'after_track',
    anchorTrackIndex: anchorIndex,
    text: info.text,
    ttsUrl: null,
    ttsStatus: 'pending',
    transitionStyle: info.transitionStyle,
    metadata: { prevSong: { name: song.name || song.trackName, artist: song.artist } },
  };
}

/**
 * Build a silence Segment object.
 * @param {number} anchorIndex - Track's index in the batch
 * @param {string} reason - Why silence was chosen
 * @param {string} [idPrefix='silence'] - ID prefix for uniqueness
 * @returns {object} Segment
 */
function buildSilenceSegment(anchorIndex, reason, idPrefix = 'silence') {
  return {
    id: `seg:silence:${idPrefix}:${anchorIndex}`,
    type: 'silence',
    position: 'between_tracks',
    anchorTrackIndex: anchorIndex,
    text: '',
    ttsUrl: null,
    ttsStatus: 'silent',
    transitionStyle: 'none',
    metadata: { silenceReason: reason },
  };
}

/**
 * Synthesize TTS for a segment and update its status.
 * @param {object} segment - Segment object (mutated in place)
 * @returns {Promise<object>} Updated segment
 */
async function resolveSegmentTTS(segment) {
  if (segment.ttsStatus === 'silent' || !segment.text) {
    segment.ttsStatus = 'silent';
    return segment;
  }

  try {
    const ttsResult = await tts.synthesize(segment.text);
    segment.ttsUrl = ttsResult.url;
    segment.ttsStatus = ttsResult.url ? 'ready' : 'failed';
  } catch (err) {
    logger.warn('SEGMENT', `TTS failed for segment ${segment.id}: ${err.message}`);
    segment.ttsStatus = 'failed';
  }

  return segment;
}

// ── Dedup Checking ────────────────────────────────────────────

/**
 * Check if a track should be excluded based on dedup rules.
 *
 * @param {object} track - { name, artist, trackId }
 * @param {object} dedupState - {
 *   batchIds: Set<trackId>,         // L1: tracks in current batch
 *   queueIds: Set<trackId>,         // L2: tracks in play queue
 *   recentPlays: Array<{trackId, artist, playedAt}>, // L3/L4: recent history
 * }
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function dedupCheck(track, dedupState) {
  const trackId = track.trackId || track.track_id;
  const artist = (track.artist || '').toLowerCase();

  // L1: Batch duplicate
  if (dedupState.batchIds && dedupState.batchIds.has(trackId)) {
    return { allowed: false, reason: 'batch_duplicate' };
  }

  // L2: Queue duplicate
  if (dedupState.queueIds && dedupState.queueIds.has(trackId)) {
    return { allowed: false, reason: 'queue_duplicate' };
  }

  // L3: Cooldown (24 hours)
  if (dedupState.recentPlays && dedupState.recentPlays.length > 0) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentlyPlayed = dedupState.recentPlays.filter(
      (p) => new Date(p.playedAt || p.played_at).getTime() > cutoff
    );
    if (recentlyPlayed.some((p) => (p.trackId || p.track_id) === trackId)) {
      return { allowed: false, reason: 'cooldown_duplicate' };
    }

    // L4: Artist overexposure (same artist in last 5 plays)
    const last5 = dedupState.recentPlays.slice(0, 5);
    const recentArtists = new Set(
      last5.map((p) => (p.artist || '').toLowerCase()).filter(Boolean)
    );
    if (artist && recentArtists.has(artist)) {
      return { allowed: false, reason: 'artist_overexposure' };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Filter a list of songs through the dedup state machine.
 * Returns only the songs that pass all checks.
 *
 * @param {Array} songs - [{ name, artist, trackId? }]
 * @param {object} dedupState - Same as dedupCheck
 * @returns {{ accepted: Array, rejected: Array<{song, reason}> }}
 */
function dedupFilter(songs, dedupState) {
  const accepted = [];
  const rejected = [];
  const batchIds = new Set(dedupState.batchIds || []);

  for (const song of songs) {
    const trackId = song.trackId || song.track_id || song.ncmTrackId;
    const checkState = { ...dedupState, batchIds };
    const result = dedupCheck({ ...song, trackId }, checkState);

    if (result.allowed) {
      accepted.push(song);
      if (trackId) batchIds.add(trackId);
    } else {
      rejected.push({ song, reason: result.reason });
      logger.info('SEGMENT', `Dedup rejected: "${song.name}" — ${result.reason}`);
    }
  }

  return { accepted, rejected };
}

// ── Segment Lookup ────────────────────────────────────────────

/**
 * Find segments for a specific track position.
 *
 * @param {Map} segmentMap - stationState segments (key: "position:anchorIndex")
 * @param {number} trackIndex - Track's index in the queue
 * @returns {{ beforeTrack: Segment|null, afterTrack: Segment|null }}
 */
function getSegmentsForTrack(segmentMap, trackIndex) {
  if (!segmentMap || segmentMap.size === 0) {
    return { beforeTrack: null, afterTrack: null };
  }

  // Check for before_track and between_tracks segments
  const beforeKey = `between_tracks:${trackIndex - 1}`;
  const coldOpenKey = `before_track:${trackIndex}`;
  const beforeTrack = segmentMap.get(coldOpenKey) || segmentMap.get(beforeKey) || null;

  // Check for after_track segment
  const afterKey = `after_track:${trackIndex}`;
  const afterTrack = segmentMap.get(afterKey) || null;

  return { beforeTrack, afterTrack };
}

/**
 * Store segments in a Map keyed by "position:anchorIndex" for O(1) lookup.
 * @param {Array<Segment>} segments
 * @returns {Map<string, Segment>}
 */
function buildSegmentMap(segments) {
  const map = new Map();
  for (const seg of segments) {
    const key = `${seg.position}:${seg.anchorTrackIndex}`;
    map.set(key, seg);
  }
  return map;
}

module.exports = {
  normalizeSegments,
  generateBridgeText,
  generateBridgeLLM,
  generateColdOpen,
  generateBackAnnounce,
  shouldSilence,
  shouldExpand,
  resolveSegmentTTS,
  dedupCheck,
  dedupFilter,
  getSegmentsForTrack,
  buildSegmentMap,
  buildBackAnnounceSegment,
  buildSilenceSegment,
  normalizeBridgeOutput,
  checkBridgeDedup,
  recordBridgeText,
  VALID_TYPES,
  VALID_POSITIONS,
  SILENCE_CONFIG,
  EXPAND_CONFIG,
  COLD_OPEN_PARTS,
};
