/**
 * 播放器：<audio> 封装 + 队列 + 直链获取 + Media Session + 睡眠定时。
 * UI 只读 store.state.player，不直接操作 audio。
 */

import { api, errorText, ApiError, streamUrl } from './api.js';
import { store, ls, local, state } from './store.js';
import { toast, fmtDuration } from './ui.js';
import { showNotice, noticePlayError, clearNotice } from './notice.js';

const audio = document.getElementById('audio');

export const RATES = [1, 1.25, 1.5, 1.75, 2];
export const MODES = ['list', 'one', 'seq'];
export const MODE_LABEL = { list: '列表循环', one: '单集循环', seq: '顺序播放' };
export const MODE_ICON = { list: 'repeat', one: 'repeat-one', seq: 'sequential' };

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 把任意 Track 形状统一成队列项 */
export function normalizeTrack(t) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.title || '未命名节目',
    albumId: t.albumId != null ? t.albumId : null,
    albumTitle: t.albumTitle || '',
    cover: t.cover || '',
    duration: Number(t.duration) || 0,
    index: t.index != null ? t.index : null,
    isPaid: Boolean(t.isPaid),
    playable: t.playable !== false,
  };
}

class Player {
  constructor() {
    this.token = 0;
    this.usedProxy = false;
    this.pendingResume = false;
    this.historyId = null;
    this.lastPositionSave = 0;
    this.lastMediaPosition = 0;
    this.sleepTimer = 0;
    this.sleepEndsAt = 0;
    this.volumeToastAt = 0;

    this._bindAudio();
    this._bindMediaSession();
    this._restore();
  }

  /* ---------------------------------------------------------------- */
  /* 初始化                                                            */
  /* ---------------------------------------------------------------- */

