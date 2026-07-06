// A MODULE source (`suggestions = ./lib/suggestion.js`) — Google's own
// YouTube autocomplete endpoint, no API key. Sits alongside `results` on the
// same page, so the client's single ambient `refresh()` call (debounced as
// the user types, see components/search-box.html) re-fetches BOTH together
// from the live query string — no separate suggest endpoint needed.
import suggest from 'youtube-suggest';

export default async function suggestions(req) {
  const q = String(req.query.q || '').trim();
  if (!q) return [];
  try {
    return await suggest(q);
  } catch {
    return [];
  }
}
