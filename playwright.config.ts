import { defineConfig } from '@playwright/test';

// E2E tests drive the real app (Next.js + realtime gateway + worker + PostgreSQL).
// They reuse a running server at E2E_BASE_URL or start `npm run dev` + `npm run worker`.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? undefined,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
    screenshot: 'only-on-failure',
  },
  // The worker must also be running (npm run worker) for production/settlement deadlines.
  webServer: { command: 'npm run dev', url: `${baseURL}/api/health`, reuseExistingServer: true, timeout: 180_000 },
});
