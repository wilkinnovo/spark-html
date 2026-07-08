/**
 * Semantic tokens for <spark-ssr> block bodies.
 *
 * TextMate/tree-sitter grammars see these blocks as plain text inside an HTML
 * custom element — so SQL, URL/glob/module sources, and `METHOD /path →`
 * endpoint lines render as an unhighlighted wall. This module gives any LSP
 * client (VS Code, Zed, …) real highlighting for them via
 * `textDocument/semanticTokens/full`.
 *
 * The line grammar mirrors spark-ssr's parseBody (packages/spark-ssr/src/
 * parse.js) and prettier-plugin-spark's formatSsrBody — keep the three in
 * sync:
 *   var = SELECT … | https://… | ./content/*.md | ./lib/x.js
 *   METHOD [/path] → [var =] SQL        (`->` accepted alongside `→`)
 * SQL may continue on following lines.
 */

// Legend — index into this array is the tokenType integer in the data stream.
export const TOKEN_TYPES = [
  'keyword',   // SQL keywords, HTTP methods
  'variable',  // binding names (page data vars)
  'operator',  // = and →
  'string',    // SQL '…' strings, URL/glob/module sources, endpoint paths
  'number',    // SQL numeric literals
  'parameter', // :param placeholders (:session.id, :q, :body.title)
  'comment',   // SQL -- comments
];
const T = Object.fromEntries(TOKEN_TYPES.map((t, i) => [t, i]));

const ROUTE_RE = /^(\s*)(GET|POST|PUT|PATCH|DELETE)(\s*)(\/\S*)?(\s*)(→|->)/;
const BIND_RE = /^(\s*)([a-zA-Z_$][\w$]*)(\s*)=/;
const SQL_START_RE = /^\s*(select|insert|update|delete|with)\b/i;

// Same classifier as spark-ssr's classifySource — keep in sync.
function ssrKind(v) {
  v = v.trim();
  if (/^https?:\/\//i.test(v)) return 'url';
  if (/^\.{0,2}\//.test(v) && /[*?]/.test(v)) return 'glob';
  if (/^\.{0,2}\//.test(v) && /\.(m?js|ts)$/i.test(v)) return 'module';
  return 'sql';
}

export const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE',
  'GLOB', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS',
  'DISTINCT', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION',
  'ALL', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'WITH', 'RETURNING',
  'ASC', 'DESC', 'CAST', 'COLLATE', 'USING', 'NATURAL',
]);

// Tokenize one line of SQL starting at column `base`; push onto `out`.
function sqlTokens(out, line, s, base, lineIdx) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '-' && s[i + 1] === '-') {
      out.push({ line: lineIdx, char: base + i, len: n - i, type: T.comment });
      return;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; }
        if (s[j] === "'") { j++; break; }
        j++;
      }
      out.push({ line: lineIdx, char: base + i, len: j - i, type: T.string });
      i = j;
      continue;
    }
    if (c === ':' && /[A-Za-z_$]/.test(s[i + 1] || '')) {
      // :param — tokens keep dots and dashes (:body.title, :session.id)
      let j = i + 1;
      while (j < n && /[\w$.-]/.test(s[j])) j++;
      out.push({ line: lineIdx, char: base + i, len: j - i, type: T.parameter });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) && !/[\w$]/.test(s[i - 1] || '')) {
      let j = i;
      while (j < n && /[\d.]/.test(s[j])) j++;
      out.push({ line: lineIdx, char: base + i, len: j - i, type: T.number });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(s[j])) j++;
      const word = s.slice(i, j);
      if (SQL_KEYWORDS.has(word.toUpperCase())) {
        out.push({ line: lineIdx, char: base + i, len: j - i, type: T.keyword });
      }
      i = j;
      continue;
    }
    i++;
  }
}

// Collect raw tokens for every <spark-ssr> block body in the document.
export function ssrBlockTokens(text) {
  const out = [];
  // Self-closing tags are excluded in the pattern itself — matching them and
  // skipping after the fact would swallow everything up to the NEXT block's
  // close tag and hide that block.
  const blockRe = /(?:<spark-ssr\b[^>]*[^/>]>|<spark-ssr>)([\s\S]*?)<\/spark-ssr\s*>/gi;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    const body = m[1];
    // line index + column of the body start
    let lineIdx = 0;
    let lineStart = 0;
    for (let i = 0; i < bodyStart; i++) {
      if (text[i] === '\n') { lineIdx++; lineStart = i + 1; }
    }
    let col = bodyStart - lineStart; // column where the body begins on its first line
    let inSql = false;
    const lines = body.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const L = lineIdx + li;
      const base = li === 0 ? col : 0;
      const t = line.trim();
      if (!t) { inSql = false; continue; }
      const rm = line.match(ROUTE_RE);
      if (rm) {
        let p = rm[1].length;
        out.push({ line: L, char: base + p, len: rm[2].length, type: T.keyword });
        p += rm[2].length + rm[3].length;
        if (rm[4]) {
          out.push({ line: L, char: base + p, len: rm[4].length, type: T.string });
          p += rm[4].length;
        }
        p += rm[5].length;
        out.push({ line: L, char: base + p, len: rm[6].length, type: T.operator });
        p += rm[6].length;
        let rest = line.slice(p);
        // optional `var =` before the SQL
        const vm = rest.match(/^(\s*)([a-zA-Z_$][\w$]*)(\s*)(=)/);
        if (vm && !SQL_START_RE.test(rest)) {
          out.push({ line: L, char: base + p + vm[1].length, len: vm[2].length, type: T.variable });
          out.push({ line: L, char: base + p + vm[1].length + vm[2].length + vm[3].length, len: 1, type: T.operator });
          p += vm[0].length;
          rest = line.slice(p);
        }
        sqlTokens(out, line, rest, base + p, L);
        inSql = true;
        continue;
      }
      const bm = line.match(BIND_RE);
      if (bm) {
        const valueStart = bm[0].length;
        const value = line.slice(valueStart);
        const kind = ssrKind(value);
        const sqlish = SQL_START_RE.test(value);
        if (kind !== 'sql' || sqlish) {
          out.push({ line: L, char: base + bm[1].length, len: bm[2].length, type: T.variable });
          out.push({ line: L, char: base + bm[1].length + bm[2].length + bm[3].length, len: 1, type: T.operator });
          if (kind !== 'sql') {
            const vs = value.match(/^\s*/)[0].length;
            out.push({ line: L, char: base + valueStart + vs, len: value.trim().length, type: T.string });
            inSql = false;
          } else {
            sqlTokens(out, line, value, base + valueStart, L);
            inSql = true;
          }
          continue;
        }
      }
      if (inSql) { sqlTokens(out, line, line, base, L); continue; }
    }
  }
  return out;
}

// LSP wire format: sorted, delta-encoded [ΔLine, ΔChar, len, type, modifiers].
export function encodeSemanticTokens(tokens) {
  tokens.sort((a, b) => a.line - b.line || a.char - b.char);
  const data = [];
  let prevLine = 0;
  let prevChar = 0;
  for (const t of tokens) {
    const dLine = t.line - prevLine;
    const dChar = dLine === 0 ? t.char - prevChar : t.char;
    data.push(dLine, dChar, t.len, t.type, 0);
    prevLine = t.line;
    prevChar = t.char;
  }
  return data;
}
