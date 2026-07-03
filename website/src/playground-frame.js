/**
 * Playground result-frame runner. Loaded in TWO places:
 *
 *  1. The main site page (index.html carries the tag so the bundler emits
 *     this file as its own hashed entry and playground.js can discover its
 *     URL) — there `__SPARK_PG__` is unset and this module does nothing.
 *  2. The playground's <iframe srcdoc>, which sets `window.__SPARK_PG__ = 1`
 *     and embeds the project files as JSON — there it captures the console,
 *     registers every .html file as a component, routes JS imports to blob
 *     modules (or esm.sh for bare specifiers), and mounts the real runtime.
 *
 * Each run is a fresh srcdoc → a fresh realm: no state, styles, or warn
 * dedupe survive between runs.
 */
import { mount, component } from 'spark-html';

function send(level, text) {
  parent.postMessage({ __sparkPg: true, kind: 'console', level, text }, '*');
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'function') return String(v);
  if (v instanceof Error) return v.message;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

if (window.__SPARK_PG__) {
  // Console capture FIRST, so component-script warnings/errors are seen.
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      send(level, args.map(fmt).join(' '));
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => send('error', e.message));
  window.addEventListener('unhandledrejection', (e) =>
    send('error', 'Unhandled rejection: ' + fmt((e.reason && e.reason.message) || e.reason)),
  );

  const files = JSON.parse(document.getElementById('spark-pg-files').textContent);

  // `import ... from './utils.js'` inside a component <script> resolves to
  // the playground file of that name (as a blob module). Bare specifiers go
  // to esm.sh, absolute URLs load directly.
  const jsFiles = new Map(
    files.filter((f) => f.name.endsWith('.js')).map((f) => [f.name, f.source]),
  );
  globalThis.__SPARK_IMPORT__ = (spec) => {
    const clean = String(spec).replace(/^\.\//, '').replace(/^\//, '');
    if (jsFiles.has(clean)) {
      const url = URL.createObjectURL(new Blob([jsFiles.get(clean)], { type: 'text/javascript' }));
      return import(url).finally(() => URL.revokeObjectURL(url));
    }
    if (/^https?:/i.test(spec)) return import(spec);
    return import('https://esm.sh/' + spec);
  };

  // Every .html file is a component named after the file: card.html →
  // <div import="card">. app.html is the entry the srcdoc mounts.
  for (const f of files) {
    if (f.name.endsWith('.html')) component(f.name.replace(/\.html$/, ''), f.source);
  }
  mount(document.body, { quiet: true });
}
