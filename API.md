# Ximalaya Clean — 本地服务 API 契约

前端只与本机 `http://127.0.0.1:<port>` 通信，不直接访问喜马拉雅。
所有响应均为 JSON（除静态文件与音频流）。错误统一返回：

```json
{ "error": "中文错误信息", "code": "GEO_BLOCKED | NEED_LOGIN | NOT_FOUND | UPSTREAM | PAID | NETWORK" }
```

HTTP 状态码：`200` 成功，`401` 需要登录，`403` 地区限制/无权限，`404` 不存在，`502` 上游失败。

## 数据类型

```ts
type Album = {
  id: number;
  title: string;
  cover: string;          // 完整 URL，已补 https:
  anchor: { uid: number; name: string; avatar: string };
  intro: string;          // 纯文本，已去 HTML
  trackCount: number;
  playCount: number;
  isPaid: boolean;        // 原始付费标记（VIP 专辑也是 true，别直接拿来显示）
  isVip: boolean;         // VIP 免费专辑
  bought: boolean;        // 已购买（注意：会员看 VIP 专辑时也会是 true）
  access: 'free' | 'vip' | 'vip-locked' | 'bought' | 'locked' | 'unknown';
                          // 按当前账号算好的访问状态，显示徽章请用这个
                          // unknown = 「我的」列表接口不返回 VIP 字段，无法判断，
                          //           此时不要显示任何付费徽章（进专辑页会给出准确状态）
  locked: boolean;        // 当前账号是否能直接听（true 表示需要买/开会员）
  isFinished: boolean;
  updatedAt: string;      // "2025-02-27"
  category: string;
};

type Track = {
  id: number;
  albumId: number;
  albumTitle: string;
  index: number;          // 在专辑内的序号（从 1 开始）
  title: string;
  cover: string;
  duration: number;       // 秒
  isPaid: boolean;        // 原始付费标记（VIP 内容也是 true）
  vip: boolean;           // 属于 VIP 专辑
  bought: boolean;        // 已购买
  locked: boolean;        // 当前账号没权限听
  playable: boolean;      // 当前账号是否能播放（locked 时为 false）
  publishedAt: string;    // "2023-08"
};

type AudioSource = {
  url: string;            // 已解密的 CDN 直链
  quality: string;        // "128k" / "64k" / "32k"
  duration: number;
};
```

### 关于付费 / VIP 的判断（重要）

喜马拉雅的接口把「VIP 会员免费」的专辑也标成 `isPaid: true`，所以**不要用 `isPaid` 决定是否显示「付费」**，
否则会员会看到满屏的付费锁。正确做法：

- 显示徽章用 `access`：`vip` → 「VIP 会员免费」，`vip-locked` → 「VIP 专享」，`locked` → 「付费专辑」，`bought` → 「已购」，`unknown` → 不显示徽章
- 决定能不能点播放用 `locked` / `playable`
- 真正取音频失败时后端返回 `PAID`（需要单独购买）或 `VIP_REQUIRED`（需要会员）错误码

## 会话与登录

### `GET /api/session`
```json
{ "loggedIn": true, "user": { "uid": 123, "nickname": "名字", "avatar": "https://...", "vip": false } }
```
未登录时 `{ "loggedIn": false, "user": null }`。

### `POST /api/login/qr`
生成登录二维码。
```json
{ "qrId": "1D76...", "img": "data:image/png;base64,iVBOR..." }
```

### `GET /api/login/qr/:qrId`
轮询扫码状态。每 2 秒轮询一次，成功即停止。
```json
{ "status": "pending" }   // pending | scanned | success | expired
{ "status": "success", "user": { ... } }
```
`expired` 时前端应提示“二维码已过期，点击刷新”。

### `POST /api/login/cookie`
备用登录方式：粘贴浏览器 Cookie 字符串（`{ "cookie": "1&_token=...; ..." }`）→ `{ "loggedIn": true, "user": {...} }`

### `POST /api/logout` → `{ "ok": true }`

## 内容

