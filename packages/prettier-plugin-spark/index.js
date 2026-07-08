// prettier-plugin-spark — format spark-html single-file components.
//
// The hard rule (Spark's whole philosophy): the markup you write is what runs.
// So this plugin formats ONLY the embedded <script> (JavaScript) and <style>
// (CSS) blocks — real code that's safe to pretty-print — and leaves every byte
// of your markup exactly as written. That means Spark's `{interpolation}` and
// `onclick={handler}` and `:attr="…"` syntax can never be corrupted by a
// generic HTML formatter (which rewrites `onclick={fn}` into broken JS and
// word-wraps string literals inside `{…}`). Markup is untouched, period.
//
// Distributed for editors that drive Prettier (e.g. Zed via the Spark
// extension). Prettier is a peer dependency.

import { format } from "prettier";

const SCRIPT_RE = /(<script[^>]*>)([\s\S]*?)(<\/script>)/gi;
const STYLE_RE = /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi;

// Only forward the standard formatting knobs to the inner JS/CSS pass — never
// `parser`/`plugins`/`filepath` (those would re-select this same plugin and
// recurse, or point Prettier at the wrong language).
const FORWARD = [
  "printWidth",
  "tabWidth",
  "useTabs",
  "semi",
  "singleQuote",
  "quoteProps",
  "trailingComma",
  "bracketSpacing",
  "arrowParens",
  "endOfLine",
];
function innerOptions(options) {
  const out = {};
  for (const k of FORWARD) if (options && options[k] != null) out[k] = options[k];
  return out;
}

// String.replace can't await, so walk matches manually.
async function replaceAsync(str, re, fn) {
  re.lastIndex = 0;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push(str.slice(last, m.index));
    out.push(await fn(m, m.index, str));
    last = m.index + m[0].length;
  }
  out.push(str.slice(last));
  return out.join("");
}

// Indentation (whitespace only) of the line the opening tag sits on, so a
// nested block is re-indented relative to its own tag, not column 0.
function tagIndent(str, index) {
  const lineStart = str.lastIndexOf("\n", index - 1) + 1;
  const before = str.slice(lineStart, index);
  return /^\s*$/.test(before) ? before : "";
}

async function formatBlock(body, parser, options, baseIndent) {
  if (!body.trim()) return body; // empty block: leave as-is
  let formatted;
  try {
    formatted = await format(body, { ...innerOptions(options), parser });
  } catch {
    return body; // never break the file on a parse error — leave it untouched
  }
  formatted = formatted.replace(/\n+$/, "");
  const unit = options.useTabs ? "\t" : " ".repeat(options.tabWidth || 2);
  const indent = baseIndent + unit;
  const inner = formatted
    .split("\n")
    .map((l) => (l.length ? indent + l : l))
    .join("\n");
  return "\n" + inner + "\n" + baseIndent;
}

// ── <spark-ssr> block bodies ────────────────────────────────────────────
// The block grammar (spark-ssr src/parse.js parseBody — keep in sync):
//   var = SELECT … | https://… | ./content/*.md | ./lib/x.js
//   METHOD [/path] → [var =] SQL        (`->` accepted alongside `→`)
// SQL may continue on following lines. The runtime is reflow-tolerant, so
// formatting is safe — but humans read these blocks constantly, so:
//   • one binding per line, `=` aligned across the block
//   • long SQL broken before top-level clauses (FROM, WHERE, ORDER BY, …),
//     continuations indented two past the binding (the examples/ house style)
//   • strings ('…', with '' escapes) and parenthesized subqueries are never
//     split — the scanner is quote- and depth-aware
//   • any line the grammar doesn't recognize is passed through byte-identical
//     in place (comments, prose — never guess)

const SSR_BLOCK_RE = /(<spark-ssr\b[^>]*[^/>]>|<spark-ssr>)([\s\S]*?)(<\/spark-ssr\s*>)/gi;
const ROUTE_RE = /^\s*(GET|POST|PUT|PATCH|DELETE)\s*(\/\S*)?\s*(→|->)\s*([\s\S]*)$/;
const BIND_RE = /^\s*([a-zA-Z_$][\w$]*)\s*=\s*(\S[\s\S]*)$/;
const SQL_START_RE = /^\s*(select|insert|update|delete|with)\b/i;

