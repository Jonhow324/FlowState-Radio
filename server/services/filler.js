// services/filler.js — Filler / transition DJ talk generator
// Generates generic (non-song-specific) DJ transitions for:
// - Gap filling while LLM is loading
// - Breaking up long stretches of continuous music
// - Smooth style transitions between mood shifts

const logger = require('../utils/logger');

// ── Filler Templates ─────────────────────────────────────────
// Each template is a function that receives context and returns text

const TIME_FILLERS = {
  morning: [
    '早安，新的一天从好音乐开始。',
    '清晨的空气格外清新，让这首歌陪你慢慢醒来。',
    '早上好，希望今天的音乐能给你一个美好的开场。',
    '阳光洒进来了，配上一首好歌，刚刚好。',
  ],
  afternoon: [
    '午后的时光总是慵懒的，让音乐继续陪你。',
    '下午了，休息一下，听首歌放松放松。',
    '午后的阳光和旋律最配了。',
    '又到了下午茶时间，来点音乐佐茶。',
  ],
  evening: [
    '夜幕降临，是时候换一种节奏了。',
    '晚风习习，让音乐陪你度过这个夜晚。',
    '忙碌了一天，现在是属于你和音乐的时间。',
    '夜色渐浓，换一首歌，换一种心情。',
  ],
  night: [
    '夜深了，让这首安静的歌陪你入眠。',
    '深夜的电波里，只有音乐和你。',
    '这个时间还在听歌的你，一定有什么心事吧。',
    '晚安之前，再送你一首歌。',
  ],
};

const TRANSITION_FILLERS = [
  '接下来换一种风格，给你一点新鲜感。',
  '让我们稍微转换一下心情，听听这个。',
  '音乐的魅力就在于变化，来，换个味道。',
  '刚才那首歌很棒，接下来这首也不会让你失望。',
  '调一下频道，好音乐马上就来。',
  '这里是 AI Radio，音乐不停，故事继续。',
];

const STRETCH_FILLERS = [
  '已经连着听了好几首了，DJ 出来冒个泡。',
  '音乐不停，但 DJ 想和你说句话。',
  '听到这里，你是不是也有点沉浸其中了？',
  '好的音乐值得连续播放，但偶尔也需要 DJ 串个场。',
  '这里是 FlowState，你的 AI 电台，一直在陪你。',
  '插播一下，外面的世界还在转，而这里的音乐也还在。',
];

const WEATHER_FILLERS = {
  rain: [
    '外面还在下雨，正好窝着听歌。',
    '雨天和音乐是绝配，让旋律替你撑伞。',
  ],
  clear: [
    '今天天气不错，音乐也跟着明朗起来。',
    '好天气配好心情，继续听。',
  ],
  cloudy: [
    '天有点阴，但音乐可以让心情放晴。',
    '多云的天气，适合听一些有层次的歌。',
  ],
  snow: [
    '下雪了，世界安静下来，只有音乐在响。',
    '雪天最适合窝在沙发里，戴上耳机。',
  ],
};

// ── Helper Functions ──────────────────────────────────────────

function getTimePeriod() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Parse weather description into a category
 */
function categorizeWeather(weatherDesc) {
  if (!weatherDesc) return null;
  const desc = weatherDesc.toLowerCase();
  if (desc.includes('雨') || desc.includes('rain') || desc.includes('shower') || desc.includes('drizzle')) return 'rain';
  if (desc.includes('雪') || desc.includes('snow')) return 'snow';
  if (desc.includes('云') || desc.includes('阴') || desc.includes('cloud') || desc.includes('overcast')) return 'cloudy';
  if (desc.includes('晴') || desc.includes('clear') || desc.includes('sunny')) return 'clear';
  return null;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Generate a filler DJ talk based on context
 * @param {object} options
 * @param {string} options.reason - Why this filler is needed: 'gap' | 'stretch' | 'transition' | 'weather'
 * @param {string} [options.weather] - Current weather description
 * @param {string} [options.prevSong] - Name of the previous song (for outro context)
 * @param {string} [options.prevArtist] - Artist of the previous song
 * @returns {{ text: string, type: string }} - Filler text and its type
 */
function generateFiller(options = {}) {
  const { reason = 'gap', weather, prevSong, prevArtist } = options;
  const period = getTimePeriod();
  let text;
  let type = reason;

  switch (reason) {
    case 'weather': {
      const category = categorizeWeather(weather);
      if (category && WEATHER_FILLERS[category]) {
        text = pickRandom(WEATHER_FILLERS[category]);
      } else {
        text = pickRandom(TIME_FILLERS[period]);
      }
      break;
    }

    case 'stretch': {
      const base = pickRandom(STRETCH_FILLERS);
      if (prevSong) {
        text = `刚刚听完${prevArtist ? prevArtist + '的' : ''}《${prevSong}》，${pickRandom(TRANSITION_FILLERS)}`;
      } else {
        text = base;
      }
      type = 'stretch';
      break;
    }

    case 'transition': {
      text = pickRandom(TRANSITION_FILLERS);
      if (prevSong) {
        text = `${prevArtist ? prevArtist : ''}的《${prevSong}》告一段落，${text}`;
      }
      break;
    }

    case 'gap':
    default: {
      // Generic time-based filler
      text = pickRandom(TIME_FILLERS[period]);
      type = 'gap';
      break;
    }
  }

  logger.info('FILLER', `Generated ${type} filler: "${text}"`);
  return { text, type };
}

/**
 * Generate a song-specific transition (segue)
 * Used when the brain doesn't provide one
 * @param {object} prevSong - { name, artist }
 * @param {object} nextSong - { name, artist }
 * @returns {string}
 */
function generateSegue(prevSong, nextSong) {
  const templates = [
    `从${prevSong.artist}的《${prevSong.name}》过渡到${nextSong.artist}的《${nextSong.name}》，音乐在流动。`,
    `听完《${prevSong.name}》，接下来是${nextSong.artist}带来的《${nextSong.name}》。`,
    `${prevSong.name}的余韵还在，${nextSong.name}已经准备好了。`,
    `刚才那首${prevSong.name}很动人，这首${nextSong.name}也不会让你失望。`,
  ];
  return pickRandom(templates);
}

/**
 * Decide whether a filler should be inserted based on play count
 * @param {number} consecutivePlays - Number of songs played without DJ talk
 * @param {number} [threshold=3] - Trigger threshold
 * @returns {boolean}
 */
function shouldInsertFiller(consecutivePlays, threshold = 3) {
  return consecutivePlays >= threshold;
}

module.exports = {
  generateFiller,
  generateSegue,
  shouldInsertFiller,
  getTimePeriod,
  categorizeWeather,
};
