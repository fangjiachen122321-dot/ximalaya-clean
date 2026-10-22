/**
 * 弹层：扫码登录、设置、播放队列。
 * 所有弹层都会注册进弹层栈，Esc 逐层关闭。
 */

import { api, errorText } from './api.js';
import { store, emit, applyTheme, currentThemeMode } from './store.js';
import { icon } from './icons.js';
import {
  h,
  clear,
  append,
  cover,
  avatar,
  fmtDuration,
  emptyState,
  toast,
  registerLayer,
} from './ui.js';
import { player } from './player.js';
import { refreshSession } from './session.js';

const $ = (id) => document.getElementById(id);
const APP_VERSION = '1.0.0';

let settingsLayerOpen = false;

/* ------------------------------------------------------------------ */
/* 通用 Modal                                                          */
/* ------------------------------------------------------------------ */

function createModal({ title, body, width = 440, className = '', onClose }) {
  const layer = h('div', { class: 'modal-layer' });
  const backdrop = h('div', { class: 'modal-backdrop' });
  const closeBtn = h('button', {
    class: 'icon-btn modal-close',
    type: 'button',
    'aria-label': '关闭',
    html: icon('x', 18),
    onClick: () => close(),
  });
  const head = h(
    'header',
    { class: 'modal-head' },
    h('h2', { class: 'modal-title', text: title }),
    closeBtn,
  );
  const bodyEl = h('div', { class: 'modal-body' });
  append(bodyEl, [body]);
  const modal = h(
    'div',
    {
      class: `modal ${className}`.trim(),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      style: { width: `${width}px` },
    },
    head,
    bodyEl,
  );
  layer.append(backdrop, modal);
  $('overlay-root').append(layer);
  requestAnimationFrame(() => layer.classList.add('is-open'));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unregister();
    layer.classList.remove('is-open');
    setTimeout(() => layer.remove(), 200);
    if (onClose) onClose();
  };
  const unregister = registerLayer(modal, close);
  backdrop.addEventListener('click', close);

  requestAnimationFrame(() => {
    const target = modal.querySelector('[data-autofocus]') || closeBtn;
    if (target && target.focus) target.focus({ preventScroll: true });
  });

  return { el: modal, body: bodyEl, close };
}

/* ------------------------------------------------------------------ */
/* 扫码登录                                                            */
/* ------------------------------------------------------------------ */

