/**
 * spark-html-persist — persist a spark-html store across reloads, in one line.
 *
 *   import { persist } from 'spark-html-persist';
 *
 *   // a normal store(), but hydrated from storage and saved on every change:
 *   persist('settings', { theme: 'dark', fontSize: 14 });
 *
 *   // any component: const s = useStore('settings');  s.theme = 'light';
 *
 * Defaults to localStorage under the key `spark:<name>`. Options:
 *   key      — storage key (default `spark:<name>`)
 *   storage  — a Storage (default localStorage; pass sessionStorage for per-tab)
 *   include  — only persist these keys
 *   exclude  — persist everything except these keys
 *
 * Built on spark-html's `store()` + `subscribe()` — one dependency, no build.
 */
import { store, subscribe } from 'spark-html';

export function persist(name, initial = {}, options = {}) {
  const key = options.key || `spark:${name}`;
  const area = options.storage ||
    (typeof localStorage !== 'undefined' ? localStorage : null);

  // Hydrate: saved values layer on top of the defaults (so a new default key
  // appears even for users who already have an older saved blob).
  let start = { ...initial };
  if (area) {
    try {
      const raw = area.getItem(key);
      if (raw) start = { ...start, ...JSON.parse(raw) };
    } catch { /* corrupt or blocked storage — fall back to defaults */ }
  }

  const s = store(name, start);
  if (!area) return s;

  // Save the (filtered) state after each change, coalesced to one write per
  // tick so a burst of mutations is a single setItem.
  let queued = false;
  const save = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      try {
        const out = {};
        const keys = options.include || Object.keys(s);
        for (const k of keys) {
          if (options.exclude && options.exclude.includes(k)) continue;
          out[k] = s[k];
        }
        area.setItem(key, JSON.stringify(out));
      } catch { /* quota exceeded or blocked — skip this write */ }
    });
  };
  subscribe(name, save);
  return s;
}

export default { persist };
