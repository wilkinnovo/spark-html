import { mount, store } from 'spark-html';

// Shared, reactive state. Any component can subscribe with useStore('app').
// Assigning a property re-patches every subscriber — that's the whole model.
store('app', { sparks: 0 });

// Resolve every <div import="..."> placeholder and boot the components.
mount();
