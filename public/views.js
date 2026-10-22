/**
 * 页面视图。每个 view 返回 { el, cleanup }，由 router 挂载。
 * 视图内部自行处理 loading / 空 / 错误三态，绝不留白屏。
 */

import { api, errorText } from './api.js';
import { local } from './store.js';
import { icon } from './icons.js';
import {
  h,
  clear,
  cover,
  avatar,
  fmtCount,
  fmtDate,
  fmtDuration,
  debounce,
  albumCard,
  albumGrid,
  trackRow,
  bindNowPlaying,
  skeletonCards,
  skeletonRows,
  skeletonAlbum,
  slowHint,
  emptyState,
  errorState,
  loginRequired,
  toast,
  sectionHeader,
  pageHeader,
  badge,
  loadingMore,
} from './ui.js';
import { player, normalizeTrack } from './player.js';

const PAGE_SIZE_HINT = 30;

/* ------------------------------------------------------------------ */
/* 共用                                                                */
/* ------------------------------------------------------------------ */

function page(cls = '') {
  return h('div', { class: `page ${cls}`.trim() });
}

function withCleanup(el, cleanup) {
  return { el, cleanup: typeof cleanup === 'function' ? cleanup : () => {} };
}

/** 播放一整个列表 */
function playFrom(tracks, index = 0) {
  const list = (tracks || []).map(normalizeTrack).filter((t) => t && t.id != null);
  if (!list.length) {
    toast('这里还没有可播放的节目', 'info');
    return;
  }
  player.playQueue(list, Math.max(0, Math.min(index, list.length - 1)));
}

function playableIndex(tracks) {
  const i = (tracks || []).findIndex((t) => t && t.playable !== false);
  return i < 0 ? 0 : i;
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || err.code === 'ABORTED');
}

/* ------------------------------------------------------------------ */
/* 首页                                                                */
/* ------------------------------------------------------------------ */

function continueSection(onPlay) {
  const history = local.history();
  if (!history.length) return null;
  const positions = local.positions();
  const items = history.slice(0, 12);

  const cards = items.map((item) => {
    const pos = positions[item.id];
    const ratio = pos && item.duration ? Math.min(1, pos.p / item.duration) : 0;
    return h(
      'button',
      {
        class: 'continue-card',
        type: 'button',
        onClick: () => onPlay(item, pos ? pos.p : 0),
        title: item.title,
      },
      cover(item.cover, item.title, 'continue-cover'),
      h(
        'span',
        { class: 'continue-main' },
        h('span', { class: 'continue-title', text: item.title }),
        h('span', { class: 'continue-sub', text: item.albumTitle || '本地记录' }),
        h(
          'span',
          { class: 'continue-bar' },
          h('span', { class: 'continue-bar-fill', style: { width: `${Math.round(ratio * 100)}%` } }),
        ),
        h('span', {
          class: 'continue-time',
          text: pos ? `上次听到 ${fmtDuration(pos.p)}` : '未开始',
        }),
      ),
      h('span', { class: 'continue-play', html: icon('play', 15) }),
    );
  });

  return h(
    'section',
    { class: 'home-section' },
    sectionHeader('继续收听', h('span', { class: 'section-hint', text: '记录仅保存在本机' })),
    h('div', { class: 'continue-grid' }, cards),
  );
}

function hotKeywords(onPick) {
  const words = ['三体', '明朝那些事儿', '郭德纲', '睡前故事', '罗辑思维'];
  return h(
    'div',
    { class: 'hot-words' },
    words.map((w) =>
      h(
        'button',
        { class: 'hot-word', type: 'button', onClick: () => onPick(w) },
        h('span', { class: 'hot-word-ico', html: icon('search', 14) }),
        w,
      ),
    ),
  );
}

function searchHero(onSubmit, onPick) {
  const input = h('input', {
    id: 'home-search-input',
    class: 'hero-input',
    type: 'text',
    placeholder: '搜索专辑、节目或主播',
    'aria-label': '搜索',
    autocomplete: 'off',
  });
  const go = () => {
    const kw = input.value.trim();
    if (!kw) {
      input.focus();
      return;
    }
    onSubmit(kw);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });

  return h(
    'section',
    { class: 'hero' },
    h('p', { class: 'hero-eyebrow', text: '没有广告，没有推荐轰炸' }),
    h('h1', { class: 'hero-title', text: '想听点什么？' }),
    h(
      'div',
      { class: 'hero-search' },
      h('span', { class: 'hero-search-ico', html: icon('search', 19) }),
      input,
      h('button', { class: 'hero-search-btn', type: 'button', text: '搜索', onClick: go }),
    ),
    h('p', { class: 'hero-hint', text: '热门搜索' }),
    hotKeywords(onPick),
  );
}

