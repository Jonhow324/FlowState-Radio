// config.js — Environment variables & configuration aggregation

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const config = {
  // Server
  port: parseInt(process.env.PORT || '8000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // AI Brain (OpenCode CLI)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-sonnet-4-6',

  // TTS (Minimax)
  minimaxApiKey: process.env.MINIMAX_API_KEY || '',
  minimaxGroupId: process.env.MINIMAX_GROUP_ID || '',
  minimaxVoiceIdZh: process.env.MINIMAX_VOICE_ID_ZH || 'default',
  minimaxVoiceIdEn: process.env.MINIMAX_VOICE_ID_EN || 'default',

  // Weather (OpenWeather)
  openweatherApiKey: process.env.OPENWEATHER_API_KEY || '',
  defaultCity: process.env.DEFAULT_CITY || '深圳',

  // NCM API
  ncmApiUrl: process.env.NCM_API_URL || 'http://localhost:3000',

  // Paths
  dataDir: require('path').resolve(__dirname, '../data'),
  userDir: require('path').resolve(__dirname, '../user'),
  promptsDir: require('path').resolve(__dirname, '../prompts'),
  ttsCacheDir: require('path').resolve(__dirname, '../data/cache/tts'),
};

module.exports = config;
