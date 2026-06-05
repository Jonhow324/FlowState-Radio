// api/taste.js — GET /api/taste
// Return user taste summary from user/*.md files

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const config = require('../config');

router.get('/', (req, res) => {
  const files = ['taste.md', 'routines.md', 'mood-rules.md'];
  const taste = {};

  for (const file of files) {
    const filePath = path.join(config.userDir, file);
    try {
      taste[file.replace('.md', '')] = fs.readFileSync(filePath, 'utf-8');
    } catch {
      taste[file.replace('.md', '')] = null;
    }
  }

  // Read playlists.json
  try {
    const playlistsPath = path.join(config.userDir, 'playlists.json');
    taste.playlists = JSON.parse(fs.readFileSync(playlistsPath, 'utf-8'));
  } catch {
    taste.playlists = null;
  }

  res.json(taste);
});

module.exports = router;
