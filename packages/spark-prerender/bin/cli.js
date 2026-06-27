#!/usr/bin/env node
/**
 * spark-prerender CLI
 *
 *   spark-prerender <page.html> [more.html ...] [options]
 *
 * Prerenders each entry HTML file to fully-rendered, crawler-ready HTML.
 * Multi-page sites are an MPA — just list each page (no router). By default
 * each file is rewritten in place (intended for a post-build step over dist/);
 * pass --out <dir> to write copies elsewhere instead.
 *
 * Options:
 *   --out <dir>     Write output to <dir>/<basename> instead of in place.
 *   --root <dir>    Base dir for resolving import="components/x" (default: the
 *                   entry file's directory; also tries <root>/public, /dist).
 *   -h, --help      Show this help.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { prerender, routesOf, routeToFile, redirectsFor, vercelConfigFor } from '../src/prerender.js';

function parseArgs(argv) {
  const entries = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else entries.push(a);
  }
  return { entries, opts };
}

const HELP = `spark-prerender — SEO prerender for spark-html

Usage:
  spark-prerender <page.html> [more.html ...] [--out <dir>] [--root <dir>]

Examples:
  spark-prerender dist/index.html dist/docs.html
  spark-prerender site/index.html --out build --root site
`;

async function main() {
  const { entries, opts } = parseArgs(process.argv.slice(2));
  if (opts.help || entries.length === 0) {
    process.stdout.write(HELP);
    process.exit(entries.length === 0 && !opts.help ? 2 : 0);
  }

  let failures = 0;
  for (const entry of entries) {
    const entryAbs = resolve(entry);
    const outDir = opts.out ? resolve(opts.out) : dirname(entryAbs);
    try {
      // A routed entry (spark-html-router) expands to one file per route.
      const routes = routesOf(await readFile(entryAbs, 'utf8'));
      if (routes.length) {
        const all = routes.includes('/') ? routes : ['/', ...routes];
        // Render every route from the ORIGINAL entry first, then write — the
        // "/" route's output file IS the entry, so writing mid-loop would
        // clobber the source the remaining routes re-read.
        const rendered = [];
        for (const route of all) {
          rendered.push([route, routeToFile(route), await prerender(entryAbs, { root: opts.root, route })]);
        }
        for (const [route, name, html] of rendered) {
          const dest = join(outDir, name);
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, html, 'utf8');
          console.log(`✓ ${entry} [${route}] → ${name} (${Buffer.byteLength(html)} bytes)`);
        }
        await writeFile(join(outDir, '_redirects'), redirectsFor(all), 'utf8');
        await writeFile(join(outDir, 'vercel.json'), vercelConfigFor(all), 'utf8');
        console.log(`✓ wrote _redirects + vercel.json (${all.length} routes)`);
        continue;
      }

      const html = await prerender(entryAbs, { root: opts.root });
      const dest = opts.out ? join(outDir, basename(entryAbs)) : entryAbs;
      if (opts.out) await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, html, 'utf8');
      console.log(`✓ ${entry} → ${opts.out ? dest : 'in place'} (${Buffer.byteLength(html)} bytes)`);
    } catch (e) {
      failures++;
      console.error(`✗ ${entry} — ${e.message}`);
    }
  }
  process.exit(failures ? 1 : 0);
}

main();
