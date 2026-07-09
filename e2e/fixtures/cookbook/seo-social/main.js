import { mount } from 'spark-html';
import { head } from 'spark-html-head';

head({
  title: { '/': 'Home', '/about': 'About', '*': 'Not found' },
  titleTemplate: (t) => `${t} · My Site`,
  meta: {
    description: (path) => `The ${path} page`,
    'og:title': (path) => `My Site — ${path}`,
    'og:image': () => 'https://example.com/og.png',
  },
});
mount();
