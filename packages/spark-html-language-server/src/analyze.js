/**
 * spark-html-language-server — component analyzer.
 *
 * Parses a single-file Spark component (.html) the same way the runtime does
 * (regex + string scanning, no AST) and produces everything the LSP features
 * need: declarations with offsets, template references, import placeholders,
 * each/await scopes, and diagnostics.
 *
 * All positions are absolute character offsets into the original text; the
 * server converts them to LSP line/character positions.
 *
 * spark-ssr aware: a file with a <spark-ssr> tag has its inferred page data
 * and ambient identifiers (session, path, flash, api_create, …) added to
 * scope, and undeclared handlers referenced from the template are assumed
 * synthesized rather than flagged (see analyzeSSR below).
 */

// Identifiers never flagged as "undefined" — JS/browser globals plus the
// builtins Spark injects into every component scope (see spark-html/globals).
export const KNOWN_GLOBALS = new Set([
  // Spark component builtins
  'useStore', 'onMount', 'props', 'await',
  // literals & keywords that the identifier regex can catch
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'new', 'typeof', 'instanceof', 'in', 'of', 'this', 'void', 'delete',
  'if', 'else', 'return', 'function', 'async', 'arguments',
  // ubiquitous browser/JS globals
  'window', 'document', 'console', 'Math', 'JSON', 'Date', 'Number',
  'String', 'Boolean', 'Array', 'Object', 'Promise', 'Map', 'Set',
  'RegExp', 'Error', 'Intl', 'Symbol', 'BigInt', 'Reflect', 'Proxy',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'structuredClone',
  'fetch', 'localStorage', 'sessionStorage', 'navigator', 'location',
  'history', 'alert', 'confirm', 'prompt', 'crypto', 'performance',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'AbortController',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'Audio', 'Image',
  'WebSocket', 'Notification', 'IntersectionObserver', 'ResizeObserver',
  'MutationObserver', 'matchMedia', 'getComputedStyle', 'globalThis',
]);

const IDENT = /[A-Za-z_$][\w$]*/g;

// ── spark-ssr awareness ─────────────────────────────────────────────────────
// spark-ssr (packages/spark-ssr) turns a page's <spark-ssr> block into inferred
// data, and synthesizes handlers/ambient helpers for interactive pages. Any
// file containing a <spark-ssr> tag is treated as an SSR page: its named data
// becomes a declared template binding, its ambient identifiers are never
// flagged as undefined, and undeclared `on*={handler}` refs are assumed to be
// auto-synthesized (see spark-ssr's README, "Page scripts — ambient helpers").
export const SSR_AMBIENT_GLOBALS = new Set([
  // ambient on every page (template) — request/response context
  'session', 'path', 'flash', 'errors', 'values',
  // ambient helpers synthesized into an interactive page's client script
  'api_create', 'api_update', 'api_delete', 'refresh',
]);

// Same table/singular fuzzy-match spark-ssr's dataPlan() uses (parse.js) —
// `table="posts"` also satisfies a template that reads the single row as
// `{post.title}` on a `[slug].html` page.
const singular = (s) => (s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('s') ? s.slice(0, -1) : s);

// Named data a <spark-ssr> block/tag declares:
//   <spark-ssr table="todos" live />          → `todos` (+ singular `todo`)
//   <spark-ssr> posts = SELECT … </spark-ssr> → `posts` (+ singular `post`)
//   <spark-ssr> GET /api/x → posts = … </spark-ssr>  → same, named-endpoint form
// A bare `METHOD path → SELECT …` (no `name =`) answers the endpoint directly
// and declares no page var.
function analyzeSSR(text) {
  const vars = new Set();
  let isSSRPage = false;
  const add = (name) => { vars.add(name); vars.add(singular(name)); };
  const tagRe = /<spark-ssr\b([^>]*?)(\/)?>/gi;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    isSSRPage = true;
    const tableM = m[1].match(/\btable\s*=\s*"([^"]*)"/);
    if (tableM) add(tableM[1]);
    if (m[2]) continue; // self-closing — no block body
    const bodyStart = m.index + m[0].length;
    const closeIdx = text.slice(bodyStart).search(/<\/spark-ssr\s*>/i);
    const body = closeIdx === -1 ? text.slice(bodyStart) : text.slice(bodyStart, bodyStart + closeIdx);
    for (const line of body.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      const lm = l.match(/^(?:[A-Z]+\s+(?:\S+\s+)?(?:→|->)\s*)?([A-Za-z_$][\w$]*)\s*=\s*.+$/);
      if (lm) add(lm[1]);
    }
  }
  return { isSSRPage, vars };
}

