import { mount, store } from 'spark-html';
import { motion } from 'spark-html-motion';

// Shared state — any component can subscribe with useStore('cart')
store('cart', { items: [], total: 0 });

// Enable enter/leave transitions for elements with a `transition` attribute.
motion();

mount();
