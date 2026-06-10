// api/chat.js — POST /api/chat
// Full AI pipeline: router → context → brain → NCM resolve → play

const express = require('express');
const router = express.Router();
const { route } = require('../router');
const context = require('../context');
const Brain = require('../brain');
const state = require('../state');
const ncm = require('../services/ncm');
const config = require('../config');
const logger = require('../utils/logger');
const tts = require('../tts');
const scheduler = require('../scheduler');
const filler = require('../services/filler');

// Singleton brain instance
const brain = new Brain(config);

// ── Helper: safe NCM wrappers ────────────────────────────────
async function safeSearch(keyword, limit) {
  if (!ncm.isHealthy()) {
    logger.warn('CHAT', `NCM unhealthy, skipping search: "${keyword}"`);
    return null;
  }
  try {
    return await ncm.search(keyword, limit);
  } catch (err) {
    logger.warn('CHAT', `NCM search failed for "${keyword}": ${err.message}`);
    return null;
  }
}

async function safeGetSongUrl(trackId) {
  if (!ncm.isHealthy()) {
    logger.warn('CHAT', 'NCM unhealthy, cannot get song URL');
    return null;
  }
  try {
    return await ncm.getSongUrl(trackId);
  } catch (err) {
    logger.warn('CHAT', `NCM getSongUrl failed for ${trackId}: ${err.message}`);
    return null;
  }
}

