# spark-html-test-utils

Test helpers for [spark-html](https://www.npmjs.com/package/spark-html): mount a
component on [linkedom](https://github.com/WebReflection/linkedom), inspect its
reactive scope, and fire realistic DOM events — no browser, no build step.

This is the harness every spark-html debugging session hand-rolls, made
reusable. For component-level logic it's all you need. For hydration and
real-DOM-lifecycle behavior (detached hosts, event delegation timing), test in a
real browser.

```bash
npm i -D spark-html-test-utils   # linkedom comes with it; spark-html is a peer
```

## mount(fixture) → handle

```js
import { mount, fireClick } from 'spark-html-test-utils';

const h = await mount({
  root: '<div import="counter"></div>',
  components: {
    counter: '<button onclick={inc}>{n}</button><script>let n = 0; function inc(){ n++; }</script>',
  },
});

fireClick(h.query('button'));
await h.settle();
console.assert(h.query('button').textContent === '1');
h.cleanup();
```

`fixture` is a markup string (the `<body>`), or `{ root, components?, url? }`:

| field | meaning |
|---|---|
| `root` | markup placed in `<body>` — usually a `<div import="…">` host |
| `components` | `{ name: source }` registered with `component()` before mount |
| `url` | the location the runtime sees (default `http://localhost/`) |

The handle:

| member | what it gives you |
|---|---|
| `query(sel)` / `queryAll(sel)` | `document.querySelector[All]` over the mounted tree |
| `el` | the first booted component host (its `name` element) |
| `scope(el?)` | the reactive scope proxy — **read and write it** to drive/inspect state |
| `deps(node)` | the node's tracked dependency keys (`Set` or `null`) |
| `html()` | current `<body>` HTML — the serialized render |
| `settle()` | drain microtasks + rAF timers so reactive updates land before you assert |
| `cleanup()` | tear down components (drop store subscriptions) and restore globals |

`scope` and `deps` are the core `inspect` API (also re-exported), reading the
same `__spark*` internals as `spark-html-devtools` — a supported window.

## Event helpers

The runtime binds handlers with `addEventListener`, so a dispatched event with
the right type fires them; extra props ride on the event object the handler
receives, and events bubble (so `document`-delegated handlers fire too).

```js
import { fire, fireClick, fireInput, fireChange, fireToggle, fireKey, fireSubmit, fireDrag } from 'spark-html-test-utils';

fireClick(el);
fireInput(input, 'typed');       // sets value, fires input (drives bind:value)
fireToggle(checkbox, true);      // sets checked, fires change (drives bind:checked)
fireKey(input, 'Enter');         // keydown with event.key = 'Enter'
fireDrag(box, { from: { x: 0, y: 0 }, to: { x: 40, y: 8 } }); // pointerdown→move→up (+mouse), with clientX/Y
fire(el, 'focus', { detail: 1 });// anything else
```

## Recipe

- **Component logic** — linkedom mount here. Fast, deterministic, no browser.
- **SSR / hydration** — run the real server and drive a real browser (see the
  spark-html repo's debugging workflow); linkedom can't model everything a
  hydrating page does.

## License

MIT
