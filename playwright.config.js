import { defineConfig, devices } from '@playwright/test';

// One real-browser smoke test of the whole stack: the website is built (Bun +
// spark-prerender) and served, then we drive it in Chromium to prove mount →
// hydrate → router → theme all work together in a browser, not just in jsdom.
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build the site (prerender bakes per-route HTML) then serve dist, so the
    // test exercises real hydration over prerendered markup.
    command: `bun run site:build && cd website && bunx spark preview --port ${PORT} --strict-port`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
