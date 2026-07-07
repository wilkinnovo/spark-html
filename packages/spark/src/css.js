/**
 * CSS scoping — prefixes every selector with [name="comp"] so a component's
 * styles can't leak out (or in).
 *
 * The old implementation was a single regex — it couldn't see into @media,
 * mangled @keyframes step selectors (0%/100%), embedded CSS comments into
 * selectors, and only handled :global() when it wrapped the ENTIRE selector.
 * This is a small, proper tokenizer instead: it strips comments, walks the
 * rule tree by brace depth, scopes only real selector lists (recursing into
 * @media/@supports so their selectors get the SAME scope — which also
 * balances specificity against base rules), leaves @keyframes/@font-face
 * bodies untouched, and unwraps :global(...) wherever it appears in a selector.
 *
 * Imports skipString from ./script.js — the brace/string-aware scanner the
 * CSS tokenizer needs to handle strings inside selectors without miscount.
 */
import { skipString } from './script.js';

// Strip /* … */ comments, preserving strings. A comment becomes one space so
// adjacent tokens never fuse (e.g. `a/* x */b` → `a b`, not `ab`).
function stripCssComments(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") { const j = skipString(css, i); out += css.slice(i, j); i = j; continue; }
    if (c === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Index of the `}` matching the `{` at `openIdx` (string-aware).
function cssMatchBrace(css, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") { i = skipString(css, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return css.length; // unbalanced — treat the rest as the body
}

// Index just past a balanced ( … ) or [ … ] group starting at `open`.
function cssMatchGroup(s, open) {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipString(s, i); continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return s.length;
}

// At-rules whose body is itself a list of rules (so we recurse + scope the
// nested selectors). Everything else with a block (@keyframes, @font-face,
// @page, @font-feature-values…) has a body that is NOT selectors — leave it.
const NESTED_AT_RULES = new Set([
  'media', 'supports', 'container', 'document', '-moz-document', 'layer',
]);

// Split a selector list on top-level commas (commas inside (), [], or strings
// — e.g. :is(.a, .b) or [x="a,b"] — don't separate selectors).
function splitSelectorList(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < list.length) {
    const c = list[i];
    if (c === '"' || c === "'") { i = skipString(list, i); continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(list.slice(start));
  return parts;
}

// Break one complex selector into compounds + combinators, respecting
// strings and ()/[] groups (so `>`/`+`/`~`/spaces inside :nth-child(2n+1) or
// [a~=b] are not treated as combinators).
function tokenizeSelector(sel) {
  const tokens = [];
  let compound = '';
  const flush = () => { if (compound) { tokens.push({ t: 'c', v: compound }); compound = ''; } };
  let i = 0;
  while (i < sel.length) {
    const c = sel[i];
    if (c === '"' || c === "'") { const j = skipString(sel, i); compound += sel.slice(i, j); i = j; continue; }
    if (c === '(' || c === '[') { const j = cssMatchGroup(sel, i); compound += sel.slice(i, j); i = j; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '>' || c === '+' || c === '~') {
      flush();
      let comb = '';
      while (i < sel.length && /[\s>+~]/.test(sel[i])) { comb += sel[i]; i++; }
      const sym = comb.match(/[>+~]/);
      tokens.push({ t: 'comb', v: sym ? ` ${sym[0]} ` : ' ' });
      continue;
    }
    compound += c;
    i++;
  }
  flush();
  return tokens;
}

// Scope one selector: insert `prefix ` before the first compound that isn't
// wrapped in :global(), and unwrap :global(X) → X wherever it appears. A
// selector that is entirely :global(...) stays fully unscoped.
function scopeSelector(sel, prefix) {
  const trimmed = sel.trim();
  if (!trimmed) return sel;
  const tokens = tokenizeSelector(trimmed);
  let out = '';
  let inserted = false;
  for (const tok of tokens) {
    if (tok.t === 'comb') { out += tok.v; continue; }
    const whole = tok.v.match(/^:global\(([\s\S]*)\)$/);
    if (whole) {
      out += whole[1]; // a purely-global compound: drop the wrapper, no scope
    } else {
      if (!inserted) { out += `${prefix} `; inserted = true; }
      out += tok.v.replace(/:global\(([\s\S]*?)\)/g, '$1'); // partial :global()
    }
  }
  return out;
}

function scopeSelectorList(list, prefix) {
  return splitSelectorList(list)
    .map((sel) => scopeSelector(sel, prefix))
    .join(', ');
}

// Walk a sequence of rules at one nesting level, scoping style-rule selectors.
function scopeRules(css, prefix) {
  let out = '';
  let i = 0;
  const n = css.length;
  while (i < n) {
    // Preserve leading whitespace between rules.
    const ws = i;
    while (i < n && /\s/.test(css[i])) i++;
    out += css.slice(ws, i);
    if (i >= n) break;

    // Read the prelude (selector list or at-rule header) up to a top-level
    // `{` or `;` — `{`/`;` inside (), [], or strings don't count.
    const preludeStart = i;
    let depth = 0;
    while (i < n) {
      const c = css[i];
      if (c === '"' || c === "'") { i = skipString(css, i); continue; }
      if (c === '(' || c === '[') { depth++; i++; continue; }
      if (c === ')' || c === ']') { depth--; i++; continue; }
      if (depth === 0 && (c === '{' || c === ';')) break;
      i++;
    }
    const prelude = css.slice(preludeStart, i);

    if (i >= n) { out += prelude; break; }

    if (css[i] === ';') {        // statement at-rule (@import, @charset…)
      out += prelude + ';';
      i++;
      continue;
    }

    // css[i] === '{' — block rule.
    const end = cssMatchBrace(css, i);
    const body = css.slice(i + 1, end);
    const trimmed = prelude.trim();

    if (trimmed[0] === '@') {
      const name = (trimmed.slice(1).match(/^[\w-]*/) || [''])[0].toLowerCase();
      out += NESTED_AT_RULES.has(name)
        ? `${trimmed} {${scopeRules(body, prefix)}}` // scope nested selectors
        : `${trimmed} {${body}}`;                    // @keyframes/@font-face: leave
    } else {
      out += `${scopeSelectorList(prelude, prefix)} {${body}}`;
    }
    i = end + 1;
  }
  return out;
}

export function scopeCss(css, tag) {
  return scopeRules(stripCssComments(css), `[name="${tag}"]`);
}