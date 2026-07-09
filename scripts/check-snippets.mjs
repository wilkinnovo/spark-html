/**
 * Doc snippet harness (improvements.md I4a) — part of the root `npm test`
 * chain (node). "Docs are exactly true" needs a tripwire: every fenced code
 * block in README.md + packages/*\/README.md, and every <pre> block in the
 * website doc sources, is at least SYNTAX-CHECKED on every test run.
 *
 * Classification:
 *   ```html / <pre> that looks like a spark page  → parseSFC() must yield
 *     markup, and its <script> content must transpile (esbuild) as JS.
 *   ```js / ```javascript / js-looking <pre>      → esbuild transpile-check.
 *   ```json                                       → JSON.parse.
 *   ```bash/sh, output samples, css, other        → skipped (not code we run).
 *   ```<lang> skip=<reason>                       → explicit opt-out, reason
 *     required — the only silencer, and it's visible in the diff.
 *
 * Heuristics are deliberately conservative (a false PASS is possible; a
 *false FAIL should not be): website <pre> blocks have no info string, so
 * only blocks that clearly look like spark pages or JS are checked.
 * Never-weaken-the-oracle applies: when this finds rot, fix the doc.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parseSFC } = await import(join(ROOT, 'packages/spark/src/index.js'));

let checked = 0, failed = 0, skipped = 0;
const fails = [];
const bad = (where, msg, src) => {
  failed++;
  fails.push(`  ✗ ${where}\n    ${msg}\n    ${src.trim().split('\n')[0].slice(0, 90)}`);
};

function checkJs(src, where, loader = 'js') {
  checked++;
  try { transformSync(src, { loader }); }
  catch (e) { bad(where, e.errors?.[0]?.text || e.message, src); }
}

function checkHtmlPage(src, where) {
  checked++;
  let sfc;
  try { sfc = parseSFC(src); } catch (e) { return bad(where, `parseSFC threw: ${e.message}`, src); }
  if (!(sfc.markup || '').trim() && !(sfc.script || '').trim()) return bad(where, 'parseSFC yielded nothing', src);
  // Transpile-check each script by its own type (a full-document example can
  // carry an importmap — JSON, not JS); untyped/module scripts are JS.
  for (const sm of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const type = (sm[1].match(/type\s*=\s*["']([^"']+)["']/) || [])[1] || '';
    if (!sm[2].trim()) continue;
    if (type === 'importmap' || type.includes('json')) {
      try { JSON.parse(sm[2]); } catch (e) { bad(where, `importmap/json script: ${e.message}`, src); }
    } else if (!type || type === 'module' || type === 'text/javascript') {
      try { transformSync(sm[2], { loader: 'js' }); }
      catch (e) { bad(where, `page <script> is not valid JS: ${e.errors?.[0]?.text || e.message}`, src); }
    }
  }
}

// ── markdown fenced blocks ────────────────────────────────────────────────
const FENCE = /```([^\n]*)\n([\s\S]*?)```/g;
function checkMarkdown(file) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(ROOT.length + 1);
  let m, n = 0;
  while ((m = FENCE.exec(text))) {
    n++;
    const info = m[1].trim();
    const src = m[2];
    const where = `${rel} block ${n} (\`\`\`${info || '∅'})`;
    const skipMatch = info.match(/\bskip=(\S+)/);
    if (skipMatch) { skipped++; continue; }
    const lang = info.split(/\s+/)[0].toLowerCase();
    if (lang === 'html') checkHtmlPage(src, where);
    else if (lang === 'js' || lang === 'javascript' || lang === 'mjs') checkJs(src, where);
    else if (lang === 'ts' || lang === 'typescript') checkJs(src, where, 'ts');
    else if (lang === 'jsonc' || lang === 'json') {
      checked++;
      try { JSON.parse(src.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n"']*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); } catch (e) { bad(where, e.message, src); }
    } else skipped++; // bash, css, output samples, plain text
  }
}

// ── website <pre> blocks (no info string — conservative heuristics) ──────
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function checkWebsiteDoc(file) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(ROOT.length + 1);
  let m, n = 0;
  const PRE = /<pre[^>]*>([\s\S]*?)<\/pre>/g;
  while ((m = PRE.exec(text))) {
    n++;
    const src = decode(m[1].replace(/<[^>]+>/g, ''));
    const where = `${rel} <pre> ${n}`;
    const head = src.trim();
    if (/^[#$]|^bun |^npm |^npx |^curl |^git /.test(head)) { skipped++; continue; } // shell
    // "// something.json" header + a {…} body → jsonc sample
    if (/^\/\/[^\n]*\.json/.test(head)) {
      const body = head.split('\n').slice(1).join('\n').trim();
      if (body.startsWith('{')) {
        checked++;
        try { JSON.parse(body.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n"']*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); }
        catch (e) { bad(where, `jsonc: ${e.message}`, src); }
        continue;
      }
    }
    if (/^\{[\s\S]*\}$/.test(head)) { checked++; try { JSON.parse(head); } catch { skipped++; checked--; } continue; }
    if (/<template\b|<spark-ssr\b|\bimport="|<script\b/.test(src)) { checkHtmlPage(src, where); continue; }
    if (/^(import |export |const |let |function |await |\/\/)/.test(head)) { checkJs(src, where); continue; }
    skipped++; // css, prose-ish, partial fragments — not provably code
  }
}

checkMarkdown(join(ROOT, 'README.md'));
for (const pkg of readdirSync(join(ROOT, 'packages'))) {
  const f = join(ROOT, 'packages', pkg, 'README.md');
  if (existsSync(f)) checkMarkdown(f);
}
for (const f of ['website/public/components/docs-body.html', 'website/public/components/ssr.html']) {
  if (existsSync(join(ROOT, f))) checkWebsiteDoc(join(ROOT, f));
}

if (fails.length) {
  console.error(`\nsnippet check: ${failed} of ${checked} checked blocks FAILED (${skipped} skipped):\n`);
  for (const f of fails) console.error(f + '\n');
  console.error('Fix the doc (never loosen this harness); `skip=<reason>` on the fence is the only opt-out.');
  process.exit(1);
}
console.log(`snippet check: ${checked} code blocks OK (${skipped} skipped as non-runnable)`);