export function openLogin() {
  if (store.state.session.loggedIn) {
    toast('你已经登录了', 'info');
    return;
  }

  let closed = false;
  let pollTimer = 0;
  let qrId = null;
  let failures = 0;

  const qrWrap = h('div', { class: 'qr-wrap' });

  const statusEl = h('p', { class: 'qr-status', text: '正在获取二维码…' });
  const hintEl = h('p', { class: 'qr-hint', text: '用喜马拉雅 App 扫码登录' });
  const refreshBtn = h('button', {
    class: 'btn btn-ghost btn-sm qr-refresh',
    type: 'button',
    html: icon('refresh', 14) + '<span>刷新二维码</span>',
    onClick: () => start(),
  });
  refreshBtn.hidden = true;

  const cookieMsg = h('div', { class: 'field-hint' });
  const cookieInput = h('textarea', {
    class: 'input textarea',
    rows: '3',
    placeholder: '粘贴浏览器 Cookie，例如：1&_token=...; ...',
    spellcheck: 'false',
  });
  const cookieBtn = h('button', {
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '使用 Cookie 登录',
    onClick: async () => {
      const value = cookieInput.value.trim();
      if (!value) {
        cookieMsg.textContent = '请先粘贴 Cookie';
        cookieMsg.className = 'field-hint is-error';
        return;
      }
      cookieBtn.disabled = true;
      cookieBtn.textContent = '登录中…';
      cookieMsg.textContent = '';
      try {
        const data = await api.loginCookie(value);
        await finishLogin(data && data.user);
      } catch (err) {
        cookieMsg.textContent = errorText(err);
        cookieMsg.className = 'field-hint is-error';
      } finally {
        cookieBtn.disabled = false;
        cookieBtn.textContent = '使用 Cookie 登录';
      }
    },
  });

  const cookieEntry = h(
    'details',
    { class: 'cookie-entry' },
    h('summary', { class: 'cookie-summary', text: '手动粘贴 Cookie' }),
    h(
      'div',
      { class: 'cookie-body' },
      h('p', {
        class: 'cookie-desc',
        text: '在浏览器登录 ximalaya.com 后，从开发者工具 → 网络请求中复制 Cookie 字符串。',
      }),
      cookieInput,
      h('div', { class: 'cookie-actions' }, cookieBtn, cookieMsg),
    ),
  );

  const body = h(
    'div',
    { class: 'login-body' },
    qrWrap,
    statusEl,
    hintEl,
    refreshBtn,
    cookieEntry,
    h('p', {
      class: 'login-foot',
      text: '登录信息仅保存在本机，不会上传到任何第三方。',
    }),
  );

  const modal = createModal({
    title: '扫码登录',
    body,
    width: 380,
    className: 'login-modal',
    onClose: () => {
      closed = true;
      clearTimeout(pollTimer);
    },
  });

  let cachedImg = '';

  function paint(kind, data = {}) {
    if (data.img) cachedImg = data.img;
    const img = cachedImg;
    clear(qrWrap);
    const box = h('div', { class: `qr-box qr-${kind}` });

    if (kind === 'loading') {
      box.append(h('div', { class: 'qr-skeleton' }));
    } else if (kind === 'error') {
      box.append(h('div', { class: 'qr-error' }, h('span', { html: icon('wifi-off', 30) })));
    } else if (img) {
      box.append(h('img', { class: 'qr-img', src: img, alt: '登录二维码' }));
    } else {
      box.append(h('div', { class: 'qr-skeleton' }));
    }

    if (kind === 'scanned') {
      box.append(
        h(
          'div',
          { class: 'qr-overlay' },
          h('span', { class: 'qr-overlay-ico', html: icon('check', 22) }),
          h('span', { text: '已扫码' }),
        ),
      );
    }
    if (kind === 'expired') {
      box.append(
        h(
          'div',
          { class: 'qr-overlay is-dim' },
          h('span', { class: 'qr-overlay-ico', html: icon('refresh', 22) }),
          h('span', { text: '二维码已过期' }),
        ),
      );
    }

    qrWrap.append(box);

    const statusMap = {
      loading: '正在获取二维码…',
      pending: '等待扫码…',
      scanned: '已扫码，请在手机上确认',
      expired: '二维码已过期，请点击刷新',
      error: data.message || '获取二维码失败',
    };
    statusEl.textContent = statusMap[kind] || '';
    statusEl.className = `qr-status qr-status-${kind}`;
    refreshBtn.hidden = !(kind === 'expired' || kind === 'error');
  }

  async function start() {
    clearTimeout(pollTimer);
    failures = 0;
    qrId = null;
    paint('loading');
    try {
      const data = await api.qrCreate();
      if (closed) return;
      qrId = data && data.qrId;
      if (!qrId || !data.img) throw new Error('二维码数据不完整');
      paint('pending', { img: data.img });
      schedulePoll();
    } catch (err) {
      if (closed) return;
      paint('error', { message: errorText(err) });
    }
  }

  function schedulePoll() {
    if (closed) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 2000);
  }

  async function poll() {
    if (closed || !qrId) return;
    try {
      const res = await api.qrStatus(qrId);
      if (closed) return;
      failures = 0;
      const status = res && res.status;
      if (status === 'success') {
        await finishLogin(res.user);
        return;
      }
      if (status === 'expired') {
        paint('expired');
        return;
      }
      paint(status === 'scanned' ? 'scanned' : 'pending');
      schedulePoll();
    } catch (err) {
      if (closed) return;
      failures += 1;
      if (failures >= 4) {
        paint('error', { message: errorText(err) });
        return;
      }
      schedulePoll();
    }
  }

  async function finishLogin(user) {
    clearTimeout(pollTimer);
    store.update('session', {
      loaded: true,
      loggedIn: true,
      user: user || null,
    });
    await refreshSession();
    toast('登录成功，欢迎回来', 'success');
    emit('session-changed');
    modal.close();
  }

  start();
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

const QUALITY_OPTIONS = [
  { value: 'high', label: '高音质', sub: '128k' },
  { value: 'medium', label: '标准', sub: '64k' },
  { value: 'low', label: '省流', sub: '32k' },
];

