// state.js — SQLite database wrapper for FlowState Radio (using sql.js)

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');

const DB_PATH = path.join(config.dataDir, 'state.db');

let db = null;
let saveTimer = null;

// ===== Database Helpers =====

/**
 * Ensure data directory exists
 */
function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Also ensure TTS cache dir
  if (!fs.existsSync(config.ttsCacheDir)) {
    fs.mkdirSync(config.ttsCacheDir, { recursive: true });
  }
}

/**
 * Save database to disk (debounced)
 */
function saveDb() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (db) {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    }
  }, 100);
}

/**
 * Save database to disk immediately
 */
function saveDbSync() {
  if (saveTimer) clearTimeout(saveTimer);
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

/**
 * Run a query that returns rows (SELECT)
 * Returns array of objects
 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/**
 * Run a query that returns a single row
 */
function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Run a mutation query (INSERT/UPDATE/DELETE)
 * Auto-saves to disk
 */
function mutate(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ===== Database Initialization =====

async function initDatabase() {
  ensureDataDir();

  const SQL = await initSqlJs();

  // Load existing database or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    logger.info('STATE', `Database loaded from ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    logger.info('STATE', `New database created at ${DB_PATH}`);
  }

  // Create tables
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      track_name TEXT,
      artist TEXT,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      source TEXT,
      reason TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      say_audio_path TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date DATE NOT NULL UNIQUE,
      plan_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS play_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      track_name TEXT,
      artist TEXT,
      position INTEGER NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      source TEXT,
      ai_reason TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS track_metadata (
      track_id TEXT PRIMARY KEY,
      track_name TEXT,
      artist TEXT,
      album TEXT,
      album_art TEXT,
      duration INTEGER,
      lyric TEXT,
      description TEXT,
      segue_text TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS current_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      now_playing_track_id TEXT,
      now_playing_started DATETIME,
      current_mood TEXT,
      volume REAL DEFAULT 0.5,
      is_playing INTEGER DEFAULT 0,
      active_dj TEXT DEFAULT 'zh',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Initialize current_state if not exists
  const existing = queryOne('SELECT id FROM current_state WHERE id = 1');
  if (!existing) {
    mutate('INSERT INTO current_state (id, volume, is_playing, active_dj) VALUES (1, 0.5, 0, ?)', ['zh']);
  }

  // Save initial schema
  saveDbSync();
  logger.info('STATE', 'Database tables initialized');
}

// ===== Plays =====

function logPlay(trackId, trackName, artist, source, reason) {
  mutate(
    'INSERT INTO plays (track_id, track_name, artist, source, reason) VALUES (?, ?, ?, ?, ?)',
    [trackId, trackName, artist, source, reason]
  );
}

function getRecentPlays(limit = 20) {
  return queryAll('SELECT * FROM plays ORDER BY played_at DESC LIMIT ?', [limit]);
}

/**
 * Get play statistics
 */
function getPlayStats() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const todayCount = queryOne(
    "SELECT COUNT(*) as count FROM plays WHERE date(played_at) = ?",
    [today]
  );
  const weekCount = queryOne(
    "SELECT COUNT(*) as count FROM plays WHERE played_at >= ?",
    [weekAgo]
  );
  const totalCount = queryOne('SELECT COUNT(*) as count FROM plays');
  const topArtists = queryAll(
    "SELECT artist, COUNT(*) as count FROM plays WHERE artist IS NOT NULL GROUP BY artist ORDER BY count DESC LIMIT 5"
  );
  const topTracks = queryAll(
    "SELECT track_name, artist, COUNT(*) as count FROM plays WHERE track_name IS NOT NULL GROUP BY track_name, artist ORDER BY count DESC LIMIT 5"
  );

  return {
    today: todayCount?.count || 0,
    week: weekCount?.count || 0,
    total: totalCount?.count || 0,
    topArtists: topArtists || [],
    topTracks: topTracks || [],
  };
}

// ===== Messages =====

function logMessage(role, content, audioPath) {
  mutate(
    'INSERT INTO messages (role, content, say_audio_path) VALUES (?, ?, ?)',
    [role, content, audioPath || null]
  );
}

function getRecentMessages(limit = 5) {
  return queryAll('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?', [limit]);
}

// ===== Daily Plans =====

function saveTodayPlan(planJson) {
  const today = new Date().toISOString().slice(0, 10);
  const jsonStr = typeof planJson === 'string' ? planJson : JSON.stringify(planJson);
  // Use INSERT OR REPLACE
  mutate(
    'INSERT OR REPLACE INTO daily_plans (date, plan_json) VALUES (?, ?)',
    [today, jsonStr]
  );
}

function getTodayPlan() {
  const today = new Date().toISOString().slice(0, 10);
  const row = queryOne('SELECT * FROM daily_plans WHERE date = ?', [today]);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.plan_json);
    return { ...parsed, date: row.date };
  } catch {
    return { raw: row.plan_json, date: row.date };
  }
}

