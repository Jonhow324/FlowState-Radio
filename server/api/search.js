// api/search.js — GET /api/search
// Search songs via NCM API

const express = require('express');
const router = express.Router();
const ncm = require('../services/ncm');
const logger = require('../utils/logger');

/**
 * GET /api/search?keyword=xxx&limit=10
 */
router.get('/', async (req, res) => {
  const keyword = req.query.keyword || req.query.keywords || '';
  const limit = parseInt(req.query.limit || '10', 10);

  if (!keyword.trim()) {
    return res.status(400).json({ error: 'keyword is required' });
  }

  try {
    const results = await ncm.search(keyword, limit);
    logger.info('SEARCH', `"${keyword}" → ${results.length} results`);
    res.json({ keyword, results, total: results.length });
  } catch (error) {
    logger.error('SEARCH', `Search failed: ${error.message}`);
    res.status(502).json({ error: 'NCM API search failed', detail: error.message });
  }
});

module.exports = router;
