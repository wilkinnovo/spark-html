; <script> → JavaScript, <style> → CSS, and every {interpolation} → JavaScript.
(script_element
  (raw_text) @injection.content
  (#set! injection.language "javascript"))

(style_element
  (raw_text) @injection.content
  (#set! injection.language "css"))

((svelte_raw_text) @injection.content
  (#set! injection.language "javascript"))

; <spark-ssr> block bodies are SQL (with :params) — inject the SQL grammar
; so `me = SELECT … FROM users WHERE id = :session.id` reads like SQL, not
; plain text. (URL/glob/module source lines pass through SQL highlighting
; harmlessly.) Requires a SQL language/extension in Zed; silently plain
; text otherwise. Same block grammar as spark-ssr parseBody /
; prettier-plugin-spark / the LSP semantic tokens — keep in sync.
((element
   (start_tag (tag_name) @_spark_ssr_tag)
   (text) @injection.content)
 (#eq? @_spark_ssr_tag "spark-ssr")
 (#set! injection.language "sql"))
