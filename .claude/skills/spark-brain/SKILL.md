---
name: spark-brain
description: The judgment layer for the Spark monorepo — value ordering, decision gates, change protocols, and standing orders that govern all work here. Load at session start alongside spark-project, and before any non-trivial decision — scope, priorities, refactors, releases, budget spend, API changes, bug triage, security work, or anything the v1 plan doesn't cover.
---

# The Spark brain — operating manual

Written 2026-07-06 by Claude Fable 5 at Wilkin's request, against spark-html
0.27.14 / spark-ssr 0.7.2, to be followed by every model that works in this
repo after me. `spark-project` holds the **facts** (repo map, invariants,
pitfalls, workflows). The **sequence** lives in `improvements.md` — the
"easiest AND fastest" program, written 2026-07-09 (each predecessor — the v1
plan, then `spark-improvements.md` — completed and was deleted; deletion on
completion is the convention). This file holds the **judgment**:
how to decide when the facts and the sequence are silent, conflicting, or
tempting you toward a mistake. It is written for the ways models like us
actually fail here — every rule below is paid for by a real shipped bug or a
real near-miss.

**Precedence:** Wilkin's explicit instruction > this manual > the active
program doc (`improvements.md` since 2026-07-09; earlier
`spark-improvements.md`, and before 2026-07-07 the v1 plan) >
everything else. When a higher authority contradicts a lower one, say so once,
plainly, with the tradeoff — then follow the higher authority without
relitigating. When Wilkin overrides a rule here, record the override (see
"Maintaining the knowledge system") so the next model inherits the decision
instead of re-fighting it.

**Session start ritual** (cheap, do it every time):
1. Load `spark-project`, then this file.
2. Read the STATUS line at the top of `improvements.md`, then
   `git log --oneline -15` to see where reality is vs. the program.
3. Only then touch the task. Never start editing the reactivity core, the
   budget, or a release from a cold context.

---

## 1. The identity, as a decision procedure

The north star: **Spark is the simplest way to write a web app — SSR,
prerender, or pure client — for humans who want to write the code
themselves.** Simplicity is the moat. Nobody outspends us on features;
nobody should out-simple us, ever.

Run every proposal — feature, fix, refactor, doc, error message — through
four gates, in order. Failing any gate is a full stop, not a negotiation:

1. **The no-build gate.** Does this require the *user* to compile, transpile,
   or configure a build step? Then it is out of scope by identity, not by
   priority. (The *framework* having a release-time build step — e.g. the M3
   dist concatenation — is fine; the user having one is never fine.)
2. **The concept-count gate.** HTML + `{expr}` + a handful of directives +
   stores. Could the existing concepts do this? If yes, the new surface is
   rejected — improve the docs or the error message instead. Every concept we
   add is a concept every future user must hold; we are spending *their*
   budget.
3. **The relocation gate.** A page written for one mode (client / SSR /
   prerender) must run in the other two by *relocation, not rewrite*. Any
   change that makes the three modes diverge in semantics — props behaving
   differently, a directive that only works in one mode — is a v1 bug even
   if each mode individually works.
4. **The loud-failure gate.** If this can fail, does it fail with a message
   that names the fix? "Simplicity is mostly the absence of failure" — a
   framework stops feeling simple the first time it fails silently. A feature
   that can fail silently is not done; it is a liability with a demo.

## 2. The order of values

When goods conflict, this is the tie-breaker order. Higher always beats lower:

1. **Correctness** — the DOM converges: any nesting, any mutation order,
   patched result identical to a from-scratch render. Nothing outranks this.
2. **Loud failure** — a bug we can't prevent must at least announce itself.
   Spend bytes on this; it is why the budget was raised.
3. **User-surface simplicity** — fewer concepts, fewer configs, better
   messages. Reliability (1 and 2) *is* the simplicity feature; that's why
   they sit above it, not below.
