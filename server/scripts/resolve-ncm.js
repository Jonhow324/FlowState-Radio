// scripts/resolve-ncm.js — Resolve NCM track IDs for existing vector DB entries
// Usage: node scripts/resolve-ncm.js [--overwrite]
//
// Loads vector-db.json, searches NCM for each song, stores ncmTrackId.
// Skips songs that already have ncmTrackId unless --overwrite is passed.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const vectorStore = require('../services/vectorStore');
const ncm = require('../services/ncm');
const logger = require('../utils/logger');

const DELAY_MS = 8000; // Base delay between NCM calls (enhanced API needs more breathing room)
const MAX_RETRIES = 3;  // Max retries on 405 rate limit
const COOLDOWN_MS = 60000; // Cooldown after 3 consecutive 405s

/**
 * Attempt NCM search with exponential-backoff retries on 405 rate limits.
 * Returns { match, retried } where match may be null if not found.
 * Throws if all retries are exhausted (non-405 errors or persistent 405).
 */
async function searchWithRetry(name, artist, retries = MAX_RETRIES) {
  const keyword = `${name} ${artist}`.trim();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let results = await ncm.search(keyword, 3);

      // Fuzzy match
      let match = null;
      if (results.length > 0) {
        const nameNorm = name.toLowerCase().replace(/[\s()（）\[\]【】]/g, '');
        match = results.find((r) => {
          const rName = r.trackName.toLowerCase().replace(/[\s()（）\[\]【】]/g, '');
          return rName.includes(nameNorm) || nameNorm.includes(rName);
        }) || results[0];
      }

      // If no match with name+artist, try just name
      if (!match && attempt === 0) {
        try {
          const nameResults = await ncm.search(name, 3);
          if (nameResults.length > 0) {
            match = nameResults[0];
          }
        } catch (_) { /* fall through */ }
      }

      return { match, retried: attempt > 0 };

    } catch (err) {
      if (err.response?.status === 405 && attempt < retries) {
        // Exponential backoff: 10s, 20s, 40s
        const wait = 10000 * Math.pow(2, attempt);
        logger.warn('RESOLVE', `405 rate limit on "${name}", retry ${attempt + 1}/${retries} after ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err; // Non-405 error or exhausted retries
    }
  }
}

async function main() {
  const overwrite = process.argv.includes('--overwrite');

  // Load existing vector DB
  vectorStore.load();
  const items = vectorStore.listMetadata();
  logger.info('RESOLVE', `Loaded ${items.length} songs from vector DB`);

  // Filter songs that need resolution
  const all = vectorStore.items;
  const needsResolve = all.filter((item) => overwrite || !item.metadata.ncmTrackId);
  logger.info('RESOLVE', `${needsResolve.length} songs need NCM resolution${overwrite ? ' (overwrite mode)' : ''}`);

  if (needsResolve.length === 0) {
    logger.info('RESOLVE', 'All songs already have NCM track IDs. Use --overwrite to re-resolve.');
    return;
  }

  let resolved = 0;
  let failed = 0;
  let skipped = all.length - needsResolve.length;
  let consecutive405 = 0;

  for (let i = 0; i < needsResolve.length; i++) {
    const item = needsResolve[i];
    const { name, artist } = item.metadata;
    const progress = `[${i + 1}/${needsResolve.length}]`;

    try {
      const { match, retried } = await searchWithRetry(name, artist);

      if (match) {
        item.metadata.ncmTrackId = match.trackId;
        item.metadata.ncmAlbumArt = match.albumArt || null;
        resolved++;
        consecutive405 = 0; // Reset on success
        logger.info('RESOLVE', `${progress} ✓ ${name} → NCM ${match.trackId} (${match.trackName})${retried ? ' [retried]' : ''}`);
      } else {
        failed++;
        logger.warn('RESOLVE', `${progress} ✗ ${name} — not found on NCM`);
      }
    } catch (err) {
      failed++;
      consecutive405++;
      logger.warn('RESOLVE', `${progress} ✗ ${name} — error: ${err.message}`);

      // Escalating cooldown on consecutive 405s
      if (consecutive405 >= 3) {
        logger.warn('RESOLVE', `${consecutive405} consecutive 405s — cooling down ${COOLDOWN_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));
        consecutive405 = 0;
      }
    }

    // Save progress every 10 songs (so we don't lose work on crash)
    if ((i + 1) % 10 === 0) {
      vectorStore.save();
      logger.info('RESOLVE', `Progress saved: ${i + 1}/${needsResolve.length} (✓${resolved} ✗${failed})`);
    }

    // Inter-request delay
    if (i < needsResolve.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  // Save updated vector DB
  vectorStore.save();

  // Summary
  logger.info('RESOLVE', '═══════════════════════════════');
  logger.info('RESOLVE', `Total: ${all.length} songs`);
  logger.info('RESOLVE', `Resolved: ${resolved}`);
  logger.info('RESOLVE', `Failed: ${failed}`);
  logger.info('RESOLVE', `Skipped (already resolved): ${skipped}`);
  logger.info('RESOLVE', `Match rate: ${((resolved / needsResolve.length) * 100).toFixed(1)}%`);
}

main().catch((err) => {
  console.error('Resolution failed:', err.message);
  process.exit(1);
});
