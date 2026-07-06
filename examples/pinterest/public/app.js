// The client side — plain browser modules, no build step. spark-ssr serves
// every spark-html-* family package at /@modules/* and wires an importmap,
// so this bare import just works.
import { theme } from 'spark-html-theme';

theme();