// ── masking helpers ────────────────────────────────────────────────────────
// Replace comments and string/template-literal contents with spaces so regex
// scans can't match inside them — same length, so offsets stay valid.

export function maskJs(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const two = code.slice(i, i + 2);
    if (two === '//') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === c) break;
        j++;
      }
      const stop = Math.min(j + 1, n);
      out += c + ' '.repeat(Math.max(0, stop - i - 2)) + (stop - i >= 2 ? c : '');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Index of the `}` matching the `{` at openIdx (quote-aware), or -1.
function matchingBrace(text, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// ── script extraction ──────────────────────────────────────────────────────

function findScript(text) {
  // The component's script is the first <script> without src=.
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const start = m.index + m[0].length;
    const end = text.indexOf('</script', start);
    return { start, end: end === -1 ? text.length : end, attrs: m[1] };
  }
  return null;
}

function blankRange(chars, start, end) {
  for (let i = start; i < end && i < chars.length; i++) {
    if (chars[i] !== '\n') chars[i] = ' ';
  }
}

// Template text = source minus <script>/<style> contents minus spark-ignore
// subtrees (never patched by Spark, so never analyzed).
function templateMask(text, script) {
  const chars = [...text];
  if (script) blankRange(chars, script.start - 8, script.end); // include "<script>" tag itself
  const styleRe = /<style\b[^>]*>/gi;
  let m;
  while ((m = styleRe.exec(text)) !== null) {
    const close = text.indexOf('</style', m.index);
    blankRange(chars, m.index, close === -1 ? text.length : close + 8);
  }
  // spark-ignore: blank from the opening tag to the matching close tag.
  const ignoreRe = /<([a-zA-Z][\w-]*)\b[^>]*\bspark-ignore[\s>=/]/g;
  while ((m = ignoreRe.exec(text)) !== null) {
    const tag = m[1].toLowerCase();
    let depth = 1;
    const tagRe = new RegExp(`</?${tag}\\b`, 'gi');
    tagRe.lastIndex = m.index + m[0].length;
    let end = text.length;
    let t;
    while ((t = tagRe.exec(text)) !== null) {
      depth += t[0][1] === '/' ? -1 : 1;
      if (depth === 0) { end = text.indexOf('>', t.index) + 1 || text.length; break; }
    }
    blankRange(chars, m.index, end);
  }
  return chars.join('');
}

// Content range of the <template …> whose open tag starts at tagIdx.
function templateContentRange(text, tagIdx) {
  const open = text.indexOf('>', tagIdx);
  if (open === -1) return null;
  let depth = 1;
  const re = /<\/?template\b/gi;
  re.lastIndex = open;
  let m;
  while ((m = re.exec(text)) !== null) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return { start: open + 1, end: m.index };
  }
  return { start: open + 1, end: text.length };
}

// ── expression scanning ────────────────────────────────────────────────────

