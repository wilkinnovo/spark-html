/**
 * Directive patchers — the three structural directives <template if>, 
 * <template await>, and <template each>, plus the enter/leave lifecycle
 * seam they ride on.
 *
 * Each directive is a "patcher": called from the patch flush in index.js
 * (withSink(node, patchIf/patchEach/patchAwait, ...)), it reconciles its
 * anchor's rendered output against the current scope state. Reconciliation,
 * not rebuild — patchEach keeps one "block" of nodes per item and reuses it
 * across patches so a focused <input> in a loop survives a keystroke.
 *
 * Imports from ./index.js are circular and safe: function declarations are
 * hoisted in ESM's instantiate phase, only ever CALLED at runtime well
 * after every module has loaded. The patch flush + walkNode + the clone/
 * insert/render helpers stay in index.js (they're shared with code outside
 * the directives block); the directives here orchestrate them.
 *
 * Mutable capture/dirty state arrives via the imported `capture` object
 * (properties mutate freely across the module boundary; only the binding
 * itself is const). patchAwait reassigns capture.set in its reEval branch
 * — legal because that's a property write, not a binding reassignment,
 * which is what the bag refactor (the prior commit) made possible.
 *
 * Public surface: lifecycle (re-exported by index.js as public API).
 * Internal-but-exported (called from index.js): patchIf, patchEach,
 * patchAwait, enterNode. M4.1 freeze review will bucket each.
 */
import { compileExpr, runExpr, parseTemplate } from './expr.js';
import { REACTIVE_RAW, setsIntersect } from './reactivity.js';
import {
  capture,
  warnOnce,
  closestComponent,
  ELEMENT_NODE, TEXT_NODE,
  cloneTemplateNodes, insertClones, renderClones,
  walkNode, patchLive, patchPoint, spill, hydrateBlockImports, pushPrerenderWait,
} from './index.js';

// Anything that makes an each-row "deep" (own machinery in the subtree).
const DEEP_SEL = '[name],[import],[each],[if],[else-if],[else],[await]';
// destroyComponent moved with the rest of the component lifecycle (M3.1).
// Imported directly from component.js so index.js doesn't have to re-export
// it: this is the only directives.js consumer of destroyComponent.
import { destroyComponent } from './component.js';

// Local one-liner copy of index.js's isPrerender — duplicating a trivial
// pure global read is cheaper than exporting it across the circular
// boundary, and keeps isPrerender off the (de-facto public) export line.
// Same pattern as reactivity.js.
const isPrerender = () => globalThis.__SPARK_PRERENDER__;

// ─── <template if="expr"> conditional blocks ──────────────────────────
// ─── enter/leave lifecycle hooks ──────────────────────────────────────
// Tiny seam for optional animation packages (spark-html-motion). When a
// hook is registered, if/each blocks call enter() after inserting a node and
// leave(node, remove) before removing one — the hook may defer `remove` until
// an exit transition finishes. With no hook set this is a no-op: nodes are
// inserted and removed synchronously, exactly as before. Core ships nothing
// that animates; it just exposes the seam.
let enterHook = null;
let leaveHook = null;
export function lifecycle(hooks = {}) {
  enterHook = typeof hooks.enter === 'function' ? hooks.enter : null;
  leaveHook = typeof hooks.leave === 'function' ? hooks.leave : null;
}
export function enterNode(n) {
  if (enterHook && n && n.nodeType === 1) enterHook(n);
}
// A <template each>/<template if>/<template await> anchor is (visually)
// empty — everything it "rendered" lives in tracked SIBLING nodes it
// inserted itself (__sparkEachBlocks' rows, __sparkIfRendered,
// __sparkAwaitRendered). Removing just the anchor, as every caller of
// leaveNode used to do, orphans those siblings: their own onDestroy/store
// subscriptions never fire and their DOM nodes never leave. Recursive
// because any of those siblings can itself be a nested each/if/await
// anchor (a <template each> whose rows each contain a <template if>, say).
function teardownManaged(n) {
  if (n.__sparkEachBlocks) {
    for (const b of n.__sparkEachBlocks) for (const c of b.nodes) leaveNode(c);
    n.__sparkEachBlocks = [];
  }
  if (n.__sparkIfRendered) {
    for (const c of n.__sparkIfRendered) leaveNode(c);
    n.__sparkIfRendered = [];
  }
  if (n.__sparkAwaitRendered) {
    for (const c of n.__sparkAwaitRendered) leaveNode(c);
    n.__sparkAwaitRendered = [];
  }
}
// Run component cleanups now (the node is leaving and goes inert), then let the
// leave hook animate before it actually detaches; no hook ⇒ remove immediately.
function leaveNode(n) {
  teardownManaged(n);
  destroyComponent(n);
  const remove = () => n.remove();
  if (leaveHook && n.nodeType === 1) leaveHook(n, remove);
  else remove();
}

