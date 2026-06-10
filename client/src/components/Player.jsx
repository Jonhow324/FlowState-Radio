import { motion, AnimatePresence } from 'framer-motion';
import useAppStore from '../stores/appStore.js';

function Player() {
  const { currentTrack, isPlaying, progress, duration, togglePlay, skipNext, skipPrev } = useAppStore();

  const progressPercent = duration > 0 ? (progress / duration) * 100 : 0;
  const trackKey = currentTrack?.trackId || 'empty';

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return (
    <div className="flex flex-col items-center px-6">
      {/* Album Art with breathing glow */}
      <div className="relative mb-8">
        {/* Glow ring — pulses when playing */}
        <motion.div
          className="absolute -inset-3 rounded-3xl"
          animate={isPlaying
            ? { boxShadow: [
                '0 0 20px 2px rgba(139,92,246,0.15)',
                '0 0 40px 8px rgba(139,92,246,0.30)',
                '0 0 20px 2px rgba(139,92,246,0.15)',
              ]}
            : { boxShadow: '0 0 0px 0px rgba(139,92,246,0)' }
          }
          transition={{ duration: 3, repeat: isPlaying ? Infinity : 0, ease: 'easeInOut' }}
        />

        {/* Album art container */}
        <motion.div
          className="relative w-64 h-64 rounded-2xl overflow-hidden shadow-2xl shadow-flowstate-900/50"
          animate={isPlaying ? { scale: [1, 1.015, 1] } : { scale: 1 }}
          transition={{ duration: 4, repeat: isPlaying ? Infinity : 0, ease: 'easeInOut' }}
        >
          <AnimatePresence mode="popLayout">
            <motion.div
              key={trackKey}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.05 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="absolute inset-0"
            >
              {currentTrack?.albumArt ? (
                <img
                  src={currentTrack.albumArt}
                  alt={currentTrack.trackName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-flowstate-800 to-slate-900 flex items-center justify-center">
                  <svg
                    width="64"
                    height="64"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    className="text-white/20"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="3" />
                    <line x1="12" y1="2" x2="12" y2="5" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Subtle gradient overlay for depth */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent pointer-events-none" />
        </motion.div>
      </div>

      {/* Track Info — crossfade on track change */}
      <div className="text-center mb-6 w-full">
        <AnimatePresence mode="wait">
          <motion.div key={trackKey} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
            <h2 className="text-lg font-semibold truncate">
              {currentTrack?.trackName || 'FlowState FM'}
            </h2>
            <p className="text-sm text-white/50 truncate">
              {currentTrack?.artist || 'AI Radio DJ'}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Progress Bar */}
      <div className="w-full mb-6">
        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-flowstate-500 rounded-full"
            style={{ width: `${progressPercent}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
        <div className="flex justify-between text-xs text-white/30 mt-1">
          <span>{formatTime(progress)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-8">
        <motion.button
          onClick={skipPrev}
          className="p-2 text-white/60 hover:text-white transition-colors"
          whileTap={{ scale: 0.85 }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
          </svg>
        </motion.button>

        <motion.button
          onClick={togglePlay}
          className="w-16 h-16 rounded-full bg-flowstate-600 hover:bg-flowstate-500 
                     flex items-center justify-center
                     shadow-lg shadow-flowstate-600/30"
          whileTap={{ scale: 0.9 }}
          whileHover={{ scale: 1.05 }}
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
        >
          <AnimatePresence mode="wait">
            {isPlaying ? (
              <motion.svg
                key="pause"
                width="24" height="24" viewBox="0 0 24 24" fill="white"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </motion.svg>
            ) : (
              <motion.svg
                key="play"
                width="24" height="24" viewBox="0 0 24 24" fill="white"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <polygon points="8 5 19 12 8 19" />
              </motion.svg>
            )}
          </AnimatePresence>
        </motion.button>

        <motion.button
          onClick={skipNext}
          className="p-2 text-white/60 hover:text-white transition-colors"
          whileTap={{ scale: 0.85 }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </motion.button>
      </div>
    </div>
  );
}

export default Player;