// ===== Preferences =====

function getPref(key) {
  const row = queryOne('SELECT value FROM preferences WHERE key = ?', [key]);
  return row ? row.value : null;
}

function setPref(key, value) {
  mutate(
    'INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
    [key, value]
  );
}

// ===== Play Queue =====

function getQueue() {
  return queryAll('SELECT * FROM play_queue ORDER BY position ASC');
}

function addToQueue(tracks, source, reason) {
  const maxRow = queryOne('SELECT COALESCE(MAX(position), -1) as maxPos FROM play_queue');
  let position = (maxRow ? maxRow.maxPos : -1) + 1;

  for (const track of tracks) {
    const trackId = track.trackId || track;
    const trackName = track.trackName || null;
    const artist = track.artist || null;

    mutate(
      'INSERT INTO play_queue (track_id, track_name, artist, position, source, ai_reason) VALUES (?, ?, ?, ?, ?, ?)',
      [trackId, trackName, artist, position++, source, reason || null]
    );
  }
}

function removeFromQueue(position) {
  mutate('DELETE FROM play_queue WHERE position = ?', [position]);
}

function clearQueue() {
  mutate('DELETE FROM play_queue');
}

function getQueueLength() {
  const row = queryOne('SELECT COUNT(*) as count FROM play_queue');
  return row ? row.count : 0;
}

function shiftQueue() {
  const first = queryOne('SELECT * FROM play_queue ORDER BY position ASC LIMIT 1');
  if (first) {
    mutate('DELETE FROM play_queue WHERE id = ?', [first.id]);
    mutate('UPDATE play_queue SET position = position - 1 WHERE position > 0');
  }
  return first || null;
}

/**
 * Put a track back at the front of the queue (used when skip fails)
 */
function prependToQueue(track) {
  mutate('UPDATE play_queue SET position = position + 1');
  mutate(
    'INSERT INTO play_queue (track_id, track_name, artist, position, source, ai_reason) VALUES (?, ?, ?, 0, ?, ?)',
    [track.track_id, track.track_name || null, track.artist || null, track.source || 'restored', null]
  );
}

// ===== Track Metadata (with in-memory cache) =====

const META_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const META_CACHE_MAX = 200;
const _metaCache = new Map();

function _cacheSet(trackId, data) {
  if (_metaCache.size >= META_CACHE_MAX) {
    // Evict oldest entry
    const oldest = _metaCache.keys().next().value;
    _metaCache.delete(oldest);
  }
  _metaCache.set(trackId, { data, expires: Date.now() + META_CACHE_TTL });
}

function _cacheGet(trackId) {
  const entry = _metaCache.get(trackId);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    _metaCache.delete(trackId);
    return undefined;
  }
  // Move to end (most recently used)
  _metaCache.delete(trackId);
  _metaCache.set(trackId, entry);
  return entry.data;
}

function getTrackMeta(trackId) {
  const cached = _cacheGet(trackId);
  if (cached !== undefined) return cached;
  const row = queryOne('SELECT * FROM track_metadata WHERE track_id = ?', [trackId]);
  if (row) _cacheSet(trackId, row);
  return row;
}

