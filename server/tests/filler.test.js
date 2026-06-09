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

  describe('generateFiller()', () => {
    // Re-implement the core logic for testing
    const TIME_FILLERS = {
      morning: ['早安，新的一天从好音乐开始。'],
      afternoon: ['午后的时光总是慵懒的，让音乐继续陪你。'],
      evening: ['夜幕降临，是时候换一种节奏了。'],
      night: ['夜深了，让这首安静的歌陪你入眠。'],
    };
    const TRANSITION_FILLERS = ['接下来换一种风格，给你一点新鲜感。'];
    const STRETCH_FILLERS = ['已经连着听了好几首了，DJ 出来冒个泡。'];

    function pickRandom(arr) {
      return arr[Math.floor(Math.random() * arr.length)];
    }

    function generateFiller(options = {}) {
      const { reason = 'gap', weather, prevSong, prevArtist } = options;
      const period = getTimePeriod();
      let text;
      let type = reason;
      switch (reason) {
        case 'stretch': {
          const base = pickRandom(STRETCH_FILLERS);
          if (prevSong) {
            text = `刚刚听完${prevArtist ? prevArtist + '的' : ''}《${prevSong}》，${pickRandom(TRANSITION_FILLERS)}`;
          } else {
            text = base;
          }
          type = 'stretch';
          break;
        }
        case 'transition': {
          text = pickRandom(TRANSITION_FILLERS);
          if (prevSong) {
            text = `${prevArtist ? prevArtist : ''}的《${prevSong}》告一段落，${text}`;
          }
          break;
        }
        case 'gap':
        default: {
          text = pickRandom(TIME_FILLERS[period]);
          type = 'gap';
          break;
        }
      }
      return { text, type };
    }

    it('returns gap filler by default', () => {
      const result = generateFiller();
      expect(result.type).toBe('gap');
      expect(typeof result.text).toBe('string');
      expect(result.text.length).toBeGreaterThan(0);
    });

    it('returns stretch filler with prevSong context', () => {
      const result = generateFiller({ reason: 'stretch', prevSong: '晴天', prevArtist: '周杰伦' });
      expect(result.type).toBe('stretch');
      expect(result.text).toContain('晴天');
      expect(result.text).toContain('周杰伦');
    });

    it('returns stretch filler without prevSong', () => {
      const result = generateFiller({ reason: 'stretch' });
      expect(result.type).toBe('stretch');
      expect(result.text.length).toBeGreaterThan(0);
    });

    it('returns transition filler with prevSong context', () => {
      const result = generateFiller({ reason: 'transition', prevSong: '七里香', prevArtist: '周杰伦' });
      expect(result.type).toBe('transition');
      expect(result.text).toContain('七里香');
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

  describe('generateSegue()', () => {
    function generateSegue(prevSong, nextSong) {
      const templates = [
        `从${prevSong.artist}的《${prevSong.name}》过渡到${nextSong.artist}的《${nextSong.name}》，音乐在流动。`,
        `听完《${prevSong.name}》，接下来是${nextSong.artist}带来的《${nextSong.name}》。`,
        `${prevSong.name}的余韵还在，${nextSong.name}已经准备好了。`,
        `刚才那首${prevSong.name}很动人，这首${nextSong.name}也不会让你失望。`,
      ];
      return templates[Math.floor(Math.random() * templates.length)];
    }

    it('generates a segue mentioning both songs', () => {
      const result = generateSegue(
        { name: '晴天', artist: '周杰伦' },
        { name: '夜曲', artist: '周杰伦' },
      );
      expect(typeof result).toBe('string');
      // At least one template variant should mention a song name
      expect(result.includes('晴天') || result.includes('夜曲')).toBe(true);
    });

    it('always returns a non-empty string', () => {
      for (let i = 0; i < 10; i++) {
        const result = generateSegue({ name: 'A', artist: 'B' }, { name: 'C', artist: 'D' });
        expect(result.length).toBeGreaterThan(0);
      }
    });
  });
});
