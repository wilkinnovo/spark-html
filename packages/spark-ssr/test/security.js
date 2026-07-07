/**
 * spark-ssr — the M3.3 security pass, exercised against real temp projects.
 * Runs under `bun` (Bun.serve / bun:sqlite are the product); the root
 * `npm test` chain invokes it through scripts/test-bun.mjs.
 *
 * Every test here is written to FAIL if its protection is removed — that is
 * the whole point of a security suite (check-by-reading proves nothing). The
 * checklist lives in packages/spark-ssr/SECURITY.md; each item maps to a test
 * below. `localPath` is unit-covered inline; the rest go end-to-end through
 * a running server, the way an attacker reaches them.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { serve } from '../src/index.js';
import { localPath } from '../src/request.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack || e.message}`); }
}

console.log('\nspark-ssr security (M3.3)');

// A project with auth + a scoped notes table and a page that reads {session}
// and posts a note through the no-JS form path (so _redirect is in play).
function makeAuthApp(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-sec-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({
    db: 'sqlite::memory:',
    auth: { table: 'users', identity: 'email', secret: 'sec-test-secret' },
    ...extra,
  }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.html'),
    '<p id="who">{session ? session.email : \'anon\'}</p>\n'
    + '<spark-ssr table="notes" />\n'
    + '<template each="n in notes"><p class="note">{n.body}</p></template>\n'
    + '<form method="post" action="/api/notes">\n'
    + '  <input name="body" required>\n'
    + '  <input type="hidden" name="_redirect" value="/">\n'
    + '  <button>add</button>\n'
    + '</form>');
  return root;
}

async function signup(B, email = 'me@x.com', password = 'secret') {
  await fetch(`${B}/api/users`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}
async function login(B, opts = {}) {
  const r = await fetch(`${B}/api/users?auth`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...(opts.headers || {}) },
    body: `email=me%40x.com&password=${opts.password ?? 'secret'}`,
  });
  return r;
}

// ── open redirect / header injection through _redirect (and ?next) ──────────
await test('localPath rejects protocol-relative, backslash, absolute-URL and CRLF targets', () => {
  assert.equal(localPath('/dashboard'), '/dashboard');
  assert.equal(localPath('/a?b=1&c=2'), '/a?b=1&c=2');
  for (const bad of ['//evil.com', '/\\evil.com', 'http://evil', 'evil', '', null, undefined, '/x\r\nSet-Cookie: y=1']) {
    assert.equal(localPath(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

await test('no-JS form: a hostile _redirect can never send the browser off-origin', async () => {
  const root = makeAuthApp();
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    await signup(B);
    const cookie = (await login(B)).headers.get('set-cookie').split(';')[0];
    const post = (redir) => fetch(`${B}/api/notes`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', referer: `${B}/` },
      body: `body=hi&_redirect=${encodeURIComponent(redir)}`,
    });
    for (const target of ['//evil.com', '/\\evil.com', 'https://evil.com/x']) {
      const r = await post(target);
      assert.equal(r.status, 303, 'form still redirects');
      const loc = r.headers.get('location');
      // The whole point: the Location must stay on THIS origin — never the host
      // the attacker tried to smuggle in via a protocol-relative / absolute URL.
      assert.ok(!/evil\.com/.test(loc), `open redirect leaked: ${loc}`);
      assert.ok(loc.startsWith('/') && !loc.startsWith('//'), `not a safe local path: ${loc}`);
    }
    // A legitimate local target is honored.
    assert.equal((await post('/done')).headers.get('location'), '/done', 'valid local redirect preserved');
  } finally { await s.stop?.(); }
});

// ── Secure cookie flag on HTTPS (trusted X-Forwarded-Proto) ─────────────────
await test('session cookie gets Secure over HTTPS, and not over plain HTTP', async () => {
  const root = makeAuthApp();
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    await signup(B);
    const plain = await login(B);
    const plainCookie = plain.headers.get('set-cookie') || '';
    assert.ok(plainCookie.includes('spark_session='), 'logged in over http');
    assert.ok(!/;\s*Secure/i.test(plainCookie), 'no Secure over plain http (would break the cookie)');

    const https = await login(B, { headers: { 'x-forwarded-proto': 'https' } });
    const httpsCookie = https.headers.get('set-cookie') || '';
    assert.ok(/;\s*Secure/i.test(httpsCookie), 'Secure set when the proxy reports https');
    assert.ok(/HttpOnly/i.test(httpsCookie) && /SameSite=Lax/i.test(httpsCookie), 'HttpOnly + SameSite intact');
  } finally { await s.stop?.(); }
});

// ── /login brute-force rate limiting ────────────────────────────────────────
await test('login is rate-limited per IP — a burst of bad attempts hits 429', async () => {
  const root = makeAuthApp();
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    await signup(B);
    let saw429 = false, sawEarly401 = false;
    for (let i = 0; i < 25; i++) {
      const r = await login(B, { password: 'wrong' });
      if (i < 5 && r.status === 401) sawEarly401 = true;
      if (r.status === 429) { saw429 = true; break; }
    }
    assert.ok(sawEarly401, 'first attempts answer 401 (limiter not tripping immediately)');
    assert.ok(saw429, 'a sustained burst is eventually blocked with 429');
  } finally { await s.stop?.(); }
});

// ── request-body / upload size ceiling ──────────────────────────────────────
await test('an over-limit request body is rejected at the socket (413), under limit is fine', async () => {
  const root = makeAuthApp({ maxBodyMb: 0.01 }); // ~10 KB ceiling
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    await signup(B);
    const cookie = (await login(B)).headers.get('set-cookie').split(';')[0];
    // Over the ceiling → rejected at the socket (413) before it ever buffers.
    const big = await fetch(`${B}/api/notes`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x'.repeat(50_000) }),
    }).catch((e) => ({ status: 413, _err: String(e) }));
    assert.equal(big.status, 413, 'oversize body → 413');

    const small = await fetch(`${B}/api/notes`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'ok' }),
    });
    assert.ok(small.status < 400, `small body accepted (${small.status})`);
  } finally { await s.stop?.(); }
});

// ── production requires an explicit session secret ──────────────────────────
await test('production (watch:false) with auth but no secret fails hard at startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-sec-'));
  writeFileSync(join(root, 'spark.json'),
    JSON.stringify({ db: 'sqlite::memory:', auth: { table: 'users', identity: 'email' } }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.html'), '<h1>home</h1>');

  await assert.rejects(
    () => serve({ root, port: 0, quiet: true, watch: false }),
    /auth\.secret/,
    'must refuse to start a production auth server with an ephemeral key',
  );
  // With a secret it starts fine.
  const ok = await serve({ root, port: 0, quiet: true, watch: false, config: { auth: { table: 'users', identity: 'email', secret: 'x' } } });
  assert.ok(ok.port > 0, 'starts once a secret is supplied');
  await ok.stop?.();
});

// ── SQL identifier allowlist: ?sort can't inject ────────────────────────────
await test('?sort is allowlisted against real columns — injection is ignored, not executed', async () => {
  const root = makeAuthApp();
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    await signup(B);
    const cookie = (await login(B)).headers.get('set-cookie').split(';')[0];
    // Seed a couple of scoped notes.
    for (const body of ['alpha', 'bravo']) {
      await fetch(`${B}/api/notes`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
    }
    // A valid sort works…
    const sorted = await fetch(`${B}/api/notes?sort=body:desc`, { headers: { cookie } });
    assert.equal(sorted.status, 200);
    const rows = await sorted.json();
    assert.deepEqual(rows.map((r) => r.body), ['bravo', 'alpha'], 'valid sort applied');
    // …and an injection attempt is silently ignored (200, rows intact) rather
    // than reaching SQL (which would 500). If the allowlist were removed the
    // bogus identifier would raise a SQL error and this would not be 200.
    const evil = await fetch(`${B}/api/notes?sort=${encodeURIComponent('body; DROP TABLE notes;--')}`, { headers: { cookie } });
    assert.equal(evil.status, 200, 'injection did not reach SQL');
    assert.equal((await evil.json()).length, 2, 'notes table intact after the attempt');
  } finally { await s.stop?.(); }
});

// ── path traversal + server-dir exposure on static serving ──────────────────
await test('traversal out of the project root is refused (404, no file contents)', async () => {
  const root = makeAuthApp();
  mkdirSync(join(root, 'public'), { recursive: true });
  writeFileSync(join(root, 'public', 'ok.txt'), 'public-ok');
  // A secret OUTSIDE the project root — the real escape target. `..` is sent
  // percent-encoded so fetch() doesn't normalize it away before it hits us.
  writeFileSync(join(root, '..', 'sec-outside.txt'), 'TOP SECRET');
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    assert.equal(await (await fetch(`${B}/ok.txt`)).text(), 'public-ok', 'real asset serves');
    for (const attack of [
      '/%2e%2e/sec-outside.txt',
      '/uploads/%2e%2e%2f%2e%2e%2fsec-outside.txt',
      '/public/%2e%2e%2f%2e%2e%2fsec-outside.txt',
    ]) {
      const r = await fetch(`${B}${attack}`);
      assert.ok(!(await r.text()).includes('TOP SECRET'), `traversal leaked a file via ${attack}`);
      assert.equal(r.status, 404, `traversal attempt should 404 (${attack})`);
    }
  } finally { await s.stop?.(); }
});

await test('server-only source trees (node_modules/, jobs/, lib/) are never served as static', async () => {
  const root = makeAuthApp();
  for (const [dir, file, body] of [
    ['node_modules/pkg', 'index.js', 'const KEY="nm-leak"'],
    ['jobs', 'notify.js', 'const S="job-leak"'],
    ['lib', 'mail.js', 'const APIKEY="mail-leak"'],
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, file), body);
  }
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    for (const [p, marker] of [
      ['/node_modules/pkg/index.js', 'nm-leak'],
      ['/jobs/notify.js', 'job-leak'],
      ['/lib/mail.js', 'mail-leak'],
    ]) {
      const r = await fetch(`${B}${p}`);
      assert.ok(!(await r.text()).includes(marker), `${p} leaked server-side source`);
      assert.equal(r.status, 404, `${p} should 404`);
    }
  } finally { await s.stop?.(); }
});

// ── response-cache: an authenticated request never gets an anonymous entry ───
await test('response cache is anon-only — a request with a session cookie bypasses it', async () => {
  const root = makeAuthApp();
  // Production so the response cache is live (dev always re-renders).
  const s = await serve({ root, port: 0, quiet: true, watch: false, config: { auth: { table: 'users', identity: 'email', secret: 'x' } } });
  const B = `http://localhost:${s.port}`;
  try {
    await signup(B);
    // Warm the cache with an anonymous view.
    const anon = await (await fetch(`${B}/`)).text();
    assert.ok(/id="who">anon</.test(anon), 'anon sees the logged-out view');
    const cookie = (await login(B)).headers.get('set-cookie').split(';')[0];
    // The authenticated request must NOT be served the cached anon HTML.
    const authed = await (await fetch(`${B}/`, { headers: { cookie } })).text();
    assert.ok(/id="who">me@x\.com</.test(authed), 'cookie request bypasses the anon cache');
  } finally { await s.stop?.(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