router.post('/', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  logger.info('CHAT', `User: "${message}"`);
  state.logMessage('user', message);

  const broadcast = req.app.get('broadcast');

  try {
    // Step 1: Route intent
    const { intent, params } = route(message);
    logger.info('CHAT', `Intent: ${intent}`);

    switch (intent) {
      case 'pause': {
        state.updateCurrentState({ is_playing: false });
        if (broadcast) broadcast({ type: 'player-control', data: { action: 'pause' } });
        return res.json({ say: '好，暂停了。', play: [], reason: 'User requested pause', action: 'pause' });
      }

      case 'skip': {
        // Before skipping: check if we should insert a filler DJ talk
        const currentMeta = state.getCurrentState().now_playing_track_id
          ? state.getTrackMeta(state.getCurrentState().now_playing_track_id) : null;
        const prevSong = currentMeta ? { name: currentMeta.track_name, artist: currentMeta.artist } : null;

        const next = state.shiftQueue();
        if (next) {
          const url = await safeGetSongUrl(next.track_id);
          if (!url) {
            logger.warn('CHAT', `Cannot get URL for ${next.track_id}, trying next in queue`);
            const fallback = state.shiftQueue();
            if (fallback) {
              const fallbackUrl = await safeGetSongUrl(fallback.track_id);
              if (fallbackUrl) {
                const fallbackMeta = state.getTrackMeta(fallback.track_id);
                const nextSong = { name: fallbackMeta?.track_name || fallback.track_name, artist: fallbackMeta?.artist || fallback.artist };

                // Check if filler is needed
                if (scheduler.shouldInsertFiller && filler.shouldInsertFiller(scheduler._consecutivePlays)) {
                  scheduler.generateTransition(prevSong, nextSong).catch(() => {});
                }

                state.updateCurrentState({
                  now_playing_track_id: fallback.track_id,
                  now_playing_started: new Date().toISOString(),
                  is_playing: true,
                });
                if (broadcast) {
                  broadcast({
                    type: 'now-playing',
                    data: {
                      trackId: fallback.track_id,
                      trackName: fallbackMeta?.track_name || fallback.track_name,
                      artist: fallbackMeta?.artist || fallback.artist,
                      albumArt: fallbackMeta?.album_art || null,
                      url: fallbackUrl,
                      transitionStyle: fallback.transitionStyle || 'outro',
                    },
                  });
                }

                // Rolling queue check
                scheduler.checkAndPrefetch().catch(() => {});

                return res.json({
                  say: null,
                  play: [fallback.track_id],
                  reason: 'Skipped (fallback)',
                  action: 'skip',
                  nowPlaying: { trackId: fallback.track_id, url: fallbackUrl, trackName: fallbackMeta?.track_name || fallback.track_name },
                });
              }
            }
            return res.json({
              say: '抱歉，音乐服务暂时不可用，请稍后再试。',
              play: [],
              reason: 'NCM unavailable',
              action: 'skip',
            });
          }

          const meta = state.getTrackMeta(next.track_id);
          const nextSong = { name: meta?.track_name || next.track_name, artist: meta?.artist || next.artist };

          // Check if filler is needed between songs
          if (filler.shouldInsertFiller(scheduler._consecutivePlays)) {
            scheduler.generateTransition(prevSong, nextSong).catch(() => {});
          }

          state.updateCurrentState({
            now_playing_track_id: next.track_id,
            now_playing_started: new Date().toISOString(),
            is_playing: true,
          });

          // Rolling queue: prefetch when running low
          scheduler.checkAndPrefetch().catch(() => {});

          if (broadcast) {
            broadcast({
              type: 'now-playing',
              data: {
                trackId: next.track_id,
                trackName: meta?.track_name || next.track_name,
                artist: meta?.artist || next.artist,
                albumArt: meta?.album_art || null,
                url,
                transitionStyle: next.transitionStyle || 'outro',
              },
            });
          }
          return res.json({
            say: null,
            play: [next.track_id],
            reason: 'User skipped',
            action: 'skip',
            nowPlaying: { trackId: next.track_id, url, trackName: meta?.track_name || next.track_name },
          });
        }
        return res.json({ say: '队列里没有歌了。', play: [], reason: 'Queue empty' });
      }

      case 'search': {
        const results = await safeSearch(params.keyword, 5);
        if (!results) {
          return res.json({
            say: '音乐搜索服务暂时不可用，请稍后再试。',
            play: [],
            reason: 'NCM search unavailable',
            action: 'search',
            searchResults: [],
          });
        }
        const trackIds = results.map((r) => r.trackId);
        if (trackIds.length > 0) {
          // Add to queue
          state.addToQueue(results, 'search', `Search: ${params.keyword}`);
          for (const r of results) {
            state.setTrackMeta(r.trackId, r);
          }
          if (broadcast) {
            broadcast({ type: 'queue-update', data: { queue: state.getQueue() } });
          }
        }
        return res.json({
          say: null,
          play: trackIds,
          reason: `搜索"${params.keyword}"找到 ${results.length} 首`,
          action: 'search',
          searchResults: results,
        });
      }

      case 'what_playing': {
        const current = state.getCurrentState();
        const meta = current.now_playing_track_id
          ? state.getTrackMeta(current.now_playing_track_id)
          : null;
        const name = meta?.track_name || '没有正在播放的歌';
        return res.json({ say: `现在在放 ${name}。`, play: [], reason: 'Query' });
      }

      case 'play': {
        // If a song name is provided, search and play
        if (params.songName) {
          const results = await safeSearch(params.songName, 1);
          if (!results) {
            return res.json({
              say: '音乐服务暂时不可用，没法帮你找到这首歌，请稍后再试。',
              play: [],
              reason: 'NCM unavailable',
              action: 'play',
            });
          }
          if (results.length > 0) {
            const track = results[0];
            state.setTrackMeta(track.trackId, track);
            const url = await safeGetSongUrl(track.trackId);
            if (!url) {
              return res.json({
                say: `找到了${track.artist}的${track.trackName}，但暂时无法获取播放链接。`,
                play: [],
                reason: 'NCM URL unavailable',
                action: 'play',
              });
            }
            state.updateCurrentState({
              now_playing_track_id: track.trackId,
              now_playing_started: new Date().toISOString(),
              is_playing: true,
            });
            state.logPlay(track.trackId, track.trackName, track.artist, 'chat', `User: ${message}`);
            if (broadcast) {
              broadcast({
                type: 'now-playing',
                data: {
                  trackId: track.trackId,
                  trackName: track.trackName,
                  artist: track.artist,
                  albumArt: track.albumArt,
                  url,
                },
              });
            }
            return res.json({
              say: `好的，来听${track.artist}的${track.trackName}。`,
              play: [track.trackId],
              reason: 'User requested specific song',
              action: 'play',
              nowPlaying: { trackId: track.trackId, url, trackName: track.trackName, artist: track.artist, albumArt: track.albumArt },
            });
          }
        }
        // No song name or not found — resume
        const current = state.getCurrentState();
        if (current.now_playing_track_id) {
          const url = await safeGetSongUrl(current.now_playing_track_id);
          if (!url) {
            return res.json({
              say: '音乐服务暂时不可用，无法恢复播放。',
              play: [],
              reason: 'NCM URL unavailable',
              action: 'resume',
            });
          }
          state.updateCurrentState({ is_playing: true });
          if (broadcast) broadcast({ type: 'player-control', data: { action: 'play', url } });
          return res.json({ say: null, play: [], reason: 'Resume', action: 'resume' });
        }
        return res.json({ say: '队列是空的，告诉我你想听什么吧。', play: [], reason: 'Nothing to play' });
      }

      // Default: AI brain
      case 'ai':
      default: {
        // Assemble context
        const ctx = await context.assemble({
          userInput: params.userInput || message,
          triggerType: 'chat',
        });

        // Think (brain builds prompt internally from context pieces)
        const aiResult = await brain.think(ctx);
        const ragInfo = aiResult.candidates ? ` (RAG: ${aiResult.candidates} candidates)` : '';
        logger.info('CHAT', `AI source: ${aiResult.source}${ragInfo}, songs: ${aiResult.songs?.length || 0}`);

        // Resolve AI recommendations to real NCM tracks
        let resolvedTracks = [];
        const ncmAvailable = ncm.isHealthy();

        if (aiResult.songs && aiResult.songs.length > 0) {
          if (!ncmAvailable) {
            logger.warn('CHAT', 'NCM unhealthy — skipping song resolution, returning DJ text only');
          } else {
            // New format: [{name, artist, ncmTrackId?}] — resolve each song
            for (const song of aiResult.songs) {
              try {
                // Fast path: use pre-resolved NCM track ID from vector store
                if (song.ncmTrackId) {
                  logger.info('CHAT', `Using pre-resolved NCM ID for "${song.name}": ${song.ncmTrackId}`);
                  resolvedTracks.push({
                    trackId: song.ncmTrackId,
                    trackName: song.name,
                    artist: song.artist,
                    albumArt: song.albumArt || null,
                  });
                  continue;
                }

                // Slow path: search NCM by name + artist
                const keyword = `${song.name} ${song.artist}`.trim();
                const results = await ncm.search(keyword, 1);
                if (results.length > 0) {
                  resolvedTracks.push(results[0]);
                } else {
                  // Retry with just song name
                  const retryResults = await ncm.search(song.name, 1);
                  if (retryResults.length > 0) {
                    resolvedTracks.push(retryResults[0]);
                  } else {
                    logger.warn('CHAT', `Song not found on NCM: ${song.name} - ${song.artist}`);
                  }
                }
              } catch (err) {
                logger.warn('CHAT', `NCM search failed for "${song.name}": ${err.message}`);
              }
            }
          }
        } else if (aiResult.play && aiResult.play.length > 0) {
          // Old format: [trackIds] — from rule engine
          if (ncmAvailable) {
            try {
              const details = await ncm.getSongDetail(aiResult.play);
              resolvedTracks = details;
            } catch (err) {
              logger.warn('CHAT', `NCM getSongDetail failed: ${err.message}`);
            }
          }
        }

        let nowPlaying = null;
        if (resolvedTracks.length > 0) {
          // Store metadata for all resolved tracks
          for (const track of resolvedTracks) {
            state.setTrackMeta(track.trackId, track);
          }

          // For AI recommendations, replace the queue; for rule engine, append
          if (aiResult.source === 'deepseek') {
            state.clearQueue();
          }

          // Add all to queue
          state.addToQueue(resolvedTracks, aiResult.source, aiResult.reason);

          // Play the first one immediately
          const first = state.shiftQueue();
          if (first) {
            const url = await safeGetSongUrl(first.track_id);
            if (!url) {
              logger.warn('CHAT', `Cannot play first track ${first.track_id}, NCM URL failed`);
              // Still return the DJ text, just skip playback
            } else {
              state.updateCurrentState({
                now_playing_track_id: first.track_id,
                now_playing_started: new Date().toISOString(),
                is_playing: true,
              });
              state.logPlay(first.track_id, first.track_name, first.artist, aiResult.source, aiResult.reason);

              const meta = state.getTrackMeta(first.track_id);
              // Get transition style from the AI's first song recommendation
              const firstSong = aiResult.songs?.[0];
              const transitionStyle = firstSong?.transitionStyle || firstSong?.transition_style || 'intro';

              nowPlaying = {
                trackId: first.track_id,
                trackName: meta?.track_name || first.track_name,
                artist: meta?.artist || first.artist,
                albumArt: meta?.album_art || null,
                url,
                transitionStyle,
              };

              if (broadcast) {
                // Push DJ talk first if AI has something to say (with TTS)
                if (aiResult.say) {
                  // AI is talking — reset the filler counter
                  scheduler.resetPlayCounter();
                  try {
                    const ttsResult = await tts.synthesize(aiResult.say);
                    broadcast({
                      type: 'dj-talk',
                      data: { text: aiResult.say, ttsUrl: ttsResult.url, transitionStyle },
                    });
                    nowPlaying.ttsUrl = ttsResult.url;
                  } catch (ttsErr) {
                    logger.warn('CHAT', `TTS synthesis failed: ${ttsErr.message}`);
                    broadcast({
                      type: 'dj-talk',
                      data: { text: aiResult.say, ttsUrl: null, transitionStyle },
                    });
                  }
                }
                broadcast({ type: 'now-playing', data: nowPlaying });
                broadcast({ type: 'queue-update', data: { queue: state.getQueue() } });
              }
            }
          }
        }

        // Log FlowState's response
        let ttsUrl = null;
        if (aiResult.say) {
          state.logMessage('flowstate', aiResult.say);
          // Synthesize TTS (non-blocking for response, but include URL)
          try {
            const ttsResult = await tts.synthesize(aiResult.say);
            ttsUrl = ttsResult.url;
          } catch (ttsErr) {
            logger.warn('CHAT', `TTS synthesis failed: ${ttsErr.message}`);
          }
        }

        return res.json({
          say: aiResult.say,
          ttsUrl,
          songs: aiResult.songs || [],
          resolvedTracks: resolvedTracks.map((t) => ({
            trackId: t.trackId,
            trackName: t.trackName,
            artist: t.artist,
          })),
          reason: aiResult.reason,
          segue: aiResult.segue,
          source: aiResult.source,
          nowPlaying,
        });
      }
    }
  } catch (error) {
    logger.error('CHAT', `Unhandled error: ${error.message}`, error.stack);
    // Return a graceful response instead of raw 500
    return res.status(200).json({
      say: '嗯，出了一点小状况，稍后再试试吧。',
      play: [],
      reason: 'Internal error',
      error: config.nodeEnv !== 'production' ? error.message : undefined,
    });
  }
});

module.exports = router;
