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
import { compileExpr, runExpr, rowFn, parseTemplate } from './expr.js';
import { REACTIVE_RAW, setsIntersect } from './reactivity.js';
import {
  capture,
  warnOnce,
  closestComponent,
  ELEMENT_NODE, TEXT_NODE,
  cloneTemplateNodes, insertClones, insertChunk, renderClones,
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
    const isShown = !!(m.__sparkIfRendered && m.__sparkIfRendered.length);

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
  // No proto cache here: await branches re-render rarely (settle/re-eval),
  // so per-call proto build is cheaper than a cache slot.
  return rowScope(makeLoopProto('await', el.__sparkAwaitAs, scope), { item: v, i: v });
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

// A loop scope: the loop variable and index resolve via accessors on ONE
// shared per-anchor prototype; everything else falls through the chain to
// the enclosing scope proxy (so dependency capture still sees those reads,
// one proxy trap instead of two). One `{__proto__, __b}` scope object is
// created per block and REUSED across patches — reconciliation just
// rewrites block.item / block.i. The proto captures the enclosing scope at
// creation, so patchEach rebuilds it (and every row scope) when the scope
// identity changes (it compares first; a component's scope proxy is
// stable, so in practice this never fires after creation).
// The loop-var setter is a silent no-op — an assignment must never clobber
// the loop variable or leak it onto the shared parent scope.
// The getters DO record their own name into the capture sets (like a scope
// read): the fast expression variant (expr.js buildFast) destructures every
// captured key from the scope object, and the loop var must be in that key
// set to resolve through this accessor instead of falling to a global
// lookup. Row nodes therefore carry the loop-var name in their readKeys —
// walkBlock's rowForce is what keeps item-driven row walks un-gated.
// P4b (speed-max-pro): ONE prototype per anchor carries the loop-var
// getters — closures per ANCHOR, not per row. A row scope is then just
// `{ __proto__: proto, __b: rowState }` (heap receipt: the old per-row
// get/set/record closures were 82 KB at 1k rows). Reads record into the
// active capture set/sink exactly as before; writes to a loop var stay
// silently ignored. `__b` is set in the object literal (defineProperty
// semantics) — a plain assignment would walk the proto chain into the
// component scope proxy's set trap.
function makeLoopProto(v, iv, scope) {
  const desc = {};
  const add = (name, k) => desc[name] = {
    // No `configurable`: a proto is never redefined — scope-identity
    // changes rebuild the whole proto object instead.
    get() {
      if (capture.set) capture.set.add(name);
      if (capture.sink) capture.sink.add(name);
      return this.__b[k];
    },
    set: () => {},
  };
  add(v, 'item');
  if (iv) add(iv, 'i');
  return Object.create(scope, desc);
}
// A row scope over the shared proto. `__b` must be DEFINED (object
// literal), never assigned — assignment would walk the chain into the
// scope proxy's set trap.
const rowScope = (p, b) => ({ __proto__: p, __b: b });

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
const gKeys = []; // key-scan scratch — pooled for shallow anchors only (same reason)
// Canonical raw identity for an item read off the RAW backing array: users
// can store previously-wrapped values (rows = [rows[2], rows[0]]), so the
// backing array may hold reactive proxies — dirtyItems/`block.raw` identity
// must always compare the true raw target.
const rawOf = (x) => (x && typeof x === 'object' && x[REACTIVE_RAW]) || x;
// P2 (speed-max-pro): is point j's ONLY dirty-sensitive expression the
// shape `rowKey === scalar ? a : b` (or bare/`!==`, either operand order),
// where rowKey is EXACTLY this anchor's key expression and neither branch
// mentions the scalar again? Then a change to that scalar can only move
// the match from one row to another — patch those two rows, not N.
// Classification is per (anchor, point), cached; source-level, masked by
// nothing (expressions carry their compile source on fn.__src). ANY doubt
// classifies as 0 → the full sweep below stays the semantic definition.
function classifySel(el, nd) {
  const K = el.__sparkEachKeyExpr;
  if (!K || nd.nodeType === TEXT_NODE || !nd.__sparkPlan) return 0;
  let name = null;
  for (const op of nd.__sparkPlan) {
    if (op.kind === 3) return 0; // interpolations: sweep
    const src = op.fn && op.fn.__src;
    if (!src) return 0;
    const q = src.indexOf('?');
    const head = (q < 0 ? src : src.slice(0, q)).trim();
    // head must be exactly `KEY === id` / `id === KEY` (or !==) — exact
    // string compare against the anchor's key source, no escaping games
    const parts = head.split(/\s*[!=]==\s*/);
    if (parts.length !== 2) return 0;
    const id = parts[0] === K ? parts[1] : parts[1] === K ? parts[0] : null;
    if (!id || !/^[A-Za-z_$][\w$]*$/.test(id)) return 0;
    // the scalar must not appear in the branches — substring check is
    // over-conservative on purpose; a miss only costs a sweep
    if (q >= 0 && src.slice(q).includes(id)) return 0;
    if (name && name !== id) return 0; // two different scalars: sweep
    name = id;
  }
  return name || 0;
}

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

  // Selector fast path (P2): exactly one hot point, one dirty key, and the
  // point classifies as key-equality on that key. The key→block map is
  // rebuilt lazily after every structural reconcile (patchEach nulls it),
  // and the first sweep after a rebuild runs the FULL pass to re-sync
  // `prev` with the rendered DOM — O(2) only ever follows a full sync.
  if (gHot.length === 1 && dk.size === 1) {
    const j = gHot[0];
    const nd = live0[j];
    let cls = nd.__sparkSC; // classification, cached on the point node
    if (cls === undefined) cls = nd.__sparkSC = classifySel(el, nd);
    if (cls && dk.has(cls)) {
      let map = el.__sparkKeyMap;
      const st = el.__sparkSelSt; // { j, v: value the DOM currently shows }
      const val = blocks[0].scope[cls];
      if (map && st && st.j === j) {
        const a = map.get(st.v), b = map.get(val);
        if (a) patchPoint(a.live[j], a.scope);
        if (b && b !== a) patchPoint(b.live[j], b.scope);
        st.v = val;
        return;
      }
      if (!map) {
        map = el.__sparkKeyMap = new Map();
        for (const b of blocks) map.set(b.key, b);
      }
      el.__sparkSelSt = { j, v: val };
      // fall through: full sweep re-syncs every row against the new value
    }
  }

  for (const b of blocks) {
    const live = b.live, scope = b.scope;
    for (let x = 0; x < gHot.length; x++) patchPoint(live[gHot[x]], scope);
  }
}