function setTrackMeta(trackId, meta) {
  mutate(`
    INSERT OR REPLACE INTO track_metadata 
    (track_id, track_name, artist, album, album_art, duration, lyric, description, segue_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    trackId,
    meta.trackName || null,
    meta.artist || null,
    meta.album || null,
    meta.albumArt || null,
    meta.duration || null,
    meta.lyric || null,
    meta.description || null,
    meta.segueText || null,
  ]);
  // Update cache with the data we just wrote
  _cacheSet(trackId, {
    track_id: trackId,
    track_name: meta.trackName || null,
    artist: meta.artist || null,
    album: meta.album || null,
    album_art: meta.albumArt || null,
    duration: meta.duration || null,
  });
}

function setTrackDescription(trackId, description) {
  const existing = getTrackMeta(trackId);
  if (!existing) {
    mutate(
      'INSERT INTO track_metadata (track_id, description, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      [trackId, description]
    );
  } else {
    mutate(
      'UPDATE track_metadata SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE track_id = ?',
      [description, trackId]
    );
  }
}

function setTrackSegue(trackId, segueText) {
  const existing = getTrackMeta(trackId);
  if (!existing) {
    mutate(
      'INSERT INTO track_metadata (track_id, segue_text, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      [trackId, segueText]
    );
  } else {
    mutate(
      'UPDATE track_metadata SET segue_text = ?, updated_at = CURRENT_TIMESTAMP WHERE track_id = ?',
      [segueText, trackId]
    );
  }
}

// ===== Current State =====

function getCurrentState() {
  const row = queryOne('SELECT * FROM current_state WHERE id = 1');
  if (!row) {
    mutate(
      'INSERT INTO current_state (id, volume, is_playing, active_dj) VALUES (1, 0.5, 0, ?)',
      ['zh']
    );
    return queryOne('SELECT * FROM current_state WHERE id = 1');
  }
  return row;
}

function updateCurrentState(partial) {
  const current = getCurrentState();
  const merged = { ...current, ...partial, id: 1, updated_at: new Date().toISOString() };

  mutate(`
    UPDATE current_state SET
      now_playing_track_id = ?,
      now_playing_started = ?,
      current_mood = ?,
      volume = ?,
      is_playing = ?,
      active_dj = ?,
      updated_at = ?
    WHERE id = 1
  `, [
    merged.now_playing_track_id || null,
    merged.now_playing_started || null,
    merged.current_mood || null,
    merged.volume ?? 0.5,
    merged.is_playing ? 1 : 0,
    merged.active_dj || 'zh',
    merged.updated_at,
  ]);

  return getCurrentState();
}

// ===== Segment Storage (in-memory) =====
// Segments are transient broadcast data — not persisted to SQLite.
// Keyed by "position:afterTrackIndex" (or beforeTrackIndex for before_track) for O(1) lookup during playback.

const _segmentMap = new Map();

function setSegments(segmentMap) {
  _segmentMap.clear();
  if (segmentMap instanceof Map) {
    for (const [k, v] of segmentMap) _segmentMap.set(k, v);
  }
}

function addSegment(key, segment) {
  _segmentMap.set(key, segment);
}

function removeSegment(key) {
  _segmentMap.delete(key);
}

function getSegment(key) {
  return _segmentMap.get(key) || null;
}

function getSegmentsForTrack(trackIndex) {
  const coldOpenKey = `before_track:${trackIndex}`;
  const bridgeKey = `between_tracks:${trackIndex - 1}`;
  const afterKey = `after_track:${trackIndex}`;

  return {
    beforeTrack: _segmentMap.get(coldOpenKey) || _segmentMap.get(bridgeKey) || null,
    afterTrack: _segmentMap.get(afterKey) || null,
  };
}

function clearSegments() {
  _segmentMap.clear();
}

function getAllSegments() {
  return Array.from(_segmentMap.values());
}

// ===== Recent Plays for Dedup (L3/L4) =====

function getRecentPlaysForDedup(limit = 50) {
  return queryAll(
    'SELECT track_id AS trackId, artist, played_at AS playedAt FROM plays ORDER BY played_at DESC LIMIT ?',
    [limit]
  );
}

module.exports = {
  initDatabase,
  logPlay,
  getRecentPlays,
  getPlayStats,
  logMessage,
  getRecentMessages,
  saveTodayPlan,
  getTodayPlan,
  getPref,
  setPref,
  getQueue,
  addToQueue,
  removeFromQueue,
  clearQueue,
  getQueueLength,
  shiftQueue,
  prependToQueue,
  getTrackMeta,
  setTrackMeta,
  setTrackDescription,
  setTrackSegue,
  getCurrentState,
  updateCurrentState,
  saveDbSync,
  setSegments,
  addSegment,
  removeSegment,
  getSegment,
  getSegmentsForTrack,
  clearSegments,
  getAllSegments,
  getRecentPlaysForDedup,
};