// Identifiers referenced by a JS expression (masked for strings), each with
// its absolute offset. Skips property accesses (`.foo`, `?.foo`), object keys
// (`{ foo: … }`), and locals declared by arrow params inside the expression.
export function exprRefs(expr, baseOffset) {
  const masked = maskJs(expr);
  const locals = new Set();
  // arrow params: `e =>` and `(a, b) =>`
  for (const m of masked.matchAll(/(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/g)) {
    for (const p of (m[1] ?? m[2] ?? '').split(',')) {
      const name = p.trim().match(/^[A-Za-z_$][\w$]*/);
      if (name) locals.add(name[0]);
    }
  }
  const refs = [];
  let m;
  IDENT.lastIndex = 0;
  while ((m = IDENT.exec(masked)) !== null) {
    const name = m[0];
    const before = masked.slice(0, m.index).match(/[\s\S]?$/)[0];
    const prev = masked.slice(0, m.index).replace(/\s+$/, '').slice(-2);
    if (before === '.' || prev.endsWith('.') ) continue;      // property access
    const after = masked.slice(m.index + name.length).match(/^\s*./)?.[0]?.trim();
    if (after === ':' && !prev.endsWith('?')) continue;        // object key / label
    if (locals.has(name) || KNOWN_GLOBALS.has(name)) continue;
    refs.push({ name, offset: baseOffset + m.index });
  }
  return refs;
}

// ── script analysis ────────────────────────────────────────────────────────

function analyzeScript(text, script) {
  const declarations = new Map(); // name -> { kind, offset }
  const imports = [];
  const diagnostics = [];
  if (!script) return { declarations, imports, diagnostics, refs: [] };

  const code = text.slice(script.start, script.end);
  const masked = maskJs(code);
  const declare = (name, kind, offset) => {
    if (!declarations.has(name)) declarations.set(name, { kind, offset: script.start + offset });
  };

  // JS imports (Spark replays them as dynamic import()).
  const importRe = /(^|[\n;])\s*import\s+(?:([^'"\n;]+?)\s+from\s+)?(['"])([^'"\n]*)\3/g;
  let m;
  while ((m = importRe.exec(masked)) !== null) {
    const clause = m[2] || '';
    const spec = code.slice(m.index, m.index + m[0].length).match(/['"]([^'"]*)['"]/)?.[1] ?? '';
    const entry = { spec, locals: [], start: script.start + m.index, end: script.start + m.index + m[0].length };
    const clauseBase = m.index + m[0].indexOf(clause);
    const named = clause.match(/\{([^}]*)\}/);
    let rest = clause;
    if (named) {
      for (const part of named[1].split(',')) {
        const asM = part.match(/^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/);
        if (!asM) continue;
        const local = asM[2] || asM[1];
        const off = clauseBase + clause.indexOf(local, named.index);
        entry.locals.push({ name: local, offset: script.start + off });
      }
      rest = clause.slice(0, named.index) + clause.slice(named.index + named[0].length);
    }
    const ns = rest.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (ns) entry.locals.push({ name: ns[1], offset: script.start + clauseBase + rest.indexOf(ns[1]) });
    const def = rest.replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, '').match(/[A-Za-z_$][\w$]*/);
    if (def) entry.locals.push({ name: def[0], offset: script.start + clauseBase + clause.indexOf(def[0]) });
    for (const l of entry.locals) declare(l.name, 'import', l.offset - script.start + 0);
    for (const l of entry.locals) declarations.get(l.name).offset = l.offset;
    imports.push(entry);
  }

  // `export let x` = prop; plain let/const/var = state (comma chains too).
  const declRe = /(^|[\n;{}])\s*(export\s+)?(let|const|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(masked)) !== null) {
    const name = m[4];
    const offset = m.index + m[0].length - name.length;
    declare(name, m[2] ? 'prop' : 'let', offset);
    // comma-chained names at the same nesting depth: `let a = 1, b = 2`
    let i = m.index + m[0].length;
    let depth = 0;
    while (i < masked.length) {
      const c = masked[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (--depth < 0) break; }
      else if ((c === ';' || c === '\n') && depth === 0) break;
      else if (c === ',' && depth === 0) {
        const next = masked.slice(i + 1).match(/^\s*([A-Za-z_$][\w$]*)/);
        if (next) declare(next[1], m[2] ? 'prop' : 'let', i + 1 + next[0].length - next[1].length);
      }
      i++;
    }
  }

  // function declarations
  const funcRe = /(^|[\n;{}])\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = funcRe.exec(masked)) !== null) {
    declare(m[2], 'function', m.index + m[0].length - m[2].length);
  }

  // `$: x = …` implicitly declares x
  const reactiveRe = /(^|\n)\s*\$:\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  while ((m = reactiveRe.exec(masked)) !== null) {
    declare(m[2], 'reactive', m.index + m[0].indexOf(m[2]));
  }

  // Syntax check: what the runtime would execute. `$:` is a valid JS label;
  // `import`/`export` are not valid inside Function, so strip them the way
  // the runtime lifts them out.
  let checkable = code;
  for (const imp of imports) {
    const s = imp.start - script.start;
    const e = imp.end - script.start;
    checkable = checkable.slice(0, s) + checkable.slice(s, e).replace(/\S/g, ' ') + checkable.slice(e);
  }
  checkable = checkable.replace(/(^|[\n;{}])(\s*)export(\s+)(?=let|const|var)/g, '$1$2      $3');
  try {
    new Function(checkable); // eslint-disable-line no-new-func
  } catch (e) {
    let offset = script.start;
    const loc = e.stack?.match(/<anonymous>:(\d+):(\d+)/);
    if (loc) {
      // new Function() prepends two lines before the body.
      const line = Math.max(0, Number(loc[1]) - 3);
      const lines = code.split('\n');
      offset = script.start + lines.slice(0, line).reduce((s, l) => s + l.length + 1, 0) + Number(loc[2]) - 1;
    }
    diagnostics.push({
      start: offset,
      end: Math.min(offset + 1, script.end),
      severity: 1,
      message: `Script error: ${e.message}`,
      code: 'script-syntax',
    });
  }

  // References inside the script (for unused-import detection): identifiers
  // outside each import's own statement.
  const refs = [];
  IDENT.lastIndex = 0;
  while ((m = IDENT.exec(masked)) !== null) {
    const abs = script.start + m.index;
    if (imports.some((imp) => abs >= imp.start && abs < imp.end)) continue;
    if (masked[m.index - 1] === '.') continue;
    refs.push({ name: m[0], offset: abs });
  }

  return { declarations, imports, diagnostics, refs };
}

