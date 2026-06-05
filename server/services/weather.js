// services/weather.js — OpenWeather API wrapper
// Falls back to mock data when API key is not configured

const axios = require('axios');
const config = require('../config');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get current weather data
 */
async function getCurrent(city) {
  city = city || config.defaultCity || '深圳';

  // Check cache
  const cacheKey = `weather:${city}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // No API key — return mock
  if (!config.openweatherApiKey || config.openweatherApiKey === 'placeholder') {
    logger.debug('WEATHER', 'No API key, returning mock data');
    return getMockWeather(city);
  }

  try {
    const res = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
      params: {
        q: city,
        appid: config.openweatherApiKey,
        lang: 'zh_cn',
        units: 'metric',
      },
      timeout: 10000,
    });

    const data = res.data;
    const result = {
      temp: Math.round(data.main?.temp || 25),
      description: data.weather?.[0]?.description || '晴朗',
      icon: data.weather?.[0]?.icon || '01d',
      humidity: data.main?.humidity || 50,
      windSpeed: data.wind?.speed || 2,
      city: data.name || city,
    };

    cache.set(cacheKey, result, CACHE_TTL);
    return result;
  } catch (error) {
    logger.warn('WEATHER', `API failed: ${error.message}`);
    return getMockWeather(city);
  }
}

/**
 * Get natural language weather description
 */
async function getDescription() {
  const data = await getCurrent();
  if (!data) return null;
  return `${data.city}现在${data.description}，${data.temp}°C，湿度 ${data.humidity}%，风速 ${data.windSpeed}m/s。`;
}

/**
 * Mock weather when API is unavailable
 */
function getMockWeather(city) {
  // Simple time-based mock
  const hour = new Date().getHours();
  let temp, desc;

  if (hour < 6)       { temp = 22; desc = '晴朗'; }
  else if (hour < 10) { temp = 24; desc = '多云'; }
  else if (hour < 14) { temp = 28; desc = '晴间多云'; }
  else if (hour < 18) { temp = 26; desc = '多云'; }
  else                { temp = 23; desc = '晴朗'; }

  return {
    temp,
    description: desc,
    icon: '01d',
    humidity: 60,
    windSpeed: 3,
    city: city || '深圳',
  };
}

module.exports = { getCurrent, getDescription };
