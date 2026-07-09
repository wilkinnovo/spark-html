// Dump browser console + page errors for one relocation fixture mode.
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const MODE = process.argv[2] || 'client';
const PORT = 5301;
const server = spawn('bun', ['scripts/serve-relocation-fixture.mjs', MODE, String(PORT)], {
  cwd: '/home/nine/spark', stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d));

for (let i = 0; i < 120; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
await page.goto(`http://localhost:${PORT}/`);
await page.waitForTimeout(6000);
console.log('---BODY---');
console.log((await page.locator('.count').textContent().catch(() => 'no .count')));
await browser.close();
server.kill('SIGTERM');
setTimeout(() => process.exit(0), 800);