// Same classifier as spark-ssr's classifySource — keep in sync.
function ssrKind(v) {
  v = v.trim();
  if (/^https?:\/\//i.test(v)) return "url";
  if (/^\.{0,2}\//.test(v) && /[*?]/.test(v)) return "glob";
  if (/^\.{0,2}\//.test(v) && /\.(m?js|ts)$/i.test(v)) return "module";
  return "sql";
}

// Clauses that start a new line when the statement is too long for one.
// Multi-word first (ORDER BY before OR is irrelevant — OR never breaks —
// but GROUP BY must not half-match GROUP).
export const SQL_BREAK_CLAUSES = [
  "GROUP BY", "ORDER BY", "UNION ALL", "LEFT JOIN", "RIGHT JOIN",
  "INNER JOIN", "FULL JOIN", "CROSS JOIN", "OUTER JOIN",
  "FROM", "WHERE", "HAVING", "LIMIT", "OFFSET", "UNION", "JOIN",
  "VALUES", "SET", "RETURNING",
];

// Split SQL into clause segments at depth-0, outside single-quoted strings.
// Returns the segments with original inner whitespace collapsed to single
// spaces (whitespace in SQL outside strings is insignificant).
export function splitSqlClauses(sql) {
  const flat = sql.replace(/\s+/g, (ws, i) => {
    // never collapse whitespace inside '…' strings
    return insideString(sql, i) ? ws : " ";
  }).trim();
  const segs = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    if (c === "'") {
      i++;
      while (i < flat.length) {
        if (flat[i] === "'" && flat[i + 1] === "'") { i += 2; continue; }
        if (flat[i] === "'") break;
        i++;
      }
      continue;
    }
    if (c === "(") { depth++; continue; }
    if (c === ")") { depth--; continue; }
    if (depth !== 0 || i === 0) continue;
    if (!/[\s(]/.test(flat[i - 1])) continue; // clause must start a word
    for (const kw of SQL_BREAK_CLAUSES) {
      if (
        flat.slice(i, i + kw.length).toUpperCase() === kw &&
        (i + kw.length === flat.length || /[\s(]/.test(flat[i + kw.length]))
      ) {
        segs.push(flat.slice(start, i).trimEnd());
        start = i;
        i += kw.length - 1;
        break;
      }
    }
  }
  segs.push(flat.slice(start));
  return segs.filter((s) => s.length);
}

// Is offset `i` inside a single-quoted SQL string ('' escapes)?
function insideString(sql, i) {
  let open = false;
  for (let j = 0; j < i; j++) {
    if (sql[j] === "'") open = !open;
  }
  return open;
}

// Lay out one SQL statement: one line if it fits the print width, otherwise
// one clause per line, continuations at `contIndent`.
function printSql(sql, headLen, contIndent, printWidth) {
  // A SQL comment (`-- …` runs to end-of-line) makes whitespace significant —
  // reflowing would swallow the next clause into the comment. Keep the
  // author's line structure, just re-indent the continuations.
  if (/--|\/\*/.test(sql)) {
    return sql
      .split("\n")
      .map((l, i) => (i === 0 ? l.trim() : contIndent + l.trim()))
      .join("\n");
  }
  const segs = splitSqlClauses(sql);
  const oneLine = segs.join(" ");
  if (headLen + oneLine.length <= printWidth || segs.length === 1) return oneLine;
  return segs
    .map((s, i) => (i === 0 ? s : contIndent + s))
    .join("\n");
}

export function formatSsrBody(body, baseIndent, options = {}) {
  if (!body.trim()) return body;
  const printWidth = options.printWidth || 80;
  const unit = options.useTabs ? "\t" : " ".repeat(options.tabWidth || 2);
  const indent = baseIndent + unit;
  const contIndent = indent + unit;

  // Pass 1 — group physical lines into entries, same continuation rule as
  // the runtime: a line that is neither a route nor a binding-with-a-source
  // continues the previous SQL entry; otherwise it's raw and kept verbatim.
  const entries = [];
  let cur = null; // entry whose SQL keeps growing
  for (const line of String(body).split("\n")) {
    const t = line.trim();
    if (!t) { cur = null; entries.push({ type: "raw", text: "" }); continue; }
    const rm = line.match(ROUTE_RE);
    if (rm) {
      let sql = rm[4].trim();
      let varName = null;
      const vm = sql.match(/^([a-zA-Z_$][\w$]*)\s*=\s*([\s\S]*)$/);
      if (vm && !SQL_START_RE.test(sql)) { varName = vm[1]; sql = vm[2].trim(); }
      cur = { type: "route", method: rm[1], path: rm[2] || null, var: varName, sql };
      entries.push(cur);
      continue;
    }
    const bm = line.match(BIND_RE);
    if (bm) {
      const kind = ssrKind(bm[2]);
      if (kind !== "sql") {
        cur = null;
        entries.push({ type: "bind", var: bm[1], kind, value: bm[2].trim() });
        continue;
      }
      if (SQL_START_RE.test(bm[2])) {
        cur = { type: "bind", var: bm[1], kind: "sql", sql: bm[2].trim() };
        entries.push(cur);
        continue;
      }
      // `published = 1` inside multi-line SQL — continuation, not a binding
    }
    if (cur && cur.sql !== undefined) { cur.sql += "\n" + t; continue; }
    cur = null;
    entries.push({ type: "raw", text: line });
  }
  if (!entries.some((e) => e.type !== "raw")) return body; // nothing we understand
  // The body's own leading/trailing blank lines are re-created by the final
  // "\n … \n" wrap — drop them here so they don't double up.
  while (entries.length && entries[0].type === "raw" && !entries[0].text.trim()) entries.shift();
  while (entries.length && entries.at(-1).type === "raw" && !entries.at(-1).text.trim()) entries.pop();

  // Pass 2 — align `=` across the block's named bindings.
  const nameLen = Math.max(
    0,
    ...entries.filter((e) => e.type === "bind").map((e) => e.var.length),
  );

  const out = [];
  for (const e of entries) {
    if (e.type === "raw") { out.push(e.text); continue; }
    if (e.type === "bind") {
      const head = indent + e.var.padEnd(nameLen) + " = ";
      if (e.kind !== "sql") { out.push(head + e.value); continue; }
      out.push(head + printSql(e.sql, head.length, contIndent, printWidth));
      continue;
    }
    // route
    let head = indent + e.method + " " + (e.path ? e.path + " " : "") + "→ ";
    if (e.var) head += e.var + " = ";
    out.push(head + printSql(e.sql, head.length, contIndent, printWidth));
  }
  return "\n" + out.join("\n") + "\n" + baseIndent;
}

export async function formatSpark(text, options = {}) {
  let out = await replaceAsync(text, SCRIPT_RE, async (m, i, s) =>
    m[1] + (await formatBlock(m[2], "babel", options, tagIndent(s, i))) + m[3],
  );
  out = await replaceAsync(out, STYLE_RE, async (m, i, s) =>
    m[1] + (await formatBlock(m[2], "css", options, tagIndent(s, i))) + m[3],
  );
  out = await replaceAsync(out, SSR_BLOCK_RE, async (m, i, s) =>
    m[1] + formatSsrBody(m[2], tagIndent(s, i), options) + m[3],
  );
  return out;
}

export const languages = [
  {
    name: "Spark",
    parsers: ["spark"],
    extensions: [".html"],
    vscodeLanguageIds: ["spark", "html"],
  },
];

export const parsers = {
  spark: {
    astFormat: "spark",
    locStart: () => 0,
    locEnd: (node) => node.text.length,
    async parse(text, options) {
      return { type: "spark-root", text: await formatSpark(text, options) };
    },
  },
};

export const printers = {
  spark: {
    print(path) {
      return path.getValue().text;
    },
  },
};