4. **The gzip budget** — law, but fourth: we raised it once (13.5 → 15.0,
   itemized) precisely because correctness and loud failure were worth more
   than 1.5 KB. [OVERRIDE 2026-07-08, Wilkin: raised a second time,
   15.0 → 16.0, itemized in scripts/size-check.mjs, to fund the krausest
   speed program (spark-speed-up.md) — "fastest" was declared part of the
   mission.] [OVERRIDE 2026-07-09, Wilkin, two steps ending in an ALL-IN
   ceiling: 16.0 → 16.5 for F1's template-dependency dispatch (+0.26 after
   three design iterations of golf), then 16.5 → **17.25** when F2's
   trim-first reconcile measured +0.56 and the per-gate-ask pattern was
   recognized as the real problem (round 1 cost +1.31 measured; structural
   levers here are the same shape). 17.25 covers the WHOLE remaining
   program; a gate that would exceed it is DESCOPED, never funded — no
   further budget conversations for the life of 1.x. Estimate lesson,
   twice-paid: plan-time gross byte estimates for structural core work run
   2–4× light; only the per-gate measured ledger is admissible.]
5. **Performance** — *defend, don't chase* was the 1.0 posture. [OVERRIDE
   2026-07-08, Wilkin: for the speed program, performance is actively chased
   — target is the top of the krausest js-framework-benchmark table — but
   never above correctness or loud failure, and never with new user-facing
   concepts. Outside that program, defend-don't-chase still applies.]
6. **Internal elegance** — last, always, and only under a green harness. A
   3,200-line file that works outranks a beautiful module split that ships a
   silent reconciliation bug. This is not a license for permanent mess — M3
   does the split — it is an *ordering*: harness first, then beauty.

Corollary: when you catch yourself optimizing #6 while #1's safety net (the
fuzzer) doesn't exist yet, stop. That exact inversion is how the 0.27.12–14
trilogy happened.

## 3. Epistemic standing orders

How models fail in this repo, and the counter-habit for each. These are not
suggestions; they are the lessons line-itemized in `references/pitfalls.md`,
compressed into behavior:

- **Measure, never estimate.** Gzip cost intuition is unreliable — dedup is
  free, unique entropy costs, and the only way to know is esbuild + gzipSync
  on the actual edit. The same applies to perf (run `test/bench.js`, don't
  reason about it) and to "this probably still works" (run the suite).
- **Silence is not success.** The reactivity core's failure mode is a
  directive that quietly stops updating. A green-looking page after a core
  change means *nothing* without the convergence oracle. Absence of errors is
  the *starting* condition of every bug in the 0.27.1x trilogy.
- **Confidence in the capture code is a warning sign.** Three shipped bugs
  came from one week of confident, small, "obviously fine" edits to
  `withCapture`/`withSink`/`gDirtyKeys`. If an edit there feels easy, slow
  down and follow the core protocol (§4) to the letter.
- **Verify documents against the tree before acting on them.** This includes
  the plan and this manual. The pre-rewrite `spark-improvements.md` §7
  (replaced 2026-07-07) would have burned
  weeks rebuilding features that already shipped. Line numbers rot; symbol
  names and exit criteria are the durable anchors. If a doc names a file,
  function, or flag — confirm it exists before recommending it. The knowledge
  graph (`graphify query "<question>"` against `graphify-out/`) is the
  cheapest first pass for "what calls/depends on X" questions — it found the
  website playground consuming core internals when no doc mentioned it — but
  its INFERRED edges are hypotheses: confirm in source before acting.
- **A new ambient client helper isn't done at the design stage — wire it into
  a real page before calling it done.** Adding `navigate()` to spark-ssr
  (2026-07-09) looked complete after the implementation and unit tests; it
  wasn't until it was actually wired into examples/spark-chat that a real
  bug surfaced — `handlerRoles()`'s auto-CRUD synthesis is name-blind and
  happily generated a duplicate `navigate()` that clobbered the ambient one,
  because the only thing distinguishing "author's own handler" from "calls
  the ambient helper" was a name the synthesizer didn't know to protect. No
  amount of reading the diff would have caught this; only exercising it did.
  Same lesson as the "exercise the change end-to-end" order below, but worth
  its own line because *helpers that inject names into someone else's scope*
  are a distinct risk shape from ordinary runtime changes — the collision
  is with code you didn't write and won't see in your diff.
- **Check the known-unfixed list before debugging.** Frozen props, the SSR
  loop-prop gap, SSR-never-runs-page-script, detached-host rebuild, the
  dual-package hazard — these are *documented*. Rediscovering one from
  scratch is a multi-hour tax the knowledge system exists to prevent. Match
  the symptom against `references/pitfalls.md` first, every time.
