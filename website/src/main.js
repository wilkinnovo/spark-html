import { store } from 'spark-html';
import { router } from 'spark-html-router';
import { theme } from 'spark-html-theme';
import { head } from 'spark-html-head';
import stats from 'virtual:spark-stats';
import { highlightAll } from './highlight.js';

// Hero stats, computed at build time (see vite.config.js) — never hand-edited.
store('stats', stats);

// Code samples on Docs/Playground call this from their onMount (idempotent —
// already-highlighted <pre> are skipped), so it re-runs per route.
window.highlightAll = highlightAll;

// Served from "/" in dev and "/spark/" on GitHub Pages — links read this.
const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
store('app', { base });

// Dark/light/system theming (the ⚡ logo toggles it).
theme();

// Reactive document title per route (replaces hand-rolled title syncing).
head({
  base,
  title: {
    '/': 'Spark — HTML that reacts.',
    '/docs': 'Spark — Documentation',
    '/playground': 'Spark — Playground',
    '/showcase': 'Spark — Showcase',
    '*': 'Spark — HTML that reacts.',
  },
});

// Sites built with Spark — rendered on /showcase and teased on Home.
store('showcase', {
  sites: [
    { slug: 'novo', name: 'novo.ws', url: 'https://novo.ws',
      desc: 'Design studio — the reference Spark build.',
      tags: ['router', 'theme', 'prerender'] },
    { slug: 'dat-taxi', name: 'dat.taxi', url: 'https://dat.taxi',
      desc: "NYC's premium ride service, on demand since 1992.",
      tags: ['router', 'prerender'] },
    { slug: 'spark', name: 'This site', url: 'https://wilkinnovo.github.io/spark/',
      desc: 'Every section is a Spark component.',
      tags: ['router', 'theme', 'prerender'] },
  ],
});

// One call: mounts the chrome + active route once, intercepts <a> clicks for
// SPA nav, marks the active link, and exposes a reactive `route` store.
router({ base });
