import { describe, it, expect } from 'vitest';
import { route } from '../router.js';

// ---------------------------------------------------------------------------
// Helper: shorthand to assert intent + params in one line
// ---------------------------------------------------------------------------
function expectRoute(input, intent, params) {
  const result = route(input);
  expect(result.intent).toBe(intent);
  expect(result.params).toEqual(params);
}

// ===========================================================================
// 1. PLAY intent
// ===========================================================================
describe('PLAY intent', () => {
  it.each([
    '播放',
    '来一首',
    '换首',
    '下一首',
    '切歌',
    'play',
    'Play',       // case-insensitive
    'PLAY',       // case-insensitive
    '放首',
    '放一',
  ])('matches "%s" as play', (input) => {
    expect(route(input).intent).toBe('play');
  });

  it('extracts songName after the play command', () => {
    expectRoute('播放 晴天', 'play', { songName: '晴天' });
  });

  it('extracts songName without leading space', () => {
    expectRoute('来一首稻香', 'play', { songName: '稻香' });
  });

  it('returns empty songName when no song is specified', () => {
    expectRoute('播放', 'play', { songName: '' });
  });

  it('trims whitespace around the extracted songName', () => {
    // trimmed input: '播放   夜曲' → replace '播放' → '   夜曲' → trim → '夜曲'
    expectRoute('播放   夜曲  ', 'play', { songName: '夜曲' });
  });

  it('handles English play command with song name', () => {
    expectRoute('play Bohemian Rhapsody', 'play', { songName: 'Bohemian Rhapsody' });
  });
});

// ===========================================================================
// 2. PAUSE intent
// ===========================================================================
describe('PAUSE intent', () => {
  it.each([
    '暂停',
    '停',
    'pause',
    'Pause',
    'PAUSE',
    '停止',
  ])('matches "%s" as pause', (input) => {
    expectRoute(input, 'pause', {});
  });
});

// ===========================================================================
// 3. SKIP intent
// ===========================================================================
describe('SKIP intent', () => {
  it.each([
    '跳过',
    'skip',
    'Skip',
    'SKIP',
    '换一首',
  ])('matches "%s" as skip', (input) => {
    expectRoute(input, 'skip', {});
  });

  // "下一首" exists in both PLAY and SKIP patterns.
  // PLAY is checked first, so it should always match as play.
  it('"下一首" matches play (not skip) because PLAY is checked first', () => {
    expect(route('下一首').intent).toBe('play');
  });
});

// ===========================================================================
// 4. VOLUME intent
// ===========================================================================
describe('VOLUME intent', () => {
  it.each([
    '音量',
    '大声',
    '小声',
    'volume',
    'Volume',
    '调',
  ])('matches "%s" as volume', (input) => {
    expect(route(input).intent).toBe('volume');
  });

  it('passes the full trimmed input as params.raw', () => {
    expectRoute('音量大一点', 'volume', { raw: '音量大一点' });
  });

  it('preserves the original casing in params.raw', () => {
    expectRoute('Volume up', 'volume', { raw: 'Volume up' });
  });
});

// ===========================================================================
// 5. LIKE intent
// ===========================================================================
describe('LIKE intent', () => {
  it.each([
    '喜欢',
    '收藏',
    'like',
    'Like',
    '标记',
  ])('matches "%s" as like', (input) => {
    expectRoute(input, 'like', {});
  });
});

// ===========================================================================
// 6. SEARCH intent
// ===========================================================================
describe('SEARCH intent', () => {
  it.each([
    '搜索',
    '找',
    'search',
    'Search',
    '有没有',
  ])('matches "%s" as search', (input) => {
    expect(route(input).intent).toBe('search');
  });

  it('extracts keyword after the search command', () => {
    expectRoute('搜索 周杰伦', 'search', { keyword: '周杰伦' });
  });

  it('extracts keyword for English search', () => {
    expectRoute('search jazz', 'search', { keyword: 'jazz' });
  });

  it('falls back to full input as keyword when nothing follows the command', () => {
    // "搜索" alone: after replace the remainder is "", so keyword = trimmed (original)
    expectRoute('搜索', 'search', { keyword: '搜索' });
  });

  it('falls back to full input for "找" alone', () => {
    expectRoute('找', 'search', { keyword: '找' });
  });

  it('falls back to full input for "有没有" alone', () => {
    expectRoute('有没有', 'search', { keyword: '有没有' });
  });
});

