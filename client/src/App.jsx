import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import NavBar from './components/NavBar.jsx';
import PlayerView from './views/PlayerView.jsx';
import ProfileView from './views/ProfileView.jsx';
import SettingsView from './views/SettingsView.jsx';
import NowPlayingBar from './components/NowPlayingBar.jsx';
import RadioSplash from './components/RadioSplash.jsx';
import useMediaSession from './hooks/useMediaSession.js';
import useWebSocket from './hooks/useWebSocket.js';
import useAppStore from './stores/appStore.js';

const VIEWS = {
  player: PlayerView,
  profile: ProfileView,
  settings: SettingsView,
};

function App() {
  const [activeView, setActiveView] = useState('player');
  const isRadioStarted = useAppStore((s) => s.isRadioStarted);
  const toast = useAppStore((s) => s.toast);
  const ActiveComponent = VIEWS[activeView];

  // Enable system media controls (lock screen, notification bar)
  useMediaSession();

  // Connect WebSocket for real-time events (DJ talk, now-playing, queue updates)
  useWebSocket();

  // Show splash screen until radio is explicitly started
  if (!isRadioStarted) {
    return <RadioSplash />;
  }

  return (
    <div className="min-h-screen flex flex-col max-w-lg mx-auto relative">
      {/* Header */}
      <header className="flex items-center justify-between px-5 pt-6 pb-3">
        <h1 className="text-xl font-bold tracking-tight">
          <span className="text-flowstate-400">FlowState</span>
          <span className="text-white/40 text-sm ml-2 font-normal">FM</span>
        </h1>
        <div className="text-xs text-white/30">AI Radio</div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto pb-36">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeView}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <ActiveComponent />
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Now Playing Bar (shown when not on player view) */}
      <AnimatePresence>
        {activeView !== 'player' && <NowPlayingBar />}
      </AnimatePresence>

      {/* Bottom Navigation */}
      <NavBar activeView={activeView} onViewChange={setActiveView} />

      {/* Toast notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 30 }}
            transition={{ duration: 0.3 }}
            className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50
                       px-5 py-3 rounded-xl max-w-sm text-center
                       bg-black/80 text-white/90 text-sm backdrop-blur-sm
                       shadow-lg pointer-events-none"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;
