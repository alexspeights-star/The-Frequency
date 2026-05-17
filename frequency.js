// ============================================================
// THE FREQUENCY — PRODIGAL ROBE
// frequency.js v2.0
// ============================================================

/* ── CONSTANTS ───────────────────────────────────────────── */
const FQ_API_KEY        = 'YOUR_API_KEY_HERE'; // ← drop your YouTube Data API key here
const FQ_CACHE_TTL      = 6 * 60 * 60 * 1000; // 6 hours
const FQ_VIDEO_SLOT_SEC = 1800;                // 30 min per video slot
const FQ_MIN_DURATION   = 120;                 // skip anything under 2 min (blocks Shorts)
const FQ_VERSION        = 'v2.0';

/* ── STATE ───────────────────────────────────────────────── */
let fqIdx        = -1;
let fqPlayer     = null;
let fqReady      = false;
let fqMuted      = true;
let fqBlock      = null;
let fqNsId       = null;
let fqBugTimer   = null;
let fqUserName   = '';
let fqUnlocked   = false;
let fqErrorSkip  = 0;
let fqActiveCat  = 'all';
let fqTargetStart = 0; // intended seek position — verified after PLAYING fires

/* ── TIME BLOCK ──────────────────────────────────────────── */
function fqGetBlock() {
  const h = new Date().getHours();
  for (const b of FQ_BLOCKS) {
    if (b.start <= b.end) {
      if (h >= b.start && h < b.end) return b;
    } else {
      if (h >= b.start || h < b.end) return b;
    }
  }
  return FQ_BLOCKS[0];
}

/* ── SEEDED SHUFFLE ──────────────────────────────────────── */
function fqSeededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function fqDailyShuffleIds(ids, channelNumber) {
  const now     = new Date();
  const daySeed = now.getFullYear() * 10000
                + (now.getMonth() + 1) * 100
                + now.getDate()
                + parseInt(channelNumber, 10);
  const rand = fqSeededRandom(daySeed);
  const arr  = [...ids];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── SYNCED POSITION ─────────────────────────────────────── */
// Every device at the same UTC time calculates the same video + offset.
// This is how broadcast TV works — deterministic, no server required.
function fqGetSyncedPosition(channelNumber, videoIds) {
  if (!videoIds.length) return { shuffled: [], videoIndex: 0, startSeconds: 0 };
  const shuffled      = fqDailyShuffleIds(videoIds, channelNumber);
  const nowSec        = Math.floor(Date.now() / 1000);
  const chOffset      = parseInt(channelNumber, 10) * 307; // stagger channels
  const totalDur      = shuffled.length * FQ_VIDEO_SLOT_SEC;
  const posInCycle    = (nowSec + chOffset) % totalDur;
  const videoIndex    = Math.floor(posInCycle / FQ_VIDEO_SLOT_SEC);
  const startSeconds  = posInCycle % FQ_VIDEO_SLOT_SEC;
  return { shuffled, videoIndex, startSeconds };
}

/* ── CORS PROXY WITH FALLBACK ────────────────────────────── */
const FQ_PROXIES = [
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

async function fqProxyFetch(url) {
  for (const proxy of FQ_PROXIES) {
    try {
      const res = await fetch(proxy(url), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      // allorigins wraps in { contents }, corsproxy returns raw text in body
      const text = data.contents ?? (typeof data === 'string' ? data : null);
      if (text) return text;
    } catch (e) {
      // try next proxy
    }
  }
  return null;
}

/* ── RSS VIDEO FETCH ─────────────────────────────────────── */
async function fqFetchViaRSS(channelId) {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const text   = await fqProxyFetch(rssUrl);
  if (!text) return null;

  try {
    const xml = new DOMParser().parseFromString(text, 'text/xml');
    const ids = [];
    xml.querySelectorAll('entry').forEach(entry => {
      const el = entry.getElementsByTagNameNS('http://www.youtube.com/xml/schemas/2015', 'videoId')[0];
      if (el?.textContent) ids.push(el.textContent.trim());
    });
    return ids.length ? ids : null;
  } catch (e) {
    return null;
  }
}

/* ── API + RSS VIDEO FETCH ───────────────────────────────── */
async function fqFetchVideos(channelId) {
  const cacheKey = `fq_vids_${channelId}`;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < FQ_CACHE_TTL && parsed.ids?.length) return parsed.ids;
    }
  } catch (e) {}

  let ids = null;

  // Try YouTube Data API first (best quality, filters Shorts with videoDuration=long)
  if (FQ_API_KEY && FQ_API_KEY !== 'YOUR_API_KEY_HERE') {
    const apiIds = [];
    let pageToken = '';
    try {
      do {
        const url = `https://www.googleapis.com/youtube/v3/search`
          + `?key=${FQ_API_KEY}&channelId=${channelId}&part=id`
          + `&order=date&type=video&videoDuration=long&maxResults=50`
          + (pageToken ? `&pageToken=${pageToken}` : '');
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) break;
        const d = await res.json();
        (d.items || []).forEach(i => { if (i.id?.videoId) apiIds.push(i.id.videoId); });
        pageToken = d.nextPageToken || '';
      } while (pageToken && apiIds.length < 100);
      if (apiIds.length) ids = apiIds;
    } catch (e) {}
  }

  // Fallback: RSS (returns up to 15 most recent videos, no duration filter)
  if (!ids) ids = await fqFetchViaRSS(channelId);

  if (ids?.length) {
    try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), ids })); } catch (e) {}
    const apiEl = document.getElementById('fq-st-api');
    if (apiEl) {
      const label = FQ_API_KEY !== 'YOUR_API_KEY_HERE' ? 'API: ACTIVE' : 'RSS: ACTIVE';
      apiEl.textContent = label;
      apiEl.className   = 'fq-si fq-green';
    }
  }

  return ids?.length ? ids : null;
}

