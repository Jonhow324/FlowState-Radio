import { motion } from 'framer-motion';

function DJMessage({ message }) {
  if (!message) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="mx-6 mb-4"
    >
      <div className="card">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-claudio-700 flex items-center justify-center shrink-0 mt-0.5">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-claudio-300"
            >
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </div>
          <div>
            <p className="text-xs text-claudio-400 font-medium mb-1">DJ Claudio</p>
            <p className="text-sm text-white/80 leading-relaxed">{message}</p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default DJMessage;
