import { mount, fireClick } from 'spark-html-test-utils';
import { strict as assert } from 'node:assert';

const h = await mount({
  root: '<div import="counter"></div>',
  components: {
    counter: '<button onclick={inc}>{n}</button><script>let n = 0; function inc() { n++; }<\/script>',
  },
});

fireClick(h.query('button'));
await h.settle();
assert.equal(h.query('button').textContent, '1');
h.cleanup();
console.log('counter.test.js: 1 passed');
