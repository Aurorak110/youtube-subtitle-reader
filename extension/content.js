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

  let panel, transcriptEl, statusEl, titleEl, genBtn;

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
  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'ylr-panel';
    panel.innerHTML = `
      <button id="ylr-tab" title="双语学习字幕">译</button>
      <div id="ylr-body">
        <div class="ylr-head">
          <span class="ylr-title" id="ylr-title">双语学习字幕</span>
          <button id="ylr-close" title="收起">×</button>
        </div>
        <div class="ylr-controls">
          <label><input type="checkbox" id="ylr-zh" checked /> 中文</label>
          <label><input type="checkbox" id="ylr-hl" checked /> 生词</label>
          <label><input type="checkbox" id="ylr-cloze" /> 挖空</label>
          <label><input type="checkbox" id="ylr-loop" /> 单句循环</label>
          <label><input type="checkbox" id="ylr-pause" /> 逐句暂停</label>
        </div>
        <div class="ylr-status" id="ylr-status"></div>
        <button id="ylr-gen" hidden>为这个视频生成学习字幕（约 1 分钟）</button>
        <div class="ylr-transcript" id="ylr-transcript"></div>
      </div>`;
    document.documentElement.appendChild(panel);

    transcriptEl = panel.querySelector('#ylr-transcript');
    statusEl = panel.querySelector('#ylr-status');
    titleEl = panel.querySelector('#ylr-title');
    genBtn = panel.querySelector('#ylr-gen');

    const collapsed = localStorage.getItem('ylrCollapsed') === '1';
    panel.classList.toggle('ylr-collapsed', collapsed);

    panel.querySelector('#ylr-tab').addEventListener('click', () => {
      panel.classList.remove('ylr-collapsed');
      localStorage.setItem('ylrCollapsed', '0');
    });
    panel.querySelector('#ylr-close').addEventListener('click', () => {
      panel.classList.add('ylr-collapsed');
      localStorage.setItem('ylrCollapsed', '1');
    });

    panel.querySelector('#ylr-zh').addEventListener('change', (e) => {
      panel.classList.toggle('ylr-hide-zh', !e.target.checked);
    });
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

  // ---------- 同步 ----------
  function scrollWithin(container, el) {
    container.scrollTo({
      top: el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2,
      behavior: 'smooth',
    });
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
      scrollWithin(transcriptEl, next);
      activeWordEls = [...next.querySelectorAll('.ylr-w')];
      activeWordTimes = activeWordEls.map((el) => parseFloat(el.dataset.t));
      activeWordIdx = -1;
    }
    activeIndex = index;
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
    titleEl.textContent = data.title || '双语学习字幕';
    renderTranscript();
    setStatus('');
  }

  async function loadForVideo(id) {
    buildPanel();
    panel.classList.remove('ylr-hidden');
    sentences = [];
    vocab = [];
    transcriptEl.innerHTML = '';
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
