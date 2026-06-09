// scripts/ingest-playlist.js — Playlist CSV/TSV ingestion into vector database
// Usage: node scripts/ingest-playlist.js <path-to-csv-or-tsv>
//
// Supports both comma-separated (CSV) and tab-separated (TSV) formats.
// Auto-detects delimiter and whether a header row is present.
// If no header row is found, columns are mapped positionally:
//   序号 | 歌名 | 歌手 | 风格标签 | 核心歌词大意/情感基调 | 个人评分/听歌频率

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Must be required after dotenv setup
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const embedding = require('../services/embedding');
const vectorStore = require('../services/vectorStore');
const ncm = require('../services/ncm');
const logger = require('../utils/logger');

// ── CSV/TSV Parser ──────────────────────────────────────────

/**
 * Detect delimiter (comma or tab) from header line
 */
function detectDelimiter(headerLine) {
  const tabCount = (headerLine.match(/\t/g) || []).length;
  const commaCount = (headerLine.match(/,/g) || []).length;
  return tabCount > commaCount ? '\t' : ',';
}

/**
 * Parse a single CSV/TSV line respecting quoted fields
 */
function parseLine(line, delimiter) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Map header names to canonical column indices
 */
function mapColumns(headers) {
  const mapping = {};
  const patterns = {
    index:    /序号|no|#|index/i,
    name:     /歌名|歌曲|song|name|title/i,
    artist:   /歌手|artist|singer|表演者/i,
    tags:     /风格|标签|tag|genre|style/i,
    mood:     /歌词|情感|基调|mood|emotion|lyrics|描述/i,
    rating:   /评分|频率|rating|score|freq|听歌/i,
  };

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    for (const [key, regex] of Object.entries(patterns)) {
      if (!mapping[key] && regex.test(h)) {
        mapping[key] = i;
        break;
      }
    }
  }

  // Validate required columns
  if (mapping.name === undefined) {
    throw new Error(`找不到「歌名」列。检测到的表头: ${headers.join(', ')}`);
  }
  if (mapping.artist === undefined) {
    throw new Error(`找不到「歌手」列。检测到的表头: ${headers.join(', ')}`);
  }

  return mapping;
}

/**
 * Check if a line looks like a data row (first field is a number = 序号)
 */
function isDataRow(line, delimiter) {
  const fields = parseLine(line, delimiter);
  return fields.length > 0 && /^\d+$/.test(fields[0].trim());
}

/**
 * Default positional column mapping for headerless files
 * Expected order: 序号, 歌名, 歌手, 风格标签, 情感基调, 评分
 */
function defaultColumnMapping() {
  return { index: 0, name: 1, artist: 2, tags: 3, mood: 4, rating: 5 };
}

/**
 * Generate a stable content-hash ID for a song
 * Based on name + artist so the same song always gets the same ID
 * regardless of which CSV it came from or its position
 */
function generateSongId(song) {
  const key = `${song.name.trim()}---${song.artist.trim()}`.toLowerCase();
  const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
  return `song:${hash}`;
}

/**
 * Parse the full CSV/TSV file
 * Supports both header-row and headerless formats.
 */
function parseFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''); // strip BOM
  const lines = content.split(/\r?\n/).filter((l) => l.trim());

  if (lines.length < 1) {
    throw new Error('文件为空');
  }

  const delimiter = detectDelimiter(lines[0]);
  let columns;
  let startLine;

  if (isDataRow(lines[0], delimiter)) {
    // Headerless file — use positional mapping
    columns = defaultColumnMapping();
    startLine = 0;
    logger.info('INGEST', 'No header row detected — using positional column mapping');
  } else {
    // First line is a header
    if (lines.length < 2) {
      throw new Error('文件至少需要包含表头行和一行数据');
    }
    const headers = parseLine(lines[0], delimiter);
    columns = mapColumns(headers);
    startLine = 1;
  }

  logger.info('INGEST', `Detected delimiter: ${delimiter === '\t' ? 'TSV' : 'CSV'}`);
  logger.info('INGEST', `Columns mapped: name=${columns.name}, artist=${columns.artist}, tags=${columns.tags ?? 'N/A'}, mood=${columns.mood ?? 'N/A'}, rating=${columns.rating ?? 'N/A'}`);

  const songs = [];
  for (let i = startLine; i < lines.length; i++) {
    const fields = parseLine(lines[i], delimiter);
    if (fields.length < 2) continue; // skip empty/malformed lines

    const name = fields[columns.name] || '';
    const artist = fields[columns.artist] || '';
    if (!name || !artist) continue;

    songs.push({
      index: columns.index !== undefined ? fields[columns.index] : String(i + 1),
      name: name.replace(/^["']|["']$/g, ''),
      artist: artist.replace(/^["']|["']$/g, ''),
      tags: columns.tags !== undefined ? (fields[columns.tags] || '').replace(/^["']|["']$/g, '') : '',
      mood: columns.mood !== undefined ? (fields[columns.mood] || '').replace(/^["']|["']$/g, '') : '',
      rating: columns.rating !== undefined ? (fields[columns.rating] || '').replace(/^["']|["']$/g, '') : '',
    });
  }

  return songs;
}

// ── Embedding Text Builder ──────────────────────────────────

/**
 * Build a rich text description for embedding a song
 * This text captures all the semantic information for vector similarity
 */
function buildEmbeddingText(song) {
  const parts = [
    `${song.name} - ${song.artist}`,
  ];

  if (song.tags) {
    parts.push(`风格: ${song.tags}`);
  }

  if (song.mood) {
    parts.push(`情感: ${song.mood}`);
  }

  return parts.join('. ');
}

// ── Main Ingestion Flow ─────────────────────────────────────

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.log('Usage: node scripts/ingest-playlist.js <path-to-csv-or-tsv> [options]');
    console.log('');
    console.log('Expected columns:');
    console.log('  序号 | 歌名 | 歌手 | 风格标签 | 核心歌词大意/情感基调 | 个人评分/听歌频率');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run      Parse and show results without calling embedding API');
    console.log('  --resolve      Also resolve NCM track IDs for each song (slower)');
    console.log('  --merge        Append to existing DB, skip songs already present (by content hash)');
    console.log('                 Without --merge, the DB is cleared before import (replace mode)');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  const resolve = process.argv.includes('--resolve');
  const merge = process.argv.includes('--merge');
  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }

  // Parse the file
  logger.info('INGEST', `Parsing: ${resolvedPath}`);
  const songs = parseFile(resolvedPath);
  logger.info('INGEST', `Parsed ${songs.length} songs`);

  if (dryRun) {
    console.log('\n── DRY RUN: Parsed Songs ──\n');
    songs.forEach((s, i) => {
      console.log(`${i + 1}. ${s.name} — ${s.artist}`);
      if (s.tags) console.log(`   Tags: ${s.tags}`);
      if (s.mood) console.log(`   Mood: ${s.mood.slice(0, 60)}...`);
      console.log(`   Embedding text: "${buildEmbeddingText(s).slice(0, 80)}..."`);
      console.log('');
    });
    console.log(`Total: ${songs.length} songs ready for ingestion.`);
    return;
  }

  // Check embedding service
  if (!embedding.isAvailable()) {
    console.error('Error: DASHSCOPE_API_KEY not configured. Set it in .env file.');
    console.error('For dry run (no API calls), use: node scripts/ingest-playlist.js <file> --dry-run');
    process.exit(1);
  }

  // Load existing vector store
  vectorStore.load();

  const mode = merge ? 'MERGE' : 'REPLACE';
  logger.info('INGEST', `Mode: ${mode}`);

  // Assign content-hash IDs to all parsed songs
  const allSongs = songs.map(song => ({ ...song, hashId: generateSongId(song) }));

  let songsToProcess;

  if (merge) {
    // In merge mode, skip songs whose hash ID already exists in the store
    const existingIds = new Set(vectorStore.listMetadata().map(item => item.id));
    songsToProcess = allSongs.filter(song => !existingIds.has(song.hashId));

    const skippedCount = allSongs.length - songsToProcess.length;
    if (skippedCount > 0) {
      logger.info('INGEST', `Merge: skipping ${skippedCount} songs already in DB`);
    }
    logger.info('INGEST', `Merge: ${songsToProcess.length} new songs to ingest (existing DB has ${vectorStore.size()} items)`);

    if (songsToProcess.length === 0) {
      logger.info('INGEST', 'No new songs to add. Done.');
      return;
    }
  } else {
    // Replace mode: clear existing data first
    const prevCount = vectorStore.size();
    if (prevCount > 0) {
      logger.info('INGEST', `Replace mode: clearing ${prevCount} existing items`);
      vectorStore.clear();
    }
    songsToProcess = allSongs;
  }

  // Build embedding texts only for songs we need to process
  const embeddingTexts = songsToProcess.map(s => buildEmbeddingText(s));

  // Batch embed
  logger.info('INGEST', `Embedding ${songsToProcess.length} songs via DashScope ${embedding.model}...`);
  const vectors = await embedding.embedBatch(embeddingTexts);
  logger.info('INGEST', `Got ${vectors.length} embedding vectors (${vectors[0]?.length || 0}d)`);

  // Store in vector database
  const items = songsToProcess.map((song, i) => ({
    id: song.hashId,
    metadata: {
      name: song.name,
      artist: song.artist,
      tags: song.tags,
      mood: song.mood,
      rating: song.rating || null,
      embeddingText: embeddingTexts[i],
    },
    embedding: vectors[i],
  }));

  vectorStore.upsertBatch(items);

  // Optional: resolve NCM track IDs for each song
  if (resolve) {
    logger.info('INGEST', `Resolving NCM track IDs for ${items.length} songs...`);
    let resolved = 0;
    let failed = 0;

    for (const item of items) {
      try {
        const keyword = `${item.metadata.name} ${item.metadata.artist}`;
        const results = await ncm.search(keyword, 1);
        if (results.length > 0) {
          item.metadata.ncmTrackId = results[0].trackId;
          item.metadata.ncmAlbumArt = results[0].albumArt || null;
          resolved++;
          logger.info('INGEST', `  ✓ ${item.metadata.name} → NCM ${results[0].trackId}`);
        } else {
          // Retry with just song name
          const retryResults = await ncm.search(item.metadata.name, 1);
          if (retryResults.length > 0) {
            item.metadata.ncmTrackId = retryResults[0].trackId;
            item.metadata.ncmAlbumArt = retryResults[0].albumArt || null;
            resolved++;
            logger.info('INGEST', `  ✓ ${item.metadata.name} (name-only) → NCM ${retryResults[0].trackId}`);
          } else {
            failed++;
            logger.warn('INGEST', `  ✗ ${item.metadata.name} — not found on NCM`);
          }
        }
      } catch (err) {
        failed++;
        logger.warn('INGEST', `  ✗ ${item.metadata.name} — NCM error: ${err.message}`);
      }

      // Rate limit: small delay between NCM calls
      await new Promise((r) => setTimeout(r, 300));
    }

    logger.info('INGEST', `NCM resolution: ${resolved} resolved, ${failed} not found (of ${items.length})`);
  }

  vectorStore.save();

  // Summary
  logger.info('INGEST', `Ingestion complete: ${items.length} songs added, total DB size: ${vectorStore.size()}`);

  // Quick self-test: search for the first newly added song
  if (vectors.length > 0) {
    logger.info('INGEST', `Self-test: searching for "${songsToProcess[0].name}"...`);
    const results = vectorStore.search(vectors[0], 5);
    console.log('\n── Self-test Results ──');
    results.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.metadata.name} — ${r.metadata.artist} (score: ${r.score.toFixed(4)})`);
    });
  }
}

main().catch((err) => {
  console.error('Ingestion failed:', err.message);
  process.exit(1);
});
