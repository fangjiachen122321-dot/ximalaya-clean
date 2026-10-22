/**
 * UI 基建：极简 hyperscript、通用组件、格式化、弹层栈、Toast、滑块。
 * 所有组件都返回真实 DOM 节点，视图层直接拼装。
 */

import { icon } from './icons.js';
import { errorText } from './api.js';
import { store, emit } from './store.js';

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && typeof props === 'object') {
    for (const key of Object.keys(props)) {
      const val = props[key];
      if (val == null || val === false) continue;
      if (key === 'class' || key === 'className') el.className = val;
      else if (key === 'html') el.innerHTML = val;
      else if (key === 'text') el.textContent = String(val);
      else if (key === 'style' && typeof val === 'object') Object.assign(el.style, val);
      else if (key === 'dataset') Object.assign(el.dataset, val);
      else if (key.startsWith('on') && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (val === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(val));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function on(el, type, handler, options) {
  el.addEventListener(type, handler, options);
  return () => el.removeEventListener(type, handler, options);
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function fmtDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '0:00';
  const total = Math.round(n);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (hh > 0) return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

export function fmtCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  return String(Math.round(v));
}

export function fmtDate(s) {
  if (!s) return '';
  return String(s).replace(/T.*$/, '');
}

export function debounce(fn, ms = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms = 200) {
  let last = 0;
  let timer = 0;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = 0;
        last = Date.now();
        fn(...lastArgs);
      }, wait);
    }
  };
}

export function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  return s.slice(0, 1).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* 图片                                                                */
/* ------------------------------------------------------------------ */

export function coverImg(src, alt = '') {
  const img = h('img', {
    class: 'cover-img',
    alt,
    loading: 'lazy',
    decoding: 'async',
  });
  if (src) {
    img.src = src;
    img.addEventListener('error', () => {
      img.classList.add('is-broken');
      img.removeAttribute('src');
    });
  } else {
    img.classList.add('is-broken');
  }
  return img;
}

export function cover(url, alt = '', extraClass = '') {
  return h(
    'div',
    { class: `cover ${extraClass}`.trim() },
    coverImg(url, alt),
    h('span', { class: 'cover-fallback', html: icon('music', 22) }),
  );
}

export function avatar(url, name, size = 24) {
  const el = h('span', {
    class: 'avatar',
    style: { width: `${size}px`, height: `${size}px` },
    title: name || '',
  });
  if (url) {
    const img = coverImg(url, name || '');
    img.loading = 'lazy';
    el.append(img);
  }
  el.append(h('span', { class: 'avatar-letter', text: initials(name) }));
  return el;
}

/* ------------------------------------------------------------------ */
/* 通用块                                                              */
/* ------------------------------------------------------------------ */

export function sectionHeader(title, right = null, sub = '') {
  return h(
    'div',
    { class: 'section-head' },
    h(
      'div',
      { class: 'section-head-main' },
      h('h2', { class: 'section-title', text: title }),
      sub ? h('span', { class: 'section-sub', text: sub }) : null,
    ),
    right ? h('div', { class: 'section-head-right' }, right) : null,
  );
}

export function pageHeader({ title, sub = '', actions = null }) {
  return h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      { class: 'page-head-main' },
      h('h1', { class: 'page-title', text: title }),
      sub ? h('p', { class: 'page-sub', text: sub }) : null,
    ),
    actions ? h('div', { class: 'page-head-actions' }, actions) : null,
  );
}

/**
 * 专辑卡片的角标。
 * 喜马拉雅把「VIP 免费」的专辑也标成 isPaid，所以不能只看 isPaid，
 * 要结合 access（后端按当前账号算好的状态）。
 */
export function albumBadge(album) {
  if (!album) return null;
  const access = album.access;
  // 「我的」列表拿不到 VIP 信息，别瞎猜成「付费」
  if (access === 'unknown') return null;
  if (access === 'bought') return { text: '已购', kind: 'done' };
  if (access === 'vip' || access === 'vip-locked' || album.isVip) return { text: 'VIP', kind: 'vip' };
  if (access === 'locked' || album.isPaid) return { text: '付费', kind: 'paid' };
  return null;
}

