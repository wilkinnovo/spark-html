# spark-html-language-server

Language server (LSP) for [Spark](https://github.com/wilkinnovo/spark) single-file
`.html` components. Zero dependencies, speaks LSP over stdio.

## What you get

- **Diagnostics**, live as you type:
  - `{binding}` used in the template but never declared in `<script>`
  - JS imports that are never used
  - script syntax errors (the exact code the runtime would execute)
  - `<div import="…">` pointing at a component file that doesn't exist
  - `each` without `key=` (hint — keyed reconciliation is opt-in)
  - malformed `each` expressions
- **Go-to-definition** — jump from `<div import="components/card">` to
  `card.html`, and from any `{symbol}` to its `let` / `function` / `$:` /
  `export let` declaration.
- **Autocomplete**
  - props on import placeholders, read from the target component's
    `export let` declarations
  - every template directive (`each`, `if`/`else-if`/`else`, `await`/`then`/`catch`,
    `bind:value|checked|group|form`, `:hidden`-style dynamic attributes, `key`,
    `route`, `transition:fade|slide|scale`, `spark-ignore`)
  - script symbols and Spark builtins (`useStore`, `onMount`, `props`) inside
    `{…}` and `<script>`
- **Hover docs** for every directive and declaration.

## Install

```bash
npm install -g spark-html-language-server
```

The `spark-html-language-server` binary starts the server on stdio — the
transport every LSP client speaks.

## VS Code

Install the **Spark (spark-html)** extension from
[`editors/vscode`](https://github.com/wilkinnovo/spark/tree/main/editors/vscode) —
it bundles syntax highlighting and launches this server automatically (globally
installed binary, or `node_modules/.bin` in your project).

## Programmatic use

The analyzer is exported for tooling:

```js
import { analyze } from 'spark-html-language-server';

const { declarations, props, diagnostics } = analyze(componentSource);
```

## Scope (v0.x)

The server analyzes one component at a time — the same boundary the runtime
has. It does not type-check across files (props completion reads the target
file's `export let` names, not their types), and remote URL imports are not
resolved.

## License

MIT
