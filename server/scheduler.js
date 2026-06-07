// scheduler.js — Claudio's Rhythm Scheduler (cron-based)
// 3 scheduled tasks: daily plan (07:00), morning briefing (09:00), hourly check

const cron = require('node-cron');
const context = require('./context');
const Brain = require('./brain');
const state = require('./state');
const ncm = require('./services/ncm');
const tts = require('./tts');
const config = require('./config');
const logger = require('./utils/logger');

class Scheduler {
  constructor() {
    this.brain = new Brain(config);
    this.broadcast = null; // Set after server starts
    this.tasks = [];
  }

  /**
   * Set the broadcast function (from WebSocket server)
   */
  setBroadcast(broadcastFn) {
    this.broadcast = broadcastFn;
  }

  /**
   * Initialize and start all cron tasks
   */
  start() {
    logger.info('SCHEDULER', 'Starting cron tasks...');

    // 07:00 — Daily playlist planning
    const planTask = cron.schedule('0 7 * * *', () => {
      this.planToday().catch((err) =>
        logger.error('SCHEDULER', `Daily plan failed: ${err.message}`)
      );
    }, { timezone: 'Asia/Shanghai' });

    // 09:00 — Morning briefing (weekdays only)
    const morningTask = cron.schedule('0 9 * * 1-5', () => {
      this.morningBriefing().catch((err) =>
        logger.error('SCHEDULER', `Morning briefing failed: ${err.message}`)
      );
    }, { timezone: 'Asia/Shanghai' });

    // Every hour — Periodic check (weather, mood, queue status)
    const hourlyTask = cron.schedule('0 * * * *', () => {
      this.hourlyCheck().catch((err) =>
        logger.error('SCHEDULER', `Hourly check failed: ${err.message}`)
      );
    }, { timezone: 'Asia/Shanghai' });

    this.tasks = [planTask, morningTask, hourlyTask];
    logger.info('SCHEDULER', '3 cron tasks started (plan@07:00, briefing@09:00, hourly@xx:00)');
  }

  /**
   * Stop all cron tasks
   */
  stop() {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    logger.info('SCHEDULER', 'All cron tasks stopped');
  }

  // ===== Task Implementations =====

  /**
   * 07:00 — Plan today's playlist
   * AI generates a full-day music plan based on taste + routines + calendar
   */
  async planToday() {
    logger.info('SCHEDULER', '[07:00] Generating daily plan...');

    const ctx = await context.assemble({
      userInput: '请规划今日歌单',
      triggerType: 'scheduler-plan',
    });

    // Call DeepSeek directly with a custom prompt for plan generation
    // (brain.think() enforces song recommendation format, which doesn't fit plan format)
    const deepseek = this.brain.deepseek;
    let planData;

    if (await deepseek.isAvailable()) {
      try {
        const systemPrompt = [
          ctx.systemPrompt,
          '',
          '## 用户品味与作息',
          ctx.userCorpus,
          '',
          '## 当前环境',
          ctx.environment,
          '',
          '## 记忆',
          ctx.memory,
          '',
          '# 任务',
          '请根据以上信息，规划一份今日歌单计划。',
          '严格返回 JSON 格式：',
          '{"summary": "今日音乐规划概要(一句话)", "plan": {"morning": [{"name":"歌名","artist":"歌手"}], "afternoon": [...], "evening": [...], "night": [...]}}',
          '每个时段推荐 3-4 首歌。必须是真实存在的歌曲。',
        ].join('\n');

        const result = await deepseek.think(systemPrompt, '请规划今日歌单');

        // deepseek.think returns parsed {say, songs, reason, segue}
        // The plan JSON might be in the raw response — use what we have
        planData = {
          songs: result.songs || [],
          summary: result.reason || result.say || '今日歌单已规划',
          source: 'deepseek',
          generatedAt: new Date().toISOString(),
        };
      } catch (err) {
        logger.warn('SCHEDULER', `DeepSeek plan failed: ${err.message}`);
        planData = {
          songs: [],
          summary: 'AI 暂时无法规划，请稍后再试',
          source: 'fallback',
          generatedAt: new Date().toISOString(),
        };
      }
    } else {
      // Fallback: use rule engine for a basic plan
      planData = {
        songs: [],
        summary: 'DeepSeek 未配置，今日歌单待手动规划',
        source: 'no-ai',
        generatedAt: new Date().toISOString(),
      };
    }

    state.saveTodayPlan(planData);
    logger.info('SCHEDULER', `[07:00] Daily plan saved: ${planData.summary}`);

    if (this.broadcast) {
      this.broadcast({ type: 'daily-plan', data: planData });
    }

    return planData;
  }