// Parse one chain member's expr + content template. The head carries if=,
// followers carry else-if= (an expr) or a bare else (expr stays null).
function parseIfMember(el) {
  if (el.__sparkIfParsed) return;
  el.__sparkIfExpr = el.hasAttribute('if')
    ? el.getAttribute('if').trim()
    : el.hasAttribute('else-if')
      ? el.getAttribute('else-if').trim()
      : null; // bare else
  // A bare else compiles as the constant `true` — the chain scan stops there.
  el.__sparkIfFn = compileExpr(el.__sparkIfExpr === null ? 'true' : el.__sparkIfExpr);
  el.__sparkIfTemplate = cloneTemplateNodes(el);
  el.__sparkIfParsed = 1;
}

// Collect the if / else-if / else chain headed at `el` (computed once, cached
// on the head). Followers are the consecutive element siblings carrying
// else-if / else, with only blank text or comments between; a bare else ends
// the chain. Followers are marked managed so walkNode leaves them to this
// head — they render nothing on their own.
function ifChain(el) {
  let chain = el.__sparkIfChain;
  if (chain) return chain;
  chain = [el];
  let n = el.nextSibling;
  while (n) {
    if (n.nodeType === TEXT_NODE) {
      if ((n.textContent || '').trim()) break; // real prose interrupts the chain
      n = n.nextSibling;
      continue;
    }
    if (n.nodeType !== ELEMENT_NODE) { n = n.nextSibling; continue; } // comments
    if (n.hasAttribute('if') || !(n.hasAttribute('else-if') || n.hasAttribute('else'))) break;
    n.__sparkIfManagedBy = el;
    chain.push(n);
    if (!n.hasAttribute('else-if')) break; // bare else — nothing may follow
    n = n.nextSibling;
  }
  el.__sparkIfChain = chain;
  return chain;
}

export function patchIf(el, scope) {
  if (!el.parentNode) return;
  const chain = ifChain(el);

  // Exactly one branch is active: the first truthy if / else-if, or the bare
  // else when none was. Short-circuit like real if/else — branches after the
  // active one aren't evaluated, and dependency capture naturally records
  // only the exprs that actually ran this pass.
  let active = -1;
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i];
    parseIfMember(m);
    if (runExpr(m.__sparkIfFn, m.__sparkIfExpr, scope)) { active = i; break; }
  }

  for (let i = 0; i < chain.length; i++) {
    const m = chain[i];
    if (i > 0 && !m.parentNode) continue;
    // Parse every member: for a plain-element branch this also CLEARS its
    // children (they become the template), which must happen even for
    // branches beyond the active one or their raw content stays visible.
    parseIfMember(m);
    const show = i === active;
    const isShown = Boolean(m.__sparkIfRendered && m.__sparkIfRendered.length);

    if (show && !isShown) {
      m.__sparkIfRendered = [];
      renderClones(m.__sparkIfTemplate, m, m.__sparkIfRendered, scope);
    } else if (!show && isShown) {
      m.__sparkIfRendered.forEach(leaveNode); // cleanups + (optional) exit anim
      m.__sparkIfRendered = [];
    } else if (show && isShown) {
      // keep contents fresh
      m.__sparkIfRendered.forEach((n) => {
        if (n.parentNode) walkNode(n, scope);
      });
    }
  }
}

// ─── <template await="promise"> async blocks ──────────────────────────
// Declarative async, the Spark way: no compiler, reuse the same template +
// scope-proxy + dependency-tracking machinery the each/if blocks ride on.
//
//   <template await="expr">
//     <p>Loading…</p>                       <!-- pending (default) -->
//     <template then>  {await.value} </template>   <!-- await = resolved value -->
//     <template catch> {await.message} </template> <!-- await = error -->
//   </template>
//
// • await="expr"        re-evaluates when a scalar dependency changes (like $:),
//                       cancels the prior promise, and shows pending again.
// • await="once(expr)"  fires on mount only (never re-fires).
// A non-thenable expr is treated as an already-resolved value (then branch).

// The scope an await branch's content walks with: the identifier `await` (and
// an optional `as` alias) bound to the settled value — the resolved value in
// `then`, the error in `catch` — and the plain scope while pending. Exactly a
// loop scope with both names bound to the same value, so reuse it.
function awaitBranchScope(el, scope, state) {
  if (state !== 'then' && state !== 'catch') return scope;
  const v = state === 'then' ? el.__sparkAwaitValue : el.__sparkAwaitError;
  return makeLoopScope({ v: 'await', iv: el.__sparkAwaitAs, item: v, i: v, scope });
}

