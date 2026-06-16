// promptBuilders.js — Specialized prompt builders for different AI tasks
// Each builder selects and arranges context layers differently, following
// the Claudio-FM principle: not every task needs every context layer.
//
// Context layers:
//   1. persona      — DJ character and speaking rules
//   2. taste        — User preferences (taste.md, routines.md, mood-rules.md)
//   3. environment  — Time, weather, calendar
//   4. memory       — Recent plays + recent messages
//   5. dialog       — Current user input
//   6. recentPlays  — Subset of memory focused on listening history

const context = require('./context');
const personaLoader = require('./services/personaLoader');

/**
 * Build the full prompt for user chat + song selection.
 * Uses ALL context layers — the brain needs everything to make
 * informed song recommendations based on user intent.
 *
 * Layers: persona + taste + environment + memory + dialog
 */
async function buildChatPrompt(userInput) {
  const ctx = await context.assemble({ userInput, triggerType: 'chat' });
  const sections = [
    `# System\n${ctx.systemPrompt}`,
    `# 用户品味与作息\n${ctx.userCorpus}`,
    `# 当前环境\n${ctx.environment}`,
    `# 记忆\n${ctx.memory}`,
    `# 用户输入\n${ctx.userInput}`,
    `# 触发方式\n${ctx.executionTrace.triggerType}`,
    '',
    '# 指令',
    '基于以上所有信息，请返回 JSON 格式的歌曲推荐。',
    'play 数组中填入网易云歌曲 ID（字符串），推荐 10-20 首。',
    'say 字段为 DJ 的自然语言串词（可为 null）。',
    '严格返回 JSON，不要包含其他内容。',
  ];
  return sections.join('\n\n');
}

/**
 * Build prompt for queue refill (auto-prefetch).
 * Strips dialog layer — refill is autonomous, not user-triggered.
 * Focuses on recent plays to maintain musical continuity.
 *
 * Layers: persona + taste + environment + memory (no dialog)
 */
async function buildRefillPrompt() {
  const ctx = await context.assemble({ triggerType: 'scheduler-refill' });

  // Strip dialog from memory (recent messages section)
  const memoryWithoutDialog = ctx.memory.replace(
    /### 最近对话[\s\S]*?(?=###|$)/g,
    ''
  ).trim();

  const sections = [
    `# System\n${ctx.systemPrompt}`,
    `# 用户品味与作息\n${ctx.userCorpus}`,
    `# 当前环境\n${ctx.environment}`,
    `# 记忆\n${memoryWithoutDialog}`,
    '',
    '# 指令',
    '播放队列快空了，请根据最近的听歌风格和当前时间，推荐 10 首延续当前氛围的歌曲。',
    '严格返回 JSON 格式。',
  ];
  return sections.join('\n\n');
}

