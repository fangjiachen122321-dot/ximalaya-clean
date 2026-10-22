'use strict';
/**
 * 喜马拉雅干净客户端 —— 本地服务。
 *
 * 只在本机 127.0.0.1 上监听，负责：
 *   - 代理喜马拉雅的内容接口（补上浏览器不方便设置的请求头 / Cookie）
 *   - 解析并解密播放直链
 *   - 托管前端静态文件
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const store = require('./lib/store');
const xm = require('./lib/xm');
const net = require('./lib/net');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const code = (err && err.code) || 'INTERNAL';
  const message = (err && err.message) || '服务器内部错误';
  if (status >= 500) console.error('[error]', code, message);
  sendJson(res, status, { error: message, code });
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new xm.ApiError('请求体过大', 'BAD_REQUEST', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        reject(new xm.ApiError('请求体不是合法 JSON', 'BAD_REQUEST', 400));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // 单页应用：未知路径回退到 index.html
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (e2, data) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('前端文件缺失');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 音频代理                                                            */
/* ------------------------------------------------------------------ */

async function handleStream(req, res, trackId) {
  let src;
  try {
    src = await xm.audioUrl(trackId);
  } catch (err) {
    sendError(res, err);
    return;
  }

  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await net.stream(src.url, {
      proxy: store.getSettings().proxy,
      headers: {
        ...headers,
        Referer: 'https://www.ximalaya.com/',
        'User-Agent': net.DEFAULT_UA,
      },
      timeout: 20000,
    });
  } catch (_) {
    sendError(res, new xm.ApiError('无法连接音频服务器', 'NETWORK', 502));
    return;
  }

  if (upstream.statusCode >= 400) {
    sendError(res, new xm.ApiError(`音频服务器返回 ${upstream.statusCode}`, 'UPSTREAM', 502));
    upstream.resume();
    return;
  }

  const outHeaders = {
    'Content-Type': upstream.headers['content-type'] || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  for (const k of ['content-length', 'content-range']) {
    if (upstream.headers[k]) outHeaders[k === 'content-length' ? 'Content-Length' : 'Content-Range'] = upstream.headers[k];
  }
  res.writeHead(upstream.statusCode === 206 ? 206 : 200, outHeaders);
  upstream.pipe(res);
  upstream.on('error', () => res.destroy());
  req.on('close', () => upstream.destroy());
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function route(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method.toUpperCase();

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, version: require('./package.json').version });
    return true;
  }

  if (pathname === '/api/network-check' && method === 'GET') {
    sendJson(res, 200, await xm.networkCheck());
    return true;
  }

  if (!pathname.startsWith('/api/')) return false;

  /* --- 会话 --- */
  if (pathname === '/api/session' && method === 'GET') {
    const s = await xm.session();
    sendJson(res, 200, s);
    return true;
  }

  if (pathname === '/api/login/qr' && method === 'POST') {
    sendJson(res, 200, await xm.loginQr());
    return true;
  }

  const qrMatch = pathname.match(/^\/api\/login\/qr\/([^/]+)$/);
  if (qrMatch && method === 'GET') {
    sendJson(res, 200, await xm.loginQrCheck(decodeURIComponent(qrMatch[1])));
    return true;
  }

  if (pathname === '/api/login/cookie' && method === 'POST') {
    const body = await readBody(req);
    const s = await xm.loginWithCookie(body.cookie);
    sendJson(res, 200, { loggedIn: true, user: s.user });
    return true;
  }

  if (pathname === '/api/logout' && method === 'POST') {
    xm.logout();
    sendJson(res, 200, { ok: true });
    return true;
  }

  /* --- 内容 --- */
  if (pathname === '/api/home' && method === 'GET') {
    sendJson(res, 200, await xm.home());
    return true;
  }

  if (pathname === '/api/search' && method === 'GET') {
    const kw = searchParams.get('kw') || '';
    const type = searchParams.get('type') || 'album';
    const page = Number(searchParams.get('page') || 1);
    sendJson(res, 200, await xm.search(kw, type, page));
    return true;
  }

  const albumMatch = pathname.match(/^\/api\/album\/(\d+)$/);
  if (albumMatch && method === 'GET') {
    const albumId = Number(albumMatch[1]);
    const album = await xm.albumInfo(albumId);
    const tracks = await xm.albumTracks(albumId, 1, 1, album);
    sendJson(res, 200, { album, tracks: tracks.tracks });
    return true;
  }

  const albumTracksMatch = pathname.match(/^\/api\/album\/(\d+)\/tracks$/);
  if (albumTracksMatch && method === 'GET') {
    const albumId = Number(albumTracksMatch[1]);
    const page = Number(searchParams.get('page') || 1);
    const sort = Number(searchParams.get('sort') || 1);
    const album = await xm.albumInfo(albumId).catch(() => null);
    const result = await xm.albumTracks(albumId, page, sort, album);
    sendJson(res, 200, result);
    return true;
  }

  const trackMatch = pathname.match(/^\/api\/track\/(\d+)$/);
  if (trackMatch && method === 'GET') {
    const trackId = Number(trackMatch[1]);
    const track = await xm.trackInfo(trackId);
    let album = null;
    if (track.albumId) {
      album = await xm.albumInfo(track.albumId).catch(() => null);
    }
    sendJson(res, 200, { track, album });
    return true;
  }

  const audioMatch = pathname.match(/^\/api\/audio\/(\d+)$/);
  if (audioMatch && method === 'GET') {
    sendJson(res, 200, await xm.audioUrl(Number(audioMatch[1])));
    return true;
  }

  const streamMatch = pathname.match(/^\/api\/stream\/(\d+)$/);
  if (streamMatch && method === 'GET') {
    await handleStream(req, res, Number(streamMatch[1]));
    return true;
  }

  /* --- 我的内容 --- */
  if (pathname === '/api/library/subscriptions' && method === 'GET') {
    const sort = searchParams.get('sort') || 'recent';
    const page = Number(searchParams.get('page') || 1);
    sendJson(res, 200, await xm.librarySubscriptions(sort, page));
    return true;
  }

  if (pathname === '/api/library/listened' && method === 'GET') {
    sendJson(res, 200, await xm.libraryListened(Number(searchParams.get('page') || 1)));
    return true;
  }

  if (pathname === '/api/library/likes' && method === 'GET') {
    sendJson(res, 200, await xm.libraryLikes(Number(searchParams.get('page') || 1)));
    return true;
  }

  if (pathname === '/api/library/bought' && method === 'GET') {
    sendJson(res, 200, await xm.libraryBought(Number(searchParams.get('page') || 1)));
    return true;
  }

  /* --- 设置 --- */
  if (pathname === '/api/settings' && method === 'GET') {
    const s = store.getSettings();
    sendJson(res, 200, { quality: s.quality, proxy: s.proxy, port: s.port });
    return true;
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    const patch = {};
    if (body.quality !== undefined) patch.quality = String(body.quality);
    if (body.proxy !== undefined) patch.proxy = String(body.proxy || '').trim();
    const s = store.setSettings(patch);
    sendJson(res, 200, { quality: s.quality, proxy: s.proxy, port: s.port });
    return true;
  }

  if (pathname === '/api/settings/test-proxy' && method === 'POST') {
    const body = await readBody(req);
    const proxy = String(body.proxy || '').trim();
    const started = Date.now();
    try {
      const res2 = await net.request('https://www.ximalaya.com/revision/time', {
        proxy,
        timeout: 10000,
        headers: { Referer: 'https://www.ximalaya.com/' },
      });
      if (res2.status >= 400) {
        throw new xm.ApiError(`代理返回 HTTP ${res2.status}`, 'UPSTREAM', 502);
      }
      sendJson(res, 200, { ok: true, latency: Date.now() - started, message: '连接成功' });
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        latency: Date.now() - started,
        message: err.message || '连接失败',
      });
    }
    return true;
  }

  sendJson(res, 404, { error: '接口不存在', code: 'NOT_FOUND' });
  return true;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}`);
  } catch (_) {
    res.writeHead(400).end('Bad Request');
    return;
  }

  Promise.resolve()
    .then(() => route(req, res, url))
    .then((handled) => {
      if (!handled) serveStatic(req, res, url.pathname);
    })
    .catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, err);
    });
});

function listen(port, attempts = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts < 20) {
      listen(port + 1, attempts + 1);
      return;
    }
    console.error('启动失败：', err.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const actual = server.address().port;
    const url = `http://${HOST}:${actual}`;
    if (!process.env.XMLY_QUIET) {
      console.log(`喜马拉雅干净客户端已启动： ${url}`);
      console.log(`配置目录： ${store.CONFIG_DIR}`);
    }
    if (process.send) process.send({ type: 'listening', port: actual, url });
  });
}

if (require.main === module) {
  const settings = store.getSettings();
  const desired = Number(process.env.PORT || settings.port || 8787);
  listen(desired);
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { server, listen };
