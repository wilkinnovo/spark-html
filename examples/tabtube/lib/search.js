// A MODULE source (`results = ./lib/search.js` in pages/index.html) — the
// ONLY place the yt-search call lives. The client's own re-search (typing,
// selecting a suggestion) goes through spark-ssr's ambient `refresh()`,
// which re-runs this exact function server-side against the live query
// string — no separate api/*.html endpoint duplicating this logic.
import yts from 'yt-search';

export default async function search(req) {
  const q = String(req.query.q || '').trim();
  if (!q) return [];
  try {
    const r = await yts(q);
    return (r.videos || []).slice(0, 24).map(simplify);
  } catch {
    // yt-search scrapes YouTube's own search page — no API key, but no SLA
    // either. A failed/blocked request degrades to "no results", never a 500.
    return [];
  }
}

// viewsFormatted is computed HERE, not in the page's <script>, on purpose:
// the server's template render never runs a page's own <script> (see
// bugs.md) — a {formatViews(v.views)} call in the template renders blank
// at SSR time. Pre-formatting the field itself works both before and after
// hydration, since it's plain data either way.
function formatViews(n) {
  if (n == null) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function simplify(v) {
  return {
    videoId: v.videoId,
    title: v.title,
    thumbnail: v.thumbnail,
    duration: v.timestamp,
    views: v.views,
    viewsFormatted: formatViews(v.views),
    ago: v.ago,
    author: { name: v.author?.name || 'Unknown' },
  };
}
