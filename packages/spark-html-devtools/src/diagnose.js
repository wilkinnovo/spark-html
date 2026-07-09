/**
 * spark-html-devtools/diagnose — the fail-loud dev layer (improvements.md I3).
 *
 * Injected automatically as a separate <script type="module"> by
 * spark-html-bun's dev server and by spark-ssr's dev (live) path. It NEVER
 * ships in production: the injectors only run in dev mode — `spark build`
 * output and dist/spark.js are untouched (the core size gate proves zero
 * core bytes were spent).
 *
 * Dependency-free ON PURPOSE: the injectors serve this single file straight
 * from their own install (`spark-html-devtools/diagnose`), so it must not
 * import anything — not even spark-html.
 *
 * Every message NAMES THE FIX (spark-brain §6): a user should never need our
 * source code to understand our message. The RULES table below is the single
 * source for those messages — the website's "when something goes wrong" docs
 * section and the language-server's static checks are test-pinned against it
 * (see test/devtools.js); change a message here and that test walks you to
 * the docs row.
 */

// ── the rules table (message single-source) ──────────────────────────────
export const RULES = {
  'directive-typo': {
    message: (attr, suggestion) =>
      `[spark] unknown directive \`${attr}\` — did you mean \`${suggestion}\`? (If it's intentional, ignore this; only near-misses of known names are flagged.)`,
    fix: 'Rename the attribute to the suggested directive.',
  },
  'duplicate-core': {
    message: () =>
      '[spark] duplicate spark-html detected — two runtimes each own a private store registry, which surfaces as "store not created". Run `npx spark-html doctor` to find and dedupe the copies.',
    fix: 'Run `npx spark-html doctor`; delete node_modules + the lockfile and reinstall so one copy remains.',
  },
  'hydration-mismatch': {
    message: (path) =>
      `[spark] hydration mismatch at ${path} — the server-rendered HTML and the settled client DOM disagree here. If this value is computed in the page's own <script>: SSR never runs a page's own <script> — compute this field in the MODULE data source instead.`,
    fix: "Compute display fields in the data source (SQL expression or module source), not the page's <script>.",
  },
  'ssr-dev-event': {
    message: (text) => `[spark-ssr] ${text}`,
    fix: 'Server-side dev warnings are mirrored here so they are not lost in server stdout.',
  },
};

// ── directive typo detection (static DOM scan) ───────────────────────────
// Known-name tables, COPIED from the runtime on purpose (the core exports
// nothing new — spark-brain: zero core bytes). Cross-reference:
// packages/spark/src/directives.js (template chain: each/if/else-if/else/
// await + then/catch/key/as; bind:<prop>; :attr; @event) and
// packages/spark-html-language-server/src/analyze.js carries the same table
// for editor-time parity — keep all three in sync by hand.
const TEMPLATE_DIRECTIVES = ['each', 'if', 'else-if', 'else', 'await', 'then', 'catch', 'key', 'as'];
const COMMON_ATTRS = ['class', 'style', 'value', 'checked', 'disabled', 'hidden', 'selected', 'href', 'src', 'title', 'id', 'type', 'placeholder'];
const BINDABLE = ['value', 'checked'];
const COMMON_EVENTS = ['click', 'input', 'change', 'submit', 'keydown', 'keyup', 'focus', 'blur', 'dblclick', 'mouseover', 'mouseout', 'pointerdown', 'pointerup', 'scroll', 'load'];

// Edit distance exactly 1 (insert/delete/replace/transpose) — conservative on
// purpose: `:foo` is a legal dynamic bind of ANY attribute and `@party` a
// legal custom event, so only near-misses of known names are worth flagging.
function distance1(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0, swap = false;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diff++;
        if (diff === 2 && a[i] === b[i - 1] && a[i - 1] === b[i]) swap = true;
        if (diff > 2) return false;
      }
    }
    return diff === 1 || (diff === 2 && swap);
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true; j++;
  }
  return true;
}

function suggest(name, table) {
  if (table.includes(name)) return null;
  return table.find((known) => distance1(name, known)) || null;
}

export function scanDirectiveTypos(root = document) {
  const findings = [];
  // Own tree walk (no selector engine): works against any DOM-ish tree —
  // real browsers, linkedom, and the test shim — and descends into
  // <template>.content, which querySelectorAll('*') never reaches.
  const attrNames = (el) => (el.getAttributeNames ? el.getAttributeNames()
    : el.attributes ? [...el.attributes].map((a) => a.name) : []);
  (function walk(node) {
    if (!node) return;
    if (node.nodeType === 1) check(node);
    for (const c of node.childNodes || []) walk(c);
    if (node.content) for (const c of node.content.childNodes || []) walk(c);
  })(root.body || root.documentElement || root);
  function check(el) {
    const isTemplate = String(el.tagName || '').toUpperCase() === 'TEMPLATE';
    for (const attr of attrNames(el)) {
      let hit = null;
      if (attr.startsWith(':')) {
        if (attr.startsWith(':data-')) continue; // data-* is arbitrary by design
        const s = suggest(attr.slice(1), COMMON_ATTRS);
        hit = s && ':' + s;
      } else if (attr.startsWith('@')) {
        const s = suggest(attr.slice(1), COMMON_EVENTS);
        hit = s && '@' + s;
      } else if (attr.startsWith('bind:')) {
        const s = suggest(attr.slice(5), BINDABLE);
        hit = s && 'bind:' + s;
      } else if (isTemplate) {
        hit = suggest(attr, TEMPLATE_DIRECTIVES);
      }
      if (hit) findings.push({ attr, suggestion: hit, el });
    }
  }
  return findings;
}