/* ── POPULATE ALL QUEUES ─────────────────────────────────── */
async function fqPopulateQueues() {
  const fetches = FQ_CHANNELS
    .filter(ch => ch.youtubeChannelId && !ch.liveStreamVideoId && !ch.playlistId)
    .map(async ch => {
      // Use hardcoded IDs if we have them and cache is cold
      const cacheKey = `fq_vids_${ch.youtubeChannelId}`;
      let hasCached = false;
      try {
        const raw = localStorage.getItem(cacheKey);
        if (raw) {
          const p = JSON.parse(raw);
          if (Date.now() - p.ts < FQ_CACHE_TTL && p.ids?.length) {
            ch.videoIds = p.ids;
            hasCached   = true;
          }
        }
      } catch (e) {}

      if (!hasCached) {
        const ids = await fqFetchVideos(ch.youtubeChannelId);
        if (ids?.length) {
          ch.videoIds = ids;
          // If this is the active channel and it was showing no-signal, start playing
          const chIndex = FQ_CHANNELS.indexOf(ch);
          if (chIndex === fqIdx && fqReady) {
            const ns = document.getElementById('fq-no-signal');
            if (ns && ns.style.display !== 'none') {
              fqStopNS();
              fqLoadSyncedVideo();
            }
          }
        }
      }
    });

  // Fetch in parallel, 5 at a time to avoid throttling
  for (let i = 0; i < fetches.length; i += 5) {
    await Promise.allSettled(fetches.slice(i, i + 5));
  }

  fqRenderGuide();
  setTimeout(fqPopulateQueues, FQ_CACHE_TTL);
}

/* ── YOUTUBE PLAYER ──────────────────────────────────────── */
function fqLoadYTAPI() {
  if (window.YT?.Player) { window.onYouTubeIframeAPIReady(); return; }
  const s = document.createElement('script');
  s.src   = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}

window.onYouTubeIframeAPIReady = function () {
  if (fqPlayer) return;
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  fqPlayer = new YT.Player('fq-yt-player', {
    height: '100%', width: '100%',
    playerVars: {
      autoplay: 1, controls: isMobile ? 1 : 0,
      rel: 0, modestbranding: 1,
      iv_load_policy: 3, playsinline: 1, fs: 1, mute: 1,
    },
    events: {
      onReady: e => {
        fqReady = true;
        if (!isMobile) {
          try { e.target.unMute(); e.target.setVolume(80); } catch (err) {}
          fqUnlocked = true;
          const blocker = document.getElementById('fq-tap-blocker');
          if (blocker) blocker.style.display = 'none';
        }
        if (fqIdx >= 0) fqLoadSyncedVideo();
      },
      onStateChange: fqOnState,
      onError: e => {
        console.warn('YT error:', e.data);
        // Error 150 = embedding disabled. Error 101 = private. Skip to next.
        setTimeout(fqSkipBlockedVideo, 1500);
      },
    },
  });
};