/** 声音行的徽章：VIP 内容标 VIP，只有真正没权限的才标付费。 */
export function trackBadge(track) {
  if (!track) return null;
  if (track.vip) {
    return track.locked
      ? h('span', { class: 'badge badge-vip', html: icon('lock', 11) + '<span>VIP</span>' })
      : h('span', { class: 'badge badge-vip', html: icon('crown', 11) + '<span>VIP</span>' });
  }
  if (track.isPaid) {
    return h('span', { class: 'badge badge-paid', html: icon('lock', 11) + '<span>付费</span>' });
  }
  return null;
}

export function badge(text, kind = '') {
  return h('span', { class: `badge${kind ? ' badge-' + kind : ''}`, text });
}

export function iconButton(name, label, onClick, opts = {}) {
  return h('button', {
    class: `icon-btn${opts.active ? ' is-active' : ''}`,
    type: 'button',
    'aria-label': label,
    title: opts.title || label,
    html: icon(name, opts.size || 20),
    onClick,
  });
}

/* ------------------------------------------------------------------ */
/* 专辑卡                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} album
 * @param {{onQuickPlay?: (album:any)=>void}} [opts]
 */
export function albumCard(album, opts = {}) {
  if (!album) return null;
  const title = album.title || '未命名专辑';
  const anchorName = (album.anchor && album.anchor.name) || '';

  const fab = h('button', {
    class: 'card-fab',
    type: 'button',
    'aria-label': `播放《${title}》`,
    title: '播放全部',
    html: icon('play', 17),
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (opts.onQuickPlay) opts.onQuickPlay(album);
      else location.hash = `#/album/${album.id}`;
    },
  });

  const badges = [];
  const ab = albumBadge(album);
  if (ab) badges.push(h('span', { class: `cover-badge badge-${ab.kind}`, text: ab.text }));

  const meta = [
    album.trackCount ? `${album.trackCount} 集` : '',
    album.isFinished ? '已完结' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const card = h(
    'div',
    {
      class: 'card',
      role: 'link',
      tabindex: '0',
      'aria-label': title,
      onClick: () => {
        location.hash = `#/album/${album.id}`;
      },
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          location.hash = `#/album/${album.id}`;
        }
      },
    },
    h(
      'div',
      { class: 'card-cover cover' },
      coverImg(album.cover, title),
      h('span', { class: 'cover-fallback', html: icon('music', 26) }),
      badges.length ? h('span', { class: 'cover-badges' }, badges) : null,
      fab,
    ),
    h('div', { class: 'card-title', title, text: title }),
    h('div', { class: 'card-sub', text: anchorName }),
    meta ? h('div', { class: 'card-meta', text: meta }) : null,
  );

  return card;
}

export function albumGrid(albums, opts = {}) {
  return h(
    'div',
    { class: 'grid' },
    (albums || []).map((a) => albumCard(a, opts)).filter(Boolean),
  );
}

/* ------------------------------------------------------------------ */
/* 声音行                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} track
 * @param {{index?: number, showCover?: boolean, showAlbum?: boolean,
 *          onPlay?: (track:any)=>void, playingId?: any}} opts
 */
