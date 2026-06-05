// router.js — Intent routing
// Determines how to handle user input based on pattern matching

const logger = require('./utils/logger');

const INTENT_PATTERNS = {
  PLAY:       /^(播放|来一首|换首|下一首|切歌|play|放首|放一)/i,
  PAUSE:      /^(暂停|停|pause|停止)/i,
  SKIP:       /^(跳过|skip|下一首|换一首)/i,
  VOLUME:     /^(音量|大声|小声|volume|调)/i,
  LIKE:       /^(喜欢|收藏|like|标记)/i,
  SEARCH:     /^(搜索|找|search|有没有)/i,
  WHAT_PLAYING: /^(什么歌|现在播|now|在放什么)/i,
  MOOD:       /^(心情|mood|感觉|开心|难过|想听|适合|来点)/i,
};

/**
 * Determine intent from user input
 * @param {string} input - User message
 * @returns {{intent: string, params: object}}
 */
function route(input) {
  const trimmed = input.trim();

  // Check patterns in order
  if (INTENT_PATTERNS.PLAY.test(trimmed)) {
    // Extract song name after the command
    const songName = trimmed.replace(INTENT_PATTERNS.PLAY, '').trim();
    return { intent: 'play', params: { songName } };
  }

  if (INTENT_PATTERNS.PAUSE.test(trimmed)) {
    return { intent: 'pause', params: {} };
  }

  if (INTENT_PATTERNS.SKIP.test(trimmed)) {
    return { intent: 'skip', params: {} };
  }

  if (INTENT_PATTERNS.VOLUME.test(trimmed)) {
    return { intent: 'volume', params: { raw: trimmed } };
  }

  if (INTENT_PATTERNS.LIKE.test(trimmed)) {
    return { intent: 'like', params: {} };
  }

  if (INTENT_PATTERNS.SEARCH.test(trimmed)) {
    const keyword = trimmed.replace(INTENT_PATTERNS.SEARCH, '').trim();
    return { intent: 'search', params: { keyword: keyword || trimmed } };
  }

  if (INTENT_PATTERNS.WHAT_PLAYING.test(trimmed)) {
    return { intent: 'what_playing', params: {} };
  }

  if (INTENT_PATTERNS.MOOD.test(trimmed)) {
    return { intent: 'ai', params: { userInput: trimmed } };
  }

  // Default: send to AI brain
  return { intent: 'ai', params: { userInput: trimmed } };
}

module.exports = { route };