function fqSkipBlockedVideo() {
  if (fqIdx < 0) return;
  const ch = FQ_CHANNELS[fqIdx];
  if (!ch.videoIds.length) { fqShowNoSig(); return; }
  fqErrorSkip++;
  if (fqErrorSkip > Math.min(ch.videoIds.length, 8)) {
    fqErrorSkip = 0;
    fqShowNoSig();
    return;
  }
  const { shuffled, videoIndex } = fqGetSyncedPosition(ch.number, ch.videoIds);
  const nextIdx = (videoIndex + fqErrorSkip) % shuffled.length;
  fqPlayer.loadVideoById({ videoId: shuffled[nextIdx], startSeconds: 0 });
}

let fqSeekVerifyTimer = null;

function fqOnState(e) {
  if (e.data === YT.PlayerState.ENDED) {
    try {
      const dur = fqPlayer.getDuration();
      if (dur > 0 && dur < FQ_MIN_DURATION) { fqSkipBlockedVideo(); return; }
    } catch (err) {}
    fqNextVid();
    return;
  }

  if (e.data === YT.PlayerState.PLAYING) {
    fqErrorSkip = 0;

    // Skip if this is a Short (duration < FQ_MIN_DURATION)
    try {
      const dur = fqPlayer.getDuration();
      if (dur > 0 && dur < FQ_MIN_DURATION) { fqSkipBlockedVideo(); return; }
    } catch (err) {}

    // Verify sync position: if YouTube reset startSeconds to 0, seek manually
    clearTimeout(fqSeekVerifyTimer);
    if (fqTargetStart > 60) {
      fqSeekVerifyTimer = setTimeout(() => {
        if (!fqPlayer || !fqReady) return;
        try {
          const cur = fqPlayer.getCurrentTime();
          const dur = fqPlayer.getDuration();
          if (cur < 5 && dur > 0) {
            // Seek to target, clamped to actual duration
            const seek = fqTargetStart < dur ? fqTargetStart : fqTargetStart % dur;
            fqPlayer.seekTo(seek, true);
          }
        } catch (err) {}
      }, 800);
    }

    const ns = document.getElementById('fq-no-signal');
    if (ns) { ns.style.display = 'none'; ns.style.visibility = 'hidden'; }
    fqStopNS();
    fqUpdateTitle();
    return;
  }

  if (e.data === YT.PlayerState.BUFFERING) {
    const ns = document.getElementById('fq-no-signal');
    if (ns) { ns.style.display = 'none'; ns.style.visibility = 'hidden'; }
    fqStopNS();
  }
}

function fqUpdateTitle() {
  try {
    const d   = fqPlayer.getVideoData();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || ''; };
    set('fq-np-title',   d.title);
    set('fq-info-title', d.title);
  } catch (e) {}
}

/* ── TAP HANDLER (iOS audio unlock) ─────────────────────── */
function fqHandleTap() {
  if (!fqReady) return;
  fqUnlocked = true;
  try { fqPlayer.unMute(); fqPlayer.setVolume(80); } catch (e) {}
  fqMuted = false;
  const blocker = document.getElementById('fq-tap-blocker');
  if (blocker) blocker.style.display = 'none';
  fqSyncMuteUI();
}

/* ── LOAD VIDEO ──────────────────────────────────────────── */
function fqLoadSyncedVideo() {
  if (!fqReady || fqIdx < 0) return;
  const ch = FQ_CHANNELS[fqIdx];
  clearTimeout(fqSeekVerifyTimer);
  fqTargetStart = 0;

  // 24/7 live stream
  if (ch.liveStreamVideoId) {
    fqPlayer.loadVideoById({ videoId: ch.liveStreamVideoId, startSeconds: 0 });
    document.getElementById('fq-no-signal').style.display = 'none';
    return;
  }

  // Playlist
  if (ch.playlistId) {
    fqPlayer.loadPlaylist({ list: ch.playlistId, listType: 'playlist', index: 0, startSeconds: 0 });
    fqPlayer.setShuffle(true);
    document.getElementById('fq-no-signal').style.display = 'none';
    return;
  }

  // Regular channel — synced by time
  if (!ch.videoIds.length) { fqShowNoSig(); return; }
  const { shuffled, videoIndex, startSeconds } = fqGetSyncedPosition(ch.number, ch.videoIds);
  fqTargetStart = startSeconds;
  fqPlayer.loadVideoById({ videoId: shuffled[videoIndex], startSeconds });
  document.getElementById('fq-no-signal').style.display = 'none';
}

