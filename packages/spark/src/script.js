/**
 * Script scanner + rewriter — the "not a parser" part of spark-html.
 *
 * analyzeScript(rawCode) rewrites a component <script> so top-level state
 * becomes reactive: declarations become bare assignments (computed via
 * braceDepths, which is brace/string/comment aware), $: reactive statements
 * are lifted out, and ESM imports are replayed as dynamic __import__() calls.
 * This module holds ONLY the string-scanning machinery; compileScript runs
 * the rewritten body and makeImporter resolves specifiers against the
 * component file's URL. None of this touches the reactivity core or DOM.
 *
 * Stays a string scanner, not a real parser, until post-1.0 — never inline
 * executable-code-looking strings in a component <script> (the scanner is
 * not string-aware where it doesn't need to be for correctness).
 */

// ─── `$:` extraction (multi-line aware) ───────────────────────────────
const OPEN = '([{';
const CLOSE = ')]}';
// operators that, at a line's end OR a line's start, mean "this continues".
const CONT_END = '+-*/%&|^<>=?:.,';
const CONT_START = CONT_END + '([`';

// Advance past a string/template literal starting at `i`; returns the index
// just after its closing quote. Handles escapes and `${…}` interpolation.
export function skipString(src, i) {
  const q = src[i++];
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === q) return i + 1;
    if (q === '`' && c === '$' && src[i + 1] === '{') {
      i += 2;
      let d = 1;
      while (i < src.length && d > 0) {
        const k = src[i];
        if (k === '\\') { i += 2; continue; }
        if (k === '"' || k === "'" || k === '`') { i = skipString(src, i); continue; }
        if (k === '{') d++;
        else if (k === '}') d--;
        i++;
      }
      continue;
    }
    if (q !== '`' && c === '\n') return i; // unterminated normal string — bail
    i++;
  }
  return i;
}

// The {/} nesting depth at every position in `src` (strings/comments
// skipped so braces inside them don't miscount). Lets the declaration
// rewrites below apply ONLY at the script's own top level: a `let`/`const`/
// `function` inside a nested block (a helper function's body, an if/for
// block) must stay a true local — rewriting it into a bare assignment turns
// it into an implicit write to the reactive scope proxy. If that "local" is
// both read and written by a single expression evaluation (an entirely
// ordinary pattern — a helper computing an intermediate value it uses), the
// expression's own dependency tracking picks up a dependency on it, and
// since evaluating the expression ALSO writes it, every evaluation
// re-triggers itself: a genuine infinite patch loop, not just a stale read.
export function braceDepths(src) {
  const depths = new Int32Array(src.length + 1);
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const j = skipString(src, i);
      for (let k = i; k < j && k < src.length; k++) depths[k] = depth;
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const s = i;
      while (i < src.length && src[i] !== '\n') i++;
      for (let k = s; k < i; k++) depths[k] = depth;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const s = i;
      i += 2;
      while (i < src.length && !(src[i - 1] === '*' && src[i] === '/')) i++;
      i++;
      for (let k = s; k < i && k < src.length; k++) depths[k] = depth;
      continue;
    }
    depths[i] = depth;
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  depths[src.length] = depth;
  return depths;
}

// Names declared by `let/const/var`, INCLUDING comma chains
// (`let a = '', b = '', c`). The old code seeded only the first name, so the
// rest leaked to the global scope (and weren't reactive). Destructuring
// (`let {a} = …` / `let [a] = …`) is intentionally skipped — those stay local.
export function extractDeclaredNames(code) {
  const names = [];
  const re = /(?:^|[\n;{}])\s*(?:let|const|var)\s+(?=[a-zA-Z_$])/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    let i = m.index + m[0].length; // at the first declarator name
    let depth = 0;
    let expectName = true;
    let lastReal = '';
    while (i < code.length) {
      const c = code[i];
      if (c === '"' || c === "'" || c === '`') { i = skipString(code, i); lastReal = '"'; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; lastReal = c; i++; continue; }
      if (c === ')' || c === ']' || c === '}') { depth--; lastReal = c; i++; continue; }
      if (depth === 0) {
        if (c === ';') break;
        if (c === '\n') { if (lastReal === ',') { i++; continue; } break; }
        if (c === ',') { expectName = true; lastReal = ','; i++; continue; }
        if (c === '=') { expectName = false; lastReal = '='; i++; continue; }
        if (expectName && /[a-zA-Z_$]/.test(c)) {
          let j = i;
          while (j < code.length && /[\w$]/.test(code[j])) j++;
          names.push(code.slice(i, j));
          expectName = false; lastReal = 'x'; i = j; continue;
        }
        if (!/\s/.test(c)) lastReal = c;
      }
      i++;
    }
  }
  return names;
}

