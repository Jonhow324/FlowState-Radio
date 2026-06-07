import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.deepseek\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\/tts\/.*\.mp3$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tts-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
        ],
      },
      manifest: {
        name: 'Claudio - AI Music Radio DJ',
        short_name: 'Claudio',
        description: 'Your personal AI radio DJ — powered by DeepSeek + NeteaseCloudMusic',
        theme_color: '#1a1a2e',
        background_color: '#020617',
        display: 'standalone',
        orientation: 'portrait',
        categories: ['music', 'entertainment'],
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
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
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
