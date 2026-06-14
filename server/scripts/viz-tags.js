// scripts/viz-tags.js — Visualize music style/tag distribution from vector-db.json
// Usage: node scripts/viz-tags.js
// Outputs an HTML chart + terminal summary

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const vectorStore = require('../services/vectorStore');
const logger = require('../utils/logger');

vectorStore.load();
const items = vectorStore.items;

// ── 1. Tag distribution ──────────────────────────────────────
const tagCount = {};
let noTag = 0;
let totalTaggedSongs = 0;

items.forEach((item) => {
  const raw = item.metadata.tags || '';
  const tags = raw
    .split(/[,;，；、\/\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length === 0) {
    noTag++;
    return;
  }
  totalTaggedSongs++;
  tags.forEach((t) => {
    tagCount[t] = (tagCount[t] || 0) + 1;
  });
});

const sorted = Object.entries(tagCount).sort((a, b) => b[1] - a[1]);

// ── 2. Artist distribution ──────────────────────────────────
const artistCount = {};
items.forEach((item) => {
  const artist = item.metadata.artist || 'Unknown';
  artistCount[artist] = (artistCount[artist] || 0) + 1;
});
const topArtists = Object.entries(artistCount)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);

// ── 3. Tag hierarchy (group similar tags) ───────────────────
const tagGroups = {
  '电子/氛围': ['电子', 'Electronic', 'Ambient', '氛围', 'Chillout', 'Downtempo', 'Trip-hop', 'IDM', 'Lounge'],
  '摇滚/独立': ['摇滚', 'Rock', '独立', 'Indie', '另类', 'Alternative', '后摇', 'Post-rock', '盯鞋', 'Shoegaze', '自赏'],
  '流行': ['流行', 'Pop', 'Dream Pop', 'Synth-pop', 'Indie Pop', 'City Pop'],
  '民谣': ['民谣', 'Folk', '新民谣', 'Neofolk'],
  '爵士': ['爵士', 'Jazz', 'Nu Jazz', 'Smooth Jazz'],
  '古典/新世纪': ['古典', 'Classical', 'New Age', '新世纪', '钢琴', 'Piano'],
  '金属': ['金属', 'Metal', '黑金属', 'Black Metal', '旋死', 'Melodic Death'],
  'R&B/Soul': ['R&B', 'Soul', 'Funk'],
  '说唱': ['说唱', 'Hip-hop', 'Rap'],
  '实验': ['实验', 'Experimental', '噪音', 'Noise'],
  '世界音乐': ['世界音乐', 'World', '雷鬼', 'Reggae'],
};

const grouped = {};
const ungrouped = [];
for (const [tag, count] of sorted) {
  let matched = false;
  for (const [group, keywords] of Object.entries(tagGroups)) {
    if (keywords.some((kw) => tag.toLowerCase().includes(kw.toLowerCase()))) {
      grouped[group] = (grouped[group] || 0) + count;
      matched = true;
      break;
    }
  }
  if (!matched) {
    ungrouped.push({ tag, count });
  }
}

// ── 4. Mood distribution ────────────────────────────────────
const moodCount = {};
items.forEach((item) => {
  const mood = item.metadata.mood || '';
  if (!mood.trim()) return;
  // Simple keyword matching for moods
  const moods = [];
  if (/快乐|欢快|愉悦|轻松|开心|happy|joy|upbeat|cheerful/i.test(mood)) moods.push('欢快');
  if (/悲伤|忧伤|难过|伤感|忧郁|sad|melancholy|sorrow|blue/i.test(mood)) moods.push('忧伤');
  if (/平静|安静|宁靜|舒缓|放松|calm|peaceful|tranquil|relax/i.test(mood)) moods.push('平静');
  if (/热血|激情|力量|powerful|energetic|intense/i.test(mood)) moods.push('热血');
  if (/浪漫|温柔|爱情|love|romantic|tender/i.test(mood)) moods.push('浪漫');
  if (/黑暗|压抑|dark|gloomy|depressing/i.test(mood)) moods.push('暗黑');
  if (/梦幻|迷幻|dreamy|psychedelic|ethereal/i.test(mood)) moods.push('梦幻');
  moods.forEach((m) => {
    moodCount[m] = (moodCount[m] || 0) + 1;
  });
});

// ── 5. Generate HTML report ──────────────────────────────────
const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F8C471', '#82E0AA', '#F1948A', '#85929E', '#AED6F1'];
const total = totalTaggedSongs || 1;

const generateTagBars = (data, label) => {
  const max = data[0]?.[1] || 1;
  return data.map(([tag, count], i) => {
    const pct = ((count / total) * 100).toFixed(1);
    const barLen = Math.max(1, Math.round((count / max) * 30));
    const bar = '█'.repeat(barLen);
    const color = colors[i % colors.length];
    return `<div style="display:flex;align-items:center;margin:4px 0;font-size:13px">
      <span style="width:80px;text-align:right;margin-right:12px;color:#aaa;flex-shrink:0">${tag}</span>
      <span style="color:${color};margin-right:8px;white-space:pre;font-family:monospace">${bar}</span>
      <span style="color:#ccc;white-space:nowrap">${count} (${pct}%)</span>
    </div>`;
  }).join('\n');
};

