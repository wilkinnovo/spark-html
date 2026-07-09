import prerender from 'spark-prerender/bun';

export default {
  pipeline: [prerender({ site: 'https://example.com' })],
};
