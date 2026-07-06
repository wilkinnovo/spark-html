// A MODULE source (`sharedVideo = ./lib/video.js` in pages/index.html) —
// resolves the single video named by `?v=<videoId>` so a shared TabTube
// link opens straight to that video (as its own tab) even for a visitor
// with no search query at all. Uses the same shared Innertube instance as
// search.js (see lib/innertube.js), and getBasicInfo() rather than the
// heavier getInfo() — this only needs the card-level metadata already
// shown elsewhere (title/thumbnail/channel/views), not the full watch-next
// feed.
import { getInnertube } from './innertube.js';

export default async function sharedVideo(req) {
  const videoId = String(req.query.v || '').trim();
  if (!videoId) return null;
  try {
    const innertube = await getInnertube();
    const info = await innertube.getBasicInfo(videoId);
    const b = info.basic_info;
    return {
      videoId,
      title: b.title || '',
      thumbnail: b.thumbnail?.[b.thumbnail.length - 1]?.url || b.thumbnail?.[0]?.url || '',
      viewsFormatted: formatViews(b.view_count),
      ago: '',
      author: { name: b.channel?.name || b.author || 'Unknown' },
    };
  } catch {
    // Degrades to "no shared video" — the app still works from `?q=` alone.
    return null;
  }
}

function formatViews(n) {
  if (typeof n !== 'number') return '0';
  return new Intl.NumberFormat('en', { notation: 'compact' }).format(n);
}