const QUALITY_LABEL = { high: '高音质', medium: '标准', low: '省流' };

function segmented(options, current, onPick) {
  const wrap = h('div', { class: 'seg' });
  const btns = options.map((opt) => {
    const btn = h(
      'button',
      {
        class: `seg-btn${opt.value === current ? ' is-active' : ''}`,
        type: 'button',
      },
      h('span', { class: 'seg-label', text: opt.label }),
      opt.sub ? h('span', { class: 'seg-sub', text: opt.sub }) : null,
    );
    btn.addEventListener('click', () => {
      if (btn.classList.contains('is-active')) return;
      btns.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      onPick(opt.value);
    });
    wrap.append(btn);
    return btn;
  });
  wrap.setActive = (value) => {
    const i = options.findIndex((o) => o.value === value);
    btns.forEach((b, idx) => b.classList.toggle('is-active', idx === i));
  };
  return wrap;
}

function settingRow(title, desc, control, extra = null) {
  return h(
    'div',
    { class: 'setting-row' },
    h(
      'div',
      { class: 'setting-info' },
      h('div', { class: 'setting-title', text: title }),
      desc ? h('div', { class: 'setting-desc', text: desc }) : null,
    ),
    h('div', { class: 'setting-control' }, control, extra),
  );
}

function settingSection(title, ...children) {
  return h(
    'section',
    { class: 'setting-section' },
    h('h3', { class: 'setting-heading', text: title }),
    children,
  );
}

async function saveSettings(patch, successText = '设置已保存') {
  try {
    const next = await api.putSettings(patch);
    store.update('settings', { ...patch, ...(next || {}) });
    if (successText) toast(successText, 'success', 1600);
    return true;
  } catch (err) {
    toast(errorText(err), 'error');
    return false;
  }
}

