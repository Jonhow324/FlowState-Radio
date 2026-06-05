import { useState, useEffect, useRef, useCallback } from 'react';
import useAppStore from '../stores/appStore.js';
import api from '../services/api.js';

function useWebSocket() {
  const wsRef = useRef(null);
  const { setCurrentTrack, setPlaying, setDjMessage, setQueue } = useAppStore();

  useEffect(() => {
    let ws;

    async function init() {
      const wsModule = await import('../services/ws.js');
      ws = wsModule.default;
      wsRef.current = ws;
      ws.connect();

      // Handle now-playing events
      ws.on('now-playing', (data) => {
        if (data.now_playing_track_id) {
          setCurrentTrack({
            trackId: data.now_playing_track_id,
            trackName: data.trackName || 'Unknown',
            artist: data.artist || 'Unknown',
            albumArt: data.albumArt || null,
          });
        }
        setPlaying(Boolean(data.is_playing));
      });

      // Handle DJ talk events
      ws.on('dj-talk', (data) => {
        setDjMessage(data.text);
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
