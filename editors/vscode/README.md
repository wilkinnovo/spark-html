# Spark for VS Code

Syntax highlighting **and language-server features** for
[spark-html](https://github.com/wilkinnovo/spark) single-file components.

## Highlighting

An **injection grammar** layered on top of VS Code's built-in HTML, so `.html`
components keep full HTML/CSS/JS highlighting and gain:

- **`{interpolations}`** highlighted as JavaScript — `{count * 2}`, `{ok ? a : b}`.
- `\{` escaped braces are left as literal text.
- `<script>` reactive statements (`$:`), `bind:`, `:attr`, `on*`, and `import`
  attributes get the editor's normal JS / attribute highlighting.

## Language server (new in 0.2.0)

The extension launches
[`spark-html-language-server`](https://www.npmjs.com/package/spark-html-language-server)
and you get, live in the editor:

- **Diagnostics** — undefined `{bindings}`, unused JS imports, script syntax
  errors, `<div import>` targets that don't exist, `each` without `key=`.
- **Go-to-definition** — from `<div import="components/card">` to `card.html`;
  from any `{symbol}` to its declaration.
- **Autocomplete** — props on import placeholders (read from the target's
  `export let`), every template directive (`each`, `if`, `await`, `bind:value`,
  `:hidden`, `transition:fade`, `route`, …), and script symbols in `{…}`.
- **Hover docs** for every directive and declaration.

The server binary comes from the npm registry — either per project (preferred; the
extension finds it in `node_modules`) or globally:

```bash
bun add -d spark-html-language-server   # in your project
# or
bun add -g spark-html-language-server
```

By default the client only starts in workspaces that depend on `spark-html`
(so plain-HTML projects see zero noise). Force it with the `spark.lsp.enable`
setting (`auto` / `on` / `off`).

## Install (from source)

VS Code can't run from a folder directly — package it once with `vsce`:

```bash
cd editors/vscode
bun install                       # pulls vscode-languageclient
bunx @vscode/vsce package          # produces spark-html-0.2.0.vsix
code --install-extension spark-html-0.2.0.vsix
```

## Notes

- The injection is scoped `L:text.html -comment -(meta.embedded | source)` so it
  never touches CSS `{}` blocks or `<script>`/`<style>` bodies.
- Component `<script>`/`<style>` are already highlighted by VS Code's HTML
  grammar; this extension only adds the Spark-specific `{…}` layer.
