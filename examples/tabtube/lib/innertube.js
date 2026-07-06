// Shared Innertube singleton — search.js and video.js (looking up a single
// shared video by id) both need a live session; one shared instance avoids
// a second, redundant Innertube.create() (a real client handshake) purely
// to satisfy two separate module sources on the same page.
import { Innertube, UniversalCache, Log } from 'youtubei.js';

Log.setLevel(Log.Level.ERROR);

let instance;
export function getInnertube() {
  if (!instance) instance = Innertube.create({ cache: new UniversalCache(true) });
  return instance;
}