- **Never weaken an oracle to go green.** If the fuzzer or a golden-file diff
  fails, the options are: (a) you found a bug — minimize it, fix it, keep the
  case; (b) the oracle is provably too strict — fix the oracle in its own
  commit with the proof written in the commit message. "Normalize a bit more
  so it passes" is how convergence guarantees rot invisibly. Same rule for
  "flaky" tests: this repo's history says the flake *is* the bug.
- **Verify the registry, not CI green.** Releases are real when
  `registry.npmjs.org/<pkg>/latest` says so. CI can look healthy while zero
  publish workflows ran (the >3-tags trap). Likewise "works in dev" proves
  nothing about prod — dev and prod resolution differ in spark-html-bun;
  suspect resolution first for works-in-dev-only bugs.
- **Respect deliberate deferrals.** (Worked example, since resolved: the
  docs#limits table was held by owner's call until v1 shipped, then audited
  in 7ba0986.) "Helpfully" fixing something the owner deliberately parked is a
  mistake wearing a virtue. When you find such a deferral, honor it; if you
  think it's wrong, say so once and let Wilkin decide.
- **Exercise the change end-to-end.** Tests and typecheck are necessary, not
  sufficient. Anything with a runtime surface gets driven in the real runtime
  (linkedom harness at minimum; real browser via the CDP recipe in
  `references/workflows.md` for hydration/DOM-lifecycle work) before it's
  called done. The detached-host bug "visibly ran onMount" and did nothing —
  only CDP `getEventListeners` told the truth.

## 4. Change protocols by blast radius

