/** spark-html-persist — hydrate from storage, save on change, filter keys. */
import { strict as assert } from 'node:assert';

// Minimal in-memory Storage stand-in.
function makeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}

const { store } = await import('spark-html');
const { persist } = await import('../src/index.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0)); // flush microtasks

console.log('spark-html-persist');

await test('hydrates from storage on top of defaults', () => {
  const storage = makeStorage({ 'spark:s1': JSON.stringify({ theme: 'light' }) });
  const s = persist('s1', { theme: 'dark', size: 14 }, { storage });
  assert.equal(s.theme, 'light', 'saved value wins');
  assert.equal(s.size, 14, 'new default still present');
});

await test('saves to storage on change (coalesced to one write)', async () => {
  const storage = makeStorage();
  const s = persist('s2', { count: 0 }, { storage });
  s.count = 1;
  s.count = 2; // burst → one write
  await tick();
  assert.deepEqual(JSON.parse(storage.getItem('spark:s2')), { count: 2 });
});

await test('custom key + include/exclude filtering', async () => {
  const storage = makeStorage();
  const s = persist('s3', { a: 1, b: 2, secret: 'x' }, { storage, key: 'k3', exclude: ['secret'] });
  s.a = 9;
  await tick();
  const saved = JSON.parse(storage.getItem('k3'));
  assert.equal(saved.a, 9);
  assert.equal('secret' in saved, false, 'excluded key not persisted');
});

await test('include = persist only the listed keys', async () => {
  const storage = makeStorage();
  const s = persist('s4', { keep: 1, drop: 2 }, { storage, include: ['keep'] });
  s.keep = 5; s.drop = 6;
  await tick();
  const saved = JSON.parse(storage.getItem('spark:s4'));
  assert.deepEqual(saved, { keep: 5 });
});

await test('corrupt storage falls back to defaults (no throw)', () => {
  const storage = makeStorage({ 'spark:s5': '{not json' });
  const s = persist('s5', { ok: true }, { storage });
  assert.equal(s.ok, true);
});

await test('returns the same store as store(name)', () => {
  const storage = makeStorage();
  const a = persist('s6', { x: 1 }, { storage });
  const b = store('s6');
  a.x = 42;
  assert.equal(b.x, 42, 'persist() store === store(name)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
