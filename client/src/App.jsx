import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import NavBar from './components/NavBar.jsx';
import PlayerView from './views/PlayerView.jsx';
import ProfileView from './views/ProfileView.jsx';
import SettingsView from './views/SettingsView.jsx';
import NowPlayingBar from './components/NowPlayingBar.jsx';
import useMediaSession from './hooks/useMediaSession.js';

const VIEWS = {
  player: PlayerView,
  profile: ProfileView,
  settings: SettingsView,
};

function App() {
  const [activeView, setActiveView] = useState('player');
  const ActiveComponent = VIEWS[activeView];

  // Enable system media controls (lock screen, notification bar)
  useMediaSession();

  return (
    <div className="min-h-screen flex flex-col max-w-lg mx-auto relative">
      {/* Header */}
      <header className="flex items-center justify-between px-5 pt-6 pb-3">
        <h1 className="text-xl font-bold tracking-tight">
          <span className="text-claudio-400">Claudio</span>
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
    </div>
  );
}

export default App;
