/**
 * Expression evaluation + template interpolation — compile, run, interpolate.
 *
 * Compiling `new Function(...)` is the single most expensive thing the
 * runtime does; compile each unique source string once and cache the result
 * (exprCache / stmtCache / templateCache). The generated functions close
 * over nothing but their arguments, so caching is safe and slashes both CPU
 * cost and CSP `unsafe-eval` churn.
 *
 * Imports the brace/string-aware `skipString` from ./script.js (interpEnd
 * and exprSemicolons need it so braces inside template literals/object
 * literals don't miscount). Imports `warnOnce` + `reportError` from
 * ./index.js — a circular import, safe because these are function
 * declarations (hoisted in ESM's instantiate phase) only ever CALLED at
 * runtime, well after all modules have loaded.
 */
import { skipString } from './script.js';
import { warnOnce, reportError } from './index.js';

// ─── Expression evaluation ─────────────────────────────────────────────
const exprCache = new Map();
export function compileExpr(code) {
  let fn = exprCache.get(code);
  if (fn === undefined) {
    try {
      // The closing brace MUST be on its own line: if `code` ends with a
      // `//` line comment, putting `}` on the same line would comment it out.
      fn = new Function('__scope__', `with(__scope__) {\nreturn (${code})\n}`);
    } catch (e) {
      warnOnce(`c:${code}`, `[spark] Syntax error in expression {${code}} — ${e.message}`);
      fn = () => '';
    }
    exprCache.set(code, fn);
  }
  return fn;
}

const stmtCache = new Map();
export function compileStmt(code) {
  let fn = stmtCache.get(code);
  if (fn === undefined) {
    try {
      // Newlines around `code` so a trailing `//` comment can't eat the `}`.
      fn = new Function('__scope__', 'event', '__val__', `with(__scope__) {\n${code}\n}`);
    } catch (e) {
      warnOnce(`c:${code}`, `[spark] Syntax error in "${code}" — ${e.message}`);
      fn = () => {};
    }
    stmtCache.set(code, fn);
  }
  return fn;
}

// Run an already-compiled expression. Split from evaluate() so hot callers
// (bindings, loop/if/await anchors) can compile ONCE at parse time and skip
// the cache lookup on every patch.
export function runExpr(fn, code, scope) {
  try {
    return fn(scope);
  } catch (e) {
    // A thrown evaluation (e.g. reading a property of undefined) renders as
    // empty — tell the consumer which expression and why, once.
    warnOnce(`e:${code}`, `[spark] Error evaluating {${code}} — ${e.message}. (Rendered as empty. Use {a?.b} for values that may be missing.)`);
    return '';
  }
}

export function evaluate(code, scope) {
  return runExpr(compileExpr(code), code, scope);
}

export function execute(code, scope, event = null, __val__ = undefined, ctx = null) {
  try {
    // `event` is a real parameter — handlers receive it directly, with no
    // proxy writes (which would trigger a re-patch mid-click) and no
    // reliance on the deprecated window.event (absent in Firefox).
    // `__val__` carries the element value for two-way bindings.
    compileStmt(code)(scope, event, __val__);
  } catch (e) {
    // `ctx` is a factory — hot callers (event listeners) pass one so the
    // context object is only built when something actually threw.
    if (ctx) reportError(e, ctx());
    else console.warn(`[spark] Error in "${code}":`, e.message);
  }
}

// Find the `}` that closes the interpolation `{` whose body starts at `start`.
// Brace-aware: respects strings/template-literals (so `${…}` inside a backtick
// doesn't end it) and nested object braces (`{a ? {x:1} : {y:2}}`). Returns the
// index of the closing brace, or -1 if unbalanced.
export function interpEnd(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { if (--depth === 0) return i; i++; continue; }
    i++;
  }
  return -1;
}

// Convert `;` to `,` outside of strings so statement-like expressions
// (e.g. `a = 1; b = 2`) work with compileExpr's `return (...)` wrapper.
export function exprSemicolons(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(code, i);
      out += code.slice(i, end);
      i = end;
    } else if (c === ';') {
      out += ',';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Parse a template into a flat list of literal strings and { code } exprs,
// cached per template string. The old regex (`\{([^}]+)\}`) broke on any `}`
// inside an expression (template literals, object literals); this doesn't, and
// caching the parse makes repeated patches cheaper than re-scanning.
const templateCache = new Map();
export function parseTemplate(template) {
  let segs = templateCache.get(template);
  if (segs) return segs;
  segs = [];
  let i = 0;
  let lit = '';
  const flush = () => { if (lit) { segs.push(lit); lit = ''; } };
  while (i < template.length) {
    const c = template[i];
    // Escape: `\{` / `\}` render a LITERAL brace (so you can write `{` in
    // prose without it being read as an interpolation). Entities don't work —
    // the browser decodes them before Spark sees the text — but a backslash
    // survives. For code blocks, prefer the spark-ignore attribute.
    if (c === '\\' && (template[i + 1] === '{' || template[i + 1] === '}')) {
      lit += template[i + 1];
      i += 2;
      continue;
    }
    if (c === '{') {
      const end = interpEnd(template, i + 1);
      if (end === -1) { lit += c; i++; continue; } // unbalanced → literal
      flush();
      const code = template.slice(i + 1, end).trim().replace(/(?:;\s*)+$/, '');
      if (code) {
        const cleaned = exprSemicolons(code);
        // Compile now — the parse is cached per template, so every later
        // interpolation of this segment skips the expr-cache lookup too.
        segs.push({ code: cleaned, fn: compileExpr(cleaned) });
      }
      i = end + 1;
      continue;
    }
    lit += c;
    i++;
  }
  flush();
  templateCache.set(template, segs);
  return segs;
}

export function interpolate(template, scope) {
  // Fast path: no braces and no backslash-escape → nothing to do.
  if (!template.includes('{') && !template.includes('\\')) return template;
  let out = '';
  for (const s of parseTemplate(template)) {
    if (typeof s === 'string') {
      out += s;
    } else {
      // s.fn was compiled at parse time — skip the expr-cache lookup.
      const v = runExpr(s.fn, s.code, scope);
      out += v == null ? '' : String(v);
    }
  }
  return out;
}

// Evaluate a prop that is a single whole-value {expr} — preserve the real
// type (array/object/function) instead of stringifying. A prop value that is
// exactly one {expr} evaluates directly; otherwise it's a string-
// interpolated prop evaluated through interpolate().
//
// The whole-value path exists because interpolate concatenates through
// String(v): for an array of objects that produces the useless
// "[object Object],[object Object],…" (each element's own toString, joined
// by Array.prototype.toString's commas), and for a function, its own source
// text — both silently destroying the prop's real type, which then fails
// coerce()'s JSON.parse and is passed to the component as garbage. Passing
// an array/object/function as an import prop is an entirely ordinary thing
// to want (a child component rendering a parent's data, or a callback prop),
// so this must preserve the value.
export function evalPropValue(template, scope) {
  const segs = parseTemplate(template);
  if (segs.length === 1 && typeof segs[0] === 'object') return runExpr(segs[0].fn, segs[0].code, scope);
  return interpolate(template, scope);
}