// ===========================================================================
// 7. WHAT_PLAYING intent
// ===========================================================================
describe('WHAT_PLAYING intent', () => {
  it.each([
    '什么歌',
    '现在播',
    'now',
    'Now',
    '在放什么',
  ])('matches "%s" as what_playing', (input) => {
    expectRoute(input, 'what_playing', {});
  });
});

// ===========================================================================
// 8. MOOD intent (routed to ai)
// ===========================================================================
describe('MOOD intent (routed to ai)', () => {
  it.each([
    '心情',
    'mood',
    'Mood',
    '感觉',
    '开心',
    '难过',
    '想听',
    '适合',
    '来点',
  ])('matches "%s" and routes to ai intent', (input) => {
    expect(route(input).intent).toBe('ai');
  });

  it('passes the trimmed input as params.userInput', () => {
    expectRoute('想听点轻音乐', 'ai', { userInput: '想听点轻音乐' });
  });

  it('passes mood keyword as userInput', () => {
    expectRoute('开心', 'ai', { userInput: '开心' });
  });
});

// ===========================================================================
// 9. AI fallback (default intent)
// ===========================================================================
describe('AI fallback', () => {
  it('returns ai intent for unrecognized Chinese input', () => {
    expectRoute('今天天气不错', 'ai', { userInput: '今天天气不错' });
  });

  it('returns ai intent for unrecognized English input', () => {
    expectRoute('hello world', 'ai', { userInput: 'hello world' });
  });

  it('returns ai intent for random characters', () => {
    expectRoute('xyz123', 'ai', { userInput: 'xyz123' });
  });

  it('preserves the full trimmed input in params.userInput', () => {
    const input = '  随便说点什么  ';
    const result = route(input);
    expect(result.intent).toBe('ai');
    expect(result.params.userInput).toBe('随便说点什么');
  });
});

// ===========================================================================
// 10. Edge cases
// ===========================================================================
describe('Edge cases', () => {
  it('handles empty string input', () => {
    const result = route('');
    expect(result.intent).toBe('ai');
    expect(result.params.userInput).toBe('');
  });

  it('handles whitespace-only input', () => {
    const result = route('   ');
    expect(result.intent).toBe('ai');
    expect(result.params.userInput).toBe('');
  });

  it('trims leading/trailing whitespace before matching', () => {
    expectRoute('  暂停  ', 'pause', {});
  });

  it('trims leading whitespace for play with songName', () => {
    const result = route('  播放 晴天');
    expect(result.intent).toBe('play');
    expect(result.params.songName).toBe('晴天');
  });

  it('handles single character input', () => {
    const result = route('停');
    expect(result.intent).toBe('pause');
  });

  it('handles mixed Chinese and English in play command', () => {
    expectRoute('播放 Hello', 'play', { songName: 'Hello' });
  });

  it('handles mixed Chinese and English in search command', () => {
    expectRoute('搜索 best songs', 'search', { keyword: 'best songs' });
  });

  it('is case-insensitive for English keywords', () => {
    expectRoute('PLAY something', 'play', { songName: 'something' });
    expectRoute('SEARCH jazz', 'search', { keyword: 'jazz' });
    expectRoute('PAUSE', 'pause', {});
    expectRoute('SKIP', 'skip', {});
    expectRoute('VOLUME up', 'volume', { raw: 'VOLUME up' });
    expectRoute('LIKE', 'like', {});
    expectRoute('NOW', 'what_playing', {});
    expectRoute('MOOD chill', 'ai', { userInput: 'MOOD chill' });
  });

  it('matches only at the start of the input (anchored regex)', () => {
    // These should NOT match because the keyword is not at the beginning
    const result = route('我想暂停');
    expect(result.intent).toBe('ai');
  });

  it('does not match pause keyword embedded in a longer word', () => {
    const result = route('请不要停');
    expect(result.intent).toBe('ai');
  });

  it('returns an object with exactly two keys: intent and params', () => {
    const result = route('播放');
    expect(Object.keys(result)).toEqual(['intent', 'params']);
  });
});
