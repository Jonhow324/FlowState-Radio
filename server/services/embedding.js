// services/embedding.js — DashScope text-embedding-v4 adapter
// Uses OpenAI-compatible endpoint for vectorizing text

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const DASHSCOPE_EMBEDDING_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const BATCH_SIZE = 10;         // DashScope limit: 10 texts per request
const MAX_TOKENS_PER_TEXT = 8192;
const DEFAULT_DIMENSIONS = 1024;

class EmbeddingService {
  constructor() {
    this.apiKey = config.dashscopeApiKey || '';
    this.model = config.embeddingModel || 'text-embedding-v4';
    this.dimensions = DEFAULT_DIMENSIONS;
  }

  /**
   * Check if embedding service is configured
   */
  isAvailable() {
    return Boolean(this.apiKey) && this.apiKey !== 'placeholder';
  }

  /**
   * Embed a single text string
   * @param {string} text - Text to embed
   * @returns {Promise<number[]>} - Embedding vector
   */
  async embed(text) {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  /**
   * Embed multiple texts in batches
   * @param {string[]} texts - Array of texts to embed
   * @returns {Promise<number[][]>} - Array of embedding vectors
   */
  async embedBatch(texts) {
    if (!this.isAvailable()) {
      throw new Error('DashScope API key not configured');
    }
    if (!texts || texts.length === 0) return [];

    const allEmbeddings = [];

    // Process in batches of BATCH_SIZE
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchResults = await this._callAPI(batch);
      allEmbeddings.push(...batchResults);

      // Rate limiting: small delay between batches
      if (i + BATCH_SIZE < texts.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    return allEmbeddings;
  }

  /**
   * Call DashScope embedding API
   * @param {string[]} texts - Batch of texts (max 10)
   * @returns {Promise<number[][]>}
   */
  async _callAPI(texts) {
    try {
      const response = await axios.post(
        DASHSCOPE_EMBEDDING_URL,
        {
          model: this.model,
          input: texts,
          dimensions: this.dimensions,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const embeddings = response.data?.data;
      if (!embeddings || !Array.isArray(embeddings)) {
        throw new Error('Invalid response from DashScope embedding API');
      }

      // Sort by index to maintain order
      embeddings.sort((a, b) => a.index - b.index);

      logger.debug('EMBEDDING', `Embedded ${texts.length} texts (${this.dimensions}d)`);
      return embeddings.map((e) => e.embedding);
    } catch (error) {
      if (error.response) {
        const msg = error.response.data?.error?.message || error.response.data?.message || 'Unknown';
        throw new Error(`DashScope embedding API error ${error.response.status}: ${msg}`);
      }
      throw new Error(`Embedding API request failed: ${error.message}`);
    }
  }
}

// Singleton
const embeddingService = new EmbeddingService();

module.exports = embeddingService;
