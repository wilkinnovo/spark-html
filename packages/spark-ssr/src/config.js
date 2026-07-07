/**
 * spark.json — the whole config. Values prefixed "ENV." resolve from
 * process.env at load time, so secrets never live in the file.
 *
 *   { "db": "sqlite://./dev.db",
 *     "auth": { "table": "users", "identity": "email", "secret": "ENV.SESSION_SECRET" },
 *     "cors": true }
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

function resolveEnv(v) {
  if (typeof v === 'string' && v.startsWith('ENV.')) {
    const key = v.slice(4);
    const val = process.env[key];
    if (val === undefined) {
      throw new Error(`spark.json references ${v} but ${key} is not set in the environment`);
    }
    return val;
  }
  if (Array.isArray(v)) return v.map(resolveEnv);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveEnv(val);
    return out;
  }
  return v;
}

export function loadConfig(root) {
  const file = join(root, 'spark.json');
  const exists = existsSync(file);
  const raw = exists ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg = resolveEnv(raw);
  return {
    // Config-less start (Tier 4.9): with NO spark.json at all, `db` defaults to
    // a local SQLite file, so `bun spark-ssr` runs on a folder holding one
    // index.html — zero files to begin. A spark.json that exists but omits `db`
    // stays deliberately database-free (the markdown-blog templates rely on it).
    db: cfg.db || (exists ? null : 'sqlite://./dev.db'),
    auth: cfg.auth || null,
    cors: cfg.cors ?? false,
    uploads: cfg.uploads || 'uploads',
    // Cap on any single request body (uploads + JSON), enforced at the socket
    // by Bun before the body is buffered — an over-limit request gets 413 and
    // never reaches a handler. Default 10 MB; `maxBodyMb` in spark.json tunes it.
    maxBodyMb: typeof cfg.maxBodyMb === 'number' ? cfg.maxBodyMb : 10,
    // Declarative mail (Tier 3.8): a module path ("./lib/mail.js" — default
    // export (msg) => …), a { url, from, headers } webhook, or null for the
    // dev logger. Jobs and handlers call mail() the same way regardless.
    mail: cfg.mail || null,
    // Companion-package config, same shapes their build-pipeline steps take:
    // "fonts" → spark-html-font tags in every <head>; "images" → options for
    // the spark-html-image pass `spark-ssr build` runs when it's installed.
    fonts: cfg.fonts || null,
    images: cfg.images || null,
  };
}
