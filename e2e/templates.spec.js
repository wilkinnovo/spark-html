/**
 * E2E smoke tests for the 4 create-spark-html-app templates.
 *
 * Each template is scaffolded, built, and served on a dedicated port.
 * Serial mode — runs in a single worker because all 4 template servers
 * share port range 5100-5103.
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });

const ROOT = process.cwd();
const HELPER = join(ROOT, 'scripts', 'serve-template-for-e2e.mjs');
const TEMPLATES = [
  { name: 'basic',    port: 5100, title: /Spark App/i },
  { name: 'prerender', port: 5101, title: /My Site/i },
  { name: 'ssr',       port: 5102, title: /Ada Spark/i },
  { name: 'ssr-nodb',  port: 5103, title: /Spark Notes/i },
];

const HOST = '127.0.0.1';

function start(tpl) {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [HELPER, tpl.name, String(tpl.port)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const t = setTimeout(() => {
      if (!ready) { child.kill(); reject(new Error('timeout ' + tpl.name)); }
    }, 90000);
    const check = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (!ready && /\b(preview|serving|dev server|ready)\b/i.test(text)) {
        ready = true;
        clearTimeout(t);
        resolve(child);
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.on('exit', (code) => {
      if (!ready) { clearTimeout(t); reject(new Error(tpl.name + ' exited ' + code)); }
    });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

const children = [];
const errors = [];

test.beforeAll(async () => {
  for (const tpl of TEMPLATES) {
    const child = await start(tpl);
    children.push(child);
    await new Promise(r => setTimeout(r, 500));
  }
});

test.afterAll(() => {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch {}
  }
  children.length = 0;
});

for (const tpl of TEMPLATES) {
  test(`${tpl.name} template renders content`, async ({ page }) => {
    const url = `http://${HOST}:${tpl.port}`;

    // Collect console errors.
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const resp = await page.request.get(url);
    expect(resp.status()).toBe(200);

    await page.goto(url, { waitUntil: 'networkidle' });

    // Check for page errors.
    expect(pageErrors).toEqual([]);

    // Title check.
    await expect(page).toHaveTitle(tpl.title);

    // Each template has a known content element.
    const body = page.locator('body');
    switch (tpl.name) {
      case 'basic':
        await expect(body).toContainText('reacts');
        await expect(page.locator('.count')).toBeVisible();
        break;
      case 'prerender':
        await expect(page.locator('nav').first()).toBeVisible();
        await expect(page.locator('main')).toBeVisible();
        break;
      case 'ssr':
        await expect(page.locator('h1')).toContainText('Ada Spark');
        break;
      case 'ssr-nodb':
        await expect(page.locator('h1')).toContainText('Spark Notes');
        break;
    }
  });
}
