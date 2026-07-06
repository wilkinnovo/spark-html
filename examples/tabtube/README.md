# TabTube

A YouTube search-and-watch app built the spark way — `create-spark-html-app ssr`, **no
database**. Search and autocomplete come from [youtubei.js](https://www.npmjs.com/package/youtubei.js)
(wraps YouTube's own InnerTube API, no API key) as plain `<spark-ssr>` MODULE sources
(`lib/search.js`, `lib/suggestion.js`), no custom `api/*.html` endpoints.

- **Search** the left sidebar; results render server-side for a shareable `/?q=...` URL, and
  re-search client-side (no reload, live as you type) via spark-ssr's own ambient `refresh()`.
- **Infinite scroll** — scrolling near the bottom of the results asks for another combined page
  (a real `IntersectionObserver`, no polling).
- **Autocomplete** as you type, debounced — `refresh()` re-fetches `suggestions` alongside
  `results` in the same call.
- **Tabs** — clicking a result opens it in a browser-style tab (hence the name); switching tabs
  pauses the outgoing video and resumes the incoming one from wherever IT left off — a single
  custom-chrome YouTube player (IFrame Player API, `controls: 0` + our own play/pause/seek/
  mute/fullscreen bar) that survives tab switches instead of one iframe per tab.
  (`components/tab-strip.html`, `components/video-player.html`)
- **My Lists** — save/unsave videos, persisted across reloads via `spark-html-persist`.
- **Filters** — All / Today / This week / This month, computed client-side from relative
  "3 days ago"-style timestamps.

## Structure

Real `<div import="...">` component composition for the pieces that are either genuinely
local or store-driven: `components/tab-strip.html`, `components/search-box.html`,
`components/video-player.html`, `components/theme-toggle.html`. Cross-component state
(open tabs, the active video, the current filter, the "My Lists" toggle, live suggestions)
lives in a shared `useStore('tabtube')` (`public/app.js`), not passed down as props through
several layers.

The results list, filters row, and "My Lists" toggle are the one exception — inlined directly
in `pages/index.html` rather than split into their own component, because `results` needs to
render for real at SSR (a shareable, no-JS `/?q=...` URL) AND reflect a live `refresh()` — and
an import node's props are evaluated once at mount and never revisited. See `bugs2.md` #2.

No database, no build step, no DOM manipulation outside spark-html and its companion
packages (`spark-html-theme`, `spark-html-persist`).

## Run it

```bash
bun install
bun run dev
```

See `bugs.md`, `bugs2.md`, and `bugs3.md` for everything found (and fixed, framework-side)
while building this — including a critical, general `spark-html` reactivity bug (`bugs3.md`
#1: an each-loop nested in a `<template if>` could permanently stop reconciling after an
unrelated sibling change) found and fixed while adding infinite scroll.
