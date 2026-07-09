/**
 * Minimal DOM shim — just enough to run Spark end-to-end in Node.
 */
export class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = text; this.parentNode = null; }
  cloneNode() { return new TextNode(this.textContent); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  after(node) { Element.prototype.after.call(this, node); }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }
}

export class Element {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this._attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this._listeners = {};
    if (tagName.toLowerCase() === 'template') this.content = new Element('#fragment');
  }
  get attributes() {
    // Stable Attr node objects, like real browsers — expandos persist.
    if (!this._attrNodes) this._attrNodes = new Map();
    const out = [];
    for (const name of this._attrs.keys()) {
      if (!this._attrNodes.has(name)) {
        const self = name && this;
        const el = this;
        this._attrNodes.set(name, {
          name,
          get value() { return el._attrs.get(name); },
          set value(v) { el._attrs.set(name, v); },
        });
      }
      out.push(this._attrNodes.get(name));
    }
    return out;
  }
  setAttribute(n, v) {
    this._attrs.set(n, String(v));
    // real DOM: the value ATTRIBUTE only sets the default; once the
    // property has been touched, attribute changes don't reflect.
  }
  get value() {
    if (this.tagName !== 'INPUT' && this.tagName !== 'TEXTAREA') return this._value;
    if (this._valueDirty) return this._value ?? '';
    return this._attrs.get('value') ?? '';
  }
  set value(v) {
    this._valueDirty = true;
    this._value = String(v);
  }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  removeAttribute(n) { this._attrs.delete(n); }
  get dataset() {
    const out = {};
    for (const [k, v] of this._attrs) {
      if (k.startsWith('data-')) out[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    }
    return out;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.childNodes.find((n) => n.nodeType === 1) || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i > 0 ? this.parentNode.childNodes[i - 1] : null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === documentBody || n === documentHead || n.tagName === '#DOC';
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; }
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  after(node) {
    if (!this.parentNode) return;
    // Real DOM semantics: inserting a DocumentFragment splices its CHILDREN
    // in (in order) and leaves the fragment empty. Each node is REMOVED
    // before its insertion index is computed — a same-parent move from
    // before the cursor must not land one slot late.
    const kids = node.tagName === '#FRAGMENT' ? [...node.childNodes] : [node];
    let cur = this;
    for (const n of kids) {
      if (n.parentNode) n.parentNode.removeChild(n);
      const at = cur.parentNode.childNodes.indexOf(cur);
      n.parentNode = cur.parentNode;
      cur.parentNode.childNodes.splice(at + 1, 0, n);
      cur = n;
    }
  }
  replaceWith(node) {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this.parentNode;
    this.parentNode.childNodes[i] = node;
    this.parentNode = null;
  }
  cloneNode(deep) {
    const c = new Element(this.tagName);
    for (const [k, v] of this._attrs) c._attrs.set(k, v);
    if (deep) {
      for (const ch of this.childNodes) {
        const cc = ch.nodeType === 3 ? new TextNode(ch.textContent) : ch.cloneNode(true);
        c.appendChild(cc);
      }
      if (this.content) {
        c.content = new Element('#fragment');
        for (const ch of this.content.childNodes) {
          c.content.appendChild(ch.nodeType === 3 ? new TextNode(ch.textContent) : ch.cloneNode(true));
        }
      }
    }
    return c;
  }
  set innerHTML(html) {
    this.childNodes = [];
    if (this.content) this.content.childNodes = [];
    const target = this.tagName === 'TEMPLATE' ? this.content : this;
    parseHTML(html, target);
  }
  get innerHTML() { return serialize(this.childNodes); }
  set textContent(t) {
    // Real DOM: children are DETACHED (parentNode nulled) and '' leaves the
    // element empty rather than holding an empty text node.
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = t === '' ? [] : [new TextNode(String(t))];
  }
  get textContent() {
    return this.childNodes.map((n) => (n.nodeType === 3 ? n.textContent : n.textContent)).join('');
  }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  dispatch(type) {
    const event = { type, target: this };
    globalThis.window.event = event;
    globalThis.event = event;            // browsers: `event` is window.event
    let n = this;
    while (n) {
      (n._listeners?.[type] || []).forEach((fn) => fn(event));
      n = n.parentNode;
    }
    globalThis.window.event = undefined;
    globalThis.event = undefined;
  }
  querySelectorAll(sel) {
    // Supports: tag, .class, [attr], [attr="v"], tag[attr="v"],
    // :scope > X, descendant combinators "A B C", and comma lists "A, B".
    if (sel.includes(',')) {
      return [...new Set(sel.split(',').flatMap((p) => this.querySelectorAll(p.trim())))];
    }
    const scoped = sel.startsWith(':scope > ');
    const chain = (scoped ? sel.slice(9) : sel).trim().split(/\s+/);
    const collect = (root, simple, directOnly, out) => {
      for (const c of root.childNodes) {
        if (c.nodeType !== 1) continue;
        if (matchSimple(c, simple)) out.push(c);
        if (!directOnly) collect(c, simple, false, out);
      }
      return out;
    };
    let current = [this];
    for (let i = 0; i < chain.length; i++) {
      const next = [];
      for (const root of current) {
        collect(root, chain[i], scoped && i === 0, next);
      }
      current = [...new Set(next)];
    }
    return current;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return sel.split(',').some((p) => matchSimple(this, p.trim())); }
}

