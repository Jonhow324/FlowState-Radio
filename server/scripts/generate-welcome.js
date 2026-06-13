// scripts/generate-welcome.js — Pre-generate the "This is FlowState Radio" welcome audio
// Run: cd server && node scripts/generate-welcome.js

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ASSETS_DIR = path.resolve(__dirname, '../../data/assets');
const WELCOME_FILE = path.join(ASSETS_DIR, 'flowstate-welcome.mp3');

const MINIMAX_TTS_URL = 'https://api.minimax.chat/v1/t2a_v2';

// Welcome audio settings
const WELCOME_TEXT = 'This is FlowState Radio';
const VOICE_ID = 'Chinese (Mandarin)_Warm_Bestie';
const SPEED = 0.85; // Slightly slower for a warm, relaxed feel

async function main() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID || '';

  if (!apiKey || apiKey === 'placeholder') {
    console.error('MINIMAX_API_KEY not configured');
    process.exit(1);
  }

  // Ensure assets dir
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }

  // Back up existing file
  if (fs.existsSync(WELCOME_FILE)) {
    const backupFile = WELCOME_FILE + '.bak';
    fs.copyFileSync(WELCOME_FILE, backupFile);
    console.log(`Backed up existing file to ${backupFile}`);
  }

  console.log(`Synthesizing "${WELCOME_TEXT}" with voice: ${VOICE_ID}, speed: ${SPEED}...`);

  const url = groupId
    ? `${MINIMAX_TTS_URL}?GroupId=${groupId}`
    : MINIMAX_TTS_URL;

  const response = await axios.post(
    url,
    {
      model: 'speech-02-hd',
      text: WELCOME_TEXT,
      voice_setting: {
        voice_id: VOICE_ID,
        speed: SPEED,
        vol: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
      },
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const data = response.data;

  if (data.base_resp?.status_code !== 0) {
    console.error('Minimax API error:', data.base_resp?.status_msg || 'Unknown');
    process.exit(1);
  }

  const audioHex = data.data?.audio;
  if (!audioHex) {
    console.error('No audio data in Minimax response');
    process.exit(1);
  }

  const audioBuffer = Buffer.from(audioHex, 'hex');
  fs.writeFileSync(WELCOME_FILE, audioBuffer);
  console.log(`Welcome audio saved: ${WELCOME_FILE} (${(audioBuffer.length / 1024).toFixed(1)}KB)`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
