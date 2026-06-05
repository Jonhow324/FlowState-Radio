import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon.svg'],
      manifest: {
        name: 'Claudio - AI Music Radio',
        short_name: 'Claudio',
        description: 'Your personal AI radio DJ',
        theme_color: '#1a1a2e',
        background_color: '#020617',
        display: 'standalone',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/stream': {
        target: 'ws://localhost:8000',
        ws: true,
      },
      '/tts': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
