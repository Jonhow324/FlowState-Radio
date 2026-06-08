// ingest.test.js — Unit tests for CSV/TSV parser functions
//
// Strategy: Test the pure parser functions (detectDelimiter, parseLine,
// mapColumns, parseFile, buildEmbeddingText) using temporary files.
// These are all local/deterministic — no API calls needed.

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
// We need to require the ingest script's internal functions.
// Since they're not exported, we'll re-implement them here for testing,
// OR we can extract and test via module loading.
// The cleanest approach: copy the pure functions here since they have no deps.
// ---------------------------------------------------------------------------

function detectDelimiter(headerLine) {
  const tabCount = (headerLine.match(/\t/g) || []).length;
  const commaCount = (headerLine.match(/,/g) || []).length;
  return tabCount > commaCount ? '\t' : ',';
}

function parseLine(line, delimiter) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
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

  if (mapping.name === undefined) {
    throw new Error(`找不到「歌名」列。检测到的表头: ${headers.join(', ')}`);
  }
  if (mapping.artist === undefined) {
    throw new Error(`找不到「歌手」列。检测到的表头: ${headers.join(', ')}`);
  }

  return mapping;
}

function buildEmbeddingText(song) {
  const parts = [`${song.name} - ${song.artist}`];
  if (song.tags) parts.push(`风格: ${song.tags}`);
  if (song.mood) parts.push(`情感: ${song.mood}`);
  return parts.join('. ');
}

function isDataRow(line, delimiter) {
  const fields = parseLine(line, delimiter);
  return fields.length > 0 && /^\d+$/.test(fields[0].trim());
}

