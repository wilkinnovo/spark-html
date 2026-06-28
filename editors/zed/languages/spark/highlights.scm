; Spark components — backed by the tree-sitter-svelte grammar.

; HTML structure
(tag_name) @tag
(attribute_name) @attribute
(quoted_attribute_value) @string
(attribute_value) @string
(comment) @comment
(doctype) @constant

[
  "<"
  ">"
  "</"
  "/>"
] @punctuation.bracket

"=" @operator

; {interpolation} — the braces; the expression inside is injected as JavaScript.
(expression
  "{" @punctuation.special
  "}" @punctuation.special)

; Block keywords (rare in Spark — it uses <template if/each/await> — but free).
[
  "if"
  "else"
  "each"
  "await"
  "then"
  "catch"
  "as"
  "key"
  "html"
  "const"
] @keyword
