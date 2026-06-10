#!/usr/bin/env node
// scripts/init-db.js — Standalone script to initialize/reset the database

const path = require('path');

// Load config from parent
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

async function main() {
  console.log('Initializing FlowState Radio database...');

  const { initDatabase, saveDbSync, getCurrentState } = require('../state');
  await initDatabase();

  const state = getCurrentState();
  console.log('Current state:', JSON.stringify(state, null, 2));

  saveDbSync();
  console.log('Database initialized successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
