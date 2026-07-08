// The client side of spark chat — plain browser modules, no build step.
// spark-ssr serves each family package at /@modules/* and puts them in the
// page importmap, so bare imports just work.
import { theme } from 'spark-html-theme';

// Dark/light/system with persistence; the server already inlined the
// no-flash snippet in <head>, this wires the reactive store + toggle.
theme();

// spark-ssr always emits its own <meta name="viewport"> (unlike <title>,
// it isn't deduped against a page-supplied one), so adding viewport-fit=cover
// via a second static tag would be unreliable — mutate the one the server
// already rendered instead. Needed for env(safe-area-inset-bottom) in
// style.css to resolve to anything on iPhone (composer padding around the
// home indicator).
const viewportMeta = document.querySelector('meta[name="viewport"]');
if (viewportMeta && !viewportMeta.content.includes('viewport-fit')) {
  viewportMeta.content += ', viewport-fit=cover';
}
