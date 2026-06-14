// context.js — Prompt assembly factory
// Assembles 6 pieces of context for the AI brain

const fs = require('fs');
const path = require('path');
const config = require('./config');
const state = require('./state');
const weather = require('./services/weather');
const calendar = require('./services/calendar');
const logger = require('./utils/logger');

/**
 * Load DJ persona prompt based on active DJ
 */
async function loadSystemPrompt() {
  const currentState = state.getCurrentState();
  const activeDj = currentState?.active_dj || 'zh';
  const filename = `dj-persona-${activeDj}.md`;
  const filePath = path.join(config.promptsDir, filename);

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    // Fallback to Chinese version
    const fallback = path.join(config.promptsDir, 'dj-persona-zh.md');
    return fs.readFileSync(fallback, 'utf-8');
  }
}

/**
 * Load all user corpus files (taste, routines, mood-rules)
 */
async function loadUserCorpus() {
  const files = ['taste.md', 'routines.md', 'mood-rules.md'];
  const parts = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(config.userDir, file), 'utf-8');
      parts.push(`### ${file}\n${content}`);
    } catch {
      // File may not exist
    }
  }

  // Include playlists.json summary
  try {
    const playlists = JSON.parse(
      fs.readFileSync(path.join(config.userDir, 'playlists.json'), 'utf-8')
    );
    if (playlists.imported?.length) {
      const list = playlists.imported.map((p) => `- ${p.name} (ID: ${p.id})`).join('\n');
      parts.push(`### 导入的歌单\n${list}`);
    }
  } catch {
    // No playlists
  }

  return parts.join('\n\n');
}

/**
 * Get current environment context (weather, time, calendar)
 */
async function fetchEnvironment() {
  const now = new Date();
  const parts = [];

  // Time context
  const timeDesc = getTimeDescription(now);
  parts.push(timeDesc);

  // Weather
  try {
    const weatherDesc = await weather.getDescription();
    if (weatherDesc) parts.push(weatherDesc);
  } catch {
    // Weather unavailable
  }

  // Calendar
  try {
    const calendarDesc = await calendar.getEventsDescription();
    if (calendarDesc) parts.push(calendarDesc);
  } catch {
    // Calendar unavailable
  }

  return parts.join('\n');
}

/**
 * Get recent memory (plays + messages)
 */
async function fetchMemory() {
  const recentPlays = state.getRecentPlays(10);
  const recentMessages = state.getRecentMessages(3);

  const parts = [];

  if (recentPlays.length > 0) {
    const playList = recentPlays
      .map((p) => `- ${p.track_name || 'Unknown'} — ${p.artist || 'Unknown'} (${p.source || ''})`)
      .join('\n');
    parts.push(`### 最近播放\n${playList}`);
  }

  if (recentMessages.length > 0) {
    const msgList = recentMessages
      .map((m) => `- [${m.role}] ${m.content.slice(0, 100)}`)
      .join('\n');
    parts.push(`### 最近对话\n${msgList}`);
  }

  // Current queue
  const queueLength = state.getQueueLength();
  if (queueLength > 0) {
    parts.push(`当前播放队列还有 ${queueLength} 首歌。`);
  }

  return parts.join('\n\n');
}

/**
 * Assemble full context for AI reasoning
 */
async function assemble({ userInput, triggerType = 'chat' }) {
  const [systemPrompt, userCorpus, environment, memory] = await Promise.all([
    loadSystemPrompt(),
    loadUserCorpus(),
    fetchEnvironment(),
    fetchMemory(),
  ]);

  const context = {
    systemPrompt,
    userCorpus,
    environment,
    memory,
    userInput,
    executionTrace: { triggerType, timestamp: new Date().toISOString() },
  };

  return context;
}

/**
 * Generate human-readable time description
 */
function getTimeDescription(date) {
  const hour = date.getHours();
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const day = dayNames[date.getDay()];
  const isWeekend = [0, 6].includes(date.getDay());

  let period;
  if (hour < 6)       period = '凌晨';
  else if (hour < 9)  period = '早晨';
  else if (hour < 12) period = '上午';
  else if (hour < 14) period = '中午';
  else if (hour < 18) period = '下午';
  else if (hour < 22) period = '晚上';
  else                period = '深夜';

  return `现在是${day}${period} ${hour}:${String(date.getMinutes()).padStart(2, '0')}，${isWeekend ? '周末' : '工作日'}。`;
}

module.exports = {
  assemble,
  loadSystemPrompt,
  loadUserCorpus,
};
