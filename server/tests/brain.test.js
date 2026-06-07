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
 */
function createMockedBrain(config = {}) {
  const brain = new Brain({ deepseekApiKey: 'placeholder', ...config });
  const deepseekMock = makeDeepSeekMock();
  const ruleEngineMock = makeRuleEngineMock();

  // Inject mocks directly into the Brain instance, replacing the real adapters
  brain.deepseek = deepseekMock;
  brain.ruleEngine = ruleEngineMock;

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
});