function fqNextVid() {
  if (fqIdx < 0) return;
  // Advance one slot and reload — stays in sync because all devices do the same calculation
  fqLoadSyncedVideo();
}

function fqPrevVid() {
  if (fqIdx < 0) return;
  const ch = FQ_CHANNELS[fqIdx];
  if (!ch.videoIds.length) return;
  const shuffled         = fqDailyShuffleIds(ch.videoIds, ch.number);
  const { videoIndex }   = fqGetSyncedPosition(ch.number, ch.videoIds);
  const prevIdx          = (videoIndex - 1 + shuffled.length) % shuffled.length;
  fqTargetStart          = 0;
  fqPlayer.loadVideoById({ videoId: shuffled[prevIdx], startSeconds: 0 });
}

/* ── NO SIGNAL ───────────────────────────────────────────── */
function fqStartNS() {
  const canvas = document.getElementById('fq-ns-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width  = canvas.offsetWidth  || 640;
  canvas.height = canvas.offsetHeight || 360;
  const frame = () => {
    const { width: w, height: h } = canvas;
    const img = ctx.createImageData(w, h);
    const d   = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * 255 | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  };
  if (fqNsId) clearInterval(fqNsId);
  fqNsId = setInterval(frame, 50);
}

function fqStopNS() { clearInterval(fqNsId); fqNsId = null; }

function fqShowNoSig() {
  const ns = document.getElementById('fq-no-signal');
  if (ns) { ns.style.display = 'flex'; ns.style.visibility = 'visible'; }
  fqStartNS();
}

/* ── CHANNEL FLASH ───────────────────────────────────────── */
function fqFlash(cb) {
  const canvas = document.getElementById('fq-ch-flash');
  if (!canvas) { if (cb) cb(); return; }
  const ctx = canvas.getContext('2d');
  canvas.width  = canvas.offsetWidth  || 800;
  canvas.height = canvas.offsetHeight || 450;
  canvas.style.opacity = '1';
  let f = 0;
  const frame = () => {
    const { width: w, height: h } = canvas;
    const img = ctx.createImageData(w, h);
    const d   = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * 255 | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (++f < 7) requestAnimationFrame(frame);
    else {
      canvas.style.transition = 'opacity .18s';
      canvas.style.opacity    = '0';
      if (cb) setTimeout(cb, 200);
    }
  };
  requestAnimationFrame(frame);
}

/* ── LIVE BUG ────────────────────────────────────────────── */
function fqShowBug() {
  const bug = document.getElementById('fq-live-bug');
  if (!bug) return;
  bug.classList.remove('fq-bug-hidden');
  clearTimeout(fqBugTimer);
  fqBugTimer = setTimeout(() => bug.classList.add('fq-bug-hidden'), 4000);
}

/* ── SELECT CHANNEL ──────────────────────────────────────── */
function fqSelectCh(idx) {
  if (idx < 0 || idx >= FQ_CHANNELS.length) return;
  fqFlash(() => {
    fqIdx = idx;
    const ch = FQ_CHANNELS[idx];
    fqStopNS();
    fqUpdateNP();
    fqUpdateGuideActive();
    fqShowBug();
    if (!ch.videoIds.length && !ch.liveStreamVideoId && !ch.playlistId) {
      fqShowNoSig();
      return;
    }
    if (fqReady) fqLoadSyncedVideo();
  });
}

function fqUpdateNP() {
  if (fqIdx < 0) return;
  const ch  = FQ_CHANNELS[fqIdx];
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || ''; };

  set('fq-np-num',   `CH ${ch.number}`);
  set('fq-np-name',  ch.name);
  set('fq-np-host',  ch.host);
  set('fq-np-block', fqBlock?.name ?? '');
  set('fq-np-title', '');
  set('fq-st-ch',    `CH ${ch.number}`);
  set('fq-st-block', fqBlock?.name ?? '');
  set('fq-live-ch',  `CH ${ch.number}`);
  set('fq-live-name', ch.name);
  set('fq-live-host', ch.host);

  // Info panel
  set('fq-info-ch',   `CH ${ch.number}`);
  set('fq-info-name', ch.name);
  set('fq-info-host', ch.host);
  set('fq-info-desc', ch.desc);
  set('fq-info-title', '');

  // Website link
  const siteBtn = document.getElementById('fq-ch-site-btn');
  if (siteBtn) {
    siteBtn.style.display = ch.website ? 'block' : 'none';
    if (ch.website) siteBtn.href = ch.website;
  }

  // Mobile header
  const mbCh = document.getElementById('fq-mb-ch');
  if (mbCh) mbCh.textContent = `CH ${ch.number} · ${ch.name}`;
}

