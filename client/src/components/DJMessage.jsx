import { motion, AnimatePresence } from 'framer-motion';
import useAppStore from '../stores/appStore.js';

function DJMessage({ message }) {
  const isSpeaking = useAppStore((s) => s.isSpeaking);

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          key={message}
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.97 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="mx-6 mb-4"
        >
          <motion.div
            className="card relative overflow-hidden"
            animate={isSpeaking
              ? { boxShadow: [
                  '0 0 0px 0px rgba(74,222,128,0)',
                  '0 0 12px 2px rgba(74,222,128,0.2)',
                  '0 0 0px 0px rgba(74,222,128,0)',
                ]}
              : {}
            }
            transition={{ duration: 2, repeat: isSpeaking ? Infinity : 0, ease: 'easeInOut' }}
          >
            {/* Speaking glow bar at top */}
            {isSpeaking && (
              <motion.div
                className="absolute top-0 left-0 right-0 h-0.5 bg-green-400/60"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: [0, 1, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}

            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-flowstate-700 flex items-center justify-center shrink-0 mt-0.5 relative">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-flowstate-300"
                >
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
                {isSpeaking && (
                  <motion.span
                    className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-400 rounded-full"
                    animate={{ scale: [1, 1.3, 1], opacity: [1, 0.7, 1] }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-xs text-flowstate-400 font-medium">DJ FlowState</p>
                  {isSpeaking && (
                    <motion.span
                      className="text-[10px] text-green-400"
                      animate={{ opacity: [1, 0.4, 1] }}
                      transition={{ duration: 1.2, repeat: Infinity }}
                    >
                      speaking...
                    </motion.span>
                  )}
                </div>
                <motion.p
                  className="text-sm text-white/80 leading-relaxed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.1, duration: 0.3 }}
                >
                  {message}
                </motion.p>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default DJMessage;
