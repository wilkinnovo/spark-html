/**
 * Playground wiring (parent side) for the /playground REPL.
 *
 * Everything code-shaped lives HERE, in bundled JS — never in the playground
 * component's <script>: Spark's declaration rewriter is not string-aware, so
 * source strings kept inside a component script would get their `let`/
 * `function` keywords rewritten. The component reads defaults through
 * window helpers and renders console entries from the `pg-console` store.
 *
 * The preview runs in a sandboxed-by-realm <iframe srcdoc> rebuilt on every
 * run: fresh stores, fresh styles, fresh warnings — no state leaks between
 * runs, and the user's console.* calls post back here for the console pane.
 * The iframe-side runner is src/playground-frame.js, shipped as its own
 * bundle entry (see the data-spark-pg-frame tag in index.html).
 */
import { store, subscribe, parseSFC, scopeCss } from 'spark-html';
import { highlightSource } from './highlight.js';

// ── default project ─────────────────────────────────────────────────────
export const DEFAULT_FILES = [
  {
    name: 'app.html',
    source: `<h1>Hello {name}!</h1>

<input bind:value="name" placeholder="name" />
<button onclick={inc}>clicks: {count}</button>

<div import="card" label="multi-file: this box is card.html"></div>

<script>
  import { greet } from './utils.js';

  let name = 'world';
  let count = 0;

  $: shout = greet(name).toUpperCase();

  function inc() {
    count++;
    console.log(shout, '· clicks:', count);
  }
<\/script>

<style>
  h1 { color: #cf9500; margin-bottom: 12px; }
  input { margin-right: 8px; }
</style>`,
  },
  {
    name: 'card.html',
    source: `<div class="card">
  <b>{label}</b>
  <span>scoped styles never leak out of this file</span>
</div>

<script>
  export let label = 'card';
<\/script>

<style>
  .card { display: flex; flex-direction: column; gap: 2px;
          border: 1px solid #55555588; padding: 10px 14px; margin-top: 16px; }
  .card b { color: #cf9500; }
  .card span { opacity: .6; font-size: 12px; }
</style>`,
  },
  {
    name: 'utils.js',
    source: `// A plain ES module — components import it with standard syntax.
export function greet(name) {
  return 'Hello ' + name + '!';
}
`,
  },
];

const BLANK_HTML = `<p>new component</p>

<script>
  // export let ... declares a prop; let ... is reactive state
<\/script>

<style>
</style>`;

const BLANK_JS = `export function hello() {
  return 'hi';
}
`;

// ── srcdoc for the result iframe ────────────────────────────────────────
const FONT_LINKS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">';

function frameUrl() {
  const tag = document.querySelector('script[data-spark-pg-frame]');
  return tag ? tag.src : null; // .src is absolute; the build rewrote it to the hashed asset
}

function buildSrcdoc(files, theme) {
  const dark = theme !== 'light';
  // In dev the frame script is served raw and imports 'spark-html' bare, so
  // the iframe needs the same import map the dev server injected into this
  // page. In the built site the frame bundle has no bare imports — no map.
  const importMap = document.querySelector('script[type="importmap"]');
  const json = JSON.stringify(files).replace(/</g, '\\u003c');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    (importMap ? importMap.outerHTML : '') + FONT_LINKS +
    '<style>' +
    'body{font:13.5px/1.6 "JetBrains Mono",ui-monospace,monospace;padding:20px;' +
    (dark ? 'background:#0a0a0a;color:#fff;' : 'background:#fff;color:#1a1a1a;') + '}' +
    'button,input,select,textarea{font:inherit;color:inherit;background:' +
    (dark ? '#16161c' : '#f4f4f5') + ';border:1px solid ' + (dark ? '#333' : '#d4d4d4') + ';padding:6px 12px;cursor:pointer;}' +
    'input{cursor:text;}' +
    '</style></head><body>' +
    '<div import="app"></div>' +
    '<script type="application/json" id="spark-pg-files">' + json + '</script>' +
    '<script>window.__SPARK_PG__ = 1;</script>' +
    '<script type="module" src="' + frameUrl() + '"></script>' +
    '</body></html>'
  );
}

// ── public wiring ───────────────────────────────────────────────────────
let consoleStore = null;
let lastHost = null;
let lastFiles = null;

export function setupPlayground() {
  consoleStore = store('pg-console', { entries: [] });

  // Console/error traffic from the result iframe.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__sparkPg !== true || d.kind !== 'console') return;
    consoleStore.entries = [...consoleStore.entries, { type: d.level, text: d.text }].slice(-200);
    requestAnimationFrame(() => {
      const log = document.querySelector('#playground-repl .clog');
      if (log) log.scrollTop = log.scrollHeight;
    });
  });

  // Re-render the preview when the site theme flips, so it always matches.
  subscribe('theme', () => {
    if (lastHost && lastHost.isConnected && lastFiles) window.__pgRun(lastHost, lastFiles);
  });

  // Fresh copies so edits never mutate the defaults.
  window.__pgDefaults = () => DEFAULT_FILES.map((f) => ({ ...f }));
  window.__pgBlank = (name) => (name.endsWith('.js') ? BLANK_JS : BLANK_HTML);
  window.__pgHl = (src, lang) => highlightSource(src, lang);

  // (Re)build the result iframe from the current files. A new srcdoc is a new
  // realm: stores, styles, timers and warn-dedupe all reset — like a reload.
  window.__pgRun = (host, files) => {
    if (!host || !frameUrl()) return;
    lastHost = host;
    lastFiles = files.map((f) => ({ name: f.name, source: f.source }));
    consoleStore.entries = [];
    let iframe = host.querySelector('iframe');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.title = 'Result';
      host.appendChild(iframe);
    }
    iframe.srcdoc = buildSrcdoc(lastFiles, document.documentElement.dataset.theme);
  };

  // JS / CSS output panes. Spark has no compile step, so "JS output" is each
  // file's <script> exactly as extracted (what the runtime executes), and
  // "CSS output" is the real transform: each <style> scoped by scopeCss() —
  // the exact stylesheet Spark injects into <head>.
  window.__pgOut = (files) => {
    let js = '';
    let css = '';
    for (const f of files) {
      if (f.name.endsWith('.js')) {
        js += '/* ' + f.name + ' — plain ES module, imported as written */\n' + f.source.trim() + '\n\n';
        continue;
      }
      if (!f.name.endsWith('.html')) continue;
      const name = f.name.replace(/\.html$/, '');
      const { script, style } = parseSFC(f.source);
      if (script) js += '/* ' + f.name + ' — <script> as extracted (no compiler: Spark runs your JS as-is) */\n' + script + '\n\n';
      if (style) css += '/* ' + f.name + ' — scoped to [name="' + name + '"] by the runtime */\n' + scopeCss(style, name) + '\n\n';
    }
    return {
      js: js.trim() || '// no <script> blocks yet',
      css: css.trim() || '/* no <style> blocks yet */',
    };
  };
}
