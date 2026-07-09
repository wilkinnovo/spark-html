import manifest from 'spark-html-manifest/bun';
import offlineSw from 'spark-html-offline/bun';

export default {
  pipeline: [
    manifest({
      name: 'My Spark App',
      shortName: 'Spark',
      themeColor: '#ffd24a',
      icon: 'public/icon.png', // one image → 192 + 512, resized
      offline: true,           // app-shell worker + auto registration
    }),
    offlineSw(),               // CDN component imports work offline too
  ],
};
