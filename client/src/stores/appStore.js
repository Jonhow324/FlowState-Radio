import { create } from 'zustand';
import api from '../services/api.js';

// Singleton audio element
const audio = new Audio();
audio.preload = 'auto';

// TTS audio element (separate from music)
const ttsAudio = new Audio();
ttsAudio.preload = 'auto';

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
  isSpeaking: false, // Whether TTS is currently playing

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

    // TTS audio events
    ttsAudio.addEventListener('play', () => set({ isSpeaking: true }));
    ttsAudio.addEventListener('ended', () => {
      set({ isSpeaking: false });
      // Resume music after TTS finishes
      if (audio.src && get().isPlaying) {
        audio.play().catch(console.error);
      }
    });
    ttsAudio.addEventListener('error', () => set({ isSpeaking: false }));

    set({ _audioInitialized: true });
  },

  // ===== Player actions =====

  /**
   * Play TTS audio (DJ voice)
   * @param {string} ttsUrl - URL to the TTS mp3 file
   */
  playTTS: (ttsUrl) => {
    if (!ttsUrl) return;
    get().initAudio();

    // Pause music while TTS plays
    const wasPlaying = audio.src && !audio.paused;
    if (wasPlaying) {
      audio.pause();
    }

    ttsAudio.src = ttsUrl;
    ttsAudio.volume = get().volume;
    ttsAudio.play().catch((err) => {
      console.warn('[TTS] Play failed:', err);
      set({ isSpeaking: false });
      // Resume music if TTS fails
      if (wasPlaying) audio.play().catch(console.error);
    });
    set({ isSpeaking: true });
  },

  /**
   * Play DJ talk + song: first TTS, then the track
   * @param {string} ttsUrl - TTS audio URL (can be null)
   * @param {string} trackUrl - Song audio URL
   * @param {object} trackInfo - Track metadata
   */
  playWithTTS: (ttsUrl, trackUrl, trackInfo) => {
    if (ttsUrl) {
      // Set up the track to play after TTS
      get().initAudio();
      audio.src = trackUrl;
      audio.volume = get().volume;
      set({ currentTrack: trackInfo, progress: 0 });

      // Play TTS first; the 'ended' event will resume audio
      ttsAudio.src = ttsUrl;
      ttsAudio.volume = get().volume;
      ttsAudio.play().catch((err) => {
        console.warn('[TTS] Play failed, playing track directly:', err);
        audio.play().catch(console.error);
        set({ isPlaying: true, isSpeaking: false });
      });
      set({ isSpeaking: true, isPlaying: true });
    } else {
      // No TTS, play track directly
      get().playTrack(trackUrl, trackInfo);
    }
  },

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
