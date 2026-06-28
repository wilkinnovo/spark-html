# prettier-plugin-spark

[Prettier](https://prettier.io) plugin for
[spark-html](https://github.com/wilkinnovo/spark) single-file components.

## Why a dedicated plugin

Spark components are a **hybrid** syntax — HTML-style quoted attributes
(`:value="x"`, `onclick="{fn}"`) **and** Svelte-style `{interpolations}`. No
built-in Prettier parser handles both without breaking your code:

- The **`html`** parser treats `onclick="{fn}"` as a JS event attribute and
  rewrites it into broken multi-line JS, and it word-wraps string literals
  **inside** `{…}` (changing their value).
- The **`svelte`** parser rejects Spark's quoted `:attr="…"` / `bind:x="…"`.

Both can silently produce **invalid Spark**.

## What it does

It honours Spark's core promise — *the markup you write is what runs* — by
formatting only what's safe to format:

- **`<script>`** → formatted as JavaScript (Prettier `babel`).
- **`<style>`** → formatted as CSS (Prettier `css`).
- **Everything else (your markup)** → left **byte-for-byte untouched**.

So `{interpolations}`, `onclick="{handlers}"`, `:bindings`, `<template if/each>`
— none of it can ever be mangled. It's idempotent, and if a `<script>`/`<style>`
block can't be parsed it's left as-is rather than failing the whole file.

## Install

```sh
npm install --save-dev prettier prettier-plugin-spark
```

## Use

Spark components use the `.html` extension, so select the plugin's `spark` parser
for them. In `.prettierrc`:

```json
{
  "plugins": ["prettier-plugin-spark"],
  "overrides": [
    { "files": "*.html", "options": { "parser": "spark" } }
  ]
}
```

```sh
npx prettier --write "src/**/*.html"
```

(If you also have non-Spark `.html` files, scope the override to your components
directory, e.g. `"files": "components/**/*.html"`.)

### Zed

The [Spark Zed extension](https://github.com/wilkinnovo/spark/tree/main/editors/zed)
already sets `prettier_parser_name = "spark"`. Enable Prettier + this plugin for
the `Spark` language once in your Zed `settings.json`:

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

Format-on-save is on by Zed default, so saving a component formats its
script/style and preserves the markup.

## License

MIT © Wilkin Novo
