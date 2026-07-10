let player = null;
let sentences = [];
let vocab = [];
let activeIndex = -1;
let flashTimer = null;
let videoIdGlobal = null;

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const vocabListEl = document.getElementById('vocab-list');
const titleEl = document.getElementById('title');
const revocabBtn = document.getElementById('revocab');
const speedSel = document.getElementById('speed');

function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 去掉词首尾的标点，用于生词匹配（"house," 也能匹配 "house"）
function normWord(w) {
  return w.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
}

// 把句子变成带时间戳的词数组。新数据自带 words（按字幕块插值），
// 旧缓存没有 words 时按句长线性插值估算
function sentenceWords(s, nextStart) {
  if (s.words && s.words.length) return s.words;
  const tokens = s.text.split(/\s+/).filter(Boolean);
  const end = nextStart != null ? nextStart : s.start + Math.max(2, tokens.length * 0.45);
  const step = (end - s.start) / Math.max(1, tokens.length);
  return tokens.map((w, i) => ({ w, t: s.start + i * step }));
}

// 逐词渲染：每个词一个 span 带时间戳；生词（可以是多词搭配）在词级别打标
function renderSentenceEn(words, vocabItems) {
  const norms = words.map((x) => normWord(x.w));
  const marks = new Array(words.length).fill(null);

  for (const item of vocabItems || []) {
    const termTokens = item.term.split(/\s+/).map(normWord).filter(Boolean);
    if (!termTokens.length) continue;
    for (let i = 0; i + termTokens.length <= words.length; i++) {
      let ok = true;
      for (let j = 0; j < termTokens.length; j++) {
        if (norms[i + j] !== termTokens[j]) { ok = false; break; }
      }
      if (ok) {
        for (let j = 0; j < termTokens.length; j++) marks[i + j] = item;
        break;
      }
    }
  }

  return words
    .map((x, i) => {
      const cls = marks[i] ? 'w vocab-hl' : 'w';
      const title = marks[i] ? ` title="${escapeHtml(marks[i].zh || '')}"` : '';
      return `<span class="${cls}" data-t="${x.t.toFixed(2)}"${title}>${escapeHtml(x.w)}</span>`;
    })
    .join(' ');
}

function renderTranscript() {
  const vocabBySentence = {};
  vocab.forEach((v) => {
    (vocabBySentence[v.sentenceIndex] = vocabBySentence[v.sentenceIndex] || []).push(v);
  });

  transcriptEl.innerHTML = sentences
    .map((s, i) => {
      const next = sentences[i + 1];
      const words = sentenceWords(s, next ? next.start : null);
      const enHtml = renderSentenceEn(words, vocabBySentence[s.index]);
      const zhHtml = escapeHtml(s.zh || '');
      return `<div class="line" data-index="${s.index}" data-start="${s.start}">
        <div class="en">${enHtml}</div>
        <div class="zh">${zhHtml}</div>
      </div>`;
    })
    .join('');

  transcriptEl.querySelectorAll('.line').forEach((el) => {
    el.addEventListener('click', () => {
      playerSeek(parseFloat(el.dataset.start));
    });
  });
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

function renderVocab() {
  vocabListEl.innerHTML = vocab
    .map((v, i) => {
      const sentence = sentences[v.sentenceIndex];
      const time = sentence ? formatTime(sentence.start) : '';
      const level = v.level ? `<span class="level">${escapeHtml(v.level)}</span>` : '';
      return `<li data-index="${i}" data-sentence="${v.sentenceIndex}">
        <div class="term">${escapeHtml(v.term)}${level}</div>
        <div class="zh">${escapeHtml(v.zh || '')}<span class="time">${time}</span></div>
      </li>`;
    })
    .join('');

  vocabLis = [...vocabListEl.querySelectorAll('li')];
  vocabLis.forEach((li) => {
    li._sentence = parseInt(li.dataset.sentence, 10);
    li.addEventListener('click', () => jumpToSentence(li._sentence));
  });
}

// 只滚动容器内部，避免把整个页面滚走（保证视频始终可见）
function scrollWithin(container, el) {
  container.scrollTo({
    top: el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2,
    behavior: 'smooth',
  });
}

function jumpToSentence(index) {
  const lineEl = transcriptEl.querySelector(`.line[data-index="${index}"]`);
  if (!lineEl) return;
  scrollWithin(transcriptEl, lineEl);
  lineEl.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => lineEl.classList.remove('flash'), 1200);

  playerSeek(parseFloat(lineEl.dataset.start));
}

// 当前句内的逐词高亮状态
let activeWordEls = [];
let activeWordTimes = [];
let activeWordIdx = -1;

