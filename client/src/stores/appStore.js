import { create } from 'zustand';

const useAppStore = create((set, get) => ({
  // Current track
  currentTrack: null,
  isPlaying: false,
  volume: 0.5,

  // DJ
  activeDj: 'zh',
  djMessage: null,

  // Queue
  queue: [],

  // Actions
  setCurrentTrack: (track) => set({ currentTrack: track }),

  setPlaying: (playing) => set({ isPlaying: playing }),

  togglePlay: async () => {
    const { isPlaying } = get();
    try {
      if (isPlaying) {
        await import('../services/api.js').then(({ default: api }) =>
          api.post('/api/player/pause')
        );
        set({ isPlaying: false });
      } else {
        await import('../services/api.js').then(({ default: api }) =>
          api.post('/api/player/play')
        );
        set({ isPlaying: true });
      }
    } catch (err) {
      console.error('Toggle play failed:', err);
    }
  },

  skipNext: async () => {
    try {
      await import('../services/api.js').then(({ default: api }) =>
        api.post('/api/player/skip')
      );
    } catch (err) {
      console.error('Skip next failed:', err);
    }
  },

  skipPrev: () => {
    // Phase 1: Simple implementation
    console.log('Skip prev not yet implemented');
  },

  setDjMessage: (message) => set({ djMessage: message }),
  setActiveDj: (dj) => set({ activeDj: dj }),
  setQueue: (queue) => set({ queue }),
  setVolume: (volume) => set({ volume }),
}));

export default useAppStore;
