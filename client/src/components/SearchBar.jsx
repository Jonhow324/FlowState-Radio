import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api.js';
import useAppStore from '../stores/appStore.js';

function SearchBar() {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const debounceRef = useRef(null);

  // Auto-search with debounce
  useEffect(() => {
    if (!keyword.trim()) {
      setResults([]);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await api.get('/api/search', { params: { keyword: keyword.trim(), limit: 8 } });
        setResults(res.data.results || []);
        setIsExpanded(true);
      } catch (err) {
        console.error('Search failed:', err);
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [keyword]);

  return (
    <div className="mx-6 mb-4 relative">
      {/* Search input */}
      <div className="flex items-center gap-2 bg-white/5 rounded-full border border-white/10 px-4 py-2.5">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-white/30 shrink-0"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onFocus={() => results.length > 0 && setIsExpanded(true)}
          placeholder="搜索歌曲..."
          className="flex-1 bg-transparent text-sm text-white placeholder-white/30 outline-none"
        />
        {isSearching && (
          <div className="w-4 h-4 border-2 border-claudio-500 border-t-transparent rounded-full animate-spin" />
        )}
        {keyword && (
          <button
            onClick={() => { setKeyword(''); setResults([]); setIsExpanded(false); }}
            className="text-white/30 hover:text-white/60"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        )}
      </div>

      {/* Search results dropdown */}
      <AnimatePresence>
        {isExpanded && results.length > 0 && (
          <>
            {/* Backdrop to close dropdown */}
            <motion.div
              className="fixed inset-0 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsExpanded(false)}
            />
            <motion.div
              className="absolute left-0 right-0 top-full mt-2 z-50"
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <div className="bg-slate-900/98 backdrop-blur-md rounded-xl border border-white/10 shadow-2xl overflow-hidden">
                <div className="max-h-80 overflow-y-auto">
                  {results.map((track, i) => (
                    <motion.div
                      key={track.trackId}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.04, duration: 0.2 }}
                    >
                      <SearchResultItem
                        track={track}
                        onSelect={() => setIsExpanded(false)}
                      />
                    </motion.div>
                  ))}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function SearchResultItem({ track, onSelect }) {
  const [isAdding, setIsAdding] = useState(false);
  const playTrack = useAppStore((s) => s.playTrack);
  const refreshQueue = useAppStore((s) => s.refreshQueue);

  const handlePlay = async () => {
    if (isAdding) return;
    setIsAdding(true);
    try {
      const res = await api.post('/api/song/add', { trackIds: [track.trackId], playNow: true });
      const np = res.data.playNow;
      if (np?.url) {
        playTrack(np.url, {
          trackId: np.trackId,
          trackName: np.trackName,
          artist: np.artist,
          albumArt: np.albumArt,
        });
      }
      refreshQueue();
      onSelect();
    } catch (err) {
      console.error('Failed to play track:', err);
    } finally {
      setIsAdding(false);
    }
  };

  const handleAddToQueue = async () => {
    if (isAdding) return;
    setIsAdding(true);
    try {
      await api.post('/api/song/add', { trackIds: [track.trackId], playNow: false });
      refreshQueue();
    } catch (err) {
      console.error('Failed to add to queue:', err);
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors group">
      {/* Play button */}
      <button
        onClick={handlePlay}
        disabled={isAdding}
        className="w-8 h-8 rounded-full bg-claudio-600 hover:bg-claudio-500 
                   flex items-center justify-center shrink-0 transition-colors"
      >
        {isAdding ? (
          <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
            <polygon points="8 5 19 12 8 19" />
          </svg>
        )}
      </button>

      {/* Track info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{track.trackName}</p>
        <p className="text-xs text-white/40 truncate">
          {track.artist}
          {track.album && ` · ${track.album}`}
        </p>
      </div>

      {/* Duration */}
      <span className="text-xs text-white/20 shrink-0">
        {track.duration ? `${Math.floor(track.duration / 60)}:${String(track.duration % 60).padStart(2, '0')}` : ''}
      </span>

      {/* Add to queue button */}
      <button
        onClick={handleAddToQueue}
        disabled={isAdding}
        className="opacity-0 group-hover:opacity-100 p-1.5 text-white/30 hover:text-claudio-400 
                   transition-all"
        title="加入队列"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}

export default SearchBar;
