'use strict';
/**
 * 极简 HTTP 客户端：支持直连 / HTTP(S) 代理 / SOCKS5 代理。
 * 只依赖 Node 内置模块，便于在 Steam Deck 这类机器上零安装运行。
 */
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { URL } = require('node:url');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* 代理连接                                                            */
/* ------------------------------------------------------------------ */

function parseProxy(proxy) {
  if (!proxy || typeof proxy !== 'string') return null;
  let raw = proxy.trim();
  if (!raw) return null;
  if (!/^[a-z0-9+]+:\/\//i.test(raw)) raw = `http://${raw}`;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return null;
  }
  const protocol = u.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h', 'socks'].includes(protocol)) return null;
  const port = Number(u.port) || (protocol === 'https' ? 443 : protocol.startsWith('socks') ? 1080 : 8080);
  return {
    protocol,
    host: u.hostname,
    port,
    auth:
      u.username || u.password
        ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
        : null,
  };
}

function tcpConnect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接代理 ${host}:${port} 超时`));
    }, timeout);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 通过 HTTP 代理建立 CONNECT 隧道 */
function httpProxyTunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const auth = proxy.auth
      ? 'Basic ' + Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64')
      : null;
    const headers = { Host: `${host}:${port}`, 'Proxy-Connection': 'keep-alive' };
    if (auth) headers['Proxy-Authorization'] = auth;

    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
      timeout,
    });

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理拒绝连接（HTTP ${res.statusCode}）`));
        return;
      }
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.once('timeout', () => {
      req.destroy(new Error('代理连接超时'));
    });
    req.once('error', (err) => reject(err));
    req.end();
  });
}

/** SOCKS5 无认证 / 用户名密码握手，返回已连到目标的 socket */
async function socks5Connect(proxy, host, port, timeout) {
  const socket = await tcpConnect(proxy.host, proxy.port, timeout);
  return new Promise((resolve, reject) => {
    const fail = (msg) => {
      socket.destroy();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('SOCKS5 握手超时'), timeout);
    let stage = 0;
    let buf = Buffer.alloc(0);

    const wantsAuth = Boolean(proxy.auth);
    socket.write(Buffer.from([0x05, wantsAuth ? 2 : 1, ...(wantsAuth ? [0x00, 0x02] : [0x00])]));

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (stage === 0) {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05) return fail('SOCKS5 代理响应异常');
          const method = buf[1];
          buf = buf.subarray(2);
          if (method === 0xff) return fail('SOCKS5 代理不接受任何认证方式');
          if (method === 0x02) {
            if (!proxy.auth) return fail('SOCKS5 代理要求用户名密码');
            const user = Buffer.from(proxy.auth.username);
            const pass = Buffer.from(proxy.auth.password);
            const pkt = Buffer.concat([
              Buffer.from([0x01, user.length]),
              user,
              Buffer.from([pass.length]),
              pass,
            ]);
            socket.write(pkt);
            stage = 1;
            return;
          }
          sendConnect();
          stage = 2;
          return;
        }
        if (stage === 1) {
          if (buf.length < 2) return;
          if (buf[1] !== 0x00) return fail('SOCKS5 用户名密码认证失败');
          buf = buf.subarray(2);
          sendConnect();
          stage = 2;
          return;
        }
        if (stage === 2) {
          if (buf.length < 4) return;
          const rep = buf[1];
          if (rep !== 0x00) {
            const reasons = {
              1: '代理内部错误',
              2: '规则不允许连接',
              3: '网络不可达',
              4: '主机不可达',
              5: '连接被拒绝',
              6: 'TTL 过期',
              7: '不支持的命令',
              8: '不支持的地址类型',
            };
            return fail(`SOCKS5 连接失败：${reasons[rep] || '错误码 ' + rep}`);
          }
          clearTimeout(timer);
          socket.removeListener('data', onData);
          // 丢弃剩余握手字节（正常情况没有）
          if (buf.length > 4) {
            const rest = buf.subarray(4);
            const atyp = buf[3];
            const skip = atyp === 0x01 ? 4 + 2 : atyp === 0x04 ? 16 + 2 : 1 + buf[4] + 2;
            const tail = buf.subarray(4 + skip);
            void rest;
            if (tail.length) socket.unshift(tail);
          }
          socket.setNoDelay(true);
          resolve(socket);
        }
      } catch (err) {
        fail(err.message);
      }
    };

    function sendConnect() {
      const hostBuf = Buffer.from(host);
      const pkt = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]);
      socket.write(pkt);
    }

    socket.on('data', onData);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 建立到目标的 socket（可能经过代理）。
 * 返回 { socket, isTls }
 */