// ── template analysis ──────────────────────────────────────────────────────

function analyzeTemplate(text, tpl) {
  const refs = [];          // { name, offset, scopes: [names visible here] }
  const eachBlocks = [];    // { itemVar, indexVar, arrayExpr, attrOffset, content: {start,end}, hasKey }
  const awaitBlocks = [];   // { content: {start,end} }
  const importTags = [];    // { path, valueStart, valueEnd, tagStart, tagEnd }
  let m;

  // <template each="item, i in expr" key="…">
  const eachRe = /<template\b[^>]*\beach\s*=\s*"([^"]*)"/gi;
  while ((m = eachRe.exec(tpl)) !== null) {
    const spec = m[1];
    const specStart = m.index + m[0].length - spec.length - 1;
    const parts = spec.match(/^(\w+)(?:\s*,\s*(\w+))?\s+in\s+([\s\S]+)$/);
    const tagEnd = tpl.indexOf('>', m.index);
    const tag = tpl.slice(m.index, tagEnd === -1 ? tpl.length : tagEnd);
    const content = templateContentRange(tpl, m.index);
    if (!parts) {
      eachBlocks.push({ itemVar: null, indexVar: null, arrayExpr: spec, attrOffset: specStart, content, hasKey: true, malformed: true });
      continue;
    }
    eachBlocks.push({
      itemVar: parts[1],
      indexVar: parts[2] || null,
      arrayExpr: parts[3].trim(),
      attrOffset: specStart,
      exprOffset: specStart + spec.indexOf(parts[3]),
      content,
      hasKey: /\bkey\s*=\s*"/.test(tag),
    });
  }

  // <template await="expr"> — `await` is in scope inside (then/catch included),
  // and an `as="user"` alias binds that name inside the block too.
  const awaitRe = /<template\b[^>]*\bawait\s*=\s*"([^"]*)"/gi;
  while ((m = awaitRe.exec(tpl)) !== null) {
    const content = templateContentRange(tpl, m.index);
    const tagEnd = tpl.indexOf('>', m.index);
    const tag = tpl.slice(m.index, tagEnd === -1 ? tpl.length : tagEnd);
    const asName = tag.match(/\bas\s*=\s*"\s*([A-Za-z_$][\w$]*)\s*"/)?.[1] || null;
    if (content) awaitBlocks.push({ content, asName });
    let expr = m[1];
    let exprOffset = m.index + m[0].length - m[1].length - 1;
    const once = expr.match(/^once\(([\s\S]*)\)$/);
    if (once) { expr = once[1]; exprOffset += 5; }
    refs.push(...exprRefs(expr, exprOffset));
  }

  // {interpolations} — quote-aware matching, `\{` escapes skipped.
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] !== '{' || tpl[i - 1] === '\\' || tpl[i - 1] === '$') continue;
    const close = matchingBrace(tpl, i);
    if (close === -1) continue;
    // `onclick={add}` etc — spark-ssr synthesizes any undeclared handler an
    // interactive page references (see analyzeSSR's caller).
    const inHandler = /on[a-zA-Z]+\s*=\s*"?$/.test(tpl.slice(Math.max(0, i - 40), i));
    refs.push(...exprRefs(tpl.slice(i + 1, close), i + 1).map((r) => ({ ...r, inHandler })));
    i = close;
  }

  // :attr="expr" dynamic attributes + template if/else-if/key
  const dynRe = /(?<=\s):([\w-]+)\s*=\s*"([^"]*)"/g;
  while ((m = dynRe.exec(tpl)) !== null) {
    refs.push(...exprRefs(m[2], m.index + m[0].length - m[2].length - 1));
  }
  const condRe = /<template\b[^>]*\b(if|else-if|key)\s*=\s*"([^"]*)"/gi;
  while ((m = condRe.exec(tpl)) !== null) {
    refs.push(...exprRefs(m[2], m.index + m[0].length - m[2].length - 1));
  }
  // key= on the each tag itself (evaluated per item)
  const keyRe = /<template\b[^>]*\beach\s*=[^>]*\bkey\s*=\s*"([^"]*)"/gi;
  while ((m = keyRe.exec(tpl)) !== null) {
    refs.push(...exprRefs(m[1], m.index + m[0].length - m[1].length - 1));
  }

  // bind:x="target" — target must be writable state.
  const bindRe = /(?<=\s)bind:([\w-]+)\s*=\s*"([^"]*)"/g;
  while ((m = bindRe.exec(tpl)) !== null) {
    refs.push(...exprRefs(m[2], m.index + m[0].length - m[2].length - 1));
  }

  // <div import="path" …> placeholders.
  const impRe = /<[a-zA-Z][\w-]*\b[^>]*\bimport\s*=\s*"([^"]*)"/g;
  while ((m = impRe.exec(tpl)) !== null) {
    const valueStart = m.index + m[0].length - m[1].length - 1;
    importTags.push({
      path: m[1],
      valueStart,
      valueEnd: valueStart + m[1].length,
      tagStart: m.index,
      tagEnd: tpl.indexOf('>', m.index),
    });
  }

  return { refs, eachBlocks, awaitBlocks, importTags };
}