/**
 * Build prompts for bridge generation between two songs.
 * Deliberately MINIMAL context — only persona, time, recent plays, and the
 * song pair. Strips taste and dialog to keep the LLM focused on making
 * a natural transition rather than trying to incorporate too much context.
 *
 * This is the Claudio-FM insight: bridge prompts should be lean.
 *
 * The LLM decides text length freely based on context — no depth parameter.
 *
 * Layers: persona + time + recentPlays + song pair
 *
 * @param {object} prevSong - { name, artist, tags? }
 * @param {object} nextSong - { name, artist, tags? }
 * @param {object} [bridgeContext] - Pre-built context from personaLoader.buildBridgeContext()
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildBridgePrompt(prevSong, nextSong, bridgeContext) {
  const bc = bridgeContext || personaLoader.buildBridgeContext();
  const persona = bc.persona || personaLoader.getBridgePersona();
  const timeContext = bc.timeContext || personaLoader.getTimeContext();
  const recentPlays = bc.recentPlays || '';

  const systemPrompt = [
    persona,
    '',
    '你的任务是用自然的话语串联两首歌之间的过渡。',
    '',
    '要求：',
    '- 简短过渡或展开聊都可以，根据你对这两首歌之间联系的感受自由决定',
    '- 语气像朋友在耳边轻声说话，不要播音腔',
    '- 不要引号、不要前缀、不要列点',
    '- 可以提到歌名、歌手、情绪、风格上的联系，或者某个有趣的细节',
    '- 不要用"让我们"、"接下来"这类套话开头',
    '',
    timeContext,
  ].join('\n');

  // User prompt: recent plays + song pair
  const prevName = prevSong.name || prevSong.trackName || '未知';
  const prevArtist = prevSong.artist || '未知';
  const nextName = nextSong.name || nextSong.trackName || '未知';
  const nextArtist = nextSong.artist || '未知';

  const userParts = [];
  if (recentPlays) userParts.push(recentPlays);
  userParts.push('');
  userParts.push(`上一首：${prevArtist} -《${prevName}》`);
  if (prevSong.tags) userParts.push(`标签：${prevSong.tags}`);
  userParts.push(`下一首：${nextArtist} -《${nextName}》`);
  if (nextSong.tags) userParts.push(`标签：${nextSong.tags}`);

  const userPrompt = userParts.join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * Build prompts for cold open generation (opening narration before first song).
 * Uses persona + time + recent plays + first song info.
 *
 * Layers: persona + time + recentPlays + firstSong
 *
 * @param {object} firstSong - { name, artist, tags? }
 * @param {object} [bridgeContext] - Pre-built context from personaLoader.buildBridgeContext()
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildColdOpenPrompt(firstSong, bridgeContext) {
  const bc = bridgeContext || personaLoader.buildBridgeContext();
  const persona = bc.persona || personaLoader.getBridgePersona();
  const timeContext = bc.timeContext || personaLoader.getTimeContext();
  const recentPlays = bc.recentPlays || '';

  const systemPrompt = [
    persona,
    '',
    '你正在开启今天的电台节目。用一段开场白为听众设定氛围。',
    '',
    '叙事弧（自然融入，不要刻意标注）：',
    '- 定场：描述当下的时间、空间、氛围',
    '- 情感：触及听众此刻可能的状态或心情',
    '- 转折：从日常引向音乐',
    '- 画面：一个具体的感官细节',
    '- 邀请：让听众觉得这段开场是为他说的',
    '',
    '要求：',
    '- 2-4句话（90-220字）',
    '- 自然衔接第一首歌，让听众觉得音乐是开场的延续',
    '- 不要播音腔、不要"大家好欢迎来到"',
    '- 不要列点、不要标注叙事弧名称',
    '',
    timeContext,
  ].join('\n');

  const songName = firstSong.name || firstSong.trackName || '第一首歌';
  const songArtist = firstSong.artist || '';

  const userParts = [];
  if (recentPlays) userParts.push(recentPlays);
  userParts.push('');
  userParts.push(`即将播出的第一首歌：${songArtist ? songArtist + ' - ' : ''}《${songName}》`);
  if (firstSong.tags) userParts.push(`标签：${firstSong.tags}`);

  const userPrompt = userParts.join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * Build prompts for back announce generation (brief comment after a song ends).
 * Lean context — persona, time, recent plays, and the song that just finished.
 *
 * Layers: persona + time + recentPlays + finishedSong
 *
 * @param {object} song - The song that just ended { name, artist, tags? }
 * @param {object} [bridgeContext] - Pre-built context from personaLoader.buildBridgeContext()
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildBackAnnouncePrompt(song, bridgeContext) {
  const bc = bridgeContext || personaLoader.buildBridgeContext();
  const persona = bc.persona || personaLoader.getBridgePersona();
  const timeContext = bc.timeContext || personaLoader.getTimeContext();
  const recentPlays = bc.recentPlays || '';

  const systemPrompt = [
    persona,
    '',
    '一首歌刚播完，用一两句话做个简短的回味或感想。',
    '',
    '要求：',
    '- 1-2句话，不要长',
    '- 可以提歌名、歌手、某个触动你的细节，也可以只是感受',
    '- 语气自然随意，像自言自语，不要播音腔',
    '- 不要引号、不要前缀、不要列点',
    '- 不要用"刚才那首"、"让我们"这类套话开头',
    '',
    timeContext,
  ].join('\n');

  const songName = song.name || song.trackName || '未知';
  const songArtist = song.artist || '未知';

  const userParts = [];
  if (recentPlays) userParts.push(recentPlays);
  userParts.push('');
  userParts.push(`刚播完：${songArtist} -《${songName}》`);
  if (song.tags) userParts.push(`标签：${song.tags}`);

  const userPrompt = userParts.join('\n');

  return { systemPrompt, userPrompt };
}

module.exports = {
  buildChatPrompt,
  buildRefillPrompt,
  buildBridgePrompt,
  buildColdOpenPrompt,
  buildBackAnnouncePrompt,
};
