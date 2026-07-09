/**
 * I2a — the relocation gate (improvements.md, identity gate 3, spark-brain
 * §1): ONE page (e2e/fixtures/relocation/shared/page.html) served three
 * ways — client, ssr, prerender — via scripts/serve-relocation-fixture.mjs.
 * Oracle: after the same scripted interaction, the normalized DOM must be
 * identical across all three modes. A page relocating across modes without
 * rewrite is the identity's central promise; this is the first time it is
 * mechanically enforced instead of asserted in prose.
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });

const ROOT = process.cwd();
const HELPER = join(ROOT, 'scripts', 'serve-relocation-fixture.mjs');
const MODES = [
  { name: 'client', port: 5210, path: '/' },
  { name: 'ssr', port: 5212, path: '/' },
  { name: 'prerender', port: 5211, path: '/' },
];

function start(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [HELPER, mode.name, String(mode.port)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const t = setTimeout(() => { if (!ready) { child.kill(); reject(new Error('timeout ' + mode.name)); } }, 90000);
    const check = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[${mode.name}] ${text}`);
      if (!ready && /(dev server|preview|serving|start)/i.test(text) && /:\/\//.test(text)) {
        ready = true; clearTimeout(t); resolve(child);
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.on('exit', (code) => { if (!ready) { clearTimeout(t); reject(new Error(mode.name + ' exited ' + code)); } });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

const children = [];
test.beforeAll(async () => {
  for (const m of MODES) children.push(await start(m));
});
test.afterAll(() => { for (const c of children) c.kill('SIGTERM'); });

// Normalization: strip attributes/markers that legitimately differ between
// modes without being a behavior difference — hydration/SSR bookkeeping
// only. Never-weaken-the-oracle applies: any new rule here needs its own
// justification, proven to be mode noise and not a real divergence. Passed
// to page.evaluate as a real function reference (Playwright serializes it
// and calls it with `arg` in-page) — passing it as a source STRING instead
// silently discards `arg` and returns undefined from every call, which is
// exactly as red-flag-free as it sounds; caught by deliberately breaking
// one mode and confirming the gate actually fires (see I2 exit criterion).
function normalizeInPage(root) {
  const strip = ['data-spark-ssr', 'data-spark-ready', 'data-spark-cloak', 'name'];
  root.querySelectorAll('*').forEach((el) => {
    for (const a of strip) el.removeAttribute(a);
  });
  // <spark-ssr> is server-only bookkeeping (a data source declaration) —
  // spark-ssr strips it from its own output; client/prerender never fetch
  // or hydrate it, so it's inert there too. Never rendered content in any
  // mode; strip it here so its raw source text isn't mistaken for a diff.
  root.querySelectorAll('spark-ssr').forEach((el) => el.remove());
  root.querySelectorAll('.ssr-plumbing').forEach((el) => el.remove());
  // The mount/hydration bootstrap <script> itself (client's /src/main.js,
  // ssr/prerender's inline mount() call) is app-shell wiring, not page
  // content — its presence/location is a mode implementation detail.
  root.querySelectorAll('script').forEach((el) => el.remove());
  // HTML comments (SSR emits some inline) never carry behavior.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments = [];
  let n; while ((n = walker.nextNode())) comments.push(n);
  comments.forEach((c) => c.remove());
  return root.innerHTML.replace(/\s+/g, ' ').trim();
}

async function driveAndCapture(page, base) {
  await page.goto(base);
  await page.waitForSelector('.mounted-flag[data-mounted]', { timeout: 10000 }); // onMount settled
  // :attr booleans render as a bare (empty-string) attribute when truthy —
  // HTML5 boolean-attribute convention, not a per-mode difference.
  await expect(page.locator('.mounted-flag')).toHaveAttribute('data-mounted', '');

  // Scripted interaction set — identical on every mode.
  await page.locator('.inc').click();
  await page.locator('.inc').click();
  await page.locator('.toggle').click();
  await page.locator('.add').click();
  await page.locator('.remove').click();
  await page.locator('.bound').fill('hello');
  await expect(page.locator('.bound-echo')).toHaveText('hello');

  const body = await page.$('body');
  return page.evaluate(normalizeInPage, body);
}

test('relocation: client / ssr / prerender converge on identical post-interaction DOM', async ({ browser }) => {
  const snapshots = {};
  for (const m of MODES) {
    const page = await browser.newPage();
    snapshots[m.name] = await driveAndCapture(page, `http://localhost:${m.port}${m.path}`);
    await page.close();
  }
  expect(snapshots.ssr, 'ssr vs client').toBe(snapshots.client);
  expect(snapshots.prerender, 'prerender vs client').toBe(snapshots.client);
});