// ── entry point ────────────────────────────────────────────────────────────

export function analyze(text) {
  const script = findScript(text);
  const tpl = templateMask(text, script);
  const s = analyzeScript(text, script);
  const t = analyzeTemplate(text, tpl);
  const ssr = analyzeSSR(text);
  const diagnostics = [...s.diagnostics];

  const declared = (name, offset) => {
    if (s.declarations.has(name)) return true;
    if (ssr.vars.has(name)) return true;
    if (ssr.isSSRPage && SSR_AMBIENT_GLOBALS.has(name)) return true;
    for (const b of t.eachBlocks) {
      if (!b.content || offset < b.content.start || offset >= b.content.end) continue;
      if (name === b.itemVar || name === b.indexVar) return true;
    }
    // the each/key expressions on the tag itself also see the loop vars
    for (const b of t.eachBlocks) {
      if (b.content && offset < b.content.start && offset >= b.attrOffset &&
          (name === b.itemVar || name === b.indexVar)) return true;
    }
    // <template await … as="user"> binds the alias inside the block.
    for (const b of t.awaitBlocks) {
      if (b.asName === name && b.content &&
          offset >= b.content.start && offset < b.content.end) return true;
    }
    return false;
  };

  // Undefined template bindings.
  for (const ref of t.refs) {
    if (ssr.isSSRPage && ref.inHandler) continue; // spark-ssr synthesizes it
    if (!declared(ref.name, ref.offset)) {
      diagnostics.push({
        start: ref.offset,
        end: ref.offset + ref.name.length,
        severity: 2,
        message: `'${ref.name}' is not declared in this component's <script> (no let/function/$:/export let matches).`,
        code: 'undefined-binding',
      });
    }
  }

  // each without key= — index-matched patching; keyed is opt-in, so a hint.
  for (const b of t.eachBlocks) {
    if (!b.hasKey && !b.malformed) {
      diagnostics.push({
        start: b.attrOffset,
        end: b.attrOffset + 4,
        severity: 4,
        message: `each without key= — rows are matched by index. Add key="${b.itemVar}.id" (or another stable expression) for keyed reconciliation.`,
        code: 'each-no-key',
      });
    }
    if (b.malformed) {
      diagnostics.push({
        start: b.attrOffset,
        end: b.attrOffset + b.arrayExpr.length,
        severity: 1,
        message: `Malformed each — expected "item in items" or "item, i in items".`,
        code: 'each-malformed',
      });
    }
  }

  // Unused JS imports: local never referenced in script or template.
  const usedNames = new Set([...s.refs.map((r) => r.name), ...t.refs.map((r) => r.name)]);
  for (const imp of s.imports) {
    for (const local of imp.locals) {
      if (!usedNames.has(local.name)) {
        diagnostics.push({
          start: local.offset,
          end: local.offset + local.name.length,
          severity: 2,
          message: `'${local.name}' is imported but never used.`,
          code: 'unused-import',
        });
      }
    }
  }

  return {
    script,
    declarations: s.declarations,
    imports: s.imports,
    props: [...s.declarations].filter(([, d]) => d.kind === 'prop').map(([name, d]) => ({ name, offset: d.offset })),
    templateRefs: t.refs,
    eachBlocks: t.eachBlocks,
    importTags: t.importTags,
    diagnostics,
    isSSRPage: ssr.isSSRPage,
    ssrVars: ssr.vars,
  };
}
