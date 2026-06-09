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

const DELAY_MS = 1500; // Rate limit between NCM calls

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

  // Check NCM health
  if (!ncm.isHealthy()) {
    logger.error('RESOLVE', 'NCM service is unhealthy. Check NCM_API_URL and NCM_COOKIE in .env');
    process.exit(1);
  }

  let resolved = 0;
  let failed = 0;
  let skipped = all.length - needsResolve.length;

  for (let i = 0; i < needsResolve.length; i++) {
    const item = needsResolve[i];
    const { name, artist } = item.metadata;
    const progress = `[${i + 1}/${needsResolve.length}]`;

    try {
      // Try name + artist first
      const keyword = `${name} ${artist}`.trim();
      let results = await ncm.search(keyword, 3);

      // Fuzzy match: find result where name or artist partially matches
      let match = null;
      if (results.length > 0) {
        const nameNorm = name.toLowerCase().replace(/[\s()（）\[\]【】]/g, '');
        match = results.find((r) => {
          const rName = r.trackName.toLowerCase().replace(/[\s()（）\[\]【】]/g, '');
          return rName.includes(nameNorm) || nameNorm.includes(rName);
        }) || results[0]; // fallback to first result
      }

      if (!match) {
        // Retry with just song name
        results = await ncm.search(name, 3);
        if (results.length > 0) {
          match = results[0];
        }
      }

      if (match) {
        item.metadata.ncmTrackId = match.trackId;
        item.metadata.ncmAlbumArt = match.albumArt || null;
        resolved++;
        logger.info('RESOLVE', `${progress} ✓ ${name} → NCM ${match.trackId} (${match.trackName})`);
      } else {
        failed++;
        logger.warn('RESOLVE', `${progress} ✗ ${name} — not found on NCM`);
      }
    } catch (err) {
      // On 405 rate limit, wait and retry once
      if (err.response && err.response.status === 405) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const retryResults = await ncm.search(`${name} ${artist}`.trim(), 3);
          if (retryResults.length > 0) {
            item.metadata.ncmTrackId = retryResults[0].trackId;
            item.metadata.ncmAlbumArt = retryResults[0].albumArt || null;
            resolved++;
            logger.info('RESOLVE', `${progress} ✓ ${name} → NCM ${retryResults[0].trackId} (retry)`);
            // Skip the failed++ below
            if (i < needsResolve.length - 1) {
              await new Promise((r) => setTimeout(r, DELAY_MS));
            }
            continue;
          }
        } catch (_) {}
      }
      failed++;
      logger.warn('RESOLVE', `${progress} ✗ ${name} — error: ${err.message}`);
    }

    // Rate limit — longer pause after 405 errors
    if (i < needsResolve.length - 1) {
      const pause = (failed > 0 && failed % 3 === 0) ? DELAY_MS * 3 : DELAY_MS;
      await new Promise((r) => setTimeout(r, pause));
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
