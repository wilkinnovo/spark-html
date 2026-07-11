// Shared terser config — build-dist.mjs ships these bytes and size-check.mjs
// gates them; the two must never diverge (the G1 same-artifact rule).
//
// mangle.properties is the round-5 funding harvest (the "prop-mangle
// reserve" measured at post-spark-speed-pro-max P0): an EXPLICIT
// include-list of internal-only field names. Curation rules, in order:
//   - never `__spark*` (siblings read those at runtime — invariant #2);
//   - never a name the core also reads on DOM/std objects (form, name,
//     key, set, code, evt, item, nodes, scope, raw...);
//   - never a public-API return field (parseSFC's markup/script/style) or
//     a user-supplied hook name (lifecycle's enter/leave);
//   - fn.__fast/__row/__keys/__src/__fastable are expression-pipeline
//     expandos on function objects — internal, not part of the __spark*
//     sibling contract.
// Every addition must be re-audited against those rules AND verified by
// the dist-exercising gates (e2e templates, krausest harness) — the unit
// suite imports src and cannot catch a bad rename.
export const terserOpts = {
  module: true,
  ecma: 2020,
  compress: { passes: 3, ecma: 2020, hoist_funs: true },
  mangle: {
    properties: {
      // builtins:true — several list names collide with DOM/std props terser
      // would otherwise protect (scope, mode, kind, item, key, code, nodes).
      // The curation rule above ALREADY requires auditing that the core never
      // reads a listed name on a foreign object, which is the same guarantee.
      builtins: true,
      // `item` is NOT listed: makeLoopProto reads it DYNAMICALLY
      // (this.__b[k] with k='item') — a renamed dot-write would never meet
      // the string read. Any name accessed through a runtime string is
      // ineligible, however internal.
      // `scope` is NOT listed: it is a METHOD of the exported `inspect`
      // API (index.js export line) — public surface, consumed by
      // spark-html-test-utils and devtools. Same rule for any field of an
      // exported object (parseSFC's markup/script/style, inspect's deps).
      // round-6 additions (beat-1-20-speed.md S0): subscribers — internal
      // field of store entries; the `stores` Map export never leaves the
      // bundle (not on the public API line) and no sibling reads it.
      regex: /^(?:dirtyKeys|dirtyItems|dirtyMode|rowForce|sink|fnExpr|writeStmt|eventName|realAttr|staticClass|oldIdx|stay|handlers|binds|plan|kind|expr|mode|live|tpl|code|block|spec|defaultName|nsName|named|imports|reactiveStmts|key|raw|nodes|ext|evt|state|proxy|subscribers|__fast|__fastable|__row|__keys|__src)$/,
    },
  },
};
