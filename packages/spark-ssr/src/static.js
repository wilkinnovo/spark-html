/**
 * File serving: components, public/ + co-located static assets, and the
 * /@modules browser-module mapping for the Spark family packages.
 *
 * makeStatic(app) closes over the serve() context bag. app.pagesDir is
 * MUTABLE (refreshPages() re-resolves it per scan) — always read at call
 * time. app.seedFiles is the live Set of seed paths that must never be
 * served as static assets.
 */
import { join, resolve, extname, dirname } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

export function makeStatic(app) {
  const { root } = app;

  // mtime-cached reads: the renderer caches compiled component programs by
  // source string, so serving the SAME string until the file changes makes
  // component composition allocation-free on the request path (§1).
  const componentFiles = new Map(); // file → { mtime, source }
  async function loadComponent(spec) {
    let rel = String(spec).split(/[?#]/)[0].replace(/^\/+/, '');
    if (!rel.endsWith('.html')) rel += '.html';
    for (const base of [root, join(root, 'public'), app.pagesDir]) {
      const file = resolve(base, rel);
      if (file.startsWith(base) && existsSync(file) && statSync(file).isFile()) {
        const mtime = statSync(file).mtimeMs;
        const hit = componentFiles.get(file);
        if (hit && hit.mtime === mtime) return hit.source;
        const source = readFileSync(file, 'utf8');
        componentFiles.set(file, { mtime, source });
        return source;
      }
    }
    return null;
  }

  function staticFile(pathname) {
    const rel = pathname.replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return null;
    const candidates = [join(root, 'public', rel)];
    const ext = extname(rel);
    // The root fallback exists for co-located assets (pages/x.css, img/…) —
    // it must never serve project internals: config (may hold secrets),
    // lockfiles, databases, dotfiles, seed data. public/ stays intentional.
    const internal = rel.startsWith('.') || rel.includes('/.')
      || rel.startsWith('seed/')
      || ['spark.json', 'package.json', 'bun.lock', 'bun.lockb', 'package-lock.json'].includes(rel)
      || ['.db', '.sqlite', '.sqlite3'].includes(ext);
    if (!internal && ext && ext !== '.html') {
      candidates.push(join(root, rel), join(app.pagesDir, rel));
    } else if (!internal && rel.startsWith('components/')) {
      candidates.push(join(root, rel));
    }
    for (const file of candidates) {
      const abs = resolve(file);
      if (!abs.startsWith(root)) continue;
      if (app.seedFiles.has(abs)) continue;
      if (existsSync(abs) && statSync(abs).isFile()) return Bun.file(abs);
    }
    return null;
  }

  // spark-html + family packages, served as browser modules. The importmap
  // maps each package name to /@modules/<pkg>/<entry>, and sibling files in
  // the package resolve as relative imports under the same prefix (theme's
  // ./init.js, say). Bun's resolver falls back to its GLOBAL install cache
  // when a dir has no node_modules — that can be a different version than
  // the app's, so cache hits only count when nothing real resolves.
  const moduleInfo = new Map(); // pkg → { dir, entry } | null
  function moduleEntry(pkg) {
    if (moduleInfo.has(pkg)) return moduleInfo.get(pkg);
    let lastResort = null;
    for (const dir of [root, dirname(new URL(import.meta.url).pathname)]) {
      try {
        const file = Bun.resolveSync(pkg, dir);
        if (file.includes('/install/cache/')) { lastResort = lastResort || file; continue; }
        const info = { dir: dirname(file), entry: file.slice(file.lastIndexOf('/') + 1) };
        moduleInfo.set(pkg, info);
        return info;
      } catch { /* next */ }
    }
    const info = lastResort
      ? { dir: dirname(lastResort), entry: lastResort.slice(lastResort.lastIndexOf('/') + 1) }
      : null;
    moduleInfo.set(pkg, info);
    return info;
  }

  return { loadComponent, staticFile, moduleEntry };
}
