/**
 * Tiny syntax highlighter for Spark code samples.
 * Tokenizes the HTML+JS hybrid that Spark components are written in and
 * wraps tokens in colored spans. Runs once after mount over every
 * <pre> on the page (skipping any already processed).
 */

const JS_KEYWORDS =
  /\b(let|const|var|function|return|if|else|for|while|new|async|await|import|export|from|default|typeof|true|false|null|undefined|class|of|in)\b/g;

function span(cls, text) {
  return `<span class="tok-${cls}">${text}</span>`;
}

function highlightJS(code) {
  const out = [];
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);

    // comments
    const comment = rest.match(/^\/\/[^\n]*/);
    if (comment) {
      out.push(span('comment', comment[0]));
      i += comment[0].length;
      continue;
    }
    // strings (template, single, double)
    const str = rest.match(/^(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/);
    if (str) {
      out.push(span('string', str[0]));
      i += str[0].length;
      continue;
    }
    // reactive label
    const reactive = rest.match(/^\$:/);
    if (reactive) {
      out.push(span('reactive', '$:'));
      i += 2;
      continue;
    }
    // numbers
    const num = rest.match(/^\d+(\.\d+)?/);
    if (num) {
      out.push(span('number', num[0]));
      i += num[0].length;
      continue;
    }
    // identifiers / keywords / builtins
    const word = rest.match(/^[a-zA-Z_$][\w$]*/);
    if (word) {
      const w = word[0];
      if (new RegExp(`^(${JS_KEYWORDS.source.slice(2, -2)})$`).test(w)) {
        out.push(span('keyword', w));
      } else if (w === 'useStore' || w === 'onMount' || w === 'props') {
        out.push(span('builtin', w));
      } else if (code[i + w.length] === '(') {
        out.push(span('fn', w));
      } else {
        out.push(w);
      }
      i += w.length;
      continue;
    }
    out.push(code[i]);
    i += 1;
  }
  return out.join('');
}

function highlightTagBody(body) {
  // body is the inside of a tag: name, attributes, values
  return body.replace(
    /([\w:-]+)(=)("(?:[^"]*)")?/g,
    (m, attr, eq, val) => {
      let out = span('attr', attr) + eq;
      if (val) {
        // highlight {bindings} inside attribute values
        const inner = val.slice(1, -1).replace(/\{([^}]*)\}/g, (_, b) =>
          span('binding', '{' + b + '}'),
        );
        out += span('string', '"' + inner + '"');
      }
      return out;
    },
  );
}

function highlightHTML(escapedSource) {
  // works on &lt;-escaped source — tags appear as &lt;tag …&gt;
  let out = '';
  let i = 0;
  const src = escapedSource;

  while (i < src.length) {
    // script block: highlight contents as JS
    const scriptOpen = src.slice(i).match(/^&lt;script&gt;/);
    if (scriptOpen) {
      const end = src.indexOf('&lt;/script&gt;', i);
      const inner = src.slice(i + scriptOpen[0].length, end === -1 ? src.length : end);
      out += span('tag', '&lt;script&gt;');
      out += highlightJS(inner);
      if (end !== -1) {
        out += span('tag', '&lt;/script&gt;');
        i = end + '&lt;/script&gt;'.length;
      } else {
        i = src.length;
      }
      continue;
    }
    // comments
    const comment = src.slice(i).match(/^&lt;!--[\s\S]*?--&gt;/);
    if (comment) {
      out += span('comment', comment[0]);
      i += comment[0].length;
      continue;
    }
    // tags
    const tag = src.slice(i).match(/^&lt;(\/?)([\w-]+)((?:[^&]|&(?!gt;))*?)(\/?)&gt;/);
    if (tag) {
      const [full, close, name, body, selfClose] = tag;
      out +=
        span('punct', '&lt;' + close) +
        span('tag', name) +
        highlightTagBody(body) +
        span('punct', selfClose + '&gt;');
      i += full.length;
      continue;
    }
    // text bindings
    const binding = src.slice(i).match(/^\{[^}\n]*\}/);
    if (binding) {
      out += span('binding', binding[0]);
      i += binding[0].length;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

export function highlightAll() {
  document.querySelectorAll('pre').forEach((pre) => {
    if (pre.__highlighted) return;
    pre.__highlighted = true;

    // preserve the filename header if present
    const fname = pre.querySelector('.fname');
    let header = '';
    if (fname) {
      header = fname.outerHTML;
      fname.remove();
    }

    // innerHTML here is already &lt;-escaped where the sample contains tags
    const source = pre.innerHTML;
    pre.innerHTML = header + highlightHTML(source);
  });

  // inject token colors once
  if (!document.getElementById('spark-hl')) {
    const s = document.createElement('style');
    s.id = 'spark-hl';
    // Brand-matched + theme-aware: amber for the Spark-y tokens (keywords,
    // bindings, builtins, $:), neutral greys for everything else.
    s.textContent = `
      .tok-tag      { color: var(--text); }
      .tok-punct    { color: var(--muted-dim); }
      .tok-attr     { color: var(--muted); }
      .tok-string   { color: var(--muted); }
      .tok-binding  { color: var(--spark); font-weight: 600; }
      .tok-keyword  { color: var(--spark); }
      .tok-fn       { color: var(--text); }
      .tok-builtin  { color: var(--spark); }
      .tok-number   { color: var(--muted); }
      .tok-reactive { color: var(--spark); font-weight: 700; }
      .tok-comment  { color: var(--muted-dim); font-style: italic; }
    `;
    document.head.appendChild(s);
  }
}
