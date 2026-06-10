# FlowState Radio — AI 音乐电台 DJ

个人 AI 音乐电台，基于三层 RAG 架构实现智能选歌 + DJ 串词 + 自动播放。

## 架构概览

用户对话 → **Layer 1** 意图生成（规则引擎，无 LLM）→ **Layer 2** 向量检索（余弦相似度，Top 20）→ **Layer 3** DeepSeek 精选 10-20 首 + 生成 DJ 脚本 → NCM 解析 → TTS 合成 → 播放

## 环境准备

在 `.env` 文件中配置：

```env
DEEPSEEK_API_KEY=sk-xxx          # DeepSeek API Key（Layer 3 选歌 + DJ 脚本）
DASHSCOPE_API_KEY=sk-xxx         # DashScope API Key（向量 embedding）
NCM_API_URL=http://your-nas-ip:3761  # NCM 服务地址
NCM_COOKIE=xxx                   # NCM 登录 Cookie
```

安装依赖：

```bash
cd server && npm install
cd ../client && npm install
```

---

## 启动服务

需要同时运行后端和前端，开两个终端窗口：

**终端 1 — 后端**（`localhost:8000`）

```bash
cd server
npm run dev
```

使用 nodemon，修改代码自动重启。也可以用 `npm start` 跑纯 Node 不热重载。

**终端 2 — 前端**（`localhost:5173`）

```bash
cd client
npm run dev
```

Vite 开发服务器启动后，浏览器打开 `http://localhost:5173`。前端已配好 proxy，`/api`、`/stream`（WebSocket）、`/tts` 会自动转发到后端 8000 端口，无需额外配置。

**验证后端就绪：** 访问 `http://localhost:8000/api/health` 可看到服务状态。

**生产模式：** 前端先 `npm run build` 生成 `client/dist/`，后端 `index.js` 会自动托管该静态目录，只需启动后端即可。

---

## 导入歌单

### CSV / TSV 格式

支持有表头和无表头两种格式，自动检测分隔符（逗号 / Tab）。

**有表头：**

```csv
序号,歌名,歌手,风格标签,核心歌词大意/情感基调,个人评分
1,晴天,周杰伦,华语流行,青春怀旧的校园回忆,5
2,Bohemian Rhapsody,Queen,Rock,史诗般的摇滚歌剧,5
```

**无表头（按位置映射）：**

```csv
1,晴天,周杰伦,华语流行,青春怀旧的校园回忆,5
2,Bohemian Rhapsody,Queen,Rock,史诗般的摇滚歌剧,5
```

列顺序固定为：`序号 | 歌名 | 歌手 | 风格标签 | 情感基调 | 评分`，其中歌名和歌手为必填，其余可空。

### 使用方法

```bash
cd server

# 预览解析结果（不调用 API）
node scripts/ingest-playlist.js ../data/my-playlist.csv --dry-run

# 全量导入（替换模式：清空旧数据后重新导入）
node scripts/ingest-playlist.js ../data/my-playlist.csv

# 追加导入（合并模式：跳过已有歌曲，只导入新歌）
node scripts/ingest-playlist.js ../data/another-playlist.csv --merge

# 导入并同步匹配 NCM trackId
node scripts/ingest-playlist.js ../data/my-playlist.csv --resolve
```

### 两种导入模式

| 模式 | 命令 | 行为 |
|------|------|------|
| 替换（默认） | `node scripts/ingest-playlist.js file.csv` | 清空数据库，全量重新导入 |
| 合并 | `node scripts/ingest-playlist.js file.csv --merge` | 按内容哈希去重，只导入新歌 |

### 歌曲 ID 机制

每首歌的 ID 基于 `歌名 + 歌手` 的内容哈希（MD5 前 12 位），例如 `song:984de3331ea3`。这意味着：

- 同一首歌无论在哪个 CSV 中、什么位置，ID 都相同，不会重复入库
- 不同 CSV 中的同名歌曲会被自动识别为同一首
- 重新导入同一份 CSV 不会丢失已有的 NCM 匹配数据（使用 `--merge` 时）

### 典型操作场景

**场景 1：第一次导入歌单**

```bash
node scripts/ingest-playlist.js ../data/my-playlist.csv --resolve
```

**场景 2：往已有歌单里追加新 CSV**

```bash
node scripts/ingest-playlist.js ../data/new-songs.csv --merge
```

**场景 3：修改了原 CSV 内容后重新导入**

```bash
node scripts/ingest-playlist.js ../data/my-playlist.csv
```

不加 `--merge` 会清空旧数据再导入，确保修改生效。

**场景 4：只想匹配 NCM，不想重新 embedding**

见下方「NCM TrackId 匹配」章节。

---

## NCM TrackId 匹配

歌单导入后，可以通过 NCM 搜索为每首歌匹配 trackId，用于实际播放。

### 独立匹配脚本

```bash
cd server

# 增量匹配（跳过已有 trackId 的歌曲）
node scripts/resolve-ncm.js

# 全量重新匹配（覆盖所有歌曲的 trackId）
node scripts/resolve-ncm.js --overwrite
```

### 匹配策略

1. 用 `歌名 + 歌手` 搜索 NCM，取前 3 条结果
2. 模糊匹配：对歌名做归一化（去空格、去括号），找到最贴近的结果
3. 如果没匹配上，退回只用歌名重试
4. 内置限流：每次请求间隔 1.5 秒，遇到 405 错误等待 5 秒后重试一次

