import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import api from '../services/api.js';

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: (i) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.4, ease: 'easeOut' },
  }),
};

function ProfileView() {
  const [taste, setTaste] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/api/taste').then((r) => r.data).catch(() => null),
      api.get('/api/stats').then((r) => r.data).catch(() => null),
    ]).then(([tasteData, statsData]) => {
      setTaste(tasteData);
      setStats(statsData);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-claudio-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <motion.div
      className="px-5 pb-24"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <h2 className="text-lg font-semibold mb-4">我的电台</h2>

      {/* Play Statistics */}
      <motion.div
        className="card mb-4"
        custom={0}
        initial="hidden"
        animate="visible"
        variants={cardVariants}
      >
        <h3 className="text-sm font-medium text-claudio-400 mb-3">播放统计</h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center p-3 bg-white/5 rounded-xl">
            <p className="text-2xl font-bold text-claudio-400">{stats?.today || 0}</p>
            <p className="text-xs text-white/40">今日</p>
          </div>
          <div className="text-center p-3 bg-white/5 rounded-xl">
            <p className="text-2xl font-bold text-claudio-400">{stats?.week || 0}</p>
            <p className="text-xs text-white/40">本周</p>
          </div>
          <div className="text-center p-3 bg-white/5 rounded-xl">
            <p className="text-2xl font-bold text-claudio-400">{stats?.total || 0}</p>
            <p className="text-xs text-white/40">总计</p>
          </div>
        </div>
      </motion.div>

      {/* Top Artists */}
      {stats?.topArtists?.length > 0 && (
        <motion.div
          className="card mb-4"
          custom={1}
          initial="hidden"
          animate="visible"
          variants={cardVariants}
        >
          <h3 className="text-sm font-medium text-claudio-400 mb-3">最爱歌手</h3>
          <div className="space-y-2">
            {stats.topArtists.map((a, i) => (
              <div key={a.artist} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/30 w-4">{i + 1}</span>
                  <span className="text-sm text-white/80">{a.artist}</span>
                </div>
                <span className="text-xs text-claudio-500">{a.count} 次</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Top Tracks */}
      {stats?.topTracks?.length > 0 && (
        <motion.div
          className="card mb-4"
          custom={2}
          initial="hidden"
          animate="visible"
          variants={cardVariants}
        >
          <h3 className="text-sm font-medium text-claudio-400 mb-3">最爱歌曲</h3>
          <div className="space-y-2">
            {stats.topTracks.map((t, i) => (
              <div key={`${t.track_name}-${t.artist}`} className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-white/30 w-4">{i + 1}</span>
                  <div className="min-w-0">
                    <p className="text-sm text-white/80 truncate">{t.track_name}</p>
                    <p className="text-xs text-white/40 truncate">{t.artist}</p>
                  </div>
                </div>
                <span className="text-xs text-claudio-500 shrink-0 ml-2">{t.count} 次</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Recent Plays */}
      {stats?.recentPlays?.length > 0 && (
        <motion.div
          className="card mb-4"
          custom={3}
          initial="hidden"
          animate="visible"
          variants={cardVariants}
        >
          <h3 className="text-sm font-medium text-claudio-400 mb-3">最近播放</h3>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {stats.recentPlays.slice(0, 10).map((p, i) => (
              <div key={`${p.trackId}-${i}`} className="flex items-center justify-between py-1">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white/70 truncate">{p.trackName}</p>
                  <p className="text-xs text-white/30 truncate">{p.artist}</p>
                </div>
                <span className="text-[10px] text-white/20 shrink-0 ml-2">
                  {formatTime(p.playedAt)}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Taste Profile */}
      <motion.div
        className="card mb-4"
        custom={4}
        initial="hidden"
        animate="visible"
        variants={cardVariants}
      >
        <h3 className="text-sm font-medium text-claudio-400 mb-2">音乐品味</h3>
        <p className="text-sm text-white/60 whitespace-pre-line leading-relaxed">
          {taste?.taste ? taste.taste.slice(0, 300) : '暂无品味数据，和 DJ Claudio 多聊聊吧'}
        </p>
      </motion.div>

      {/* Playlists */}
      {taste?.playlists?.imported?.length > 0 && (
        <motion.div
          className="card mb-4"
          custom={5}
          initial="hidden"
          animate="visible"
          variants={cardVariants}
        >
          <h3 className="text-sm font-medium text-claudio-400 mb-2">
            导入歌单 ({taste.playlists.imported.length})
          </h3>
          <div className="space-y-2">
            {taste.playlists.imported.map((pl) => (
              <div key={pl.id} className="flex items-center gap-2 text-sm text-white/60">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-claudio-500 shrink-0">
                  <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                </svg>
                <span className="truncate">{pl.name}</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default ProfileView;
