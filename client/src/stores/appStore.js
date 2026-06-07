import { create } from 'zustand';
import api from '../services/api.js';

// Singleton audio element
const audio = new Audio();
audio.preload = 'auto';

// TTS audio element (separate from music)
const ttsAudio = new Audio();
ttsAudio.preload = 'auto';

// ===== Ducking Engine =====
// When DJ speaks, music ducks (lowers volume); fades back up when DJ finishes
const DUCK_LEVEL = 0.15;    // Music volume multiplier while DJ speaks (15%)
const FADE_MS = 600;        // Fade transition duration in ms
const FADE_STEP = 30;       // Volume update interval in ms

let _duckTimer = null;        // Active fade timer
let _ducking = false;         // Whether music is currently ducked
let _savedVolume = 0.5;       // User's volume before ducking

/**
 * Smoothly fade music volume down to duck level.
 * Called when DJ starts speaking.
 */
function _duckDown() {
  const vol = audio.volume || 0.5;
  _savedVolume = vol;
  _ducking = true;
  const target = vol * DUCK_LEVEL;
  const steps = Math.max(1, Math.round(FADE_MS / FADE_STEP));
  const delta = (vol - target) / steps;

  if (_duckTimer) clearInterval(_duckTimer);
  let step = 0;
  _duckTimer = setInterval(() => {
    step++;
    if (step >= steps) {
      audio.volume = target;
      clearInterval(_duckTimer);
      _duckTimer = null;
    } else {
      audio.volume = Math.max(target, vol - delta * step);
    }
  }, FADE_STEP);
}

/**
 * Smoothly fade music volume back up to normal.
 * Called when DJ finishes speaking.
 */
function _fadeMusicUp() {
  if (_duckTimer) clearInterval(_duckTimer);
  const target = _savedVolume;
  const current = audio.volume;
  const steps = Math.max(1, Math.round(FADE_MS / FADE_STEP));
  const delta = (target - current) / steps;

  let step = 0;
  _duckTimer = setInterval(() => {
    step++;
    if (step >= steps) {
      audio.volume = target;
      clearInterval(_duckTimer);
      _duckTimer = null;
      _ducking = false;
    } else {
      audio.volume = Math.min(target, current + delta * step);
    }
  }, FADE_STEP);
}

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
  isDucking: false,  // Whether music is currently ducked for DJ voice

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

    // TTS audio events — ducking-based radio effect
    ttsAudio.addEventListener('play', () => {
      set({ isSpeaking: true });
    });
    ttsAudio.addEventListener('ended', () => {
      set({ isSpeaking: false });
      // Fade music back up when DJ finishes speaking
      _fadeMusicUp();
    });
    ttsAudio.addEventListener('error', () => {
      set({ isSpeaking: false });
      // Restore music if TTS fails
      if (_ducking) _fadeMusicUp();
    });

    set({ _audioInitialized: true });
  },

  // ===== Player actions =====

  /**
   * Play TTS audio (DJ voice) with ducking effect
   * Music continues playing at reduced volume while DJ speaks
   * @param {string} ttsUrl - URL to the TTS mp3 file
   */
  playTTS: (ttsUrl) => {
    if (!ttsUrl) return;
    get().initAudio();

    const musicIsPlaying = audio.src && !audio.paused;

    // Duck music volume if music is currently playing
    if (musicIsPlaying) {
      _duckDown();
    }

    ttsAudio.src = ttsUrl;
    ttsAudio.volume = get().volume;
    ttsAudio.play().catch((err) => {
      console.warn('[TTS] Play failed:', err);
      set({ isSpeaking: false });
      // Fade music back up if TTS fails
      if (musicIsPlaying && _ducking) _fadeMusicUp();
    });
    set({ isSpeaking: true });
  },

  /**
   * Play DJ talk + song with ducking radio effect:
   * 1. Start the new track at ducked volume
   * 2. Play TTS voice over the ducked music
   * 3. When TTS ends, music gradually fades up to full volume
   * @param {string} ttsUrl - TTS audio URL (can be null)
   * @param {string} trackUrl - Song audio URL
   * @param {object} trackInfo - Track metadata
   */
  playWithTTS: (ttsUrl, trackUrl, trackInfo) => {
    if (ttsUrl) {
      get().initAudio();

      // Start the new track at ducked volume under the DJ voice
      const vol = get().volume;
      _savedVolume = vol;
      audio.src = trackUrl;
      audio.volume = vol * DUCK_LEVEL;
      audio.play().catch(console.error);

      set({ currentTrack: trackInfo, progress: 0, isPlaying: true });

      // Play TTS voice — when it ends, the 'ended' listener calls _fadeMusicUp
      ttsAudio.src = ttsUrl;
      ttsAudio.volume = vol;
      ttsAudio.play().catch((err) => {
        console.warn('[TTS] Play failed, fading music up:', err);
        audio.volume = vol;
        set({ isSpeaking: false });
      });
      _ducking = true;
      set({ isSpeaking: true, isDucking: true });
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
      // If ducked, also restore volume so it's correct when user resumes
      if (_ducking) {
        if (_duckTimer) clearInterval(_duckTimer);
        _ducking = false;
        audio.volume = _savedVolume;
        set({ isDucking: false });
      }
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
    // Clean up ducking state on skip
    if (_ducking) {
      if (_duckTimer) clearInterval(_duckTimer);
      _ducking = false;
      audio.volume = _savedVolume;
    }
    // Stop any playing TTS
    if (!ttsAudio.paused) {
      ttsAudio.pause();
      ttsAudio.src = '';
      set({ isSpeaking: false, isDucking: false });
    }
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
    // If currently ducked, keep music at ducked level relative to new volume
    if (_ducking) {
      _savedVolume = vol;
      audio.volume = vol * DUCK_LEVEL;
    } else {
      audio.volume = vol;
    }
    ttsAudio.volume = vol;
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
