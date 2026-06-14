import { create } from 'zustand';
import api from '../services/api.js';
import wsClient from '../services/ws.js';

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
const SEGUE_LEAD_S = 15;    // Seconds before song end to start outro talk

let _duckTimer = null;        // Active fade timer
let _ducking = false;         // Whether music is currently ducked
let _savedVolume = 0.5;       // User's volume before ducking
let _outroTalkDone = false;   // Whether outro bridge talk was played for current song

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

  // Nothing to fade — just restore volume directly
  if (Math.abs(target - current) < 0.01) {
    audio.volume = target;
    _ducking = false;
    return;
  }

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
  // Radio state
  isRadioStarted: false,
  welcomeAudioUrl: null,
  _welcomeAudioEl: null, // Pre-unlocked audio element from user click

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
  lastFillerType: null, // 'gap' | 'stretch' | 'transition' | 'weather' | 'bridge'
  transitionStyle: 'none', // 'intro' | 'outro' | 'none'

  // Segments (Phase 1: bridge + cold_open storage; Phase 2: afterTrack playback)
  pendingSegments: [],

  // Queue
  queue: [],

  // ===== Audio element event listeners (set up once) =====
  _audioInitialized: false,

  initAudio: () => {
    const { _audioInitialized } = get();
    if (_audioInitialized) return;

    // Track progress + check segue window
    audio.addEventListener('timeupdate', () => {
      set({ progress: audio.currentTime, duration: audio.duration || 0 });

      // Segue window: check if we should start outro talk
      const remaining = (audio.duration || 0) - audio.currentTime;
      if (remaining > 0 && remaining <= SEGUE_LEAD_S && !_outroTalkDone) {
        get().trySegueOutro();
      }
    });

    // Auto-skip when song ends (with optional afterTrack segment)
    audio.addEventListener('ended', () => {
      // If outro talk was already played during segue window, skip directly
      if (_outroTalkDone) {
        _outroTalkDone = false;
        get().skipNext(true);
        return;
      }

      const afterSeg = get().getAfterTrackSegment();
      if (afterSeg && afterSeg.ttsUrl) {
        // Phase 2: Play back_announce commentary, then skip to next track
        get().removeSegment(afterSeg.id);
        set({ isSpeaking: true });

        const cleanup = () => {
          ttsAudio.removeEventListener('ended', onAfterEnded);
          ttsAudio.removeEventListener('error', onAfterError);
        };

        const onAfterEnded = () => {
          cleanup();
          set({ isSpeaking: false });
          get().skipNext();
        };

        const onAfterError = () => {
          cleanup();
          set({ isSpeaking: false });
          // TTS failed — skip to next track immediately
          get().skipNext();
        };

        ttsAudio.addEventListener('ended', onAfterEnded);
        ttsAudio.addEventListener('error', onAfterError);

        // Play afterTrack TTS (no music playing at this point, so no ducking)
        ttsAudio.src = afterSeg.ttsUrl;
        ttsAudio.volume = get().volume;
        ttsAudio.play().catch(() => {
          cleanup();
          set({ isSpeaking: false });
          get().skipNext();
        });
      } else {
        get().skipNext();
      }
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
      // Safety: always clear ducking flag after TTS ends
      _ducking = false;
      set({ isDucking: false });
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

    // Cancel any pending fade-up before starting a new duck
    if (_duckTimer) {
      clearInterval(_duckTimer);
      _duckTimer = null;
    }

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
   *
   * Intro mode (default):
   *   1. Start the new track at ducked volume (intro playing softly)
   *   2. Play TTS voice over the ducked music
   *   3. When TTS ends, music gradually fades up to full volume
   *
   * Outro mode:
   *   1. Duck the currently playing song's outro
   *   2. Play TTS voice over the ducked outro
   *   3. When TTS ends, crossfade: old song fades out, new song fades in
   *
   * @param {string} ttsUrl - TTS audio URL (can be null)
   * @param {string} trackUrl - Song audio URL
   * @param {object} trackInfo - Track metadata
   * @param {string} [mode='intro'] - 'intro' or 'outro'
   */
  playWithTTS: (ttsUrl, trackUrl, trackInfo, mode = 'intro') => {
    _outroTalkDone = false;
    if (ttsUrl) {
      get().initAudio();
      const vol = get().volume;
      const musicIsPlaying = audio.src && !audio.paused;

      if (mode === 'outro' && musicIsPlaying) {
        // ── Outro Mode: Duck current song, play TTS, then crossfade ──
        _savedVolume = vol;
        _duckDown(); // Fade current song to duck level
        set({ transitionStyle: 'outro', isSpeaking: true, isDucking: true });

        // When TTS ends, do crossfade: stop old, start new
        const onTtsEnded = () => {
          ttsAudio.removeEventListener('ended', onTtsEnded);
          ttsAudio.removeEventListener('error', onTtsError);

          // Crossfade: old song out, new song in
          audio.pause();
          audio.src = trackUrl;
          audio.volume = 0;
          audio.play().catch(console.error);
          set({ currentTrack: trackInfo, progress: 0, isPlaying: true, transitionStyle: 'none' });

          // Fade new song in
          const steps = Math.max(1, Math.round(FADE_MS / FADE_STEP));
          const delta = vol / steps;
          if (_duckTimer) clearInterval(_duckTimer);
          let step = 0;
          _duckTimer = setInterval(() => {
            step++;
            if (step >= steps) {
              audio.volume = vol;
              clearInterval(_duckTimer);
              _duckTimer = null;
              _ducking = false;
              set({ isSpeaking: false, isDucking: false });
            } else {
              audio.volume = Math.min(vol, delta * step);
            }
          }, FADE_STEP);
        };

        const onTtsError = () => {
          ttsAudio.removeEventListener('ended', onTtsEnded);
          ttsAudio.removeEventListener('error', onTtsError);
          // Fallback: just play the new song
          _fadeMusicUp();
          audio.src = trackUrl;
          audio.volume = vol;
          audio.play().catch(console.error);
          set({ currentTrack: trackInfo, progress: 0, isPlaying: true, isSpeaking: false, transitionStyle: 'none' });
        };

        ttsAudio.addEventListener('ended', onTtsEnded);
        ttsAudio.addEventListener('error', onTtsError);

        // Play TTS
        ttsAudio.src = ttsUrl;
        ttsAudio.volume = vol;
        ttsAudio.play().catch(onTtsError);

      } else {
        // ── Intro Mode (default): New song starts ducked, TTS over it, fade up ──
        _savedVolume = vol;
        audio.src = trackUrl;
        audio.volume = vol * DUCK_LEVEL;
        audio.play().catch(console.error);

        set({ currentTrack: trackInfo, progress: 0, isPlaying: true, transitionStyle: 'intro' });

        // Play TTS voice — when it ends, the 'ended' listener calls _fadeMusicUp
        ttsAudio.src = ttsUrl;
        ttsAudio.volume = vol;
        ttsAudio.play().catch((err) => {
          console.warn('[TTS] Play failed, fading music up:', err);
          _ducking = false;
          audio.volume = vol;
          set({ isSpeaking: false, isDucking: false, transitionStyle: 'none' });
        });
        _ducking = true;
        set({ isSpeaking: true, isDucking: true });
      }
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
    _outroTalkDone = false;

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

  skipNext: async (bridgePlayed = false) => {
    // Clean up ducking state on skip
    _outroTalkDone = false;
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
      const res = await api.post('/api/player/skip', { bridgePlayed });
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
    _outroTalkDone = false;
    // Restart current track if progress > 3s, otherwise go to prev
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    }
  },

  setVolume: (vol) => {
    get().initAudio();
    // Auto-recover from stale ducking (TTS ended/failed but flag stuck)
    if (_ducking && ttsAudio.paused) {
      if (_duckTimer) clearInterval(_duckTimer);
      _duckTimer = null;
      _ducking = false;
      set({ isDucking: false });
    }
    // If currently ducked (and TTS still playing), keep ducked relative to new volume
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
  setFillerType: (type) => set({ lastFillerType: type }),
  setQueue: (queue) => set({ queue }),
  setCurrentTrack: (track) => set({ currentTrack: track }),
  setPlaying: (playing) => set({ isPlaying: playing }),

  // ── Segment Actions (Phase 1) ──────────────────────────────
  /**
   * Store a segment received via WebSocket.
   * Segments are kept in memory for later playback (bridge, afterTrack, etc.)
   */
  addPendingSegment: (segment) => {
    const { pendingSegments } = get();
    // Avoid duplicates by segment id
    const exists = pendingSegments.some(s => s.id === segment.id);
    if (!exists) {
      set({ pendingSegments: [...pendingSegments, segment] });
    }
  },

  /**
   * Find an afterTrack / back_announce segment with ready TTS.
   * Used on audio 'ended' to decide whether to play commentary before skipping.
   * Returns the segment or null.
   */
  getAfterTrackSegment: () => {
    const { pendingSegments, currentTrack } = get();
    const candidates = pendingSegments.filter(
      s => (s.position === 'after_track' || s.type === 'back_announce') && s.ttsUrl && s.ttsStatus === 'ready'
    );
    if (candidates.length === 0) return null;
    // If metadata has prevSong info, match against current track to avoid playing wrong segment
    if (currentTrack) {
      const matched = candidates.find(s => {
        if (!s.metadata?.prevSong) return true; // No metadata, accept as candidate
        const segName = (s.metadata.prevSong.name || '').toLowerCase();
        const curName = (currentTrack.trackName || '').toLowerCase();
        return segName && curName && segName === curName;
      });
      return matched || candidates[0];
    }
    return candidates[0];
  },

  /**
   * Remove a segment by id (after it's been consumed).
   */
  removeSegment: (segmentId) => {
    const { pendingSegments } = get();
    set({ pendingSegments: pendingSegments.filter(s => s.id !== segmentId) });
  },

  /**
   * Find a ready bridge segment for the current song gap.
   * Matches by prevSong metadata against the current track.
   * Returns the segment or null.
   */
  getBridgeSegment: () => {
    const { pendingSegments, currentTrack } = get();
    const bridges = pendingSegments.filter(
      s => s.type === 'bridge' && s.ttsUrl && s.ttsStatus === 'ready'
    );
    if (bridges.length === 0) return null;
    if (currentTrack) {
      const matched = bridges.find(s => {
        if (!s.metadata?.prevSong) return true;
        const segName = (s.metadata.prevSong.name || '').toLowerCase();
        const curName = (currentTrack.trackName || '').toLowerCase();
        return segName && curName && segName === curName;
      });
      return matched || null;
    }
    return null;
  },

  /**
   * Try to start outro talk if in the segue window and a bridge segment is ready.
   * Called from timeupdate handler and segment-ready WebSocket handler.
   */
  trySegueOutro: () => {
    if (_outroTalkDone || get().isSpeaking) return;

    const remaining = (audio.duration || 0) - audio.currentTime;
    if (remaining > SEGUE_LEAD_S || remaining <= 0) return;
    if (!audio.src || audio.paused) return;

    const bridge = get().getBridgeSegment();
    if (!bridge) return;

    get()._startOutroTalk(bridge);
  },

  /**
   * Play bridge TTS over the ducked outro of the current song.
   * When TTS ends, fade music up and skip to next track.
   * @param {object} bridge - The bridge segment with ttsUrl
   */
  _startOutroTalk: (bridge) => {
    _outroTalkDone = true;
    get().removeSegment(bridge.id);
    set({ isSpeaking: true, isDucking: true });

    _savedVolume = get().volume;
    _duckDown();
    set({ djMessage: bridge.text });

    const cleanup = () => {
      ttsAudio.removeEventListener('ended', onEnded);
      ttsAudio.removeEventListener('error', onError);
    };

    const finishTransition = () => {
      // Clear any ongoing fade, restore volume immediately, then skip
      if (_duckTimer) {
        clearInterval(_duckTimer);
        _duckTimer = null;
      }
      _ducking = false;
      audio.volume = _savedVolume;
      set({ isSpeaking: false, isDucking: false });
      get().skipNext(true);
    };

    const onEnded = () => {
      cleanup();
      finishTransition();
    };

    const onError = () => {
      cleanup();
      finishTransition();
    };

    ttsAudio.addEventListener('ended', onEnded);
    ttsAudio.addEventListener('error', onError);

    ttsAudio.src = bridge.ttsUrl;
    ttsAudio.volume = get().volume;
    ttsAudio.play().catch(() => {
      cleanup();
      _outroTalkDone = false;
      _ducking = false;
      audio.volume = _savedVolume;
      set({ isSpeaking: false, isDucking: false });
    });
  },

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

  // ── Radio Actions ──────────────────────────────────────────
  /**
   * Send start-radio signal to backend via WebSocket.
   */
  startRadio: () => {
    wsClient.send({ type: 'start-radio' });
  },

  /**
   * Handle radio-started event from backend.
   * Plays welcome audio, loads queue, marks radio as started.
   */
  handleRadioStarted: (data) => {
    set({ isRadioStarted: true, queue: data.queue || [] });

    // Play welcome audio using pre-unlocked element (from user click)
    if (data.welcomeAudio) {
      const welcomeUrl = `${window.location.origin}${data.welcomeAudio}`;
      const el = get()._welcomeAudioEl;
      if (el) {
        el.src = welcomeUrl;
        el.volume = get().volume;
        el.play().catch(() => {});
        el.onended = () => {
          set({ djMessage: 'FlowState Radio is on the air.' });
        };
      } else {
        // Fallback: no pre-unlocked element, try creating new one (may be blocked)
        const welcomeAudio = new Audio(welcomeUrl);
        welcomeAudio.volume = get().volume;
        welcomeAudio.play().catch(() => {});
        welcomeAudio.onended = () => {
          set({ djMessage: 'FlowState Radio is on the air.' });
        };
      }
    } else {
      set({ djMessage: 'FlowState Radio is on the air.' });
    }
  },
}));

export default useAppStore;
