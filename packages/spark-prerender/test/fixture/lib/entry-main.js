import { mount, store } from 'spark-html';
store('todos', { items: ['ext-a', 'ext-b', 'ext-c'] });
mount();