function parseAwait(el) {
  let expr = (el.getAttribute('await') || '').trim();
  // once(expr): one-shot — evaluate on mount only. Greedy capture so inner
  // parens (once(load())) round-trip.
  const m = expr.match(/^once\(([\s\S]*)\)$/);
  el.__sparkAwaitOnce = !!m;
  el.__sparkAwaitExpr = (m ? m[1] : expr).trim();
  el.__sparkAwaitFn = compileExpr(el.__sparkAwaitExpr);
  el.__sparkAwaitAs = el.getAttribute('as') || null;

  const isTplAnchor = el.tagName.toLowerCase() === 'template';
  const content = [...(isTplAnchor ? el.content : el).childNodes];

  const pending = [], thenNodes = [], catchNodes = [];
  for (const n of content) {
    const isTpl = n.nodeType === ELEMENT_NODE && n.tagName === 'TEMPLATE';
    if (isTpl && n.hasAttribute('then')) thenNodes.push(...n.content.childNodes);
    else if (isTpl && n.hasAttribute('catch')) catchNodes.push(...n.content.childNodes);
    else pending.push(n);
  }
  const clone = (nodes) => nodes.map((n) => n.cloneNode(true));
  el.__sparkPendingTpl = clone(pending);
  el.__sparkThenTpl = clone(thenNodes);
  el.__sparkCatchTpl = clone(catchNodes);
  if (!isTplAnchor) el.innerHTML = '';
  el.__sparkAwaitParsed = 1;

  // Hydration: drop any branch content a prerender baked as live siblings
  // (tagged data-spark-await) so the client re-runs the promise and renders
  // once — no duplicate. The crawler still got the resolved HTML.
  if (!(isPrerender())) {
    let probe = el.nextSibling;
    while (probe && probe.nodeType !== ELEMENT_NODE) probe = probe.nextSibling;
    if (probe && probe.hasAttribute && probe.hasAttribute('data-spark-await')) {
      let n = el.nextSibling;
      while (n) {
        const next = n.nextSibling;
        if (n.nodeType === ELEMENT_NODE && !(n.hasAttribute && n.hasAttribute('data-spark-await'))) break;
        destroyComponent(n);
        n.remove();
        n = next;
      }
    }
  }
}

// Tear down the current branch's DOM and render the branch for the current
// state, walking it with the right scope (await-bound for then/catch).
function applyAwaitState(el, scope) {
  if (el.__sparkAwaitRendered) {
    for (const n of el.__sparkAwaitRendered) leaveNode(n);
  }
  el.__sparkAwaitRendered = [];
  const state = el.__sparkAwaitState;
  const tpl = state === 'then' ? el.__sparkThenTpl
    : state === 'catch' ? el.__sparkCatchTpl
    : el.__sparkPendingTpl;
  const branchScope = awaitBranchScope(el, scope, state);
  insertClones(tpl, el, el.__sparkAwaitRendered);
  // Tag baked branch nodes during prerender so a client mount can clear them
  // (see parseAwait) and re-render without duplicating.
  if (isPrerender() && state !== 'pending') {
    for (const c of el.__sparkAwaitRendered) {
      if (c.nodeType === ELEMENT_NODE && c.setAttribute) c.setAttribute('data-spark-await', '');
    }
  }
  // Walk after the whole branch is inserted (see patchEach — nested if/else
  // chains need their followers present when the head first patches).
  for (const c of el.__sparkAwaitRendered) walkNode(c, branchScope);
  hydrateBlockImports(el.__sparkAwaitRendered, branchScope);
  el.__sparkAwaitRenderedState = state;
}

// Keep the current branch's reactive bindings fresh on later patches.
function refreshAwait(el, scope) {
  if (!el.__sparkAwaitRendered) return;
  const branchScope = awaitBranchScope(el, scope, el.__sparkAwaitRenderedState);
  for (const n of el.__sparkAwaitRendered) if (n.parentNode) walkNode(n, branchScope);
}

