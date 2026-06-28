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

export async function formatSpark(text, options = {}) {
  let out = await replaceAsync(text, SCRIPT_RE, async (m, i, s) =>
    m[1] + (await formatBlock(m[2], "babel", options, tagIndent(s, i))) + m[3],
  );
  out = await replaceAsync(out, STYLE_RE, async (m, i, s) =>
    m[1] + (await formatBlock(m[2], "css", options, tagIndent(s, i))) + m[3],
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