function fqUpdateGuideActive() {
  const items = document.querySelectorAll('#fq-guide-list .fq-ch-item');
  items.forEach(el => {
    el.classList.toggle('fq-active', parseInt(el.dataset.idx, 10) === fqIdx);
  });
  const active = document.querySelector('#fq-guide-list .fq-ch-item.fq-active');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function fqPrevCh() { fqSelectCh(fqIdx <= 0 ? FQ_CHANNELS.length - 1 : fqIdx - 1); }
function fqNextCh() { fqSelectCh((fqIdx + 1) % FQ_CHANNELS.length); }

function fqAutoTune() {
  if (!fqBlock) fqBlock = fqGetBlock();
  const ready = ch => ch.videoIds.length || ch.liveStreamVideoId || ch.playlistId;
  let pool = FQ_CHANNELS.filter(ch => ch.category === fqBlock.cat && ready(ch));
  if (!pool.length) pool = FQ_CHANNELS.filter(ready);
  if (!pool.length) pool = FQ_CHANNELS;
  fqSelectCh(FQ_CHANNELS.indexOf(pool[Math.floor(Math.random() * pool.length)]));
}

/* ── MUTE ────────────────────────────────────────────────── */
function fqSyncMuteUI() {
  const label = fqMuted ? '🔇 UNMUTE' : '🔊 MUTE';
  const btn1  = document.getElementById('fq-mute-btn');
  const btn2  = document.getElementById('fq-mc-mute');
  if (btn1) btn1.textContent = label;
  if (btn2) btn2.textContent = label;
}

function fqToggleMute() {
  if (!fqReady) return;
  if (!fqUnlocked) { fqHandleTap(); return; }
  fqMuted = !fqMuted;
  fqMuted ? fqPlayer.mute() : fqPlayer.unMute();
  fqSyncMuteUI();
}

/* ── INFO ────────────────────────────────────────────────── */
function fqShowInfo() {
  if (fqIdx < 0) return;
  const ch = FQ_CHANNELS[fqIdx];
  alert(`CH ${ch.number} — ${ch.name}\n${ch.host}\n\n${ch.desc}\n\n${ch.type} · ${(ch.vibe || '').toUpperCase()}`);
}

/* ── FULLSCREEN ──────────────────────────────────────────── */
function fqToggleAppFullscreen() {
  const wrap = document.getElementById('frequency-wrapper');
  if (!document.fullscreenElement) {
    (wrap.requestFullscreen || wrap.webkitRequestFullscreen)?.call(wrap);
    wrap.classList.add('fq-is-fullscreen');
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  }
}

document.addEventListener('fullscreenchange', () => {
  const wrap = document.getElementById('frequency-wrapper');
  if (wrap) wrap.classList.toggle('fq-is-fullscreen', !!document.fullscreenElement);
});

function fqVideoFullscreen() {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (isMobile) {
    try {
      const iframe = document.querySelector('#fq-yt-player iframe');
      if (iframe) {
        try {
          const iDoc = iframe.contentDocument || iframe.contentWindow.document;
          const vid  = iDoc.querySelector('video');
          if (vid?.webkitEnterFullscreen) { vid.webkitEnterFullscreen(); return; }
          if (vid?.requestFullscreen)     { vid.requestFullscreen();     return; }
        } catch (corsErr) {}
        if (iframe.requestFullscreen) { iframe.requestFullscreen(); return; }
      }
    } catch (e) {}
    const sw = document.getElementById('fq-screen-wrap');
    (sw.requestFullscreen || sw.webkitRequestFullscreen)?.call(sw);
    return;
  }
  const target = document.getElementById('fq-screen-wrap');
  if (!document.fullscreenElement) {
    (target.requestFullscreen || target.webkitRequestFullscreen)?.call(target);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  }
}

/* ── SHARE ───────────────────────────────────────────────── */
function fqShare() {
  const url  = window.location.href;
  const text = 'Tuning in to The Frequency — Real faith. Real people. Real talk. No static.';
  if (navigator.share) {
    navigator.share({ title: 'The Frequency', text, url }).catch(() => {});
    return;
  }
  navigator.clipboard?.writeText(url).then(() => {
    const toast = document.getElementById('fq-share-toast');
    if (toast) { toast.classList.add('fq-toast-show'); setTimeout(() => toast.classList.remove('fq-toast-show'), 2500); }
  }).catch(() => { prompt('Copy this link to share:', url); });
}

/* ── NAME / CHAT ─────────────────────────────────────────── */
function fqSaveName() {
  const inp  = document.getElementById('fq-name-inp');
  const name = inp?.value.trim();
  if (!name) return;
  fqUserName = name.toUpperCase();
  try { localStorage.setItem('fq_username', fqUserName); } catch (e) {}
  document.getElementById('fq-name-overlay').style.display = 'none';
}

function fqSkipName() {
  const names = ['KingdomKid','GraceWalker','FaithFull','Remnant_99','Overcomer','Pilgrim'];
  fqUserName  = names[Math.floor(Math.random() * names.length)];
  document.getElementById('fq-name-overlay').style.display = 'none';
}

function fqInitName() {
  try {
    const stored = localStorage.getItem('fq_username');
    if (stored) { fqUserName = stored; return; }
  } catch (e) {}
  // Name overlay is optional — only show once
  setTimeout(() => {
    const overlay = document.getElementById('fq-name-overlay');
    if (overlay) overlay.style.display = 'flex';
    const inp = document.getElementById('fq-name-inp');
    if (inp) {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') fqSaveName(); });
      inp.focus();
    }
  }, 900);
}

/* ── CATEGORY FILTER ─────────────────────────────────────── */
function fqInitCatTabs() {
  const tabs = document.getElementById('fq-cat-tabs');
  if (!tabs) return;
  tabs.addEventListener('click', e => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    tabs.querySelectorAll('.fq-cat-tab').forEach(t => t.classList.remove('is-active'));
    btn.classList.add('is-active');
    fqActiveCat = btn.dataset.cat;
    fqRenderGuide();
  });
}

