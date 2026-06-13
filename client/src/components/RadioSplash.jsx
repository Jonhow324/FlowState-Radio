import { useState } from 'react';
import { motion } from 'framer-motion';
import useAppStore from '../stores/appStore.js';

function RadioSplash() {
  const [isStarting, setIsStarting] = useState(false);
  const startRadio = useAppStore((s) => s.startRadio);

  const handleStart = () => {
    setIsStarting(true);

    // Pre-create and unlock audio element during user gesture
    // (Browsers require audio.play() to originate from a user interaction)
    const el = new Audio();
    el.src = 'data:audio/mp3;base64,SUQzBAAAAAA=';
    el.volume = 0;
    el.play().catch(() => {});
    useAppStore.setState({ _welcomeAudioEl: el });

    startRadio();
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
    >
      {/* Ambient glow */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full opacity-10"
          style={{
            background: 'radial-gradient(circle, rgba(168,85,247,0.4) 0%, transparent 70%)',
          }}
        />
      </div>

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-8">
        {/* Radio icon */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.6 }}
          className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center"
        >
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-purple-400"
          >
            <path d="M4.93 19.07A10 10 0 0 1 4.93 4.93" />
            <path d="M7.76 16.24A6 6 0 0 1 7.76 7.76" />
            <circle cx="12" cy="12" r="2" fill="currentColor" />
            <path d="M16.24 7.76A6 6 0 0 1 16.24 16.24" />
            <path d="M19.07 4.93A10 10 0 0 1 19.07 19.07" />
          </svg>
        </motion.div>

        {/* Title */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="text-center"
        >
          <h1 className="text-3xl font-bold tracking-tight">
            <span className="text-purple-400">FlowState</span>
            <span className="text-white/30 text-lg ml-2 font-light">FM</span>
          </h1>
          <p className="text-white/25 text-sm mt-2">Your personal AI radio</p>
        </motion.div>

        {/* Start button */}
        <motion.button
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.5 }}
          onClick={handleStart}
          disabled={isStarting}
          className="mt-4 px-8 py-3 rounded-full bg-purple-500/20 border border-purple-500/30
                     text-purple-300 text-sm font-medium tracking-wide
                     hover:bg-purple-500/30 hover:border-purple-500/50
                     active:scale-95 transition-all duration-200
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isStarting ? (
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
              启动中...
            </span>
          ) : (
            '开启电台'
          )}
        </motion.button>
      </div>

      {/* Footer */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1, duration: 0.5 }}
        className="absolute bottom-8 text-white/15 text-xs"
      >
        AI Powered Radio
      </motion.div>
    </motion.div>
  );
}

export default RadioSplash;
