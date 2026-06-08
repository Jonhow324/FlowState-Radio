// services/vectorStore.js — Lightweight file-based vector database
// Stores song embeddings + metadata, supports cosine similarity search
// For ~500 songs with 1024d vectors, brute-force cosine similarity is <1ms

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

class VectorStore {
  constructor() {
    this.dbPath = config.vectorDbPath;
    this.items = [];       // [{ id, metadata, embedding }]
    this._loaded = false;
  }

  /**
   * Load the vector database from disk
   */
  load() {
    if (this._loaded) return;

    try {
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf-8');
        const data = JSON.parse(raw);
        this.items = data.items || [];
        this._loaded = true;
        logger.info('VECTOR', `Loaded ${this.items.length} items from ${path.basename(this.dbPath)}`);
      } else {
        this.items = [];
        this._loaded = true;
        logger.info('VECTOR', 'No existing vector DB, starting fresh');
      }
    } catch (error) {
      logger.error('VECTOR', `Failed to load vector DB: ${error.message}`);
      this.items = [];
      this._loaded = true;
    }
  }

  /**
   * Save the vector database to disk
   */
  save() {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        version: 1,
        dimensions: this.items.length > 0 ? this.items[0].embedding.length : 0,
        itemCount: this.items.length,
        updatedAt: new Date().toISOString(),
        items: this.items,
      };
      fs.writeFileSync(this.dbPath, JSON.stringify(data), 'utf-8');
      logger.info('VECTOR', `Saved ${this.items.length} items to ${path.basename(this.dbPath)}`);
    } catch (error) {
      logger.error('VECTOR', `Failed to save vector DB: ${error.message}`);
    }
  }

  /**
   * Add or update an item in the store
   * @param {string} id - Unique identifier (e.g., "song:1")
   * @param {object} metadata - Song metadata (name, artist, tags, etc.)
   * @param {number[]} embedding - Embedding vector
   */
  upsert(id, metadata, embedding) {
    const existing = this.items.findIndex((item) => item.id === id);
    const item = { id, metadata, embedding };

    if (existing >= 0) {
      this.items[existing] = item;
    } else {
      this.items.push(item);
    }
  }

  /**
   * Add multiple items at once (batch upsert)
   * @param {Array<{id, metadata, embedding}>} items
   */
  upsertBatch(items) {
    for (const item of items) {
      this.upsert(item.id, item.metadata, item.embedding);
    }
  }

  /**
   * Remove an item by ID
   * @param {string} id
   */
  remove(id) {
    this.items = this.items.filter((item) => item.id !== id);
  }

  /**
   * Search for the most similar items by cosine similarity
   * @param {number[]} queryVector - Query embedding vector
   * @param {number} topK - Number of results to return
   * @param {object} [filters] - Optional metadata filters { key: value }
   * @returns {Array<{id, metadata, score}>} - Sorted by similarity (highest first)
   */
  search(queryVector, topK = 20, filters = null) {
    if (this.items.length === 0) return [];

    let candidates = this.items;

    // Apply metadata filters if provided
    if (filters) {
      candidates = candidates.filter((item) => {
        for (const [key, value] of Object.entries(filters)) {
          if (item.metadata[key] !== value) return false;
        }
        return true;
      });
    }

    // Compute cosine similarity for all candidates
    const scored = candidates.map((item) => ({
      id: item.id,
      metadata: item.metadata,
      score: cosineSimilarity(queryVector, item.embedding),
    }));

    // Sort by score descending and take top K
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Get total item count
   */
  size() {
    return this.items.length;
  }

  /**
   * Get all metadata (without embeddings) for inspection
   */
  listMetadata() {
    return this.items.map((item) => ({ id: item.id, ...item.metadata }));
  }

  /**
   * Clear all items
   */
  clear() {
    this.items = [];
    logger.info('VECTOR', 'Vector store cleared');
  }
}

/**
 * Compute cosine similarity between two vectors
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} - Similarity score (-1 to 1, higher is more similar)
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// Singleton
const vectorStore = new VectorStore();

module.exports = vectorStore;