export function trackRow(track, opts = {}) {
  if (!track) return null;
  const { index = null, showCover = false, showAlbum = false, onPlay } = opts;

  const bars = h('span', { class: 'tr-bars' }, h('i'), h('i'), h('i'));
  const num = h('span', { class: 'tr-num', text: index != null ? String(index) : '' });
  const playIco = h('span', { class: 'tr-play', html: icon('play', 14) });

  const row = h(
    'div',
    {
      class: `track-row${showCover ? ' has-cover' : ''}`,
      role: 'button',
      tabindex: '0',
      dataset: { trackId: String(track.id) },
      onClick: () => onPlay && onPlay(track),
      onKeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onPlay && onPlay(track);
        }
      },
    },
    h('span', { class: 'tr-idx' }, num, bars, playIco),
    showCover
      ? h(
          'span',
          { class: 'tr-cover cover' },
          coverImg(track.cover, track.title || ''),
          h('span', { class: 'cover-fallback', html: icon('music', 16) }),
        )
      : null,
    h(
      'div',
      { class: 'tr-main' },
      h(
        'div',
        { class: 'tr-title' },
        h('span', { class: 'tr-title-text', text: track.title || '未命名' }),
        trackBadge(track),
        track.playable === false && !track.isPaid && !track.vip
          ? h('span', { class: 'badge', text: '不可播放' })
          : null,
      ),
      showAlbum && track.albumTitle
        ? h(
            'div',
            { class: 'tr-sub' },
            track.albumId
              ? h('button', {
                  class: 'tr-sub-text tr-album-link',
                  type: 'button',
                  text: track.albumTitle,
                  title: `打开专辑：${track.albumTitle}`,
                  onClick: (e) => {
                    e.stopPropagation();
                    location.hash = `#/album/${track.albumId}`;
                  },
                })
              : h('span', { class: 'tr-sub-text', text: track.albumTitle }),
            track.publishedAt ? h('span', { class: 'tr-dot', text: '·' }) : null,
            track.publishedAt ? h('span', { text: fmtDate(track.publishedAt) }) : null,
          )
        : null,
    ),
    h('span', { class: 'tr-dur', text: fmtDuration(track.duration) }),
  );

  return row;
}

/** 让一组行跟随全局播放状态高亮；返回取消订阅函数 */
export function bindNowPlaying(root) {
  const apply = () => {
    const { current, playing, loading } = store.state.player;
    const curId = current ? String(current.id) : '';
    root.querySelectorAll('[data-track-id]').forEach((el) => {
      const isCur = curId && el.dataset.trackId === curId;
      el.classList.toggle('is-current', Boolean(isCur));
      el.classList.toggle('is-playing', Boolean(isCur) && (playing || loading));
    });
  };
  apply();
  return store.subscribe(apply);
}

export function trackList(tracks, opts = {}) {
  return h(
    'div',
    { class: 'track-list' },
    (tracks || []).map((t, i) => trackRow(t, { index: i + 1, ...opts })),
  );
}

/* ------------------------------------------------------------------ */
/* 骨架屏                                                              */
/* ------------------------------------------------------------------ */

export function skeletonCards(n = 10) {
  return h(
    'div',
    { class: 'grid' },
    Array.from({ length: n }, () =>
      h(
        'div',
        { class: 'sk-card' },
        h('div', { class: 'sk sk-cover' }),
        h('div', { class: 'sk sk-line', style: { width: '82%' } }),
        h('div', { class: 'sk sk-line sk-line-sm', style: { width: '48%' } }),
      ),
    ),
  );
}

export function skeletonRows(n = 8, cover = false) {
  return h(
    'div',
    { class: 'sk-rows' },
    Array.from({ length: n }, () =>
      h(
        'div',
        { class: `sk-row${cover ? ' has-cover' : ''}` },
        h('div', { class: 'sk sk-dot' }),
        cover ? h('div', { class: 'sk sk-thumb' }) : null,
        h(
          'div',
          { class: 'sk-row-main' },
          h('div', { class: 'sk sk-line', style: { width: '56%' } }),
          h('div', { class: 'sk sk-line sk-line-sm', style: { width: '28%' } }),
        ),
        h('div', { class: 'sk sk-line sk-line-sm', style: { width: '42px' } }),
      ),
    ),
  );
}

/**
 * 慢网提示：骨架屏停留超过 ms 后，在 host 里追加一行「仍在加载」，
 * 避免用户以为界面卡死。返回 { cancel }，请求结束后务必 cancel()。
 *
 * @param {HTMLElement} host 骨架屏所在的容器
 * @param {number} [ms]
 */
export function slowHint(host, ms = 7000, text = '网络较慢，仍在加载…') {
  if (!host) return { cancel() {} };
  let el = null;
  let cancelled = false;

  const timer = setTimeout(() => {
    if (cancelled || el) return;
    el = h(
      'div',
      { class: 'slow-hint', role: 'status' },
      h('span', { class: 'slow-hint-dot' }),
      h('span', { text }),
    );
    host.append(el);
  }, ms);

  return {
    cancel() {
      cancelled = true;
      clearTimeout(timer);
      if (el) el.remove();
      el = null;
    },
  };
}

