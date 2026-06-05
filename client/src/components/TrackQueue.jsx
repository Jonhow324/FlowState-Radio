import { useEffect } from 'react';
import useAppStore from '../stores/appStore.js';

function TrackQueue() {
  const { queue, refreshQueue } = useAppStore();

  // Refresh queue every 5 seconds
  useEffect(() => {
    refreshQueue();
    const interval = setInterval(refreshQueue, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!queue || queue.length === 0) {
    return (
      <div className="mx-6 mb-4">
        <div className="card">
          <p className="text-sm text-white/40 text-center">播放队列为空</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-6 mb-4">
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-white/70">播放队列</h3>
          <span className="text-xs text-white/30">{queue.length} 首</span>
        </div>
        <div className="space-y-2">
          {queue.map((track, index) => (
            <div
              key={`${track.trackId}-${index}`}
              className="flex items-center gap-3 py-1.5"
            >
              <span className="text-xs text-white/20 w-5 text-right">{index + 1}</span>
              {track.albumArt && (
                <img
                  src={track.albumArt}
                  alt=""
                  className="w-8 h-8 rounded-md object-cover"
                />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{track.trackName || 'Unknown'}</p>
                <p className="text-xs text-white/40 truncate">{track.artist || 'Unknown'}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default TrackQueue;
