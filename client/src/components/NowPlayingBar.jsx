import { motion } from 'framer-motion';
import useAppStore from '../stores/appStore.js';

function NowPlayingBar() {
  const { currentTrack, isPlaying, togglePlay, progress, duration } = useAppStore();

  if (!currentTrack?.trackName) return null;

  const progressPercent = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <motion.div
      className="fixed bottom-16 left-0 right-0 z-40"
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 80, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 28 }}
    >
      <div className="max-w-lg mx-auto px-3">
        <div className="relative flex items-center gap-3 bg-slate-800/95 backdrop-blur-md rounded-xl border border-white/10 px-3 py-2.5 shadow-lg overflow-hidden">
          {/* Mini progress bar at top */}
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-white/5">
            <motion.div
              className="h-full bg-claudio-500/60"
              style={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>

          {/* Album art thumbnail */}
          <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-white/5">
            {currentTrack.albumArt ? (
              <img
                src={currentTrack.albumArt}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-white/20"
                >
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </div>
            )}
          </div>

          {/* Track info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {isPlaying && <PlayingIndicator />}
              <p className="text-sm font-medium truncate">{currentTrack.trackName}</p>
            </div>
            <p className="text-xs text-white/40 truncate">{currentTrack.artist}</p>
          </div>

          {/* Play/Pause button */}
          <motion.button
            onClick={togglePlay}
            className="w-9 h-9 rounded-full bg-claudio-600 flex items-center justify-center shrink-0"
            whileTap={{ scale: 0.88 }}
          >
            {isPlaying ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                <polygon points="8 5 19 12 8 19" />
              </svg>
            )}
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}

/* Animated equalizer bars shown when music is playing */
function PlayingIndicator() {
  return (
    <div className="flex items-end gap-[2px] h-3 shrink-0">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-[2px] bg-claudio-400 rounded-full"
          animate={{ height: ['30%', '100%', '50%', '80%', '30%'] }}
          transition={{
            duration: 0.8,
            repeat: Infinity,
            delay: i * 0.15,
            ease: 'easeInOut',
          }}
        />
      ))}
    </div>
  );
}

export default NowPlayingBar;