export function skeletonAlbum() {
  return h(
    'div',
    { class: 'sk-album' },
    h('div', { class: 'sk sk-hero-cover' }),
    h(
      'div',
      { class: 'sk-hero-lines' },
      h('div', { class: 'sk sk-line sk-line-lg', style: { width: '52%' } }),
      h('div', { class: 'sk sk-line', style: { width: '30%' } }),
      h('div', { class: 'sk sk-line', style: { width: '68%' } }),
      h('div', { class: 'sk sk-line', style: { width: '40%' } }),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 空状态 / 错误                                                       */
/* ------------------------------------------------------------------ */

export function emptyState({ iconName = 'headphones', title = '', desc = '', action = null } = {}) {
  const btn = action
    ? h('button', {
        class: `btn ${action.primary === false ? 'btn-ghost' : 'btn-primary'}`,
        type: 'button',
        onClick: action.onClick,
        text: action.label,
      })
    : null;
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-ico', html: icon(iconName, 26) }),
    h('h3', { class: 'empty-title', text: title }),
    desc ? h('p', { class: 'empty-desc', text: desc }) : null,
    btn,
  );
}

export function errorState(err, onRetry) {
  return emptyState({
    iconName: 'wifi-off',
    title: err && err.code === 'NEED_LOGIN' ? '需要登录' : '加载失败',
    desc: errorText(err),
    action: onRetry
      ? { label: '重试', onClick: onRetry, primary: false }
      : null,
  });
}

export function loginRequired(desc = '登录后即可同步你的订阅、收藏和已购内容。') {
  return emptyState({
    iconName: 'qr',
    title: '需要登录',
    desc,
    action: { label: '扫码登录', onClick: () => emit('open-login') },
  });
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

const TOAST_ICON = { success: 'check', error: 'alert', info: 'info' };

export function toast(message, type = 'info', ms = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = h(
    'div',
    { class: `toast toast-${type}`, role: 'status' },
    h('span', { class: 'toast-ico', html: icon(TOAST_ICON[type] || 'info', 17) }),
    h('span', { class: 'toast-msg', text: message }),
  );
  root.append(el);
  while (root.children.length > 3) root.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add('is-in'));
  const close = () => {
    clearTimeout(timer);
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 220);
  };
  const timer = setTimeout(close, ms);
  el.addEventListener('click', close);
}

/* ------------------------------------------------------------------ */
/* 弹层栈（Esc 逐层关闭）                                              */
/* ------------------------------------------------------------------ */

const layers = [];

export function registerLayer(el, close) {
  const entry = { el, close };
  layers.push(entry);
  return () => {
    const i = layers.indexOf(entry);
    if (i >= 0) layers.splice(i, 1);
  };
}

export function closeTopLayer() {
  const top = layers[layers.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function hasLayers() {
  return layers.length > 0;
}

/* ------------------------------------------------------------------ */
/* Popover                                                             */
/* ------------------------------------------------------------------ */

/**
 * 打开一个锚定在元素旁的浮层。返回 { el, close }。
 */
let activePopover = null;

export function popover(anchor, content, opts = {}) {
  const { align = 'right', onClose } = opts;
  if (activePopover) activePopover();
  const layer = h('div', { class: 'popover-layer' });
  const panel = h('div', { class: 'popover', role: 'menu' });
  if (typeof content === 'string') panel.innerHTML = content;
  else append(panel, [content]);
  layer.append(panel);
  document.getElementById('overlay-root').append(layer);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (activePopover === close) activePopover = null;
    unregister();
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    panel.classList.remove('is-open');
    setTimeout(() => layer.remove(), 140);
    if (onClose) onClose();
  };
  const unregister = registerLayer(panel, close);

  const place = () => {
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    let left = align === 'right' ? r.right - pw : r.left;
    left = clamp(left, 10, window.innerWidth - pw - 10);
    let top = r.top - ph - 10;
    if (top < 10) top = Math.min(r.bottom + 10, window.innerHeight - ph - 10);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.classList.add('is-open');
  };

  const onPointerDown = (e) => {
    if (panel.contains(e.target) || anchor.contains(e.target)) return;
    close();
  };

  requestAnimationFrame(place);
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
  }, 0);

  activePopover = close;
  return { el: panel, close };
}

