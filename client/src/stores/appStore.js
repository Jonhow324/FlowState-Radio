import { create } from 'zustand';
import api from '../services/api.js';

// Singleton audio element
const audio = new Audio();
audio.preload = 'auto';

const useAppStore = create((set, get) => ({
  // Current track info
  currentTrack: null,
  isPlaying: false,
  volume: 0.5,
  progress: 0,
  duration: 0,

  // DJ
  activeDj: 'zh',
  djMessage: null,

  // Queue
  queue: [],

  // ===== Audio element event listeners (set up once) =====
  _audioInitialized: false,

  initAudio: () => {
    const { _audioInitialized } = get();
    if (_audioInitialized) return;

    // Track progress
    audio.addEventListener('timeupdate', () => {
      set({ progress: audio.currentTime, duration: audio.duration || 0 });
    });

    // Auto-skip when song ends
    audio.addEventListener('ended', () => {
      get().skipNext();
    });

    // Handle play/pause state
    audio.addEventListener('play', () => set({ isPlaying: true }));
    audio.addEventListener('pause', () => set({ isPlaying: false }));

    // Handle errors
    audio.addEventListener('error', (e) => {
      console.error('[Audio] Error:', audio.error?.message);
      set({ isPlaying: false });
    });

    set({ _audioInitialized: true });
  },

  // ===== Player actions =====

  /**
   * Play a track with a given URL
   */
  playTrack: (url, trackInfo) => {
    get().initAudio();

    if (trackInfo) {
      set({ currentTrack: trackInfo });
    }

    audio.src = url;
    audio.volume = get().volume;
    audio.play().catch((err) => {
      console.error('[Audio] Play failed:', err);
    });
    set({ isPlaying: true, progress: 0 });
  },

  togglePlay: () => {
    get().initAudio();
    const { isPlaying } = get();

    if (isPlaying) {
      audio.pause();
      api.post('/api/player/pause').catch(console.error);
    } else if (audio.src) {
      audio.play().catch(console.error);
    } else {
      // No track loaded, ask backend to play
      api.post('/api/player/play').then((res) => {
        if (res.data.nowPlaying?.url) {
          get().playTrack(res.data.nowPlaying.url, {
            trackId: res.data.nowPlaying.trackId,
            trackName: res.data.nowPlaying.trackName,
            artist: res.data.nowPlaying.artist,
            albumArt: res.data.nowPlaying.albumArt,
          });
        }
      }).catch(console.error);
      return;
    }
    set({ isPlaying: !isPlaying });
  },

  skipNext: async () => {
    try {
      const res = await api.post('/api/player/skip');
      if (res.data.nowPlaying?.url) {
        const np = res.data.nowPlaying;
        get().playTrack(np.url, {
          trackId: np.trackId,
          trackName: np.trackName,
          artist: np.artist,
          albumArt: np.albumArt,
        });
      } else {
        audio.pause();
        set({ currentTrack: null, isPlaying: false, progress: 0 });
      }
    } catch (err) {
      console.error('Skip next failed:', err);
    }
  },

  skipPrev: () => {
    // Restart current track if progress > 3s, otherwise go to prev
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    }
  },

  setVolume: (vol) => {
    get().initAudio();
    audio.volume = vol;
    set({ volume: vol });
    api.post('/api/player/volume', { volume: vol }).catch(console.error);
  },

  setDjMessage: (message) => set({ djMessage: message }),
  setActiveDj: (dj) => set({ activeDj: dj }),
  setQueue: (queue) => set({ queue }),
  setCurrentTrack: (track) => set({ currentTrack: track }),
  setPlaying: (playing) => set({ isPlaying: playing }),

  /**
   * Refresh queue from server
   */
  refreshQueue: async () => {
    try {
      const res = await api.get('/api/queue');
      set({ queue: res.data.queue || [] });
    } catch (err) {
      console.error('Refresh queue failed:', err);
    }
  },
}));

export default useAppStore;
