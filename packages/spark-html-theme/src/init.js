/**
 * spark-html-theme/init — the inline no-flash snippet, DOM-free.
 *
 * Separate from the package root so servers and build pipelines (spark-ssr,
 * spark-html-bun, spark-prerender) can import it without pulling in the
 * client runtime (the root imports spark-html). Keep `key`/`attribute` in
 * sync with the theme() call on the client.
 */
export function themeInitScript({ key = 'theme-mode', attribute = 'data-theme' } = {}) {
  return (
    `(function(){try{var m=localStorage.getItem(${JSON.stringify(key)})||'system';` +
    `var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);` +
    `document.documentElement.setAttribute(${JSON.stringify(attribute)},d?'dark':'light');}` +
    `catch(e){document.documentElement.setAttribute(${JSON.stringify(attribute)},'dark');}})();`
  );
}

export default { themeInitScript };
