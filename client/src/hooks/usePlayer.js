import { useState, useEffect, useCallback } from 'react';
import api from '../services/api.js';
import useAppStore from '../stores/appStore.js';

function usePlayer() {
  const { currentTrack, isPlaying, queue, setCurrentTrack, setPlaying, setQueue } = useAppStore();
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  // One-time fetch on mount; subsequent updates come via WebSocket
  const fetchState = useCallback(async () => {
    try {
      const [nowRes, queueRes] = await Promise.all([
        api.get('/api/now'),
        api.get('/api/queue'),
      ]);

      const now = nowRes.data;
      if (now.track?.trackId) {
        setCurrentTrack(now.track);
      }
      setPlaying(now.isPlaying);
      setProgress(now.progress || 0);
      setQueue(queueRes.data.queue || []);
    } catch (err) {
      console.error('Failed to fetch player state:', err);
    }
  }, []);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  return {
    currentTrack,
    isPlaying,
    progress,
    duration,
    queue,
    refresh: fetchState,
  };
}

export default usePlayer;
