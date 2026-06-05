// logger.js — Structured logging utility

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function formatTimestamp() {
  return new Date().toISOString();
}

function log(level, tag, message, data) {
  if (LEVELS[level] < currentLevel) return;

  const entry = {
    time: formatTimestamp(),
    level,
    tag,
    message,
  };

  if (data !== undefined) {
    entry.data = data;
  }

  const prefix = `[${entry.time}] [${level.toUpperCase()}] [${tag}]`;

  if (level === 'error') {
    console.error(prefix, message, data || '');
  } else if (level === 'warn') {
    console.warn(prefix, message, data || '');
  } else {
    console.log(prefix, message, data || '');
  }
}

module.exports = {
  debug: (tag, msg, data) => log('debug', tag, msg, data),
  info: (tag, msg, data) => log('info', tag, msg, data),
  warn: (tag, msg, data) => log('warn', tag, msg, data),
  error: (tag, msg, data) => log('error', tag, msg, data),
};
