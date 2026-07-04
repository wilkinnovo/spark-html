// The client side of the blog — plain browser modules, no build step.
// spark-ssr serves each family package at /@modules/* and puts them in the
// page importmap, so bare imports just work.
import { theme } from 'spark-html-theme';

// Dark/light/system with persistence; the server already inlined the
// no-flash snippet in <head>, this wires the reactive store + toggle.
theme();
