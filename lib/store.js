'use strict';
/**
 * 配置与登录态持久化。
 * 存放位置：$XDG_CONFIG_HOME/ximalaya-clean/（默认 ~/.config/ximalaya-clean/）
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CONFIG_DIR =
  process.env.XMLY_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ximalaya-clean');

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const COOKIE_FILE = path.join(CONFIG_DIR, 'cookie.json');
const COOKIE_BACKUP = path.join(CONFIG_DIR, 'cookie.backup.json');

const DEFAULTS = {
  quality: 'high', // high | medium | low
  proxy: '', // '' = 直连；http://host:port；socks5://host:port
  port: 8787,
  volume: 0.8,
};

function ensureDir() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch (_) {
    /* ignore */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function getSettings() {
  const raw = readJson(CONFIG_FILE, {});
  const merged = { ...DEFAULTS, ...raw };
  if (!['high', 'medium', 'low'].includes(merged.quality)) merged.quality = DEFAULTS.quality;
  if (typeof merged.proxy !== 'string') merged.proxy = '';
  if (!Number.isInteger(merged.port) || merged.port < 1024 || merged.port > 65535) {
    merged.port = DEFAULTS.port;
  }
  return merged;
}

function setSettings(patch) {
  const next = { ...getSettings(), ...(patch || {}) };
  if (!['high', 'medium', 'low'].includes(next.quality)) next.quality = DEFAULTS.quality;
  if (typeof next.proxy !== 'string') next.proxy = '';
  delete next.port; // 端口只在启动时决定，不通过设置改
  const current = getSettings();
  writeJson(CONFIG_FILE, { ...current, ...next, port: current.port });
  return getSettings();
}

function getCookie() {
  const data = readJson(COOKIE_FILE, null);
  if (!data || typeof data.cookie !== 'string' || !data.cookie) return '';
  return data.cookie;
}

// 登录凭据。少了任何一个，账号就掉线了。
const LOGIN_KEYS = ['1&_token', '1_l_flag', '1&remember_me', '4&_token'];

function hasLoginKey(cookie) {
  return LOGIN_KEYS.some((k) => String(cookie || '').includes(`${k}=`));
}

function setCookie(cookie, opts = {}) {
  const force = Boolean(opts && opts.force);
  if (!cookie) {
    try {
      fs.unlinkSync(COOKIE_FILE);
    } catch (_) {
      /* ignore */
    }
    return;
  }
  // 防止并发写入把登录凭据覆盖掉：新 Cookie 里没有登录态、
  // 但旧 Cookie 里有，就说明这是某个请求的临时 Cookie，直接丢弃。
  const prev = getCookie();
  if (!force && !hasLoginKey(cookie) && hasLoginKey(prev)) return;
  writeJson(COOKIE_FILE, { cookie, savedAt: Date.now() });
  // 备份一份「带登录态」的 Cookie，误清后还能恢复
  if (hasLoginKey(cookie)) {
    try {
      fs.copyFileSync(COOKIE_FILE, COOKIE_BACKUP);
    } catch (_) {
      /* ignore */
    }
  }
}

/** 恢复上一次的登录 Cookie（登录态被意外清掉时用） */
function restoreCookie() {
  const data = readJson(COOKIE_BACKUP, null);
  if (!data || typeof data.cookie !== 'string' || !data.cookie) return '';
  if (!hasLoginKey(data.cookie)) return '';
  setCookie(data.cookie);
  return data.cookie;
}

module.exports = {
  CONFIG_DIR,
  getSettings,
  setSettings,
  getCookie,
  setCookie,
  restoreCookie,
  hasLoginKey,
};
