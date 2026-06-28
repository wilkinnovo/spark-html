# Editor support for Spark

Syntax highlighting for `spark-html` single-file components.

| Editor | Folder | `{…}` highlighting | Format on save | Notes |
|--------|--------|--------------------|----------------|-------|
| VS Code | [`vscode/`](vscode) | ✅ (TextMate injection) | — | Layers on built-in HTML; package with `vsce`. |
| Zed | [`zed/`](zed) | ✅ (tree-sitter-svelte) | ✅ (bundled Prettier) | Reuses the Svelte grammar (Spark is a syntactic subset); install as a dev extension. Enable Prettier for `Spark` once — see its README. |

Both keep components as plain `.html` — no new file extension, in line with
Spark's "the file you write is what runs" principle. See each folder's README to
install.
