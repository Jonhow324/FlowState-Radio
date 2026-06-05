import { useEffect, useState } from 'react';
import api from '../services/api.js';

function ProfileView() {
  const [taste, setTaste] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get('/api/taste')
      .then((res) => setTaste(res.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-claudio-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="px-5">
      <h2 className="text-lg font-semibold mb-4">个人品味</h2>

      {/* Taste Summary */}
      <div className="card mb-4">
        <h3 className="text-sm font-medium text-claudio-400 mb-2">音乐品味</h3>
        <p className="text-sm text-white/70 whitespace-pre-line">
          {taste?.taste ? taste.taste.slice(0, 300) + '...' : '暂无品味数据'}
        </p>
      </div>

      {/* Routines */}
      <div className="card mb-4">
        <h3 className="text-sm font-medium text-claudio-400 mb-2">日常节奏</h3>
        <p className="text-sm text-white/70 whitespace-pre-line">
          {taste?.routines ? taste.routines.slice(0, 300) + '...' : '暂无作息数据'}
        </p>
      </div>

      {/* Mood Rules */}
      <div className="card mb-4">
        <h3 className="text-sm font-medium text-claudio-400 mb-2">心情规则</h3>
        <p className="text-sm text-white/70 whitespace-pre-line">
          {taste?.['mood-rules'] ? taste['mood-rules'].slice(0, 300) + '...' : '暂无规则数据'}
        </p>
      </div>

      {/* Playlists */}
      {taste?.playlists && (
        <div className="card mb-4">
          <h3 className="text-sm font-medium text-claudio-400 mb-2">
            歌单 ({taste.playlists.imported?.length || 0} 个导入)
          </h3>
          <div className="space-y-2">
            {taste.playlists.imported?.map((pl) => (
              <div key={pl.id} className="flex items-center gap-2 text-sm text-white/60">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-claudio-500">
                  <circle cx="12" cy="12" r="10" />
                </svg>
                {pl.name}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Play Stats (placeholder) */}
      <div className="card mb-4">
        <h3 className="text-sm font-medium text-claudio-400 mb-2">播放统计</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="text-center p-3 bg-white/5 rounded-xl">
            <p className="text-2xl font-bold text-claudio-400">--</p>
            <p className="text-xs text-white/40">今日播放</p>
          </div>
          <div className="text-center p-3 bg-white/5 rounded-xl">
            <p className="text-2xl font-bold text-claudio-400">--</p>
            <p className="text-xs text-white/40">本周播放</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ProfileView;
