import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Tauri 开发时由 tauri CLI 注入 TAURI_ENV_* 变量；网页构建时没有。
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  plugins: [
    react(),
    // 手机 / 浏览器用的 PWA；Tauri 打包时关闭（桌面端不需要 service worker）
    VitePWA({
      disable: isTauri,
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '叮一下',
        short_name: '叮一下',
        description: '叮一下 · Pling：学校、小团队共用的提醒、作业收集和讨论',
        lang: 'zh-CN',
        theme_color: '#EEECE7',
        background_color: '#EEECE7',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        // 这几个地址是服务器的，不能被 service worker 当成页面拦下来换成 index.html
        navigateFallbackDenylist: [/^\/api\//, /^\/downloads\//, /^\/config\.json$/, /^\/MP_verify_/],
      },
    }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
