# Spark for Zed

[spark-html](https://github.com/wilkinnovo/spark-html) single-file component support
for [Zed](https://zed.dev), with **full highlighting**:

- **`{interpolation}`** highlighted as JavaScript — `{count * 2}`, `{ok ? a : b}`.
- `<script>` as JavaScript, `<style>` as CSS.
- HTML tags, attributes, and comments.

It's backed by the well-tested **tree-sitter-svelte** grammar — Spark components
are syntactically a near-subset of Svelte (HTML + `{expr}` + `<script>`/`<style>`),
so interpolations get real grammar nodes and highlight correctly. (Spark uses
`<template if/each/await>` instead of Svelte's `{#if}` blocks, so none of the
Svelte-specific block syntax appears.)

Because highlighting is **grammar-based**, the full current Spark surface works
with no extra configuration — it's all HTML attributes plus injected JS:

- Directives: `:attr` (`:disabled`, `:class`, `:style`), `bind:value` /
  `bind:checked` / `bind:group` / **`bind:form`**, `on*` handlers, `import`,
  `each` / `if` / `await` / `then` / `catch` / `key` / `slot` on `<template>`.
- In `<script>` and every `{interpolation}`: the runtime API and store helpers —
  `useStore`, `store`, **`derived`**, `onMount`, **`query`** (from
  `spark-html-query`) — highlight as ordinary JavaScript.

New runtime/package features therefore need no extension update to highlight.

## Install (dev extension)

1. Zed → command palette → **`zed: install dev extension`**
2. Select this `editors/zed` folder.

Zed fetches the grammar pinned in `extension.toml` and loads the queries in
`languages/spark/`.

## Format on save

Spark is a **hybrid** syntax: HTML-style quoted attributes (`:value="x"`,
`onclick="{fn}"`) plus Svelte-style `{interpolations}`. No off-the-shelf
Prettier parser handles both safely — Prettier's `html` parser rewrites
`onclick="{fn}"` into broken multi-line JS and word-wraps string literals
*inside* `{…}`, and its `svelte` parser flat-out rejects `:attr="…"`. Either one
can silently produce invalid Spark.

So Spark ships its own Prettier plugin,
[`prettier-plugin-spark`](https://www.npmjs.com/package/prettier-plugin-spark):
it formats the embedded **`<script>` (JS) and `<style>` (CSS)** blocks and
leaves your **markup byte-for-byte untouched** — exactly in line with Spark's
“the file you write is what runs.” Your `{…}` and `onclick="{…}"` can never be
corrupted.

The extension already sets `prettier_parser_name = "spark"`; enable Prettier +
the plugin once in your Zed `settings.json`:

```json
{
  "languages": {
    "Spark": {
      "prettier": {
        "allowed": true,
        "plugins": ["prettier-plugin-spark"]
      }
    }
  }
}
```

That's it — Zed bundles Prettier and installs the listed plugin automatically,
and `format_on_save` is already `"on"` by Zed default, so saving a `.html` Spark
component formats its script/style and preserves the markup. (Prefer your own
formatter? Point `"formatter"` at an external command in the same block.)

## Publish (Zed extension registry)

There's no `zed publish` CLI — it's a registry PR:

1. Fork **`zed-industries/extensions`**.
2. Add this repo as a git submodule under `extensions/` and an entry in
   `extensions.toml` pointing at the `editors/zed` directory + this version.
3. Open a PR; Zed CI builds and lists it.

`path_suffixes = ["html"]` makes Zed treat all `.html` files as Spark while the
extension is enabled — scope it to your components directory if you prefer.
