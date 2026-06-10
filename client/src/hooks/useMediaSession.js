// hooks/useMediaSession.js — Media Session API integration
// Enables system media controls (lock screen, notification, etc.)

import { useEffect } from 'react';
import useAppStore from '../stores/appStore.js';

function useMediaSession() {
  const { currentTrack, isPlaying, togglePlay, skipNext, skipPrev } = useAppStore();

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    // Update metadata when track changes
    if (currentTrack) {
      const artwork = currentTrack.albumArt
        ? [{ src: currentTrack.albumArt, sizes: '512x512', type: 'image/jpeg' }]
        : [];

      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.trackName || 'Unknown',
        artist: currentTrack.artist || 'FlowState Radio',
        album: 'FlowState AI DJ',
        artwork,
      });
    }
  }, [currentTrack]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    // Set playback state
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

    // Register action handlers
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    navigator.mediaSession.setActionHandler('previoustrack', () => skipPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => skipNext());

    // Seek (if supported)
    try {
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) {
          const audio = document.querySelector('audio');
          if (audio) audio.currentTime = details.seekTime;
        }
      });
    } catch {
      // seekto not supported
    }
  }, [isPlaying, togglePlay, skipNext, skipPrev]);

  // Cleanup
  useEffect(() => {
    return () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
      }
    };
  }, []);
}

export default useMediaSession;
