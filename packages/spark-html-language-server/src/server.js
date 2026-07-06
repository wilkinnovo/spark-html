/**
 * spark-html-language-server — the LSP server.
 *
 * Speaks Language Server Protocol over JSON-RPC. Transport-agnostic: the
 * class handles decoded messages and emits replies through `send`; the CLI
 * (bin/cli.js) wires it to stdio with Content-Length framing. Tests drive
 * `handle()` directly — no child process, no flakiness.
 *
 * Features: publishDiagnostics (on open/change), completion (component props
 * from the target's `export let`, template directives, script symbols),
 * hover (directive + builtin docs, declaration info), and go-to-definition
 * (component imports → file, identifiers → their declaration).
 *
 * spark-ssr pages (any file with a <spark-ssr> tag) get extra completion and
 * hover coverage for inferred page data and ambient helpers (session, path,
 * flash, api_create, …) — see analyze.js's analyzeSSR and docs.js's
 * SSR_BUILTINS.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyze } from './analyze.js';
import { directiveDoc, directiveCompletions, SCRIPT_BUILTINS, SSR_BUILTINS } from './docs.js';

// ── position mapping ───────────────────────────────────────────────────────

export function offsetToPosition(text, offset) {
  let line = 0;
  let last = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; last = i + 1; }
  }
  return { line, character: Math.min(offset, text.length) - last };
}

export function positionToOffset(text, pos) {
  let line = 0;
  let i = 0;
  while (line < pos.line && i < text.length) {
    if (text[i] === '\n') line++;
    i++;
  }
  return Math.min(i + pos.character, text.length);
}

const range = (text, start, end) => ({
  start: offsetToPosition(text, start),
  end: offsetToPosition(text, end),
});

// Word under the cursor, including the directive charset (`bind:value`,
// `:hidden`, `else-if`, `$:`).
function wordAt(text, offset) {
  const chars = /[\w$:.-]/;
  let s = offset;
  let e = offset;
  while (s > 0 && chars.test(text[s - 1])) s--;
  while (e < text.length && chars.test(text[e])) e++;
  return { word: text.slice(s, e), start: s, end: e };
}

// ── server ─────────────────────────────────────────────────────────────────

export class SparkLanguageServer {
  constructor({ send }) {
    this.send = send;
    this.docs = new Map(); // uri -> { text, analysis }
    this.rootPath = null;
  }

  handle(msg) {
    const { id, method, params } = msg;
    const respond = (result) => this.send({ jsonrpc: '2.0', id, result });
    try {
      switch (method) {
        case 'initialize':
          this.rootPath = params?.rootUri ? fileURLToPath(params.rootUri)
            : params?.rootPath || null;
          return respond({
            capabilities: {
              textDocumentSync: 1, // full
              completionProvider: { triggerCharacters: ['{', ':', '"', ' ', '.'] },
              hoverProvider: true,
              definitionProvider: true,
            },
            serverInfo: { name: 'spark-html-language-server' },
          });
        case 'initialized':
        case 'exit':
          return;
        case 'shutdown':
          return respond(null);
        case 'textDocument/didOpen':
          return this.open(params.textDocument.uri, params.textDocument.text);
        case 'textDocument/didChange':
          return this.open(params.textDocument.uri, params.contentChanges[0].text);
        case 'textDocument/didClose':
          this.docs.delete(params.textDocument.uri);
          return this.send({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: { uri: params.textDocument.uri, diagnostics: [] },
          });
        case 'textDocument/completion':
          return respond(this.completion(params));
        case 'textDocument/hover':
          return respond(this.hover(params));
        case 'textDocument/definition':
          return respond(this.definition(params));
        default:
          // Respond to unknown requests (they have an id) so clients don't hang.
          if (id !== undefined) respond(null);
      }
    } catch (e) {
      if (id !== undefined) {
        this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
      }
    }
  }

  open(uri, text) {
    const analysis = analyze(text);
    this.docs.set(uri, { text, analysis });
    const diagnostics = analysis.diagnostics.map((d) => ({
      range: range(text, d.start, d.end),
      severity: d.severity,
      message: d.message,
      code: d.code,
      source: 'spark',
      ...(d.code === 'unused-import' ? { tags: [1] } : {}), // Unnecessary
    }));
    // Component placeholders pointing at files that don't exist.
    for (const tag of analysis.importTags) {
      const file = this.resolveImport(uri, tag.path);
      if (file === undefined) continue; // remote / unresolvable — not checked
      if (!file) {
        diagnostics.push({
          range: range(text, tag.valueStart, tag.valueEnd),
          severity: 2,
          message: `Component file not found: "${tag.path}" (looked for it relative to this file${this.rootPath ? ' and the workspace root' : ''}).`,
          code: 'component-not-found',
          source: 'spark',
        });
      }
    }
    this.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics },
    });
  }

  // Resolve a placeholder path to an existing file. Returns the path, null
  // (checked, missing), or undefined (remote URL — out of scope).
  resolveImport(docUri, path) {
    if (/^[a-z]+:\/\//i.test(path)) return undefined;
    let docDir;
    try { docDir = dirname(fileURLToPath(docUri)); } catch { return undefined; }
    const bases = path.startsWith('/')
      ? [this.rootPath, resolve(this.rootPath || docDir, 'public')].filter(Boolean)
      : [docDir];
    for (const base of bases) {
      const target = path.startsWith('/') ? resolve(base, path.slice(1)) : resolve(base, path);
      for (const candidate of [target, `${target}.html`]) {
        if (existsSync(candidate)) return candidate;
      }
    }
    // Components often live under public/ (served from the web root).
    if (!path.startsWith('/')) {
      for (const extra of ['public', '.']) {
        if (!this.rootPath) break;
        const target = resolve(this.rootPath, extra, path);
        for (const candidate of [target, `${target}.html`]) {
          if (existsSync(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  // ── completion ───────────────────────────────────────────────────────────

  completion({ textDocument, position }) {
    const doc = this.docs.get(textDocument.uri);
    if (!doc) return null;
    const { text, analysis } = doc;
    const offset = positionToOffset(text, position);

    const symbolItems = () => {
      const items = [];
      const seen = new Set();
      for (const [name, d] of analysis.declarations) {
        seen.add(name);
        items.push({
          label: name,
          kind: d.kind === 'function' ? 3 : d.kind === 'prop' ? 5 : 6,
          detail: { prop: 'prop (export let)', let: 'state (let)', function: 'function', reactive: 'reactive ($:)', import: 'import' }[d.kind],
        });
      }
      for (const [name, doc_] of Object.entries(SCRIPT_BUILTINS)) {
        if (name === '$:' || seen.has(name)) continue;
        seen.add(name);
        items.push({ label: name, kind: 3, detail: 'spark builtin', documentation: doc_ });
      }
      if (analysis.isSSRPage) {
        for (const name of analysis.ssrVars) {
          if (seen.has(name)) continue;
          seen.add(name);
          items.push({ label: name, kind: 6, detail: 'spark-ssr page data' });
        }
        for (const [name, doc_] of Object.entries(SSR_BUILTINS)) {
          if (seen.has(name)) continue;
          seen.add(name);
          items.push({ label: name, kind: name.startsWith('api_') || name === 'refresh' ? 3 : 6, detail: 'spark-ssr ambient', documentation: doc_ });
        }
      }
      return items;
    };

    // Inside the component <script>? Complete script symbols.
    const s = analysis.script;
    if (s && offset >= s.start && offset <= s.end) return { isIncomplete: false, items: symbolItems() };

    // Inside a tag (a `<` after the last `>`)?
    const lastOpen = text.lastIndexOf('<', offset - 1);
    const lastClose = text.lastIndexOf('>', offset - 1);
    if (lastOpen > lastClose) {
      const tagText = text.slice(lastOpen, offset);
      const quotes = (tagText.match(/"/g) || []).length;
      if (quotes % 2 === 0) {
        // Attribute-name position. On a placeholder, offer the target's props.
        const impM = tagText.match(/\bimport\s*=\s*"([^"]*)"/);
        const items = [];
        if (impM) {
          const file = this.resolveImport(textDocument.uri, impM[1]);
          if (file) {
            try {
              const target = analyze(readFileSync(file, 'utf8'));
              for (const p of target.props) {
                items.push({ label: p.name, kind: 5, detail: `prop of ${impM[1]}`, sortText: `0${p.name}` });
              }
            } catch { /* unreadable target — just skip props */ }
          }
        }
        items.push(...directiveCompletions().map((c) => ({ ...c, kind: 14 })));
        return { isIncomplete: false, items };
      }
      return null; // inside an attribute value — no completions
    }

    // After an unclosed `{` in text? Complete script symbols.
    const braceOpen = text.lastIndexOf('{', offset - 1);
    if (braceOpen > -1 && braceOpen > text.lastIndexOf('}', offset - 1) && offset - braceOpen < 200) {
      return { isIncomplete: false, items: symbolItems() };
    }
    return null;
  }

  // ── hover ────────────────────────────────────────────────────────────────

  hover({ textDocument, position }) {
    const doc = this.docs.get(textDocument.uri);
    if (!doc) return null;
    const { text, analysis } = doc;
    const offset = positionToOffset(text, position);
    const { word, start, end } = wordAt(text, offset);
    if (!word) return null;
    const md = (value) => ({
      contents: { kind: 'markdown', value },
      range: range(text, start, end),
    });

    const s = analysis.script;
    const inScript = s && offset >= s.start && offset <= s.end;

    if (inScript) {
      if (word === '$' || word.startsWith('$:')) return md(`**\`$:\`** — ${SCRIPT_BUILTINS['$:']}`);
      if (SCRIPT_BUILTINS[word]) return md(`**\`${word}\`** — ${SCRIPT_BUILTINS[word]}`);
    } else {
      const d = directiveDoc(word.replace(/=.*$/, ''));
      if (d) return md(`**\`${d.label}\`** · ${d.detail}\n\n${d.doc}`);
    }

    const bare = word.match(/[A-Za-z_$][\w$]*/)?.[0];
    const decl = bare && analysis.declarations.get(bare);
    if (decl) {
      const label = {
        prop: `prop — \`export let ${bare}\` (overridable from the import placeholder)`,
        let: `component state — \`let ${bare}\` (reactive)`,
        function: `function \`${bare}()\``,
        reactive: `derived — \`$: ${bare} = …\` (recomputed on every change)`,
        import: `imported binding \`${bare}\``,
      }[decl.kind];
      return md(label);
    }
    if (analysis.isSSRPage && bare) {
      if (SSR_BUILTINS[bare]) return md(`**\`${bare}\`** — ${SSR_BUILTINS[bare]}`);
      if (analysis.ssrVars.has(bare)) {
        return md(`**\`${bare}\`** — spark-ssr page data, inferred from this page's \`<spark-ssr>\`.`);
      }
    }
    return null;
  }

  // ── definition ───────────────────────────────────────────────────────────

  definition({ textDocument, position }) {
    const doc = this.docs.get(textDocument.uri);
    if (!doc) return null;
    const { text, analysis } = doc;
    const offset = positionToOffset(text, position);

    // On an import="…" value → the component file.
    for (const tag of analysis.importTags) {
      if (offset >= tag.tagStart && offset <= (tag.tagEnd === -1 ? text.length : tag.tagEnd)) {
        const file = this.resolveImport(textDocument.uri, tag.path);
        if (file) {
          return {
            uri: pathToFileURL(file).href,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          };
        }
      }
    }

    // On an identifier → its declaration in this component.
    const { word } = wordAt(text, offset);
    const bare = word.match(/[A-Za-z_$][\w$]*/)?.[0];
    const decl = bare && analysis.declarations.get(bare);
    if (decl && decl.offset !== undefined) {
      return {
        uri: textDocument.uri,
        range: range(text, decl.offset, decl.offset + bare.length),
      };
    }
    return null;
  }
}

// ── stdio transport (Content-Length framing) ───────────────────────────────

export function connectStdio() {
  const server = new SparkLanguageServer({
    send: (msg) => {
      const body = JSON.stringify(msg);
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    },
  });
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString();
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!length || buffer.length < headerEnd + 4 + length) return;
      const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString();
      buffer = buffer.slice(headerEnd + 4 + length);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (msg.method === 'exit') process.exit(0);
      server.handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return server;
}
