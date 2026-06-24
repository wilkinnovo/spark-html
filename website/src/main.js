import { mount, store } from 'spark-html';
import { highlightAll } from './highlight.js';

// Shared store powering the cross-component demo on the landing page
store('demo', { clicks: 0 });

// Exposed so demos that fetch their own source at runtime can re-highlight
// after injecting it (see components/composition-demo.html).
window.highlightAll = highlightAll;

await mount();
highlightAll();
