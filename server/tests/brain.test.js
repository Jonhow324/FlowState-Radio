// brain.test.js — Unit tests for Brain class
//
// Strategy: We instantiate Brain with real adapters (which are lightweight and
// make no network calls on construction), then replace the adapter instances
// with mock objects via direct injection.  This avoids any CJS / ESM interop
// pitfalls with vi.mock and keeps the tests fast and deterministic.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Brain from '../brain';

// Silence console output from the logger during tests
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal context object suitable for Brain.think().
 */
function makeContext() {
  return {
    systemPrompt: 'You are a DJ assistant.',
    userCorpus: 'User likes pop and rock music.',
    environment: 'Sunny afternoon, 25C',
    memory: 'Last played: Bohemian Rhapsody',
    userInput: 'Play something chill',
  };
}

/**
 * Build a mock DeepSeek adapter instance.
 */
function makeDeepSeekMock() {
  return {
    isAvailable: vi.fn(),
    isCircuitOpen: vi.fn(),
    think: vi.fn(),
  };
}

/**
 * Build a mock Rule Engine adapter instance.
 */
function makeRuleEngineMock() {
  return {
    think: vi.fn(),
  };
}

/**
 * Standard rule-engine result returned by the mock.
 */
function makeRuleEngineResult() {
  return {
    say: null,
    play: ['5241534', '1901371647'],
    reason: 'Rule engine: afternoon -> chill style',
    segue: null,
  };
}

/**
 * Standard DeepSeek result returned by the mock.
 */
function makeDeepSeekResult() {
  return {
    say: 'Here are some chill tracks for you!',
    songs: [
      { name: 'Weightless', artist: 'Marconi Union' },
      { name: 'Clair de Lune', artist: 'Debussy' },
    ],
    play: [
      { name: 'Weightless', artist: 'Marconi Union' },
      { name: 'Clair de Lune', artist: 'Debussy' },
    ],
    reason: 'Calming tracks for a sunny afternoon',
    segue: null,
  };
}

/**
 * Create a Brain instance with injected mock adapters.
 * Returns the brain and both mocks for convenient assertion.
 *
 * retrieveCandidates is stubbed to return null by default so that
 * think() tests never touch the real embedding service or vector store.
 * Tests that need RAG candidates can override brain.retrieveCandidates.
 */