export function homeView(ctx) {
  const root = page('home-page');
  const ctrl = new AbortController();
  ctx.signal = ctrl.signal;

  const goSearch = (kw) => {
    location.hash = `#/search?kw=${encodeURIComponent(kw)}`;
  };

  const continueEl = continueSection((item) => {
    player.playQueue([normalizeTrack(item)], 0, { resume: true });
  });

  const contentHost = h('div', { class: 'home-content' });

  if (continueEl) root.append(continueEl);
  root.append(contentHost);

  const loading = h(
    'section',
    { class: 'home-section' },
    sectionHeader('推荐'),
    skeletonCards(6),
  );
  contentHost.append(loading);

  async function loadHome() {
    clear(contentHost);
    contentHost.append(loading);
    const hint = slowHint(contentHost, 6000);
    try {
      const data = await api.home();
      hint.cancel();
      const sections = ((data && data.sections) || []).filter(
        (s) => s && Array.isArray(s.albums) && s.albums.length,
      );
      clear(contentHost);

      if (!sections.length) {
        // 没有推荐数据时：搜索引导 + 本地历史
        contentHost.append(searchHero(goSearch, goSearch));
        return;
      }

      sections.forEach((section) => {
        contentHost.append(
          h(
            'section',
            { class: 'home-section' },
            sectionHeader(
              section.title || '推荐',
              h(
                'div',
                { class: 'section-scroll-btns' },
                h('button', {
                  class: 'icon-btn xs',
                  type: 'button',
                  'aria-label': '向左滚动',
                  html: icon('chevron-left', 16),
                  onClick: (e) => {
                    const row = e.currentTarget.closest('.home-section').querySelector('.h-scroll');
                    if (row) row.scrollBy({ left: -560, behavior: 'smooth' });
                  },
                }),
                h('button', {
                  class: 'icon-btn xs',
                  type: 'button',
                  'aria-label': '向右滚动',
                  html: icon('chevron-right', 16),
                  onClick: (e) => {
                    const row = e.currentTarget.closest('.home-section').querySelector('.h-scroll');
                    if (row) row.scrollBy({ left: 560, behavior: 'smooth' });
                  },
                }),
              ),
            ),
            h(
              'div',
              { class: 'h-scroll' },
              section.albums.slice(0, 14).map((a) =>
                h(
                  'div',
                  { class: 'h-scroll-item' },
                  albumCard(a, { onQuickPlay: (album) => player.quickPlayAlbum(album) }),
                ),
              ),
            ),
          ),
        );
      });
    } catch (err) {
      hint.cancel();
      clear(contentHost);
      contentHost.append(searchHero(goSearch, goSearch));
      contentHost.append(errorState(err, () => loadHome()));
    }
  }

  loadHome();

  return withCleanup(root, () => ctrl.abort());
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

export function searchView(ctx) {
  const root = page('search-page');
  const state = {
    kw: ctx.query.kw || '',
    type: ctx.query.type === 'track' ? 'track' : 'album',
    page: 1,
    albums: [],
    tracks: [],
    total: 0,
    hasMore: false,
    loading: false,
    error: null,
    reqId: 0,
  };

  /* --- 搜索头部 --- */
  const input = h('input', {
    id: 'search-input',
    class: 'search-input',
    type: 'text',
    placeholder: '搜索专辑、节目或主播',
    'aria-label': '搜索关键词',
    autocomplete: 'off',
    value: state.kw,
    spellcheck: 'false',
  });
  const clearBtn = h('button', {
    class: 'search-clear',
    type: 'button',
    'aria-label': '清空',
    html: icon('x', 16),
    onClick: () => {
      input.value = '';
      state.kw = '';
      input.focus();
      syncUrl();
      resultsHost.replaceChildren(emptySearchPanel());
    },
  });
  clearBtn.hidden = !state.kw;

  const searchBox = h(
    'div',
    { class: 'search-box' },
    h('span', { class: 'search-box-ico', html: icon('search', 20) }),
    input,
    clearBtn,
  );

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const tabDefs = [
    { key: 'album', label: '专辑' },
    { key: 'track', label: '声音' },
  ];
  const tabButtons = tabDefs.map((t) => {
    const btn = h('button', {
      class: `tab${state.type === t.key ? ' is-active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': state.type === t.key ? 'true' : 'false',
      text: t.label,
      onClick: () => {
        if (state.type === t.key) return;
        state.type = t.key;
        tabButtons.forEach((b, i) => {
          b.classList.toggle('is-active', tabDefs[i].key === state.type);
          b.setAttribute('aria-selected', tabDefs[i].key === state.type ? 'true' : 'false');
        });
        syncUrl();
        if (state.kw) runSearch(true);
      },
    });
    tabs.append(btn);
    return btn;
  });

  const resultCount = h('span', { class: 'result-count' });
  const resultsHost = h('div', { class: 'search-results' });

  root.append(
    h(
      'div',
      { class: 'search-head' },
      searchBox,
      h('div', { class: 'search-sub' }, tabs, resultCount),
    ),
    resultsHost,
  );

  /* --- URL 同步 --- */
  const syncUrl = () => {
    const params = new URLSearchParams();
    if (state.kw) params.set('kw', state.kw);
    if (state.type !== 'album') params.set('type', state.type);
    const q = params.toString();
    const target = `#/search${q ? '?' + q : ''}`;
    if (location.hash !== target) {
      history.replaceState(null, '', target);
    }
    ctx.query.kw = state.kw;
    ctx.query.type = state.type;
  };

  /* --- 空态 / 热词 --- */
  function emptySearchPanel() {
    const recent = local.searches();
    const box = h('div', { class: 'search-empty' });
    box.append(
      h('p', { class: 'search-empty-title', text: '试试这些' }),
      hotKeywords((w) => {
        input.value = w;
        state.kw = w;
        clearBtn.hidden = false;
        syncUrl();
        runSearch(true);
      }),
    );
    if (recent.length) {
      box.append(
        h(
          'div',
          { class: 'recent-search' },
          h(
            'div',
            { class: 'recent-search-head' },
            h('span', { text: '最近搜索' }),
            h('button', {
              class: 'link-btn',
              type: 'button',
              text: '清空',
              onClick: () => {
                local.clearSearches();
                resultsHost.replaceChildren(emptySearchPanel());
              },
            }),
          ),
          h(
            'div',
            { class: 'recent-list' },
            recent.map((kw) =>
              h(
                'button',
                {
                  class: 'recent-item',
                  type: 'button',
                  onClick: () => {
                    input.value = kw;
                    state.kw = kw;
                    clearBtn.hidden = false;
                    syncUrl();
                    runSearch(true);
                  },
                },
                h('span', { class: 'recent-ico', html: icon('clock', 14) }),
                kw,
              ),
            ),
          ),
        ),
      );
    }
    return box;
  }

  /* --- 请求 --- */
  let searchHint = null;

  async function runSearch(reset = false) {
    const kw = state.kw.trim();
    if (!kw) {
      resultsHost.replaceChildren(emptySearchPanel());
      resultCount.textContent = '';
      return;
    }
    if (reset) {
      state.page = 1;
      state.albums = [];
      state.tracks = [];
      local.addSearch(kw);
    }
    const reqId = ++state.reqId;
    state.loading = true;
    state.error = null;
    renderResults();
    // 搜索通常很快；超过 6 秒仍未返回时提示用户网络较慢
    if (searchHint) searchHint.cancel();
    searchHint = slowHint(resultsHost, 6000, '搜索中，网络较慢…');

    try {
      const data = await api.search(kw, state.type, state.page);
      if (searchHint) searchHint.cancel();
      if (reqId !== state.reqId) return;
      const list = state.type === 'album' ? data.albums || [] : data.tracks || [];
      if (state.type === 'album') state.albums = state.page === 1 ? list : state.albums.concat(list);
      else state.tracks = state.page === 1 ? list : state.tracks.concat(list);

      state.total = Number(data.total) || 0;
      // 分页判断：优先用 total 推算；接口没给 total 时按每页条数兜底
      const pageSize = list.length;
      if (!pageSize) state.hasMore = false;
      else if (state.total > 0) state.hasMore = state.page * pageSize < state.total;
      else state.hasMore = pageSize >= 20;
      state.loading = false;
      renderResults();
    } catch (err) {
      if (searchHint) searchHint.cancel();
      if (reqId !== state.reqId) return;
      if (isAbort(err)) return;
      state.loading = false;
      state.error = err;
      renderResults();
    }
  }

  let nowPlayingOff = null;

  const moreBtn = h('button', {
    class: 'btn btn-ghost load-more-btn',
    type: 'button',
    text: '加载更多',
    onClick: () => {
      state.page += 1;
      runSearch(false);
    },
  });

  function renderResults() {
    const list = state.type === 'album' ? state.albums : state.tracks;
    resultCount.textContent =
      state.kw && !state.loading && !state.error && (list.length || state.total)
        ? `约 ${fmtCount(state.total || list.length)} 个结果`
        : '';

    if (state.loading && !list.length) {
      resultsHost.replaceChildren(
        state.type === 'album' ? skeletonCards(10) : skeletonRows(9, true),
      );
      return;
    }
    if (state.error) {
      resultsHost.replaceChildren(
        errorState(state.error, () => runSearch(true)),
      );
      return;
    }
    if (!state.kw.trim()) {
      resultsHost.replaceChildren(emptySearchPanel());
      return;
    }
    if (!list.length) {
      resultsHost.replaceChildren(
        emptyState({
          iconName: 'search',
          title: `没有找到「${state.kw}」`,
          desc: '换个关键词试试，或者检查一下拼写。',
          action: {
            label: state.type === 'album' ? '搜索声音' : '搜索专辑',
            onClick: () => tabButtons[state.type === 'album' ? 1 : 0].click(),
          },
        }),
      );
      return;
    }

    if (state.type === 'album') {
      resultsHost.replaceChildren(albumGrid(state.albums, {
        onQuickPlay: (album) => player.quickPlayAlbum(album),
      }));
    } else {
      const host = h(
        'div',
        { class: 'track-list' },
        state.tracks.map((t, i) =>
          trackRow(t, {
            index: i + 1,
            showCover: true,
            showAlbum: true,
            onPlay: () => playFrom(state.tracks, i),
          }),
        ),
      );
      if (nowPlayingOff) nowPlayingOff();
      nowPlayingOff = bindNowPlaying(host);
      resultsHost.replaceChildren(host);
    }

    if (state.hasMore) {
      const wrap = h('div', { class: 'load-more-wrap' }, moreBtn);
      resultsHost.append(wrap);
    }
  }

  /* --- 事件 --- */
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      state.kw = input.value;
      clearBtn.hidden = !state.kw.trim();
      syncUrl();
      runSearch(true);
    }
    if (e.key === 'Escape') {
      if (input.value) {
        input.value = '';
        state.kw = '';
        clearBtn.hidden = true;
        syncUrl();
        renderResults();
      }
    }
  });

  const liveSearch = debounce(() => {
    const v = input.value.trim();
    if (v === state.kw.trim()) return;
    state.kw = v;
    clearBtn.hidden = !v;
    syncUrl();
    runSearch(true);
  }, 650);

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    liveSearch();
  });

  if (state.kw) runSearch(true);
  else renderResults();

  requestAnimationFrame(() => {
    if (!state.kw) input.focus({ preventScroll: true });
  });

  return withCleanup(root, () => {
    state.reqId += 1;
    if (nowPlayingOff) nowPlayingOff();
  });
}

