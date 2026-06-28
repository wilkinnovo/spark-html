# spark-html-motion

Declarative **enter / leave transitions** for
[spark-html](https://github.com/wilkinnovo/spark) — the Spark way: no compiler,
no virtual DOM, 0 dependencies (~0.5 KB). When an `<template if>` / `<template
each>` block adds or removes an element, it animates in/out. A leaving element
is held in the DOM until its exit animation finishes, then removed.

## Install

```sh
npm install spark-html-motion
```

## Use

Register once, **before `mount()`**, then opt elements in with a `transition`
attribute:

```js
import { mount } from 'spark-html';
import { motion } from 'spark-html-motion';

motion();
mount(document.body);
```

```html
<template each="t in todos">
  <li transition="slide">{t.text}</li>
</template>

<template if="open">
  <div class="panel" transition="fade">…</div>
</template>
```

- `transition="fade | slide | scale"` — or the directive form `transition:fade`.
- `transition-duration="300"` — milliseconds (per element).
- `transition-easing="ease-out"` — any CSS easing (per element).

The **initial render is not animated** by default (only later enters/leaves) —
pass `motion({ appear: true })` if you want the first paint to animate too.
`prefers-reduced-motion: reduce` is honored automatically (no animation).

## Options & defaults

```js
motion({
  preset: 'fade',   // default preset for a bare `transition` attribute
  duration: 200,    // ms
  easing: 'ease',
  appear: false,    // animate the initial mount?
});
```

## Custom presets

`presets` is a plain object of `{ in: Keyframe[], out: Keyframe[] }` (standard
[Web Animations](https://developer.mozilla.org/docs/Web/API/Element/animate)
keyframes) — add your own:

```js
import { presets, motion } from 'spark-html-motion';
presets.zoom = {
  in: [{ transform: 'scale(0)' }, { transform: 'scale(1)' }],
  out: [{ transform: 'scale(1)' }, { transform: 'scale(0)' }],
};
motion();
// <li transition="zoom">…</li>
```

## How it works

Spark core exposes a tiny `lifecycle({ enter, leave })` seam; this package
registers into it and drives the Web Animations API. Nothing animates unless you
call `motion()`, and elements without a `transition` attribute are added/removed
instantly — so the cost is strictly opt-in.

## License

MIT © Wilkin Novo
