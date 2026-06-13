// services/personaLoader.js — DJ persona loading and prompt extraction
// Provides persona-aware context for bridge/cold_open generation

const fs = require('fs');
const path = require('path');
const config = require('../config');
const state = require('../state');
const logger = require('../utils/logger');

// Cache persona content (reload on demand)
let _cache = { zh: null, en: null, loadedAt: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Bridge Persona Snippets ──────────────────────────────────
// Short, focused persona description injected into bridge prompts.
// This is NOT the full persona doc — it's a distilled version for LLM context.

const BRIDGE_PERSONA_ZH = [
  '你是 FlowState，一个私人音乐电台 DJ。',
  '风格：温暖、自然、有见地，像朋友在耳边轻声聊天。',
  '绝不用播音腔、套话开头、空泛赞美、鸡汤语、emoji。',
  '细节胜过空话——提到具体的旋律、歌词、编曲巧思。',
  '沉默也是表达——不是每个间隙都需要填满。',
].join('\n');

const BRIDGE_PERSONA_EN = [
  'You are FlowState, a personal radio DJ.',
  'Style: warm, natural, insightful — like chatting with a friend.',
  'Never use announcer voice, cliches, empty praise, motivational speak, or emoji.',
  'Details beat platitudes — mention specific melodies, lyrics, production tricks.',
  'Silence is also expression — not every gap needs filling.',
].join('\n');

// ── Time Period Descriptions ─────────────────────────────────

const TIME_PERIODS_ZH = {
  early_morning: '凌晨时分，世界很安静，音乐是最好的陪伴',
  morning: '早晨，新的一天开始，轻快的气息',
  forenoon: '上午工作时间，克制、专注，音乐是背景',
  noon: '午间休息，轻松随意',
  afternoon: '下午，适中的节奏',
  evening: '晚上，最自由的时段，可以感性和深入',
  night: '深夜，温柔、私密，话少但有分量',
};

const TIME_PERIODS_EN = {
  early_morning: 'Early morning, the world is quiet, music is the best company',
  morning: 'Morning, a new day begins, light and fresh',
  forenoon: 'Work hours, restrained and focused, music in the background',
  noon: 'Lunch break, casual and relaxed',
  afternoon: 'Afternoon, a balanced pace',
  evening: 'Evening, the freest hours, can be emotional and deep',
  night: 'Late night, intimate and private, fewer words but each one counts',
};

/**
 * Get the current time period key.
 */
function getTimePeriod(hour) {
  if (typeof hour !== 'number') hour = new Date().getHours();
  if (hour < 6) return 'early_morning';
  if (hour < 9) return 'morning';
  if (hour < 12) return 'forenoon';
  if (hour < 14) return 'noon';
  if (hour < 18) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

/**
 * Get the bridge persona snippet for the active DJ language.
 * @param {string} [lang] - 'zh' or 'en', auto-detected from active DJ if not provided
 * @returns {string}
 */
function getBridgePersona(lang) {
  if (!lang) {
    const currentState = state.getCurrentState();
    lang = currentState?.active_dj || 'zh';
  }
  return lang === 'en' ? BRIDGE_PERSONA_EN : BRIDGE_PERSONA_ZH;
}

/**
 * Get a time-aware context string for prompt injection.
 * @param {number} [hour] - Current hour (0-23)
 * @param {string} [lang] - 'zh' or 'en'
 * @returns {string} e.g. "当前时段：深夜，温柔、私密，话少但有分量"
 */
function getTimeContext(hour, lang) {
  if (!lang) {
    const currentState = state.getCurrentState();
    lang = currentState?.active_dj || 'zh';
  }
  const period = getTimePeriod(hour);
  const periods = lang === 'en' ? TIME_PERIODS_EN : TIME_PERIODS_ZH;
  const desc = periods[period];

  if (lang === 'en') {
    return `Current time mood: ${desc}`;
  }
  return `当前时段：${desc}`;
}

/**
 * Build a summary of recent play history for prompt context.
 * Helps the LLM avoid repeating references to recently played songs.
 *
 * @param {number} [limit=5] - How many recent plays to include
 * @returns {string} Formatted string like "最近播过：周杰伦-晴天, 米津玄師-Lemon"
 */
function getRecentPlaySummary(limit = 5) {
  try {
    const recent = state.getRecentPlays(limit);
    if (!recent || recent.length === 0) return '';

    const list = recent
      .map(p => `${p.artist || '未知'}-${p.track_name || p.trackName || '未知'}`)
      .join(', ');

    return `最近播过：${list}`;
  } catch {
    return '';
  }
}

/**
 * Build a brief user taste summary for prompt context.
 * Reads from user/taste.md and extracts key preferences.
 *
 * @returns {string} Brief taste summary
 */
function getUserTasteSummary() {
  try {
    const tastePath = path.join(config.userDir, 'taste.md');
    const content = fs.readFileSync(tastePath, 'utf-8');

    // Extract "likes" section (first few lines after 喜欢/喜欢听)
    const likesMatch = content.match(/(?:喜欢|喜欢听)[^\n]*\n((?:[-•][^\n]+\n?)+)/m);
    if (likesMatch) {
      const likes = likesMatch[1].trim().split('\n').slice(0, 3).join('、');
      return `用户口味偏好：${likes}`;
    }

    // Fallback: just return first meaningful line
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (lines.length > 0) {
      return `用户口味：${lines[0].trim()}`;
    }
  } catch {
    // taste.md not found
  }
  return '';
}

/**
 * Build the full bridge context object.
 * This is passed to generateBridgeLLM() to enrich the prompt.
 *
 * @param {object} [options] - { hour, lang, includeTaste, includeHistory }
 * @returns {object} Bridge context with persona, time, history, taste
 */
function buildBridgeContext(options = {}) {
  const lang = options.lang || state.getCurrentState()?.active_dj || 'zh';
  const hour = typeof options.hour === 'number' ? options.hour : new Date().getHours();

  const ctx = {
    persona: getBridgePersona(lang),
    timeContext: getTimeContext(hour, lang),
    lang,
    hour,
  };

  // Optional: recent play history (avoid repetition)
  if (options.includeHistory !== false) {
    ctx.recentPlays = getRecentPlaySummary(options.historyLimit || 5);
  }

  // Optional: user taste (helps LLM pick relevant angles)
  if (options.includeTaste !== false) {
    ctx.userTaste = getUserTasteSummary();
  }

  return ctx;
}

/**
 * Load the full persona document (cached).
 * @param {string} [lang] - 'zh' or 'en'
 * @returns {string} Full persona markdown
 */
function loadFullPersona(lang) {
  if (!lang) {
    const currentState = state.getCurrentState();
    lang = currentState?.active_dj || 'zh';
  }

  const now = Date.now();
  if (_cache[lang] && (now - _cache.loadedAt) < CACHE_TTL) {
    return _cache[lang];
  }

  const filename = `dj-persona-${lang}.md`;
  const filePath = path.join(config.promptsDir, filename);

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    _cache[lang] = content;
    _cache.loadedAt = now;
    return content;
  } catch (err) {
    // Fallback to zh
    const fallback = path.join(config.promptsDir, 'dj-persona-zh.md');
    try {
      const content = fs.readFileSync(fallback, 'utf-8');
      _cache.zh = content;
      _cache.loadedAt = now;
      return content;
    } catch {
      logger.warn('PERSONA', 'Could not load persona document');
      return '';
    }
  }
}

/**
 * Invalidate the persona cache (useful after editing persona files).
 */
function clearCache() {
  _cache = { zh: null, en: null, loadedAt: 0 };
}

module.exports = {
  getBridgePersona,
  getTimeContext,
  getTimePeriod,
  getRecentPlaySummary,
  getUserTasteSummary,
  buildBridgeContext,
  loadFullPersona,
  clearCache,
  BRIDGE_PERSONA_ZH,
  BRIDGE_PERSONA_EN,
};