  _bindAudio() {
    audio.addEventListener('play', () => {
      store.update('player', { playing: true, error: null });
      this._setMediaPlaybackState('playing');
      this._rememberHistory();
    });

    audio.addEventListener('playing', () => {
      store.update('player', { playing: true, loading: false });
    });

    audio.addEventListener('pause', () => {
      store.update('player', { playing: false });
      this._setMediaPlaybackState('paused');
      this._savePosition();
    });

    audio.addEventListener('waiting', () => {
      store.update('player', { loading: true });
    });

    audio.addEventListener('canplay', () => {
      store.update('player', { loading: false });
    });

    audio.addEventListener('timeupdate', () => {
      const d = Number.isFinite(audio.duration) ? audio.duration : 0;
      store.update('player', {
        time: audio.currentTime || 0,
        duration: d || store.state.player.duration,
      });
      this._savePositionThrottled();
      const now = Date.now();
      if (now - this.lastMediaPosition > 1000) {
        this.lastMediaPosition = now;
        this._setMediaPosition();
      }
    });

    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        store.update('player', { duration: audio.duration });
      }
      if (this.pendingResume) {
        this.pendingResume = false;
        const cur = store.state.player.current;
        if (cur) {
          const pos = local.getPosition(cur.id);
          const d = Number.isFinite(audio.duration) ? audio.duration : store.state.player.duration;
          if (pos > 5 && (!d || pos < d - 10)) {
            try {
              audio.currentTime = pos;
              store.update('player', { time: pos });
            } catch {
              /* noop */
            }
          }
        }
      }
      this._setMediaPosition();
    });

    audio.addEventListener('ended', () => this._handleEnded());

    audio.addEventListener('error', () => this._handleAudioError());

    audio.addEventListener('volumechange', () => {
      store.update('player', {
        volume: audio.volume,
        muted: audio.muted,
      });
    });
  }

  _bindMediaSession() {
    if (!navigator.mediaSession) return;
    const set = (name, fn) => {
      try {
        navigator.mediaSession.setActionHandler(name, fn);
      } catch {
        /* 某些动作不被支持，忽略 */
      }
    };
    set('play', () => this.toggle());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekbackward', (d) => this.seekBy(-(d && d.seekOffset ? d.seekOffset : 10)));
    set('seekforward', (d) => this.seekBy(d && d.seekOffset ? d.seekOffset : 10));
    set('seekto', (d) => {
      if (d && Number.isFinite(d.seekTime)) this.seek(d.seekTime);
    });
    set('stop', () => this.pause());
  }

  _restore() {
    const p = store.state.player;
    const rate = Number(ls.get('rate', 1));
    const mode = ls.get('mode', 'list');
    const volume = clamp(Number(ls.get('volume', 0.8)), 0, 1);
    const muted = Boolean(ls.get('muted', false));

    const patch = {
      rate: RATES.includes(rate) ? rate : 1,
      mode: MODES.includes(mode) ? mode : 'list',
      volume,
      muted,
    };

    audio.volume = volume;
    audio.muted = muted;
    audio.playbackRate = patch.rate;

    const saved = ls.get('queue', null);
    if (Array.isArray(saved) && saved.length) {
      const list = saved.map(normalizeTrack).filter((t) => t && t.id != null);
      if (list.length) {
        const idx = clamp(Number(ls.get('queueIndex', 0)) || 0, 0, list.length - 1);
        patch.queue = list;
        patch.index = idx;
        patch.current = list[idx];
        patch.duration = list[idx].duration || 0;
        patch.time = 0;
        this._applyMediaMetadata(list[idx]);
      }
    }

    store.update('player', patch);
  }

  /* ---------------------------------------------------------------- */
  /* 播放核心                                                          */
  /* ---------------------------------------------------------------- */

  async _load(track, options = {}) {
    const { autoplay = true, resume = false } = options;
    if (!track) return;
    const token = ++this.token;
    this.usedProxy = false;
    this.pendingResume = resume;
    this.historyId = null;

    store.update('player', {
      current: track,
      duration: track.duration || 0,
      time: 0,
      loading: autoplay,
      error: null,
      quality: '',
    });
    this._applyMediaMetadata(track);

    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch {
      /* noop */
    }

    try {
      const src = await api.audio(track.id);
      if (token !== this.token) return;
      if (!src || !src.url) throw new ApiError('没有拿到播放地址', 'UPSTREAM', 502);

      const p = store.state.player;
      store.update('player', {
        quality: src.quality || '',
        duration: Number(src.duration) || track.duration || 0,
      });

      audio.src = src.url;
      audio.playbackRate = p.rate;
      audio.volume = p.volume;
      audio.muted = p.muted;

      if (autoplay) {
        await this._play();
      } else {
        audio.load();
        store.update('player', { loading: false });
      }
      if (token !== this.token) return;
      // 成功拿到播放地址：清掉之前的播放错误提示
      clearNotice('play-error');
      store.update('player', { loading: false });
    } catch (err) {
      if (token !== this.token) return;
      if (err && err.name === 'AbortError') return;
      const msg = errorText(err);
      const error = { code: (err && err.code) || 'UNKNOWN', message: msg };
      store.update('player', { loading: false, playing: false, error });
      // 顶部提示条（不打断界面），同时保留播放条状态
      noticePlayError(err);
    }
  }

  async _play() {
    try {
      await audio.play();
    } catch (err) {
      if (!err) return;
      if (err.name === 'AbortError') return; // 被新的加载打断
      if (err.name === 'NotAllowedError') {
        store.update('player', { playing: false, loading: false });
        toast('浏览器阻止了自动播放，请点击播放按钮', 'info');
        return;
      }
      // 其它错误交给 error 事件里的代理兜底逻辑处理
      store.update('player', { loading: false, playing: false });
    }
  }

  _handleAudioError() {
    const cur = store.state.player.current;
    if (!cur || !audio.src) return;

    if (!this.usedProxy) {
      this.usedProxy = true;
      audio.src = streamUrl(cur.id);
      audio.playbackRate = store.state.player.rate;
      audio.play().catch(() => {});
      return;
    }

    store.update('player', { playing: false, loading: false });
    showNotice({
      id: 'play-error',
      kind: 'error',
      message: '音频加载失败，可能是链接已过期',
      detail: '请重新点击播放',
      autoHide: 8000,
    });
  }

  _handleEnded() {
    const { mode, index, queue, current } = store.state.player;
    if (current) local.dropPosition(current.id);

    if (mode === 'one') {
      audio.currentTime = 0;
      this._play();
      return;
    }
    if (mode === 'list') {
      this.next(true);
      return;
    }
    if (index < queue.length - 1) {
      this.next(true);
      return;
    }
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      /* noop */
    }
    store.update('player', { playing: false, time: 0 });
  }

  _rememberHistory() {
    const cur = store.state.player.current;
    if (!cur || this.historyId === String(cur.id)) return;
    this.historyId = String(cur.id);
    local.addHistory(cur);
  }

  /* ---------------------------------------------------------------- */
  /* 对外 API                                                          */
  /* ---------------------------------------------------------------- */

  /** 播放某一集；list 提供队列上下文 */
  playTrack(track, list, opts = {}) {
    const items = (Array.isArray(list) && list.length ? list : [track])
      .map(normalizeTrack)
      .filter(Boolean);
    const idx = items.findIndex((t) => String(t.id) === String(track && track.id));
    return this.playQueue(items, idx >= 0 ? idx : 0, opts);
  }

  playQueue(items, index = 0, opts = {}) {
    const list = (items || []).map(normalizeTrack).filter(Boolean);
    if (!list.length) return;
    const i = clamp(Number(index) || 0, 0, list.length - 1);
    store.update('player', { queue: list, index: i });
    this._persistQueue();
    return this._load(list[i], {
      autoplay: opts.autoplay !== false,
      resume: Boolean(opts.resume),
    });
  }

  toggle() {
    const { current } = store.state.player;
    if (!current) {
      toast('先从列表里选一集开始听吧', 'info');
      return;
    }
    if (!audio.src) {
      this._load(current, { autoplay: true, resume: true });
      return;
    }
    if (audio.paused) this._play();
    else this.pause();
  }

  pause() {
    if (!audio.paused) audio.pause();
    this._savePosition();
  }

  next(auto = false) {
    const { queue, index, mode } = store.state.player;
    if (!queue.length) return;
    let nextIndex = index + 1;
    if (nextIndex >= queue.length) {
      if (auto && mode === 'seq') {
        audio.pause();
        store.update('player', { playing: false });
        return;
      }
      nextIndex = 0;
    }
    this.playQueue(queue, nextIndex);
  }

  prev() {
    const { queue, index } = store.state.player;
    if (!queue.length) return;
    if (audio.currentTime > 5) {
      this.seek(0);
      return;
    }
    let i = index - 1;
    if (i < 0) i = queue.length - 1;
    this.playQueue(queue, i);
  }

  jumpTo(index) {
    const { queue } = store.state.player;
    if (!queue.length) return;
    this.playQueue(queue, index);
  }

  seek(seconds) {
    const d = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : store.state.player.duration;
    if (!d) return;
    const target = clamp(Number(seconds) || 0, 0, Math.max(0, d - 0.3));
    try {
      audio.currentTime = target;
    } catch {
      return;
    }
    store.update('player', { time: target });
    this._setMediaPosition();
  }

  seekBy(delta) {
    const base = Number.isFinite(audio.currentTime) ? audio.currentTime : store.state.player.time;
    this.seek(base + delta);
    toast(`${delta > 0 ? '快进' : '快退'} ${Math.abs(delta)} 秒`, 'info', 1200);
  }

  setVolume(v) {
    const volume = clamp(Number(v) || 0, 0, 1);
    audio.volume = volume;
    if (volume > 0 && audio.muted) audio.muted = false;
    store.update('player', { volume, muted: audio.muted });
    ls.set('volume', volume);
    ls.set('muted', audio.muted);

    const now = Date.now();
    if (now - this.volumeToastAt > 700) {
      this.volumeToastAt = now;
      toast(`音量 ${Math.round(volume * 100)}%`, 'info', 1000);
    }
  }

  nudgeVolume(delta) {
    this.setVolume(store.state.player.volume + delta);
  }

  toggleMute() {
    audio.muted = !audio.muted;
    store.update('player', { muted: audio.muted });
    ls.set('muted', audio.muted);
    toast(audio.muted ? '已静音' : '已取消静音', 'info', 1200);
  }

  setRate(rate) {
    const r = RATES.includes(Number(rate)) ? Number(rate) : 1;
    audio.playbackRate = r;
    store.update('player', { rate: r });
    ls.set('rate', r);
    toast(`播放速度 ${r === 1 ? '1.0' : r}x`, 'info', 1400);
    this._setMediaPosition();
  }

  setMode(mode) {
    const m = MODES.includes(mode) ? mode : 'list';
    store.update('player', { mode: m });
    ls.set('mode', m);
    toast(`播放模式：${MODE_LABEL[m]}`, 'info', 1600);
  }

  cycleMode() {
    const { mode } = store.state.player;
    const i = MODES.indexOf(mode);
    this.setMode(MODES[(i + 1) % MODES.length]);
  }

  /** minutes = 0 表示取消 */
  setSleep(minutes) {
    if (this.sleepTimer) {
      clearInterval(this.sleepTimer);
      this.sleepTimer = 0;
    }
    const m = Number(minutes) || 0;
    if (!m) {
      store.update('player', { sleepEndsAt: 0, sleepRemaining: 0 });
      toast('已取消睡眠定时', 'info', 1800);
      return;
    }
    const endsAt = Date.now() + m * 60000;
    store.update('player', { sleepEndsAt: endsAt, sleepRemaining: m * 60000 });
    this.sleepTimer = setInterval(() => {
      const left = endsAt - Date.now();
      if (left <= 0) {
        clearInterval(this.sleepTimer);
        this.sleepTimer = 0;
        store.update('player', { sleepEndsAt: 0, sleepRemaining: 0 });
        this.pause();
        toast('睡眠定时结束，已暂停播放', 'info', 4000);
      } else {
        store.update('player', { sleepRemaining: left });
      }
    }, 1000);
    toast(`将在 ${m} 分钟后暂停播放`, 'success', 2400);
  }

  clearQueue() {
    this.token++;
    audio.pause();
    try {
      audio.removeAttribute('src');
      audio.load();
    } catch {
      /* noop */
    }
    this.historyId = null;
    store.update('player', {
      queue: [],
      index: -1,
      current: null,
      playing: false,
      loading: false,
      time: 0,
      duration: 0,
      quality: '',
      error: null,
    });
    ls.del('queue');
    ls.del('queueIndex');
    if (navigator.mediaSession) {
      try {
        navigator.mediaSession.metadata = null;
      } catch {
        /* noop */
      }
    }
  }

  removeAt(i) {
    const { queue, index, playing } = store.state.player;
    if (i < 0 || i >= queue.length) return;
    const next = queue.slice();
    next.splice(i, 1);
    if (!next.length) {
      this.clearQueue();
      return;
    }
    let idx = index;
    if (i === index) {
      idx = Math.min(i, next.length - 1);
      store.update('player', { queue: next, index: idx });
      this._persistQueue();
      this.playQueue(next, idx, { autoplay: playing });
    } else {
      if (i < index) idx = index - 1;
      store.update('player', { queue: next, index: idx });
      this._persistQueue();
    }
  }

  /** 从专辑卡直接播放：取专辑第一集可播的 */
  async quickPlayAlbum(album) {
    if (!album || album.id == null) return;
    try {
      const data = await api.album(album.id);
      const tracks = (data && data.tracks) || [];
      if (!tracks.length) {
        toast('这张专辑还没有可播放的节目', 'info');
        location.hash = `#/album/${album.id}`;
        return;
      }
      const idx = Math.max(0, tracks.findIndex((t) => t.playable !== false));
      this.playQueue(tracks, idx);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  /** 继续收听：从上次位置恢复 */
  resume(track) {
    if (!track) return;
    this.playQueue([track], 0, { resume: true });
  }

  get audio() {
    return audio;
  }

  /* ---------------------------------------------------------------- */
  /* 持久化 / Media Session                                            */
  /* ---------------------------------------------------------------- */

  _persistQueue() {
    const { queue, index } = store.state.player;
    const slim = queue.slice(0, 200);
    ls.set('queue', slim);
    ls.set('queueIndex', index);
  }

  _savePositionThrottled() {
    const now = Date.now();
    if (now - this.lastPositionSave < 5000) return;
    this.lastPositionSave = now;
    this._savePosition();
  }

  _savePosition() {
    const { current, time, duration } = store.state.player;
    if (!current) return;
    if (!Number.isFinite(time) || time < 3) return;
    if (duration && time > duration - 8) {
      local.dropPosition(current.id);
      return;
    }
    local.savePosition(current.id, time, duration);
  }

  _applyMediaMetadata(track) {
    if (!navigator.mediaSession || typeof window.MediaMetadata !== 'function') return;
    try {
      const artwork = track.cover
        ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }]
        : [];
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title || '未命名节目',
        artist: track.albumTitle || '喜马拉雅',
        album: track.albumTitle || '喜马拉雅',
        artwork,
      });
    } catch {
      /* 某些环境不支持 artwork，忽略 */
    }
  }

  _setMediaPlaybackState(value) {
    if (!navigator.mediaSession) return;
    try {
      navigator.mediaSession.playbackState = value;
    } catch {
      /* noop */
    }
  }

  _setMediaPosition() {
    if (!navigator.mediaSession || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const d = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime || 0, d),
      });
    } catch {
      /* noop */
    }
  }
}

export const player = new Player();

/** 供 UI 展示用的辅助 */
export function playerSummary() {
  const p = store.state.player;
  return {
    title: p.current ? p.current.title : '未在播放',
    album: p.current ? p.current.albumTitle : '',
    duration: fmtDuration(p.duration),
  };
}

export { state };
