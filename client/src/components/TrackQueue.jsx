import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import useAppStore from '../stores/appStore.js';

const listItem = {
  hidden: { opacity: 0, x: -12 },
  visible: (i) => ({
    opacity: 1,
    x: 0,
    transition: { delay: i * 0.05, duration: 0.25, ease: 'easeOut' },
  }),
  exit: { opacity: 0, x: 12, transition: { duration: 0.15 } },
};

function TrackQueue() {
  const queue = useAppStore((s) => s.queue);
  const [expanded, setExpanded] = useState(true);

  // Queue is driven by WebSocket: initial load via radio-started, updates via queue-update

  if (!queue || queue.length === 0) {
    return (
      <motion.div
        className="mx-6 mb-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <div className="card">
          <p className="text-sm text-white/40 text-center">播放队列为空</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="mx-6 mb-4"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="card">
        {/* Header — toggle expand/collapse */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center justify-between w-full mb-1"
        >
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-white/70">播放队列</h3>
            <span className="text-xs text-white/30">{queue.length} 首</span>
          </div>
          <motion.svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-white/30"
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
          >
            <polyline points="6 9 12 15 18 9" />
          </motion.svg>
        </button>

        {/* Collapsible list */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="queue-list"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              <div className="space-y-2 pt-2">
                <AnimatePresence>
                  {queue.map((track, index) => (
                    <motion.div
                      key={`${track.trackId}-${index}`}
                      custom={index}
                      variants={listItem}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      layout
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
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

export default TrackQueue;