/* ------------------------------------------------------------------ */
/* 专辑页                                                              */
/* ------------------------------------------------------------------ */

export function albumView(ctx) {
  const root = page('album-page');
  const albumId = ctx.params.id;
  const state = {
    album: null,
    tracks: [],
    sort: 1,
    page: 1,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: null,
    introOpen: false,
    reqId: 0,
  };

  root.append(skeletonAlbum());
  const body = h('div', { class: 'album-body' });
  const listHost = h('div', { class: 'album-tracks' });
  const heroHost = h('div', { class: 'album-hero-host' });
  root.replaceChildren(heroHost, body);

  let nowPlayingOff = null;

  async function load() {
    const reqId = ++state.reqId;
    state.loading = true;
    heroHost.replaceChildren(skeletonAlbum());
    listHost.replaceChildren(skeletonRows(10));
    body.replaceChildren(listHost);
    const hint = slowHint(listHost, 6000);

    try {
      const data = await api.album(albumId);
      if (reqId !== state.reqId) return;
      if (!data || !data.album) throw new Error('专辑数据为空');
      state.album = data.album;
      state.tracks = Array.isArray(data.tracks) ? data.tracks : [];
      state.hasMore = state.tracks.length >= PAGE_SIZE_HINT;
      hint.cancel();
      state.loading = false;
      render();
    } catch (err) {
      hint.cancel();
      if (reqId !== state.reqId) return;
      if (isAbort(err)) return;
      state.loading = false;
      state.error = err;
      heroHost.replaceChildren(
        h(
          'div',
          { class: 'album-error' },
          errorState(err, () => load()),
          h(
            'div',
            { class: 'album-error-actions' },
            h('button', {
              class: 'btn btn-ghost',
              type: 'button',
              text: '返回首页',
              onClick: () => {
                location.hash = '#/';
              },
            }),
          ),
        ),
      );
      body.replaceChildren();
    }
  }

  function render() {
    const album = state.album;
    heroHost.replaceChildren(renderHero(album));
    renderTracks();
  }

  function renderHero(album) {
    const intro = (album.intro || '').trim();
    const introEl = intro
      ? h('p', { class: `album-intro${state.introOpen ? ' is-open' : ''}`, text: intro })
      : null;

    const introWrap = introEl
      ? h(
          'div',
          { class: 'album-intro-wrap' },
          introEl,
          h('button', {
            class: 'link-btn album-intro-toggle',
            type: 'button',
            text: state.introOpen ? '收起' : '展开简介',
            onClick: () => {
              state.introOpen = !state.introOpen;
              introEl.classList.toggle('is-open', state.introOpen);
              const btn = introEl.nextElementSibling;
              if (btn) btn.textContent = state.introOpen ? '收起' : '展开简介';
            },
          }),
        )
      : null;

    const meta = [
      album.trackCount ? `${album.trackCount} 集` : '',
      album.playCount ? `${fmtCount(album.playCount)} 次播放` : '',
      album.updatedAt ? `更新于 ${fmtDate(album.updatedAt)}` : '',
      album.category || '',
    ].filter(Boolean);

    const flags = h(
      'span',
      { class: 'album-flags' },
      album.access === 'bought' ? badge('已购', 'done') : null,
      album.access === 'vip' ? badge('VIP 会员免费', 'vip') : null,
      album.access === 'vip-locked' ? badge('VIP 专享', 'vip') : null,
      album.access === 'locked' ? badge('付费专辑', 'paid') : null,
      album.isFinished ? badge('已完结', 'done') : null,
    );

    const playBtn = h(
      'button',
      {
        class: 'btn btn-primary btn-play-all',
        type: 'button',
        html: icon('play', 17) + '<span>播放全部</span>',
        onClick: () => {
          if (!state.tracks.length) {
            toast('这张专辑还没有节目', 'info');
            return;
          }
          playFrom(state.tracks, playableIndex(state.tracks));
        },
      },
    );

    const anchor = album.anchor || {};
    return h(
      'section',
      { class: 'album-hero' },
      cover(album.cover, album.title, 'album-cover'),
      h(
        'div',
        { class: 'album-info' },
        h('p', { class: 'album-kicker', text: '专辑' }),
        h('h1', { class: 'album-title', text: album.title || '未命名专辑' }),
        h(
          'div',
          { class: 'album-anchor' },
          avatar(anchor.avatar, anchor.name, 22),
          h('span', { class: 'album-anchor-name', text: anchor.name || '未知主播' }),
        ),
        h('div', { class: 'album-meta' }, meta.map((m, i) => [
          i ? h('span', { class: 'meta-dot', text: '·' }) : null,
          h('span', { text: m }),
        ])),
        flags.childNodes.length ? flags : null,
        h('div', { class: 'album-actions' }, playBtn),
        introWrap,
      ),
    );
  }

  function renderTracks() {
    clear(listHost);

    if (!state.tracks.length) {
      listHost.append(
        emptyState({
          iconName: 'music',
          title: '这张专辑还没有节目',
          desc: '稍后再来看看，或者换个专辑。',
        }),
      );
      return;
    }

    const sortRow = h(
      'div',
      { class: 'list-toolbar' },
      h('span', { class: 'list-toolbar-title', text: '节目列表' }),
      h(
        'div',
        { class: 'list-toolbar-right' },
        h(
          'div',
          { class: 'seg seg-sm' },
          [
            { v: 1, label: '正序' },
            { v: -1, label: '倒序' },
          ].map((opt) =>
            h('button', {
              class: `seg-btn${state.sort === opt.v ? ' is-active' : ''}`,
              type: 'button',
              text: opt.label,
              onClick: () => {
                if (state.sort === opt.v) return;
                state.sort = opt.v;
                state.page = 1;
                reloadTracks();
              },
            }),
          ),
        ),
      ),
    );

    const rows = state.tracks.map((t, i) =>
      trackRow(t, {
        index: t.index != null ? t.index : i + 1,
        showAlbum: false,
        onPlay: () => {
          const idx = state.tracks.findIndex((x) => String(x.id) === String(t.id));
          playFrom(state.tracks, idx >= 0 ? idx : i);
        },
      }),
    );

    const list = h('div', { class: 'track-list' }, rows);
    if (nowPlayingOff) nowPlayingOff();
    nowPlayingOff = bindNowPlaying(list);
    listHost.append(sortRow, list);

    if (state.hasMore) {
      const btn = h('button', {
        class: 'btn btn-ghost load-more-btn',
        type: 'button',
        text: '加载更多节目',
        onClick: async () => {
          if (state.loadingMore) return;
          state.loadingMore = true;
          btn.disabled = true;
          btn.replaceWith(loadingMore());
          try {
            const next = state.page + 1;
            const data = await api.albumTracks(albumId, next, state.sort);
            const more = (data && data.tracks) || [];
            if (!more.length) {
              state.hasMore = false;
              btn.replaceWith(h('span', { class: 'list-end', text: '已经到底啦' }));
              return;
            }
            state.page = next;
            state.tracks = state.tracks.concat(more);
            state.hasMore = Boolean(data.hasMore);
            renderTracks();
          } catch (err) {
            toast(errorText(err), 'error');
            renderTracks();
          } finally {
            state.loadingMore = false;
          }
        },
      });
      listHost.append(h('div', { class: 'load-more-wrap' }, btn));
    } else if (state.tracks.length >= 8) {
      listHost.append(h('span', { class: 'list-end', text: '已经到底啦' }));
    }
  }

  async function reloadTracks() {
    state.loadingMore = true;
    clear(listHost);
    listHost.append(skeletonRows(8));
    try {
      const data = await api.albumTracks(albumId, 1, state.sort);
      state.tracks = (data && data.tracks) || [];
      state.page = 1;
      state.hasMore = Boolean(data && data.hasMore);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      state.loadingMore = false;
      renderTracks();
    }
  }

  load();

  return withCleanup(root, () => {
    state.reqId += 1;
    if (nowPlayingOff) nowPlayingOff();
  });
}