// (Re)start the block on a new promise/value: show pending, then settle into
// then/catch. Stale promises (superseded by a newer evaluation) are ignored.
function startAwait(el, source, scope) {
  el.__sparkAwaitSource = source;
  const thenable = source && typeof source.then === 'function';
  if (!thenable) {
    // A plain value (or nullish) — resolved immediately.
    el.__sparkAwaitState = 'then';
    el.__sparkAwaitValue = source;
    applyAwaitState(el, scope);
    return;
  }
  const p = source;
  el.__sparkAwaitPromise = p;
  el.__sparkAwaitState = 'pending';
  applyAwaitState(el, scope); // loading, now

  // Let the prerender settle loop wait so :then content is in the HTML.
  pushPrerenderWait(p);

  const settle = (state, payload) => {
    if (el.__sparkAwaitPromise !== p) return; // superseded — drop
    el.__sparkAwaitState = state;
    if (state === 'then') el.__sparkAwaitValue = payload;
    else el.__sparkAwaitError = payload;
    // Re-render through the owning component's batched flush when present (so a
    // burst of settles collapses into one patch). Crucially that flush re-walks
    // in FULL mode, which does NOT re-evaluate the await expr (avoiding promise
    // churn for inline exprs like fetch()) — it only applies the new state.
    const comp = el.__sparkAwaitComp;
    if (comp && comp.__sparkScheduleFull && comp.isConnected) comp.__sparkScheduleFull();
    else applyAwaitState(el, el.__sparkAwaitScope || scope);
  };
  p.then((v) => settle('then', v), (e) => settle('catch', e));
}

export function patchAwait(el, scope) {
  if (!el.__sparkAwaitParsed) parseAwait(el);
  if (!el.parentNode) return;
  el.__sparkAwaitScope = scope; // latest scope for async settles + refresh
  if (el.__sparkAwaitComp === undefined) el.__sparkAwaitComp = closestComponent(el);

  const firstTime = !el.__sparkAwaitStarted;
  const exprKeys = el.__sparkAwaitExprKeys;
  // Re-evaluate the expr (and maybe restart) only on first sight, or — unless
  // it's once() — in a dirty pass where one of the expr's own deps changed.
  // Never in a full pass: that's where async settles re-render, and re-running
  // an inline expr (fetch(url)) there would mint a new promise every time.
  const reEval = firstTime
    || (!el.__sparkAwaitOnce && capture.dirtyMode && setsIntersect(exprKeys, capture.dirtyKeys));

  if (reEval) {
    let set = el.__sparkAwaitExprKeys;
    set = set ? (set.clear(), set) : new Set();
    const prev = capture.set;
    capture.set = set; // record THIS expr's deps (also flows to the block sink)
    let result;
    try { result = runExpr(el.__sparkAwaitFn, el.__sparkAwaitExpr, scope); }
    finally { capture.set = prev; }
    el.__sparkAwaitExprKeys = set.size ? set : null;

    if (firstTime || result !== el.__sparkAwaitSource) {
      el.__sparkAwaitStarted = 1;
      startAwait(el, result, scope);
      return;
    }
  } else if (exprKeys && capture.sink) {
    // Not re-evaluating this pass — still keep the block's gating deps.
    for (const k of exprKeys) capture.sink.add(k);
  }

  // State may have advanced asynchronously since the last walk → swap branch;
  // otherwise just refresh the current branch's reactive content.
  if (el.__sparkAwaitState !== el.__sparkAwaitRenderedState) applyAwaitState(el, scope);
  else refreshAwait(el, scope);
}

// ─── each="item in array" loops ───────────────────────────────────────
// Reconciling, not rebuilding. The old implementation removed every clone
// and recreated it on every patch — which fires on every keystroke — so an
// <input> inside a loop could never hold focus and long lists thrashed the
// DOM. We now keep one "block" of nodes per item and REUSE it across
// patches: blocks are matched by key (default: index), reused in place
// (no move when already correct, so focus survives), created for new items,
// and destroyed for removed ones.
//
// Optional explicit key for identity-stable reconciliation across reorders:
//   <template each="todo in todos" key="todo.id"> … </template>

// A loop scope: the loop variable (`box.v`) and index (`box.iv`) resolve from
// a mutable box via own accessors; everything else falls through the native
// prototype chain to the enclosing scope proxy (so dependency capture still
// sees those reads, one proxy trap instead of two). One scope object is
// created per block and REUSED across patches — reconciliation just rewrites
// box.item / box.i. The prototype is fixed at creation, so the callers that
// rewrite box.scope must rebuild the scope object when its identity changes
// (they compare first; a component's scope proxy is stable, so in practice
// this never fires after creation).
// The loop-var setter is a silent no-op — an assignment must never clobber
// the loop variable or leak it onto the shared parent scope.
// The getters DO record their own name into the capture sets (like a scope
// read): the fast expression variant (expr.js buildFast) destructures every
// captured key from the scope object, and the loop var must be in that key
// set to resolve through this accessor instead of falling to a global
// lookup. Row nodes therefore carry the loop-var name in their readKeys —
// walkBlock's rowForce is what keeps item-driven row walks un-gated.
function makeLoopScope(box) {
  const record = (name) => {
    if (capture.set) capture.set.add(name);
    if (capture.sink) capture.sink.add(name);
  };
  const desc = {
    [box.v]: { get: () => (record(box.v), box.item), set: () => {}, configurable: true },
  };
  if (box.iv) desc[box.iv] = { get: () => (record(box.iv), box.i), set: () => {}, configurable: true };
  return Object.create(box.scope, desc);
}

