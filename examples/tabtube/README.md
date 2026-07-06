# TabTube

A YouTube search-and-watch app built the spark way — `create-spark-html-app ssr`, **no
database**. Search results come from [yt-search](https://www.npmjs.com/package/yt-search)
(no API key needed); autocomplete comes from
[youtube-suggest](https://www.npmjs.com/package/youtube-suggest).

- **Search** the left sidebar; results render server-side for a shareable `/?q=...` URL,
  and re-search client-side (no reload) after that.
- **Autocomplete** as you type, debounced, via a custom `/api/suggest` endpoint.
- **Tabs** — clicking a result opens it in a browser-style tab (hence the name); switch
  or close tabs without losing your search.
- **My Lists** — save/unsave videos, persisted across reloads via `spark-html-persist`.
- **Filters** — All / Today / This week / This month, computed client-side from
  yt-search's relative "3 days ago"-style timestamps.

No database, no build step, no DOM manipulation outside spark-html and its companion
packages (`spark-html-theme`, `spark-html-persist`).

## Run it

```bash
bun install
bun run dev
```

See `bugs.md` for everything found (and fixed, framework-side) while building this.