// Find the end index of a `$:` statement whose body begins at `start`.
// Continuation checks must look at CODE, not raw text: a comment ending in
// '.' (or a next line that begins with '//') must not read as an operator —
// that would silently absorb the following statement into the `$:` body.
export function reactiveStatementEnd(src, start) {
  let i = start;
  let depth = 0;
  let last = ''; // last significant char (strings count as one, comments none)
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); last = '"'; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (OPEN.includes(c)) { depth++; last = c; i++; continue; }
    if (CLOSE.includes(c)) { if (depth === 0) return i; depth--; last = c; i++; continue; }
    if (depth === 0) {
      if (c === ';') return i;
      if (c === '\n') {
        if (last && CONT_END.includes(last)) { i++; continue; }
        // Peek the next significant char — past whitespace, blank lines, and
        // comments. ".method" chains, "? :" ternaries, binary operators on
        // the next code line mean "this continues".
        let k = i + 1;
        while (k < src.length) {
          if (/\s/.test(src[k])) { k++; continue; }
          if (src[k] === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k++; continue; }
          if (src[k] === '/' && src[k + 1] === '*') { k += 2; while (k < src.length && !(src[k] === '*' && src[k + 1] === '/')) k++; k += 2; continue; }
          break;
        }
        const next = src[k];
        if (next && CONT_START.includes(next)) { i++; continue; }
        return i;
      }
      if (!/\s/.test(c)) last = c;
    }
    i++;
  }
  return i;
}

// Pull every top-level `import` statement AND every `$:` reactive statement
// out of the script in ONE string/comment-aware pass, blanking both to
// newlines so line numbers stay put. (These were two near-identical
// scanners; merged for size and a single scan.) `import(` (dynamic) and
// `import.meta` are left alone, as is anything inside strings, comments, or
// — for imports — nested braces.
export function extractTopLevel(src) {
  const imports = [];
  const reactiveStmts = [];
  let out = '';
  let i = 0;
  let depth = 0;
  // At a statement boundary: start of script, or after ; { } newline.
  const atBoundary = () => {
    let j = out.length - 1;
    while (j >= 0 && (out[j] === ' ' || out[j] === '\t')) j--;
    const prev = j < 0 ? '\n' : out[j];
    return prev === '\n' || prev === ';' || prev === '{' || prev === '}';
  };
  const blank = (end) => { out += src.slice(i, end).replace(/[^\n]/g, ''); i = end; };
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { const j = skipString(src, i); out += src.slice(i, j); i = j; continue; }
    if (c === '/' && src[i + 1] === '/') { const s = i; while (i < src.length && src[i] !== '\n') i++; out += src.slice(s, i); continue; }
    if (c === '/' && src[i + 1] === '*') { const s = i; i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; out += src.slice(s, i); continue; }
    if (c === '$' && src[i + 1] === ':' && atBoundary()) {
      const end = reactiveStatementEnd(src, i + 2);
      const stmt = src.slice(i + 2, end).trim().replace(/;\s*$/, '');
      if (stmt) reactiveStmts.push(stmt);
      blank(end);
      continue;
    }
    if (depth === 0 && c === 'i' && src.startsWith('import', i) && !/[\w$]/.test(src[i + 6] || '') && atBoundary()) {
      let k = i + 6;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] !== '(' && src[k] !== '.') { // not import() / import.meta
        const parsed = parseImportStatement(src, i);
        if (parsed) {
          imports.push(parsed);
          blank(parsed.end);
          continue;
        }
      }
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    out += c;
    i++;
  }
  return { code: out, imports, reactiveStmts };
}

