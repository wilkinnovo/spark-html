/**
 * spark-html-font — @font-face/preload/fallback generation, runtime
 * injection, and the bun step's head insertion.
 */
import '../../spark/test/dom-shim.js';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fonts, fontCss, fontLinks, fontHtml } from '../src/index.js';
import sparkFont from '../src/bun.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\nspark-html-font');

const config = {
  fonts: [
    { family: 'Inter', src: '/fonts/inter-var.woff2', weight: '100 900' },
    { family: 'Fira Code', google: true, weights: [400, 700] },
  ],
  fallback: ['system-ui', 'sans-serif'],
};

await test('fontCss() emits @font-face with weight/style/display defaults', () => {
  const css = fontCss(config);
  assert.ok(css.includes('@font-face { font-family: "Inter"; src: url("/fonts/inter-var.woff2") format("woff2")'), 'face');
  assert.ok(css.includes('font-weight: 100 900'), 'variable weight range');
  assert.ok(css.includes('font-display: swap'), 'swap by default');
});

await test('a size-adjusted fallback face is generated from built-in metrics', () => {
  const css = fontCss(config);
  assert.ok(css.includes('font-family: "Inter Fallback"; src: local("Arial")'), 'local stand-in');
  assert.ok(/size-adjust: [\d.]+%; ascent-override: [\d.]+%; descent-override: [\d.]+%/.test(css), 'metric overrides');
});

await test(':root exposes a --font-<slug> var with the full stack', () => {
  const css = fontCss(config);
  assert.ok(css.includes('--font-inter: "Inter", "Inter Fallback", system-ui, sans-serif;'), 'inter stack');
  assert.ok(css.includes('--font-fira-code:'), 'google family gets a var too');
});

await test('custom metrics + adjust:false are honored', () => {
  const custom = fontCss({ fonts: [{ family: 'MyFace', src: '/f.woff2', metrics: { sizeAdjust: 99, ascent: 88, descent: 20, lineGap: 1 } }] });
  assert.ok(custom.includes('size-adjust: 99%'), 'user metrics used');
  const off = fontCss({ fonts: [{ family: 'Inter', src: '/f.woff2', adjust: false }] });
  assert.ok(!off.includes('Inter Fallback'), 'adjust:false skips the fallback face');
  assert.ok(off.includes('--font-inter: "Inter", system-ui'), 'stack without fallback face');
});

await test('fontLinks(): preload for self-hosted, preconnect + css2 for Google', () => {
  const links = fontLinks(config);
  assert.deepEqual(links[0], { rel: 'preload', href: '/fonts/inter-var.woff2', as: 'font', type: 'font/woff2', crossorigin: '' });
  assert.ok(links.some((l) => l.rel === 'preconnect' && l.href === 'https://fonts.gstatic.com'), 'gstatic preconnect');
  const sheet = links.find((l) => l.rel === 'stylesheet');
  assert.equal(sheet.href, 'https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700&display=swap');
});

await test('preload can be disabled globally or per font', () => {
  assert.ok(!fontLinks({ ...config, preload: false }).some((l) => l.rel === 'preload'), 'global off');
  const per = fontLinks({ fonts: [{ family: 'X', src: '/x.woff2', preload: false }] });
  assert.equal(per.length, 0, 'per-font off');
});

await test('fonts() injects into document.head once and stop() removes it', () => {
  const stop = fonts(config);
  assert.ok(document.head.querySelector('style[data-spark-font]'), 'style injected');
  assert.ok(document.head.querySelector('link[rel="preload"]'), 'preload injected');
  const count = document.head.querySelectorAll('[data-spark-font]').length;
  fonts(config); // second call is a no-op
  assert.equal(document.head.querySelectorAll('[data-spark-font]').length, count, 'idempotent');
  stop();
  assert.equal(document.head.querySelectorAll('[data-spark-font]').length, 0, 'stop() cleans up');
});

await test('bun step injects before </head> in pages, skips fragments, idempotent', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'spark-font-'));
  mkdirSync(join(dist, 'components'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>hi</body></html>', 'utf8');
  writeFileSync(join(dist, 'components', 'card.html'), '<div class="card">{title}</div>', 'utf8');

  const p = sparkFont(config);
  await p.run({ outDir: dist });

  const page = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.ok(page.includes('<style data-spark-font>'), 'style baked into the page');
  assert.ok(page.indexOf('data-spark-font') < page.indexOf('</head>'), 'inside <head>');
  assert.ok(page.includes('rel="preload"'), 'preload link baked');
  assert.equal(readFileSync(join(dist, 'components', 'card.html'), 'utf8'), '<div class="card">{title}</div>', 'fragment untouched');

  await p.run({ outDir: dist }); // second run
  const again = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.equal(again, page, 'idempotent across runs');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
