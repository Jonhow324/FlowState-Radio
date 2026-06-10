// index.js — FlowState Radio Server Entry Point

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const state = require('./state');
const scheduler = require('./scheduler');
const tts = require('./tts');

async function startServer() {
  // Initialize database (async because sql.js loads WASM)
  await state.initDatabase();

  // Restore saved TTS voice preference
  const savedVoice = state.getPref('tts_voice');
  if (savedVoice) {
    const VOICE_MAP = {
      'default':          { zh: 'male-qn-qingse', en: 'male-qn-jingying' },
      'male-qn-qingse':   { zh: 'male-qn-qingse', en: 'male-qn-jingying' },
      'male-qn-jingying': { zh: 'male-qn-jingying', en: 'male-qn-jingying' },
      'male-qn-badao':    { zh: 'male-qn-badao', en: 'male-qn-jingying' },
      'female-shaonv':    { zh: 'female-shaonv', en: 'female-yujie' },
      'female-yujie':     { zh: 'female-yujie', en: 'female-yujie' },
      'female-tianmei':   { zh: 'female-tianmei', en: 'female-yujie' },
    };
    const mapping = VOICE_MAP[savedVoice];
    if (mapping) {
      tts.setVoice(mapping.zh, 'zh');
      tts.setVoice(mapping.en, 'en');
      logger.info('TTS', `Restored saved voice: ${savedVoice}`);
    }
  }

  const app = express();
  const server = http.createServer(app);

  // ===== Middleware =====
  app.use(cors({ origin: [/^http:\/\/localhost:\d+$/] }));
  app.use(express.json());
  app.use(logger.requestMiddleware);

  // Request duration logging
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path.includes('/health')) return next();
    const start = Date.now();
    const method = req.method;
    const url = req.originalUrl || req.url;
    let logged = false;
    const onDone = () => {
      if (logged) return;
      logged = true;
      const duration = Date.now() - start;
      logger.info('HTTP', `${method} ${url} → ${res.statusCode} (${duration}ms)`);
    };
    res.once('finish', onDone);
    res.once('close', onDone);
    next();
  });

  // ===== WebSocket Setup =====
  const WebSocket = require('ws');
  const wss = new WebSocket.Server({ server, path: '/stream' });

  // Store connected clients
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    logger.info('WS', `Client connected (total: ${clients.size})`);

    ws.on('close', () => {
      clients.delete(ws);
      logger.info('WS', `Client disconnected (total: ${clients.size})`);
    });

    // Send welcome message on connect
    ws.send(JSON.stringify({
      type: 'system',
      data: { message: 'Connected to FlowState', level: 'info' },
    }));
  });

  // Helper: broadcast to all connected WS clients
  function broadcast(event) {
    const msg = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  // Make broadcast available to route handlers
  app.set('broadcast', broadcast);

  // ===== Static Files =====
  // Serve TTS cache as static files (audio playback)
  app.use('/tts', express.static(path.join(config.ttsCacheDir)));

  // ===== API Routes =====
  app.use('/api/chat', require('./api/chat'));
  app.use('/api/search', require('./api/search'));
  app.use('/api/song', require('./api/song'));
  app.use('/api/now', require('./api/now'));
  app.use('/api/next', require('./api/next'));
  app.use('/api/queue', require('./api/queue'));
  app.use('/api/taste', require('./api/taste'));
  app.use('/api/plan', require('./api/plan'));
  app.use('/api/player', require('./api/player'));
  app.use('/api/dj', require('./api/dj'));
  app.use('/api/scheduler', require('./api/scheduler-api'));
  app.use('/api/stats', require('./api/stats'));
  app.use('/api/tts', require('./api/tts'));

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // ===== Serve Frontend (Production) =====
  const clientDist = path.resolve(__dirname, '../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    // Skip API routes and WebSocket
    if (req.path.startsWith('/api/') || req.path.startsWith('/stream')) {
      return next();
    }
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      if (err) {
        res.status(200).json({ message: 'FlowState Radio API is running. Frontend not built yet.' });
      }
    });
  });

  // ===== Graceful Shutdown =====
  process.on('SIGINT', () => {
    logger.info('SERVER', 'Shutting down...');
    scheduler.stop();
    state.saveDbSync();
    server.close(() => {
      logger.info('SERVER', 'Server closed');
      process.exit(0);
    });
  });

  // ===== Start Server =====
  server.listen(config.port, () => {
    logger.info('SERVER', `FlowState Radio server running on http://localhost:${config.port}`);
    logger.info('SERVER', `WebSocket stream at ws://localhost:${config.port}/stream`);
    logger.info('SERVER', `Environment: ${config.nodeEnv}`);

    // Start scheduler after server is ready
    scheduler.setBroadcast(broadcast);
    scheduler.start();

    // Pre-warm TTS cache with common DJ phrases (non-blocking)
    tts.preWarm([
      { text: '早安！新的一天开始了，让音乐陪你出发。', lang: 'zh' },
      { text: '好的，来一首歌给你。', lang: 'zh' },
      { text: '这首歌送给你，希望你喜欢。', lang: 'zh' },
      { text: '接下来换一首节奏感更强的。', lang: 'zh' },
      { text: '夜深了，来一首安静的歌陪你入眠。', lang: 'zh' },
      { text: '好，暂停了。', lang: 'zh' },
      { text: '队列里没有歌了。', lang: 'zh' },
      { text: '嗯，出了一点小状况，稍后再试试吧。', lang: 'zh' },
    ]);
  });
}

startServer().catch((err) => {
  logger.error('SERVER', 'Failed to start server', err.message);
  process.exit(1);
});
