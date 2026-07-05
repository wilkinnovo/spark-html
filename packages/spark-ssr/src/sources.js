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
import { statSync, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
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

// Parsed rows cache (§4): re-reading, re-front-matter-parsing and re-sorting
// the same files on every request was most of a markdown site's render cost.
// The walk still happens (readdir + stat are cheap and catch adds/removes),
// but a file whose mtime hasn't moved reuses its parsed row, and an entirely
// unchanged corpus returns the same rows array. I/O is fs/promises now, so a
// glob render yields instead of blocking the event loop (§4).
const GLOB_CACHE = new Map(); // `${root}|${pattern}` → { rows, files: Map(path → { mtime, row }) }

export async function globSource(pattern, root) {
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
  const key = root + '|' + rel;
  const cached = GLOB_CACHE.get(key);
  const prev = cached ? cached.files : new Map();
  const files = new Map();
  let changed = !cached;
  await (async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      const relPath = full.slice(root.length + 1).split('\\').join('/');
      if (!rx.test(relPath)) continue;
      let st;
      try { st = await stat(full); } catch { continue; }
      const hit = prev.get(full);
      if (hit && hit.mtime === st.mtimeMs) { files.set(full, hit); continue; }
      const raw = await readFile(full, 'utf8');
      const { data, body } = parseFrontMatter(raw);
      files.set(full, {
        mtime: st.mtimeMs,
        row: {
          slug: basename(e.name, extname(e.name)),
          path: '/' + relPath,
          mtime: st.mtimeMs,
          ...data,
          body,
        },
      });
      changed = true;
    }
  })(start);
  if (!changed && files.size === prev.size) return cached.rows;
  const rows = [...files.values()].map((f) => f.row);
  // Date-ish front matter first when present, else filename order.
  rows.sort((a, b) => (a.date && b.date) ? String(b.date).localeCompare(String(a.date)) : a.slug.localeCompare(b.slug));
  GLOB_CACHE.set(key, { rows, files });
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
// Bounded (§5): table-scoped keys include session id + query params, so a
// busy multi-user app accumulates one entry per (user × query-combo) —
// unbounded, and entries never requested again were never freed. Now: LRU
// eviction at `max`, a sweep() the server calls on its heartbeat to free
// expired entries eagerly, and a per-table key index so invalidate(table)
// touches only that table's keys instead of scanning the whole map.
export function makeSourceCache({ max = 500 } = {}) {
  const store = new Map(); // key → { value, expires, tables:Set } — Map order = LRU order
  const byTable = new Map(); // table → Set(key)
  const unindex = (key, hit) => {
    for (const t of hit.tables) {
      const set = byTable.get(t);
      if (set) { set.delete(key); if (!set.size) byTable.delete(t); }
    }
  };
  const drop = (key) => {
    const hit = store.get(key);
    if (!hit) return;
    store.delete(key);
    unindex(key, hit);
  };
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expires < Date.now()) { drop(key); return undefined; }
      // Refresh recency: re-insert so the oldest entry is always first.
      store.delete(key);
      store.set(key, hit);
      return hit;
    },
    set(key, value, ttlSeconds, tables = new Set()) {
      drop(key); // replace cleanly (old entry may index different tables)
      if (store.size >= max) drop(store.keys().next().value); // evict LRU
      store.set(key, { value, expires: Date.now() + ttlSeconds * 1000, tables });
      for (const t of tables) {
        (byTable.get(t) || byTable.set(t, new Set()).get(t)).add(key);
      }
    },
    // A write went through table t — every cached source that read it is stale.
    invalidate(table) {
      const keys = byTable.get(table);
      if (!keys) return;
      for (const key of [...keys]) drop(key);
    },
    // Called on the server's heartbeat: expired entries that would otherwise
    // wait for a get() that may never come.
    sweep() {
      const now = Date.now();
      for (const [k, v] of store) if (v.expires < now) drop(k);
    },
    clear() { store.clear(); byTable.clear(); },
    size() { return store.size; },
  };
}