export function openSettings() {
  if (settingsLayerOpen) return;
  settingsLayerOpen = true;

  // 先用本地缓存值立刻打开，避免等待网络造成「点了没反应」
  const settings = { ...store.state.settings };

  const body = h('div', { class: 'settings-body' });

  /* 音质 */
  const qualitySeg = segmented(QUALITY_OPTIONS, settings.quality || 'high', async (value) => {
    const ok = await saveSettings({ quality: value }, `音质已切换为${QUALITY_LABEL[value] || value}`);
    if (!ok) qualitySeg.setActive(store.state.settings.quality || 'high');
  });
  const qualityRow = settingRow(
    '播放音质',
    '音质越高越耗流量；地铁或弱网建议切到「省流」。',
    qualitySeg,
  );

  /* 代理 */
  const proxyInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'http://127.0.0.1:7890',
    value: settings.proxy || '',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const proxyHint = h('div', { class: 'field-hint' });
  const proxySave = h('button', {
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '保存',
    onClick: async () => {
      const value = proxyInput.value.trim();
      const ok = await saveSettings({ proxy: value }, value ? '代理已保存' : '已切换为直连');
      if (ok) {
        proxyHint.textContent = value ? `当前代理：${value}` : '当前为直连（不使用代理）';
        proxyHint.className = 'field-hint is-ok';
      }
    },
  });
  const proxyTest = h('button', {
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '测试代理',
    onClick: async () => {
      proxyTest.disabled = true;
      const original = proxyTest.textContent;
      proxyTest.textContent = '测试中…';
      proxyHint.textContent = '';
      proxyHint.className = 'field-hint';
      try {
        const res = await api.testProxy(proxyInput.value.trim());
        if (res && res.ok) {
          proxyHint.textContent = res.latency ? `连接成功 · ${res.latency}ms` : res.message || '连接成功';
          proxyHint.className = 'field-hint is-ok';
        } else {
          proxyHint.textContent = (res && (res.message || res.error)) || '连接失败';
          proxyHint.className = 'field-hint is-error';
        }
      } catch (err) {
        proxyHint.textContent = errorText(err);
        proxyHint.className = 'field-hint is-error';
      } finally {
        proxyTest.disabled = false;
        proxyTest.textContent = original;
      }
    },
  });
  proxyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      proxySave.click();
    }
  });

  const proxyControl = h(
    'div',
    { class: 'proxy-control' },
    h('div', { class: 'proxy-row' }, proxyInput, proxySave, proxyTest),
    h('div', {
      class: 'setting-desc',
      text: '留空表示直连。支持 http:// 与 socks5://，仅影响客户端访问上游。',
    }),
    proxyHint,
  );

  /* 外观 */
  const themeRow = settingRow(
    '外观',
    '浅色适合白天，深色适合夜间听书。',
    segmented(
      [
        { value: 'dark', label: '深色' },
        { value: 'light', label: '浅色' },
        { value: 'system', label: '跟随系统' },
      ],
      currentThemeMode(),
      (value) => {
        applyTheme(value);
      },
    ),
  );

  /* 账号 */
  const accountWrap = h('div', { class: 'settings-account' });
  const renderAccountSection = () => {
    const s = store.state.session;
    clear(accountWrap);
    if (s.loggedIn && s.user) {
      accountWrap.append(
        h(
          'div',
          { class: 'account-line' },
          avatar(s.user.avatar, s.user.nickname, 40),
          h(
            'div',
            { class: 'account-line-text' },
            h('strong', { text: s.user.nickname || '已登录' }),
            h('span', { text: s.user.vip ? 'VIP 会员' : '喜马拉雅账号' }),
          ),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            html: icon('logout', 14) + '<span>退出登录</span>',
            onClick: async () => {
              try {
                await api.logout();
                await refreshSession();
                emit('session-changed');
                renderAccountSection();
                toast('已退出登录', 'success');
              } catch (err) {
                toast(errorText(err), 'error');
              }
            },
          }),
        ),
      );
    } else {
      accountWrap.append(
        h(
          'div',
          { class: 'account-line' },
          h('span', { class: 'account-line-ico', html: icon('qr', 22) }),
          h(
            'div',
            { class: 'account-line-text' },
            h('strong', { text: '未登录' }),
            h('span', { text: '登录后可同步订阅、收藏与已购' }),
          ),
          h('button', {
            class: 'btn btn-primary btn-sm',
            type: 'button',
            text: '扫码登录',
            onClick: () => {
              close();
              openLogin();
            },
          }),
        ),
      );
    }
  };
  renderAccountSection();

  /* 关于 */
  const portValue = h('b', { text: String(settings.port || '—') });
  const about = h(
    'div',
    { class: 'about' },
    h('div', { class: 'about-line' }, h('span', { text: '版本' }), h('b', { text: `v${APP_VERSION}` })),
    h(
      'div',
      { class: 'about-line' },
      h('span', { text: '本地服务端口' }),
      portValue,
    ),
    h('p', {
      class: 'about-desc',
      text: '本客户端仅在本机运行，无广告、无推荐位，所有数据保存在你的电脑上。',
    }),
    h(
      'details',
      { class: 'about-keys' },
      h('summary', { text: '键盘快捷键' }),
      h(
        'div',
        { class: 'keys-grid' },
        [
          ['空格', '播放 / 暂停'],
          ['← / →', '快退 / 快进 10 秒'],
          ['↑ / ↓', '音量'],
          ['N / P', '下一首 / 上一首'],
          ['/', '聚焦搜索'],
          ['Esc', '关闭弹层'],
        ].map(([k, v]) =>
          h('div', { class: 'key-row' }, h('kbd', { class: 'kbd', text: k }), h('span', { text: v })),
        ),
      ),
    ),
  );

  append(body, [
    settingSection('播放', qualityRow),
    settingSection('网络', proxyControl),
    settingSection('外观', themeRow),
    settingSection('账号', accountWrap),
    settingSection('关于', about),
  ]);

  const modal = createModal({
    title: '设置',
    body,
    width: 520,
    className: 'settings-modal',
    onClose: () => {
      settingsLayerOpen = false;
    },
  });

  const close = () => modal.close();

  // 异步补齐服务端设置（失败则保留本地值，不影响使用）
  api
    .getSettings()
    .then((fetched) => {
      if (!fetched || typeof fetched !== 'object') return;
      store.update('settings', fetched);
      if (fetched.quality) qualitySeg.setActive(fetched.quality);
      if (typeof fetched.proxy === 'string' && !proxyInput.value) proxyInput.value = fetched.proxy;
      if (fetched.port) portValue.textContent = String(fetched.port);
    })
    .catch(() => {});

  return close;
}