**The reactivity core** (`packages/spark/src/index.js`, capture machinery and
directive patchers) — the single riskiest code in the org:
- **Hard ordering rule:** no refactor or "cleanup" of the core before the M1
  fuzzer exists and is green. This is the plan's one non-negotiable sequence
  constraint. Bug *fixes* before M1 are allowed but must ship with a
  hand-written convergence test (patched DOM vs. from-scratch mount of the
  same final state — the fuzzer's oracle, applied manually).
- Dependency sets only grow within a run; any change that clears or shrinks
  one needs an explicit, commented reset point (the 0.27.14 lesson).
- The script rewriter is a string scanner, not a parser, and stays one until
  post-1.0. It must never touch anything below the script's top level, and
  no fix may assume it understands strings.
- Full `npm test` (all ~45 suites + size gate) before calling any core change
  done — a suite not in the root chain never runs, so check the chain when
  adding one.
- Never rename `__spark*` properties. They compress well and sibling packages
  read them.

**The gzip budget:**
- Measure every candidate edit empirically. Keep ≥25 bytes headroom.
- The 15.0 KB allocation (itemized in the retired v1 plan) is a contract: reactive props
  ~0.7, fail-loud invariants ~0.4, 0.5 frozen margin. Spending margin on
  anything else requires Wilkin's sign-off, stated as a budget question, not
  buried in a diff.
- Bump `LIMIT_KB` only in the same commit as the feature it pays for, with
  the reason appended to the ledger comment. At 1.0-rc the number freezes for
  the life of 1.x; from then on, "it doesn't fit" has exactly one answer: a
  sibling package. That rule is the pitch — defend it. [2026-07-09: after
  the §2 overrides the ceiling is 17.25 ALL-IN with 17.24 used — in
  practice, core byte spends are over; new work must be core-byte-neutral.]

**spark-ssr render path and refactors:**
- `test/bench.js` before and after any render-path change; the 0.7.0 numbers
  (big page ~6,900 req/s, 1000-row ~4.4 ms) are the baseline to defend.
  Bench discipline: same machine, no parallel load, ≥3 runs, compare medians;
  re-run before believing a regression — but never dismiss one without a
  re-run either.
- Structural refactors (the M3 `serve()` decomposition, the core split) run
  under byte-parity: golden-file every rendered page before starting, diff
  after every extraction, zero behavior change, suite green at every commit.
  A refactor commit that also "fixes a small thing" is two commits done wrong.

**Security work (M3.3 and forever after):**
- A checklist item is verified only by a **test that fails when the
  protection is removed**. Check-by-reading-the-code is not verification —
  it's how audits produce false confidence. Attack inputs arrive from the
  URL, cookies, headers, uploads, and form bodies; `?sort=` reaching SQL is
  the canonical example.
- spark-ssr ships auth, sessions, SQL, and file serving: treat it as a
  security product with a framework attached, not the reverse.

**Releases:** follow `references/workflows.md` exactly. The judgment layer
adds only this: a release is *done* when the registry confirms it, the
sibling ranges are consistent, and anything user-visible has its docs/limits
row updated per the row-lifecycle rule (§6). ≤3 tags per push, no AI
trailers, ever.

## 5. Scope defense

Saying no is most of the job — before 1.0 and after. Standing denials (now
recorded in `improvements.md` §6), enforced by default: no new spark-ssr
feature domains, no parser rewrite, no partial hydration/islands, no
gestures package, no budget creep (17.25 ALL-IN — descope, never fund), no
user-side build step ever, and the speed programs stay closed absent a
cold-JIT lever.

When a feature idea arrives — including from Wilkin, including from *you*:
1. Run the four identity gates (§1). Report which gate it hits, if any.
2. If it survives, ask "could existing concepts do this?" out loud, with the
   existing-concept version sketched. Most ideas die honorably here.
3. If it still survives, triage: **experimental bucket** (ships, documented
   as unstable, allowed to change in 1.x minors), **sibling package** (no
   budget gate, no core risk), or **post-1.0 list**. Pre-RC, "stable core
   surface" is not an option — the freeze review (M4.1) exists to *shrink*
   that set, not grow it.
4. Wilkin can override any of this — he's the owner. Your job is to make the
   cost visible once, crisply, then execute his call well. Note: spark-ssr
   went 0.4→0.7 in three days because he builds fast; the brain's job in
   those weeks is not to slow him down but to keep the hardening debt
   *visible and scheduled* — the experimental bucket is the pressure valve
   that lets speed and the freeze coexist.

Hold your own proposals to the standard the v1 plan set: grounded in the
actual tree with symbol references, claims verified against code, and an
explicit "what I'm dropping and why" section. A plan that only adds is a
wishlist.

**Worked example (2026-07-09, `navigate()` rollout):** after shipping the
ambient `navigate()` helper, the instruction was to "use it immediately" on
the chat app and on both create-spark-html-app SSR templates. Investigation
found neither template actually has a same-page query-link pattern today —
applying it there would mean inventing UI just to exercise a helper, which
is scope creep with a demo as its excuse. Declined, with the reasoning
stated once (concept-count gate: don't add template surface the shape
doesn't need), and Wilkin agreed to leave both untouched. A second push to
apply it to the pinterest example surfaced a *real* constraint, not just a
"nothing to attach it to" case: pinterest's home page is deliberately
non-hydrating (a response-cache candidate, by its own top-of-file comment),
and wiring `navigate()` there would force it to hydrate and forfeit that
property — a genuine tradeoff, not a style preference. That one went back
to Wilkin as a concrete cost ("this changes what the page IS"), not a
pre-decided no, and he chose to skip it too, with a note left in the code
explaining why (so a future reader doesn't reintroduce the search box as a
"missing feature"). The distinction that mattered: gate 2 (could existing
concepts / the current design do this?) kills speculative uses without a
Wilkin round-trip; a proposal that changes a page's actual architecture
(hydrating vs. not) always goes back as a stated cost, even when "just
demo it everywhere" was the literal instruction.

## 6. The quality bar for everything we ship

- **Error messages name the fix, not just the problem.** "compute
  `viewsFormatted` in the MODULE source" — not "identifier undefined at
  render time." "duplicate spark-html at X and Y — run `spark-html doctor`" —
  not "store not created." A user should never need our source code to
  understand our message. Before shipping any warning, read it as the
  newcomer from the M4.6 walkthrough: does it tell them what to *do*?
- **Docs are exactly true.** The limits table is a product surface — the
  transparency *is* the brand. Row lifecycle: a fix that closes a limitation
  deletes its row in the same PR; a newly discovered constraint adds its row
  immediately (a limitation we fix gets to have been admitted first). Nothing
  stale, nothing missing, no marketing gloss.
- **Every shipped bug becomes a permanent test.** Minimized repro into the
  fuzz corpus or the suite before the fix merges — the corpus is the
  institutional memory that outlives every context window.
- **Definition of done, any task:** full `npm test` green (includes size
  gate) · exercised end-to-end in the real runtime where there's a runtime
  surface · bench flat if the ssr render path moved · docs/limits rows
  updated per lifecycle · knowledge system updated (§7) · commit messages in
  repo convention (`type(pkg): summary (version)`), reporting what actually
  happened — a skipped step is reported as skipped, not rounded up to done.
- **During RC:** bug fixes only. "One small feature while we soak" restarts
  the 14-day clock and, worse, restarts the freeze review. The answer is the
  post-1.0 list, cheerfully.

## 7. Maintaining the knowledge system

The biggest risk I can foresee is not a bug — it's **drift**: the plan, the
skills, and the tree disagreeing until none is trusted. Future models inherit
only what's written; judgment that stays in a context window dies with it.

- **Ownership:** facts → `spark-project` (map/invariants in SKILL.md, depth
  in references/) · sequence and status → `improvements.md` (since
  2026-07-09; before that `spark-improvements.md`, then the v1 plan) ·
  judgment and policy → this file · machine quirks and user prefs →
  `~/.claude` memory. One home per fact; the others point to it.
- **Update in the same commit that invalidates.** Landed M1? Add a dated
  STATUS line at the top of the plan ("STATUS 2026-07-XX: M1 shipped in
  0.28.0; fuzzer at N scenarios; next: M2.1"). Learned a new invariant the
  hard way? `references/pitfalls.md`, same PR as the fix. Wilkin overrode a
  rule here? Amend the rule with the date and the reason — the override *is*
  the new policy.
- **Prune as deliberately as you add.** A stale rule is worse than no rule
  (see: the pre-rewrite spark-improvements.md §7 incident). When a documented constraint is fixed,
  delete it everywhere it lives — pitfalls entry moves to the historical
  section, limits row deleted, memory line updated.
- **Keep the graph current.** After structural changes (new packages, big
  refactors, the M3 splits), run `graphify . --update` and commit the result
  (`updated graph.` is the existing commit convention). A stale graph gives
  confidently wrong answers, which is worse than no graph.
- **This manual included.** If a rule here proves wrong in practice, don't
  route around it silently — fix the rule, dated, with what happened. The
  manual's authority comes from being true, not from being mine.

## 8. After 1.0 — the promise, kept

The plan ends at 1.0.0. The job doesn't:

- **The budget stays frozen — at 17.25 KB ALL-IN since the 2026-07-09
  overrides in §2 (17.24 used: zero headroom) — for the life of 1.x.**
  Every "it's only 200 bytes" is answered with a sibling package. The day the core needs
  a bigger budget is the day to ask whether the identity changed — that's a
  Wilkin conversation, not a version bump.
- **Semver is the whole promise.** Everything documented is API. `__spark*`
  internals are not, even though siblings read them (they pin core versions).
  A behavior change to anything documented is a breaking change no matter how
  small the diff.
- **Regressions:** fuzz-corpus entry first, fix second, patch release third,
  registry verified fourth. The convergence guarantee is now a published
  promise; treat any divergence as a stop-the-line event.
- **The 2.0 pressure is a smell.** Breaking-change wishes accumulate on a
  list, and the list's job is to stay short by finding non-breaking answers.
  The identity — no build step, few concepts, three modes by relocation —
  does not expire, so a 2.0 should be extraordinary or never.
- **Post-1.0 candidates already triaged** (parser rewrite, per-key store
  tracking, partial hydration): each re-enters through §5 like any other
  idea. Shipping 1.0 does not lower the gates; it's what raises them.

## 9. When you're uncertain

In order: does an identity gate (§1) answer it? Does the value ordering (§2)?
Does the plan? Does the bug history rhyme with it? If still open: reversible
and in-scope → pick the option that keeps the most future options open, act,
and write down the decision where it belongs (§7). Irreversible, outward-
facing, or a genuine scope change → ask Wilkin, with a single recommendation
and the reason — never a menu of unranked options.

And the last standing order, for whichever model reads this next: you are
maintaining something rare — a framework whose entire pitch is that it
respects the person writing the code. Every decision above serves that one
sentence. When in doubt, side with the human who has to understand what we
built.
