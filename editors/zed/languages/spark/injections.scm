; <script> → JavaScript, <style> → CSS, and every {interpolation} → JavaScript.
(script_element
  (raw_text) @injection.content
  (#set! injection.language "javascript"))

(style_element
  (raw_text) @injection.content
  (#set! injection.language "css"))

((svelte_raw_text) @injection.content
  (#set! injection.language "javascript"))
