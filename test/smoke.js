#!/usr/bin/env node
'use strict';
/**
 * 后端冒烟测试：逐个调用本地服务接口，确认契约没坏。
 *
 *   node test/smoke.js [baseUrl]
 *
 * 不需要登录也能跑（登录相关的接口只验证「未登录时的正确行为」）。
 */
const http = require('node:http');

const BASE = process.argv[2] || process.env.XMLY_BASE || 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
const failures = [];

function get(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method || 'GET',
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        timeout: opts.timeout || 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, json, text, headers: res.headers });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  console.log(`\n喜马拉雅干净客户端 · 冒烟测试\n服务： ${BASE}\n`);

  console.log('基础');
  await check('GET /api/health 返回 ok', async () => {
    const r = await get('/api/health');
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(r.json && r.json.ok === true, 'ok 不为 true');
  });

  await check('GET / 返回 HTML 界面', async () => {
    const r = await get('/');
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(/<html/i.test(r.text), '不是 HTML');
    assert(/喜马拉雅/.test(r.text), '页面里没有中文标题');
  });

  await check('未知 API 返回 404 + NOT_FOUND', async () => {
    const r = await get('/api/definitely-not-exist');
    assert(r.status === 404, `状态码 ${r.status}`);
    assert(r.json && r.json.code === 'NOT_FOUND', 'code 不对');
  });

  console.log('\n会话');
  await check('GET /api/session 返回结构正确', async () => {
    const r = await get('/api/session');
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(typeof r.json.loggedIn === 'boolean', 'loggedIn 不是布尔值');
    assert('user' in r.json, '缺少 user 字段');
  });

  await check('未登录时我的内容返回 401', async () => {
    const r = await get('/api/session');
    if (r.json.loggedIn) return; // 已登录就跳过
    const lib = await get('/api/library/subscriptions');
    assert(lib.status === 401, `状态码 ${lib.status}`);
    assert(lib.json.code === 'NEED_LOGIN', 'code 不是 NEED_LOGIN');
  });

  console.log('\n内容');
  await check('GET /api/home 返回分区', async () => {
    const r = await get('/api/home');
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(Array.isArray(r.json.sections), 'sections 不是数组');
    assert(r.json.sections.length > 0, '没有推荐分区');
    const album = r.json.sections[0].albums[0];
    assert(album && album.id, '专辑缺少 id');
    assert(album.title, '专辑缺少标题');
    assert(/^https:\/\//.test(album.cover), `封面不是 https： ${album.cover}`);
  });

  await check('搜索专辑', async () => {
    const r = await get('/api/search?kw=' + encodeURIComponent('三体') + '&type=album');
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(r.json.albums.length > 0, '没有搜索结果');
    assert(r.json.total > 0, 'total 为 0');
    const a = r.json.albums[0];
    assert(a.id && a.title, '结果缺少 id 或标题');
  });

  await check('搜索声音', async () => {
    const r = await get('/api/search?kw=' + encodeURIComponent('郭德纲') + '&type=track');
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(r.json.tracks.length > 0, '没有搜索结果');
    const t = r.json.tracks[0];
    assert(t.id, '结果缺少 id');
    assert(t.duration > 0, '结果缺少时长');
  });

  await check('空关键词返回空结果而不是报错', async () => {
    const r = await get('/api/search?kw=');
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(r.json.albums.length === 0 && r.json.tracks.length === 0, '应该有 0 条结果');
  });

  let sampleAlbumId = 2888955;
  await check('GET /api/album/:id 返回专辑 + 节目', async () => {
    const r = await get(`/api/album/${sampleAlbumId}`);
    assert(r.status === 200, `状态码 ${r.status}`);
    const a = r.json.album;
    assert(a.id === sampleAlbumId, `专辑 id 不对： ${a.id}`);
    assert(a.title, '缺少标题');
    assert(a.trackCount > 0, 'trackCount 为 0');
    assert(r.json.tracks.length > 0, '没有节目');
    const t = r.json.tracks[0];
    assert(t.id && t.title, '节目缺少 id 或标题');
    assert(t.duration > 0, '节目缺少时长');
  });

  await check('专辑分页：正序 / 倒序', async () => {
    const asc = await get(`/api/album/${sampleAlbumId}/tracks?page=1&sort=1`);
    const desc = await get(`/api/album/${sampleAlbumId}/tracks?page=1&sort=-1`);
    assert(asc.status === 200 && desc.status === 200, '状态码不对');
    assert(asc.json.tracks.length > 0, '正序没有节目');
    assert(desc.json.tracks.length > 0, '倒序没有节目');
    assert(asc.json.tracks[0].index < asc.json.tracks[1].index, '正序不是升序');
    assert(desc.json.tracks[0].index > desc.json.tracks[1].index, '倒序不是降序');
  });

  await check('GET /api/track/:id 能带出所属专辑', async () => {
    const album = await get(`/api/album/${sampleAlbumId}`);
    const trackId = album.json.tracks[0].id;
    const r = await get(`/api/track/${trackId}`);
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(r.json.track.id === trackId, 'track id 不对');
    assert(r.json.track.albumId === sampleAlbumId, `albumId 不对： ${r.json.track.albumId}`);
    assert(r.json.album && r.json.album.id === sampleAlbumId, '没有带出专辑');
  });

  console.log('\n播放');
  await check('GET /api/audio/:id 返回可播放直链', async () => {
    const album = await get(`/api/album/${sampleAlbumId}`);
    const trackId = album.json.tracks[0].id;
    const r = await get(`/api/audio/${trackId}`);
    if (r.status === 403) {
      assert(['GEO_BLOCKED', 'PAID'].includes(r.json.code), `意外的错误码： ${r.json.code}`);
      console.log(`      （该内容不可播： ${r.json.code} —— 属于预期的业务错误）`);
      return;
    }
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(/^https:\/\//.test(r.json.url), `不是 https 直链： ${r.json.url}`);
    assert(r.json.duration > 0, '没有返回时长');
  });

  await check('直链能真正下载到音频', async () => {
    const album = await get(`/api/album/${sampleAlbumId}`);
    const trackId = album.json.tracks[0].id;
    const r = await get(`/api/audio/${trackId}`);
    if (r.status !== 200) {
      console.log('      （跳过：拿不到直链）');
      return;
    }
    const res = await new Promise((resolve, reject) => {
      const url = new URL(r.json.url);
      const mod = url.protocol === 'https:' ? require('node:https') : http;
      const req = mod.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          headers: { Range: 'bytes=0-4095' },
          timeout: 20000,
        },
        (x) => {
          const chunks = [];
          x.on('data', (c) => chunks.push(c));
          x.on('end', () => resolve({ status: x.statusCode, body: Buffer.concat(chunks) }));
        }
      );
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', reject);
      req.end();
    });
    assert([200, 206].includes(res.status), `CDN 返回 ${res.status}`);
    assert(res.body.length > 0, '下载到的内容为空');
  });

  await check('GET /api/stream/:id 支持 Range', async () => {
    const album = await get(`/api/album/${sampleAlbumId}`);
    const trackId = album.json.tracks[0].id;
    const r = await new Promise((resolve, reject) => {
      const url = new URL(`/api/stream/${trackId}`, BASE);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'GET',
          headers: { Range: 'bytes=0-1023' },
          timeout: 30000,
        },
        (x) => {
          const chunks = [];
          x.on('data', (c) => chunks.push(c));
          x.on('end', () =>
            resolve({ status: x.statusCode, headers: x.headers, body: Buffer.concat(chunks) })
          );
        }
      );
      req.on('timeout', () => req.destroy(new Error('超时')));
      req.on('error', reject);
      req.end();
    });
    if (r.status === 403) {
      console.log('      （跳过：该内容不可播）');
      return;
    }
    assert([200, 206].includes(r.status), `状态码 ${r.status}`);
    assert(r.body.length > 0, '返回内容为空');
    assert(/audio/.test(r.headers['content-type'] || ''), 'Content-Type 不是音频');
  });

  console.log('\n网络自检');
  await check('GET /api/network-check 返回结果', async () => {
    const r = await get('/api/network-check');
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(typeof r.json.api === 'boolean', 'api 不是布尔值');
    assert(typeof r.json.play === 'boolean', 'play 不是布尔值');
    assert(typeof r.json.message === 'string' && r.json.message, '缺少 message');
  });

  console.log('\n设置');
  await check('设置可读可写', async () => {
    const before = await get('/api/settings');
    assert(before.status === 200, `状态码 ${before.status}`);
    const original = before.json.quality;
    const next = original === 'high' ? 'medium' : 'high';
    const put = await get('/api/settings', { method: 'PUT', body: { quality: next } });
    assert(put.status === 200, `写入状态码 ${put.status}`);
    assert(put.json.quality === next, '写入没生效');
    const after = await get('/api/settings');
    assert(after.json.quality === next, '读取不一致');
    await get('/api/settings', { method: 'PUT', body: { quality: original } });
  });

  await check('非法音质回落到默认值', async () => {
    const r = await get('/api/settings', { method: 'PUT', body: { quality: 'ultra' } });
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(['high', 'medium', 'low'].includes(r.json.quality), `音质被写坏了： ${r.json.quality}`);
  });

  await check('代理测试：直连成功', async () => {
    const r = await get('/api/settings/test-proxy', { method: 'POST', body: { proxy: '' } });
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(typeof r.json.ok === 'boolean', 'ok 不是布尔值');
  });

  await check('代理测试：坏地址返回失败而不是崩溃', async () => {
    const r = await get('/api/settings/test-proxy', {
      method: 'POST',
      body: { proxy: 'http://127.0.0.1:1' },
    });
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(r.json.ok === false, '应该返回失败');
    assert(r.json.message, '没有错误信息');
  });

  // 这些用例会写入 / 清空服务端保存的 Cookie。
  // 如果这个服务已经登录了真实账号，跑一遍就会把人踢下线，所以先探测一下。
  let alreadyLoggedIn = false;
  try {
    const s = await get('/api/session');
    alreadyLoggedIn = Boolean(s.json && s.json.loggedIn);
  } catch (_) {
    /* ignore */
  }
  if (alreadyLoggedIn) {
    console.log('\n登录（已登录真实账号，跳过会清空 Cookie 的用例）');
    console.log('  - 想完整测试登录路径，请用临时配置目录另起一个服务：');
    console.log('    XMLY_CONFIG_DIR=/tmp/xmly-test PORT=8799 node server.js');
    console.log('    node test/smoke.js http://127.0.0.1:8799');
  } else {
  console.log('\n登录（仅验证未登录路径）');
  await check('扫码登录：能生成二维码', async () => {
    const r = await get('/api/login/qr', { method: 'POST' });
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(r.json.qrId, '没有 qrId');
    assert(/^data:image\/png;base64,/.test(r.json.img), '二维码不是 data URI');
  });

  await check('扫码登录：轮询返回合法状态', async () => {
    const qr = await get('/api/login/qr', { method: 'POST' });
    const r = await get(`/api/login/qr/${qr.json.qrId}`);
    assert(r.status === 200, `状态码 ${r.status}`);
    assert(
      ['pending', 'scanned', 'success', 'expired'].includes(r.json.status),
      `意外状态： ${r.json.status}`
    );
  });

  await check('粘贴无效 Cookie 返回 401 而不是崩溃', async () => {
    const r = await get('/api/login/cookie', {
      method: 'POST',
      body: { cookie: 'this=is-not-a-real-cookie' },
    });
    assert(r.status === 401, `状态码 ${r.status}`);
    assert(r.json.code === 'NEED_LOGIN', `code 不对： ${r.json.code}`);
  });

  await check('空 Cookie 返回 400', async () => {
    const r = await get('/api/login/cookie', { method: 'POST', body: { cookie: '' } });
    assert(r.status === 400, `状态码 ${r.status}`);
  });
  }

  console.log(`\n结果： ${pass} 通过， ${fail} 失败\n`);
  if (fail) {
    for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.message}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('测试脚本本身出错：', err);
  process.exit(2);
});
