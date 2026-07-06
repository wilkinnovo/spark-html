// A MODULE source (`results = ./lib/search.js` in pages/index.html) — the
// ONLY place the search call lives. The client's own re-search (typing,
// selecting a suggestion) and infinite scroll (see pages/index.html's
// loadMore()) both go through spark-ssr's ambient `refresh()`, which re-runs
// this exact function server-side against the live query string — no
// separate api/*.html endpoint duplicating this logic.
//
// Uses youtubei.js (wraps YouTube's own InnerTube API), not yt-search —
// yt-search's `pages`/continuation option silently no-ops (its `_sp`
// continuation-token extraction from the scraped HTML page is broken
// against YouTube's current markup: requesting `pages: 5` still returns
// only page 1's videos, in ~1/5th the expected time, with no error at all).
// youtubei.js's `search.getContinuation()` genuinely walks forward with NO
// overlap between pages (verified: 5 combined pages = 98/98 unique videos).
import { Innertube, UniversalCache, Log } from 'youtubei.js';

// The library's own info/warning-level logging (occasional "unable to parse
// a text run" notices for edge-case formatting) is noisy on stderr and not
// actionable here — errors still surface (caught below, degrade to "no
// results" like the old yt-search path did).
Log.setLevel(Log.Level.ERROR);

const innertube = await Innertube.create({ cache: new UniversalCache(true) });

// Each request walks fresh from page 1 — there's no per-user session to
// stash a continuation token in across requests, and re-walking is cheap
// (~1s/hop, no artificial throttling). `?page=` is the number of COMBINED
// pages wanted, capped so a runaway scroll can't turn into an ever-growing
// wait as the user keeps scrolling.
const MAX_PAGES = 6;

export default async function search(req) {
  const q = String(req.query.q || '').trim();
  if (!q) return [];
  const pages = Math.min(Math.max(Number(req.query.page) || 1, 1), MAX_PAGES);
  try {
    let page = await innertube.search(q);
    const seen = new Map();
    for (const v of page.results.filter(isVideo)) seen.set(v.video_id, v);
    for (let i = 1; i < pages && page.has_continuation; i++) {
      page = await page.getContinuation();
      for (const v of page.results.filter(isVideo)) seen.set(v.video_id, v);
    }
    return [...seen.values()].map(simplify);
  } catch {
    // Degrades to "no results", never a 500 — same contract as before.
    return [];
  }
}

function isVideo(r) {
  return r.type === 'Video';
}

// viewsFormatted/ago are computed HERE, not in the page's <script>, on
// purpose: the server's template render never runs a page's own <script>
// (see bugs.md) — a {formatViews(v.views)} call in the template renders
// blank at SSR time. Pre-formatting the field itself works both before and
// after hydration, since it's plain data either way.
function simplify(v) {
  return {
    videoId: v.video_id,
    title: v.title?.text || '',
    thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url || v.thumbnails?.[0]?.url || '',
    duration: v.duration?.text || '',
    viewsFormatted: String(v.short_view_count?.text || '0 views').replace(/\s*views?$/i, ''),
    ago: v.published?.text || '',
    author: { name: v.author?.name || 'Unknown' },
  };
}