// ─── JS imports inside component scripts ───────────────────────────────
// Parse ONE `import …` statement starting at `start` (which points at the
// `import` keyword). Returns { end, spec, defaultName, nsName, named } or
// null when malformed — in which case the statement is left in the code and
// surfaces as a normal syntax error.
export function parseImportStatement(src, start) {
  let i = start + 6; // past 'import'
  let clause = '';
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      if (depth === 0) break; // the module specifier string
      const j = skipString(src, i); // a string import name inside { }
      clause += src.slice(i, j);
      i = j;
      continue;
    }
    if (c === ';' && depth === 0) return null; // no specifier — malformed
    if (c === '{') depth++;
    else if (c === '}') depth--;
    clause += c;
    i++;
  }
  if (i >= src.length) return null;
  const qEnd = skipString(src, i);
  if (qEnd > src.length || src[qEnd - 1] !== src[i]) return null; // unterminated
  const spec = src.slice(i + 1, qEnd - 1);
  i = qEnd;
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  if (src[i] === ';') i++;

  clause = clause.replace(/\bfrom\s*$/, '').trim();
  let defaultName = null;
  let nsName = null;
  const named = []; // [objectKeySource, localName]
  let rest = clause;
  if (/^[a-zA-Z_$]/.test(rest)) {
    const dm = rest.match(/^([a-zA-Z_$][\w$]*)\s*(?:,\s*)?/);
    defaultName = dm[1];
    rest = rest.slice(dm[0].length);
  }
  if (rest.startsWith('*')) {
    const nm = rest.match(/^\*\s*as\s+([a-zA-Z_$][\w$]*)\s*$/);
    if (!nm) return null;
    nsName = nm[1];
  } else if (rest.startsWith('{')) {
    const close = rest.lastIndexOf('}');
    if (close === -1) return null;
    const inner = rest.slice(1, close);
    // Entries: `a`, `a as b`, `default as b`, `"str-name" as b`.
    const partRe = /(['"])([\s\S]*?)\1\s*as\s+([a-zA-Z_$][\w$]*)|([a-zA-Z_$][\w$]*)(?:\s+as\s+([a-zA-Z_$][\w$]*))?/g;
    let pm;
    while ((pm = partRe.exec(inner)) !== null) {
      if (!pm[0].trim()) { partRe.lastIndex++; continue; }
      if (pm[2] !== undefined) named.push([JSON.stringify(pm[2]), pm[3]]);
      else named.push([pm[4], pm[5] || pm[4]]);
    }
  } else if (rest) {
    return null; // something we don't recognize
  }
  return { end: i, spec, defaultName, nsName, named };
}

// Generate the replay statement for one parsed import. Assignments resolve
// through the with() scope proxy (the locals are seeded), so imported values
// land in component state like any other declaration.
export function importAssign(imp) {
  const spec = JSON.stringify(imp.spec);
  const parts = [];
  if (imp.defaultName) parts.push(`"default": ${imp.defaultName}`);
  for (const [key, local] of imp.named) parts.push(`${key}: ${local}`);
  if (imp.nsName) {
    let s = `${imp.nsName} = await __import__(${spec});`;
    if (parts.length) s += ` ({ ${parts.join(', ')} } = ${imp.nsName});`;
    return s;
  }
  if (parts.length) return `({ ${parts.join(', ')} } = await __import__(${spec}));`;
  return `await __import__(${spec});`;
}

// The per-component module loader. Relative (`./x.js`, `../x.js`) and
// root-absolute (`/x.js`) specifiers resolve against the COMPONENT FILE's
// URL — not the page — so a module can sit next to its component. Bare
// specifiers pass through untouched for the browser's import maps. The
// `__SPARK_IMPORT__` global is the seam spark-prerender (and tests) use to
// load modules from disk instead.
export function makeImporter(componentEl) {
  return (spec) => {
    const hook = globalThis.__SPARK_IMPORT__;
    if (hook) return Promise.resolve(hook(spec, componentEl.__sparkImportPath || null));
    let resolved = spec;
    if (/^\.{0,2}\//.test(spec)) {
      const base = new URL(componentEl.__sparkImportPath || '.', document.baseURI || location.href);
      resolved = new URL(spec, base).href;
    }
    return import(resolved);
  };
}

// ─── Script analysis + compile caches ──────────────────────────────────
// Everything derived from a component's <script> SOURCE — the declaration
// rewrites, seeded names, `$:` statements, prop names, imports — is a pure
// function of that string. A list of 50 identical card components used to
// re-run the whole regex/tokenizer pipeline and recompile the script 50
// times; now both are computed once per distinct source.
const analysisCache = new Map();
export function analyzeScript(rawCode) {
  let a = analysisCache.get(rawCode);
  if (a) return a;
  // Normalize line endings + strip comments so the declaration regexes
  // behave identically on every OS/editor. (CRLF was a real-world bug.)
  let code = rawCode.replace(/\r\n?/g, '\n');
  // `export let x = …` marks a PROP (overridable from the import
  // placeholder). Record prop names, then treat as a normal declaration.
  const propNames = new Set();
  code = code.replace(
    /(^|[\n;{}])(\s*)export\s+(let|const|var)\s+([a-zA-Z_$][\w$]*)/g,
    (_, before, space, kw, name) => {
      propNames.add(name);
      return `${before}${space}${kw} ${name}`;
    },
  );
  // JS imports (they can't be props) + `$: …` reactive statements, lifted
  // out in one multi-line-aware pass; `$:` statements re-run on each change.
  const extracted = extractTopLevel(code);
  code = extracted.code;
  const imports = extracted.imports;
  const reactiveStmts = extracted.reactiveStmts;

  const codeNoComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  // Every name to seed on the scope so the proxy `has` trap claims it
  // inside the with() block.
  const seedNames = [];
  const funcRe =
    /(?:^|[\n;{}])\s*(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g;
  let m;
  for (const n of extractDeclaredNames(codeNoComments)) seedNames.push(n);
  while ((m = funcRe.exec(codeNoComments)) !== null) seedNames.push(m[1]);
  // `$: x = …` implicitly declares x
  for (const stmt of reactiveStmts) {
    const t = stmt.match(/^([a-zA-Z_$][\w$]*)\s*=[^=]/);
    if (t) seedNames.push(t[1]);
  }
  // Imported locals are scope keys too.
  for (const imp of imports) {
    if (imp.defaultName) seedNames.push(imp.defaultName);
    if (imp.nsName) seedNames.push(imp.nsName);
    for (const [, local] of imp.named) seedNames.push(local);
  }

  // Rewrite declarations to bare assignments so they hit the proxy — but
  // ONLY at depth 0 (the script's own top level). A nested function
  // declaration (inside another function's body) is a true local; rewriting
  // IT too would leak its name into the reactive scope the same way a
  // nested let/const would (see braceDepths above).
  let depths = braceDepths(code);
  let rewritten = code.replace(
    /(^|[\n;{}])(\s*)(async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    (m, before, space, async_ = '', name, offset) =>
      depths[offset + before.length] === 0
        ? `${before}${space}${name} = ${async_}function ${name}(`
        : m,
  );
  // Strip the `let`/`const`/`var` KEYWORD from declarations that start with an
  // identifier (single or comma-chained), turning `let a = 1, b = 2` into
  // `a = 1, b = 2` so every name hits the proxy. Destructuring (`let {…}` /
  // `let [@…]`) is left intact — it stays block-local, as documented. Depth
  // 0 only — a nested declaration must stay a true local too (see above).
  depths = braceDepths(rewritten);
  rewritten = rewritten.replace(
    /(^|[\n;{}])(\s*)(?:let|const|var)\s+(?=[a-zA-Z_$])/g,
    (m, before, space, offset) =>
      depths[offset + before.length] === 0 ? `${before}${space}` : m,
  );
  // Hoist the import replays above the rest of the script, in source order —
  // ESM semantics: imports evaluate first, wherever they were written.
  if (imports.length) {
    rewritten = imports.map(importAssign).join('\n') + '\n' + rewritten;
  }

  a = { rewritten, seedNames, propNames, reactiveStmts, hasImports: imports.length > 0 };
  analysisCache.set(rawCode, a);
  return a;
}

// Compile a rewritten component script once per distinct source; every
// instance of the same component shares the compiled function (it closes
// over nothing — scope and importer arrive as arguments).
const scriptCache = new Map();
export function compileScript(body, isAsync) {
  const key = (isAsync ? 'a:' : 's:') + body;
  let fn = scriptCache.get(key);
  if (!fn) {
    // Newline before `}` so a script ending in a `//` comment still closes.
    fn = isAsync
      ? new Function('__scope__', '__import__', `return (async () => { with(__scope__) {\n${body}\n} })()`)
      : new Function('__scope__', `with(__scope__) {\n${body}\n}`);
    scriptCache.set(key, fn);
  }
  return fn;
}