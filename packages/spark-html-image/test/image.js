/**
 * spark-html-image — the Vite plugin converts local <img> references to
 * webp/avif variants with srcset, across pages AND component fragments,
 * leaving externals/SVGs/authored srcsets alone.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import sparkImage from '../src/index.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\nspark-html-image');

// A synthetic 1600×900 png to optimize.
async function makeDist() {
  const dist = mkdtempSync(join(tmpdir(), 'spark-img-'));
  mkdirSync(join(dist, 'img'));
  mkdirSync(join(dist, 'components'));
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .png().toFile(join(dist, 'img', 'hero.png'));
  writeFileSync(join(dist, 'index.html'),
    '<!doctype html><html><head><title>t</title></head><body>' +
    '<img src="/img/hero.png" alt="hero">' +
    '<img src="https://cdn.example.com/x.png" alt="ext">' +
    '<img src="/img/logo.svg" alt="svg">' +
    '<img src="/img/missing.png" alt="gone">' +
    '<img src="/img/hero.png" srcset="/custom.webp 1w" alt="authored">' +
    '</body></html>', 'utf8');
  writeFileSync(join(dist, 'components', 'card.html'),
    '<div class="card"><img src="../img/hero.png" class="thumb" alt="c">{title}</div>\n' +
    '<script>let title = "hi";</script>', 'utf8');
  return dist;
}

const dist = await makeDist();
const plugin = sparkImage();
plugin.configResolved({ build: { outDir: dist } });
await plugin.closeBundle.handler();
const index = readFileSync(join(dist, 'index.html'), 'utf8');

await test('webp variants are generated (sub-widths + intrinsic, no upscale)', () => {
  for (const f of ['hero-640.webp', 'hero-960.webp', 'hero-1280.webp', 'hero.webp']) {
    assert.ok(existsSync(join(dist, 'img', f)), `${f} written`);
  }
  assert.ok(!existsSync(join(dist, 'img', 'hero-1920.webp')), 'no upscale past 1600px');
});

await test('the img gains srcset/sizes with the original src as fallback', () => {
  assert.ok(index.includes('src="/img/hero.png"'), 'original src kept');
  assert.ok(index.includes('/img/hero-640.webp 640w'), 'width variant in srcset');
  assert.ok(index.includes('/img/hero.webp 1600w'), 'intrinsic variant in srcset');
  assert.ok(index.includes('sizes="100vw"'), 'default sizes');
});

await test('width/height (CLS) and lazy-loading attributes are added', () => {
  assert.ok(index.includes('width="1600"') && index.includes('height="900"'), 'dimensions');
  assert.ok(index.includes('loading="lazy"') && index.includes('decoding="async"'), 'lazy');
});

await test('external URLs, SVGs, missing files, and authored srcsets are untouched', () => {
  assert.ok(index.includes('src="https://cdn.example.com/x.png" alt="ext"'), 'external kept verbatim');
  assert.ok(index.includes('src="/img/logo.svg" alt="svg"'), 'svg kept verbatim');
  assert.ok(index.includes('src="/img/missing.png" alt="gone"'), 'missing file skipped');
  assert.ok(index.includes('srcset="/custom.webp 1w"'), 'authored srcset respected');
});

await test('component fragments are optimized too — and stay fragments', () => {
  const card = readFileSync(join(dist, 'components', 'card.html'), 'utf8');
  assert.ok(card.includes('../img/hero-640.webp 640w'), 'relative src resolved + rewritten');
  assert.ok(card.includes('{title}'), 'spark interpolation preserved byte-for-byte');
  assert.ok(!card.includes('<html'), 'no document wrapper injected');
  assert.ok(card.includes('<script>let title = "hi";</script>'), 'script preserved');
});

await test('picture mode wraps in <picture> with one <source> per format', async () => {
  const dist2 = await makeDist();
  const p2 = sparkImage({ picture: true, formats: ['avif', 'webp'], widths: [640] });
  p2.configResolved({ build: { outDir: dist2 } });
  await p2.closeBundle.handler();
  const html = readFileSync(join(dist2, 'index.html'), 'utf8');
  assert.ok(/<picture><source [^>]*type="image\/avif"/.test(html), 'avif source first');
  assert.ok(html.includes('type="image/webp"'), 'webp source present');
  assert.ok(/<img [^>]*src="\/img\/hero.png"/.test(html), 'img fallback inside picture');
  assert.ok(existsSync(join(dist2, 'img', 'hero-640.avif')), 'avif variant written');
});

await test('a second run is idempotent (srcset already present → skipped)', async () => {
  const before = readFileSync(join(dist, 'index.html'), 'utf8');
  await plugin.closeBundle.handler();
  assert.equal(readFileSync(join(dist, 'index.html'), 'utf8'), before);
});

await test('EXIF-rotated photos: orientation baked in, display dimensions written', async () => {
  const dist3 = mkdtempSync(join(tmpdir(), 'spark-img-'));
  mkdirSync(join(dist3, 'img'));
  // A landscape sensor frame (1600×900) tagged orientation 6 — cameras store
  // portrait shots this way; browsers DISPLAY it rotated as 900×1600.
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 40, g: 200, b: 40 } } })
    .jpeg().withMetadata({ orientation: 6 }).toFile(join(dist3, 'img', 'photo.jpg'));
  writeFileSync(join(dist3, 'index.html'),
    '<!doctype html><html><head></head><body><img src="/img/photo.jpg" alt="p"></body></html>', 'utf8');
  const p3 = sparkImage({ widths: [640] });
  p3.configResolved({ build: { outDir: dist3 } });
  await p3.closeBundle.handler();
  const html = readFileSync(join(dist3, 'index.html'), 'utf8');
  assert.ok(html.includes('width="900"') && html.includes('height="1600"'),
    'width/height match what the browser renders, not the sensor frame');
  assert.ok(html.includes('/img/photo.webp 900w'), 'intrinsic descriptor uses display width');
  const out = await sharp(join(dist3, 'img', 'photo.webp')).metadata();
  assert.equal(`${out.width}x${out.height}`, '900x1600', 'webp pixels are actually rotated');
  const resized = await sharp(join(dist3, 'img', 'photo-640.webp')).metadata();
  assert.equal(resized.width, 640, 'resized variant targets display width');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
