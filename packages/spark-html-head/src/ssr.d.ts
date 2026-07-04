export function liftHead(html: string): { head: string; scripts: string; body: string };
export function renderHead(head: string, resolve: (expr: string) => unknown): string;
declare const _default: { liftHead: typeof liftHead; renderHead: typeof renderHead };
export default _default;