// one simple selector (no combinators/commas) against one element
function matchSimple(el, simple) {
  const mClass = simple.match(/^\.([\w-]+)$/);
  if (mClass) return (el.getAttribute('class') || '').split(/\s+/).includes(mClass[1]);
  const mAttrV = simple.match(/^(\w+)?\[([\w-]+)="([^"]*)"\]$/);
  if (mAttrV) {
    const [, tag, attr, v] = mAttrV;
    return (!tag || el.tagName === tag.toUpperCase()) && el.getAttribute(attr) === v;
  }
  const mAttr = simple.match(/^(\w+)?\[([\w-]+)\]$/);
  if (mAttr) {
    const [, tag, attr] = mAttr;
    return (!tag || el.tagName === tag.toUpperCase()) && el.hasAttribute(attr);
  }
  return el.tagName === simple.toUpperCase();
}

const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

export function parseHTML(html, parent) {
  let i = 0;
  const stack = [parent];
  while (i < html.length) {
    const top = stack[stack.length - 1];
    if (html[i] === '<') {
      if (html.startsWith('<!--', i)) { i = html.indexOf('-->', i) + 3; continue; }
      // Find > that ends this tag, skipping over quoted attribute values
      // so that > inside onclick="…" or similar doesn't truncate the tag.
      let close = i + 1;
      let inQuote = null;
      while (close < html.length) {
        const ch = html[close];
        if (inQuote) { if (ch === inQuote) inQuote = null; }
        else if (ch === '"' || ch === "'") inQuote = ch;
        else if (ch === '>') break;
        close++;
      }
      const raw = html.slice(i + 1, close);
      i = close + 1;
      if (raw.startsWith('/')) { stack.pop(); continue; }
      const selfClose = raw.endsWith('/');
      const inner = selfClose ? raw.slice(0, -1) : raw;
      const sp = inner.search(/[\s]/);
      const tag = (sp === -1 ? inner : inner.slice(0, sp)).toLowerCase();
      const el = new Element(tag);
      const attrStr = sp === -1 ? '' : inner.slice(sp);
      const attrRe = /([^\s=]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*\{([^}]*)\})?/g;
      let am;
      while ((am = attrRe.exec(attrStr)) !== null) {
        if (am[1]) el.setAttribute(am[1], am[2] ?? am[3] ?? am[4] ?? '');
      }
      (top.content && top.tagName === 'TEMPLATE' ? top.content : top).appendChild(el);
      if (!selfClose && !VOID.has(tag)) stack.push(el);
    } else {
      let next = html.indexOf('<', i);
      if (next === -1) next = html.length;
      const text = html.slice(i, next);
      if (text) (top.content && top.tagName === 'TEMPLATE' ? top.content : top).appendChild(new TextNode(text));
      i = next;
    }
  }
}

function serialize(nodes) {
  return nodes.map((n) => {
    if (n.nodeType === 3) return n.textContent;
    const attrs = [...n._attrs.entries()].map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${n.tagName.toLowerCase()}${attrs}>${serialize(n.childNodes)}</${n.tagName.toLowerCase()}>`;
  }).join('');
}

// ── global wiring ──
const documentHead = new Element('head');
const documentBody = new Element('body');
const doc = new Element('#doc');
doc.tagName = '#DOC';
doc.appendChild(documentHead);
doc.appendChild(documentBody);

globalThis.window = { event: undefined };
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
// Real listener registry (was a no-op): the core's internal event delegation
// wires stamped loop-row handlers on document, so tests must reach them.
const documentListeners = {};
globalThis.document = {
  readyState: 'complete',
  head: documentHead,
  body: documentBody,
  createElement: (t) => new Element(t),
  querySelector: (s) => doc.querySelector(s),
  querySelectorAll: (s) => doc.querySelectorAll(s),
  addEventListener: (t, fn) => { (documentListeners[t] ??= []).push(fn); },
  createDocumentFragment: () => new Element('#fragment'),
  __listeners: documentListeners, // test seam: capture-phase delegate dispatch in fire()
  _listeners: documentListeners,
};

export { documentBody as body, documentHead as head };