/* ------------------------------------------------------------------ */
/* 播放队列抽屉                                                        */
/* ------------------------------------------------------------------ */

let queueLayer = null;

export function openQueue() {
  if (queueLayer) return;

  const countEl = h('span', { class: 'drawer-count' });
  const totalEl = h('span', { class: 'drawer-total' });
  const listEl = h('div', { class: 'queue-list' });

  const clearBtn = h('button', {
    class: 'link-btn',
    type: 'button',
    text: '清空',
    onClick: () => {
      if (!store.state.player.queue.length) return;
      player.clearQueue();
      toast('已清空播放队列', 'success');
    },
  });

  const closeBtn = h('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': '关闭队列',
    html: icon('x', 18),
    onClick: () => close(),
  });

  const head = h(
    'header',
    { class: 'drawer-head' },
    h(
      'div',
      { class: 'drawer-title-wrap' },
      h('h2', { class: 'drawer-title', text: '播放队列' }),
      countEl,
    ),
    h('div', { class: 'drawer-actions' }, clearBtn, closeBtn),
  );

  const foot = h('footer', { class: 'drawer-foot' }, totalEl);

  const drawer = h(
    'aside',
    { class: 'drawer', role: 'dialog', 'aria-label': '播放队列' },
    head,
    listEl,
    foot,
  );
  const scrim = h('div', { class: 'drawer-scrim', onClick: () => close() });
  const layer = h('div', { class: 'drawer-layer' }, scrim, drawer);

  $('overlay-root').append(layer);
  requestAnimationFrame(() => layer.classList.add('is-open'));

  let closed = false;
  const unregister = registerLayer(drawer, close);
  const unsub = store.subscribe(render);

  function close() {
    if (closed) return;
    closed = true;
    unsub();
    unregister();
    layer.classList.remove('is-open');
    setTimeout(() => layer.remove(), 220);
    queueLayer = null;
  }

  let lastSig = '';

  function render(force = false) {
    const p = store.state.player;
    // 队列 / 索引 / 时长没变就不重建 DOM（timeupdate 每秒触发多次）
    const sig = `${p.index}|${p.queue.length}|${p.queue.map((t) => t.id).join(',')}`;
    if (!force && sig === lastSig) return;
    lastSig = sig;

    countEl.textContent = p.queue.length ? `${p.queue.length} 集` : '';

    if (!p.queue.length) {
      clear(listEl);
      listEl.append(
        emptyState({
          iconName: 'queue',
          title: '队列是空的',
          desc: '从专辑或搜索结果里播放任意一集，就会出现在这里。',
        }),
      );
      totalEl.textContent = '';
      return;
    }

    const total = p.queue.reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
    totalEl.textContent = `共 ${p.queue.length} 集 · 总时长 ${fmtDuration(total)}`;

    clear(listEl);
    p.queue.forEach((track, i) => {
      listEl.append(queueRow(track, i, i === p.index));
    });
  }

  function queueRow(track, index, active) {
    const bars = h('span', { class: 'q-bars' }, h('i'), h('i'), h('i'));
    const row = h(
      'div',
      {
        class: `q-row${active ? ' is-current' : ''}`,
        role: 'button',
        tabindex: '0',
        onClick: () => player.jumpTo(index),
        onKeydown: (e) => {
          if (e.key === 'Enter') player.jumpTo(index);
        },
      },
      h('span', { class: 'q-idx' }, active ? bars : String(index + 1)),
      cover(track.cover, track.title, 'q-cover'),
      h(
        'span',
        { class: 'q-main' },
        h('span', { class: 'q-title', text: track.title }),
        h('span', { class: 'q-sub', text: track.albumTitle || '' }),
      ),
      h('span', { class: 'q-dur', text: fmtDuration(track.duration) }),
      h('button', {
        class: 'icon-btn q-remove',
        type: 'button',
        'aria-label': '从队列移除',
        title: '从队列移除',
        html: icon('x', 15),
        onClick: (e) => {
          e.stopPropagation();
          player.removeAt(index);
        },
      }),
    );
    return row;
  }

  render(true);
  queueLayer = { close };
}

/* ------------------------------------------------------------------ */
/* 供外部调用的小工具                                                  */
/* ------------------------------------------------------------------ */

export function closeAllOverlays() {
  if (queueLayer) queueLayer.close();
}
