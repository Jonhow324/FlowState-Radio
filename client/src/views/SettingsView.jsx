import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import api from '../services/api.js';
import useAppStore from '../stores/appStore.js';

function SettingsView() {
  const { activeDj, setActiveDj } = useAppStore();
  const [volume, setVolume] = useState(50);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    // Load current state
    api
      .get('/api/now')
      .then((res) => {
        setVolume(Math.round((res.data.volume || 0.5) * 100));
        if (res.data.activeDj) setActiveDj(res.data.activeDj);
      })
      .catch(console.error);
  }, []);

  const handleDjSwitch = async (dj) => {
    if (dj === activeDj || switching) return;
    setSwitching(true);
    try {
      const res = await api.post('/api/dj/switch', { dj });
      setActiveDj(dj);
      console.log('DJ switched:', res.data.welcomeMessage);
    } catch (err) {
      console.error('Failed to switch DJ:', err);
    } finally {
      setSwitching(false);
    }
  };

  const handleVolumeChange = async (e) => {
    const val = parseInt(e.target.value, 10);
    setVolume(val);
    try {
      await api.post('/api/player/volume', { volume: val / 100 });
    } catch (err) {
      console.error('Failed to set volume:', err);
    }
  };

  return (
    <div className="px-5">
      <h2 className="text-lg font-semibold mb-6">设置</h2>

      {/* DJ Switch */}
      <div className="card mb-4">
        <h3 className="text-sm font-medium text-claudio-400 mb-3">DJ 主播</h3>
        <div className="flex gap-3">
          {[
            { id: 'zh', label: 'Claudio', desc: '中文电台 · 温暖亲切' },
            { id: 'en', label: 'DJ Claudio', desc: 'English · Cool & Smooth' },
          ].map((dj) => (
            <button
              key={dj.id}
              onClick={() => handleDjSwitch(dj.id)}
              disabled={switching}
              className={`flex-1 p-3 rounded-xl border transition-all duration-200 ${
                activeDj === dj.id
                  ? 'border-claudio-500 bg-claudio-900/50'
                  : 'border-white/10 bg-white/5 hover:border-white/20'
              }`}
            >
              <p className="text-sm font-medium">{dj.label}</p>
              <p className="text-xs text-white/40 mt-1">{dj.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Volume */}
      <div className="card mb-4">
        <h3 className="text-sm font-medium text-claudio-400 mb-3">音量</h3>
        <div className="flex items-center gap-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-white/40"
          >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          </svg>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={handleVolumeChange}
            className="flex-1 accent-claudio-500"
          />
          <span className="text-sm text-white/50 w-8 text-right">{volume}%</span>
        </div>
      </div>

      {/* TTS Voice (placeholder) */}
      <div className="card mb-4">
        <h3 className="text-sm font-medium text-claudio-400 mb-3">TTS 音色</h3>
        <p className="text-sm text-white/40">
          Phase 3 接入 Minimax TTS 后可配置音色
        </p>
      </div>

      {/* About */}
      <div className="card mb-4">
        <h3 className="text-sm font-medium text-claudio-400 mb-3">关于</h3>
        <p className="text-sm text-white/60">Claudio v0.1.0</p>
        <p className="text-xs text-white/30 mt-1">AI Music Radio DJ</p>
      </div>
    </div>
  );
}

export default SettingsView;
