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
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg = resolveEnv(raw);
  return {
    db: cfg.db || null,
    auth: cfg.auth || null,
    cors: cfg.cors ?? false,
    uploads: cfg.uploads || 'uploads',
  };
}