/* ------------------------------------------------------------------ */
/* 我的订阅                                                            */
/* ------------------------------------------------------------------ */

function libraryHeader(title, sub, sortControl) {
  return pageHeader({
    title,
    sub,
    actions: sortControl || null,
  });
}

function sortSeg(current, onPick) {
  const opts = [
    { v: 'recent', label: '最近更新' },
    { v: 'sub', label: '订阅时间' },
  ];
  const wrap = h('div', { class: 'seg seg-sm' });
  opts.forEach((o) => {
    wrap.append(
      h('button', {
        class: `seg-btn${current === o.v ? ' is-active' : ''}`,
        type: 'button',
        text: o.label,
        onClick: () => {
          if (current === o.v) return;
          wrap.querySelectorAll('.seg-btn').forEach((b, i) =>
            b.classList.toggle('is-active', opts[i].v === o.v),
          );
          onPick(o.v);
        },
      }),
    );
  });
  return wrap;
}

export function subscriptionsView(ctx) {
  const root = page();
  const host = h('div', { class: 'lib-host' });
  const state = { sort: 'recent', albums: [], page: 1, hasMore: false, loading: true, error: null, reqId: 0 };

  const head = h('div');
  root.append(head, host);

  const renderHead = () => {
    clear(head);
    head.append(
      libraryHeader(
        '我的订阅',
        '按最近更新或订阅时间排列',
        sortSeg(state.sort, (v) => {
          state.sort = v;
          state.page = 1;
          load(true);
        }),
      ),
    );
  };

  async function load(reset = false) {
    const reqId = ++state.reqId;
    if (reset) {
      state.albums = [];
      state.loading = true;
    }
    renderHead();
    if (state.loading) host.replaceChildren(skeletonCards(12));
    else host.append(loadingMore());
    const hint = state.loading ? slowHint(host, 6000) : null;

    try {
      const data = await api.subscriptions(state.sort, state.page);
      if (hint) hint.cancel();
      if (reqId !== state.reqId) return;
      const list = (data && data.albums) || [];
      state.albums = state.page === 1 ? list : state.albums.concat(list);
      state.hasMore = Boolean(data && data.hasMore);
      state.loading = false;
      state.error = null;
      render();
    } catch (err) {
      if (hint) hint.cancel();
      if (reqId !== state.reqId || isAbort(err)) return;
      state.loading = false;
      state.error = err;
      render();
    }
  }

  function render() {
    clear(host);
    if (state.error) {
      host.append(
        state.error.code === 'NEED_LOGIN'
          ? loginRequired('登录后即可看到你订阅的专辑。')
          : errorState(state.error, () => load(true)),
      );
      return;
    }
    if (!state.albums.length) {
      host.append(
        emptyState({
          iconName: 'radio',
          title: '还没有订阅任何专辑',
          desc: '在喜马拉雅 App 里订阅后，这里会自动同步。',
          action: {
            label: '去搜索',
            onClick: () => {
              location.hash = '#/search';
            },
          },
        }),
      );
      return;
    }
    const grid = albumGrid(state.albums, {
      onQuickPlay: (album) => player.quickPlayAlbum(album),
    });
    host.append(grid);
    if (state.hasMore) {
      host.append(
        h(
          'div',
          { class: 'load-more-wrap' },
          h('button', {
            class: 'btn btn-ghost load-more-btn',
            type: 'button',
            text: '加载更多',
            onClick: () => {
              state.page += 1;
              state.loading = false;
              load(false);
            },
          }),
        ),
      );
    }
  }

  load(true);
  return withCleanup(root, () => {
    state.reqId += 1;
  });
}

