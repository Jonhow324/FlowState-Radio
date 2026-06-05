import { motion } from 'framer-motion';
import useAppStore from '../stores/appStore.js';

function Player() {
  const { currentTrack, isPlaying, progress, duration, togglePlay, skipNext, skipPrev } = useAppStore();

  const progressPercent = duration > 0 ? (progress / duration) * 100 : 0;

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return (
    <div className="flex flex-col items-center px-6">
      {/* Album Art */}
      <motion.div
        className="relative w-64 h-64 rounded-2xl overflow-hidden shadow-2xl shadow-claudio-900/50 mb-8"
        animate={isPlaying ? { scale: [1, 1.02, 1] } : { scale: 1 }}
        transition={{ duration: 4, repeat: isPlaying ? Infinity : 0, ease: 'easeInOut' }}
      >
        {currentTrack?.albumArt ? (
          <img
            src={currentTrack.albumArt}
            alt={currentTrack.trackName}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-claudio-800 to-slate-900 flex items-center justify-center">
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

      {/* Track Info */}
      <div className="text-center mb-6 w-full">
        <h2 className="text-lg font-semibold truncate">
          {currentTrack?.trackName || 'Claudio FM'}
        </h2>
        <p className="text-sm text-white/50 truncate">
          {currentTrack?.artist || 'AI Radio DJ'}
        </p>
      </div>

      {/* Progress Bar */}
      <div className="w-full mb-6">
        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-claudio-500 rounded-full"
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
        <button
          onClick={skipPrev}
          className="p-2 text-white/60 hover:text-white transition-colors"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
          </svg>
        </button>

        <button
          onClick={togglePlay}
          className="w-16 h-16 rounded-full bg-claudio-600 hover:bg-claudio-500 
                     flex items-center justify-center transition-all duration-200
                     shadow-lg shadow-claudio-600/30"
        >
          {isPlaying ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
              <polygon points="8 5 19 12 8 19" />
            </svg>
          )}
        </button>

        <button
          onClick={skipNext}
          className="p-2 text-white/60 hover:text-white transition-colors"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default Player;
