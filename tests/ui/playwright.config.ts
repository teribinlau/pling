// 界面测试：Playwright 跑演示模式（不连服务器）。
//   npm run test:ui                         自己起一个 Vite 开发服务器（端口 1420）跑全部
//   PLING_UI_BASE=http://localhost:1420 …   用已经开着的服务器
// 浏览器：本机已有的 chromium（PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers，playwright 1.56.1 对应 chromium-1194）；
// 没有的话用 PLING_CHROME=/opt/google/chrome/chrome 指定可执行文件。
import { defineConfig, devices } from '@playwright/test';

const base = process.env.PLING_UI_BASE ?? 'http://localhost:1420';
const chrome = process.env.PLING_CHROME;
// 没设 locale 的 Linux（容器、CI）里 Chromium 会把中文下载文件名换成「download」：给浏览器进程一个 UTF-8 的 locale
const browserEnv = { ...process.env, LANG: process.env.LANG || 'C.UTF-8' } as Record<string, string>;

export default defineConfig({
  testDir: '.',
  // 失败时的 trace / 截图放仓库根目录的 test-results/（已经在 .gitignore 里）
  outputDir: '../../test-results',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: base,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    launchOptions: { env: browserEnv, ...(chrome ? { executablePath: chrome } : {}) },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: process.env.PLING_UI_BASE
    ? undefined
    : {
        command: 'npx vite --port 1420 --strictPort',
        cwd: '../..',
        url: base,
        reuseExistingServer: true,
        timeout: 60_000,
        // 演示模式：不给 Supabase 地址
        env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
      },
});