### `GET /api/home`
首页推荐（未登录也尽量返回；失败时返回空 sections 而不是报错）。
```json
{ "sections": [ { "title": "猜你喜欢", "albums": [Album] } ] }
```

### `GET /api/search?kw=关键词&type=album|track&page=1`
```json
{ "albums": [Album], "tracks": [Track], "total": 120, "page": 1 }
```
`type=album` 时只填 `albums`，`type=track` 时只填 `tracks`（另一项为空数组）。

### `GET /api/album/:id`
```json
{ "album": Album, "tracks": [Track] }
```
一次返回第一页（最多 30 条）。更多分页用下面的接口。

### `GET /api/album/:id/tracks?page=2&sort=1`
```json
{ "tracks": [Track], "page": 2, "total": 120, "hasMore": true }
```
`sort=1` 正序（旧→新），`sort=-1` 倒序（新→旧），默认 `1`。

### `GET /api/track/:id`
```json
{ "track": Track, "album": Album }
```

### `GET /api/audio/:trackId`
取播放直链。前端每次播放时调用一次（直链有时效，不要长期缓存）。
```json
{ "url": "https://...m4a", "quality": "64k", "duration": 1197 }
```
失败：`403` + `code: "GEO_BLOCKED"`（地区限制，少见的兜底路径）或 `code: "PAID"`（付费未购买）。

**重要（后端已实现，前端不需要额外处理）**：后端优先走移动端接口，绝大多数节目（含已购买的付费内容）都能直接拿到可播放直链，海外 IP 也能播。所以正常情况下直接 `audio.src = url` 就能播。

前端仍要按 `code` 给中文提示：
- `GEO_BLOCKED` → 「该内容受版权地区限制（需要中国大陆网络）」
- `PAID` → 「这是付费内容，当前账号未购买」
- `UPSTREAM` / `NETWORK` → 「暂时无法获取播放地址，请稍后重试」

### `GET /api/stream/:trackId`
音频代理流，支持 Range 请求。当直链在 `<audio>` 中无法直接播放（比如需要 Referer）时使用。用法：`audio.src = "/api/stream/" + trackId`。

### `GET /api/network-check`
启动时调用一次，用来提示网络状况。
```json
{ "api": true, "play": true, "geoBlocked": false, "proxy": "", "message": "网络正常，可以播放。", "latency": 4421 }
```
`geoBlocked: true` 时在界面顶部显示一条黄色提示条（可关闭），内容用 `message`。

## 我的内容（需登录，否则 401）

### `GET /api/library/subscriptions?sort=recent|sub&page=1`
- `sort=recent`：按最近更新（默认）
- `sort=sub`：按订阅时间
```json
{ "albums": [Album], "total": 42, "hasMore": true }
```

### `GET /api/library/listened?page=1`
最近收听。`{ "tracks": [Track], "hasMore": true }`

### `GET /api/library/likes?page=1`
我喜欢的。`{ "tracks": [Track], "hasMore": true }`

### `GET /api/library/bought?page=1`
已购专辑。`{ "albums": [Album], "hasMore": true }`

## 设置

### `GET /api/settings`
```json
{ "quality": "high", "proxy": "", "port": 8787 }
```
`quality`: `"high" | "medium" | "low"`；`proxy`: `""` 表示直连，或 `http://host:port` / `socks5://host:port`。

### `PUT /api/settings`
请求体同上（可只传部分字段）→ 返回更新后的完整设置。

### `POST /api/settings/test-proxy`
`{ "proxy": "http://127.0.0.1:7890" }` → `{ "ok": true, "latency": 320, "message": "连接成功" }`

## 前端约定

- 单页应用，无构建步骤：`public/index.html` + `public/app.js` + `public/style.css`，原生 ES module。
- 不使用任何 CDN 资源（离线可用），图标用内联 SVG。
- 播放器：`<audio>` + Media Session API（硬件媒体键）。
- 断网/上游失败时给出中文提示条，不要白屏。
- 深色为主，中文界面，紧凑但留白舒服。