/* ------------------------------------------------------------------ */
/* 声音列表类页面：最近收听 / 我喜欢的                                  */
/* ------------------------------------------------------------------ */

function makeTrackLibraryView({ title, sub, iconName, emptyTitle, emptyDesc, fetcher, loginDesc }) {
  return function view(ctx) {
    const root = page();
    const head = h('div', {}, pageHeader({ title, sub }));
    const host = h('div', { class: 'lib-host' });
    root.append(head, host);

    const state = { tracks: [], page: 1, hasMore: false, loading: true, error: null, reqId: 0 };
    let nowPlayingOff = null;

    async function load(reset = false) {
      const reqId = ++state.reqId;
      if (reset) {
        state.tracks = [];
        state.loading = true;
        host.replaceChildren(skeletonRows(10, true));
      } else {
        host.append(loadingMore());
      }
      const hint = reset ? slowHint(host, 6000) : null;
      try {
        const data = await fetcher(state.page);
        if (hint) hint.cancel();
        if (reqId !== state.reqId) return;
        const list = (data && data.tracks) || [];
        state.tracks = state.page === 1 ? list : state.tracks.concat(list);
        state.hasMore = Boolean(data && data.hasMore);
        state.loading = false;
        state.error = null;
        render();
      } catch (err) {
        if (hint) hint.cancel();
        if (reqId !== state.reqId || isAbort(err)) return;
        state.loading = false;
        state.error = err;
        render();
      }
    }

    function render() {
      clear(host);
      if (state.error) {
        host.append(
          state.error.code === 'NEED_LOGIN'
            ? loginRequired(loginDesc)
            : errorState(state.error, () => load(true)),
        );
        return;
      }
      if (!state.tracks.length) {
        host.append(
          emptyState({
            iconName,
            title: emptyTitle,
            desc: emptyDesc,
            action: {
              label: '去搜索',
              onClick: () => {
                location.hash = '#/search';
              },
            },
          }),
        );
        return;
      }
      const list = h(
        'div',
        { class: 'track-list' },
        state.tracks.map((t, i) =>
          trackRow(t, {
            index: i + 1,
            showCover: true,
            showAlbum: true,
            onPlay: () => playFrom(state.tracks, i),
          }),
        ),
      );
      if (nowPlayingOff) nowPlayingOff();
      nowPlayingOff = bindNowPlaying(list);
      host.append(list);
      if (state.hasMore) {
        host.append(
          h(
            'div',
            { class: 'load-more-wrap' },
            h('button', {
              class: 'btn btn-ghost load-more-btn',
              type: 'button',
              text: '加载更多',
              onClick: () => {
                state.page += 1;
                load(false);
              },
            }),
          ),
        );
      }
    }

    load(true);
    return withCleanup(root, () => {
      state.reqId += 1;
      if (nowPlayingOff) nowPlayingOff();
    });
  };
}

