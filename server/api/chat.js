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

// Singleton brain instance
const brain = new Brain(config);

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
        const next = state.shiftQueue();
        if (next) {
          const url = await ncm.getSongUrl(next.track_id);
          state.updateCurrentState({
            now_playing_track_id: next.track_id,
            now_playing_started: new Date().toISOString(),
            is_playing: true,
          });
          const meta = state.getTrackMeta(next.track_id);
          if (broadcast) {
            broadcast({
              type: 'now-playing',
              data: {
                trackId: next.track_id,
                trackName: meta?.track_name || next.track_name,
                artist: meta?.artist || next.artist,
                albumArt: meta?.album_art || null,
                url,
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
        const results = await ncm.search(params.keyword, 5);
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
          const results = await ncm.search(params.songName, 1);
          if (results.length > 0) {
            const track = results[0];
            state.setTrackMeta(track.trackId, track);
            const url = await ncm.getSongUrl(track.trackId);
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
          const url = await ncm.getSongUrl(current.now_playing_track_id);
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
        logger.info('CHAT', `AI source: ${aiResult.source}, songs: ${aiResult.songs?.length || 0}`);

        // Resolve AI recommendations to real NCM tracks
        let resolvedTracks = [];

        if (aiResult.songs && aiResult.songs.length > 0) {
          // New format: [{name, artist}] — search NCM for each
          for (const song of aiResult.songs) {
            try {
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
        } else if (aiResult.play && aiResult.play.length > 0) {
          // Old format: [trackIds] — from rule engine
          const details = await ncm.getSongDetail(aiResult.play);
          resolvedTracks = details;
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
            const url = await ncm.getSongUrl(first.track_id);
            state.updateCurrentState({
              now_playing_track_id: first.track_id,
              now_playing_started: new Date().toISOString(),
              is_playing: true,
            });
            state.logPlay(first.track_id, first.track_name, first.artist, aiResult.source, aiResult.reason);

            const meta = state.getTrackMeta(first.track_id);
            nowPlaying = {
              trackId: first.track_id,
              trackName: meta?.track_name || first.track_name,
              artist: meta?.artist || first.artist,
              albumArt: meta?.album_art || null,
              url,
            };

            if (broadcast) {
              // Push DJ talk first if AI has something to say
              if (aiResult.say) {
                broadcast({ type: 'dj-talk', data: { text: aiResult.say } });
              }
              broadcast({ type: 'now-playing', data: nowPlaying });
              broadcast({ type: 'queue-update', data: { queue: state.getQueue() } });
            }
          }
        }

        // Log Claudio's response
        if (aiResult.say) {
          state.logMessage('claudio', aiResult.say);
        }

        return res.json({
          say: aiResult.say,
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
    logger.error('CHAT', `Error: ${error.message}`, error.stack);
    res.status(500).json({
      error: 'Chat processing failed',
      detail: error.message,
    });
  }
});

module.exports = router;
