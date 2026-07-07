import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4321);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', testMatch: 'spark.spec.js', use: { ...devices['Desktop Chrome'] } },
    { name: 'templates', testMatch: 'templates.spec.js', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `bun run site:build && cd website && bunx spark preview --port ${PORT} --strict-port`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