// ── hydration mismatch diff ──────────────────────────────────────────────
// Normalization mirrors the relocation gate's list (e2e/relocation.spec.js):
// strip scripts/styles/comments/TEMPLATES (inert machinery — the client
// component re-introduces its own template elements over server-rendered
// content) and data-spark-* bookkeeping, collapse whitespace — every
// stripped artifact is framework plumbing, never content.
function normalize(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  (function clean(node) {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 8 || (c.nodeType === 1 && (c.tagName === 'SCRIPT' || c.tagName === 'STYLE' || c.tagName === 'TEMPLATE'))) { c.remove(); continue; }
      if (c.nodeType === 3) { c.data = String(c.data ?? c.textContent ?? '').replace(/\s+/g, ' '); continue; }
      if (c.nodeType === 1) {
        const names = c.getAttributeNames ? c.getAttributeNames() : [...(c.attributes || [])].map((a) => a.name);
        for (const a of names) if (a.startsWith('data-spark')) c.removeAttribute(a);
        clean(c);
      }
    }
  })(t.content);
  return t.content;
}

function pathOf(node, root) {
  const parts = [];
  while (node && node !== root && node.parentNode) {
    const el = node.nodeType === 1 ? node : node.parentNode;
    if (el && el !== root && el.nodeType === 1) {
      const tag = el.tagName.toLowerCase();
      const cls = el.getAttribute && el.getAttribute('class');
      parts.unshift(tag + (cls ? '.' + cls.split(/\s+/)[0] : ''));
    }
    node = el === node ? node.parentNode : el;
  }
  return parts.join(' > ') || '(root)';
}

// Compare the aligned prefix only: post-hydration DOM legitimately GAINS
// content (an await block resolving, progressive machinery) — additions are
// not a mismatch. CHANGED text/tags at aligned positions, or content the
// client LOST (b shorter than a), are.
function firstDivergence(a, b, root) {
  const txt = (n) => String(n.data ?? n.textContent ?? '');
  const wa = [...a.childNodes].filter((n) => n.nodeType !== 3 || txt(n).trim());
  const wb = [...b.childNodes].filter((n) => n.nodeType !== 3 || txt(n).trim());
  for (let i = 0; i < wa.length; i++) {
    const na = wa[i], nb = wb[i];
    if (!nb) return pathOf(na, root); // content lost after hydration — real
    if (na.nodeType !== nb.nodeType) return pathOf(na, root);
    if (na.nodeType === 3) {
      if (txt(na).trim() !== txt(nb).trim()) return pathOf(na, root);
      continue;
    }
    if (na.nodeType === 1) {
      if (na.tagName !== nb.tagName) return pathOf(na, root);
      const deeper = firstDivergence(na, nb, root);
      if (deeper) return deeper;
    }
  }
  return null;
}

// The whole check as one seam (also what the tests drive): server HTML in,
// settled HTML in, first genuinely-diverging path (or null) out.
export function diffHydration(beforeHtml, afterHtml) {
  return firstDivergence(normalize(beforeHtml), normalize(afterHtml), null);
}

// ── boot ─────────────────────────────────────────────────────────────────
function banner(text) {
  const el = document.createElement('div');
  el.setAttribute('data-spark-diagnose-banner', '');
  el.setAttribute('style', 'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#7f1d1d;color:#fff;font:13px/1.5 ui-monospace,monospace;padding:8px 14px;white-space:pre-wrap');
  el.textContent = text;
  document.body.appendChild(el);
}

function boot() {
  // 1. Duplicate-core escalation: the core console.error()s when a second
  //    copy loads; escalate that to an in-page banner. This module loads
  //    first (injected at head start), so the hook sees the core's message.
  const prevError = console.error;
  console.error = function (...args) {
    if (typeof args[0] === 'string' && args[0].includes('a second copy of the runtime loaded')) {
      try { banner(RULES['duplicate-core'].message()); } catch { /* body not ready */ }
    }
    return prevError.apply(this, args);
  };

  const onReady = () => {
    // 2. SSR dev events (spark-ssr live mode writes them into the page).
    //    querySelector, not getElementById — DOM shims used in tests don't
    //    always implement the latter, and a diagnostics layer must never be
    //    able to crash the page it is diagnosing (see the boot() guard too).
    const events = document.querySelector('#__spark-dev-events');
    if (events) {
      try { for (const w of JSON.parse(events.textContent || '[]')) console.warn(RULES['ssr-dev-event'].message(w)); }
      catch { /* malformed — server bug, not the page's */ }
    }

    // 3. Directive typos (static scan, once).
    for (const f of scanDirectiveTypos(document)) {
      console.warn(RULES['directive-typo'].message(f.attr, f.suggestion), f.el);
    }

    // 4. Hydration mismatch: snapshot now (server HTML), diff after settle.
    //    Only meaningful when the page actually hydrates (a host carrying
    //    both import= and name= is the flash-free hydrate contract).
    const host = document.querySelector('[import][name]');
    if (!host) return;
    const before = host.innerHTML;
    setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      const path = diffHydration(before, host.innerHTML);
      if (path) console.warn(RULES['hydration-mismatch'].message(path));
    })), 700);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
}

if (typeof document !== 'undefined' && !globalThis.__sparkDiagnoseBooted) {
  globalThis.__sparkDiagnoseBooted = 1;
  // A diagnostics layer must never be able to crash the page it diagnoses.
  try { boot(); } catch { /* diagnostics off — never the page's problem */ }
}
