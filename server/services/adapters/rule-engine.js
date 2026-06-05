// services/adapters/rule-engine.js — Rule-based fallback engine
// Maps time + weather to fixed music styles and default tracks

const logger = require('../../utils/logger');

// Default track IDs by style (popular NeteaseCloudMusic tracks)
// These are well-known track IDs that should work with NCM API
const DEFAULT_TRACKS = {
  morning: [
    { trackId: '5241534', trackName: '晴天', artist: '周杰伦' },
    { trackId: '1901371647', trackName: '稻香', artist: '周杰伦' },
    { trackId: '5232511', trackName: '简单爱', artist: '周杰伦' },
  ],
  focus: [
    { trackId: '28283799', trackName: 'River Flows In You', artist: 'Yiruma' },
    { trackId: '5249706', trackName: '菊次郎的夏天', artist: '久石让' },
    { trackId: '28949374', trackName: 'Comptine d\'un autre été', artist: 'Yann Tiersen' },
  ],
  lunch: [
    { trackId: '5250074', trackName: '告白气球', artist: '周杰伦' },
    { trackId: '436514312', trackName: 'Shape of You', artist: 'Ed Sheeran' },
    { trackId: '5253386', trackName: '七里香', artist: '周杰伦' },
  ],
  chill: [
    { trackId: '5256082', trackName: '夜曲', artist: '周杰伦' },
    { trackId: '5250028', trackName: '不能说的秘密', artist: '周杰伦' },
    { trackId: '29796524', trackName: 'A Little Story', artist: 'Valentin' },
  ],
  evening: [
    { trackId: '5253386', trackName: '七里香', artist: '周杰伦' },
    { trackId: '5241534', trackName: '晴天', artist: '周杰伦' },
    { trackId: '5250086', trackName: '以父之名', artist: '周杰伦' },
  ],
  night: [
    { trackId: '5256082', trackName: '夜曲', artist: '周杰伦' },
    { trackId: '28283799', trackName: 'River Flows In You', artist: 'Yiruma' },
    { trackId: '5250028', trackName: '不能说的秘密', artist: '周杰伦' },
  ],
  rainy: [
    { trackId: '28283799', trackName: 'River Flows In You', artist: 'Yiruma' },
    { trackId: '5256082', trackName: '夜曲', artist: '周杰伦' },
    { trackId: '29796524', trackName: 'A Little Story', artist: 'Valentin' },
  ],
};

class RuleEngine {
  constructor(config) {
    this.config = config;
  }

  /**
   * Rule engine is always available
   */
  async isAvailable() {
    return true;
  }

  /**
   * Generate response based on time + weather rules
   * @param {object} context - Assembled context object
   * @returns {{say, play, reason, segue}}
   */
  think(context) {
    const hour = new Date().getHours();
    const weather = context.environment?.weather?.description || '';
    const isWeekend = [0, 6].includes(new Date().getDay());

    // Determine music style based on time
    let style;
    if (hour < 9)       style = 'morning';
    else if (hour < 12) style = 'focus';
    else if (hour < 14) style = 'lunch';
    else if (hour < 18) style = isWeekend ? 'chill' : 'focus';
    else if (hour < 22) style = 'evening';
    else                style = 'night';

    // Weather override
    if (weather.includes('雨') || weather.includes('rain')) {
      style = 'rainy';
    }

    const tracks = DEFAULT_TRACKS[style] || DEFAULT_TRACKS.evening;
    const timeLabel = this.getTimeLabel(hour);
    const weatherLabel = weather ? `，天气：${weather}` : '';

    logger.info('RULE_ENGINE', `Style: ${style} (hour=${hour}, weekend=${isWeekend}, weather=${weather})`);

    return {
      say: null, // Rule engine doesn't generate DJ talk
      play: tracks.map((t) => t.trackId),
      reason: `规则引擎：${timeLabel}${weatherLabel} → ${style} 风格`,
      segue: null,
    };
  }

  getTimeLabel(hour) {
    if (hour < 6)  return '凌晨';
    if (hour < 9)  return '早晨';
    if (hour < 12) return '上午';
    if (hour < 14) return '中午';
    if (hour < 18) return '下午';
    if (hour < 22) return '晚上';
    return '深夜';
  }
}

module.exports = RuleEngine;