/* ── GUIDE RENDER ────────────────────────────────────────── */
function fqGetChannelIcon(ch) {
  const icons = {
    PODCAST:   '🎙',
    CHURCH:    '⛪',
    TEACHING:  '📖',
    APOLOGETICS: '🛡',
    EDUCATION: '📚',
    HISTORY:   '🏛',
    MUSIC:     '🎵',
    AMBIENT:   '🌊',
    COMEDY:    '😄',
    CATHOLIC:  '✝',
  };
  return icons[ch.type] || '📺';
}

function fqRenderGuide() {
  const list = document.getElementById('fq-guide-list');
  if (!list) return;
  list.innerHTML = '';

  const visible = fqActiveCat === 'all'
    ? FQ_CHANNELS
    : FQ_CHANNELS.filter(ch => ch.category === fqActiveCat);

  visible.forEach(ch => {
    const i      = FQ_CHANNELS.indexOf(ch);
    const isLive = ch.isLive || ch.liveStreamVideoId;
    const hasContent = ch.videoIds.length || ch.liveStreamVideoId || ch.playlistId;

    const el     = document.createElement('div');
    el.className = `fq-ch-item${i === fqIdx ? ' fq-active' : ''}${!hasContent ? ' fq-ch-pending' : ''}`;
    el.dataset.idx = i;

    const thumb = ch.thumbUrl
      ? `<img class="fq-ch-thumb" src="${ch.thumbUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<div class="fq-ch-ph" style="display:none">${fqGetChannelIcon(ch)}</div>`
      : `<div class="fq-ch-ph">${fqGetChannelIcon(ch)}</div>`;

    el.innerHTML = `
      <span class="fq-ch-num">${ch.number}</span>
      <div class="fq-ch-thumb-wrap">${thumb}</div>
      <div class="fq-ch-info">
        <div class="fq-ch-name">${ch.name}</div>
        <span class="fq-ch-host">${ch.host || ''}</span>
        <div class="fq-ch-meta">
          <span class="fq-ch-type">${ch.type}</span>
          ${isLive ? '<span class="fq-ch-live">● LIVE</span>' : ''}
        </div>
      </div>`;

    el.addEventListener('click', () => fqSelectCh(i));
    list.appendChild(el);
  });
}

