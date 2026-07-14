import { store, component, mount, unmount } from 'spark-html';
import { router, navigate } from 'spark-html-router';
import { theme } from 'spark-html-theme';
import { head } from 'spark-html-head';
import { motion } from 'spark-html-motion';
import { query } from 'spark-html-query';
import { persist } from 'spark-html-persist';
import { integrity } from 'spark-html-sri';
import { manifestJson } from 'spark-html-manifest';
import { shouldHandle } from 'spark-html-offline';
import stats from './stats.js';
import { highlightAll } from './highlight.js';
import { TUTORIAL_LESSONS } from './tutorial-lessons.js';
import { setupPlayground } from './playground.js';

// Hero stats, computed from live source (see scripts/gen-stats.js) — never hand-edited.
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
    '/': 'Spark — HTML that reacts. Built for humans.',
    '/docs': 'Spark — Documentation',
    '/ssr': 'Spark — Full-stack SSR',
    '/playground': 'Spark — Playground',
    '/tutorials': 'Spark — Tutorials',
    '/showcase': 'Spark — Showcase',
    '/blog': 'Spark — Blog',
    '/blog/1-3-2-what-looks-like-a-bug': 'Spark — spark-ssr 1.3.2: 21 “bugs” and what they actually were',
    '/blog/1-3-1-spark-ssr-live-raw-writes': 'Spark — spark-ssr 1.3.1: live fires on raw writes',
    '/blog/1-3-0-spark-ssr-api-only-mode': 'Spark — spark-ssr 1.3.0: API-only mode + rate limits',
    '/blog/1-8-1-bind-write-back-ordering': 'Spark — v1.8.1: a same-event bind + handler ordering fix',
    '*': 'Spark — HTML that reacts. Built for humans.',
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
    { slug: 'spark', name: 'This site', url: 'https://spark-html.dev',
      desc: 'Every section is a Spark component.',
      tags: ['router', 'theme', 'prerender'] },
  ],
});

// ── Playground (the multi-file REPL on /playground) ───────────────────
setupPlayground();

// ── Live-demos wiring (the gallery on /tutorials) — every demo runs the
//    real package ─────────────────────────────────────────────────────────
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

// ── Tutorials wiring — the live editor runs the REAL runtime ───────────
// Lesson data lives in tutorial-lessons.js (bundled JS — component scripts
// would get their declaration keywords rewritten inside the code strings).
store('tutorial', { list: TUTORIAL_LESSONS });

// Each edit re-registers the source under a fresh name (component() caches by
// name), tears down the previous mount, and mounts again. Errors come back to
// the lesson component as a string for the ✘ bar.
let tutorialSeq = 0;
window.__tutorialRun = async (host, src) => {
  if (!host) return null;
  const name = `tutorial-lesson-${++tutorialSeq}`;
  // Spark never throws on a broken component — it warns and renders what it
  // can. Capture those warnings so the lesson can show them in its ✘ bar.
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    const line = args.join(' ');
    if (line.startsWith('[spark]')) warnings.push(line.replace(/^\[spark\]\s*/, ''));
    origWarn(...args);
  };
  try {
    component(name, src);
    unmount(host);
    host.innerHTML = `<div import="${name}"></div>`;
    await mount(host, { quiet: true });
    return warnings[0] || null;
  } catch (e) {
    return e.message || String(e);
  } finally {
    console.warn = origWarn;
  }
};

// Pre-registered helpers for the props and slots lessons (components can only
// import other components, not define them inline).
component('tut-badge', `<span class="b" :style="'background: hsl(' + hue + ', 90%, 65%)'">{label}</span>
<script>
  export let label = 'badge';
  export let hue = 48;
<\/script>
<style>
  .b { display: inline-block; color: #000; font-weight: 700; font-size: 12px;
       padding: 4px 10px; border-radius: 999px; margin: 0 6px 6px 0; }
</style>`);
component('tut-card', `<div class="card">
  <h3><slot name="title">Untitled</slot></h3>
  <slot><p>(empty card)</p></slot>
</div>
<script>
<\/script>
<style>
  .card { border: 1px solid var(--border-strong); border-radius: 10px; padding: 14px 18px; }
  .card h3 { margin-bottom: 8px; font-size: 15px; }
</style>`);

// One call: mounts the chrome + active route once, intercepts <a> clicks for
// SPA nav, marks the active link, and exposes a reactive `route` store.
router({ base });
