// SSR-only data source (mode-specific file, per improvements.md I2a: "the
// page file is shared" — data source files may differ). Its only purpose is
// to give the page a non-empty data-source plan so spark-ssr treats it as
// hydrating (an interactive page with zero declared sources runs its
// <script> on the server instead — by design, see the docs#limits row).
// The value itself is unused by the shared page template.
export default () => ({ relocMarker: true });
