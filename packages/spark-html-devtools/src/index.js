/**
 * spark-html-devtools — a tiny in-page panel for inspecting a Spark app.
 *
 *   import { devtools } from 'spark-html-devtools';
 *   if (import.meta.env?.DEV) devtools();   // dev only
 *
 * Shows, live:
 *  • every named store + its state,
 *  • the component tree ([name] hosts) + each component's reactive state,
 *  • a patch counter, and a brief amber outline on whichever component just
 *    re-rendered — so "surgical reactivity" is visible.
 *
 * Reads from the DOM (component scopes) and `inspectStores()`; it never mutates
 * the app. Toggle with the ⚡ button (bottom-right).
 */
import { inspectStores } from 'spark-html';

const AMBER = '#ffd24a';
let booted = false;

function safe(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'function') return undefined;
      if (v && typeof v === 'object') { if (seen.has(v)) return '[circular]'; seen.add(v); }
      return v;
    }, 1);
  } catch { return String(value); }
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function readScope(scope) {
  const o = {};
  try {
    for (const k of Object.keys(scope)) {
      try { const v = scope[k]; if (typeof v !== 'function') o[k] = v; } catch { /* getter threw */ }
    }
  } catch { /* not enumerable */ }
  return o;
}

function components() {
  return [...document.querySelectorAll('[name]')]
    .filter((el) => el.__sparkScope)
    .map((el) => ({ name: el.getAttribute('name'), state: readScope(el.__sparkScope), el }));
}

/**
 * Mount the devtools panel. Returns a teardown function.
 * @param {object} [options]
 * @param {boolean} [options.open=false]  Start expanded.
 */
export function devtools(options = {}) {
  if (booted || typeof document === 'undefined') return () => {};
  booted = true;

  let patches = 0;
  let open = !!options.open;

  const root = document.createElement('div');
  root.setAttribute('data-spark-devtools', '');
  root.innerHTML = `
    <button class="sdt-toggle" title="Spark devtools">⚡</button>
    <div class="sdt-panel">
      <div class="sdt-head"><b>⚡ spark devtools</b><span class="sdt-meta"></span><button class="sdt-x">×</button></div>
      <div class="sdt-body"></div>
    </div>`;

  const style = document.createElement('style');
  style.textContent = `
    [data-spark-devtools]{position:fixed;right:14px;bottom:14px;z-index:2147483647;font:12px/1.5 "JetBrains Mono",ui-monospace,monospace}
    [data-spark-devtools] .sdt-toggle{width:40px;height:40px;border-radius:50%;border:1px solid #333;background:#000;color:${AMBER};font-size:20px;cursor:pointer}
    [data-spark-devtools] .sdt-panel{display:none;position:absolute;right:0;bottom:48px;width:340px;max-height:70vh;overflow:auto;background:#0a0a0a;color:#e8e8e8;border:1px solid #333}
    [data-spark-devtools][data-open] .sdt-panel{display:block}
    [data-spark-devtools][data-open] .sdt-toggle{outline:2px solid ${AMBER}}
    [data-spark-devtools] .sdt-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #1a1a1a;position:sticky;top:0;background:#0a0a0a}
    [data-spark-devtools] .sdt-head b{color:#fff}
    [data-spark-devtools] .sdt-meta{margin-left:auto;color:#888}
    [data-spark-devtools] .sdt-x{background:none;border:none;color:#888;font-size:16px;cursor:pointer}
    [data-spark-devtools] .sdt-body{padding:10px 12px}
    [data-spark-devtools] .sdt-sec{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#666;margin:12px 0 6px}
    [data-spark-devtools] .sdt-item{border-left:2px solid #1a1a1a;padding:2px 0 2px 10px;margin:4px 0}
    [data-spark-devtools] .sdt-name{color:${AMBER}}
    [data-spark-devtools] pre{margin:2px 0 0;white-space:pre-wrap;color:#aaa;font-size:11px}
    .sdt-flash{outline:1px solid ${AMBER} !important;outline-offset:-1px;transition:outline .15s}`;
  document.head.appendChild(style);
  document.body.appendChild(root);

  const panelBody = root.querySelector('.sdt-body');
  const meta = root.querySelector('.sdt-meta');
  const setOpen = (v) => { open = v; if (v) root.setAttribute('data-open', ''); else root.removeAttribute('data-open'); if (v) render(); };
  root.querySelector('.sdt-toggle').addEventListener('click', () => setOpen(!open));
  root.querySelector('.sdt-x').addEventListener('click', () => setOpen(false));

  function render() {
    const stores = inspectStores();
    const comps = components();
    meta.textContent = `${comps.length} comp · ${patches} patches`;
    const storeRows = Object.keys(stores).map((n) =>
      `<div class="sdt-item"><span class="sdt-name">${esc(n)}</span><pre>${esc(safe(stores[n]))}</pre></div>`).join('') || '<div class="sdt-item">—</div>';
    const compRows = comps.map((c) =>
      `<div class="sdt-item"><span class="sdt-name">${esc(c.name)}</span><pre>${esc(safe(c.state))}</pre></div>`).join('') || '<div class="sdt-item">—</div>';
    panelBody.innerHTML =
      `<div class="sdt-sec">stores</div>${storeRows}<div class="sdt-sec">components</div>${compRows}`;
  }

  // Patch hook (the runtime calls this per component patch). Chain any existing.
  const prev = globalThis.__sparkTestOnPatch;
  globalThis.__sparkTestOnPatch = (el) => {
    patches++;
    if (typeof prev === 'function') try { prev(el); } catch { /* ignore */ }
    if (el && el.classList) {
      el.classList.add('sdt-flash');
      setTimeout(() => el.classList && el.classList.remove('sdt-flash'), 180);
    }
  };

  const timer = setInterval(() => { if (open) render(); }, 400);
  if (open) { root.setAttribute('data-open', ''); render(); }

  return function teardown() {
    clearInterval(timer);
    globalThis.__sparkTestOnPatch = prev;
    root.remove(); style.remove();
    booted = false;
  };
}

export default { devtools };
