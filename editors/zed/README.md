# Spark for Zed

[spark-html](https://github.com/wilkinnovo/spark) single-file component support
for [Zed](https://zed.dev), with **full highlighting**:

- **`{interpolation}`** highlighted as JavaScript — `{count * 2}`, `{ok ? a : b}`.
- `<script>` as JavaScript, `<style>` as CSS.
- HTML tags, attributes, and comments.

It's backed by the well-tested **tree-sitter-svelte** grammar — Spark components
are syntactically a near-subset of Svelte (HTML + `{expr}` + `<script>`/`<style>`),
so interpolations get real grammar nodes and highlight correctly. (Spark uses
`<template if/each/await>` instead of Svelte's `{#if}` blocks, so none of the
Svelte-specific block syntax appears.)

## Install (dev extension)

1. Zed → command palette → **`zed: install dev extension`**
2. Select this `editors/zed` folder.

Zed fetches the grammar pinned in `extension.toml` and loads the queries in
`languages/spark/`.

## Publish (Zed extension registry)

There's no `zed publish` CLI — it's a registry PR:

1. Fork **`zed-industries/extensions`**.
2. Add this repo as a git submodule under `extensions/` and an entry in
   `extensions.toml` pointing at the `editors/zed` directory + this version.
3. Open a PR; Zed CI builds and lists it.

`path_suffixes = ["html"]` makes Zed treat all `.html` files as Spark while the
extension is enabled — scope it to your components directory if you prefer.
