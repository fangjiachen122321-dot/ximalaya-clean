/**
 * 应用入口：hash 路由 + 视图挂载 + 启动流程。
 */

import { api } from './api.js';
import { store, emit, bus, applyTheme, currentThemeMode } from './store.js';
import { initShell, setRouteUI, refreshSession, bindBack } from './shell.js';
import { hydrateIcons } from './icons.js';
import { closeTopLayer, hasLayers, toast, clear } from './ui.js';
import { openLogin } from './overlays.js';
import { showNotice } from './notice.js';
import {
  homeView,
  searchView,
  albumView,
  subscriptionsView,
  listenedView,
  likesView,
  boughtView,
  notFoundView,
} from './views.js';

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

const ROUTES = [
  { name: 'home', pattern: /^\/?$/, view: homeView, title: '首页' },
  { name: 'search', pattern: /^\/search\/?$/, view: searchView, title: '搜索' },
  { name: 'album', pattern: /^\/album\/([^/]+)\/?$/, view: albumView, title: '专辑', params: ['id'] },
  { name: 'subscriptions', pattern: /^\/subscriptions\/?$/, view: subscriptionsView, title: '我的订阅' },
  { name: 'listened', pattern: /^\/listened\/?$/, view: listenedView, title: '最近收听' },
  { name: 'likes', pattern: /^\/likes\/?$/, view: likesView, title: '我喜欢的' },
  { name: 'bought', pattern: /^\/bought\/?$/, view: boughtView, title: '已购专辑' },
];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart || '/';
  const query = {};
  if (queryPart) {
    new URLSearchParams(queryPart).forEach((v, k) => {
      query[k] = v;
    });
  }
  return { path, query };
}

function matchRoute(path) {
  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    const params = {};
    (route.params || []).forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1] || '');
    });
    return { route, params };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 视图挂载                                                            */
/* ------------------------------------------------------------------ */

const viewHost = document.getElementById('view');
let currentCleanup = null;
let currentKey = '';
let routeToken = 0;

function setTitle(route, params, query) {
  let title = route.title;
  if (route.name === 'search' && query.kw) title = `搜索「${query.kw}」`;
  if (route.name === 'album' && params.id) title = '专辑';
  setRouteUI({ name: route.name, title, backEnabled: history.length > 1 });
}

function mount(path, query) {
  const matched = matchRoute(path);
  const token = ++routeToken;

  if (currentCleanup) {
    try {
      currentCleanup();
    } catch (err) {
      console.warn('[router] cleanup failed', err);
    }
    currentCleanup = null;
  }

  const ctx = {
    path,
    query: { ...query },
    params: {},
    signal: null,
  };

  let result;
  if (!matched) {
    store.set('route', { name: 'notfound', path, query: { ...query } });
    setRouteUI({ name: 'notfound', title: '页面不存在', backEnabled: false });
    result = notFoundView(ctx);
  } else {
    const { route, params } = matched;
    ctx.params = params;
    store.set('route', { name: route.name, path, query: { ...query } });
    setTitle(route, params, query);
    try {
      result = route.view(ctx);
    } catch (err) {
      console.error('[router] view crashed', err);
      result = {
        el: (() => {
          const el = document.createElement('div');
          el.className = 'page';
          el.innerHTML =
            '<div class="empty"><div class="empty-title">页面渲染失败</div><p class="empty-desc">请刷新重试，或查看控制台日志。</p></div>';
          return el;
        })(),
        cleanup: () => {},
      };
    }
  }

  if (token !== routeToken) {
    if (result && result.cleanup) result.cleanup();
    return;
  }

  const el = result && result.el ? result.el : document.createElement('div');
  currentCleanup = (result && result.cleanup) || null;

  // 保留滚动位置只在同路由切换时重置
  clear(viewHost);
  viewHost.append(el);
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;

  // 视图里可能动态插入 [data-icon]，再补一次
  hydrateIcons(viewHost);

  currentKey = `${path}?${JSON.stringify(query)}`;

}

function navigate() {
  const { path, query } = parseHash();
  mount(path, query);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/**
 * 启动时的网络自检：仅在被地区限制时提示一次。
 * geoBlocked 提示条可关闭，关闭状态记在 localStorage（notice.geo-blocked）。
 */
async function runNetworkCheck() {
  try {
    const res = await api.networkCheck();
    if (!res || typeof res !== 'object') return;
    if (res.geoBlocked) {
      showNotice({
        id: 'geo-blocked',
        kind: 'warn',
        message: res.message || '当前网络无法播放受地区限制的内容',
        detail: '在设置里配置代理后可解除限制',
        persistKey: 'geo-blocked',
      });
    } else if (res.api === false) {
      showNotice({
        id: 'net-down',
        kind: 'error',
        message: '本地服务暂时无法连接，部分功能可能不可用',
        autoHide: 8000,
      });
    }
  } catch {
    /* 自检失败本身不需要打扰用户 */
  }
}

async function bootstrap() {
  applyTheme(currentThemeMode());
  initShell();

  bindBack(() => {
    if (history.length > 1) history.back();
    else location.hash = '#/';
  });

  window.addEventListener('hashchange', navigate);
  window.addEventListener('beforeunload', () => {
    const p = store.state.player;
    if (p.current && p.time > 3) {
      try {
        import('./store.js').then(({ local }) => local.savePosition(p.current.id, p.time, p.duration));
      } catch {
        /* noop */
      }
    }
  });

  // 会话与设置并行拉取，任一失败都不阻塞首屏
  const settingsPromise = api
    .getSettings()
    .then((s) => {
      if (s && typeof s === 'object') store.update('settings', s);
    })
    .catch(() => {});

  const sessionPromise = refreshSession();

  // 启动后延迟自检网络（非阻塞，不参与首屏渲染）
  setTimeout(() => {
    runNetworkCheck();
  }, 1000);

  navigate();
  store.update('ui', { ready: true });

  await Promise.allSettled([settingsPromise, sessionPromise]);

  // 登录状态变化后，若当前是「我的」页面则重新拉取
  bus.addEventListener('session-changed', () => {
    const name = store.state.route.name;
    if (['subscriptions', 'listened', 'likes', 'bought'].includes(name)) {
      const { path, query } = parseHash();
      mount(path, query);
    }
  });

  bus.addEventListener('open-login', () => openLogin());
  bus.addEventListener('open-settings', () => import('./overlays.js').then((m) => m.openSettings()));
}

/* 全局兜底：未捕获异常不白屏 */
window.addEventListener('error', (e) => {
  console.error('[uncaught]', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && e.reason.name === 'AbortError') return;
  console.error('[unhandled rejection]', e.reason);
});

/* 暴露给调试 */
window.__xmc = { store, emit, toast, closeTopLayer, hasLayers };

bootstrap();
