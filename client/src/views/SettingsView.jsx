import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import api from '../services/api.js';
import useAppStore from '../stores/appStore.js';

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: (i) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.4, ease: 'easeOut' },
  }),
};

// Minimax voice presets
const VOICE_PRESETS = [
  { id: 'default', label: '默认', desc: '系统默认音色' },
  { id: 'male-qn-qingse', label: '青涩', desc: '青年男声 · 清澈' },
  { id: 'male-qn-jingying', label: '精英', desc: '青年男声 · 沉稳' },
  { id: 'male-qn-badao', label: '霸道', desc: '青年男声 · 磁性' },
  { id: 'female-shaonv', label: '少女', desc: '少女音 · 甜美' },
  { id: 'female-yujie', label: '御姐', desc: '成熟女声 · 优雅' },
  { id: 'female-tianmei', label: '甜美', desc: '甜美女声 · 温柔' },
];

function SettingsView() {
  const { activeDj, setActiveDj, volume, setVolume } = useAppStore();
  const [localVolume, setLocalVolume] = useState(Math.round(volume * 100));
  const [switching, setSwitching] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('default');
  const [previewing, setPreviewing] = useState(null);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState(null);

  useEffect(() => {
    // Load current state
    api.get('/api/now').then((res) => {
      const vol = Math.round((res.data.volume || 0.5) * 100);
      setLocalVolume(vol);
      setVolume(vol / 100);
      if (res.data.activeDj) setActiveDj(res.data.activeDj);
    }).catch(console.error);

    // Check TTS availability and load current voice
    api.get('/api/scheduler/status').then((res) => {
      setTtsAvailable(res.data.ttsAvailable);
      setSchedulerStatus(res.data);
    }).catch(console.error);

    api.get('/api/tts/voice').then((res) => {
      setSelectedVoice(res.data.current || 'default');
    }).catch(console.error);
  }, []);

  const handleDjSwitch = async (dj) => {
    if (dj === activeDj || switching) return;
    setSwitching(true);
    try {
      const res = await api.post('/api/dj/switch', { dj });
      setActiveDj(dj);
    } catch (err) {
      console.error('Failed to switch DJ:', err);
    } finally {
      setSwitching(false);
    }
  };

  const handleVolumeChange = (e) => {
    const val = parseInt(e.target.value, 10);
    setLocalVolume(val);
    setVolume(val / 100);
  };

  const handleVolumeCommit = () => {
    api.post('/api/player/volume', { volume: localVolume / 100 }).catch(console.error);
  };

  const handleVoiceChange = async (voiceId) => {
    if (selectedVoice === voiceId) return;
    setSelectedVoice(voiceId);
    try {
      await api.post('/api/tts/voice', { voiceId });
    } catch (err) {
      console.error('Failed to change voice:', err);
    }
  };

  const handleVoicePreview = async (voiceId) => {
    if (previewing) return;
    setPreviewing(voiceId);
    try {
      const res = await api.post('/api/tts/preview', { voiceId });
      if (res.data.url) {
        const audio = new Audio(res.data.url);
        audio.play();
        audio.onended = () => setPreviewing(null);
        // Safety timeout
        setTimeout(() => setPreviewing(null), 8000);
      } else {
        setPreviewing(null);
      }
    } catch (err) {
      console.error('Voice preview failed:', err);
      setPreviewing(null);
    }
  };

  return (
    <motion.div
      className="px-5 pb-24"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <h2 className="text-lg font-semibold mb-6">设置</h2>

      {/* DJ Switch */}
      <motion.div
        className="card mb-4"
        custom={0}
        initial="hidden"
        animate="visible"
        variants={cardVariants}
      >
        <h3 className="text-sm font-medium text-claudio-400 mb-3">DJ 主播</h3>
        <div className="flex gap-3">
          {[
            { id: 'zh', label: 'Claudio', desc: '中文电台 · 温暖亲切', emoji: '🎙️' },
            { id: 'en', label: 'DJ Claudio', desc: 'English · Cool & Smooth', emoji: '🎧' },
          ].map((dj) => (
            <motion.button
              key={dj.id}
              onClick={() => handleDjSwitch(dj.id)}
              disabled={switching}
              whileTap={{ scale: 0.97 }}
              className={`flex-1 p-3 rounded-xl border transition-all duration-200 ${
                activeDj === dj.id
                  ? 'border-claudio-500 bg-claudio-900/50'
                  : 'border-white/10 bg-white/5 hover:border-white/20'
              } ${switching ? 'opacity-50' : ''}`}
            >
              <p className="text-lg mb-1">{dj.emoji}</p>
              <p className="text-sm font-medium">{dj.label}</p>
              <p className="text-xs text-white/40 mt-1">{dj.desc}</p>
            </motion.button>
          ))}
        </div>
        {switching && (
          <p className="text-xs text-claudio-500 mt-2 animate-pulse">切换中...</p>
        )}
      </motion.div>

      {/* Volume */}
      <motion.div
        className="card mb-4"
        custom={1}
        initial="hidden"
        animate="visible"
        variants={cardVariants}
      >
        <h3 className="text-sm font-medium text-claudio-400 mb-3">音量</h3>
        <div className="flex items-center gap-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/40">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          </svg>
          <input
            type="range"
            min="0"
            max="100"
            value={localVolume}
            onChange={handleVolumeChange}
            onMouseUp={handleVolumeCommit}
            onTouchEnd={handleVolumeCommit}
            className="flex-1 accent-claudio-500 h-1"
          />
          <span className="text-sm text-white/50 w-8 text-right">{localVolume}%</span>
        </div>
      </motion.div>

      {/* TTS Voice */}
      <motion.div
        className="card mb-4"
        custom={2}
        initial="hidden"
        animate="visible"
        variants={cardVariants}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-claudio-400">TTS 音色</h3>
          {ttsAvailable ? (
            <span className="text-[10px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full">已连接</span>
          ) : (
            <span className="text-[10px] bg-white/10 text-white/40 px-2 py-0.5 rounded-full">未配置</span>
          )}
        </div>
        {ttsAvailable ? (
          <div className="space-y-2">
            {VOICE_PRESETS.map((v) => (
              <div
                key={v.id}
                className={`flex items-center justify-between p-2.5 rounded-lg transition-all ${
                  selectedVoice === v.id
                    ? 'bg-claudio-900/50 border border-claudio-500/50'
                    : 'bg-white/5 border border-transparent hover:bg-white/10'
                }`}
              >
                <button
                  onClick={() => handleVoiceChange(v.id)}
                  className="flex-1 text-left"
                >
                  <p className="text-sm text-white/80">{v.label}</p>
                  <p className="text-xs text-white/40">{v.desc}</p>
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleVoicePreview(v.id)}
                    disabled={previewing === v.id}
                    className={`p-1.5 rounded-full transition-all ${
                      previewing === v.id ? 'text-green-400' : 'text-white/30 hover:text-claudio-400'
                    }`}
                    title="试听"
                  >
                    {previewing === v.id ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="animate-pulse">
                        <path d="M3 9v6h4l5 5V4L7 9H3z" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </svg>
                    )}
                  </button>
                  {selectedVoice === v.id && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-claudio-400">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-white/40">
            配置 Minimax API Key 后可自定义 DJ 语音音色
          </p>
        )}
      </motion.div>

      {/* System Status */}
      <motion.div
        className="card mb-4"
        custom={3}
        initial="hidden"
        animate="visible"
        variants={cardVariants}
      >
        <h3 className="text-sm font-medium text-claudio-400 mb-3">系统状态</h3>
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-white/50">调度器</span>
            <span className={schedulerStatus?.schedulerRunning ? 'text-green-400' : 'text-white/30'}>
              {schedulerStatus?.schedulerRunning ? `${schedulerStatus.taskCount} 个任务运行中` : '未启动'}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-white/50">播放队列</span>
            <span className="text-white/70">{schedulerStatus?.queueLength || 0} 首</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-white/50">今日计划</span>
            <span className={schedulerStatus?.hasTodayPlan ? 'text-green-400' : 'text-white/30'}>
              {schedulerStatus?.hasTodayPlan ? '已生成' : '未生成'}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-white/50">TTS 引擎</span>
            <span className={ttsAvailable ? 'text-green-400' : 'text-white/30'}>
              {ttsAvailable ? 'Minimax 已连接' : '未配置'}
            </span>
          </div>
        </div>
      </motion.div>

      {/* Manual Triggers */}
      <motion.div
        className="card mb-4"
        custom={4}
        initial="hidden"
        animate="visible"
        variants={cardVariants}
      >
        <h3 className="text-sm font-medium text-claudio-400 mb-3">手动触发</h3>
        <div className="flex gap-2">
          <TriggerButton label="早安播报" endpoint="/api/scheduler/briefing" />
          <TriggerButton label="今日规划" endpoint="/api/scheduler/plan" />
          <TriggerButton label="补充队列" endpoint="/api/scheduler/refill" />
        </div>
      </motion.div>

      {/* About */}
      <motion.div
        className="card mb-4"
        custom={5}
        initial="hidden"
        animate="visible"
        variants={cardVariants}
      >
        <h3 className="text-sm font-medium text-claudio-400 mb-2">关于</h3>
        <p className="text-sm text-white/60">Claudio v0.3.0</p>
        <p className="text-xs text-white/30 mt-1">AI Music Radio DJ · Phase 4</p>
      </motion.div>
    </motion.div>
  );
}

function TriggerButton({ label, endpoint }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await api.post(endpoint);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch (err) {
      console.error(`Trigger ${endpoint} failed:`, err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-all ${
        done
          ? 'bg-green-500/20 text-green-400'
          : 'bg-white/5 text-white/60 hover:bg-white/10 active:scale-95'
      } ${loading ? 'opacity-50' : ''}`}
    >
      {loading ? '...' : done ? '✓' : label}
    </button>
  );
}

export default SettingsView;
