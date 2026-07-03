import prerender from 'spark-prerender/bun';

// `spark dev` serves the components + lib/*.js modules raw; `spark build`
// bundles the entry and prerenders index.html into static HTML.
export default {
  pipeline: [prerender({ pages: ['index.html'] })],
};
