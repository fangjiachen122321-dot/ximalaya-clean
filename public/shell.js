/**
 * 外壳：播放条、账号区、顶栏、快捷键、主题、网络提示。
 */

import { api, errorText } from './api.js';
import { store, emit, applyTheme, currentThemeMode } from './store.js';
import { icon, hydrateIcons, setIcon } from './icons.js';
import {
  h,
  avatar,
  fmtDuration,
  createSlider,
  popover,
  menuItem,
  menuLabel,
  menuSep,
  toast,
  closeTopLayer,
  hasLayers,
} from './ui.js';
import { player, RATES, MODE_LABEL, MODE_ICON, MODES } from './player.js';
import { openLogin, openSettings, openQueue } from './overlays.js';
import { refreshSession } from './session.js';
import { showNotice, clearNotice } from './notice.js';

const $ = (id) => document.getElementById(id);

let seekSlider = null;
let volSlider = null;
let seekDragging = false;
let volDragging = false;
let lastQueueBadge = -1;

const refs = {};

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

export function initShell() {
  hydrateIcons(document);

  refs.coverImg = $('pl-cover-img');
  refs.cover = $('pl-cover');
  refs.title = $('pl-title');
  refs.sub = $('pl-sub');
  refs.quality = $('pl-quality');
  refs.playBtn = $('btn-play');
  refs.playIco = refs.playBtn.querySelector('[data-icon]');
  refs.cur = $('pl-cur');
  refs.dur = $('pl-dur');
  refs.rate = $('btn-rate');
  refs.mode = $('btn-mode');
  refs.mute = $('btn-mute');
  refs.more = $('btn-more');
  refs.queue = $('btn-queue');
  refs.back = $('btn-back');

  refs.coverImg.addEventListener('error', () => {
    refs.coverImg.hidden = true;
    refs.coverImg.removeAttribute('src');
  });

  initSliders();
  bindPlayerButtons();
  bindKeyboard();
  bindNetwork();

  let lastSessionSig = '';
  store.subscribe(() => {
    renderPlayer();
    const s = store.state.session;
    const sig = `${s.loaded}|${s.loggedIn}|${s.user ? s.user.uid || s.user.nickname : ''}|${s.user ? s.user.vip : ''}|${s.user ? s.user.avatar : ''}`;
    if (sig !== lastSessionSig) {
      lastSessionSig = sig;
      renderAccount();
    }
  });

  renderPlayer();
  renderAccount();
  updateThemeModeBadge();
  store.update('ui', { ready: true });
}

function initSliders() {
  const seekHost = $('seek');
  seekSlider = createSlider({
    ariaLabel: '播放进度',
    step: 0.02,
    onInput: (pct, dragging) => {
      seekDragging = Boolean(dragging);
      const d = store.state.player.duration;
      if (refs.cur) refs.cur.textContent = fmtDuration(pct * d);
    },
    onCommit: (pct) => {
      seekDragging = false;
      const d = store.state.player.duration;
      player.seek(pct * d);
    },
  });
  if (seekHost) seekHost.replaceWith(seekSlider.el);

  const volHost = $('vol');
  volSlider = createSlider({
    value: store.state.player.muted ? 0 : store.state.player.volume,
    ariaLabel: '音量',
    step: 0.05,
    onInput: (pct) => {
      volDragging = true;
      player.setVolume(pct);
    },
    onCommit: (pct) => {
      volDragging = false;
      player.setVolume(pct);
    },
  });
  if (volHost) volHost.replaceWith(volSlider.el);
}