// The V4 wipe: if the parent's managed children are exactly this anchor's
// `own` nodes, wipe the parent in one pass and re-append the keepers
// (anchor, whitespace, sibling non-managed markup) in order — byte-identical
// to a fresh mount of the empty list. Returns whether it wiped.
function wipeAll(el, own) {
  const parent = el.parentNode;
  const keep = [];
  let managed = 0;
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.__sparkManaged) managed++;
    else keep.push(n);
  }
  if (managed !== own || keep.length > own) return 0;
  parent.textContent = '';
  for (const n of keep) parent.appendChild(n);
  return 1;
}

// P3 (speed-max-pro): idle self-warmup. The krausest residual is FIRST-RUN
// script cost — the row-patch pipeline runs in the interpreter exactly when
// the user first interacts. So after mount settles, drive patchEach once
// against a DETACHED clone of every shallow each-anchor with synthetic rows
// (create → reverse → swap → clear): every hot path — chunked stamping,
// trim/LIS/direct-permutation reconcile, the wipe, expression fast-variants
// — has executed and tiered up before the first real interaction. Generic
// framework self-initialization: touches only spark's own parsed templates,
// costs idle time, and every app's first click benefits identically.
// Row values are undefined-heavy on purpose; warnOnce is gated (gWarm) so
// a throwing warm expression never spends a real warning's dedupe slot,
// and the whole pass is try-wrapped — warming must never break a page.
export function warmEach(root) {
  if (!root.querySelectorAll) return;
  for (const el of root.querySelectorAll('template[each]')) {
    if (!el.__sparkEachParsed || el.__sparkEachDeepRows || !el.__sparkEachTemplate || el.__sparkWarmed) continue;
    el.__sparkWarmed = 1;
    let host = el.parentNode;
    while (host && !host.__sparkScope) host = host.parentNode;
    const scope = (host && host.__sparkScope) || {};
    const w = el.ownerDocument.createElement('template');
    // Every __spark* expando rides over; blocks/deep are overridden. The
    // copied selector/arrKeys state is never consulted: warm passes run
    // with dirtyMode off, so the reconcile-skip and sweep gates never open.
    Object.assign(w, el);
    w.__sparkEachDeepRows = 0;
    w.__sparkEachBlocks = [];
    el.ownerDocument.createElement('div').appendChild(w);
    let cur = [];
    for (let i = 0; i < 66; i++) cur.push({ id: ~i });
    w.__sparkEachArrayFn = () => cur;
    try {
      // chunked create + seed row, then clear/wipe. (Reorder warm passes —
      // LIS + direct permutation — were descoped for bytes at 18.00; the
      // move paths share placeWithRendered/patchPoint with these two.
      // Revisit at the checkpoint if swap/update cold cost didn't move.)
      patchEach(w, scope);
      cur = [];
      patchEach(w, scope);
    } catch { /* warming must never break the page */ }
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
    el.__sparkEachIndexVar = match[2] || 0;
    el.__sparkEachArrayExpr = match[3].trim();
    el.__sparkEachArrayFn = compileExpr(el.__sparkEachArrayExpr);
    const ke = el.__sparkEachKeyExpr = (el.getAttribute('key') || '').trim() || 0;
    el.__sparkEachKeyFn = ke && compileExpr(ke);

    el.__sparkEachTemplate = cloneTemplateNodes(el);
    // Whitespace between table-structural rows is render-inert (CSS table
    // fixup ignores it), but cloned into every BLOCK it triples the DOM
    // mutations of every row move — a 2-row swap moved 6 nodes (the F1
    // "swap paint gap", attributed at speed-max-pro P0). When EVERY element
    // in the template is table-structural (or <option>), drop the
    // whitespace-only text nodes; inline content keeps its whitespace —
    // there it renders.
    {
      const tpl = el.__sparkEachTemplate;
      const isEl = (n) => n.nodeType === ELEMENT_NODE;
      if (tpl.some(isEl) && tpl.every((n) => !isEl(n) || /^(?:T[RDH]|TBODY)$/.test(n.tagName))) {
        el.__sparkEachTemplate = tpl.filter((n) => n.nodeType !== TEXT_NODE || n.data.trim());
        // P4a (DESCOPED 2026-07-10 at the 18.00 ALL-IN rule, +0.05 KB —
        // same precedent as F4's park-then-revive): the same rule applies
        // INSIDE the row containers — whitespace between a <tr>'s cells is
        // render-inert too, but cloned per row it costs a Text node + a
        // __spark expando slot + layout adjacency work each (heap receipt:
        // ~4.5 such nodes per krausest row). Verified design: inside THIS
        // gate, every element is T[RDH]|TBODY, so containers are simply
        // !/^T[DH]$/ — for those, remove whitespace-only text children
        // (cells hold flow content, never touched). Revive with funding.
      }
    }
    // Template-level teardown fact, computed once: a row with no component
    // boundaries and no nested anchors anywhere in its subtree needs none of
    // the per-node teardown machinery (destroyComponent's querySelectorAll
    // per node is the expensive part) — removal is just n.remove(), unless
    // a leave transition wants to animate it out.
    el.__sparkEachDeepRows = el.__sparkEachTemplate.some((t) => t.nodeType === ELEMENT_NODE
      && ((t.matches && t.matches(DEEP_SEL)) || (t.querySelector && t.querySelector(DEEP_SEL)))) ? 1 : 0;
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

  // varName/arrayExpr/templateNodes are set together at parse — one guard.
  if (!varName || !el.parentNode) return;

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

  // ONE prototype per anchor holds the loop-var getters (makeLoopProto);
  // a row scope is `{__proto__: proto, __b: block}` — the block IS the row
  // state (item/i live on it since P4b). Proto (and with it every row
  // scope) rebuilds only when the enclosing scope identity changes — never
  // for a stable component proxy.
  let proto = el.__sparkEachProto;
  const protoChanged = !proto || el.__sparkEachPS !== scope;
  if (protoChanged) {
    proto = el.__sparkEachProto = makeLoopProto(varName, idxName, scope);
    el.__sparkEachPS = scope;
  }
  const keyFn = el.__sparkEachKeyFn;
  const keyBox = keyFn && (el.__sparkEachKeyBox ||= { item: null, i: 0 });
  // Built once per reconcile (not cached): a two-property literal over the
  // shared proto — cheaper than the old cached-scope invalidation dance.
  const keyScope = keyFn && rowScope(proto, keyBox);

  const oldBlocks = el.__sparkEachBlocks || [];
  const oldLen = oldBlocks.length;

  // Track each row's raw item on the owning component, so a deep mutation
  // (`todos[i].done = …`) can re-walk just that row instead of the whole
  // component. A WeakSet → dropped rows are collected automatically.
  const comp = el.__sparkEachComp || (el.__sparkEachComp = closestComponent(el));
  const items = comp && (comp.__sparkItems || (comp.__sparkItems = new WeakSet()));

  const count = arr.length;
  // The whole scan runs against the RAW array — every `arr[i]` on the
  // wrapped proxy pays a get trap + reactify cache hop, measured at 15–21%
  // of swap/update script time (F0 attribution). Raw is for the SCAN; rows
  // keep receiving wrapped values (box.item) so in-place mutation
  // reactivity is untouched.
  const rawArr = arr[REACTIVE_RAW] || arr;

  // ── Stage 1: new-side keys, once. Fast path: the key expression with the
  // loop vars as REAL parameters over raw items (rowFn) — no box writes, no
  // proxy hops, no with(). Any throw (a branch key the first capture never
  // saw, an exotic key expr) pins THIS anchor to the box path, which
  // re-captures and stays correct.
  const keys = el.__sparkEachDeepRows ? new Array(count) : gKeys; // pooled only where reentry is impossible
  keys.length = count;
  let rf = keyFn && el.__sparkEachRowKey !== 0 ? rowFn(keyFn, varName, idxName) : 0;
  if (rf) {
    try { for (let i = 0; i < count; i++) keys[i] = rf(scope, rawArr[i], i); }
    catch { rf = el.__sparkEachRowKey = 0; }
  }
  if (!rf) {
    if (!keyFn) for (let i = 0; i < count; i++) keys[i] = i;
    else for (let i = 0; i < count; i++) {
      keyBox.item = arr[i]; keyBox.i = i;
      keys[i] = runExpr(keyFn, keyExpr, keyScope);
    }
  }

  // Per-row reuse bookkeeping — decide BEFORE overwriting: a row whose item
  // identity, index, and read keys are untouched this tick renders
  // byte-identically and skips its walk (O(changed rows) on immutable
  // updates); identity/index changes walk with rowForce; deep-row external
  // keys keep the ext gate; live rows ride the post-reconcile sweep. The
  // wrapped read (arr[i]) happens ONLY when identity actually changed.
  const reuse = (block, i) => {
    const raw = rawOf(rawArr[i]);
    let force = false;
    let walk;
    if (capture.dirtyMode) {
      force = block.raw !== raw || (idxName && block.i !== i) || !(block.live || block.ext);
      walk = force || (!block.live && setsIntersect(block.ext, capture.dirtyKeys));
    } else {
      walk = !capture.dirtyItems || capture.dirtyItems.has(raw);
    }
    if (block.raw !== raw) {
      block.raw = raw;
      block.item = arr[i];
      if (items && raw && typeof raw === 'object') items.add(raw);
    }
    if (idxName) block.i = i;
    if (protoChanged) {
      // Enclosing scope identity changed (never for a stable component
      // proxy) — the shared proto was rebuilt above; re-seat this row's
      // scope over it.
      block.scope = rowScope(proto, block);
      walk = force = true;
    }
    if (walk) walkBlock(block, force);
  };
  // Build one new row after `cur`; returns the block ((hydrateBlockImports
  // inside renderClones mutates `nodes` in place so reconciliation tracks
  // booted hosts). Shallow rows collect their live-recipe nodes at stamp
  // time; the anchor's very first row EVER renders capturing (seeding
  // fn.__keys + the anchor's key set), every later row replays capture-free.
  let seeded = oldLen > 0;
  // Row-state constructor shared by the single and chunked create paths —
  // registers the block in newBlocks itself (single-path callers of make()
  // also assign, harmlessly).
  const build = (i, nodes, live) => {
    const raw = rawOf(rawArr[i]);
    if (items && raw && typeof raw === 'object') items.add(raw);
    const b = { key: keys[i], nodes, item: arr[i], i, scope: 0, raw, ext: 0, live };
    b.scope = rowScope(proto, b);
    return newBlocks[i] = b;
  };
  const make = (i, cur) => {
    const nodes = [];
    const live = el.__sparkEachDeepRows ? 0 : [];
    const block = build(i, nodes, live);
    if (live) {
      renderClones(templateNodes, cur, nodes, block.scope, live, seeded);
      seeded = 1;
    } else {
      const prevSink = capture.sink;
      capture.sink = block.ext = new Set();
      try {
        renderClones(templateNodes, cur, nodes, block.scope, live);
      } finally {
        capture.sink = prevSink;
        spill(block.ext, prevSink);
      }
    }
    return block;
  };
  // Shallow rows (no components/anchors, no leave hook) need no teardown
  // machinery on drop: just detach.
  const shallow = !el.__sparkEachDeepRows && !leaveHook;
  // The span end of block i-1 (or the anchor itself) — where row i inserts.
  const endOf = (blocks, i) => {
    if (i < 0) return el;
    const b = blocks[i];
    const last = b.nodes[b.nodes.length - 1];
    return last ? blockEnd(last) : el;
  };

  // ── Stage 2: trim the common prefix/suffix by key. Rows that didn't move
  // pay bookkeeping only — no map, no LIS, no entry objects. An unkeyed
  // each (key = index) trims its whole overlap, so appends/truncates are
  // O(changed) by construction.
  let p = 0;
  const pMax = oldLen < count ? oldLen : count;
  while (p < pMax && oldBlocks[p].key === keys[p]) p++;
  let so = oldLen - 1;
  let sn = count - 1;
  while (so >= p && sn >= p && oldBlocks[so].key === keys[sn]) { so--; sn--; }

  const newBlocks = new Array(count);
  for (let i = 0; i < p; i++) reuse(newBlocks[i] = oldBlocks[i], i);
  for (let i = sn + 1, j = so + 1; i < count; i++, j++) reuse(newBlocks[i] = oldBlocks[j], i);

  // ── Stage 3: the window [p..so] → [p..sn] ──
  if (count === 0 && oldLen && !el.__sparkEachDeepRows && wipeAll(el, oldLen * templateNodes.length)) {
    // V4 clear-as-one-wipe (descoped at the 17.25 ceiling, revived under
    // the 18.00 program): one textContent='' beats oldLen removes. Shallow
    // rows only (deep rows need leaveNode teardown), and only when every
    // managed child of the parent is OURS — a sibling anchor sharing this
    // parent must never be wiped; wipeAll proves it by exact count.
  } else if (p > so && p > sn) {
    // nothing structural changed
  } else if (p > so) {
    // Pure insert (create 1k/10k, append): no reconcile bookkeeping at all.
    // Shallow runs after the seed row go CHUNKED (F3): stamp CHUNK rows out
    // of one fragment clone and land them in one insert. Remainder rows —
    // and deep rows, and the capturing seed row — take the single path.
    let cur = endOf(newBlocks, p - 1);
    let i = p;
    if (!seeded && i <= sn) { newBlocks[i] = make(i, cur); cur = endOf(newBlocks, i); i++; }
    if (!el.__sparkEachDeepRows) {
      // 64 = the chunk size (one clone + one insert per group; G swept 8/16/32/64/128 at F3 — 64 won creates).
      while (sn - i > 62) {
        insertChunk(templateNodes, cur, el, 64, (nodes, live) => build(i++, nodes, live));
        cur = endOf(newBlocks, i - 1);
      }
    }
    for (; i <= sn; i++) {
      newBlocks[i] = make(i, cur);
      cur = endOf(newBlocks, i);
    }
  } else {
    // Bounded-mismatch shortcut: equal-length window whose few (≤4)
    // differing positions are a permutation of each other — a swap is 2
    // moves with no map and no LIS, regardless of how far apart the rows
    // sit. Bail to the general path the moment it isn't that shape.
    let direct = so - p === sn - p ? [] : null;
    if (direct) {
      for (let i = p; i <= sn && direct; i++) {
        if (oldBlocks[i].key !== keys[i] && direct.push(i) > 4) direct = null;
      }
    }
    if (direct) {
      for (let x = 0; direct && x < direct.length; x++) {
        const i = direct[x];
        let hit = null;
        for (let y = 0; y < direct.length; y++) {
          if (oldBlocks[direct[y]].key === keys[i]) { hit = oldBlocks[direct[y]]; break; }
        }
        // Duplicate keys (user error) could match one old block twice —
        // never let a block land in two slots; degrade to the windowed
        // path, which reuses it once and creates the extra row.
        for (let y = 0; hit && y < x; y++) if (newBlocks[direct[y]] === hit) hit = null;
        hit ? newBlocks[i] = hit : direct = null; // not a pure permutation
      }
    }
    if (direct) {
      for (let i = p; i <= sn; i++) newBlocks[i] ||= oldBlocks[i];
      // Move the displaced rows left→right; everything before each move is
      // already in final order, so the predecessor's span end is the cursor.
      for (const i of direct) {
        let cursor = endOf(newBlocks, i - 1);
        for (const nd of newBlocks[i].nodes) cursor = placeWithRendered(cursor, nd);
      }
      for (let i = p; i <= sn; i++) reuse(newBlocks[i], i);
    } else {
      // ── General window: old-index map → LIS → move only off-LIS rows ──
      const oldByKey = new Map();
      for (let j = p; j <= so; j++) {
        const b = oldBlocks[j];
        b.oldIdx = j;
        oldByKey.set(b.key, b);
      }
      const entries = new Array(sn - p + 1);
      const seq = [];   // reused blocks' old positions, in new order
      const seqAt = []; // entry index of each seq member
      for (let i = p; i <= sn; i++) {
        const block = oldByKey.get(keys[i]);
        if (block) {
          oldByKey.delete(keys[i]);
          seqAt.push(i - p);
          seq.push(block.oldIdx);
        }
        entries[i - p] = { block, stay: 0 };
      }
      for (const k of lisMembers(seq)) entries[seqAt[k]].stay = 1;
      let insertAfter = endOf(newBlocks, p - 1);
      for (let i = p; i <= sn; i++) {
        const e = entries[i - p];
        let block = e.block;
        if (block) {
          if (!e.stay) {
            // Move the whole row right after the cursor — an anchor's OWN
            // rendered content (if/await/nested-each output) rides along.
            // Rows still in place are never touched, so a focused <input>
            // keeps focus.
            let cursor = insertAfter;
            for (const nd of block.nodes) cursor = placeWithRendered(cursor, nd);
          }
          reuse(block, i);
        } else {
          block = make(i, insertAfter);
        }
        newBlocks[i] = block;
        const last = block.nodes[block.nodes.length - 1];
        if (last) insertAfter = blockEnd(last);
      }
      // Anything left in the map was dropped from the array.
      for (const b of oldByKey.values()) {
        for (const n of b.nodes) shallow ? n.remove() : leaveNode(n);
      }
    }
  }

  el.__sparkEachBlocks = newBlocks;
  // Structural change: the P2 selector map is stale (rows added/removed/
  // reordered) — rebuild lazily, and force one full re-sync sweep before
  // the O(2) path may run again.
  el.__sparkKeyMap = null;
  el.__sparkSelSt = null;

  // A reconcile tick can carry external-key writes too (rows = next AND
  // selected = id in one microtask). Identity-skipped rows never walked, so
  // dispatch the external keys over the graph; it exits for free when no
  // registered key is dirty, and re-evaluating just-created rows is an
  // idempotent compare-gated no-op.
  if (capture.dirtyMode && !el.__sparkEachDeepRows) sweepEach(el);
}