import { store } from 'spark-html';
import { router, navigate } from 'spark-html-router';
import { theme } from 'spark-html-theme';
import { head } from 'spark-html-head';
import { motion } from 'spark-html-motion';
import { query } from 'spark-html-query';
import { persist } from 'spark-html-persist';
import { integrity } from 'spark-html-sri';
import { manifestJson } from 'spark-html-manifest';
import { shouldHandle } from 'spark-html-offline';
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

// ── Playground wiring — every demo runs the real package ──────────────
// Enter/leave transitions for the motion demo (opt-in via `transition`).
motion();

// Shared-store demo: two component instances, one named store.
store('playground', { sparks: 0 });

// Persist demo: survives reloads via localStorage.
persist('pg-prefs', { opens: 0, note: '' });

// Query demo: a self-fetching store; every 5th call fails on purpose so
// the error state is demonstrable.
let factCalls = 0;
query('pg-fact', () => new Promise((resolve, reject) =>
  setTimeout(() => {
    factCalls++;
    if (factCalls % 5 === 0) reject(new Error('synthetic failure — refetch to recover'));
    else resolve({ value: Math.floor(Math.random() * 900) + 100 });
  }, 900),
));

// Components can't import modules, so the demos reach these through window:
// the EXACT functions the packages run in production.
window.navigate = navigate;                    // router demo: clear the query
window.__pgSri = (text) => integrity(text);    // sri demo: live hashing
window.__pgManifest = manifestJson;            // manifest demo: live output
window.__pgOffline = shouldHandle;             // offline demo: the worker's rule
window.__pgDevtools = async (opts) => {        // devtools demo: loaded on demand
  const { devtools } = await import('spark-html-devtools');
  return devtools(opts);
};

// One call: mounts the chrome + active route once, intercepts <a> clicks for
// SPA nav, marks the active link, and exposes a reactive `route` store.
router({ base });
