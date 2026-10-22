'use strict';
/**
 * 喜马拉雅 Web / 移动端接口封装。
 *
 * 说明：本客户端只调用公开的内容读取接口，播放直链来自官方播放页接口，
 * 解密后交给浏览器 <audio> 播放 —— 全程不加载喜马拉雅的播放器与广告脚本。
 */
const crypto = require('node:crypto');
const net = require('./net');
const store = require('./store');

const WEB = 'https://www.ximalaya.com';
const PASSPORT = 'https://passport.ximalaya.com';
const PLAY_HOSTS = ['www', 'mobile', 'mobwsa']; // 播放接口可用的主机，按顺序尝试

// 播放直链的 AES-128-ECB 密钥（与网页播放器一致）
const AES_KEY = Buffer.from('aaad3e4fd540b0f79dca95606e72bf93', 'hex');

const REFERER = 'https://www.ximalaya.com/';

class ApiError extends Error {
  constructor(message, code = 'UPSTREAM', status = 502) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function settings() {
  return store.getSettings();
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function baseHeaders(extra) {
  const cookie = store.getCookie();
  return {
    Referer: REFERER,
    Origin: WEB,
    ...(cookie ? { Cookie: cookie } : {}),
    ...(extra || {}),
  };
}

/** 把 Set-Cookie 合并进已保存的 Cookie 串 */
function absorbCookies(setCookieList) {
  if (!setCookieList || !setCookieList.length) return false;
  const jar = new Map();
  for (const part of store.getCookie().split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) jar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  let changed = false;
  for (const raw of setCookieList) {
    const first = String(raw).split(';')[0];
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!name) continue;
    const lower = String(raw).toLowerCase();
    const expired = /max-age=0\b/.test(lower) || /expires=thu, 01 jan 1970/.test(lower);
    if (expired) {
      // 登录凭据不因为某个请求的过期头就被删掉，否则会莫名其妙掉线
      if (store.hasLoginKey(name + '=') && store.getCookie()) continue;
      if (jar.delete(name)) changed = true;
      continue;
    }
    if (jar.get(name) !== value) {
      jar.set(name, value);
      changed = true;
    }
  }
  if (changed) {
    store.setCookie([...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  }
  return changed;
}

function normalizeCover(path) {
  if (!path || typeof path !== 'string') return '';
  let p = path.trim();
  if (!p) return '';
  if (p.startsWith('//')) p = `https:${p}`;
  else if (/^http:\/\//i.test(p)) p = `https://${p.slice(7)}`;
  else if (!/^https?:\/\//i.test(p)) p = `https://imagev2.xmcdn.com/${p.replace(/^\/+/, '')}`;
  // 去掉图片裁剪参数，交给前端 CSS 控制尺寸
  const bang = p.indexOf('!');
  if (bang > 0) p = p.slice(0, bang);
  return p;
}

function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pick(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function firstArray(obj, keys) {
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* 底层请求                                                            */
/* ------------------------------------------------------------------ */

/**
 * 请求 www.ximalaya.com 的 /revision/* 或 /my/* 接口。
 * 不自动跟随重定向，以便把「跳登录页」识别为未登录。
 */
async function webGet(path, params, opts = {}) {
  const url = `${WEB}${path}${qs(params)}`;
  const res = await net.request(url, {
    proxy: settings().proxy,
    headers: baseHeaders(opts.headers),
    timeout: opts.timeout || 15000,
    maxRedirects: 0,
  });

  absorbCookies(res.headers['set-cookie']);

  if (res.status >= 300 && res.status < 400) {
    const loc = String(res.headers.location || '');
    if (/passport\.ximalaya\.com/i.test(loc) || /\/login/i.test(loc)) {
      throw new ApiError('需要登录喜马拉雅账号', 'NEED_LOGIN', 401);
    }
    throw new ApiError('接口被重定向了，可能需要登录', 'NEED_LOGIN', 401);
  }
  if (res.status === 401) throw new ApiError('需要登录喜马拉雅账号', 'NEED_LOGIN', 401);
  if (res.status >= 400) {
    throw new ApiError(`喜马拉雅接口异常（HTTP ${res.status}）`, 'UPSTREAM', 502);
  }

  const text = res.body.toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new ApiError('喜马拉雅返回了无法解析的内容（可能需要登录）', 'UPSTREAM', 502);
  }
  return json;
}

/** 把 ret 码翻译成友好错误 */
function checkRet(json, what) {
  const ret = toInt(json && json.ret, 200);
  if (ret === 200 || ret === 0) return json;
  if (ret === 927) {
    throw new ApiError(
      '该内容受版权地区限制：喜马拉雅只对中国大陆 IP 开放播放',
      'GEO_BLOCKED',
      403
    );
  }
  if (ret === 401 || ret === 407) {
    throw new ApiError('需要登录喜马拉雅账号', 'NEED_LOGIN', 401);
  }
  const msg = pick(json, ['msg', 'message'], `接口返回错误 ${ret}`);
  throw new ApiError(`${what || '接口'}失败：${msg}`, 'UPSTREAM', 502);
}

/* ------------------------------------------------------------------ */
/* 会话 / 登录                                                          */
/* ------------------------------------------------------------------ */

let sessionCache = { at: 0, value: null };


async function session(force = false) {
  if (!force && sessionCache.value && Date.now() - sessionCache.at < 30_000) {
    return sessionCache.value;
  }
  if (!store.getCookie()) {
    sessionCache = { at: Date.now(), value: { loggedIn: false, user: null } };
    return sessionCache.value;
  }
  try {
    const json = await webGet('/revision/main/getCurrentUser', {});
    const data = (json && json.data) || {};
    const uid = toInt(pick(data, ['uid', 'id', 'userId'], 0));
    if (!uid) throw new ApiError('需要登录', 'NEED_LOGIN', 401);
    const user = {
      uid,
      nickname: pick(data, ['nickname', 'nickName', 'userName', 'name'], '喜马拉雅用户'),
      avatar: normalizeCover(pick(data, ['avatar', 'avatarUrl', 'mobileLargeAvatar', 'largeAvatar'], '')),
      vip: Boolean(pick(data, ['isVip', 'vip', 'isVipUser'], false)),
    };
    sessionCache = { at: Date.now(), value: { loggedIn: true, user } };
    return sessionCache.value;
  } catch (err) {
    if (err.code === 'NEED_LOGIN') {
      sessionCache = { at: Date.now(), value: { loggedIn: false, user: null } };
      return sessionCache.value;
    }
    throw err;
  }
}

async function loginQr() {
  const res = await net.request(`${PASSPORT}/web/qrCode/gen?level=L`, {
    proxy: settings().proxy,
    headers: { Referer: REFERER },
    timeout: 15000,
  });
  absorbCookies(res.headers['set-cookie']);
  let json;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch (_) {
    throw new ApiError('无法获取登录二维码，请稍后重试', 'UPSTREAM', 502);
  }
  if (toInt(json.ret, -1) !== 0 || !json.qrId) {
    throw new ApiError(pick(json, ['msg'], '无法获取登录二维码'), 'UPSTREAM', 502);
  }
  return {
    qrId: json.qrId,
    img: `data:image/png;base64,${json.img}`,
  };
}

async function loginQrCheck(qrId) {
  const ts = Date.now();
  const res = await net.request(`${PASSPORT}/web/qrCode/check/${encodeURIComponent(qrId)}/${ts}`, {
    proxy: settings().proxy,
    headers: { Referer: REFERER },
    timeout: 15000,
  });
  const setCookies = res.headers['set-cookie'] || [];
  let json;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch (_) {
    return { status: 'pending' };
  }
  const ret = toInt(json.ret, -1);

  if (ret === 0) {
    absorbCookies(setCookies);
    if (!store.getCookie()) {
      throw new ApiError('登录成功但没有拿到凭证，请重试', 'UPSTREAM', 502);
    }
    sessionCache = { at: 0, value: null };
    const s = await session(true);
    if (!s.loggedIn) {
      throw new ApiError('登录凭证无效，请重试', 'NEED_LOGIN', 401);
    }
    return { status: 'success', user: s.user };
  }
  if (ret === 32000 || ret === 32001) return { status: 'pending' };
  if (ret === 32002) return { status: 'scanned' };
  if (ret === 32003 || ret === 32004) return { status: 'expired' };
  // 其他未知返回，按等待处理，避免二维码一闪而过
  return { status: 'pending' };
}

async function loginWithCookie(cookie) {
  const value = String(cookie || '').trim();
  if (!value) throw new ApiError('Cookie 不能为空', 'BAD_REQUEST', 400);
  if (!/&_token=|_token=/.test(value)) {
    // 不强制，但给出提示
    void 0;
  }
  store.setCookie(value, { force: true });
  sessionCache = { at: 0, value: null };
  const s = await session(true);
  if (!s.loggedIn) {
    store.setCookie('', { force: true });
    throw new ApiError('Cookie 无效或已过期，请重新复制', 'NEED_LOGIN', 401);
  }
  return s;
}

function logout() {
  store.setCookie('', { force: true });
  sessionCache = { at: 0, value: null };
}

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

function albumFromRecommend(a) {
  const isPaid = Boolean(pick(a, ['isPaid', 'is_paid'], false));
  const isVip = toInt(pick(a, ['vipType', 'vipFreeType'], 0)) > 0;
  return {
    id: toInt(pick(a, ['albumId', 'id'], 0)),
    title: pick(a, ['albumTitle', 'title'], ''),
    cover: normalizeCover(pick(a, ['albumCoverPath', 'coverPath', 'cover', 'cover_path'], '')),
    anchor: {
      uid: toInt(pick(a, ['anchorId', 'anchorUid', 'uid'], 0)),
      name: pick(a, ['albumUserNickName', 'anchorName', 'nickname', 'nickName'], ''),
      avatar: normalizeCover(pick(a, ['anchorCoverPath', 'avatar'], '')),
    },
    intro: stripHtml(pick(a, ['intro', 'shortIntro', 'description'], '')),
    trackCount: toInt(pick(a, ['albumTrackCount', 'trackCount', 'tracks'], 0)),
    playCount: toInt(pick(a, ['albumPlayCount', 'playCount', 'play'], 0)),
    isPaid,
    isVip,
    isFinished: [1, 2, true].includes(pick(a, ['isFinished', 'is_finished'], 0)),
    updatedAt: pick(a, ['updateDate', 'lastUptrackAtStr', 'updatedAt'], ''),
    category: pick(a, ['categoryTitle', 'category_title'], ''),
  };
}

function albumFromSearch(doc) {
  return {
    id: toInt(pick(doc, ['id', 'albumId'], 0)),
    title: pick(doc, ['title', 'albumTitle'], ''),
    cover: normalizeCover(pick(doc, ['cover_path', 'coverPath', 'albumCoverPath'], '')),
    anchor: {
      uid: toInt(pick(doc, ['uid', 'anchorId'], 0)),
      name: pick(doc, ['nickname', 'custom_title', 'anchorName'], ''),
      avatar: '',
    },
    intro: stripHtml(pick(doc, ['intro', 'description'], '')),
    trackCount: toInt(pick(doc, ['tracks', 'trackCount', 'albumTrackCount'], 0)),
    playCount: toInt(pick(doc, ['play', 'playCount'], 0)),
    isPaid: Boolean(pick(doc, ['is_paid', 'isPaid'], false)),
    isVip: Boolean(pick(doc, ['isVipFree', 'isVip'], false)),
    bought: Boolean(pick(doc, ['hasBuy', 'has_buy'], false)),
    isFinished: Boolean(pick(doc, ['is_finished', 'isFinished'], false)),
    updatedAt: '',
    category: pick(doc, ['category_title', 'categoryTitle'], ''),
  };
}

function albumFromMy(item, userVip, opts = {}) {
  const anchor = item.anchor || {};
  const isPaid = Boolean(pick(item, ['isPaid'], false));
  const isVip = toInt(pick(item, ['vipType'], 0)) > 0;
  const bought = Boolean(pick(item, ['hasBuy', 'isBuy', 'hasBought'], false));
  // 「我的」列表接口的 vipType 恒为 0，分辨不出 VIP 免费专辑，
  // 又不能为每张专辑单独查一次（服务器会串行处理，30 张要 30 秒）。
  // 所以这里标成 unknown，进专辑页时再给出准确状态。
  const access = opts.fromList && isPaid && !isVip ? 'unknown' : accessState({ isPaid, isVip, bought, userVip });
  return {
    id: toInt(pick(item, ['id', 'albumId'], 0)),
    title: pick(item, ['title', 'albumTitle'], ''),
    cover: normalizeCover(pick(item, ['cover', 'coverPath', 'albumCoverPath'], '')),
    anchor: {
      uid: toInt(pick(anchor, ['id', 'anchorUid'], pick(item, ['anchorUid'], 0))),
      name: pick(anchor, ['nickName', 'anchorNickName'], pick(item, ['nickname'], '')),
      avatar: normalizeCover(pick(anchor, ['cover', 'anchorCoverPath'], '')),
    },
    intro: stripHtml(pick(item, ['description', 'intro', 'subTitle'], '')),
    trackCount: toInt(pick(item, ['trackCount', 'albumTrackCount'], 0)),
    playCount: toInt(pick(item, ['playCount', 'albumPlayCount'], 0)),
    isPaid,
    isVip,
    bought,
    access,
    locked: access === 'locked' || access === 'vip-locked',
    isFinished: Boolean(pick(item, ['isFinished'], false)),
    updatedAt: pick(item, ['lastUptrackAtStr', 'updateDate'], ''),
    category: pick(item, ['categoryTitle'], ''),
  };
}

/** 当前账号是不是会员（我的内容列表里要用它算 access） */
async function currentUserVip() {
  try {
    const u = await session();
    return Boolean(u.loggedIn && u.user && u.user.vip);
  } catch (_) {
    return false;
  }
}

/**
 * 计算一条内容对「当前账号」的访问状态。
 *
 * 喜马拉雅的付费标记很粗糙：VIP 免费专辑的每一集都带 isPaid=true，
 * 但会员其实能直接听。这里统一换算成三种状态：
 *   free   —— 免费内容
 *   vip    —— 会员免费（会员可直接听，非会员需要开会员）
 *   locked —— 需要单独购买
 */
/** 「最近收听」条目（字段名和别处不一样） */
function trackFromListened(item) {
  return {
    id: toInt(pick(item, ['trackId', 'id'], 0)),
    albumId: toInt(pick(item, ['albumId'], 0)),
    albumTitle: pick(item, ['albumName', 'albumTitle'], ''),
    index: toInt(pick(item, ['index', 'orderNo'], 0)),
    title: pick(item, ['trackTitle', 'title', 'trackName'], ''),
    cover: normalizeCover(pick(item, ['trackCover', 'cover', 'coverPath'], '')),
    duration: toInt(pick(item, ['trackDuration', 'duration'], 0)),
    isPaid: Boolean(pick(item, ['isPaid'], false)),
    vip: false,
    bought: false,
    locked: false,
    playable: true,
    publishedAt: pick(item, ['createAtStr', 'createAt'], ''),
  };
}

function accessState({ isPaid, isVip, bought, userVip }) {
  if (!isPaid) return 'free';
  // VIP 专辑优先按会员判断：喜马拉雅对会员也返回 hasBuy=true，
  // 显示成「已购」会让人误以为单独买过，所以先看 isVip。
  if (isVip) return userVip ? 'vip' : 'vip-locked';
  if (bought) return 'bought';
  return 'locked';
}

function trackFromShow(t, album) {
  const albumVip = album ? album.isVip : false;
  const albumBought = album ? album.bought : false;
  const albumLocked = album ? album.locked : false;
  const isPaid = Boolean(pick(t, ['isPaid'], album ? album.isPaid : false));
  return {
    id: toInt(pick(t, ['trackId', 'id'], 0)),
    albumId: toInt(pick(t, ['albumId'], album ? album.id : 0)),
    albumTitle: pick(t, ['albumName', 'albumTitle'], album ? album.title : ''),
    index: toInt(pick(t, ['index', 'orderNo'], 0)),
    title: pick(t, ['trackName', 'title'], ''),
    cover: normalizeCover(pick(t, ['trackCoverPath', 'coverPath'], album ? album.cover : '')),
    duration: toInt(pick(t, ['duration'], 0)),
    isPaid,
    vip: albumVip,
    bought: albumBought,
    locked: isPaid && albumLocked,
    playable: !(isPaid && albumLocked),
    publishedAt: pick(t, ['updateTime', 'createTime'], ''),
  };
}

function trackFromSearch(doc) {
  return {
    id: toInt(pick(doc, ['id', 'trackId'], 0)),
    albumId: toInt(pick(doc, ['album_id', 'albumId'], 0)),
    albumTitle: pick(doc, ['album_title', 'albumTitle'], ''),
    index: 0,
    title: pick(doc, ['title'], ''),
    cover: normalizeCover(
      pick(doc, ['cover_path', 'album_cover_path', 'albumCoverPath', 'coverPath'], '')
    ),
    duration: toInt(pick(doc, ['duration'], 0)),
    isPaid: Boolean(pick(doc, ['is_paid', 'isPaid'], false)),
    vip: Boolean(pick(doc, ['isVipFree', 'vipType'], false)),
    bought: Boolean(pick(doc, ['hasBuy'], false)),
    locked: false,
    playable: Boolean(pick(doc, ['is_authorized', 'isAuthorized'], true)),
    publishedAt: '',
  };
}

function trackFromMy(item) {
  return {
    id: toInt(pick(item, ['trackId', 'id'], 0)),
    albumId: toInt(pick(item, ['albumId', 'album_id'], 0)),
    albumTitle: pick(item, ['albumTitle', 'albumName', 'album_title'], ''),
    index: toInt(pick(item, ['index', 'orderNo'], 0)),
    title: pick(item, ['trackTitle', 'title', 'trackName'], ''),
    cover: normalizeCover(pick(item, ['trackCoverPath', 'coverPath', 'cover'], '')),
    duration: toInt(pick(item, ['duration'], 0)),
    isPaid: Boolean(pick(item, ['isPaid'], false)),
    vip: toInt(pick(item, ['vipType'], 0)) > 0,
    bought: Boolean(pick(item, ['hasBuy'], false)),
    locked: false,
    playable: true,
    publishedAt: pick(item, ['updateTime', 'createTime', 'createdAt'], ''),
  };
}

/* ------------------------------------------------------------------ */
/* 内容接口                                                            */
/* ------------------------------------------------------------------ */

async function home() {
  const sections = [];
  try {
    const json = await webGet('/revision/explore/v2/getRecommend', {});
    const cards = (json && json.data && json.data.cards) || [];
    for (const card of cards) {
      const albums = (card.albumList || []).map(albumFromRecommend).filter((a) => a.id);
      if (albums.length) {
        sections.push({ title: pick(card, ['title', 'name'], '推荐'), albums });
      }
    }
  } catch (_) {
    /* 推荐失败不影响主流程 */
  }

  if (!sections.length) {
    try {
      const json = await webGet('/revision/explore/guessYouLike', { pageNum: 1, pageSize: 18 });
      const list = (json && json.data && json.data.recommendInfoList) || [];
      const albums = list.map(albumFromRecommend).filter((a) => a.id);
      if (albums.length) sections.push({ title: '猜你喜欢', albums });
    } catch (_) {
      /* ignore */
    }
  }
  return { sections };
}

async function search(kw, type = 'album', page = 1) {
  const keyword = String(kw || '').trim();
  if (!keyword) return { albums: [], tracks: [], total: 0, page: 1 };
  const core = type === 'track' ? 'track' : 'album';
  const json = await webGet('/revision/search', {
    core,
    kw: keyword,
    page: Math.max(1, toInt(page, 1)),
    rows: 20,
    spellchecker: true,
    condition: 'relation',
    device: 'pc',
  });
  checkRet(json, '搜索');
  const response = (((json.data || {}).result || {}).response || {});
  const docs = response.docs || [];
  return {
    albums: core === 'album' ? docs.map(albumFromSearch).filter((a) => a.id) : [],
    tracks: core === 'track' ? docs.map(trackFromSearch).filter((t) => t.id) : [],
    total: toInt(response.numFound, docs.length),
    page: Math.max(1, toInt(page, 1)),
  };
}

/** 专辑总集数：web 接口不返回，用移动端播放列表接口补 */
async function albumTrackTotal(albumId) {
  try {
    const res = await net.request(
      `https://mobwsa.ximalaya.com/mobile/playlist/album/page${qs({ albumId, pageId: 1 })}`,
      { proxy: settings().proxy, headers: baseHeaders(), timeout: 10000 }
    );
    const json = JSON.parse(res.body.toString('utf8'));
    return toInt(pick(json, ['totalCount'], 0));
  } catch (_) {
    return 0;
  }
}

async function albumInfo(albumId) {
  const json = await webGet('/revision/album/v1/simple', { albumId });
  checkRet(json, '获取专辑');
  const main = (json.data && json.data.albumPageMainInfo) || {};
  let trackCount = toInt(pick(main, ['trackCount', 'tracks'], 0));
  if (!trackCount) trackCount = await albumTrackTotal(albumId);

  const isPaid = Boolean(pick(main, ['isPaid'], false));
  const isVip = toInt(pick(main, ['vipType', 'ximiVipFreeType'], 0)) > 0;
  const bought = Boolean(pick(main, ['hasBuy'], false));
  const user = await session();
  const userVip = Boolean(user.loggedIn && user.user && user.user.vip);
  const access = accessState({ isPaid, isVip, bought, userVip });
  const locked = access === 'locked' || access === 'vip-locked';

  const album = {
    id: toInt(pick(main, ['albumId'], albumId)),
    title: pick(main, ['albumTitle', 'customTitle'], ''),
    cover: normalizeCover(pick(main, ['cover'], '')),
    anchor: {
      uid: toInt(pick(main, ['anchorUid'], 0)),
      name: pick(main, ['anchorName', 'nickname'], ''),
      avatar: '',
    },
    intro: stripHtml(pick(main, ['shortIntro', 'richIntro', 'detailRichIntro'], '')),
    trackCount,
    playCount: toInt(pick(main, ['playCount'], 0)),
    isPaid,
    isVip,
    bought,
    access, // free | vip | vip-locked | bought | locked
    locked, // 当前账号是否能直接听
    isFinished: toInt(pick(main, ['isFinished'], 0)) === 1,
    updatedAt: pick(main, ['updateDate'], ''),
    category: pick(main, ['categoryTitle'], ''),
  };
  return album;
}

/**
 * 节目列表。
 * @param {number} page 1 起
 * @param {number} sort 1 = 正序（旧→新），-1 = 倒序（新→旧）
 *
 * 注意：网页接口的 sort 语义与直觉相反 —— sort=0 为升序，sort=1 为降序。
 */
async function albumTracks(albumId, page = 1, sort = 1, album = null) {
  const asc = toInt(sort, 1) !== -1;
  const json = await webGet('/revision/play/v1/show', {
    id: albumId,
    num: Math.max(1, toInt(page, 1)),
    sort: asc ? 0 : 1,
    size: 30,
    ptype: 0,
  });
  checkRet(json, '获取节目列表');
  const data = (json && json.data) || {};
  const raw = data.tracksAudioPlay || data.tracks || [];
  const tracks = raw.map((t) => trackFromShow(t, album)).filter((t) => t.id);
  const pageNum = toInt(pick(data, ['pageNum', 'page'], page), page);
  const pageSize = toInt(pick(data, ['pageSize'], 30), 30);
  let total = album && album.trackCount ? album.trackCount : 0;
  if (!total) total = await albumTrackTotal(albumId);
  if (!total) total = pageNum * pageSize + (data.hasMore ? 1 : 0);
  return {
    tracks,
    page: pageNum,
    total,
    hasMore: Boolean(pick(data, ['hasMore'], tracks.length >= pageSize)),
  };
}

async function trackInfo(trackId) {
  // trackPageInfo 比 track/simple 多带 albumInfo，能直接拿到 albumId / 集数
  const json = await webGet('/revision/track/trackPageInfo', { trackId });
  checkRet(json, '获取声音信息');
  const data = (json && json.data) || {};
  const t = data.trackInfo || {};
  const albumInfo = data.albumInfo || {};
  return {
    id: toInt(pick(t, ['trackId'], trackId)),
    albumId: toInt(pick(albumInfo, ['albumId'], 0)),
    albumTitle: pick(albumInfo, ['title'], ''),
    index: toInt(pick(t, ['positionInAlbum'], 0)) || 0,
    title: pick(t, ['title'], ''),
    cover: normalizeCover(pick(t, ['coverPath'], pick(albumInfo, ['coverPath'], ''))),
    duration: toInt(pick(t, ['duration'], 0)),
    isPaid: Boolean(pick(t, ['isPaid'], false)),
    playable: Boolean(pick(t, ['isAuthorized'], true)),
    publishedAt: pick(t, ['lastUpdate'], ''),
  };
}

/* ------------------------------------------------------------------ */
/* 播放直链                                                            */
/* ------------------------------------------------------------------ */

function decryptPlayUrl(encoded) {
  const text = String(encoded || '').trim();
  if (!text) return '';
  // 已经是明文地址（部分接口直接返回）
  if (/^https?:\/\//i.test(text)) return text;
  let b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const buf = Buffer.from(b64, 'base64');
  try {
    const d = crypto.createDecipheriv('aes-128-ecb', AES_KEY, null);
    const out = Buffer.concat([d.update(buf), d.final()]).toString('utf8').trim();
    return out;
  } catch (_) {
    return '';
  }
}

const QUALITY_LEVELS = { low: 1, medium: 2, high: 3 };
const QUALITY_NAMES = { 0: '24k', 1: '64k', 2: '128k', 3: '256k' };

function toHttps(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
}

function pickPlayItem(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const sorted = [...list].sort((a, b) => toInt(b.qualityLevel, 0) - toInt(a.qualityLevel, 0));
  return sorted[0] || list[0];
}

/**
 * 移动端老接口：直接返回明文的播放地址，且不受网页播放接口的地区限制。
 */
const LEGACY_QUALITY_ORDER = {
  high: ['playPathHq', 'playPathAacv164', 'playUrl64', 'playPathAacv224', 'playUrl32'],
  medium: ['playPathAacv164', 'playUrl64', 'playPathAacv224', 'playUrl32', 'playPathHq'],
  low: ['playPathAacv224', 'playUrl32', 'playPathAacv164', 'playUrl64', 'playPathHq'],
};

const LEGACY_QUALITY_NAME = {
  playPathHq: 'HQ',
  playPathAacv164: '64k',
  playUrl64: '64k mp3',
  playPathAacv224: '24k',
  playUrl32: '32k',
};

async function audioUrlLegacy(trackId) {
  const res = await net.request(
    `https://mobile.ximalaya.com/mobile/track/baseInfo${qs({ trackId })}`,
    {
      proxy: settings().proxy,
      headers: baseHeaders({ 'User-Agent': 'ting_6.3.60(sdk,Android16)' }),
      timeout: 15000,
    }
  );
  absorbCookies(res.headers['set-cookie']);
  let json;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch (_) {
    return null;
  }
  if (toInt(json.ret, 0) !== 0) return null;

  const quality = settings().quality || 'high';
  const order = LEGACY_QUALITY_ORDER[quality] || LEGACY_QUALITY_ORDER.high;
  let chosen = null;
  for (const key of order) {
    const url = toHttps(json[key] || '');
    if (url) {
      chosen = { url, quality: LEGACY_QUALITY_NAME[key] || key };
      break;
    }
  }

  if (!chosen) {
    return {
      empty: true,
      isPaid: Boolean(json.isPaid),
      isAuthorized: Boolean(json.isAuthorized),
      vipFreeType: toInt(json.vipFreeType, 0),
      title: json.title || '',
    };
  }
  return {
    url: chosen.url,
    quality: chosen.quality,
    duration: toInt(json.duration, 0),
    title: json.title || '',
  };
}

/** 网页播放接口：需要解密，且海外 IP 会被地区限制（有账号时可用于 VIP 内容） */
async function audioUrlModern(trackId) {
  const desired = QUALITY_LEVELS[settings().quality] || 3;
  const levels = [...new Set([desired, 2, 1, 0])];
  let lastErr = null;

  for (const host of PLAY_HOSTS) {
    for (const level of levels) {
      const url = `https://${host}.ximalaya.com/mobile-playpage/track/v3/baseInfo/${Date.now()}${qs(
        { device: 'web', trackId, trackQualityLevel: level }
      )}`;
      let json;
      try {
        const res = await net.request(url, {
          proxy: settings().proxy,
          headers: baseHeaders(),
          timeout: 15000,
        });
        absorbCookies(res.headers['set-cookie']);
        json = JSON.parse(res.body.toString('utf8'));
      } catch (err) {
        lastErr = new ApiError('无法连接喜马拉雅播放接口', 'NETWORK', 502);
        continue;
      }

      const ret = toInt(json.ret, -1);
      if (ret === 927) {
        // 地区限制是按 IP 判定的，换主机/换音质都没用，直接结束
        throw new ApiError(
          '该内容受版权地区限制：喜马拉雅只对中国大陆 IP 开放播放',
          'GEO_BLOCKED',
          403
        );
      }
      if (ret !== 0 && ret !== 200) {
        lastErr = new ApiError(pick(json, ['msg'], '获取播放地址失败'), 'UPSTREAM', 502);
        continue;
      }

      const info = json.trackInfo || json.data || {};
      const list = info.playUrlList || [];
      const item = pickPlayItem(list);
      if (!item) {
        lastErr = new ApiError(
          pick(info, ['isPaid'], false)
            ? '这是付费内容，当前账号未购买'
            : '这条声音暂时没有可播放的地址',
          pick(info, ['isPaid'], false) ? 'PAID' : 'UPSTREAM',
          pick(info, ['isPaid'], false) ? 403 : 502
        );
        continue;
      }

      const decoded = decryptPlayUrl(pick(item, ['url', 'playUrl', 'src'], ''));
      if (!decoded) {
        lastErr = new ApiError('播放地址解密失败', 'UPSTREAM', 502);
        continue;
      }
      return {
        url: toHttps(decoded),
        quality: QUALITY_NAMES[toInt(item.qualityLevel, level)] || `${level}`,
        duration: toInt(pick(info, ['duration'], 0), 0),
      };
    }
  }
  throw lastErr || new ApiError('获取播放地址失败', 'UPSTREAM', 502);
}

/**
 * 取播放直链。
 * 先走移动端老接口（通常不受地区限制），失败再退回网页播放接口。
 */
async function audioUrl(trackId) {
  let legacy = null;
  try {
    legacy = await audioUrlLegacy(trackId);
  } catch (_) {
    legacy = null;
  }

  if (legacy && legacy.url) {
    const resolved = await resolveRedirect(legacy.url);
    // 老接口给的是跳转地址，解析不出来说明这一跳被拦了（常见于地区限制），
    // 这时继续往下试网页播放接口，别把跳转地址当成音频地址交给播放器。
    if (!/\/mobile\/redirect\//i.test(resolved)) {
      return { url: resolved, quality: legacy.quality, duration: legacy.duration };
    }
  }

  // 明确是付费/VIP 且当前账号没权限时，不用再去网页接口白跑一轮
  if (legacy && legacy.empty && legacy.isPaid && !legacy.isAuthorized) {
    if (legacy.vipFreeType > 0) {
      throw new ApiError(
        '这条内容需要 VIP 会员。请在客户端里登录已开通会员的喜马拉雅账号。',
        'VIP_REQUIRED',
        403
      );
    }
    throw new ApiError(
      '这是付费内容，当前账号没有购买（或在客户端里登录已购买该专辑的账号）',
      'PAID',
      403
    );
  }

  try {
    const modern = await audioUrlModern(trackId);
    return { ...modern, url: await resolveRedirect(modern.url) };
  } catch (err) {
    if (legacy && legacy.empty) {
      if (err.code === 'GEO_BLOCKED') throw err;
      if (err.code === 'PAID') throw err;
      throw new ApiError(
        '这条声音暂时没有可播放的地址（可能需要 VIP 会员，或已下架）',
        'UPSTREAM',
        502
      );
    }
    throw err;
  }
}

/**
 * 部分节目返回的是喜马拉雅的跳转地址（如 /mobile/redirect/free/play/...），
 * 跟随一次拿到真正的 CDN 直链。
 */
async function resolveRedirect(url) {
  if (!/ximalaya\.com\/mobile\/redirect\//i.test(url)) return url;
  // 手动逐跳解析，且只要响应头 —— 终点是 CDN 上的音频文件，
  // 跟着下载正文会白白等上好几秒。
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    let res;
    try {
      res = await net.request(current, {
        proxy: settings().proxy,
        headers: baseHeaders({ 'User-Agent': 'ting_6.3.60(sdk,Android16)' }),
        timeout: 12000,
        maxRedirects: 0,
        headersOnly: true,
      });
    } catch (_) {
      return current;
    }
    const loc = res.headers && res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      current = new URL(loc, current).href;
      continue;
    }
    return toHttps(current);
  }
  return toHttps(current);
}

/* ------------------------------------------------------------------ */
/* 我的内容                                                            */
/* ------------------------------------------------------------------ */

async function librarySubscriptions(sort = 'recent', page = 1) {
  const path =
    sort === 'sub'
      ? '/revision/my/getSubscriptionBySubAt'
      : sort === 'update'
        ? '/revision/my/getSubscriptionByCreateAt'
        : '/revision/my/getSubscriptionSynthesize';
  // 先拿会员状态，再请求列表：并行发两个请求会互相覆盖 Cookie 存储
  const userVip = await currentUserVip();
  const json = await webGet(path, { pageNum: Math.max(1, toInt(page, 1)), pageSize: 30 });
  checkRet(json, '获取订阅');
  const data = json.data || {};
  const list = firstArray(data, ['albumsInfo', 'albumList', 'list', 'albums']);
  const total = toInt(pick(data, ['totalCount', 'total'], list.length), list.length);
  const pageNum = toInt(pick(data, ['pageNum', 'page'], page), page);
  const pageSize = toInt(pick(data, ['pageSize'], 30), 30);
  const albums = list.map((it) => albumFromMy(it, userVip, { fromList: true })).filter((a) => a.id);
  return {
    albums,
    total,
    hasMore: Boolean(pick(data, ['hasMore'], pageNum * pageSize < total)),
  };
}

async function libraryListened(page = 1) {
  const json = await webGet('/revision/my/getListened', {
    pageNum: Math.max(1, toInt(page, 1)),
    pageSize: 30,
  });
  checkRet(json, '获取最近收听');
  const data = json.data || {};
  // 接口按 today / yesterday / earlier 三段返回
  const list = firstArray(data, ['tracks', 'listenedTracks', 'trackList', 'list', 'records']);
  if (!list.length) {
    for (const key of ['today', 'yesterday', 'earlier']) {
      if (Array.isArray(data[key])) list.push(...data[key]);
    }
  }
  return {
    tracks: list.map(trackFromListened).filter((t) => t.id),
    hasMore: Boolean(pick(data, ['hasMore'], list.length >= 30)),
  };
}

async function libraryLikes(page = 1) {
  const json = await webGet('/revision/my/getLikeTracks', { pageNum: Math.max(1, toInt(page, 1)), pageSize: 30 });
  checkRet(json, '获取我喜欢的');
  const data = json.data || {};
  const list = firstArray(data, ['tracksList', 'tracks', 'trackList', 'likeTracks', 'list']);
  return {
    tracks: list.map(trackFromMy).filter((t) => t.id),
    hasMore: Boolean(pick(data, ['hasMore'], list.length >= 30)),
  };
}

async function libraryBought(page = 1) {
  const userVip = await currentUserVip();
  const json = await webGet('/revision/my/getHasBroughtAlbums', {
    pageNum: Math.max(1, toInt(page, 1)),
    pageSize: 30,
  });
  checkRet(json, '获取已购专辑');
  const data = json.data || {};
  const list = firstArray(data, ['albumList', 'albums', 'list']);
  const albums = list.map((it) => albumFromMy(it, userVip, { fromList: true })).filter((a) => a.id);
  return {
    albums,
    hasMore: Boolean(pick(data, ['hasMore'], list.length >= 30)),
  };
}

/* ------------------------------------------------------------------ */
/* 网络自检                                                            */
/* ------------------------------------------------------------------ */

/**
 * 检查当前网络能否正常访问喜马拉雅接口 / 播放接口。
 * 海外 IP 会命中版权地区限制，这个检查能提前告诉用户。
 */
async function networkCheck() {
  const out = { api: false, play: false, geoBlocked: false, proxy: settings().proxy, message: '' };
  const started = Date.now();

  try {
    const json = await webGet('/revision/time', {});
    out.api = Boolean(json);
  } catch (err) {
    out.message = `无法连接喜马拉雅接口：${err.message}`;
    return out;
  }

  // 用一条公开节目探测播放能力（不下载音频，只看能否拿到直链）
  const PROBE_TRACK = 514399973; // 「你好，西藏」中的一集，公开可听
  try {
    const probe = await audioUrlLegacy(PROBE_TRACK);
    if (probe && probe.url) {
      out.play = true;
      out.message = '网络正常，可以播放。';
    } else {
      // 老接口没给地址，看看网页接口是不是地区限制
      try {
        await audioUrlModern(PROBE_TRACK);
        out.play = true;
        out.message = '网络正常，可以播放。';
      } catch (err) {
        if (err.code === 'GEO_BLOCKED') {
          out.geoBlocked = true;
          out.message =
            '播放接口受地区限制：喜马拉雅只对中国大陆 IP 开放音频。浏览、搜索、订阅可以正常用，播放需要中国大陆网络或代理。';
        } else {
          out.message = err.message;
        }
      }
    }
  } catch (err) {
    out.message = `播放接口不可用：${err.message}`;
  }

  out.latency = Date.now() - started;
  return out;
}

module.exports = {
  ApiError,
  session,
  loginQr,
  loginQrCheck,
  loginWithCookie,
  logout,
  home,
  search,
  albumInfo,
  albumTracks,
  trackInfo,
  audioUrl,
  librarySubscriptions,
  libraryListened,
  libraryLikes,
  libraryBought,
  normalizeCover,
  networkCheck,
};