// Siblings OWNED by an anchor node — the rendered output of an if/else
// chain member, an await block, or a nested each. They sit after the anchor
// in the DOM but belong to it, so a row move must carry them along.
function anchorOwnedNodes(n) {
  if (n.__sparkIfRendered && n.__sparkIfRendered.length) return n.__sparkIfRendered;
  if (n.__sparkAwaitRendered && n.__sparkAwaitRendered.length) return n.__sparkAwaitRendered;
  if (n.__sparkEachBlocks && n.__sparkEachBlocks.length) {
    const out = [];
    for (const b of n.__sparkEachBlocks) out.push(...b.nodes);
    return out;
  }
  return null;
}

// The physically-last node of `n`'s span: `n` itself, or the deep end of the
// last owned sibling its anchor rendered.
function blockEnd(n) {
  const owned = anchorOwnedNodes(n);
  if (owned) {
    for (let i = owned.length - 1; i >= 0; i--) {
      if (owned[i].parentNode) return blockEnd(owned[i]);
    }
  }
  return n;
}

// Ensure `n` sits right after `cursor` (moving it only when needed), then its
// owned rendered siblings after it, recursively. Returns the new cursor.
function placeWithRendered(cursor, n) {
  if (cursor.nextSibling !== n) cursor.after(n);
  cursor = n;
  const owned = anchorOwnedNodes(n);
  if (owned) {
    for (const r of owned) {
      if (r.parentNode) cursor = placeWithRendered(cursor, r);
    }
  }
  return cursor;
}

// Longest-increasing-subsequence membership (patience sorting, O(n log n)):
// returns the positions of `seq` forming one LIS. Rows on it are already in
// relative order and never move — a swap displaces 2 rows and a remove 0,
// instead of a forward cursor cascading ~n moves.
function lisMembers(seq) {
  const tails = []; // tails[d] = seq position of the smallest tail among increasing runs of length d+1
  const prev = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    const x = seq[i];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < x) lo = mid + 1; else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const members = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) { members.push(k); k = prev[k]; }
  return members;
}

// Walk a block's nodes with its loop scope, accumulating every key the row
// reads (outer-scope keys AND loop-var names) into block.ext (grow-only,
// exactly withSink's contract) and propagating to the enclosing sink so the
// anchor's own gating set still sees everything. block.ext is what lets a
// dirty pass skip rows whose external reads are untouched.
//
// `force` = the walk was triggered by the row's own inputs changing (item
// identity/index) rather than by an external key: suspend per-node key
// gating for its duration — the row's loop-var-derived bindings carry only
// the loop-var name in readKeys, which never appears in dirtyKeys. Without
// force, an item-replacement walk would skip exactly the nodes that need
// re-rendering. An external-key walk (force=false) keeps gating, so e.g. a
// `sel` change re-evaluates only the one :class binding per row that reads
// it, not every text node.
function walkBlock(block, force) {
  // Graph mode (shallow live rows): rows carry NO per-row dep state — any
  // walk that reaches a live row is ungated by definition (item-driven,
  // forced, or a full pass); external-key gating happens at the anchor via
  // the dependency masks (sweepEach). So: patch the recipe points directly,
  // no sink, no per-node capture, no per-row Sets.
  if (block.live) return patchLive(block.live, block.scope, 1);
  const prevSink = capture.sink;
  const prevForce = capture.rowForce;
  const ext = block.ext || (block.ext = new Set());
  capture.sink = ext;
  if (force) capture.rowForce = 1;
  try {
    for (const nd of block.nodes) walkNode(nd, block.scope);
  } finally {
    capture.sink = prevSink;
    capture.rowForce = prevForce;
    spill(ext, prevSink);
  }
}

