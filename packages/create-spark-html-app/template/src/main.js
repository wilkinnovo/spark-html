import { store } from "spark-html";
import { router } from "spark-html-router";
import { theme } from "spark-html-theme";
import { head } from "spark-html-head";
import { devtools } from "spark-html-devtools";

const dev = import.meta.env?.DEV;
if (dev) devtools(); // dev only

head({
  title: { "/": "Home", "/about": "About", "*": "Not found" },
  titleTemplate: (t) => `${t} · My Site`,
  meta: { description: (path) => `The ${path} page` },
});

// Shared stores connect components without providers or prop drilling.
store("app", { sparks: 0 });

// One-line dark/light/system theming (the ⚡ logo toggles it).
theme();

// Client-side router: reads <template route> blocks, intercepts <a> clicks,
// and manages SPA navigation. Call it once — replaces mount().
router({ devOverlay: dev, quiet: !dev });
