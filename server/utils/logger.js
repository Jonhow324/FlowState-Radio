// logger.js — Structured logging utility with request correlation
// Dev mode: pretty-printed console output
// Prod mode: JSON structured output for log aggregation

const { AsyncLocalStorage } = require('async_hooks');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;
const isProduction = process.env.NODE_ENV === 'production';

// Async local storage for request correlation IDs
const asyncLocalStorage = new AsyncLocalStorage();

/**
 * Generate a short unique request ID
 */
function generateReqId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `${ts}-${rand}`;
}

/**
 * Run a callback within a request context (sets the correlation ID)
 */
function runWithReqId(reqId, fn) {
  return asyncLocalStorage.run({ reqId }, fn);
}

/**
 * Get the current request ID from async context
 */
function getReqId() {
  const store = asyncLocalStorage.getStore();
  return store?.reqId || null;
}

/**
 * Express middleware: attach a request correlation ID
 */
function requestMiddleware(req, res, next) {
  const reqId = req.headers['x-request-id'] || generateReqId();
  res.setHeader('x-request-id', reqId);
  req.reqId = reqId;
  asyncLocalStorage.run({ reqId }, next);
}

function formatTimestamp() {
  return new Date().toISOString();
}

function log(level, tag, message, data) {
  if (LEVELS[level] < currentLevel) return;

  const reqId = getReqId();

  if (isProduction) {
    // JSON structured output
    const entry = {
      time: formatTimestamp(),
      level,
      tag,
      message,
    };
    if (reqId) entry.reqId = reqId;
    if (data !== undefined) {
      entry.data = typeof data === 'object' ? data : { detail: data };
    }
    const line = JSON.stringify(entry);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  } else {
    // Pretty-print for development
    const prefix = reqId
      ? `[${formatTimestamp()}] [${level.toUpperCase()}] [${tag}] [${reqId}]`
      : `[${formatTimestamp()}] [${level.toUpperCase()}] [${tag}]`;

    if (level === 'error') {
      console.error(prefix, message, data || '');
    } else if (level === 'warn') {
      console.warn(prefix, message, data || '');
    } else {
      console.log(prefix, message, data || '');
    }
  }
}

module.exports = {
  debug: (tag, msg, data) => log('debug', tag, msg, data),
  info: (tag, msg, data) => log('info', tag, msg, data),
  warn: (tag, msg, data) => log('warn', tag, msg, data),
  error: (tag, msg, data) => log('error', tag, msg, data),
  requestMiddleware,
  runWithReqId,
  getReqId,
  generateReqId,
};
