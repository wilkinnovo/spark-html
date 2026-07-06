// The client side — plain browser modules, no build step. spark-ssr serves
// every spark-html-* family package at /@modules/* and wires an importmap,
// so these bare imports just work.
import { store } from 'spark-html';
import { persist } from 'spark-html-persist';
import { theme } from 'spark-html-theme';

// Shared UI state every component below reads/writes via useStore('tabtube')
// instead of the page passing it down as props through several layers.
//
// `results` itself deliberately does NOT live here — it stays a page-level
// spark-ssr plan var, and the results list is inlined in the page's own
// template rather than a separate component. An import node's props are
// evaluated ONCE at mount and never revisited (see bugs2.md), so a
// component reading search results as a PROP would never see a later
// refresh() — and results must also render for real at SSR (a shareable
// `/?q=...` URL, no JS required), which a store can't do either (a store
// is only ever populated by client script, which never runs at SSR).
// `suggestions` has neither constraint — autocomplete is inherently
// client-only — so it's fine here, reactive across refresh() calls.
store('tabtube', {
  tabs: [],
  activeId: null,
  activeFilter: 'all',
  showMyLists: false,
  suggestions: [],
});

// Created once, here — components that want it just call
// useStore('tabtube-saved'), they don't call persist() themselves.
persist('tabtube-saved', { items: [] });

theme();
