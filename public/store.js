/**
 * 极轻量状态容器 + localStorage 持久化。
 * 没有框架，只有「读 state / update / subscribe」。
 */

const NS = 'xmc.';

export const ls = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(NS + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
    } catch {
      /* 隐私模式 / 配额满：静默失败 */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(NS + key);
    } catch {
      /* noop */
    }
  },
};

/** 事件总线：跨模块解耦（登录成功、需要刷新当前页等） */
export const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export const state = {
  route: { name: 'home', path: '/', query: {} },
  session: { loaded: false, loggedIn: false, user: null },
  settings: { quality: 'high', proxy: '', port: 0 },
  player: {
    current: null, // 队列项
    queue: [],
    index: -1,
    playing: false,
    loading: false,
    time: 0,
    duration: 0,
    rate: 1,
    volume: 0.8,
    muted: false,
    mode: 'list', // list | one | seq
    quality: '',
    error: null,
    sleepEndsAt: 0,
    sleepRemaining: 0,
  },
  ui: {
    queueOpen: false,
    ready: false,
  },
};

const listeners = new Set();

function notify() {
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      console.error('[store] listener failed', err);
    }
  });
}

export const store = {
  state,
  get(key) {
    return state[key];
  },
  /** 合并某个顶层分区，例如 store.update('player', { playing: true }) */
  update(key, patch) {
    if (!state[key]) state[key] = {};
    Object.assign(state[key], patch);
    notify();
  },
  /** 整体替换某个顶层分区 */
  set(key, value) {
    state[key] = value;
    notify();
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/* ------------------------------------------------------------------ */
/* 本地历史 / 播放位置                                                  */
/* ------------------------------------------------------------------ */

const HISTORY_LIMIT = 80;
const POSITION_LIMIT = 300;

export const local = {
  history() {
    return ls.get('history', []);
  },

  addHistory(track) {
    if (!track || track.id == null) return;
    const list = ls.get('history', []).filter((t) => String(t.id) !== String(track.id));
    list.unshift({
      id: track.id,
      title: track.title,
      albumId: track.albumId,
      albumTitle: track.albumTitle,
      cover: track.cover,
      duration: track.duration,
      at: Date.now(),
    });
    ls.set('history', list.slice(0, HISTORY_LIMIT));
  },

  clearHistory() {
    ls.del('history');
    ls.del('positions');
  },

  /** 每首曲目的续播位置（秒） */
  positions() {
    return ls.get('positions', {});
  },

  savePosition(id, position, duration) {
    if (id == null) return;
    const map = ls.get('positions', {});
    if (!Number.isFinite(position) || position < 3) {
      delete map[id];
    } else {
      map[id] = {
        p: Math.floor(position),
        d: Math.floor(duration || 0),
        at: Date.now(),
      };
    }
    const keys = Object.keys(map);
    if (keys.length > POSITION_LIMIT) {
      keys
        .sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
        .slice(0, keys.length - POSITION_LIMIT)
        .forEach((k) => delete map[k]);
    }
    ls.set('positions', map);
  },

  getPosition(id) {
    if (id == null) return 0;
    const item = ls.get('positions', {})[id];
    return item && Number.isFinite(item.p) ? item.p : 0;
  },

  dropPosition(id) {
    const map = ls.get('positions', {});
    if (map[id]) {
      delete map[id];
      ls.set('positions', map);
    }
  },

  searches() {
    return ls.get('searches', []);
  },

  addSearch(kw) {
    const k = String(kw || '').trim();
    if (!k) return;
    const list = ls.get('searches', []).filter((x) => x !== k);
    list.unshift(k);
    ls.set('searches', list.slice(0, 10));
  },

  clearSearches() {
    ls.del('searches');
  },
};

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

export const THEME_MODES = ['dark', 'light', 'system'];

export function resolveTheme(mode) {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode === 'light' ? 'light' : 'dark';
}

export function applyTheme(mode) {
  const m = THEME_MODES.includes(mode) ? mode : 'dark';
  document.documentElement.dataset.theme = resolveTheme(m);
  document.documentElement.dataset.themeMode = m;
  ls.set('theme', m);
  return m;
}

export function currentThemeMode() {
  return ls.get('theme', 'dark');
}