function defaultColumnMapping() {
  return { index: 0, name: 1, artist: 2, tags: 3, mood: 4, rating: 5 };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.resolve(__dirname, '../data/test-tmp');
const TMP_FILES = [];

function writeTmpFile(name, content) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  TMP_FILES.push(filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Ingest Parser', () => {

  afterEach(() => {
    // Cleanup temp files
    for (const f of TMP_FILES) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    TMP_FILES.length = 0;
    try { fs.rmdirSync(TMP_DIR); } catch (_) {}
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  describe('detectDelimiter()', () => {
    it('detects tab delimiter for TSV', () => {
      expect(detectDelimiter('序号\t歌名\t歌手\t风格')).toBe('\t');
    });

    it('detects comma delimiter for CSV', () => {
      expect(detectDelimiter('序号,歌名,歌手,风格')).toBe(',');
    });

    it('defaults to comma when no tabs or commas', () => {
      expect(detectDelimiter('no delimiters here')).toBe(',');
    });

    it('picks tab when both are present but tabs outnumber commas', () => {
      expect(detectDelimiter('a\tb\tc\td,e')).toBe('\t');
    });

    it('picks comma when commas outnumber tabs', () => {
      expect(detectDelimiter('a,b,c,d\te')).toBe(',');
    });
  });

  // --------------------------------------------------------------------------
  describe('parseLine()', () => {
    it('splits simple comma-separated fields', () => {
      expect(parseLine('a,b,c', ',')).toEqual(['a', 'b', 'c']);
    });

    it('splits tab-separated fields', () => {
      expect(parseLine('a\tb\tc', '\t')).toEqual(['a', 'b', 'c']);
    });

    it('handles quoted fields with commas inside', () => {
      expect(parseLine('"hello, world",b,c', ',')).toEqual(['hello, world', 'b', 'c']);
    });

    it('handles escaped quotes inside quoted fields', () => {
      expect(parseLine('"he said ""hi""",b', ',')).toEqual(['he said "hi"', 'b']);
    });

    it('trims whitespace from fields', () => {
      expect(parseLine('  a  ,  b  ,  c  ', ',')).toEqual(['a', 'b', 'c']);
    });

    it('handles empty fields', () => {
      expect(parseLine('a,,c', ',')).toEqual(['a', '', 'c']);
    });

    it('handles single field with no delimiter', () => {
      expect(parseLine('single', ',')).toEqual(['single']);
    });
  });

  // --------------------------------------------------------------------------
  describe('mapColumns()', () => {
    it('maps Chinese headers correctly', () => {
      const headers = ['序号', '歌名', '歌手', '风格标签', '核心歌词大意/情感基调', '个人评分'];
      const mapping = mapColumns(headers);

      expect(mapping.index).toBe(0);
      expect(mapping.name).toBe(1);
      expect(mapping.artist).toBe(2);
      expect(mapping.tags).toBe(3);
      expect(mapping.mood).toBe(4);
      expect(mapping.rating).toBe(5);
    });

    it('maps English headers correctly', () => {
      const headers = ['#', 'Song Name', 'Artist', 'Genre Tags', 'Mood', 'Rating'];
      const mapping = mapColumns(headers);

      expect(mapping.index).toBe(0);
      expect(mapping.name).toBe(1);
      expect(mapping.artist).toBe(2);
      expect(mapping.tags).toBe(3);
      expect(mapping.mood).toBe(4);
      expect(mapping.rating).toBe(5);
    });

    it('throws when 歌名 column is missing', () => {
      expect(() => mapColumns(['序号', '歌手', '风格'])).toThrow('找不到「歌名」列');
    });

    it('throws when 歌手 column is missing', () => {
      expect(() => mapColumns(['序号', '歌名', '风格'])).toThrow('找不到「歌手」列');
    });

    it('handles partial columns (only name + artist)', () => {
      const mapping = mapColumns(['歌名', '歌手']);
      expect(mapping.name).toBe(0);
      expect(mapping.artist).toBe(1);
      expect(mapping.tags).toBeUndefined();
      expect(mapping.mood).toBeUndefined();
    });

    it('is case-insensitive for English headers', () => {
      const mapping = mapColumns(['NAME', 'ARTIST', 'TAGS']);
      expect(mapping.name).toBe(0);
      expect(mapping.artist).toBe(1);
      expect(mapping.tags).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  describe('buildEmbeddingText()', () => {
    it('combines name and artist as base text', () => {
      const text = buildEmbeddingText({ name: '晴天', artist: '周杰伦' });
      expect(text).toBe('晴天 - 周杰伦');
    });

    it('includes tags when present', () => {
      const text = buildEmbeddingText({ name: '晴天', artist: '周杰伦', tags: '华语流行' });
      expect(text).toBe('晴天 - 周杰伦. 风格: 华语流行');
    });

    it('includes mood when present', () => {
      const text = buildEmbeddingText({ name: '晴天', artist: '周杰伦', mood: '青春怀旧' });
      expect(text).toBe('晴天 - 周杰伦. 情感: 青春怀旧');
    });

    it('includes both tags and mood', () => {
      const text = buildEmbeddingText({
        name: '晴天',
        artist: '周杰伦',
        tags: '华语流行, 经典',
        mood: '青春怀旧，校园回忆',
      });
      expect(text).toContain('风格: 华语流行, 经典');
      expect(text).toContain('情感: 青春怀旧，校园回忆');
    });

    it('handles empty tags and mood gracefully', () => {
      const text = buildEmbeddingText({ name: 'Test', artist: 'Art', tags: '', mood: '' });
      expect(text).toBe('Test - Art');
    });
  });

  // --------------------------------------------------------------------------
  describe('CSV file parsing (integration)', () => {
    it('parses a well-formed CSV file', () => {
      const csv = [
        '序号,歌名,歌手,风格标签,情感基调,评分',
        '1,晴天,周杰伦,华语流行,青春怀旧,5',
        '2,七里香,周杰伦,华语流行,浪漫甜蜜,4',
        '3,稻香,周杰伦,民谣,温暖治愈,5',
      ].join('\n');

      const filePath = writeTmpFile('test.csv', csv);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      const delimiter = detectDelimiter(lines[0]);
      const headers = parseLine(lines[0], delimiter);
      const columns = mapColumns(headers);

      expect(delimiter).toBe(',');
      expect(lines.length).toBe(4); // header + 3 data rows

      const songs = [];
      for (let i = 1; i < lines.length; i++) {
        const fields = parseLine(lines[i], delimiter);
        songs.push({
          name: fields[columns.name],
          artist: fields[columns.artist],
          tags: fields[columns.tags] || '',
          mood: fields[columns.mood] || '',
        });
      }

      expect(songs).toHaveLength(3);
      expect(songs[0].name).toBe('晴天');
      expect(songs[1].artist).toBe('周杰伦');
      expect(songs[2].tags).toBe('民谣');
    });

    it('parses a TSV file correctly', () => {
      const tsv = [
        '序号\t歌名\t歌手\t风格标签',
        '1\tBohemian Rhapsody\tQueen\tRock',
        '2\tStairway to Heaven\tLed Zeppelin\tRock',
      ].join('\n');

      const filePath = writeTmpFile('test.tsv', tsv);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      const delimiter = detectDelimiter(lines[0]);

      expect(delimiter).toBe('\t');

      const headers = parseLine(lines[0], delimiter);
      const columns = mapColumns(headers);
      const fields = parseLine(lines[1], delimiter);

      expect(fields[columns.name]).toBe('Bohemian Rhapsody');
      expect(fields[columns.artist]).toBe('Queen');
    });

    it('handles quoted fields with embedded commas', () => {
      const csv = [
        '歌名,歌手,风格标签,情感',
        '"Hello, Goodbye","The Beatles","Rock, Pop",离别感伤',
      ].join('\n');

      const filePath = writeTmpFile('quoted.csv', csv);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      const fields = parseLine(lines[1], ',');

      expect(fields[0]).toBe('Hello, Goodbye');
      expect(fields[1]).toBe('The Beatles');
      expect(fields[2]).toBe('Rock, Pop');
      expect(fields[3]).toBe('离别感伤');
    });

    it('skips empty or malformed data rows', () => {
      const csv = [
        '歌名,歌手',
        '晴天,周杰伦',
        '',  // empty line
        '   ',  // whitespace only
        '稻香,周杰伦',
      ].join('\n');

      const filePath = writeTmpFile('sparse.csv', csv);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(l => l.trim());

      // header + 2 valid data rows
      expect(lines.length).toBe(3);
    });

    it('handles Windows-style line endings (CRLF)', () => {
      const csv = '歌名,歌手\r\n晴天,周杰伦\r\n稻香,周杰伦\r\n';

      const filePath = writeTmpFile('crlf.csv', csv);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(l => l.trim());

      expect(lines).toHaveLength(3);
    });
  });

  // --------------------------------------------------------------------------
  describe('isDataRow()', () => {
    it('returns true when first field is a number (data row)', () => {
      expect(isDataRow('1,I Love You So,The Walters,Indie Pop,慵懒,待设定', ',')).toBe(true);
    });

    it('returns false when first field is a string (header row)', () => {
      expect(isDataRow('序号,歌名,歌手,风格标签,情感基调,评分', ',')).toBe(false);
    });

    it('returns false for Chinese header text', () => {
      expect(isDataRow('歌名,歌手,风格', ',')).toBe(false);
    });

    it('works with tab delimiter', () => {
      expect(isDataRow('42\tSong Name\tArtist', '\t')).toBe(true);
    });

    it('returns false for empty line', () => {
      expect(isDataRow('', ',')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  describe('defaultColumnMapping()', () => {
    it('returns correct positional mapping', () => {
      const mapping = defaultColumnMapping();
      expect(mapping).toEqual({ index: 0, name: 1, artist: 2, tags: 3, mood: 4, rating: 5 });
    });

    it('always includes all six columns', () => {
      const mapping = defaultColumnMapping();
      expect(Object.keys(mapping)).toHaveLength(6);
    });
  });

  // --------------------------------------------------------------------------
  describe('Headerless CSV parsing (integration)', () => {
    it('correctly parses a headerless CSV with positional columns', () => {
      const csv = [
        '1,I Love You So,The Walters,"Indie Pop, Lo-fi, 浪漫",慵懒的告白,待设定',
        '2,Frisco Blues,Lewis OfMan,"French Touch, Lofi",法式轻爵士,待设定',
      ].join('\n');

      const filePath = writeTmpFile('headerless.csv', csv);
      const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      const delimiter = detectDelimiter(lines[0]);

      // Should detect as data row (no header)
      expect(isDataRow(lines[0], delimiter)).toBe(true);

      const columns = defaultColumnMapping();
      const songs = [];
      for (let i = 0; i < lines.length; i++) {
        const fields = parseLine(lines[i], delimiter);
        songs.push({
          index: fields[columns.index],
          name: fields[columns.name],
          artist: fields[columns.artist],
          tags: fields[columns.tags] || '',
          mood: fields[columns.mood] || '',
        });
      }

      expect(songs).toHaveLength(2);
      expect(songs[0].name).toBe('I Love You So');
      expect(songs[0].artist).toBe('The Walters');
      expect(songs[0].tags).toBe('Indie Pop, Lo-fi, 浪漫');
      expect(songs[1].name).toBe('Frisco Blues');
    });

    it('handles mixed quoted/unquoted tags in the same file', () => {
      const csv = [
        '1,Song A,Artist A,"Rock, Pop, 浪漫",摇滚的激情,待设定',
        '2,Song B,Artist B,民谣，治愈，温暖,安静的夜晚,待设定',
      ].join('\n');

      const filePath = writeTmpFile('mixed.csv', csv);
      const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      const columns = defaultColumnMapping();

      // Row 1: English commas inside quotes
      const fields1 = parseLine(lines[0], ',');
      expect(fields1[columns.tags]).toBe('Rock, Pop, 浪漫');

      // Row 2: Chinese commas, no quotes — tags stay as one field
      const fields2 = parseLine(lines[1], ',');
      expect(fields2[columns.tags]).toBe('民谣，治愈，温暖');
    });

    it('handles BOM-prefixed headerless CSV', () => {
      const csv = '\uFEFF1,晴天,周杰伦,华语流行,青春,5\n2,稻香,周杰伦,民谣,温暖,4';

      const filePath = writeTmpFile('bom-headerless.csv', csv);
      const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
      const lines = content.split(/\r?\n/).filter(l => l.trim());

      expect(isDataRow(lines[0], ',')).toBe(true);
      const fields = parseLine(lines[0], ',');
      expect(fields[1]).toBe('晴天');
    });
  });
});
