/**
 * Blog posts for /blog. Lives in bundled app JS (not a component <script>)
 * for the same reason as tutorial-lessons.js: body HTML here contains
 * {curly} example text and code fences that the component script rewriter
 * (string-scanner, not a parser) shouldn't have to navigate. The blog-post
 * component renders `body` with spark-ignore, same treatment as the docs.
 */

export const BLOG_POSTS = [
  {
    slug: '1-8-1-bind-write-back-ordering',
    title: 'v1.8.1 — a same-event bind + handler ordering fix',
    date: '2026-07-12',
    tag: 'Fix',
    excerpt: 'A bind and an onXXX handler on the same event could fire in the wrong order, so the handler saw the stale value instead of the write-back. Binds now wire first.',
    body: `
<p><strong>spark-html 1.8.1</strong> is a small, focused patch: it fixes the
order two kinds of listeners get wired onto the same element when they share
an event.</p>

<h2 id="the-bug">The bug</h2>
<p>Spark supports two ways to react to an event on the same element — a
<code>bind:</code> (e.g. <code>bind:checked</code>) that writes a DOM value
back into your state, and a plain <code>onXXX</code> handler for your own
logic. Write both on the same event and you'd reasonably expect your handler
to see the state <em>after</em> the bind has written back — that's the whole
point of a two-way bind.</p>

<pre><code>&lt;input type="checkbox" bind:checked="agreed" onchange="{track}" /&gt;

&lt;script&gt;
  let agreed = false;
  function track() {
    // expected: agreed already reflects the new checkbox state
  }
&lt;/script&gt;</code></pre>

<p>Internally, <code>wireElement()</code> registered a component's declared
<code>onXXX</code> handlers before its binds. The DOM fires same-type
listeners in registration order, so <code>track()</code> could run
<em>before</em> the bind's write-back had updated <code>agreed</code> —
the handler observed the pre-write-back value on that first tick.</p>

<h2 id="the-fix">The fix</h2>
<p>The fix is a three-line reorder in
<a href="https://github.com/wilkinnovo/spark-html/blob/main/packages/spark/src/index.js" target="_blank" rel="noopener"><code>packages/spark/src/index.js</code></a>:
binds wire before handlers, unconditionally, so registration order always
puts the write-back first.</p>

<pre><code>// binds wire BEFORE handlers: a same-event onXXX (onchange={…} beside
// bind:checked=…) must observe the write-back's new value, not the stale
// one — DOM fires same-type listeners in registration order.
for (const b of a.binds) { /* … */ }
for (const h of a.handlers) { /* … */ }</code></pre>

<p>No new concepts, no API surface change, no size cost — this is exactly
the kind of fix the <a href="{app.base}/docs#limits">limits table</a> and
this changelog exist for: name the bug precisely, fix it, ship it, move
on.</p>

<h2 id="verifying">Verifying it</h2>
<p>Every core change here runs the full suite before it ships — 500 fuzz
scenarios, the scanner fuzzer, <code>spark-html doctor</code>, the snippet
and ecosystem checks, and the gzip budget gate — plus a manual convergence
check for the ordering itself. All green:</p>

<pre><code>500 passed, 0 failed (500 scenarios, 29 corpus)
scanner-fuzz: 200 passed, 0 failed
spark-html runtime: 17.93 KB gzip · budget 18 KB
✅ within budget</code></pre>

<h2 id="upgrade">Upgrading</h2>
<p>1.8.1 is a pure bug fix with no breaking changes — bump your
<code>spark-html</code> range and you're done:</p>
<pre><code>npm install spark-html@^1.8.1</code></pre>

<p>Full details: <a href="https://www.npmjs.com/package/spark-html" target="_blank" rel="noopener">spark-html on npm</a> · <a href="https://github.com/wilkinnovo/spark-html/releases/tag/v1.8.1" target="_blank" rel="noopener">v1.8.1 on GitHub</a>.</p>
`,
  },
];