function bindPlayerButtons() {
  refs.playBtn.addEventListener('click', () => player.toggle());
  $('btn-prev').addEventListener('click', () => player.prev());
  $('btn-next').addEventListener('click', () => player.next());

  refs.cover.addEventListener('click', () => {
    const cur = store.state.player.current;
    if (cur && cur.albumId != null) location.hash = `#/album/${cur.albumId}`;
  });

  refs.title.addEventListener('click', (e) => {
    const cur = store.state.player.current;
    if (!cur || cur.albumId == null) e.preventDefault();
  });

  refs.mute.addEventListener('click', () => player.toggleMute());
  refs.mode.addEventListener('click', () => player.cycleMode());
  refs.queue.addEventListener('click', () => openQueue());
  refs.rate.addEventListener('click', () => openRateMenu());
  refs.more.addEventListener('click', () => openMoreMenu());

  $('btn-settings').addEventListener('click', () => openSettings());

  const topSearch = $('btn-topbar-search');
  if (topSearch) topSearch.addEventListener('click', () => focusSearch());
}

/* ------------------------------------------------------------------ */
/* 播放条渲染                                                          */
/* ------------------------------------------------------------------ */

function setText(el, text) {
  if (!el) return;
  const t = String(text == null ? '' : text);
  if (el.textContent !== t) el.textContent = t;
}

function renderPlayer() {
  const p = store.state.player;
  const cur = p.current;

  if (cur && cur.cover) {
    const src = cur.cover;
    if (refs.coverImg.getAttribute('src') !== src) {
      refs.coverImg.hidden = false;
      refs.coverImg.classList.remove('is-broken');
      refs.coverImg.src = src;
    }
  } else {
    refs.coverImg.hidden = true;
    refs.coverImg.removeAttribute('src');
  }

  setText(refs.title, cur ? cur.title : '未在播放');
  setText(refs.sub, cur ? cur.albumTitle || '' : '选择一集开始收听');

  const href = cur && cur.albumId != null ? `#/album/${cur.albumId}` : '';
  [refs.title, refs.sub].forEach((el) => {
    if (!el) return;
    if (href) el.setAttribute('href', href);
    else el.removeAttribute('href');
    el.classList.toggle('is-link', Boolean(href));
  });

  const icoName = p.playing ? 'pause' : 'play';
  if (refs.playIco.dataset.state !== icoName) {
    refs.playIco.dataset.state = icoName;
    refs.playIco.innerHTML = icon(icoName, 20);
  }
  refs.playBtn.classList.toggle('is-loading', Boolean(p.loading));
  refs.playBtn.setAttribute('aria-label', p.playing ? '暂停' : '播放');

  setText(refs.quality, p.quality || '');
  if (refs.quality) refs.quality.hidden = !p.quality;

  if (seekSlider && !seekDragging) {
    const ratio = p.duration > 0 ? Math.min(1, p.time / p.duration) : 0;
    seekSlider.setValue(ratio);
  }
  if (!seekDragging) {
    setText(refs.cur, fmtDuration(p.time));
    setText(refs.dur, fmtDuration(p.duration));
  }

  if (volSlider && !volDragging) {
    volSlider.setValue(p.muted ? 0 : p.volume);
  }
  const volIcon = p.muted || p.volume === 0 ? 'volume-mute' : p.volume < 0.45 ? 'volume-low' : 'volume';
  if (refs.mute.dataset.state !== volIcon) {
    refs.mute.dataset.state = volIcon;
    setIcon(refs.mute, volIcon, 20);
  }
  refs.mute.setAttribute('aria-label', p.muted ? '取消静音' : '静音');
  refs.mute.title = p.muted ? '取消静音' : '静音';

  setText(refs.rate, `${p.rate === 1 ? '1.0' : p.rate}x`);
  refs.rate.classList.toggle('is-active', p.rate !== 1);

  if (refs.mode.dataset.mode !== p.mode) {
    refs.mode.dataset.mode = p.mode;
    setIcon(refs.mode, MODE_ICON[p.mode] || 'repeat', 20);
  }
  refs.mode.title = `播放模式：${MODE_LABEL[p.mode] || '列表循环'}`;
  refs.mode.setAttribute('aria-label', `播放模式：${MODE_LABEL[p.mode] || '列表循环'}`);
  refs.mode.classList.toggle('is-active', p.mode !== 'list');

  refs.more.classList.toggle('has-timer', Boolean(p.sleepEndsAt));
  refs.more.title = p.sleepEndsAt
    ? `更多 · 睡眠定时剩余 ${fmtDuration(Math.ceil(p.sleepRemaining / 1000))}`
    : '更多';

  const qlen = p.queue.length;
  if (qlen !== lastQueueBadge) {
    lastQueueBadge = qlen;
    refs.queue.dataset.count = qlen > 0 ? String(qlen) : '';
    refs.queue.classList.toggle('has-badge', qlen > 0);
    refs.queue.title = qlen > 0 ? `播放队列 · ${qlen} 集` : '播放队列';
  }
}

