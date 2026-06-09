import { useEffect } from 'react';
import useAppStore from '../stores/appStore.js';
import api from '../services/api.js';

function useWebSocket() {
  useEffect(() => {
    let cancelled = false;
    let ws = null;

    async function init() {
      const wsModule = await import('../services/ws.js');
      ws = wsModule.default;

      if (cancelled) return; // Unmounted during async import
      ws.connect();

      // Handle now-playing events
      ws.on('now-playing', (data) => {
        const store = useAppStore.getState();
        const transitionStyle = data.transitionStyle || 'none';

        if (data.url) {
          const trackInfo = {
            trackId: data.trackId,
            trackName: data.trackName || 'Unknown',
            artist: data.artist || 'Unknown',
            albumArt: data.albumArt || null,
          };

          if (data.ttsUrl && (transitionStyle === 'intro' || transitionStyle === 'outro')) {
            // Intro/Outro mode: play song under DJ voice with ducking
            if (data.fillerType) store.setFillerType(data.fillerType);
            store.playWithTTS(data.ttsUrl, data.url, trackInfo, transitionStyle);
          } else {
            // Direct play
            store.playTrack(data.url, trackInfo);
          }
        } else if (data.now_playing_track_id) {
          store.setCurrentTrack({
            trackId: data.now_playing_track_id,
            trackName: data.trackName || 'Unknown',
            artist: data.artist || 'Unknown',
            albumArt: data.albumArt || null,
            transitionStyle,
          });
        }
        if (data.is_playing !== undefined) {
          store.setPlaying(Boolean(data.is_playing));
        }
      });

      // Handle DJ talk events (with optional TTS audio + filler type)
      ws.on('dj-talk', (data) => {
        const store = useAppStore.getState();
        store.setDjMessage(data.text);
        if (data.fillerType) {
          store.setFillerType(data.fillerType);
        }
        if (data.ttsUrl) {
          store.playTTS(data.ttsUrl);
        }
      });

      // Handle morning briefing (DJ greeting + first song)
      ws.on('morning-briefing', (data) => {
        const store = useAppStore.getState();
        if (data.say) {
          store.setDjMessage(data.say);
        }

        const musicIsPlaying = store.isPlaying;

        if (musicIsPlaying) {
          // Music is already playing → duck it and play DJ voice over it
          if (data.ttsUrl) {
            store.playTTS(data.ttsUrl);
          }
          if (data.songs && data.songs.length > 0) {
            const trackIds = data.songs.map((s) => s.trackId);
            api.post('/api/song/add', { trackIds, playNow: false }).catch(console.error);
          }
        } else if (data.songs && data.songs.length > 0) {
          // No music playing → start new track with DJ voice overlay
          const first = data.songs[0];
          api.post('/api/song/add', { trackIds: [first.trackId], playNow: false })
            .then((res) => {
              const track = res.data.tracks?.[0];
              if (track?.url) {
                const trackInfo = {
                  trackId: first.trackId,
                  trackName: first.trackName || track.trackName,
                  artist: first.artist || track.artist,
                  albumArt: track.albumArt || null,
                };
                store.playWithTTS(data.ttsUrl, track.url, trackInfo);
              } else if (data.ttsUrl) {
                store.playTTS(data.ttsUrl);
              }
            })
            .catch(() => {
              if (data.ttsUrl) store.playTTS(data.ttsUrl);
            });
        } else if (data.ttsUrl) {
          store.playTTS(data.ttsUrl);
        }
      });

      // Handle daily plan notification
      ws.on('daily-plan', (data) => {
        useAppStore.getState().setDjMessage(data.summary || '今日歌单已规划');
      });

      // Handle DJ switch
      ws.on('dj-switch', (data) => {
        const store = useAppStore.getState();
        if (data.activeDj) store.setActiveDj(data.activeDj);
        if (data.profile?.welcomeMessage) store.setDjMessage(data.profile.welcomeMessage);
        if (data.ttsUrl) store.playTTS(data.ttsUrl);
      });

      // Handle queue updates
      ws.on('queue-update', (data) => {
        useAppStore.getState().setQueue(data.queue || []);
      });
    }

    init();

    // Cleanup: disconnect THIS effect's WebSocket instance
    return () => {
      cancelled = true;
      if (ws) {
        ws.disconnect();
      }
    };
  }, []);
}

export default useWebSocket;
