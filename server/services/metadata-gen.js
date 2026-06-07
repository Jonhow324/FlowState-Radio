// services/metadata-gen.js — AI Song Metadata Generator
// Generates description and segue text for tracks using DeepSeek

const Brain = require('../brain');
const state = require('../state');
const config = require('../config');
const logger = require('../utils/logger');

const brain = new Brain(config);

/**
 * Generate metadata (description + segue) for a track
 * @param {object} track - { trackId, trackName, artist, album }
 * @param {object} [prevTrack] - Previous track for segue context
 * @returns {Promise<{description: string, segue: string}|null>}
 */
async function generateMetadata(track, prevTrack = null) {
  const trackName = track.trackName || track.track_name || 'Unknown';
  const artist = track.artist || 'Unknown';

  // Check if metadata already exists
  const existing = state.getTrackMeta(track.trackId || track.track_id);
  if (existing?.description) {
    return { description: existing.description, segue: existing.segue_text };
  }

  const prevInfo = prevTrack
    ? `上一首播放的是 ${prevTrack.trackName || prevTrack.track_name} - ${prevTrack.artist}。`
    : '';

  const userInput = `请为歌曲「${trackName}」（${artist}）生成：
1. 一段 DJ 风格的歌曲介绍（50-80字，自然口语化，像电台主持人介绍歌曲那样）
2. 一段过渡词（30-50字，用于从这首歌过渡到下一首歌时的串词）
${prevInfo}
返回 JSON 格式：{"description": "歌曲介绍", "segue": "过渡词"}`;

  try {
    const ctx = {
      systemPrompt: '你是一个专业的电台 DJ，擅长用自然、温暖的语言介绍歌曲和做过渡串词。',
      userCorpus: '',
      environment: '',
      memory: '',
      userInput,
      executionTrace: { triggerType: 'metadata-gen' },
    };

    // Use DeepSeek directly for metadata generation
    const deepseek = brain.deepseek;
    if (!(await deepseek.isAvailable())) {
      // No AI available, return null
      return null;
    }

    const systemPrompt = [
      ctx.systemPrompt,
      '',
      '严格返回 JSON 格式：{"description": "歌曲介绍文本", "segue": "过渡词文本"}',
      '不要包含 markdown 代码块标记。',
    ].join('\n');

    const result = await deepseek.think(systemPrompt, userInput);

    // Extract from result — DeepSeek returns structured {say, songs, reason, segue}
    // But for metadata we parse the raw JSON differently
    const description = result.reason || result.say || '';
    const segue = result.segue || '';

    // Store in database
    state.setTrackDescription(track.trackId || track.track_id, description);
    state.setTrackSegue(track.trackId || track.track_id, segue);

    logger.info('META_GEN', `Generated metadata for "${trackName}": desc=${description.length}c, segue=${segue.length}c`);

    return { description, segue };
  } catch (error) {
    logger.warn('META_GEN', `Failed for "${trackName}": ${error.message}`);
    return null;
  }
}

/**
 * Batch generate metadata for multiple tracks
 * Processes sequentially to avoid rate limiting
 * @param {Array} tracks - Array of track objects
 * @returns {Promise<Map<string, {description, segue}>>}
 */
async function batchGenerate(tracks) {
  const results = new Map();
  let prevTrack = null;

  for (const track of tracks) {
    const meta = await generateMetadata(track, prevTrack);
    if (meta) {
      results.set(track.trackId || track.track_id, meta);
    }
    prevTrack = track;
  }

  logger.info('META_GEN', `Batch generated: ${results.size}/${tracks.length} tracks`);
  return results;
}

module.exports = {
  generateMetadata,
  batchGenerate,
};