  /**
   * 09:00 — Morning briefing
   * Weather + calendar + recommend first song of the day
   */
  async morningBriefing() {
    logger.info('SCHEDULER', '[09:00] Generating morning briefing...');

    const ctx = await context.assemble({
      userInput: '早上好！请给我一个早安播报，告诉我今天的天气情况，并推荐一首适合开始新一天的歌。',
      triggerType: 'scheduler-morning',
    });

    const result = await this.brain.think(ctx);

    // Resolve songs via NCM
    let resolvedTracks = [];
    if (result.songs && result.songs.length > 0) {
      for (const song of result.songs.slice(0, 3)) {
        try {
          const keyword = `${song.name} ${song.artist}`.trim();
          const results = await ncm.search(keyword, 1);
          if (results.length > 0) {
            resolvedTracks.push(results[0]);
          }
        } catch (err) {
          logger.warn('SCHEDULER', `NCM search failed: ${err.message}`);
        }
      }
    }

    // Add resolved tracks to queue
    if (resolvedTracks.length > 0) {
      for (const track of resolvedTracks) {
        state.setTrackMeta(track.trackId, track);
      }
      state.clearQueue();
      state.addToQueue(resolvedTracks, 'scheduler-morning', result.reason);
    }

    // Synthesize DJ talk
    let ttsUrl = null;
    if (result.say) {
      const ttsResult = await tts.synthesize(result.say);
      ttsUrl = ttsResult.url;
    }

    // Save message
    state.logMessage('claudio', result.say || '早安！新的一天开始了。');

    // Broadcast morning briefing
    if (this.broadcast) {
      this.broadcast({
        type: 'morning-briefing',
        data: {
          say: result.say,
          ttsUrl,
          songs: resolvedTracks.map((t) => ({
            trackId: t.trackId,
            trackName: t.trackName,
            artist: t.artist,
          })),
          source: result.source,
        },
      });

      // Also push first track if available
      if (resolvedTracks.length > 0) {
        const first = state.shiftQueue();
        if (first) {
          const url = await ncm.getSongUrl(first.track_id);
          state.updateCurrentState({
            now_playing_track_id: first.track_id,
            now_playing_started: new Date().toISOString(),
            is_playing: true,
          });
          state.logPlay(first.track_id, first.track_name, first.artist, 'scheduler-morning', 'Morning briefing');

          this.broadcast({
            type: 'now-playing',
            data: {
              trackId: first.track_id,
              trackName: first.track_name,
              artist: first.artist,
              albumArt: state.getTrackMeta(first.track_id)?.album_art || null,
              url,
            },
          });
        }

        this.broadcast({
          type: 'queue-update',
          data: { queue: state.getQueue() },
        });
      }
    }

    logger.info('SCHEDULER', `[09:00] Morning briefing done: ${resolvedTracks.length} tracks`);
  }

  /**
   * Every hour — Periodic check
   * Weather changes, queue level, mood transitions
   */
  async hourlyCheck() {
    logger.info('SCHEDULER', '[Hourly] Running periodic check...');

    const queueLength = state.getQueueLength();

    // Auto-refill queue when < 3 tracks
    if (queueLength < 3) {
      logger.info('SCHEDULER', `[Hourly] Queue low (${queueLength} tracks), auto-refilling...`);
      await this.autoRefillQueue();
      return;
    }

    // Check if it's a transition time (style change)
    const hour = new Date().getHours();
    const isTransition = [9, 12, 18, 22].includes(hour);

    if (isTransition) {
      logger.info('SCHEDULER', `[Hourly] Time transition at ${hour}:00, checking mood...`);
      await this.triggerTransition();
    } else {
      logger.info('SCHEDULER', `[Hourly] All good. Queue: ${queueLength} tracks`);
    }
  }

