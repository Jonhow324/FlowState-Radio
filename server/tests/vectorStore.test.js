// vectorStore.test.js — Unit tests for VectorStore + cosine similarity
//
// Strategy: Import the singleton, then call clear() in beforeEach to reset
// state. Override dbPath for file I/O tests to use a temp directory.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Silence console output during tests
let consoleSpy;
beforeEach(() => {
  consoleSpy = {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
});
afterEach(() => {
  consoleSpy.log.mockRestore();
  consoleSpy.warn.mockRestore();
  consoleSpy.error.mockRestore();
});

// ---------------------------------------------------------------------------
// Temp directory for file I/O tests
// ---------------------------------------------------------------------------

const TMP_DIR = path.resolve(__dirname, '../data/test-tmp-vector');
const TMP_DB_PATH = path.join(TMP_DIR, 'test-vector-db.json');

function cleanupTmp() {
  try { if (fs.existsSync(TMP_DB_PATH)) fs.unlinkSync(TMP_DB_PATH); } catch (_) {}
  try { if (fs.existsSync(path.join(TMP_DIR, 'nested', 'deep', 'db.json'))) fs.unlinkSync(path.join(TMP_DIR, 'nested', 'deep', 'db.json')); } catch (_) {}
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VectorStore', () => {
  let store;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../config', () => ({
      vectorDbPath: TMP_DB_PATH,
    }));
    vi.doMock('../utils/logger', () => ({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    }));
    store = require('../services/vectorStore');
    // Ensure clean state: reset items and loaded flag
    store.items = [];
    store._loaded = false;
  });

  afterEach(() => {
    cleanupTmp();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // --------------------------------------------------------------------------
  describe('upsert()', () => {
    it('adds a new item to the store', () => {
      store.upsert('song:1', { name: 'Test Song', artist: 'Artist' }, [0.1, 0.2, 0.3]);

      expect(store.size()).toBe(1);
      expect(store.items[0].id).toBe('song:1');
      expect(store.items[0].metadata.name).toBe('Test Song');
    });

    it('updates an existing item by id', () => {
      store.upsert('song:1', { name: 'Old Name' }, [0.1, 0.2]);
      store.upsert('song:1', { name: 'New Name' }, [0.3, 0.4]);

      expect(store.size()).toBe(1);
      expect(store.items[0].metadata.name).toBe('New Name');
      expect(store.items[0].embedding).toEqual([0.3, 0.4]);
    });

    it('handles multiple distinct items', () => {
      store.upsert('song:1', { name: 'Song A' }, [1, 0]);
      store.upsert('song:2', { name: 'Song B' }, [0, 1]);
      store.upsert('song:3', { name: 'Song C' }, [1, 1]);

      expect(store.size()).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  describe('upsertBatch()', () => {
    it('adds multiple items at once', () => {
      store.upsertBatch([
        { id: 's1', metadata: { name: 'A' }, embedding: [1, 0] },
        { id: 's2', metadata: { name: 'B' }, embedding: [0, 1] },
      ]);

      expect(store.size()).toBe(2);
    });

    it('updates existing items in batch', () => {
      store.upsert('s1', { name: 'Old' }, [1, 0]);
      store.upsertBatch([
        { id: 's1', metadata: { name: 'Updated' }, embedding: [0, 1] },
        { id: 's2', metadata: { name: 'New' }, embedding: [1, 1] },
      ]);

      expect(store.size()).toBe(2);
      expect(store.items.find(i => i.id === 's1').metadata.name).toBe('Updated');
    });
  });

  // --------------------------------------------------------------------------
  describe('remove()', () => {
    it('removes an item by id', () => {
      store.upsert('s1', { name: 'A' }, [1, 0]);
      store.upsert('s2', { name: 'B' }, [0, 1]);
      store.remove('s1');

      expect(store.size()).toBe(1);
      expect(store.items[0].id).toBe('s2');
    });

    it('does nothing when removing a non-existent id', () => {
      store.upsert('s1', { name: 'A' }, [1, 0]);
      store.remove('nonexistent');

      expect(store.size()).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  describe('search()', () => {
    it('returns empty array for empty store', () => {
      const results = store.search([1, 0, 0], 5);
      expect(results).toEqual([]);
    });

    it('returns results sorted by cosine similarity (highest first)', () => {
      // 3D vectors: one along each axis
      store.upsert('x', { name: 'X-axis' }, [1, 0, 0]);
      store.upsert('y', { name: 'Y-axis' }, [0, 1, 0]);
      store.upsert('z', { name: 'Z-axis' }, [0, 0, 1]);

      // Query strongly biased toward X, then Y, then Z — ensures distinct scores
      const results = store.search([0.95, 0.3, 0.1], 3);

      expect(results[0].id).toBe('x');
      expect(results[1].id).toBe('y');
      expect(results[2].id).toBe('z');
      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[1].score).toBeGreaterThan(results[2].score);
    });

    it('respects topK parameter', () => {
      for (let i = 0; i < 10; i++) {
        const v = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        v[i] = 1;
        store.upsert(`s${i}`, { name: `Song ${i}` }, v);
      }

      const results = store.search([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3);
      expect(results).toHaveLength(3);
    });

    it('returns all results when topK > store size', () => {
      store.upsert('s1', { name: 'Only' }, [1, 0]);

      const results = store.search([1, 0], 10);
      expect(results).toHaveLength(1);
    });

    it('returns score of 1.0 for identical vectors', () => {
      const vec = [0.5, 0.5, 0.5, 0.5];
      store.upsert('exact', { name: 'Exact Match' }, vec);

      const results = store.search(vec, 1);
      expect(results[0].score).toBeCloseTo(1.0, 5);
    });

    it('returns score near 0 for orthogonal vectors', () => {
      store.upsert('ortho', { name: 'Orthogonal' }, [1, 0, 0]);

      const results = store.search([0, 1, 0], 1);
      expect(results[0].score).toBeCloseTo(0.0, 5);
    });

    it('includes id and metadata in results', () => {
      store.upsert('s1', { name: 'Test', artist: 'Art' }, [1, 0]);

      const results = store.search([1, 0], 1);
      expect(results[0]).toHaveProperty('id', 's1');
      expect(results[0]).toHaveProperty('metadata');
      expect(results[0]).toHaveProperty('score');
      expect(results[0].metadata.name).toBe('Test');
    });
  });

  // --------------------------------------------------------------------------
  describe('search() with metadata filters', () => {
    it('filters results by metadata key-value', () => {
      store.upsert('s1', { name: 'Pop Song', genre: 'pop' }, [1, 0]);
      store.upsert('s2', { name: 'Rock Song', genre: 'rock' }, [0.9, 0.1]);
      store.upsert('s3', { name: 'Pop Hit', genre: 'pop' }, [0.8, 0.2]);

      const results = store.search([1, 0], 10, { genre: 'pop' });

      expect(results).toHaveLength(2);
      expect(results.every(r => r.metadata.genre === 'pop')).toBe(true);
    });

    it('returns empty when filter matches nothing', () => {
      store.upsert('s1', { name: 'Pop Song', genre: 'pop' }, [1, 0]);

      const results = store.search([1, 0], 10, { genre: 'jazz' });
      expect(results).toHaveLength(0);
    });

    it('supports multiple filter keys', () => {
      store.upsert('s1', { name: 'A', genre: 'pop', year: '2024' }, [1, 0]);
      store.upsert('s2', { name: 'B', genre: 'pop', year: '2023' }, [0.9, 0.1]);
      store.upsert('s3', { name: 'C', genre: 'rock', year: '2024' }, [0.8, 0.2]);

      const results = store.search([1, 0], 10, { genre: 'pop', year: '2024' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('s1');
    });
  });

  // --------------------------------------------------------------------------
  describe('save() and load()', () => {
    it('persists items to disk and reloads them', () => {
      store.dbPath = TMP_DB_PATH;
      store.upsert('s1', { name: 'Saved Song' }, [0.1, 0.2, 0.3]);
      store.save();

      expect(fs.existsSync(TMP_DB_PATH)).toBe(true);

      // Create a "new" store instance via reset
      vi.resetModules();
      vi.doMock('../config', () => ({ vectorDbPath: TMP_DB_PATH }));
      vi.doMock('../utils/logger', () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      }));
      const store2 = require('../services/vectorStore');

      store2.load();
      expect(store2.size()).toBe(1);
      expect(store2.items[0].metadata.name).toBe('Saved Song');
      expect(store2.items[0].embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('creates directory if it does not exist', () => {
      const deepPath = path.join(TMP_DIR, 'nested', 'deep', 'db.json');
      store.dbPath = deepPath;
      store.upsert('s1', { name: 'Test' }, [1]);
      store.save();

      expect(fs.existsSync(deepPath)).toBe(true);
    });

    it('starts fresh when file does not exist', () => {
      store.dbPath = path.join(TMP_DIR, 'nonexistent.json');
      store.load();

      expect(store.size()).toBe(0);
      expect(store._loaded).toBe(true);
    });

    it('handles corrupted JSON gracefully', () => {
      if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
      fs.writeFileSync(TMP_DB_PATH, 'not valid json{{{', 'utf-8');

      store.dbPath = TMP_DB_PATH;
      store._loaded = false;
      store.load();

      expect(store.size()).toBe(0);
      expect(store._loaded).toBe(true);
    });

    it('includes metadata header in saved file', () => {
      store.dbPath = TMP_DB_PATH;
      store.upsert('s1', { name: 'Test' }, [0.5, 0.5]);
      store.save();

      const raw = JSON.parse(fs.readFileSync(TMP_DB_PATH, 'utf-8'));
      expect(raw.version).toBe(1);
      expect(raw.dimensions).toBe(2);
      expect(raw.itemCount).toBe(1);
      expect(raw.updatedAt).toBeDefined();
    });

    it('load() is idempotent (only loads once)', () => {
      store.dbPath = TMP_DB_PATH;
      store.upsert('s1', { name: 'Original' }, [1]);
      store.save();

      // Reset loaded flag and add a new item to in-memory store
      store.items = [];
      store._loaded = false;
      store.load();
      expect(store.size()).toBe(1);

      // Modify in-memory
      store.upsert('s2', { name: 'Added' }, [2]);
      store.save();

      // Second load should be no-op
      store.load();
      expect(store.size()).toBe(2); // still the in-memory version
    });
  });

  // --------------------------------------------------------------------------
  describe('listMetadata()', () => {
    it('returns metadata without embeddings', () => {
      store.upsert('s1', { name: 'Song A', artist: 'Artist A' }, [1, 0, 0]);
      store.upsert('s2', { name: 'Song B', artist: 'Artist B' }, [0, 1, 0]);

      const meta = store.listMetadata();

      expect(meta).toHaveLength(2);
      expect(meta[0]).toEqual({ id: 's1', name: 'Song A', artist: 'Artist A' });
      expect(meta[0].embedding).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  describe('clear()', () => {
    it('removes all items from the store', () => {
      store.upsert('s1', { name: 'A' }, [1]);
      store.upsert('s2', { name: 'B' }, [2]);

      store.clear();
      expect(store.size()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Cosine similarity (tested through VectorStore.search)
// ---------------------------------------------------------------------------

describe('cosineSimilarity (via VectorStore.search)', () => {
  let store;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../config', () => ({ vectorDbPath: TMP_DB_PATH }));
    vi.doMock('../utils/logger', () => ({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    }));
    store = require('../services/vectorStore');
    store.items = [];
    store._loaded = false;
  });

  afterEach(() => {
    cleanupTmp();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('identical vectors give score 1.0', () => {
    store.upsert('a', {}, [1, 2, 3]);
    const results = store.search([1, 2, 3], 1);
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });

  it('opposite vectors give score -1.0', () => {
    store.upsert('a', {}, [1, 0, 0]);
    const results = store.search([-1, 0, 0], 1);
    expect(results[0].score).toBeCloseTo(-1.0, 5);
  });

  it('orthogonal vectors give score 0.0', () => {
    store.upsert('a', {}, [1, 0]);
    const results = store.search([0, 1], 1);
    expect(results[0].score).toBeCloseTo(0.0, 5);
  });

  it('zero vector gives score 0.0', () => {
    store.upsert('a', {}, [0, 0, 0]);
    const results = store.search([1, 2, 3], 1);
    expect(results[0].score).toBeCloseTo(0.0, 5);
  });

  it('mismatched dimensions give score 0.0', () => {
    store.upsert('a', {}, [1, 2, 3]);
    const results = store.search([1, 2], 1);
    expect(results[0].score).toBe(0);
  });

  it('scaled vectors still give score 1.0 (scale invariant)', () => {
    store.upsert('a', {}, [1, 2, 3]);
    const results = store.search([10, 20, 30], 1);
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });
});
