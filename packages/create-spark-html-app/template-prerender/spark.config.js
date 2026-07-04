import prerender from 'spark-prerender/bun';

// Static site, the Spark way: `spark dev` serves components raw with HMR;
// `spark build` copies public/, bundles the entry, then prerender() runs the
// REAL app at build time and writes fully-rendered HTML into dist/ — crawlers
// and AI tools read real content, the browser hydrates over it.
export default {
  pipeline: [prerender({ pages: ['index.html'] })],
};
