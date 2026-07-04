/**
 * Sources beyond SQL — the <spark-ssr> block stops meaning "SQL" and starts
 * meaning "where data comes from" (§8). All bundled, no deps: Bun has fetch,
 * the filesystem, and import() natively.
 *
 *   repo    = https://api.github.com/repos/x/y     URL — server-side fetch, JSON
 *   posts   = ./content/posts/*.md                 glob — files become rows
 *   weather = ./lib/weather.js                     module — default export (req, db)
 *
 * Plus the per-source TTL cache behind cache="…" (Tier 3): entries record
 * which tables their SQL read, and any write to a `live` table sweeps them.
 */
import { join, resolve, basename, extname } from 'node:path';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ── URL source ─────────────────────────────────────────────────────────
// `:param` interpolates from the request (path params, then query), URL-encoded.
export async function urlSource(url, req) {
  const resolved = String(url).replace(/:([a-zA-Z_$][\w$]*)/g, (m, name) => {
    const v = req?.params?.[name] ?? req?.query?.[name];
    return v === undefined ? m : encodeURIComponent(String(v));
  });
  const res = await fetch(resolved, { headers: { accept: 'application/json' } });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ── glob source ────────────────────────────────────────────────────────
// Files become rows: front-matter → columns, body → .body, filename → .slug.
// A blog/docs/portfolio site with no database at all. Markdown stays text —
// rendering belongs to a companion package, the core is HTML-only.
export function parseFrontMatter(text) {
  const s = String(text);
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: s };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v !== '' && !Number.isNaN(Number(v)) && /^-?[\d.]+$/.test(v)) v = Number(v);
    data[kv[1]] = v;
  }
  return { data, body: s.slice(m[0].length) };
}

// Minimal glob: `*` within a segment, `**` for any depth. Enough for
// ./content/posts/*.md — not a general matcher.
function globRegex(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' GLOBSTAR ')
    .replace(/\*/g, '[^/]*')
    .replace(/ GLOBSTAR /g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp('^' + esc + '$');
}

export function globSource(pattern, root) {
  const rel = String(pattern).replace(/^\.\//, '');
  const rx = globRegex(rel);
  // Walk from the deepest literal directory prefix.
  let start = root;
  for (const seg of rel.split('/')) {
    if (/[*?]/.test(seg)) break;
    const next = join(start, seg);
    if (existsSync(next) && statSync(next).isDirectory()) start = next;
    else break;
  }
  const rows = [];
  (function walk(dir) {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const f of names) {
      if (f.startsWith('.')) continue;
      const full = join(dir, f);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      const relPath = full.slice(root.length + 1).split('\\').join('/');
      if (!rx.test(relPath)) continue;
      const raw = readFileSync(full, 'utf8');
      const { data, body } = parseFrontMatter(raw);
      rows.push({
        slug: basename(f, extname(f)),
        path: '/' + relPath,
        mtime: st.mtimeMs,
        ...data,
        body,
      });
    }
  })(start);
  // Date-ish front matter first when present, else filename order.
  rows.sort((a, b) => (a.date && b.date) ? String(b.date).localeCompare(String(a.date)) : a.slug.localeCompare(b.slug));
  return rows;
}

// ── module source ──────────────────────────────────────────────────────
// default export (req, db) => value. In dev the import is mtime-busted so
// edits take effect without a restart.
export async function moduleSource(spec, root, req, db, { watch = true } = {}) {
  const file = resolve(root, String(spec).replace(/^\.\//, ''));
  if (!file.startsWith(root) || !existsSync(file)) return null;
  const bust = watch ? '?v=' + statSync(file).mtimeMs : '';
  const mod = await import(pathToFileURL(file).href + bust);
  const fn = mod.default;
  return typeof fn === 'function' ? await fn(req, db) : fn ?? null;
}

// ── the per-source TTL cache (cache="…") ───────────────────────────────
export function makeSourceCache() {
  const store = new Map(); // key → { value, expires, tables:Set }
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expires < Date.now()) { store.delete(key); return undefined; }
      return hit;
    },
    set(key, value, ttlSeconds, tables = new Set()) {
      store.set(key, { value, expires: Date.now() + ttlSeconds * 1000, tables });
    },
    // A write went through table t — every cached source that read it is stale.
    invalidate(table) {
      for (const [k, v] of store) if (v.tables.has(table)) store.delete(k);
    },
    clear() { store.clear(); },
    size() { return store.size; },
  };
}
