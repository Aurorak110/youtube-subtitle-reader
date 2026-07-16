// YouTube 双语学习字幕 — 内容脚本
// 在 YouTube 观看页右侧挂一个学习面板，数据来自本地服务 localhost:4300，
// 与网页版共享同一套翻译缓存。
(() => {
  const SERVER = 'http://localhost:4300';

  let sentences = [];
  let vocab = [];
  let activeIndex = -1;
  let currentId = null;
  let loadedId = null;

  // 练习状态
  let loopOne = false;
  let autoPause = false;
  let lastAutoPausedAt = -1;

  // 当前句逐词高亮
  let activeWordEls = [];
  let activeWordTimes = [];
  let activeWordIdx = -1;

  let panel, transcriptEl, statusEl, titleEl, genBtn, vocabUlEl;
  let overlayEl, ovEnEl, ovZhEl;
  let vocabLis = [];
  let prevNowLis = [];
  let prevLatestLi = null;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normWord(w) {
    return w.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
  }

  function ytVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function currentVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('ylr-error', !!isError);
  }

  // ---------- 面板 ----------
  // 面板挂到 YouTube 右侧栏（相关视频那一列），与视频并排、同屏可见；
  // 当前句则单独叠加在视频画面上（见 overlay），看片时眼睛不用离开画面。
  function mountTarget() {
    return document.querySelector('#secondary-inner') || document.querySelector('#secondary') || null;
  }

  // 把面板放到右侧栏最上方（相关视频之上）
  function attachPanel() {
    if (!panel) return;
    const host = mountTarget();
    if (!host) return; // 页面还没渲染好，tick 会再试
    // 已经挂在右栏里就不动，避免每次 tick 重排导致闪烁/滚动跳动
    if (panel.parentNode === host) return;
    host.insertBefore(panel, host.firstChild);
  }

  // 视频画面上的当前句叠加层
  function playerContainer() {
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }
  function buildOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'ylr-overlay';
    overlayEl.innerHTML = '<div class="ylr-ov-en" id="ylr-ov-en"></div><div class="ylr-ov-zh" id="ylr-ov-zh"></div>';
    ovEnEl = overlayEl.querySelector('#ylr-ov-en');
    ovZhEl = overlayEl.querySelector('#ylr-ov-zh');
    if (localStorage.getItem('ylrShowOverlay') === '0') overlayEl.classList.add('ylr-ov-off');
    if (localStorage.getItem('ylrShowZh') === '0') overlayEl.classList.add('ylr-ov-hide-zh');
  }
  function attachOverlay() {
    if (!overlayEl) return;
    const pc = playerContainer();
    if (!pc || overlayEl.parentNode === pc) return;
    pc.appendChild(overlayEl);
  }

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'ylr-panel';
    panel.innerHTML = `
      <div id="ylr-body">
        <div class="ylr-head">
          <span class="ylr-title" id="ylr-title">双语学习字幕</span>
          <div class="ylr-controls">
            <label><input type="checkbox" id="ylr-zh" checked /> 中文</label>
            <label><input type="checkbox" id="ylr-hl" checked /> 生词</label>
            <label><input type="checkbox" id="ylr-cloze" /> 挖空</label>
            <label><input type="checkbox" id="ylr-loop" /> 单句循环</label>
            <label><input type="checkbox" id="ylr-pause" /> 逐句暂停</label>
            <label><input type="checkbox" id="ylr-vocablist" checked /> 词表</label>
            <label><input type="checkbox" id="ylr-overlay-tg" checked /> 叠加</label>
          </div>
          <button id="ylr-toggle" title="展开/收起">收起</button>
        </div>
        <div class="ylr-status" id="ylr-status"></div>
        <button id="ylr-gen" hidden>为这个视频生成学习字幕（约 1 分钟）</button>
        <div class="ylr-content">
          <div class="ylr-transcript" id="ylr-transcript"></div>
          <aside class="ylr-vocablist" id="ylr-vocablist">
            <div class="ylr-vocab-head">重点词 / 搭配</div>
            <ul id="ylr-vocab-ul"></ul>
          </aside>
        </div>
      </div>`;

    transcriptEl = panel.querySelector('#ylr-transcript');
    statusEl = panel.querySelector('#ylr-status');
    titleEl = panel.querySelector('#ylr-title');
    genBtn = panel.querySelector('#ylr-gen');
    vocabUlEl = panel.querySelector('#ylr-vocab-ul');

    buildOverlay();
    attachOverlay();

    const collapsed = localStorage.getItem('ylrCollapsed') === '1';
    panel.classList.toggle('ylr-collapsed', collapsed);

    const toggleBtn = panel.querySelector('#ylr-toggle');
    toggleBtn.textContent = collapsed ? '展开字幕' : '收起';
    toggleBtn.addEventListener('click', () => {
      const nowCollapsed = !panel.classList.contains('ylr-collapsed');
      panel.classList.toggle('ylr-collapsed', nowCollapsed);
      toggleBtn.textContent = nowCollapsed ? '展开字幕' : '收起';
      localStorage.setItem('ylrCollapsed', nowCollapsed ? '1' : '0');
    });

    attachPanel();

    panel.querySelector('#ylr-zh').addEventListener('change', (e) => {
      panel.classList.toggle('ylr-hide-zh', !e.target.checked);
      // 视频叠加层的中文也一起跟随
      if (overlayEl) overlayEl.classList.toggle('ylr-ov-hide-zh', !e.target.checked);
      localStorage.setItem('ylrShowZh', e.target.checked ? '1' : '0');
    });
    // 视频叠加开关
    const ovToggle = panel.querySelector('#ylr-overlay-tg');
    if (localStorage.getItem('ylrShowOverlay') === '0') ovToggle.checked = false;
    ovToggle.addEventListener('change', (e) => {
      if (overlayEl) overlayEl.classList.toggle('ylr-ov-off', !e.target.checked);
      localStorage.setItem('ylrShowOverlay', e.target.checked ? '1' : '0');
    });
    // 中文开关初始状态（面板与叠加层保持一致）
    if (localStorage.getItem('ylrShowZh') === '0') {
      panel.querySelector('#ylr-zh').checked = false;
      panel.classList.add('ylr-hide-zh');
      if (overlayEl) overlayEl.classList.add('ylr-ov-hide-zh');
    }
    panel.querySelector('#ylr-hl').addEventListener('change', (e) => {
      panel.classList.toggle('ylr-hide-hl', !e.target.checked);
    });
    panel.querySelector('#ylr-cloze').addEventListener('change', (e) => {
      panel.classList.toggle('ylr-cloze', e.target.checked);
      if (!e.target.checked) {
        transcriptEl.querySelectorAll('.ylr-vocab.ylr-revealed').forEach((el) =>
          el.classList.remove('ylr-revealed')
        );
      }
    });
    panel.querySelector('#ylr-loop').addEventListener('change', (e) => (loopOne = e.target.checked));
    panel.querySelector('#ylr-pause').addEventListener('change', (e) => {
      autoPause = e.target.checked;
      lastAutoPausedAt = -1;
    });

    // 词表开关：显示/隐藏右侧重点词列表，记忆到下次
    const vlToggle = panel.querySelector('#ylr-vocablist');
    if (localStorage.getItem('ylrShowVocab') === '0') {
      vlToggle.checked = false;
      panel.classList.add('ylr-hide-vocablist');
    }
    vlToggle.addEventListener('change', (e) => {
      panel.classList.toggle('ylr-hide-vocablist', !e.target.checked);
      localStorage.setItem('ylrShowVocab', e.target.checked ? '1' : '0');
    });

    genBtn.addEventListener('click', generate);

    // 挖空模式下点生词 = 揭晓，不触发跳转
    transcriptEl.addEventListener(
      'click',
      (e) => {
        if (!panel.classList.contains('ylr-cloze')) return;
        const hl = e.target.closest('.ylr-vocab');
        if (hl) {
          e.stopPropagation();
          hl.classList.toggle('ylr-revealed');
        }
      },
      true
    );
  }

  // ---------- 渲染 ----------
  function sentenceWords(s, nextStart) {
    if (s.words && s.words.length) return s.words;
    const tokens = s.text.split(/\s+/).filter(Boolean);
    const end = nextStart != null ? nextStart : s.start + Math.max(2, tokens.length * 0.45);
    const step = (end - s.start) / Math.max(1, tokens.length);
    return tokens.map((w, i) => ({ w, t: s.start + i * step }));
  }

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
        const cls = marks[i] ? 'ylr-w ylr-vocab' : 'ylr-w';
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
        return `<div class="ylr-line" data-index="${s.index}" data-start="${s.start}">
          <div class="ylr-en">${renderSentenceEn(words, vocabBySentence[s.index])}</div>
          <div class="ylr-zh">${escapeHtml(s.zh || '')}</div>
        </div>`;
      })
      .join('');

    transcriptEl.querySelectorAll('.ylr-line').forEach((el) => {
      el.addEventListener('click', () => {
        const v = ytVideo();
        if (v) {
          v.currentTime = parseFloat(el.dataset.start);
          v.play();
        }
      });
    });
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  // 更新视频画面上的当前句叠加（纯文本，保证在画面上清晰易读）
  function updateOverlay(index) {
    if (!overlayEl || !ovEnEl) return;
    const s = sentences[index];
    if (!s) return;
    ovEnEl.textContent = s.text || '';
    ovZhEl.textContent = s.zh || '';
  }

  // 右侧重点词列表：术语 + 级别标签 + 释义 + 时间戳，点击跳到该词所在句
  function renderVocab() {
    vocabUlEl.innerHTML = vocab
      .map((v, i) => {
        const sentence = sentences[v.sentenceIndex];
        const time = sentence ? formatTime(sentence.start) : '';
        const level = v.level ? `<span class="ylr-level">${escapeHtml(v.level)}</span>` : '';
        return `<li data-index="${i}" data-sentence="${v.sentenceIndex}">
          <div class="ylr-term">${escapeHtml(v.term)}${level}</div>
          <div class="ylr-vzh">${escapeHtml(v.zh || '')}<span class="ylr-time">${time}</span></div>
        </li>`;
      })
      .join('');

    vocabLis = [...vocabUlEl.querySelectorAll('li')];
    prevNowLis = [];
    prevLatestLi = null;
    vocabLis.forEach((li) => {
      li._sentence = parseInt(li.dataset.sentence, 10);
      li.addEventListener('click', () => {
        const s = sentences[li._sentence];
        const v = ytVideo();
        if (s && v) {
          v.currentTime = s.start;
          v.play();
        }
        const line = transcriptEl.querySelector(`.ylr-line[data-index="${li._sentence}"]`);
        if (line) scrollLineToTop(transcriptEl, line);
      });
    });
  }

  // 播到含重点词的句子时，右侧词表实时高亮并滚动跟随（只做增量 class 变更）
  function updateVocabHighlight(index) {
    if (!vocabLis.length) return;
    prevNowLis.forEach((li) => li.classList.remove('ylr-now'));
    prevNowLis = vocabLis.filter((li) => li._sentence === index);
    prevNowLis.forEach((li) => li.classList.add('ylr-now'));

    let latestLi = null;
    for (const li of vocabLis) {
      if (li._sentence <= index) latestLi = li;
      else break;
    }
    if (latestLi && latestLi !== prevLatestLi) {
      prevLatestLi = latestLi;
      // 滚动的是外层可滚动的 aside（position:relative），不是内层的 ul
      const aside = vocabUlEl.closest('.ylr-vocablist');
      if (aside) scrollWithin(aside, latestLi);
    }
  }

  // ---------- 同步 ----------
  function scrollWithin(container, el) {
    container.scrollTo({
      top: el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2,
      behavior: 'smooth',
    });
  }

  // 播放跟随时把当前句顶到容器最上方（紧贴视频），而不是居中
  function scrollLineToTop(container, el) {
    container.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: 'smooth' });
  }

  function setActiveLine(index) {
    if (index === activeIndex) return;
    const prev = transcriptEl.querySelector('.ylr-line.ylr-active');
    if (prev) {
      prev.classList.remove('ylr-active');
      const cur = prev.querySelector('.ylr-w.ylr-current');
      if (cur) cur.classList.remove('ylr-current');
    }
    const next = transcriptEl.querySelector(`.ylr-line[data-index="${index}"]`);
    if (next) {
      next.classList.add('ylr-active');
      scrollLineToTop(transcriptEl, next);
      activeWordEls = [...next.querySelectorAll('.ylr-w')];
      activeWordTimes = activeWordEls.map((el) => parseFloat(el.dataset.t));
      activeWordIdx = -1;
    }
    activeIndex = index;
    updateVocabHighlight(index);
    updateOverlay(index);
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
      activeWordEls[activeWordIdx].classList.remove('ylr-current');
    }
    if (idx >= 0) activeWordEls[idx].classList.add('ylr-current');
    activeWordIdx = idx;
  }

  function tick() {
    // 视频切换检测（YouTube 是单页应用，不刷新页面）
    const id = currentVideoId();
    if (id !== currentId) {
      currentId = id;
      if (id) loadForVideo(id);
      else panel && panel.classList.add('ylr-hidden');
    }

    // SPA 导航后 YouTube 会重建右栏/播放器，把面板或叠加层冲掉；补挂回去
    if (id && panel && !panel.isConnected) attachPanel();
    if (id && overlayEl && !overlayEl.isConnected) attachOverlay();

    if (!sentences.length || loadedId !== currentId) return;
    const v = ytVideo();
    if (!v) return;
    const t = v.currentTime;

    if (loopOne && activeIndex >= 0) {
      const next = sentences[activeIndex + 1];
      if (next && t >= next.start) {
        v.currentTime = sentences[activeIndex].start;
        return;
      }
    }

    let idx = -1;
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i].start <= t) idx = sentences[i].index;
      else break;
    }

    if (autoPause && activeIndex >= 0 && idx > activeIndex && lastAutoPausedAt !== activeIndex && !v.paused) {
      v.pause();
      lastAutoPausedAt = activeIndex;
      return;
    }

    if (idx >= 0) setActiveLine(idx);
    syncWordHighlight(t);
  }

  // ---------- 数据 ----------
  function applyData(data) {
    sentences = data.sentences || [];
    vocab = data.vocab || [];
    activeIndex = -1;
    activeWordEls = [];
    activeWordTimes = [];
    activeWordIdx = -1;
    lastAutoPausedAt = -1;
    loadedId = data.id;
    prevNowLis = [];
    prevLatestLi = null;
    titleEl.textContent = data.title || '双语学习字幕';
    renderTranscript();
    renderVocab();
    setStatus('');
  }

  async function loadForVideo(id) {
    buildPanel();
    attachPanel();
    attachOverlay();
    panel.classList.remove('ylr-hidden');
    sentences = [];
    vocab = [];
    transcriptEl.innerHTML = '';
    if (ovEnEl) ovEnEl.textContent = '';
    if (ovZhEl) ovZhEl.textContent = '';
    genBtn.hidden = true;
    titleEl.textContent = '双语学习字幕';
    setStatus('查询缓存…');
    try {
      const res = await fetch(`${SERVER}/api/video/${id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          applyData(data);
          return;
        }
      }
      // 没有缓存：显示生成按钮
      setStatus('这个视频还没有学习字幕');
      genBtn.hidden = false;
    } catch {
      setStatus('本地服务未启动（开机应自动启动，或双击桌面「YouTube字幕学习工具」）', true);
    }
  }

  async function generate() {
    const id = currentId;
    if (!id) return;
    genBtn.hidden = true;
    setStatus('正在抓取字幕并翻译，长视频可能要几分钟，可以先继续看…');
    try {
      const res = await fetch(`${SERVER}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}` }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '生成失败');
      if (currentId === id) applyData(data);
    } catch (err) {
      setStatus(err.message, true);
      genBtn.hidden = false;
    }
  }

  // ---------- 启动 ----------
  buildPanel();
  panel.classList.add('ylr-hidden');
  setInterval(tick, 200);
})();
