import { useState, useEffect, useRef, useCallback } from 'react';
import useAppStore from '../stores/appStore.js';
import api from '../services/api.js';

function useWebSocket() {
  const wsRef = useRef(null);
  const { setCurrentTrack, setPlaying, setDjMessage, setQueue, playTrack, playTTS } = useAppStore();

  useEffect(() => {
    let ws;

    async function init() {
      const wsModule = await import('../services/ws.js');
      ws = wsModule.default;
      wsRef.current = ws;
      ws.connect();

      // Handle now-playing events
      ws.on('now-playing', (data) => {
        if (data.url) {
          // Full now-playing event with URL — play the track
          playTrack(data.url, {
            trackId: data.trackId,
            trackName: data.trackName || 'Unknown',
            artist: data.artist || 'Unknown',
            albumArt: data.albumArt || null,
          });
        } else if (data.now_playing_track_id) {
          setCurrentTrack({
            trackId: data.now_playing_track_id,
            trackName: data.trackName || 'Unknown',
            artist: data.artist || 'Unknown',
            albumArt: data.albumArt || null,
          });
        }
        if (data.is_playing !== undefined) {
          setPlaying(Boolean(data.is_playing));
        }
      });

      // Handle DJ talk events (with optional TTS audio)
      ws.on('dj-talk', (data) => {
        setDjMessage(data.text);
        if (data.ttsUrl) {
          playTTS(data.ttsUrl);
        }
      });

      // Handle chat events
      ws.on('chat', (data) => {
        console.log('[WS] Chat:', data.content);
      });

      // Handle queue updates
      ws.on('queue-update', (data) => {
        setQueue(data.queue || []);
      });
    }

    init();

    return () => {
      if (wsRef.current) {
        wsRef.current.disconnect();
      }
    };
  }, []);

  return wsRef.current;
}

export default useWebSocket;