async function openSocket({ host, port, isHttps, proxy, timeout = 20000 }) {
  const p = parseProxy(proxy);
  if (!p) {
    if (!isHttps) {
      return { socket: await tcpConnect(host, port, timeout), isTls: false };
    }
    return { socket: await tlsConnect(host, port, timeout), isTls: true };
  }

  if (p.protocol.startsWith('socks')) {
    const raw = await socks5Connect(p, host, port, timeout);
    if (!isHttps) return { socket: raw, isTls: false };
    return { socket: await wrapTls(raw, host, timeout), isTls: true };
  }

  // http / https 代理
  if (!isHttps) {
    // 明文 HTTP 走代理：直接把代理当服务器，路径用绝对 URL
    const raw = await tcpConnect(p.host, p.port, timeout);
    return { socket: raw, isTls: false, httpProxy: p };
  }
  const tunnel = await httpProxyTunnel(p, host, port, timeout);
  return { socket: await wrapTls(tunnel, host, timeout), isTls: true };
}

function tlsConnect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host} 超时`));
    }, timeout);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function wrapTls(socket, host, timeout) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => {
      t.destroy();
      reject(new Error(`TLS 握手超时（${host}）`));
    }, timeout);
    t.once('secureConnect', () => {
      clearTimeout(timer);
      t.setNoDelay(true);
      resolve(t);
    });
    t.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

function buildOptions(url, { method, headers, proxy, httpProxy }) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const path = httpProxy ? u.href : `${u.pathname}${u.search}`;
  const host = httpProxy ? `${httpProxy.host}:${httpProxy.port}` : u.hostname;
  return {
    isHttps,
    host,
    port: httpProxy ? httpProxy.port : port,
    path,
    servername: u.hostname,
    headers: {
      Host: u.host,
      ...headers,
    },
    method,
  };
}

/**
 * 发起请求并读完响应体。
 * @returns {Promise<{status:number, headers:object, body:Buffer, url:string}>}
 */
async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    proxy = '',
    timeout = 20000,
    maxRedirects = 5,
    headersOnly = false,
  } = opts;

  const { socket, isTls, httpProxy } = await openSocket({
    host: new URL(url).hostname,
    port: Number(new URL(url).port) || (new URL(url).protocol === 'https:' ? 443 : 80),
    isHttps: new URL(url).protocol === 'https:',
    proxy,
    timeout,
  });

  const options = buildOptions(url, { method, headers, proxy, httpProxy });
  const mod = isTls ? https : http;
  const finalHeaders = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    Connection: 'close',
    ...options.headers,
    ...headers,
  };
  if (body) finalHeaders['Content-Length'] = Buffer.byteLength(body);

  const result = await new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method,
        host: options.host,
        port: options.port,
        path: options.path,
        headers: finalHeaders,
        agent: false,
        createConnection: () => socket,
        servername: options.servername,
        timeout,
      },
      (res) => {
        // headersOnly：只拿响应头和重定向目标，不下载正文。
        // 解析音频直链时会重定向到 CDN，跟着下载整首音频就太慢了。
        if (headersOnly) {
          res.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) });
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on('error', reject);
      }
    );
    req.once('timeout', () => req.destroy(new Error('请求超时')));
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });

  // 跟随重定向
  if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location && maxRedirects > 0) {
    const next = new URL(result.headers.location, url).href;
    if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === 'POST')) {
      return request(next, { ...opts, method: 'GET', body: null, maxRedirects: maxRedirects - 1 });
    }
    return request(next, { ...opts, maxRedirects: maxRedirects - 1 });
  }

  return { ...result, url };
}

/** 流式请求，返回 IncomingMessage，供音频代理使用 */
async function stream(url, opts = {}) {
  const { method = 'GET', headers = {}, proxy = '', timeout = 20000 } = opts;
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const { socket, isTls, httpProxy } = await openSocket({
    host: u.hostname,
    port: Number(u.port) || (isHttps ? 443 : 80),
    isHttps,
    proxy,
    timeout,
  });
  const options = buildOptions(url, { method, headers, proxy, httpProxy });
  const mod = isTls ? https : http;
  const finalHeaders = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    Connection: 'close',
    ...options.headers,
    ...headers,
  };

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method,
        host: options.host,
        port: options.port,
        path: options.path,
        headers: finalHeaders,
        agent: false,
        createConnection: () => socket,
        servername: options.servername,
        timeout,
      },
      (res) => resolve(res)
    );
    req.once('timeout', () => req.destroy(new Error('请求超时')));
    req.once('error', reject);
    req.end();
  });
}

async function getJson(url, opts = {}) {
  const res = await request(url, {
    ...opts,
    headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers || {}) },
  });
  const text = res.body.toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    const err = new Error(`接口返回了非 JSON 内容（HTTP ${res.status}）`);
    err.status = res.status;
    err.raw = text.slice(0, 300);
    throw err;
  }
  return { status: res.status, headers: res.headers, json };
}

module.exports = { request, stream, getJson, parseProxy, DEFAULT_UA };