// ── Template dependency dispatch — column sweeps for shallow keyed rows ──
// The capture system already LEARNS every binding's key set (fn.__keys,
// global per expression source string); all rows of one keyed each share
// one template, so those are TEMPLATE-level facts — there is nothing
// per-row to store or intersect. A dirty pass asks each dynamic point of
// the template ONCE (via any block's stamped plan/tpl, all shared) whether
// its observed keys intersect the dirty set — pinned/unobserved
// expressions are always hot — then dispatches straight to that point in
// every row: no tree walk, no per-row Sets, no per-node set algebra. This
// is the compiler's precomputed binding graph, recovered by observation at
// runtime (spark-speed-up-max.md §0/V1). Freshness is structural: __keys
// is read live, so a heal (missed ternary branch → union re-capture) is
// honored by the very next sweep; the healed key reaches the anchor's own
// gate through the still-active sink (every sweep runs inside the anchor's
// withSink). Loop-var names are recorded in __keys but never appear as
// scope dirty keys except by user-level shadowing — where a spurious
// re-eval is safe, same as today's per-node gating.
const gHot = []; // scratch — sweeps never nest (shallow rows can't contain anchors)
function sweepEach(el) {
  const blocks = el.__sparkEachBlocks;
  if (!blocks.length) return;
  const dk = capture.dirtyKeys;
  const hit = (fn) => {
    const ks = fn.__fastable === false ? null : fn.__keys;
    if (!ks) return 1;
    for (const k of dk) if (ks.has(k)) return 1;
    return 0;
  };
  const live0 = blocks[0].live;
  gHot.length = 0;
  for (let j = 0; j < live0.length; j++) {
    const nd = live0[j];
    let hot = 0;
    if (nd.nodeType === TEXT_NODE) {
      for (const seg of parseTemplate(nd.__sparkTpl)) if (typeof seg === 'object' && hit(seg.fn)) { hot = 1; break; }
    } else {
      for (const op of nd.__sparkPlan) {
        if (op.kind === 3) { for (const seg of parseTemplate(op.tpl)) if (typeof seg === 'object') { if (hit(seg.fn)) { hot = 1; break; } } }
        else if (hit(op.fn)) hot = 1;
        if (hot) break;
      }
    }
    if (hot) gHot.push(j);
  }
  for (const b of blocks) {
    const live = b.live, scope = b.scope;
    for (let x = 0; x < gHot.length; x++) patchPoint(live[gHot[x]], scope);
  }
}

