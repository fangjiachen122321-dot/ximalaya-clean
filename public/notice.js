/**
 * 顶部 / 播放条上方的提示条（可关闭、可持久化关闭状态）。
 * 用于地区限制、播放地址失败、网络异常这类「不中断界面」的提示。
 */

import { icon } from './icons.js';
import { h, registerLayer } from './ui.js';
import { ls, emit } from './store.js';

const KIND_ICON = {
  warn: 'alert',
  error: 'wifi-off',
  info: 'info',
  success: 'check',
};

const active = new Map();

function root() {
  let el = document.getElementById('notice-root');
  if (!el) {
    el = h('div', { id: 'notice-root', class: 'notice-root', role: 'region', 'aria-label': '提示' });
    document.body.append(el);
  }
  return el;
}

function dismissed(key) {
  if (!key) return false;
  return ls.get(`notice.${key}`, false) === true;
}

/**
 * @param {object} opts
 * @param {string} [opts.id]     同 id 的提示不会重复堆叠
 * @param {'warn'|'error'|'info'|'success'} [opts.kind]
 * @param {string} opts.message  中文文案
 * @param {string} [opts.detail] 次要说明
 * @param {string} [opts.persistKey] 关闭后写入 localStorage 的键，避免反复打扰
 * @param {{label:string,onClick:Function}} [opts.action]
 * @param {number} [opts.autoHide] 自动消失毫秒数（0 = 不自动消失）
 */
export function showNotice(opts) {
  const {
    id = '',
    kind = 'warn',
    message = '',
    detail = '',
    persistKey = '',
    action = null,
    autoHide = 0,
  } = opts || {};

  if (!message) return null;
  if (persistKey && dismissed(persistKey)) return null;
  if (id && active.has(id)) {
    // 更新已有提示的文案而不是堆叠
    const entry = active.get(id);
    entry.messageEl.textContent = message;
    if (detail) entry.detailEl.textContent = detail;
    return entry;
  }

  const messageEl = h('span', { class: 'notice-msg', text: message });
  const detailEl = h('span', { class: 'notice-detail', text: detail });

  const closeBtn = h('button', {
    class: 'notice-close',
    type: 'button',
    'aria-label': '关闭提示',
    title: '关闭',
    html: icon('x', 15),
  });

  const actionBtn = action
    ? h('button', {
        class: 'notice-action',
        type: 'button',
        text: action.label || '重试',
        onClick: () => {
          try {
            action.onClick && action.onClick();
          } finally {
            close();
          }
        },
      })
    : null;

  const el = h(
    'div',
    { class: `notice notice-${kind}`, role: 'status' },
    h('span', { class: 'notice-ico', html: icon(KIND_ICON[kind] || 'info', 17) }),
    h(
      'div',
      { class: 'notice-body' },
      messageEl,
      detail ? detailEl : null,
    ),
    actionBtn,
    closeBtn,
  );

  let timer = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (id) active.delete(id);
    unregister();
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 220);
    if (persistKey) ls.set(`notice.${persistKey}`, true);
    emit('notice-closed', { id, persistKey });
  };
  const unregister = registerLayer(el, close);

  closeBtn.addEventListener('click', close);
  root().append(el);
  requestAnimationFrame(() => el.classList.add('is-in'));

  const entry = { el, close, messageEl, detailEl };
  if (id) active.set(id, entry);

  if (autoHide > 0) timer = setTimeout(close, autoHide);
  return entry;
}

export function clearNotice(id) {
  const entry = active.get(id);
  if (entry) entry.close();
}

export function clearAllNotices() {
  [...active.values()].forEach((e) => e.close());
}

/** 播放失败：按错误码给出中文提示条 */
export function noticePlayError(err) {
  if (!err) return;
  const code = err.code || 'UNKNOWN';
  const map = {
    PAID: { kind: 'warn', message: '这是付费内容，当前账号未购买' },
    VIP_REQUIRED: { kind: 'warn', message: '这条内容需要 VIP 会员，请登录已开通会员的账号' },
    GEO_BLOCKED: { kind: 'warn', message: '该内容受版权地区限制' },
    UPSTREAM: { kind: 'error', message: '暂时无法获取播放地址，请稍后重试' },
    NETWORK: { kind: 'error', message: '暂时无法获取播放地址，请稍后重试' },
    TIMEOUT: { kind: 'error', message: '暂时无法获取播放地址，请稍后重试' },
    NEED_LOGIN: { kind: 'warn', message: '需要先登录喜马拉雅账号' },
    NOT_FOUND: { kind: 'error', message: '该节目已下架，无法播放' },
  };
  const conf = map[code] || { kind: 'error', message: err.message || '播放失败，请稍后重试' };
  return showNotice({
    id: 'play-error',
    kind: conf.kind,
    message: conf.message,
    detail: code === 'GEO_BLOCKED' ? '需要中国大陆网络环境，可在设置里配置代理' : '',
    autoHide: 12000,
  });
}