/* ------------------------------------------------------------------ */
/* 播放条弹出菜单                                                      */
/* ------------------------------------------------------------------ */

function openRateMenu() {
  const p = store.state.player;
  const content = h(
    'div',
    { class: 'menu' },
    menuLabel('播放速度'),
    RATES.map((r) =>
      menuItem({
        label: r === 1 ? '1.0x　正常' : `${r}x`,
        checked: p.rate === r,
        onClick: () => {
          player.setRate(r);
          close();
        },
      }),
    ),
    menuSep(),
    h('div', { class: 'menu-note', text: '听书建议 1.25x – 1.5x' }),
  );
  const { close } = popover(refs.rate, content, { align: 'right' });
}

function sleepLabel() {
  const p = store.state.player;
  if (!p.sleepEndsAt) return '';
  return fmtDuration(Math.ceil(p.sleepRemaining / 1000));
}

function openMoreMenu() {
  const p = store.state.player;
  const remain = sleepLabel();

  const content = h(
    'div',
    { class: 'menu' },
    menuLabel('循环模式'),
    MODES.map((m) =>
      menuItem({
        label: MODE_LABEL[m],
        iconName: MODE_ICON[m],
        checked: p.mode === m,
        onClick: () => {
          player.setMode(m);
          close();
        },
      }),
    ),
    menuSep(),
    menuLabel(p.sleepEndsAt ? `睡眠定时 · 剩余 ${remain}` : '睡眠定时'),
    [0, 15, 30, 60].map((m) =>
      menuItem({
        label: m ? `${m} 分钟` : '关闭定时',
        iconName: m ? 'timer' : 'x',
        checked: m === 0 ? !p.sleepEndsAt : false,
        onClick: () => {
          player.setSleep(m);
          close();
        },
      }),
    ),
    menuSep(),
    menuItem({
      label: '清空播放队列',
      iconName: 'trash',
      onClick: () => {
        close();
        if (!store.state.player.queue.length) {
          toast('队列已经是空的', 'info');
          return;
        }
        player.clearQueue();
        toast('已清空播放队列', 'success');
      },
    }),
  );

  const { close } = popover(refs.more, content, { align: 'right' });
}

/* ------------------------------------------------------------------ */
/* 账号                                                                */
/* ------------------------------------------------------------------ */

function renderAccount() {
  const el = $('account');
  if (!el) return;
  const s = store.state.session;

  if (!s.loaded) {
    el.replaceChildren(
      h(
        'div',
        { class: 'account-skeleton' },
        h('div', { class: 'sk sk-avatar' }),
        h('div', { class: 'sk sk-line', style: { width: '70%' } }),
      ),
    );
    return;
  }

  if (s.loggedIn && s.user) {
    const user = s.user;
    const btn = h(
      'button',
      {
        class: 'account-user',
        type: 'button',
        title: `${user.nickname || '已登录'} · 点击管理账号`,
        onClick: () => openAccountMenu(btn),
      },
      avatar(user.avatar, user.nickname, 30),
      h(
        'span',
        { class: 'account-text' },
        h('strong', { class: 'account-name', text: user.nickname || '已登录' }),
        h('span', { class: 'account-sub', text: user.vip ? 'VIP 会员' : '已登录' }),
      ),
      h('span', { class: 'account-caret', html: icon('chevron-up', 15) }),
    );
    el.replaceChildren(btn);
  } else {
    const btn = h(
      'button',
      { class: 'account-login', type: 'button', onClick: () => openLogin() },
      h('span', { class: 'account-login-ico', html: icon('qr', 20) }),
      h(
        'span',
        { class: 'account-text' },
        h('strong', { class: 'account-name', text: '扫码登录' }),
        h('span', { class: 'account-sub', text: '同步订阅与收藏' }),
      ),
      h('span', { class: 'account-caret', html: icon('chevron-right', 15) }),
    );
    el.replaceChildren(btn);
  }
}

