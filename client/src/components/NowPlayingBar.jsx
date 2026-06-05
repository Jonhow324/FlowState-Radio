import useAppStore from '../stores/appStore.js';

function NowPlayingBar() {
  const { currentTrack, isPlaying, togglePlay } = useAppStore();

  if (!currentTrack?.trackName) return null;

  return (
    <div className="fixed bottom-16 left-0 right-0 z-40">
      <div className="max-w-lg mx-auto px-3">
        <div className="flex items-center gap-3 bg-slate-800/95 backdrop-blur-md rounded-xl border border-white/10 px-3 py-2.5 shadow-lg">
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
            <p className="text-sm font-medium truncate">{currentTrack.trackName}</p>
            <p className="text-xs text-white/40 truncate">{currentTrack.artist}</p>
          </div>

          {/* Play/Pause button */}
          <button
            onClick={togglePlay}
            className="w-9 h-9 rounded-full bg-claudio-600 flex items-center justify-center shrink-0"
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
          </button>
        </div>
      </div>
    </div>
  );
}

export default NowPlayingBar;
