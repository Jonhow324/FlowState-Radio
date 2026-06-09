// filler.test.js — Unit tests for the filler / transition DJ talk service

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Re-implement pure functions here (same pattern as ingest.test.js)
function getTimePeriod() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

function categorizeWeather(weatherDesc) {
  if (!weatherDesc) return null;
  const desc = weatherDesc.toLowerCase();
  if (desc.includes('雨') || desc.includes('rain') || desc.includes('shower') || desc.includes('drizzle')) return 'rain';
  if (desc.includes('雪') || desc.includes('snow')) return 'snow';
  if (desc.includes('云') || desc.includes('阴') || desc.includes('cloud') || desc.includes('overcast')) return 'cloudy';
  if (desc.includes('晴') || desc.includes('clear') || desc.includes('sunny')) return 'clear';
  return null;
}

function shouldInsertFiller(consecutivePlays, threshold = 3) {
  return consecutivePlays >= threshold;
}

// ── Silence console during tests ─────────────────────────────
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────

describe('Filler Service', () => {

  describe('getTimePeriod()', () => {
    it('returns a valid period string', () => {
      const period = getTimePeriod();
      expect(['morning', 'afternoon', 'evening', 'night']).toContain(period);
    });
  });

  describe('categorizeWeather()', () => {
    it('detects rain from Chinese description', () => {
      expect(categorizeWeather('小雨转中雨')).toBe('rain');
    });

    it('detects rain from English description', () => {
      expect(categorizeWeather('light rain showers')).toBe('rain');
    });

    it('detects snow', () => {
      expect(categorizeWeather('Snow expected today')).toBe('snow');
      expect(categorizeWeather('大雪')).toBe('snow');
    });

    it('detects cloudy', () => {
      expect(categorizeWeather('多云')).toBe('cloudy');
      expect(categorizeWeather('overcast skies')).toBe('cloudy');
    });

    it('detects clear', () => {
      expect(categorizeWeather('晴天')).toBe('clear');
      expect(categorizeWeather('sunny and warm')).toBe('clear');
    });

    it('returns null for unknown weather', () => {
      expect(categorizeWeather('some weird thing')).toBeNull();
    });

    it('returns null for null/undefined input', () => {
      expect(categorizeWeather(null)).toBeNull();
      expect(categorizeWeather(undefined)).toBeNull();
    });
  });

  describe('shouldInsertFiller()', () => {
    it('returns false below threshold', () => {
      expect(shouldInsertFiller(0)).toBe(false);
      expect(shouldInsertFiller(1)).toBe(false);
      expect(shouldInsertFiller(2)).toBe(false);
    });

    it('returns true at threshold', () => {
      expect(shouldInsertFiller(3)).toBe(true);
    });

    it('returns true above threshold', () => {
      expect(shouldInsertFiller(5)).toBe(true);
      expect(shouldInsertFiller(10)).toBe(true);
    });

    it('respects custom threshold', () => {
      expect(shouldInsertFiller(4, 5)).toBe(false);
      expect(shouldInsertFiller(5, 5)).toBe(true);
      expect(shouldInsertFiller(2, 2)).toBe(true);
    });
  });
});