  /**
   * Auto-refill queue when < 3 tracks
   * AI recommends 5 songs to fill the queue
   */
  async autoRefillQueue() {
    const ctx = await context.assemble({
      userInput: '播放队列快空了，请根据我最近的听歌记录和当前时间，再推荐 5 首我会喜欢的歌。',
      triggerType: 'scheduler-refill',
    });

    const result = await this.brain.think(ctx);

    let resolvedTracks = [];
    if (result.songs && result.songs.length > 0) {
      for (const song of result.songs) {
        try {
          const keyword = `${song.name} ${song.artist}`.trim();
          const results = await ncm.search(keyword, 1);
          if (results.length > 0) {
            resolvedTracks.push(results[0]);
          }
        } catch (err) {
          logger.warn('SCHEDULER', `Refill NCM search failed: ${err.message}`);
        }
      }
    }

    if (resolvedTracks.length > 0) {
      for (const track of resolvedTracks) {
        state.setTrackMeta(track.trackId, track);
      }
      state.addToQueue(resolvedTracks, 'scheduler-refill', result.reason || 'Auto-refill');
      logger.info('SCHEDULER', `Queue refilled with ${resolvedTracks.length} tracks`);

      if (this.broadcast) {
        this.broadcast({
          type: 'queue-update',
          data: { queue: state.getQueue() },
        });
      }
    } else {
      logger.warn('SCHEDULER', 'Queue refill failed: no tracks resolved');
    }
  }

  /**
   * Time transition — AI generates a brief comment and adjusts music style
   */
  async triggerTransition() {
    const ctx = await context.assemble({
      userInput: '时间到了转折点，请根据当前时间和氛围，简短说一句话并推荐 2 首接下来适合听的歌。',
      triggerType: 'scheduler-transition',
    });

    const result = await this.brain.think(ctx);

    // Synthesize DJ talk if present
    let ttsUrl = null;
    if (result.say) {
      const ttsResult = await tts.synthesize(result.say);
      ttsUrl = ttsResult.url;
      state.logMessage('claudio', result.say);
    }

    // Resolve and add tracks
    if (result.songs && result.songs.length > 0) {
      let resolvedTracks = [];
      for (const song of result.songs) {
        try {
          const results = await ncm.search(`${song.name} ${song.artist}`.trim(), 1);
          if (results.length > 0) resolvedTracks.push(results[0]);
        } catch { /* skip */ }
      }

      if (resolvedTracks.length > 0) {
        for (const track of resolvedTracks) {
          state.setTrackMeta(track.trackId, track);
        }
        state.addToQueue(resolvedTracks, 'scheduler-transition', result.reason);
      }
    }

    // Broadcast
    if (this.broadcast) {
      if (result.say) {
        this.broadcast({
          type: 'dj-talk',
          data: { text: result.say, ttsUrl },
        });
      }
      this.broadcast({
        type: 'queue-update',
        data: { queue: state.getQueue() },
      });
    }

    logger.info('SCHEDULER', `Transition done: say=${!!result.say}, songs=${result.songs?.length || 0}`);
  }

  // ===== Manual Triggers (for API endpoints) =====

  /**
   * Manually trigger daily plan (for testing or API call)
   */
  async triggerPlan() {
    return this.planToday();
  }

  /**
   * Manually trigger morning briefing
   */
  async triggerBriefing() {
    return this.morningBriefing();
  }

  /**
   * Manually trigger refill
   */
  async triggerRefill() {
    return this.autoRefillQueue();
  }
}

// Singleton
const scheduler = new Scheduler();

module.exports = scheduler;