export const listenedView = makeTrackLibraryView({
  title: '最近收听',
  sub: '来自你的喜马拉雅账号',
  iconName: 'clock',
  emptyTitle: '还没有收听记录',
  emptyDesc: '播放任意一集后，这里会显示最近听过的内容。',
  loginDesc: '登录后可同步账号里的最近收听记录。',
  fetcher: (page) => api.listened(page),
});

export const likesView = makeTrackLibraryView({
  title: '我喜欢的',
  sub: '你在喜马拉雅里点过喜欢的声音',
  iconName: 'heart',
  emptyTitle: '还没有喜欢的声音',
  emptyDesc: '在喜马拉雅 App 里点喜欢，内容会自动同步到这里。',
  loginDesc: '登录后可同步你在喜马拉雅里喜欢的声音。',
  fetcher: (page) => api.likes(page),
});

/* ------------------------------------------------------------------ */
/* 已购专辑                                                            */
/* ------------------------------------------------------------------ */

export function boughtView(ctx) {
  const root = page();
  const head = h('div', {}, pageHeader({ title: '已购专辑', sub: '你购买过的专辑都在这儿' }));
  const host = h('div', { class: 'lib-host' });
  root.append(head, host);

  const state = { albums: [], page: 1, hasMore: false, loading: true, error: null, reqId: 0 };

  async function load(reset = false) {
    const reqId = ++state.reqId;
    if (reset) {
      state.albums = [];
      state.loading = true;
      host.replaceChildren(skeletonCards(10));
    } else {
      host.append(loadingMore());
    }
    try {
      const data = await api.bought(state.page);
      if (reqId !== state.reqId) return;
      const list = (data && data.albums) || [];
      state.albums = state.page === 1 ? list : state.albums.concat(list);
      state.hasMore = Boolean(data && data.hasMore);
      state.loading = false;
      state.error = null;
      render();
    } catch (err) {
      if (reqId !== state.reqId || isAbort(err)) return;
      state.loading = false;
      state.error = err;
      render();
    }
  }

  function render() {
    clear(host);
    if (state.error) {
      host.append(
        state.error.code === 'NEED_LOGIN'
          ? loginRequired('登录后可查看你购买过的专辑。')
          : errorState(state.error, () => load(true)),
      );
      return;
    }
    if (!state.albums.length) {
      host.append(
        emptyState({
          iconName: 'bag',
          title: '还没有购买记录',
          desc: '付费专辑购买后会出现在这里，登录同一账号即可同步。',
        }),
      );
      return;
    }
    host.append(albumGrid(state.albums, { onQuickPlay: (a) => player.quickPlayAlbum(a) }));
    if (state.hasMore) {
      host.append(
        h(
          'div',
          { class: 'load-more-wrap' },
          h('button', {
            class: 'btn btn-ghost load-more-btn',
            type: 'button',
            text: '加载更多',
            onClick: () => {
              state.page += 1;
              load(false);
            },
          }),
        ),
      );
    }
  }

  load(true);
  return withCleanup(root, () => {
    state.reqId += 1;
  });
}

/* ------------------------------------------------------------------ */
/* 404                                                                 */
/* ------------------------------------------------------------------ */

export function notFoundView(ctx) {
  const root = page();
  root.append(
    emptyState({
      iconName: 'alert',
      title: '页面不存在',
      desc: '这个地址可能已经失效了。',
      action: {
        label: '回到首页',
        onClick: () => {
          location.hash = '#/';
        },
      },
    }),
  );
  return withCleanup(root);
}
