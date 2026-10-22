/**
 * 会话：读取 / 刷新登录状态。登录态变化由调用方通过 emit('session-changed') 通知。
 */

import { api } from './api.js';
import { store } from './store.js';

export async function refreshSession() {
  try {
    const data = await api.session();
    store.update('session', {
      loaded: true,
      loggedIn: Boolean(data && data.loggedIn),
      user: (data && data.user) || null,
    });
  } catch {
    // 后端未就绪时静默降级为未登录，避免白屏
    store.update('session', { loaded: true, loggedIn: false, user: null });
  }
  return store.state.session;
}

export function isLoggedIn() {
  return Boolean(store.state.session.loggedIn);
}