### 匹配效果

以当前 240 首歌为例，3 轮匹配后约 207 首成功（86.3%），未匹配的多为 NCM 曲库中缺少的小众歌曲。

### 数据存储

所有数据持久化在 `data/vector-db.json`，每首歌的结构：

```json
{
  "id": "song:984de3331ea3",
  "metadata": {
    "name": "I Love You So (Acoustic)",
    "artist": "The Walters",
    "tags": "Indie Pop, Lo-fi",
    "mood": "慵懒又深情的告白",
    "rating": "待设定",
    "embeddingText": "I Love You So (Acoustic) - The Walters. 风格: ...",
    "ncmTrackId": "123456",
    "ncmAlbumArt": "https://..."
  },
  "embedding": [0.012, -0.034, ...]
}
```

---

## 播放与转场机制

### 播放路径

前端通过 `POST /api/player/skip` 切歌（手动跳过或歌曲自动播完均走此路径），`POST /api/player/play` 用于指定播放、恢复暂停、或从队列取下一首。

### Filler 转场 DJ

连续播放超过 3 首歌没有 DJ 串词时，系统会自动插入一段 Filler DJ 话术（模板生成 + TTS 合成），避免长时间纯音乐播放。

触发逻辑位于 `player.js` 的 `/skip` 和 `/play`（队列下一首）端点中：

1. `scheduler._consecutivePlays` 记录连续播放次数
2. 每次切歌检查 `filler.shouldInsertFiller(count)`（默认阈值 3）
3. 达到阈值后调用 `scheduler.generateTransition(prevSong, nextSong, { silent: true })`
4. 生成 Filler 文本 → TTS 合成音频 → 以 `{ silent: true }` 抑制独立 `dj-talk` 广播
5. 将 `ttsUrl`、`transitionStyle`（设为 `intro`）、`fillerType` 打包进 `now-playing` WebSocket 事件

前端收到带 `ttsUrl` 的 `now-playing` 事件后，进入 **intro 转场模式**：新歌以低音量（ducked）开始播放，DJ 语音叠加在新歌 intro 上方，语音结束后音乐渐强恢复正常音量。

### Transition Style

Brain 在 Layer 3 选歌时会为每首歌标注 `transition_style`（`intro` / `outro` / `none`），决定 DJ 语音与歌曲的衔接方式：

| 风格 | 行为 |
|------|------|
| `intro` | DJ 语音叠加在新歌 intro 上播放，结束后音乐渐强 |
| `outro` | 当前歌曲渐弱（duck），DJ 说话，说完后 crossfade 到新歌 |
| `none` | 直接切换，无 DJ 语音 |

### 滚动队列（Rolling Queue）

当播放队列剩余歌曲 ≤ 2 首时，自动触发 `scheduler.checkAndPrefetch()`，异步调用 Brain 补充 10 首新歌，确保播放不会中断。预取过程使用 `_prefetching` 锁防止并发请求。

### 相关文件

| 文件 | 职责 |
|------|------|
| `server/api/player.js` | 播放端点，集成 filler 触发 + 滚动队列检查 |
| `server/services/filler.js` | Filler 模板系统（时段 / 天气 / 连续播放 / 过渡词） |
| `server/scheduler.js` | 调度器：cron 任务 + generateTransition + checkAndPrefetch |
| `client/src/stores/appStore.js` | 前端音频引擎：intro/outro ducking + crossfade |
| `client/src/hooks/useWebSocket.js` | WebSocket 事件处理：now-playing / dj-talk |

---

## 运行测试

```bash
cd server && npx vitest run
```

---

## 文件结构

```
flowstate-radio/
├── .env                          # 环境变量
├── data/
│   └── vector-db.json            # 向量数据库（歌曲 + embedding + NCM 信息）
├── client/                       # React 前端（Vite + Tailwind + PWA）
│   ├── src/
│   │   ├── stores/appStore.js    # Zustand 状态 + 音频引擎（ducking / crossfade）
│   │   ├── hooks/useWebSocket.js # WebSocket 事件处理
│   │   └── ...                   # 页面组件
│   └── vite.config.js            # 开发代理配置（/api → :8000）
├── server/                       # Express 后端
│   ├── index.js                  # 入口 + 路由
│   ├── config.js                 # 配置聚合
│   ├── brain.js                  # 三层 RAG 大脑
│   ├── context.js                # 上下文组装（天气/时间/记忆）
│   ├── router.js                 # 意图路由
│   ├── scheduler.js              # 定时任务 + 滚动队列 + filler 转场
│   ├── state.js                  # 播放状态管理
│   ├── tts.js                    # TTS 合成服务
│   ├── scripts/
│   │   ├── ingest-playlist.js    # 歌单导入脚本
│   │   └── resolve-ncm.js       # NCM trackId 匹配脚本
│   ├── services/
│   │   ├── embedding.js          # DashScope embedding 服务
│   │   ├── filler.js             # Filler 转场 DJ 话术模板
│   │   ├── vectorStore.js        # 向量存储 + 余弦相似度搜索
│   │   └── ncm.js                # NCM API 封装
│   ├── api/
│   │   ├── player.js             # 播放控制（play / pause / skip / volume）
│   │   └── chat.js               # 聊天 API（完整 RAG 管线）
│   └── tests/                    # 单元测试（vitest）
└── README.md
```
