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
 * Layers: persona + time + recentPlays + song pair
 *
 * @param {object} prevSong - { name, artist, tags? }
 * @param {object} nextSong - { name, artist, tags? }
 * @param {'shallow'|'deep'} depth - Bridge depth mode
 * @param {object} [bridgeContext] - Pre-built context from personaLoader.buildBridgeContext()
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildBridgePrompt(prevSong, nextSong, depth, bridgeContext) {
  const bc = bridgeContext || personaLoader.buildBridgeContext();
  const persona = bc.persona || personaLoader.getBridgePersona();
  const timeContext = bc.timeContext || personaLoader.getTimeContext();
  const recentPlays = bc.recentPlays || '';

  // System prompt varies by depth
  let systemPrompt;
  if (depth === 'deep') {
    systemPrompt = [
      persona,
      '',
      '你觉得下一首歌特别契合当下的氛围，想和听众多聊几句。',
      '',
      '请从以下角度中自然选择一个展开（不要列出角度名称，直接说）：',
      '1. 这首歌或歌手背后的创作故事、有趣轶事',
      '2. 音乐中值得细细品味的细节（某段旋律、编曲、歌词的妙处）',
      '3. 这首歌带来的情绪共鸣，为什么此刻听它格外动人',
      '4. 歌曲和当下场景/时间/心境的独特联系',
      '',
      '要求：',
      '- 2-4句话（60-200字），像跟老朋友聊天',
      '- 要有具体的细节，不要空泛的赞美或套话',
      '- 不要引号、不要前缀、不要列点',
      '- 第一句话要自然衔接上一首歌，后面的话展开聊下一首',
      '- 语气真诚，像真的在分享自己对音乐的感受',
      '',
      timeContext,
    ].join('\n');
  } else {
    systemPrompt = [
      persona,
      '',
      '你的任务是用一句话串联两首歌之间的过渡，让听众觉得音乐在自然流动。',
      '',
      '要求：',
      '- 只输出一句话（15-60字），不要引号、不要前缀',
      '- 可以提到歌名、歌手、情绪、风格上的联系',
      '- 语气像朋友在耳边轻声说话',
      '- 不要用"让我们"、"接下来"这类套话开头',
      '',
      timeContext,
    ].join('\n');
  }

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

module.exports = {
  buildChatPrompt,
  buildRefillPrompt,
  buildBridgePrompt,
  buildColdOpenPrompt,
};