/** 弹层里的菜单项 */
export function menuItem({ label, iconName = '', checked = false, hint = '', onClick }) {
  return h(
    'button',
    {
      class: `menu-item${checked ? ' is-checked' : ''}`,
      type: 'button',
      role: 'menuitemradio',
      'aria-checked': checked ? 'true' : 'false',
      onClick,
    },
    iconName ? h('span', { class: 'menu-ico', html: icon(iconName, 16) }) : null,
    h('span', { class: 'menu-label', text: label }),
    hint ? h('span', { class: 'menu-hint', text: hint }) : null,
    h('span', { class: 'menu-check', html: checked ? icon('check', 15) : '' }),
  );
}

export function menuLabel(text) {
  return h('div', { class: 'menu-label-text', text });
}

export function menuSep() {
  return h('div', { class: 'menu-sep' });
}

/* ------------------------------------------------------------------ */
/* Slider                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {{value?: number, step?: number, ariaLabel?: string, className?: string,
 *          onInput?: (pct:number, dragging:boolean)=>void,
 *          onCommit?: (pct:number)=>void}} opts
 */
export function createSlider(opts = {}) {
  const { value = 0, step = 0.05, ariaLabel = '', className = '' } = opts;
  const el = h('div', {
    class: `slider ${className}`.trim(),
    role: 'slider',
    tabindex: '0',
    'aria-label': ariaLabel,
    'aria-valuemin': '0',
    'aria-valuemax': '100',
  });
  const rail = h('div', { class: 'slider-rail' });
  const fill = h('div', { class: 'slider-fill' });
  const thumb = h('div', { class: 'slider-thumb' });
  rail.append(fill);
  el.append(rail, thumb);

  let pct = clamp(Number(value) || 0, 0, 1);

  const paint = () => {
    el.style.setProperty('--pct', String(pct * 100));
    el.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
    el.setAttribute('aria-valuetext', `${Math.round(pct * 100)}%`);
  };
  paint();

  const setValue = (v) => {
    pct = clamp(Number(v) || 0, 0, 1);
    paint();
  };

  const pctFrom = (clientX) => {
    const r = rail.getBoundingClientRect();
    if (!r.width) return 0;
    return clamp((clientX - r.left) / r.width, 0, 1);
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');

    const start = pctFrom(e.clientX);
    setValue(start);
    if (opts.onInput) opts.onInput(start, true);

    const move = (ev) => {
      const p = pctFrom(ev.clientX);
      setValue(p);
      if (opts.onInput) opts.onInput(p, true);
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('is-dragging');
      const p = pctFrom(ev.clientX);
      setValue(p);
      if (opts.onCommit) opts.onCommit(p);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });

  el.addEventListener('keydown', (e) => {
    const delta = e.shiftKey ? 0.1 : step;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = pct + delta;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = pct - delta;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    setValue(next);
    if (opts.onInput) opts.onInput(pct, false);
    if (opts.onCommit) opts.onCommit(pct);
  });

  return { el, setValue, getValue: () => pct };
}

/* ------------------------------------------------------------------ */
/* 杂项                                                                */
/* ------------------------------------------------------------------ */

export function loadingMore() {
  return h(
    'div',
    { class: 'load-more' },
    h('span', { class: 'mini-spinner' }),
    '加载中…',
  );
}

export function loadMoreButton(onClick, label = '加载更多') {
  return h(
    'div',
    { class: 'load-more-wrap' },
    h('button', { class: 'btn btn-ghost load-more-btn', type: 'button', onClick, text: label }),
  );
}

export function kbd(text) {
  return h('kbd', { class: 'kbd', text });
}

export function scrollToTop() {
  const main = document.getElementById('main');
  if (main) main.scrollTo({ top: 0 });
}
