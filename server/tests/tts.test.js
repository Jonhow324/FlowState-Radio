// tts.test.js — Unit tests for TTS service (Minimax)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------- mocks for relative-path imports (work with vi.mock) ----------
vi.mock('../config', () => ({
  default: {
    minimaxApiKey: '',
    minimaxGroupId: '',
    minimaxVoiceIdZh: '',
    minimaxVoiceIdEn: '',
    ttsCacheDir: '', // overridden per-test in beforeEach
  },
}));

vi.mock('../utils/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------- import module under test ----------
const tts = (await import('../tts')).default;

// ---------- helpers ----------

/** Compute the same MD5 hash the TTS service uses internally. */
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Mock the internal callMinimaxTTS method on the TTS singleton.
 * This avoids real HTTP calls without needing to mock the axios module
 * (which vitest cannot intercept for bare-specifier CJS imports).
 */
function mockApiSuccess(audioContent = 'fakeaudio') {
  return vi.spyOn(tts, 'callMinimaxTTS').mockResolvedValue(
    Buffer.from(audioContent),
  );
}

function mockApiFailure(errorMsg = 'Network error') {
  return vi.spyOn(tts, 'callMinimaxTTS').mockRejectedValue(
    new Error(errorMsg),
  );
}

// ---------- test suite ----------

describe('TTSService', () => {
  let testCacheDir;

  beforeEach(() => {
    // Create a real temp directory so fs operations (existsSync, writeFileSync)
    // work without filesystem mocking.
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'));
    tts.cacheDir = testCacheDir;

    // Reset singleton state
    tts.apiKey = '';
    tts.groupId = '';
    tts.voiceIdZh = 'male-qn-qingse';
    tts.voiceIdEn = 'male-qn-jingying';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(testCacheDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ------------------------------------------------------------------
  // 1. setVoice / getVoice
  // ------------------------------------------------------------------
  describe('setVoice / getVoice', () => {
    it('returns default zh voice', () => {
      expect(tts.getVoice('zh')).toBe('male-qn-qingse');
    });

    it('returns default en voice', () => {
      expect(tts.getVoice('en')).toBe('male-qn-jingying');
    });

    it('sets and gets a custom voice for zh', () => {
      tts.setVoice('female-shaonv', 'zh');
      expect(tts.getVoice('zh')).toBe('female-shaonv');
    });

    it('sets and gets a custom voice for en', () => {
      tts.setVoice('female-tianmei', 'en');
      expect(tts.getVoice('en')).toBe('female-tianmei');
    });

    it('keeps zh and en voices independent of each other', () => {
      tts.setVoice('voice-zh', 'zh');
      tts.setVoice('voice-en', 'en');
      expect(tts.getVoice('zh')).toBe('voice-zh');
      expect(tts.getVoice('en')).toBe('voice-en');
    });

    it('defaults lang parameter to zh when not specified', () => {
      tts.setVoice('default-voice');
      expect(tts.getVoice()).toBe('default-voice');
      expect(tts.getVoice('zh')).toBe('default-voice');
      // en voice must remain unchanged
      expect(tts.getVoice('en')).toBe('male-qn-jingying');
    });

    it('overwrites a previously set voice', () => {
      tts.setVoice('first', 'zh');
      tts.setVoice('second', 'zh');
      expect(tts.getVoice('zh')).toBe('second');
    });
  });

  // ------------------------------------------------------------------
  // 2. Cache key generation (MD5 of text + lang + voiceId)
  // ------------------------------------------------------------------
  describe('cache key generation', () => {
    it('produces an MD5 hash from text + lang + voiceId', async () => {
      const apiSpy = mockApiSuccess();
      tts.setVoice('voice-abc', 'zh');
      tts.apiKey = 'test-key';

      const text = 'hello world';
      const lang = 'zh';
      const expectedHash = md5(text + lang + 'voice-abc');

      const result = await tts.synthesize(text, lang);

      // API was called
      expect(apiSpy).toHaveBeenCalledWith(text, lang);

      // Cache file was created with the correct hash
      const files = fs.readdirSync(testCacheDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(`${expectedHash}.mp3`);
    });

    it('produces a different hash when the voice changes', async () => {
      mockApiSuccess();
      tts.apiKey = 'test-key';

      const text = 'same text';
      const lang = 'zh';

      tts.setVoice('voice-A', 'zh');
      await tts.synthesize(text, lang);

      tts.setVoice('voice-B', 'zh');
      await tts.synthesize(text, lang);

      const files = fs.readdirSync(testCacheDir);
      expect(files).toHaveLength(2);
      expect(files[0]).not.toBe(files[1]);
    });

    it('produces a different hash when the language changes', async () => {
      mockApiSuccess();
      tts.apiKey = 'test-key';
      tts.setVoice('voice-zh', 'zh');
      tts.setVoice('voice-en', 'en');

      const text = 'hello';

      await tts.synthesize(text, 'zh');
      await tts.synthesize(text, 'en');

      const files = fs.readdirSync(testCacheDir);
      expect(files).toHaveLength(2);
      expect(files[0]).not.toBe(files[1]);
    });

    it('returns a URL path formatted as /tts/<hash>.mp3', async () => {
      mockApiSuccess();
      tts.apiKey = 'test-key';
      tts.setVoice('v1', 'zh');

      const result = await tts.synthesize('some text', 'zh');
      const expectedHash = md5('some text' + 'zh' + 'v1');

      expect(result.url).toBe(`/tts/${expectedHash}.mp3`);
      expect(result.cached).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 3. synthesize — returns null URL when TTS is not configured
  // ------------------------------------------------------------------
  describe('synthesize when not configured', () => {
    it('returns { url: null, cached: false } when API key is empty', async () => {
      const apiSpy = mockApiSuccess();
      tts.apiKey = '';

      const result = await tts.synthesize('hello', 'zh');

      expect(result).toEqual({ url: null, cached: false });
      // API method must NOT be called when service is unavailable
      expect(apiSpy).not.toHaveBeenCalled();
    });

    it('returns { url: null, cached: false } when API key is "placeholder"', async () => {
      const apiSpy = mockApiSuccess();
      tts.apiKey = 'placeholder';

      const result = await tts.synthesize('hello', 'zh');

      expect(result).toEqual({ url: null, cached: false });
      expect(apiSpy).not.toHaveBeenCalled();
    });

    it('returns { url: null, cached: false } for empty text', async () => {
      const result = await tts.synthesize('', 'zh');
      expect(result).toEqual({ url: null, cached: false });
    });

    it('returns { url: null, cached: false } for whitespace-only text', async () => {
      const result = await tts.synthesize('   ', 'zh');
      expect(result).toEqual({ url: null, cached: false });
    });

    it('returns { url: null, cached: false } for null/undefined text', async () => {
      expect(await tts.synthesize(null, 'zh')).toEqual({ url: null, cached: false });
      expect(await tts.synthesize(undefined, 'zh')).toEqual({ url: null, cached: false });
    });
  });

  // ------------------------------------------------------------------
  // 4. synthesize — returns cached result when file exists
  // ------------------------------------------------------------------
  describe('synthesize with cache hit', () => {
    it('returns cached URL and cached:true when the mp3 already exists', async () => {
      const apiSpy = mockApiSuccess();
      tts.setVoice('v1', 'zh');

      const text = 'cached phrase';
      const lang = 'zh';
      const expectedHash = md5(text + lang + 'v1');

      // Pre-create the cache file on the real filesystem
      fs.writeFileSync(path.join(testCacheDir, `${expectedHash}.mp3`), 'fake');

      const result = await tts.synthesize(text, lang);

      expect(result.url).toBe(`/tts/${expectedHash}.mp3`);
      expect(result.cached).toBe(true);
      // API must NOT have been called
      expect(apiSpy).not.toHaveBeenCalled();
    });

    it('returns cached result even when TTS is not configured (cache takes priority)', async () => {
      tts.apiKey = ''; // not available
      tts.setVoice('v1', 'zh');

      const text = 'anything';
      const lang = 'zh';
      const hash = md5(text + lang + 'v1');

      // Pre-create the cache file
      fs.writeFileSync(path.join(testCacheDir, `${hash}.mp3`), 'fake');

      const result = await tts.synthesize(text, lang);

      // Cache is checked BEFORE isAvailable(), so we get the cached result
      expect(result.cached).toBe(true);
      expect(result.url).toMatch(/^\/tts\/[a-f0-9]+\.mp3$/);
    });

    it('calls the API only on cache miss when service is available', async () => {
      const apiSpy = mockApiSuccess();
      tts.apiKey = 'real-key';
      tts.setVoice('v1', 'zh');

      const result = await tts.synthesize('new phrase', 'zh');

      expect(apiSpy).toHaveBeenCalledTimes(1);
      expect(result.cached).toBe(false);
      expect(result.url).toMatch(/^\/tts\/[a-f0-9]+\.mp3$/);

      // Verify the cache file was written
      const files = fs.readdirSync(testCacheDir);
      expect(files).toHaveLength(1);
    });

    it('returns { url: null, cached: false } when the API call fails', async () => {
      mockApiFailure('Network error');
      tts.apiKey = 'real-key';

      const result = await tts.synthesize('fail text', 'zh');

      expect(result).toEqual({ url: null, cached: false });
    });
  });

  // ------------------------------------------------------------------
  // 5. isAvailable() — checks if API key is configured
  // ------------------------------------------------------------------
  describe('isAvailable()', () => {
    it('returns false when apiKey is empty string', () => {
      tts.apiKey = '';
      expect(tts.isAvailable()).toBe(false);
    });

    it('returns false when apiKey is the literal "placeholder"', () => {
      tts.apiKey = 'placeholder';
      expect(tts.isAvailable()).toBe(false);
    });

    it('returns true when apiKey is a valid non-placeholder string', () => {
      tts.apiKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      expect(tts.isAvailable()).toBe(true);
    });

    it('returns false when apiKey is undefined', () => {
      tts.apiKey = undefined;
      expect(tts.isAvailable()).toBe(false);
    });

    it('returns false when apiKey is null', () => {
      tts.apiKey = null;
      expect(tts.isAvailable()).toBe(false);
    });

    it('reflects runtime changes to the apiKey property', () => {
      tts.apiKey = '';
      expect(tts.isAvailable()).toBe(false);

      tts.apiKey = 'new-key';
      expect(tts.isAvailable()).toBe(true);

      tts.apiKey = '';
      expect(tts.isAvailable()).toBe(false);

      tts.apiKey = 'placeholder';
      expect(tts.isAvailable()).toBe(false);
    });
  });
});