const generateGroupBars = (data) => {
  const max = Math.max(...Object.values(data));
  return Object.entries(data)
    .sort((a, b) => b[1] - a[1])
    .map(([group, count], i) => {
      const pct = ((count / total) * 100).toFixed(1);
      const barLen = Math.max(1, Math.round((count / max) * 30));
      const bar = '█'.repeat(barLen);
      const color = colors[i % colors.length];
      return `<div style="display:flex;align-items:center;margin:4px 0;font-size:13px">
        <span style="width:80px;text-align:right;margin-right:12px;color:#aaa;flex-shrink:0">${group}</span>
        <span style="color:${color};margin-right:8px;white-space:pre;font-family:monospace">${bar}</span>
        <span style="color:#ccc;white-space:nowrap">${count} (${pct}%)</span>
      </div>`;
    }).join('\n');
};

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claudio 音乐风格分析</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0d1117; color:#c9d1d9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding:40px; }
  h1 { color:#58a6ff; margin-bottom:8px; }
  h2 { color:#58a6ff; margin:32px 0 16px; border-bottom:1px solid #21262d; padding-bottom:8px; }
  .summary { color:#8b949e; margin-bottom:32px; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:20px; margin-bottom:24px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
  @media(max-width:900px){ .grid{grid-template-columns:1fr;} }
  .stats { display:flex; gap:24px; flex-wrap:wrap; margin-bottom:24px; }
  .stat { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:16px 24px; text-align:center; }
  .stat-value { font-size:28px; font-weight:bold; color:#58a6ff; }
  .stat-label { font-size:12px; color:#8b949e; margin-top:4px; }
</style>
</head>
<body>

<h1>🎵 Claudio 音乐风格全景</h1>
<div class="summary">基于 ${items.length} 首歌曲的标签、风格、情感分析</div>

<div class="stats">
  <div class="stat"><div class="stat-value">${items.length}</div><div class="stat-label">总歌曲数</div></div>
  <div class="stat"><div class="stat-value">${sorted.length}</div><div class="stat-label">风格标签数</div></div>
  <div class="stat"><div class="stat-value">${Object.keys(artistCount).length}</div><div class="stat-label">艺人总数</div></div>
  <div class="stat"><div class="stat-value">${Object.keys(grouped).length}</div><div class="stat-label">风格大类</div></div>
</div>

<div class="grid">
  <div class="card">
    <h2>📊 风格大类分布</h2>
    ${generateGroupBars(grouped)}
  </div>
  <div class="card">
    <h2>🏷️ 细分标签 TOP 20</h2>
    ${generateTagBars(sorted.slice(0, 20))}
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>😊 情感分布</h2>
    ${generateTagBars(Object.entries(moodCount).sort((a,b) => b[1]-a[1]))}
  </div>
  <div class="card">
    <h2>🎤 高频艺人 TOP 20</h2>
    ${generateTagBars(topArtists)}
  </div>
</div>

<div class="card">
  <h2>📋 全部标签 (${sorted.length})</h2>
  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
    ${sorted.map(([tag, count], i) => {
      const pct = ((count / total) * 100).toFixed(1);
      const color = colors[i % colors.length];
      return '<span style="background:#21262d;color:' + color + ';padding:4px 12px;border-radius:12px;font-size:12px">' + tag + ' <span style="color:#8b949e">' + count + '</span></span>';
    }).join('\n')}
  </div>
</div>

</body>
</html>`;

const outPath = path.resolve(__dirname, '../../data/style-report.html');
fs.writeFileSync(outPath, html, 'utf-8');
logger.info('VIZ', `Report saved to ${outPath}`);

// ── 6. Terminal summary ──────────────────────────────────────
console.log('\n═══════════════════════════════════');
console.log(`  🎵 音乐风格全景 | ${items.length} 首 | ${Object.keys(artistCount).length} 位艺人`);
console.log('═══════════════════════════════════\n');

console.log('📊 风格大类:');
Object.entries(grouped)
  .sort((a, b) => b[1] - a[1])
  .forEach(([g, c]) => {
    const pct = ((c / total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round((c / Math.max(...Object.values(grouped))) * 25));
    console.log(`  ${g.padEnd(10)} ${bar} ${c} (${pct}%)`);
  });

console.log('\n🏷️ 细分标签 TOP 15:');
sorted.slice(0, 15).forEach(([t, c]) => {
  console.log(`  ${t.padEnd(16)} ${c}`);
});

console.log('\n🎤 高频艺人:');
topArtists.slice(0, 10).forEach(([a, c]) => {
  console.log(`  ${a.padEnd(20)} ${c} 首`);
});

console.log(`\n📄 完整报告: ${path.relative(process.cwd(), outPath)}\n`);