function createMockedBrain(config = {}) {
  const brain = new Brain({ deepseekApiKey: 'placeholder', ...config });
  const deepseekMock = makeDeepSeekMock();
  const ruleEngineMock = makeRuleEngineMock();

  // Inject mocks directly into the Brain instance, replacing the real adapters
  brain.deepseek = deepseekMock;
  brain.ruleEngine = ruleEngineMock;

  // Stub out Layer 2 (vector retrieval) to avoid real API calls in tests
  brain.retrieveCandidates = vi.fn().mockResolvedValue(null);

  return { brain, deepseekMock, ruleEngineMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Brain', () => {
  let context;

  beforeEach(() => {
    context = makeContext();
  });

  // --------------------------------------------------------------------------
  describe('think()', () => {
    it('falls back to rule engine when DeepSeek is not configured (apiKey is placeholder)', async () => {
      const { brain, deepseekMock, ruleEngineMock } = createMockedBrain({
        deepseekApiKey: 'placeholder',
      });

      // DeepSeek reports as unavailable (simulating placeholder key)
      deepseekMock.isAvailable.mockResolvedValue(false);
      deepseekMock.isCircuitOpen.mockReturnValue(false);

      // Rule engine returns its standard response
      const ruleEngineResult = makeRuleEngineResult();
      ruleEngineMock.think.mockReturnValue(ruleEngineResult);

      const result = await brain.think(context);

      // DeepSeek should NOT have been attempted
      expect(deepseekMock.think).not.toHaveBeenCalled();

      // Rule engine should have been called with the context
      expect(ruleEngineMock.think).toHaveBeenCalledWith(context);

      // Result should carry the rule-engine source tag
      expect(result.source).toBe('rule-engine');
      expect(result.say).toBeNull();
      expect(result.reason).toContain('Rule engine');
      expect(result.play).toEqual(['5241534', '1901371647']);
    });

    it('falls back to rule engine when DeepSeek throws an error', async () => {
      const { brain, deepseekMock, ruleEngineMock } = createMockedBrain({
        deepseekApiKey: 'sk-test-key-abc123',
      });

      // DeepSeek is available
      deepseekMock.isAvailable.mockResolvedValue(true);
      deepseekMock.isCircuitOpen.mockReturnValue(false);

      // DeepSeek throws during think()
      deepseekMock.think.mockRejectedValue(new Error('API rate limit exceeded'));

      // Rule engine is the safety net
      const ruleEngineResult = makeRuleEngineResult();
      ruleEngineMock.think.mockReturnValue(ruleEngineResult);

      const result = await brain.think(context);

      // DeepSeek should have been attempted first
      expect(deepseekMock.think).toHaveBeenCalledOnce();

      // Rule engine should have been called as fallback
      expect(ruleEngineMock.think).toHaveBeenCalledWith(context);

      // Final result should come from rule engine
      expect(result.source).toBe('rule-engine');
      expect(result.say).toBeNull();
      expect(result.play).toBeDefined();
    });

    it('uses DeepSeek when it is configured and responds successfully', async () => {
      const { brain, deepseekMock, ruleEngineMock } = createMockedBrain({
        deepseekApiKey: 'sk-test-key-abc123',
      });

      // DeepSeek is available and responds successfully
      deepseekMock.isAvailable.mockResolvedValue(true);
      deepseekMock.isCircuitOpen.mockReturnValue(false);

      const deepSeekResult = makeDeepSeekResult();
      deepseekMock.think.mockResolvedValue(deepSeekResult);

      const result = await brain.think(context);

      // DeepSeek should have been called
      expect(deepseekMock.think).toHaveBeenCalledOnce();

      // Rule engine should NOT have been called
      expect(ruleEngineMock.think).not.toHaveBeenCalled();

      // Result should carry the deepseek source tag and contain expected data
      expect(result.source).toBe('deepseek');
      expect(result.say).toBe('Here are some chill tracks for you!');
      expect(result.songs).toHaveLength(2);
      expect(result.songs[0].name).toBe('Weightless');
      expect(result.songs[1].artist).toBe('Debussy');
      expect(result.reason).toContain('Calming tracks');
    });
  });

  // --------------------------------------------------------------------------
  describe('isDeepSeekAvailable()', () => {
    it('returns false when circuit breaker is open', async () => {
      const { brain, deepseekMock } = createMockedBrain({
        deepseekApiKey: 'sk-test-key-abc123',
      });

      // First call: DeepSeek is available and circuit is closed.
      // This caches _deepseekAvailable = true inside the Brain instance.
      deepseekMock.isAvailable.mockResolvedValue(true);
      deepseekMock.isCircuitOpen.mockReturnValue(false);

      const firstResult = await brain.isDeepSeekAvailable();
      expect(firstResult).toBe(true);

      // Simulate circuit breaker opening (e.g. after consecutive failures).
      // The cached _deepseekAvailable stays true, but isCircuitOpen returns true.
      deepseekMock.isCircuitOpen.mockReturnValue(true);

      const secondResult = await brain.isDeepSeekAvailable();
      expect(secondResult).toBe(false);
    });

    it('returns false when API key is not configured (empty string)', async () => {
      const { brain, deepseekMock } = createMockedBrain({
        deepseekApiKey: '',
      });

      deepseekMock.isAvailable.mockResolvedValue(false);

      const result = await brain.isDeepSeekAvailable();
      expect(result).toBe(false);
    });

    it('returns false when API key is the literal string "placeholder"', async () => {
      const { brain, deepseekMock } = createMockedBrain({
        deepseekApiKey: 'placeholder',
      });

      deepseekMock.isAvailable.mockResolvedValue(false);

      const result = await brain.isDeepSeekAvailable();
      expect(result).toBe(false);
    });

    it('caches the availability result across calls', async () => {
      const { brain, deepseekMock } = createMockedBrain({
        deepseekApiKey: 'sk-test-key-abc123',
      });

      deepseekMock.isAvailable.mockResolvedValue(true);
      deepseekMock.isCircuitOpen.mockReturnValue(false);

      // Call multiple times
      await brain.isDeepSeekAvailable();
      await brain.isDeepSeekAvailable();
      await brain.isDeepSeekAvailable();

      // isAvailable should only have been called once due to caching
      expect(deepseekMock.isAvailable).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  describe('generateIntent() — Layer 1', () => {
    it('includes environment context in intent', () => {
      const { brain } = createMockedBrain();
      const ctx = { environment: '雨天下午，20度', memory: '', userInput: '' };

      const intent = brain.generateIntent(ctx);
      expect(intent).toContain('雨天下午');
    });

    it('includes recent listening history', () => {
      const { brain } = createMockedBrain();
      const ctx = {
        environment: '',
        memory: '### 最近播放\n- 晴天 (周杰伦)\n- 七里香 (周杰伦)\n### 其他',
        userInput: '',
      };

      const intent = brain.generateIntent(ctx);
      expect(intent).toContain('最近听了');
      expect(intent).toContain('晴天');
    });

    it('includes user input only for chat trigger', () => {
      const { brain } = createMockedBrain();
      const ctx = {
        userInput: '来首安静的歌',
        executionTrace: { triggerType: 'chat' },
      };

      const intent = brain.generateIntent(ctx);
      expect(intent).toContain('用户说: 来首安静的歌');
    });

    it('does NOT include user input for scheduler trigger', () => {
      const { brain } = createMockedBrain();
      const ctx = {
        userInput: 'some leftover text',
        executionTrace: { triggerType: 'scheduler-morning' },
      };

      const intent = brain.generateIntent(ctx);
      expect(intent).not.toContain('用户说');
      expect(intent).toContain('早安时段');
    });

    it('adds scheduler-morning trigger context', () => {
      const { brain } = createMockedBrain();
      const ctx = { executionTrace: { triggerType: 'scheduler-morning' } };

      const intent = brain.generateIntent(ctx);
      expect(intent).toContain('早安时段');
    });

    it('adds scheduler-refill trigger context', () => {
      const { brain } = createMockedBrain();
      const ctx = { executionTrace: { triggerType: 'scheduler-refill' } };

      const intent = brain.generateIntent(ctx);
      expect(intent).toContain('队列补充');
    });

    it('adds scheduler-transition trigger context', () => {
      const { brain } = createMockedBrain();
      const ctx = { executionTrace: { triggerType: 'scheduler-transition' } };

      const intent = brain.generateIntent(ctx);
      expect(intent).toContain('时段过渡');
    });

    it('combines multiple context parts with period delimiter', () => {
      const { brain } = createMockedBrain();
      const ctx = {
        environment: '晴天下午',
        userInput: '想听摇滚',
        executionTrace: { triggerType: 'chat' },
      };

      const intent = brain.generateIntent(ctx);
      expect(intent).toContain('晴天下午');
      expect(intent).toContain('想听摇滚');
      expect(intent).toContain('。');
    });

    it('returns empty string when no context is provided', () => {
      const { brain } = createMockedBrain();
      const intent = brain.generateIntent({});
      expect(intent).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  describe('_matchCandidatesToStore()', () => {
    it('enriches LLM songs with ncmTrackId from candidates', () => {
      const { brain } = createMockedBrain();

      const llmSongs = [
        { name: '晴天', artist: '周杰伦' },
      ];
      const candidates = [
        { name: '晴天', artist: '周杰伦', ncmTrackId: '12345', tags: '华语流行', id: 'song:1' },
        { name: '七里香', artist: '周杰伦', ncmTrackId: '67890', tags: '华语', id: 'song:2' },
      ];

      const result = brain._matchCandidatesToStore(llmSongs, candidates);

      expect(result[0].ncmTrackId).toBe('12345');
      expect(result[0].vectorId).toBe('song:1');
      expect(result[0].tags).toBe('华语流行');
    });

    it('handles case-insensitive name matching', () => {
      const { brain } = createMockedBrain();

      const llmSongs = [{ name: 'Bohemian Rhapsody', artist: 'Queen' }];
      const candidates = [
        { name: 'bohemian rhapsody', artist: 'queen', ncmTrackId: '111', tags: '', id: 's1' },
      ];

      const result = brain._matchCandidatesToStore(llmSongs, candidates);
      expect(result[0].ncmTrackId).toBe('111');
    });

    it('handles whitespace-trimmed matching', () => {
      const { brain } = createMockedBrain();

      const llmSongs = [{ name: ' 晴天 ', artist: ' 周杰伦 ' }];
      const candidates = [
        { name: '晴天', artist: '周杰伦', ncmTrackId: '222', tags: '', id: 's1' },
      ];

      const result = brain._matchCandidatesToStore(llmSongs, candidates);
      expect(result[0].ncmTrackId).toBe('222');
    });

    it('returns song unchanged when not found in candidates', () => {
      const { brain } = createMockedBrain();

      const llmSongs = [{ name: '不存在的歌', artist: '未知歌手' }];
      const candidates = [
        { name: '晴天', artist: '周杰伦', ncmTrackId: '12345', tags: '', id: 's1' },
      ];

      const result = brain._matchCandidatesToStore(llmSongs, candidates);
      expect(result[0].ncmTrackId).toBeUndefined();
      expect(result[0].name).toBe('不存在的歌');
    });

    it('returns empty/null input unchanged', () => {
      const { brain } = createMockedBrain();

      expect(brain._matchCandidatesToStore([], [])).toEqual([]);
      expect(brain._matchCandidatesToStore(null, [])).toBeNull();
    });

    it('handles candidates without ncmTrackId', () => {
      const { brain } = createMockedBrain();

      const llmSongs = [{ name: '晴天', artist: '周杰伦' }];
      const candidates = [
        { name: '晴天', artist: '周杰伦', ncmTrackId: null, tags: '华语', id: 's1' },
      ];

      const result = brain._matchCandidatesToStore(llmSongs, candidates);
      expect(result[0].ncmTrackId).toBeNull();
      expect(result[0].vectorId).toBe('s1');
    });
  });

  // --------------------------------------------------------------------------
  describe('_buildRAGPrompt()', () => {
    it('includes candidate list in the prompt', () => {
      const { brain } = createMockedBrain();

      const candidates = [
        { name: '晴天', artist: '周杰伦', tags: '华语流行', mood: '青春怀旧', score: 0.9 },
        { name: '七里香', artist: '周杰伦', tags: '华语', mood: '甜蜜浪漫', score: 0.8 },
      ];

      const prompt = brain._buildRAGPrompt(context, candidates);

      expect(prompt).toContain('候选歌曲');
      expect(prompt).toContain('晴天');
      expect(prompt).toContain('周杰伦');
      expect(prompt).toContain('七里香');
      expect(prompt).toContain('华语流行');
    });

    it('includes environment and memory context', () => {
      const { brain } = createMockedBrain();

      const prompt = brain._buildRAGPrompt(context, []);

      expect(prompt).toContain('Sunny afternoon');
      expect(prompt).toContain('Bohemian Rhapsody');
    });

    it('instructs LLM to select from candidates only', () => {
      const { brain } = createMockedBrain();

      const candidates = [
        { name: 'Test Song', artist: 'Test', tags: '', mood: '', score: 0.9 },
      ];

      const prompt = brain._buildRAGPrompt(context, candidates);

      expect(prompt).toContain('候选歌曲列表中精选');
      expect(prompt).toContain('必须与候选列表中的完全一致');
    });

    it('truncates long mood descriptions', () => {
      const { brain } = createMockedBrain();

      const longMood = '这是一段非常非常长的描述，包含了大量的情感细节和背景信息，远远超过了四十个字符的限制';
      const candidates = [
        { name: 'Test', artist: 'Art', tags: '', mood: longMood, score: 0.9 },
      ];

      const prompt = brain._buildRAGPrompt(context, candidates);

      // The mood in the prompt should be truncated to 40 chars
      expect(prompt).not.toContain(longMood);
    });
  });

  // --------------------------------------------------------------------------
  describe('think() with RAG candidates', () => {
    it('includes candidates count in result', async () => {
      const { brain, deepseekMock, ruleEngineMock } = createMockedBrain({
        deepseekApiKey: 'sk-test-key',
      });

      deepseekMock.isAvailable.mockResolvedValue(true);
      deepseekMock.isCircuitOpen.mockReturnValue(false);
      deepseekMock.think.mockResolvedValue(makeDeepSeekResult());
      ruleEngineMock.think.mockReturnValue(makeRuleEngineResult());

      // Without vector candidates (embedding not available)
      const result = await brain.think(context);

      expect(result).toHaveProperty('candidates');
      expect(result.candidates).toBe(0);
    });

    it('returns source and candidates in rule-engine fallback', async () => {
      const { brain, deepseekMock, ruleEngineMock } = createMockedBrain({
        deepseekApiKey: '',
      });

      deepseekMock.isAvailable.mockResolvedValue(false);
      ruleEngineMock.think.mockReturnValue(makeRuleEngineResult());

      const result = await brain.think(context);

      expect(result.source).toBe('rule-engine');
      expect(result.candidates).toBe(0);
    });
  });
});
