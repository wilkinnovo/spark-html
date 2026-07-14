/**
 * spark-html-dev-tls — a local HTTPS reverse proxy for spark-html dev servers.
 *
 * Your `dev` script stays exactly as it is (plain HTTP). `secure` is an opt-in
 * wrapper for device testing: it spawns that same dev server on a private port
 * and fronts it with HTTPS on the public one, so secure-context APIs (camera,
 * mic, geolocation, service workers) work when you open the app on your phone.
 *
 * It is mode-agnostic by construction — an HTTP→HTTPS proxy doesn't care
 * whether spark-ssr, client-only, or prerender is behind it. It relays plain
 * requests, Server-Sent Events (spark-ssr's /__spark/reload + /__spark/live),
 * and the WebSocket HMR channel (spark-html-bun's /__spark_hmr) alike, and
 * adds `x-forwarded-proto: https` so the dev server sets Secure cookies right.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureCert, lanIPs } from './cert.js';

/** Detect which dev server a project uses, from its shape. Null if unknown. */
export function detectDev(root) {
  if (existsSync(join(root, 'spark.json')) || existsSync(join(root, 'pages'))) {
    return ['bun', 'spark-ssr'];
  }
  if (['spark.config.js', 'spark.config.mjs', 'spark.config.ts']
    .some((f) => existsSync(join(root, f)))) {
    return ['bun', 'spark', 'dev'];
  }
  return null;
}

/**
 * Start the HTTPS reverse proxy in front of a plain-HTTP dev server already
 * (or soon) listening on `targetPort`. Returns the Bun server.
 */
export function startProxy({ port, targetPort, cert, key }) {
  const httpTarget = 'http://127.0.0.1:' + targetPort;
  const wsTarget = 'ws://127.0.0.1:' + targetPort;
  return Bun.serve({
    port,
    tls: { cert: Bun.file(cert), key: Bun.file(key) },
    idleTimeout: 60,
    async fetch(req, server) {
      const url = new URL(req.url);
      // WebSocket HMR — hand off to the websocket handler, which relays frames.
      if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
        if (server.upgrade(req, { data: { path: url.pathname + url.search } })) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      // Everything else streams straight through (SSE included). The forwarded
      // headers tell an origin-aware server (spark-ssr) the request was secure.
      const headers = new Headers(req.headers);
      headers.set('x-forwarded-proto', 'https');
      headers.set('x-forwarded-host', url.host);
      try {
        return await fetch(httpTarget + url.pathname + url.search, {
          method: req.method,
          headers,
          body: req.body,
          redirect: 'manual',
          duplex: 'half',
        });
      } catch {
        return new Response('dev server not ready on ' + httpTarget, { status: 502 });
      }
    },
    websocket: {
      open(ws) {
        const up = new WebSocket(wsTarget + ws.data.path);
        ws.data.up = up;
        ws.data.queue = [];
        ws.data.ready = false;
        up.onopen = () => { ws.data.ready = true; for (const m of ws.data.queue) up.send(m); ws.data.queue = []; };
        up.onmessage = (e) => { try { ws.send(e.data); } catch { /* client gone */ } };
        up.onclose = () => { try { ws.close(); } catch { /* already closed */ } };
        up.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
      },
      message(ws, msg) { if (ws.data.ready) ws.data.up.send(msg); else ws.data.queue.push(msg); },
      close(ws) { try { ws.data.up?.close(); } catch { /* already closed */ } },
    },
  });
}

/** Poll `port` over HTTP until it answers (or the timeout elapses). */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const url = 'http://127.0.0.1:' + port + '/';
  for (;;) {
    try { await fetch(url); return true; }
    catch {
      if (Date.now() > deadline) return false;
      await Bun.sleep(150);
    }
  }
}

/**
 * The orchestrator behind `bun spark-html-dev-tls`: resolve a cert, spawn the
 * (detected or explicit) dev server on a private port, and front it with HTTPS.
 * Returns { server, child }.
 */
export async function secure(opts = {}) {
  const root = resolve(opts.root || process.cwd());
  const port = opts.port ?? 3000;
  const targetPort = opts.targetPort ?? port + 1;

  let cmd = opts.cmd;
  if (!cmd || !cmd.length) {
    cmd = detectDev(root);
    if (!cmd) {
      throw new Error(
        '[spark-html-dev-tls] could not detect the project type (no spark.json / pages/ or spark.config.js).\n'
        + '  Pass the dev command explicitly:  spark-html-dev-tls -- <cmd…>   e.g.  -- bun spark-ssr',
      );
    }
  }

  const { cert, key, reused } = opts.cert && opts.key
    ? { cert: opts.cert, key: opts.key, reused: true }
    : await ensureCert({ dir: join(root, '.spark') });

  // Spawn the real dev server on the private HTTP port. PORT + --port both set
  // so it lands there whichever knob it reads.
  const child = Bun.spawn([...cmd, '--port', String(targetPort)], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, PORT: String(targetPort) },
  });
  const shutdown = () => { try { child.kill(); } catch { /* gone */ } };
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  child.exited.then((code) => { process.exit(code ?? 0); });

  await waitForPort(targetPort, 20_000);
  const server = startProxy({ port, targetPort, cert, key });

  const ips = lanIPs();
  console.log(`\n[spark-html-dev-tls] 🔒 HTTPS on :${port}  →  ${cmd.join(' ')} on :${targetPort}${reused ? '' : '  (new self-signed cert)'}`);
  console.log(`  local:    https://localhost:${port}/`);
  for (const ip of ips) console.log(`  network:  https://${ip}:${port}/   ← open this on your phone`);
  console.log('  (self-signed — accept the browser warning once)\n');
  return { server, child };
}
