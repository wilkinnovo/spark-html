// Shared display formatting for module data sources. Computed HERE (not in a
// hydrating page's client <script>) so the first server-rendered paint
// already carries the formatted fields — a page script only runs client-side.

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
}

export function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const ICONS = { image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', spreadsheet: '📊', archive: '🗜️', document: '📄' };
export const iconFor = (type) => ICONS[type] || '📁';

const VIEWABLE = new Set(['image', 'video', 'audio', 'pdf']);
export const isViewable = (type, url) => VIEWABLE.has(type) || /\.txt$/i.test(url || '');

export function decorate(row) {
  return {
    ...row,
    sizeLabel: humanSize(row.size),
    createdLabel: prettyDate(row.created_at),
    icon: iconFor(row.type),
    viewable: isViewable(row.type, row.url),
    shareUrl: row.share_token ? '/s/' + row.share_token : null,
  };
}