function setActiveLine(index) {
  if (index === activeIndex) return;
  const prev = transcriptEl.querySelector('.line.active');
  if (prev) {
    prev.classList.remove('active');
    const cur = prev.querySelector('.w.current');
    if (cur) cur.classList.remove('current');
  }
  const next = transcriptEl.querySelector(`.line[data-index="${index}"]`);
  if (next) {
    next.classList.add('active');
    scrollWithin(transcriptEl, next);
    activeWordEls = [...next.querySelectorAll('.w')];
    activeWordTimes = activeWordEls.map((el) => parseFloat(el.dataset.t));
    activeWordIdx = -1;
  }
  activeIndex = index;
  updateVocabHighlight(index);
}

function syncWordHighlight(t) {
  if (!activeWordEls.length) return;
  let idx = -1;
  for (let i = 0; i < activeWordTimes.length; i++) {
    if (activeWordTimes[i] <= t) idx = i;
    else break;
  }
  if (idx === activeWordIdx) return;
  if (activeWordIdx >= 0 && activeWordEls[activeWordIdx]) {
    activeWordEls[activeWordIdx].classList.remove('current');
  }
  if (idx >= 0) activeWordEls[idx].classList.add('current');
  activeWordIdx = idx;
}

// 播放到含重点词的句子时，右侧词表实时高亮并滚动跟随。
// 只做增量 class 变更，避免每次全量刷新几百个节点
let vocabLis = [];
let prevNowLis = [];
let prevLatestLi = null;

function updateVocabHighlight(index) {
  prevNowLis.forEach((li) => li.classList.remove('now'));
  prevNowLis = vocabLis.filter((li) => li._sentence === index);
  prevNowLis.forEach((li) => li.classList.add('now'));

  let latestLi = null;
  for (const li of vocabLis) {
    if (li._sentence <= index) latestLi = li;
    else break;
  }
  if (latestLi && latestLi !== prevLatestLi) {
    prevLatestLi = latestLi;
    const sidebarEl = vocabListEl.closest('.sidebar');
    if (sidebarEl) scrollWithin(sidebarEl, latestLi);
  }
}

// 播放器抽象：优先本地/云端视频文件（不需要梯子），没有时退回 YouTube 在线播放器
let html5Video = null;

function playerCurrentTime() {
  if (html5Video) return html5Video.currentTime;
  if (player && typeof player.getCurrentTime === 'function') return player.getCurrentTime();
  return null;
}

function playerSeek(t) {
  if (html5Video) {
    html5Video.currentTime = t;
    html5Video.play();
    return;
  }
  if (player && player.seekTo) {
    player.seekTo(t, true);
    player.playVideo();
  }
}

function playerPause() {
  if (html5Video) html5Video.pause();
  else if (player && player.pauseVideo) player.pauseVideo();
}

function isPlaying() {
  if (html5Video) return !html5Video.paused && !html5Video.ended;
  return !!(player && typeof player.getPlayerState === 'function' && player.getPlayerState() === 1);
}

function setPlaybackSpeed(v) {
  if (html5Video) html5Video.playbackRate = v;
  else if (player && player.setPlaybackRate) player.setPlaybackRate(v);
}

// 跟读练习状态
let loopOne = false;
let autoPause = false;
let lastAutoPausedAt = -1;

function syncTranscript() {
  if (!sentences.length) return;
  const t = playerCurrentTime();
  if (t == null) return;

  // 单句循环：播过当前句结尾就跳回句首继续磨这一句
  if (loopOne && activeIndex >= 0) {
    const next = sentences[activeIndex + 1];
    if (next && t >= next.start) {
      playerSeek(sentences[activeIndex].start);
      return;
    }
  }

  let idx = -1;
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].start <= t) idx = sentences[i].index;
    else break;
  }

  // 逐句暂停：一句播完的瞬间自动停，高亮留在刚播完那句，方便跟读；
  // 再按播放继续下一句（每个句界只停一次）
  if (autoPause && activeIndex >= 0 && idx > activeIndex && lastAutoPausedAt !== activeIndex && isPlaying()) {
    playerPause();
    lastAutoPausedAt = activeIndex;
    return;
  }

  if (idx >= 0) setActiveLine(idx);
  syncWordHighlight(t);
}

function createYtPlayer(videoId) {
  player = new YT.Player('player', {
    videoId,
    playerVars: { rel: 0 },
    events: {
      onReady: () => {
        setPlaybackSpeed(parseFloat(speedSel.value));
        setInterval(syncTranscript, 150);
      },
    },
  });
}

