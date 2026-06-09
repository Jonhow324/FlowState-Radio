# Claudio — AI 音乐电台 DJ

个人 AI 音乐电台，基于三层 RAG 架构实现智能选歌 + DJ 串词 + 自动播放。

## 架构概览

用户对话 → **Layer 1** 意图生成（规则引擎，无 LLM）→ **Layer 2** 向量检索（余弦相似度，Top 20）→ **Layer 3** DeepSeek 精选 3-5 首 + 生成 DJ 脚本 → NCM 解析 → TTS 合成 → 播放

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
```

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

## 运行测试

```bash
cd server && npx vitest run
```

---

## 文件结构

```
claudio/
├── .env                          # 环境变量
├── data/
│   └── vector-db.json            # 向量数据库（歌曲 + embedding + NCM 信息）
├── server/
│   ├── config.js                 # 配置聚合
│   ├── brain.js                  # 三层 RAG 大脑
│   ├── context.js                # 上下文组装（天气/时间/记忆）
│   ├── scripts/
│   │   ├── ingest-playlist.js    # 歌单导入脚本
│   │   └── resolve-ncm.js       # NCM trackId 匹配脚本
│   ├── services/
│   │   ├── embedding.js          # DashScope embedding 服务
│   │   ├── vectorStore.js        # 向量存储 + 余弦相似度搜索
│   │   └── ncm.js                # NCM API 封装
│   ├── api/
│   │   └── chat.js               # 聊天 API（完整 RAG 管线）
│   └── tests/                    # 单元测试
└── README.md
```