function openAccountMenu(anchor) {
  const user = store.state.session.user || {};
  const content = h(
    'div',
    { class: 'menu' },
    h(
      'div',
      { class: 'menu-account' },
      avatar(user.avatar, user.nickname, 34),
      h(
        'div',
        { class: 'menu-account-text' },
        h('strong', { text: user.nickname || '已登录' }),
        h('span', { text: user.vip ? 'VIP 会员' : '喜马拉雅账号' }),
      ),
    ),
    menuSep(),
    menuItem({
      label: '设置',
      iconName: 'settings',
      onClick: () => {
        close();
        openSettings();
      },
    }),
    menuItem({
      label: '退出登录',
      iconName: 'logout',
      onClick: async () => {
        close();
        await logout();
      },
    }),
  );
  const { close } = popover(anchor, content, { align: 'left' });
}

async function logout() {
  try {
    await api.logout();
    await refreshSession();
    toast('已退出登录', 'success');
    emit('session-changed');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

/* ------------------------------------------------------------------ */
/* 顶栏 / 主题                                                         */
/* ------------------------------------------------------------------ */

export function setRouteUI({ name, title, backEnabled }) {
  const t = $('topbar-title');
  if (t) t.textContent = title || '';
  document.title = title ? `${title} · 喜马拉雅` : '喜马拉雅 · 干净版';

  const topSearch = $('btn-topbar-search');
  if (topSearch) topSearch.hidden = name === 'search';

  document.querySelectorAll('.nav-item').forEach((el) => {
    const active = el.dataset.route === name;
    el.classList.toggle('is-active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });

  if (refs.back) {
    refs.back.disabled = !backEnabled;
  }
  const main = $('main');
  if (main) main.scrollTop = 0;
}

export function bindBack(handler) {
  if (refs.back) refs.back.addEventListener('click', handler);
}

export function updateThemeModeBadge() {
  applyTheme(currentThemeMode());
}

/* ------------------------------------------------------------------ */
/* 快捷键                                                              */
/* ------------------------------------------------------------------ */

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function focusSearch() {
  const existing = $('search-input');
  if (existing) {
    existing.focus();
    if (existing.select) existing.select();
    return;
  }
  location.hash = '#/search';
  let tries = 0;
  const tick = () => {
    const el = $('search-input');
    if (el) {
      el.focus();
      return;
    }
    if (tries++ < 24) setTimeout(tick, 60);
  };
  setTimeout(tick, 60);
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (hasLayers()) {
        e.preventDefault();
        closeTopLayer();
      }
      return;
    }

    if (isTyping(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.defaultPrevented) return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        player.toggle();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        player.seekBy(-10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        player.seekBy(10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        player.nudgeVolume(0.05);
        break;
      case 'ArrowDown':
        e.preventDefault();
        player.nudgeVolume(-0.05);
        break;
      case 'n':
      case 'N':
        player.next();
        break;
      case 'p':
      case 'P':
        player.prev();
        break;
      case '/':
        e.preventDefault();
        focusSearch();
        break;
      default:
        break;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 网络状态                                                            */
/* ------------------------------------------------------------------ */

function bindNetwork() {
  const offline = () =>
    showNotice({
      id: 'offline',
      kind: 'error',
      message: '网络已断开，播放可能受影响',
      detail: '恢复联网后会自动消失',
    });

  window.addEventListener('offline', offline);
  window.addEventListener('online', () => {
    clearNotice('offline');
    toast('网络已恢复', 'success', 2000);
  });
  if (!navigator.onLine) offline();
}

/* ------------------------------------------------------------------ */
/* 其他                                                                */
/* ------------------------------------------------------------------ */

export { openLogin, openSettings, openQueue, refreshSession };
