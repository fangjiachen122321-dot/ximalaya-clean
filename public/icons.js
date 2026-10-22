/**
 * 内联 SVG 图标（Lucide 风格，24 网格，2px stroke）
 * 全部零依赖，按需取用：icon('play', 18)
 */

const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  settings:
    '<path d="M3 6h9"/><path d="M16 6h5"/><circle cx="14" cy="6" r="2"/>' +
    '<path d="M3 12h4"/><path d="M11 12h10"/><circle cx="9" cy="12" r="2"/>' +
    '<path d="M3 18h9"/><path d="M16 18h5"/><circle cx="14" cy="18" r="2"/>',
  radio:
    '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/>' +
    '<path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/>' +
    '<circle cx="12" cy="12" r="2"/>' +
    '<path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/>' +
    '<path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  heart:
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  bag:
    '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>' +
    '<path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  play: { fill: true, d: '<path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.9-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z"/>' },
  pause: {
    fill: true,
    d: '<rect x="7" y="4" width="3.6" height="16" rx="1.2"/><rect x="13.4" y="4" width="3.6" height="16" rx="1.2"/>',
  },
  prev: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>',
  next: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
  volume:
    '<path d="M11 5 6 9H3v6h3l5 4V5Z"/>' +
    '<path d="M15.4 8.6a5 5 0 0 1 0 6.8"/>' +
    '<path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  'volume-low': '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.4 8.6a5 5 0 0 1 0 6.8"/>',
  'volume-mute':
    '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 9 5 6"/><path d="m21 9-5 6"/>',
  queue:
    '<path d="M21 15V6"/><circle cx="18.5" cy="18" r="2.5"/>' +
    '<path d="M12 12H3"/><path d="M16 6H3"/><path d="M12 18H3"/>',
  more: {
    fill: true,
    d: '<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>',
  },
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  refresh:
    '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>' +
    '<path d="M21 3v5h-5"/>',
  repeat:
    '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/>' +
    '<path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  'repeat-one':
    '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/>' +
    '<path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>' +
    '<path d="M11 10.6 12.4 9.6V14"/>',
  sequential: '<path d="M4 12h15"/><path d="m14 7 5 5-5 5"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  trash:
    '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
    '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>' +
    '<path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
  check: '<path d="m20 6-10.5 11L4 12"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
    '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  crown:
    '<path d="M3 17l1.6-9 4.7 4L12 5l2.7 7 4.7-4L21 17Z"/><path d="M3 17h18"/>',
  music:
    '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  qr:
    '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1.4"/><path d="M14 14h3.5v3.5H14z"/>' +
    '<path d="M21 14v3"/><path d="M14 21h3"/><path d="M21 21h.01"/>',
  'wifi-off':
    '<path d="m2 2 20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/>' +
    '<path d="M5 12.9a10 10 0 0 1 3-1.9"/><path d="M14 11a10 10 0 0 1 5 1.9"/>' +
    '<path d="M2 8.8a16 16 0 0 1 4-2.2"/><path d="M18 6.6a16 16 0 0 1 4 2.2"/>' +
    '<path d="M12 20h.01"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.6"/><path d="M9 2h6"/>',
  headphones:
    '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/>' +
    '<path d="M20 15a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h1a2 2 0 0 1 2 2Z"/>' +
    '<path d="M4 15a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H6a2 2 0 0 0-2 2Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
  sliders:
    '<path d="M4 6h8"/><path d="M16 6h4"/><circle cx="14" cy="6" r="2"/>' +
    '<path d="M4 12h4"/><path d="M12 12h8"/><circle cx="10" cy="12" r="2"/>' +
    '<path d="M4 18h8"/><path d="M16 18h4"/><circle cx="14" cy="18" r="2"/>',
  gauge: '<path d="M12 14 16 9"/><circle cx="12" cy="14" r="1"/><path d="M3.5 17a9 9 0 1 1 17 0"/>',
};

/**
 * 生成一个内联 SVG 字符串。
 * @param {string} name 图标名
 * @param {number} size 边长（px）
 * @param {string} cls 额外 class
 */
export function icon(name, size = 20, cls = '') {
  const def = ICONS[name];
  if (!def) return '';
  const body = typeof def === 'string' ? def : def.d;
  const filled = typeof def === 'object' && def.fill;
  const attrs = filled
    ? `fill="currentColor" stroke="none"`
    : `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg class="svg-icon${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" ${attrs} aria-hidden="true" focusable="false">${body}</svg>`;
}

/** 把页面里所有 [data-icon] 占位符替换成真实 SVG */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.dataset.icon;
    if (!name) return;
    const size = Number(el.dataset.iconSize) || 20;
    el.innerHTML = icon(name, size);
  });
}

/** 换掉某个元素的图标（保留其它内容时请用 innerHTML 自行处理） */
export function setIcon(el, name, size = 20) {
  if (!el) return;
  el.innerHTML = icon(name, size);
}

export function hasIcon(name) {
  return Boolean(ICONS[name]);
}