/* ── KEYBOARD ────────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  if (document.activeElement === document.getElementById('fq-name-inp')) return;
  switch (e.key) {
    case 'ArrowUp':    e.preventDefault(); fqPrevCh();          break;
    case 'ArrowDown':  e.preventDefault(); fqNextCh();          break;
    case 'ArrowLeft':  e.preventDefault(); fqPrevVid();         break;
    case 'ArrowRight': e.preventDefault(); fqNextVid();         break;
    case 'i': case 'I': fqShowInfo();      break;
    case 'm': case 'M': fqToggleMute();    break;
    case 'a': case 'A': fqAutoTune();      break;
    case 'f': case 'F': fqVideoFullscreen(); break;
  }
});

/* ── BOOT SEQUENCE ───────────────────────────────────────── */
const fqSleep = ms => new Promise(r => setTimeout(r, ms));
let fqBootStaticId = null;

function fqStartBootStatic(canvas) {
  const ctx     = canvas.getContext('2d');
  canvas.width  = canvas.offsetWidth  || 500;
  canvas.height = canvas.offsetHeight || 350;
  canvas.style.opacity = '1';
  const frame = () => {
    const { width: w, height: h } = canvas;
    const img = ctx.createImageData(w, h);
    const d   = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * 255 | 0;
      d[i] = d[i+1] = d[i+2] = v;
      d[i+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  };
  fqBootStaticId = setInterval(frame, 40);
}

function fqStopBootStatic() { clearInterval(fqBootStaticId); fqBootStaticId = null; }

function fqPlayStaticAudio() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const dur  = 1.4;
    const buf  = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src  = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + dur);
    src.connect(gain); gain.connect(ctx.destination);
    src.start(); src.stop(ctx.currentTime + dur);
  } catch (e) {}
}

async function fqRunBoot() {
  const overlay = document.getElementById('freq-boot-overlay');
  const line    = document.getElementById('fq-boot-line');
  const canvas  = document.getElementById('fq-static-canvas');
  const txt     = document.getElementById('fq-boot-text');

  fqPlayStaticAudio();
  await fqSleep(250);
  if (line) line.style.opacity = '1';
  await fqSleep(70);
  if (line) { line.style.transition = 'height .85s cubic-bezier(.2,.8,.3,1)'; line.style.height = '100%'; }
  await fqSleep(340);
  if (canvas) fqStartBootStatic(canvas);
  await fqSleep(850);
  if (txt) { txt.style.transition = 'opacity .28s'; txt.style.opacity = '1'; }
  await fqSleep(550);
  if (txt) txt.style.opacity = '0';
  fqStopBootStatic();
  if (canvas) { canvas.style.transition = 'opacity .4s'; canvas.style.opacity = '0'; }
  if (line)   { line.style.transition   = 'opacity .3s'; line.style.opacity   = '0'; }
  await fqSleep(300);
  if (overlay) overlay.style.opacity = '0';
  await fqSleep(550);
  if (overlay) overlay.style.display = 'none';
  fqInitApp();
}

/* ── INIT ────────────────────────────────────────────────── */
async function fqInitApp() {
  fqBlock = fqGetBlock();

  // Clear stale cache on version bump
  try {
    if (localStorage.getItem('fq_version') !== FQ_VERSION) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith('fq_')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
      localStorage.setItem('fq_version', FQ_VERSION);
    }
  } catch (e) {}

  fqInitCatTabs();
  fqRenderGuide();
  fqInitName();

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || ''; };
  set('fq-guide-block', fqBlock.name);
  set('fq-np-block',    fqBlock.name);
  set('fq-st-block',    fqBlock.name);

  // Boot on channel 01
  fqIdx = 0;
  fqUpdateNP();
  fqUpdateGuideActive();
  fqShowBug();
  fqShowNoSig();

  fqLoadYTAPI();
  fqPopulateQueues();
}

function fqStartOnce() {
  if (window.__fqStarted) return;
  window.__fqStarted = true;
  fqRunBoot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', fqStartOnce);
} else {
  setTimeout(fqStartOnce, 50);
}
