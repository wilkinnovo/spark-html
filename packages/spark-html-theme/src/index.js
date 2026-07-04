/**
 * spark-html-theme — dark / light / system theming in one line.
 *
 * Replaces the boilerplate every site re-writes (a theme store, applying a
 * `data-theme` attribute, watching the OS preference, persisting to
 * localStorage, and a toggle). Call once in your bootstrap:
 *
 *   import { theme } from 'spark-html-theme';
 *   theme();
 *
 * It creates a reactive `theme` store any component can read and drive:
 *
 *   <span class="logo" onclick="{theme.toggle}"></span>
 *   <script>
 *     const theme = useStore('theme');   // { mode, resolved, toggle, set }
 *     $: label = theme.resolved;          // 'light' | 'dark'
 *   </script>
 *
 * `mode` is the user's choice ('system' | 'light' | 'dark'); `resolved` is what
 * actually applies ('light' | 'dark'); `toggle()` flips the visible theme
 * (light↔dark — always a visible change); `cycle()` advances through `modes`
 * (tri-state, including 'system'); `set(mode)` jumps to one. The chosen
 * `resolved` is written to `document.documentElement` as `data-theme`.
 *
 * No flash on reload: a deferred module runs after first paint, so the correct
 * theme must be on <html> before the browser paints. Add the pipeline step to
 * spark.config.js and it's handled in dev and build automatically:
 *
 *   import theme from 'spark-html-theme/bun';
 *   export default { pipeline: [prerender(), theme()] };
 *
 * (Without the bun pipeline, inline the same snippet by hand — import
 * { themeInitScript } and drop its string into a <script> at the top of <head>.)
 */
import { store } from 'spark-html';

const DEFAULT_MODES = ['system', 'light', 'dark'];

/**
 * Set up theming. Returns the reactive `theme` store proxy.
 *
 * @param {object} [options]
 * @param {string} [options.key='theme-mode']   localStorage key for the mode.
 * @param {string} [options.attribute='data-theme'] Attribute written on <html>.
 * @param {string[]} [options.modes]             Cycle order for toggle()
 *                                               (default ['system','light','dark']).
 * @param {string} [options.name='theme']        Store name.
 */
export function theme(options = {}) {
  const key = options.key || 'theme-mode';
  const attribute = options.attribute || 'data-theme';
  const modes = options.modes || DEFAULT_MODES;
  const name = options.name || 'theme';

  const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const read = () => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(key, v); } catch { /* ignore */ } };

  const saved = read();
  const initial = saved && modes.includes(saved) ? saved : modes[0];
  const resolve = (mode) => (mode === 'system' ? (mq && mq.matches ? 'dark' : 'light') : mode);

  function apply() {
    s.resolved = resolve(s.mode);
    const root = typeof document !== 'undefined' && document.documentElement;
    if (root) root.setAttribute(attribute, s.resolved);
  }
  function set(mode) {
    if (!modes.includes(mode)) return;
    s.mode = mode;
    write(mode);
    apply();
  }
  // Flip the VISIBLE theme. Always changes appearance on every call — the right
  // behaviour for a single toggle button. (A naive system→light→dark cycle can
  // land on two visually-identical states in a row — e.g. explicit "dark" then
  // "system" when the OS is dark — which feels like the click did nothing.)
  function toggle() {
    set(s.resolved === 'dark' ? 'light' : 'dark');
  }
  // Advance through `modes` (includes 'system'). Use for a tri-state control;
  // note adjacent modes can resolve to the same appearance.
  function cycle() {
    set(modes[(modes.indexOf(s.mode) + 1) % modes.length]);
  }

  const s = store(name, { mode: initial, resolved: resolve(initial), toggle, cycle, set });

  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  return s;
}

// The inline no-flash snippet (sets `data-theme` before first paint) lives in
// ./init.js — DOM-free and importable by servers/pipelines (spark-ssr,
// spark-html-bun) without pulling in the client runtime. Re-exported here
// for compatibility.
import { themeInitScript } from './init.js';
export { themeInitScript };

export default { theme, themeInitScript };
