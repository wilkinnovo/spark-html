# Editor support for Spark

Syntax highlighting — and, in VS Code, full language-server features — for
`spark-html` single-file components.

| Editor | Folder | `{…}` highlighting | LSP (diagnostics, go-to-def, completion, hover) | Format on save | Notes |
|--------|--------|--------------------|------------------------------------------------|----------------|-------|
| VS Code | [`vscode/`](vscode) | ✅ (TextMate injection) | ✅ (`spark-html-language-server`) | — | Layers on built-in HTML; launches the language server in Spark workspaces. Package with `vsce`. |
| Zed | [`zed/`](zed) | ✅ (tree-sitter-svelte) | — | ✅ (`prettier-plugin-spark`) | Reuses the Svelte grammar (Spark is a syntactic subset); install as a dev extension. Formatting uses the dedicated plugin (formats `<script>`/`<style>`, leaves markup intact) — enable it once, see its README. |

Both keep components as plain `.html` — no new file extension, in line with
Spark's "the file you write is what runs" principle. See each folder's README to
install.