export function patchEach(el, scope) {
  if (!el.__sparkEachParsed) {
    const expr = el.getAttribute('each').trim();
    const match = expr.match(/^(\w+)(?:\s*,\s*(\w+))?\s+in\s+(.+)$/);
    if (!match) {
      el.__sparkEachParsed = 1;
      warnOnce(
        `each:${expr}`,
        `[spark] Invalid each="${expr}". Expected each="item in items" or each="item, i in items".`,
      );
      return;
    }

    el.__sparkEachVar = match[1];
    el.__sparkEachIndexVar = match[2] || null;
    el.__sparkEachArrayExpr = match[3].trim();
    el.__sparkEachArrayFn = compileExpr(el.__sparkEachArrayExpr);
    const ke = el.__sparkEachKeyExpr = (el.getAttribute('key') || '').trim() || null;
    el.__sparkEachKeyFn = ke && compileExpr(ke);

    el.__sparkEachTemplate = cloneTemplateNodes(el);
    // Template-level teardown fact, computed once: a row with no component
    // boundaries and no nested anchors anywhere in its subtree needs none of
    // the per-node teardown machinery (destroyComponent's querySelectorAll
    // per node is the expensive part) — removal is just n.remove(), unless
    // a leave transition wants to animate it out.
    let deep = 0;
    for (const t of el.__sparkEachTemplate) {
      if (t.nodeType !== ELEMENT_NODE) continue;
      if ((t.matches && t.matches(DEEP_SEL)) || (t.querySelector && t.querySelector(DEEP_SEL))) {
        deep = 1;
        break;
      }
    }
    el.__sparkEachDeepRows = deep;
    el.__sparkEachParsed = 1;
    el.__sparkEachBlocks = []; // [{ key, nodes: [] }]
  }

  const {
    __sparkEachVar: varName,
    __sparkEachIndexVar: idxName,
    __sparkEachArrayExpr: arrayExpr,
    __sparkEachKeyExpr: keyExpr,
    __sparkEachTemplate: templateNodes,
  } = el;

  if (!varName || !arrayExpr || !templateNodes) return;
  if (!el.parentNode) return;

  // Reconcile-skip: in a dirty-key pass that doesn't touch any key the array
  // expression itself reads, the list's structure is untouched — the array
  // wasn't reassigned (that key would be dirty) and wasn't deep-mutated
  // (that forces a full or pure-row pass, dirtyMode false). Skip the whole
  // reconcile (key evals, LIS, placement) and just refresh the rows whose
  // external reads are dirty; per-node gating narrows further inside. Never
  // inside a forced row walk (rowForce): there the enclosing row's item was
  // replaced wholesale, so a nested array CAN be new even though this tick's
  // dirty keys don't name it.
  const arrKeysPrior = el.__sparkEachArrKeys;
  if (capture.dirtyMode && !capture.rowForce && arrKeysPrior
    && !setsIntersect(arrKeysPrior, capture.dirtyKeys)) {
    // Shallow live rows: column dispatch through the template dependency
    // graph — no per-block set algebra, no row walks. Deep rows keep the
    // per-block ext gating.
    if (!el.__sparkEachDeepRows) { sweepEach(el); return; }
    for (const b of el.__sparkEachBlocks) {
      if (b.ext && setsIntersect(b.ext, capture.dirtyKeys)) walkBlock(b);
    }
    return;
  }

  // Evaluate the array expr, accumulating its own keys (grow-only — a
  // branching expr may read different keys on different passes) for the
  // reconcile-skip gate above. Reads still flow to the anchor's sink.
  const prevArrSet = capture.set;
  const arrKeys = arrKeysPrior || (el.__sparkEachArrKeys = new Set());
  capture.set = arrKeys;
  let arr;
  try {
    arr = runExpr(el.__sparkEachArrayFn, arrayExpr, scope);
  } finally {
    capture.set = prevArrSet;
    spill(arrKeys, prevArrSet);
  }
  if (!Array.isArray(arr)) {
    // null/undefined is a normal "loading" state; warn only for a real
    // type mistake (e.g. each over an object or string).
    if (arr != null) {
      warnOnce(
        `eacharr:${arrayExpr}`,
        `[spark] each="… in ${arrayExpr}" expected an array but got ${typeof arr}. Nothing rendered.`,
      );
    }
    return;
  }

  // The key expression evaluates through ONE shared per-anchor box+proxy;
  // each block carries its own persistent box+proxy for walking its nodes.
  // Reconciliation updates three box fields per row instead of allocating a
  // new Proxy per row per patch (see makeLoopScope).
  const keyFn = el.__sparkEachKeyFn;
  let keyBox = el.__sparkEachKeyBox;
  if (keyFn && (!keyBox || keyBox.scope !== scope)) {
    if (keyBox) keyBox.scope = scope;
    else keyBox = el.__sparkEachKeyBox = { v: varName, iv: idxName, item: null, i: 0, scope };
    el.__sparkEachKeyScope = makeLoopScope(keyBox);
  }

  const oldBlocks = el.__sparkEachBlocks || [];
  const oldByKey = new Map();
  for (let j = 0; j < oldBlocks.length; j++) {
    const b = oldBlocks[j];
    b.oldIdx = j;
    oldByKey.set(b.key, b);
  }

  // Track each row's raw item on the owning component, so a deep mutation
  // (`todos[i].done = …`) can re-walk just that row instead of the whole
  // component. A WeakSet → dropped rows are collected automatically.
  const comp = el.__sparkEachComp || (el.__sparkEachComp = closestComponent(el));
  const items = comp && (comp.__sparkItems || (comp.__sparkItems = new WeakSet()));

  // ── Phase 1: match rows to blocks by key (no DOM writes yet) ──
  const count = arr.length;
  const entries = new Array(count);
  const seq = [];   // reused blocks' old positions, in new order
  const seqAt = []; // entry index of each seq member
  let increasing = 1; // reused rows already in relative order → zero moves
  let prevOld = -1;
  for (let i = 0; i < count; i++) {
    const item = arr[i];
    const raw = (item && item[REACTIVE_RAW]) || item;
    if (items && raw && typeof raw === 'object') items.add(raw);
    let key = i;
    if (keyFn) {
      keyBox.item = item; keyBox.i = i;
      key = runExpr(keyFn, keyExpr, el.__sparkEachKeyScope);
    }
    const block = oldByKey.get(key);
    let walk = true;
    let force = false;
    if (block) {
      oldByKey.delete(key);
      const box = block.box;
      // Decide BEFORE overwriting the block's bookkeeping. In a dirty-key
      // pass: a row whose item identity, index, and read keys are all
      // untouched this tick renders byte-identically — skip its whole walk
      // (this is what turns an immutable array update into O(changed
      // rows)). A row whose own inputs changed (identity/index, or no
      // recorded key set yet) walks with rowForce — per-node gating off,
      // like a one-row full pass. A row walked only because an external
      // key it reads changed keeps per-node gating, so just the bindings
      // reading that key re-evaluate. Full passes walk everything;
      // pure-row passes keep the dirtyItems gate; a deep mutation mixed
      // with a key write in one tick forces a full pass (flush
      // classification), so the identity test can't go stale.
      if (capture.dirtyMode) {
        // Live rows have no ext set: identity/index decide the walk, and
        // external-key refreshes ride the post-reconcile sweep instead.
        force = block.raw !== raw || (idxName && box.i !== i) || !(block.live || block.ext);
        walk = force || (!block.live && setsIntersect(block.ext, capture.dirtyKeys));
      } else {
        walk = !capture.dirtyItems || capture.dirtyItems.has(raw);
      }
      box.item = item; box.i = i;
      if (box.scope !== scope) {
        // Enclosing scope identity changed (never for a stable component
        // proxy) — the loop scope's prototype is fixed, so rebuild it.
        box.scope = scope;
        block.scope = makeLoopScope(box);
        walk = true;
        force = true;
      }
      block.raw = raw;
      if (increasing) {
        if (block.oldIdx < prevOld) increasing = 0;
        else prevOld = block.oldIdx;
      }
      seqAt.push(i);
      seq.push(block.oldIdx);
    }
    entries[i] = { block, item, raw, key, walk, force };
  }

  // ── Phase 2: rows on a longest increasing subsequence of old positions
  // keep their DOM position; every other reused row moves exactly once.
  if (increasing) {
    for (const e of entries) if (e.block) e.stay = 1;
  } else {
    for (const k of lisMembers(seq)) entries[seqAt[k]].stay = 1;
  }

  // ── Phase 3: place / create / walk, forward with a moving cursor ──
  const newBlocks = new Array(count);
  let insertAfter = el;
  for (let i = 0; i < count; i++) {
    const e = entries[i];
    let block = e.block;
    if (block) {
      if (!e.stay) {
        // Move the whole row right after the cursor. An anchor's OWN
        // rendered content (an if/else chain, await branch, or nested each
        // inside this row) lives as siblings after it — reposition it along
        // with the anchor, or reordering rows would strand it. Rows still
        // in place are never touched, so a focused <input> keeps focus.
        let cursor = insertAfter;
        for (const nd of block.nodes) cursor = placeWithRendered(cursor, nd);
      }
      if (e.walk) walkBlock(block, e.force);
    } else {
      const box = { v: varName, iv: idxName, item: e.item, i, scope };
      const loopScope = makeLoopScope(box);
      // hydrateBlockImports (inside renderClones) mutates `nodes` in place,
      // swapping placeholders for booted hosts so reconciliation tracks them.
      const nodes = [];
      // Shallow rows (no anchors/components/imports anywhere in the
      // template) collect their dynamic nodes at stamp time; walkBlock then
      // patches that list instead of walking the row's DOM.
      const live = el.__sparkEachDeepRows ? 0 : [];
      block = { key: e.key, nodes, box, scope: loopScope, raw: e.raw, ext: live ? 0 : new Set(), live };
      if (live) {
        // Graph mode: no per-block ext Set. The anchor's very first row
        // (nothing rendered before it, this pass or ever) renders capturing
        // under the anchor's own sink — seeding fn.__keys and the anchor's
        // key set; every later row replays through patchPoint (renderClones
        // fast path) — the capture tax is paid once per TEMPLATE, not per
        // row.
        renderClones(templateNodes, insertAfter, nodes, loopScope, live, i || oldBlocks.length);
      } else {
        const prevSink = capture.sink;
        capture.sink = block.ext;
        try {
          renderClones(templateNodes, insertAfter, nodes, loopScope, live);
        } finally {
          capture.sink = prevSink;
          spill(block.ext, prevSink);
        }
      }
    }
    newBlocks[i] = block;
    const last = block.nodes[block.nodes.length - 1];
    // The next block starts after this row's LAST node — including any
    // content its trailing anchor rendered (if/await/nested-each output).
    if (last) insertAfter = blockEnd(last);
  }

  // Anything left in oldByKey was dropped from the array — clean it up.
  // Shallow rows (no components/anchors in the template, no leave hook)
  // need no teardown machinery: just detach.
  const shallow = !el.__sparkEachDeepRows && !leaveHook;
  for (const b of oldByKey.values()) {
    if (shallow) for (const n of b.nodes) n.remove();
    else for (const n of b.nodes) leaveNode(n); // cleanups + (optional) exit anim
  }

  el.__sparkEachBlocks = newBlocks;

  // A reconcile tick can carry external-key writes too (rows = next AND
  // selected = id in one microtask). Identity-skipped rows never walked, so
  // dispatch the external keys over the graph; it exits for free when no
  // registered key is dirty, and re-evaluating just-created rows is an
  // idempotent compare-gated no-op.
  if (capture.dirtyMode && !el.__sparkEachDeepRows) sweepEach(el);
}