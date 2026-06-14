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
const segmentEngine = require('../services/segmentEngine');
const jobQueue = require('../services/jobQueue');
const personaLoader = require('../services/personaLoader');

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
                // Check for pre-generated bridge segment
                const fbSegs = state.getAllSegments();
                let fbTransitionSeg = null;
                let fbSegKey = null;
                if (fbSegs.length > 0) {
                  const bridgeSegs = fbSegs.filter(s => s.type === 'bridge' && s.ttsStatus === 'ready');
                  if (bridgeSegs.length > 0) {
                    fbTransitionSeg = bridgeSegs[0];
                    fbSegKey = `${fbTransitionSeg.position}:${fbTransitionSeg.anchorTrackIndex}`;
                  }
                }
                if (fbTransitionSeg) {
                  state.removeSegment(fbSegKey);
                }

                state.updateCurrentState({
                  now_playing_track_id: fallback.track_id,
                  now_playing_started: new Date().toISOString(),
                  is_playing: true,
                });
                if (broadcast) {
                  const fbNowPlayData = {
                    trackId: fallback.track_id,
                    trackName: fallbackMeta?.track_name || fallback.track_name,
                    artist: fallbackMeta?.artist || fallback.artist,
                    albumArt: fallbackMeta?.album_art || null,
                    url: fallbackUrl,
                    transitionStyle: fallback.transitionStyle || 'outro',
                  };
                  if (fbTransitionSeg && fbTransitionSeg.ttsUrl) {
                    fbNowPlayData.ttsUrl = fbTransitionSeg.ttsUrl;
                    fbNowPlayData.fillerText = fbTransitionSeg.text;
                    fbNowPlayData.fillerType = 'bridge';
                    fbNowPlayData.transitionStyle = fbTransitionSeg.transitionStyle || 'intro';
                  }
                  broadcast({ type: 'now-playing', data: fbNowPlayData });
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

          // ── Segment Transition Logic ─────────────────────────
          const allSegs = state.getAllSegments();
          const hasSegments = allSegs.length > 0;
          let transitionSeg = null;
          let consumedSegKey = null;

          if (hasSegments) {
            const bridgeSegs = allSegs.filter(s => s.type === 'bridge' && s.ttsStatus === 'ready');
            if (bridgeSegs.length > 0) {
              transitionSeg = bridgeSegs[0];
              consumedSegKey = `${transitionSeg.position}:${transitionSeg.anchorTrackIndex}`;
            }
          }

          if (transitionSeg) {
            state.removeSegment(consumedSegKey);
          }

          state.updateCurrentState({
            now_playing_track_id: next.track_id,
            now_playing_started: new Date().toISOString(),
            is_playing: true,
          });

          // Rolling queue: prefetch when running low
          scheduler.checkAndPrefetch().catch(() => {});

          if (broadcast) {
            const nowPlayData = {
              trackId: next.track_id,
              trackName: meta?.track_name || next.track_name,
              artist: meta?.artist || next.artist,
              albumArt: meta?.album_art || null,
              url,
              transitionStyle: next.transitionStyle || 'outro',
            };
            // Attach pre-generated bridge segment if available
            if (transitionSeg && transitionSeg.ttsUrl) {
              nowPlayData.ttsUrl = transitionSeg.ttsUrl;
              nowPlayData.fillerText = transitionSeg.text;
              nowPlayData.fillerType = 'bridge';
              nowPlayData.transitionStyle = transitionSeg.transitionStyle || 'intro';
            }
            broadcast({ type: 'now-playing', data: nowPlayData });
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
            // ── Phase 3: Four-layer dedup before NCM resolution ──
            let songsToResolve = aiResult.songs;
            try {
              const queueTracks = state.getQueue();
              const queueIds = new Set(queueTracks.map(q => q.track_id));
              const recentPlays = state.getRecentPlaysForDedup(50);
              const dedupState = {
                batchIds: new Set(),
                queueIds,
                recentPlays,
              };
              const dedupResult = segmentEngine.dedupFilter(aiResult.songs, dedupState);
              songsToResolve = dedupResult.accepted;
              if (dedupResult.rejected.length > 0) {
                logger.info('CHAT', `Dedup filtered ${dedupResult.rejected.length} songs: ${dedupResult.rejected.map(r => r.reason).join(', ')}`);
              }
            } catch (dedupErr) {
              logger.warn('CHAT', `Dedup check failed, using unfiltered songs: ${dedupErr.message}`);
            }

            // New format: [{name, artist, ncmTrackId?}] — resolve each song
            for (const song of songsToResolve) {
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

          // ── Segment Processing (Phase 1) ────────────────────────
          // After NCM confirms tracks, normalize LLM segments and generate bridges.
          let normalizedSegments = [];

          if (aiResult.segments && Array.isArray(aiResult.segments) && resolvedTracks.length > 0) {
            normalizedSegments = segmentEngine.normalizeSegments(
              aiResult.segments,
              resolvedTracks.map(t => ({ name: t.trackName || t.name, artist: t.artist }))
            );
            const segMap = segmentEngine.buildSegmentMap(normalizedSegments);
            state.setSegments(segMap);

            logger.info('CHAT', `Segments normalized: ${normalizedSegments.length} (${normalizedSegments.map(s => s.type).join(', ')})`);
          }

          // ── Phase 3: Enqueue bridge + back_announce + silence generation ──
          if (broadcast && resolvedTracks.length > 1) {
            const tracksSnapshot = resolvedTracks.map(t => ({
              trackId: t.trackId,
              trackName: t.trackName || t.name,
              artist: t.artist,
            }));

            // Fill missing gaps with deterministic fallback (night→silence, day→bridge)
            const completeDecisions = segmentEngine.fillMissingSegments(
              resolvedTracks.length, normalizedSegments
            );

            jobQueue.enqueue({
              type: 'bridge_generation',
              dedupKey: `bridge:chat:${Date.now()}:${process.hrtime.bigint()}`,
              payload: { tracks: tracksSnapshot, completeDecisions: Array.from(completeDecisions.entries()) },
              execute: async (payload) => {
                // Reconstruct Map from serialized entries
                const decisionMap = new Map(payload.completeDecisions);

                // Build enriched bridge context once for this batch
                const bridgeContext = personaLoader.buildBridgeContext();

                for (let i = 0; i < payload.tracks.length - 1; i++) {
                  const prev = {
                    name: payload.tracks[i].trackName,
                    artist: payload.tracks[i].artist,
                    tags: state.getTrackMeta(payload.tracks[i].trackId)?.tags || '',
                  };
                  const next = {
                    name: payload.tracks[i + 1].trackName,
                    artist: payload.tracks[i + 1].artist,
                    tags: state.getTrackMeta(payload.tracks[i + 1].trackId)?.tags || '',
                  };

                  // ── Look up decision (Brain or fillMissingSegments fallback) ──
                  const decision = decisionMap.get(i);

                  if (decision?.type === 'silence') {
                    // Silence — either Brain decided or night-time fallback
                    const reason = decision._filled ? 'fill_night' : 'brain_decision';
                    const silenceSeg = segmentEngine.buildSilenceSegment(i, reason, 'chat');
                    state.addSegment(`between_tracks:${i}`, silenceSeg);
                    broadcast({ type: 'segment-ready', data: silenceSeg });
                    logger.info('CHAT', `Gap[${i}] → silence (${reason})`);
                  } else {
                    // Bridge — Brain decided or daytime fallback
                    const bridgeInfo = await segmentEngine.generateBridgeLLM(prev, next, brain.deepseek, {
                      bridgeContext,
                    });
                    const decisionSource = decision?._filled ? 'fill' : 'brain';
                    logger.info('CHAT', `Gap[${i}] ${decisionSource}: (${bridgeInfo.source}): "${bridgeInfo.text.slice(0, 50)}..."`);
                    const bridgeSeg = {
                      id: `seg:bridge:${i}:post`,
                      type: 'bridge',
                      position: 'between_tracks',
                      anchorTrackIndex: i,
                      text: bridgeInfo.text,
                      ttsUrl: null,
                      ttsStatus: 'pending',
                      transitionStyle: bridgeInfo.transitionStyle,
                      metadata: { prevSong: prev, nextSong: next, bridgeSource: bridgeInfo.source, brainDecision: !decision?._filled },
                    };
                    await segmentEngine.resolveSegmentTTS(bridgeSeg);
                    state.addSegment(`between_tracks:${i}`, bridgeSeg);
                    broadcast({ type: 'segment-ready', data: bridgeSeg });
                  }

                  // Back announce — only if Brain explicitly included one
                  const brainBackAnnounce = normalizedSegments.find(
                    s => s.position === 'after_track' && s.anchorTrackIndex === i
                  );
                  if (brainBackAnnounce) {
                    const backSeg = segmentEngine.buildBackAnnounceSegment(prev, i, 'chat');
                    await segmentEngine.resolveSegmentTTS(backSeg);
                    state.addSegment(`after_track:${i}`, backSeg);
                    broadcast({ type: 'segment-ready', data: backSeg });
                  }
                }

                // Last track: back_announce only if Brain explicitly included one
                if (payload.tracks.length > 0) {
                  const lastIdx = payload.tracks.length - 1;
                  const lastBackAnnounce = normalizedSegments.find(
                    s => s.position === 'after_track' && s.anchorTrackIndex === lastIdx
                  );
                  if (lastBackAnnounce) {
                    const lastTrack = {
                      name: payload.tracks[lastIdx].trackName,
                      artist: payload.tracks[lastIdx].artist,
                      tags: state.getTrackMeta(payload.tracks[lastIdx].trackId)?.tags || '',
                    };
                    const lastBack = segmentEngine.buildBackAnnounceSegment(lastTrack, lastIdx, 'chat-last');
                    await segmentEngine.resolveSegmentTTS(lastBack);
                    state.addSegment(`after_track:${lastIdx}`, lastBack);
                    broadcast({ type: 'segment-ready', data: lastBack });
                  }
                }
              },
            });
          }

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

              // Resolve cold_open segment (opening narration before first song)
              let coldOpenSeg = null;
              const brainColdOpen = normalizedSegments.find(s => s.type === 'cold_open');

              if (brainColdOpen && brainColdOpen.text) {
                // Brain provided cold_open — clean the text
                const cleaned = (brainColdOpen.text || '')
                  .replace(/^["'"「『【《\s]+/, '')
                  .replace(/["'"」』】》\s]+$/, '')
                  .replace(/```[\s\S]*```/g, '')
                  .trim();
                if (cleaned) {
                  coldOpenSeg = { ...brainColdOpen, text: cleaned };
                  await segmentEngine.resolveSegmentTTS(coldOpenSeg);
                  state.addSegment(`before_track:0`, coldOpenSeg);
                }
              }

              if (!coldOpenSeg || !coldOpenSeg.ttsUrl) {
                // Fallback: generate cold_open from first resolved track
                const firstTrackMeta = state.getTrackMeta(first.track_id);
                const firstSongInfo = {
                  name: firstTrackMeta?.track_name || first.track_name,
                  artist: firstTrackMeta?.artist || first.artist,
                  tags: firstTrackMeta?.tags || '',
                };
                const bridgeContext = personaLoader.buildBridgeContext();
                const coldOpenResult = await segmentEngine.generateColdOpen(
                  firstSongInfo, brain.deepseek, { bridgeContext }
                );
                if (coldOpenResult.text) {
                  coldOpenSeg = {
                    id: 'seg:cold_open:0:gen',
                    type: 'cold_open',
                    position: 'before_track',
                    anchorTrackIndex: 0,
                    text: coldOpenResult.text,
                    ttsUrl: null,
                    ttsStatus: 'pending',
                    transitionStyle: 'none',
                    metadata: { source: coldOpenResult.source },
                  };
                  await segmentEngine.resolveSegmentTTS(coldOpenSeg);
                  state.addSegment(`before_track:0`, coldOpenSeg);
                }
              }

              if (broadcast) {
                // Broadcast cold_open segment if available
                if (coldOpenSeg && coldOpenSeg.ttsUrl) {
                  broadcast({ type: 'segment-ready', data: coldOpenSeg });
                  nowPlaying.coldOpen = coldOpenSeg;
                }

                // Push DJ talk first if AI has something to say (with TTS)
                if (aiResult.say) {
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
