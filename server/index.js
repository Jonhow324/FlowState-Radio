// index.js — Claudio Server Entry Point

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const state = require('./state');
const scheduler = require('./scheduler');

async function startServer() {
  // Initialize database (async because sql.js loads WASM)
  await state.initDatabase();

  const app = express();
  const server = http.createServer(app);

  // ===== Middleware =====
  app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:8000'] }));
  app.use(express.json());

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
      data: { message: 'Connected to Claudio', level: 'info' },
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
        res.status(200).json({ message: 'Claudio API is running. Frontend not built yet.' });
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
    logger.info('SERVER', `Claudio server running on http://localhost:${config.port}`);
    logger.info('SERVER', `WebSocket stream at ws://localhost:${config.port}/stream`);
    logger.info('SERVER', `Environment: ${config.nodeEnv}`);

    // Start scheduler after server is ready
    scheduler.setBroadcast(broadcast);
    scheduler.start();
  });
}

startServer().catch((err) => {
  logger.error('SERVER', 'Failed to start server', err.message);
  process.exit(1);
});
