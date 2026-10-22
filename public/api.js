/**
 * 与本地服务通信的唯一入口。
 * 所有请求走相对路径，页面由同一个服务托管。
 */

export class ApiError extends Error {
  /**
   * @param {string} message 中文错误信息
   * @param {string} code 契约里的错误码
   * @param {number} status HTTP 状态码（0 表示网络层失败）
   */
  constructor(message, code = 'UNKNOWN', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** 错误码 → 中文文案（播放相关文案以契约为准） */
const CODE_TEXT = {
  GEO_BLOCKED: '该内容受版权地区限制（需要中国大陆网络）',
  PAID: '这是付费内容，当前账号未购买',
  VIP_REQUIRED: '这条内容需要 VIP 会员，请登录已开通会员的账号',
  NEED_LOGIN: '需要登录后才能使用该功能',
  NOT_FOUND: '内容不存在或已下架',
  UPSTREAM: '上游服务异常，请稍后重试',
  NETWORK: '无法连接本地服务，请确认客户端正在运行',
  TIMEOUT: '请求超时，请稍后重试',
  RATE_LIMIT: '请求过于频繁，请稍后再试',
};

export function errorText(err) {
  if (!err) return '出了点问题，请稍后重试';
  if (err.code && CODE_TEXT[err.code]) return CODE_TEXT[err.code];
  return err.message || CODE_TEXT.UNKNOWN || '出了点问题，请稍后重试';
}

function statusToCode(status) {
  if (status === 401) return 'NEED_LOGIN';
  if (status === 403) return 'GEO_BLOCKED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'UPSTREAM';
  return 'UNKNOWN';
}

const DEFAULT_TIMEOUT = 20000;

/**
 * @param {string} path
 * @param {{method?: string, body?: any, signal?: AbortSignal, timeout?: number}} [options]
 */
async function request(path, options = {}) {
  const { method = 'GET', body, signal, timeout = DEFAULT_TIMEOUT } = options;
  const ctrl = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeout);

  const forwardAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new DOMException('aborted', 'AbortError');
    }
    signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });

    const raw = await res.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = { error: raw.slice(0, 200) };
      }
    }

    if (!res.ok) {
      const code = (data && data.code) || statusToCode(res.status);
      const msg = (data && data.error) || CODE_TEXT[code] || `请求失败（${res.status}）`;
      throw new ApiError(msg, code, res.status);
    }

    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (timedOut || err.name === 'AbortError') throw new ApiError(CODE_TEXT.TIMEOUT, 'TIMEOUT', 0);
    throw new ApiError(CODE_TEXT.NETWORK, 'NETWORK', 0);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }
}

const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  session: () => request('/api/session'),

  home: () => request('/api/home'),

  search: (kw, type = 'album', page = 1) =>
    request(`/api/search${qs({ kw, type, page })}`),

  album: (id) => request(`/api/album/${encodeURIComponent(id)}`),

  albumTracks: (id, page = 1, sort = 1) =>
    request(`/api/album/${encodeURIComponent(id)}/tracks${qs({ page, sort })}`),

  track: (id) => request(`/api/track/${encodeURIComponent(id)}`),

  audio: (trackId) => request(`/api/audio/${encodeURIComponent(trackId)}`, { timeout: 30000 }),

  subscriptions: (sort = 'recent', page = 1) =>
    request(`/api/library/subscriptions${qs({ sort, page })}`),

  listened: (page = 1) => request(`/api/library/listened${qs({ page })}`),

  likes: (page = 1) => request(`/api/library/likes${qs({ page })}`),

  bought: (page = 1) => request(`/api/library/bought${qs({ page })}`),

  qrCreate: () => request('/api/login/qr', { method: 'POST', timeout: 30000 }),

  qrStatus: (qrId) => request(`/api/login/qr/${encodeURIComponent(qrId)}`),

  loginCookie: (cookie) => request('/api/login/cookie', { method: 'POST', body: { cookie } }),

  logout: () => request('/api/logout', { method: 'POST' }),

  getSettings: () => request('/api/settings'),

  putSettings: (patch) => request('/api/settings', { method: 'PUT', body: patch }),

  testProxy: (proxy) =>
    request('/api/settings/test-proxy', { method: 'POST', body: { proxy }, timeout: 20000 }),

  /** 启动时的网络自检：{ api, play, geoBlocked, proxy, message, latency } */
  networkCheck: () => request('/api/network-check', { timeout: 15000 }),
};

/** 音频代理流地址（直链在 <audio> 里播不了时的兜底） */
export function streamUrl(trackId) {
  return `/api/stream/${encodeURIComponent(trackId)}`;
}