function initPlayer(videoId, videoUrl) {
  if (videoUrl) {
    const wrap = document.querySelector('.player-wrap');
    wrap.innerHTML = '';
    html5Video = document.createElement('video');
    html5Video.controls = true;
    html5Video.playsInline = true;
    html5Video.preload = 'metadata';
    wrap.appendChild(html5Video);

    if (videoUrl.endsWith('.m3u8')) {
      // HLS 切片：iPhone Safari 原生支持，其余浏览器用 hls.js
      if (html5Video.canPlayType('application/vnd.apple.mpegurl')) {
        html5Video.src = videoUrl;
      } else if (window.Hls && Hls.isSupported()) {
        // 多缓冲一些，点句子跳转时更可能已经在缓冲里，跳转更快
        const hls = new Hls({ maxBufferLength: 60, backBufferLength: 60 });
        hls.loadSource(videoUrl);
        hls.attachMedia(html5Video);
      } else {
        setStatus('当前浏览器不支持视频播放', true);
      }
    } else {
      html5Video.src = videoUrl;
    }
    html5Video.preload = 'auto';
    html5Video.playbackRate = parseFloat(speedSel.value);
    setInterval(syncTranscript, 150);
    return;
  }

  if (window.YT && window.YT.Player) {
    createYtPlayer(videoId);
  } else {
    window.onYouTubeIframeAPIReady = () => createYtPlayer(videoId);
  }
}

function applyData(data) {
  titleEl.textContent = data.title;
  sentences = data.sentences;
  vocab = data.vocab;
  activeIndex = -1;
  activeWordEls = [];
  activeWordTimes = [];
  activeWordIdx = -1;
  prevNowLis = [];
  prevLatestLi = null;
  renderTranscript();
  renderVocab();
}

async function loadData() {
  const params = new URLSearchParams(location.search);
  const id = params.get('v');
  if (!id) {
    setStatus('缺少视频参数', true);
    return;
  }
  videoIdGlobal = id;

  setStatus('加载中…');
  try {
    // 双模式：本地走 /api，云端静态托管时降级读 data/<id>.json
    let data = null;
    try {
      const res = await fetch(`/api/video/${id}`);
      if (res.ok) data = await res.json();
    } catch {
      // 静态托管上会走到这里
    }
    if (!data || !data.ok) {
      revocabBtn.hidden = true; // 重新提取需要服务器和 API，云端不可用
      const res = await fetch(`data/${id}.json`);
      if (!res.ok) throw new Error('未找到该视频的学习数据');
      data = await res.json();
    }

    applyData(data);
    setStatus('');
    initPlayer(id, data.videoUrl || null);
  } catch (err) {
    setStatus(err.message, true);
  }
}

revocabBtn.addEventListener('click', async () => {
  if (!videoIdGlobal) return;
  revocabBtn.disabled = true;
  setStatus('正在用更严格的标准重新挑选生词，约需 1-2 分钟…');
  try {
    const res = await fetch(`/api/revocab/${videoIdGlobal}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || '重新提取失败');
    applyData(data);
    setStatus('生词已更新 ✓');
    setTimeout(() => setStatus(''), 3000);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    revocabBtn.disabled = false;
  }
});

document.getElementById('toggle-zh').addEventListener('change', (e) => {
  document.body.classList.toggle('hide-zh', !e.target.checked);
});
document.getElementById('toggle-vocab').addEventListener('change', (e) => {
  document.body.classList.toggle('hide-vocab', !e.target.checked);
});

// 练习工具条
speedSel.addEventListener('change', () => setPlaybackSpeed(parseFloat(speedSel.value)));
document.getElementById('replay').addEventListener('click', () => {
  if (activeIndex >= 0 && sentences[activeIndex]) playerSeek(sentences[activeIndex].start);
});
document.getElementById('loop-one').addEventListener('change', (e) => {
  loopOne = e.target.checked;
});
document.getElementById('auto-pause').addEventListener('change', (e) => {
  autoPause = e.target.checked;
  lastAutoPausedAt = -1;
});
document.getElementById('cloze').addEventListener('change', (e) => {
  document.body.classList.toggle('cloze-mode', e.target.checked);
  // 退出挖空时清掉已揭晓状态，下次进入重新开始
  if (!e.target.checked) {
    transcriptEl.querySelectorAll('.vocab-hl.revealed').forEach((el) => el.classList.remove('revealed'));
  }
});
// 挖空模式下点生词 = 揭晓答案，不触发整句跳转（捕获阶段拦截）
transcriptEl.addEventListener(
  'click',
  (e) => {
    if (!document.body.classList.contains('cloze-mode')) return;
    const hl = e.target.closest('.vocab-hl');
    if (hl) {
      e.stopPropagation();
      hl.classList.toggle('revealed');
    }
  },
  true
);

// 词表开关：手机屏幕小，关掉后字幕区占满；选择记住到下次
const sidebarToggle = document.getElementById('toggle-sidebar');
if (localStorage.getItem('showSidebar') === '0') {
  sidebarToggle.checked = false;
  document.body.classList.add('hide-sidebar');
}
sidebarToggle.addEventListener('change', (e) => {
  document.body.classList.toggle('hide-sidebar', !e.target.checked);
  localStorage.setItem('showSidebar', e.target.checked ? '1' : '0');
});

loadData();
