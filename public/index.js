const urlInput = document.getElementById('url');
const submitBtn = document.getElementById('submit');
const statusEl = document.getElementById('status');
const libraryListEl = document.getElementById('library-list');
const searchInput = document.getElementById('search');

let libraryItems = [];

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', !!isError);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(sec) {
  if (!sec) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

// 按博主分组渲染；同组内按添加时间倒序（接口已排序）
function renderLibrary(items) {
  if (!items.length) {
    libraryListEl.innerHTML =
      '<div class="empty">还没有视频。在上面粘贴一个 YouTube 链接开始吧。</div>';
    return;
  }

  const groups = new Map();
  for (const item of items) {
    const key = item.channel || '未知博主';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  libraryListEl.innerHTML = [...groups.entries()]
    .map(([channel, videos]) => {
      const rows = videos
        .map((v) => {
          const parts = [];
          if (v.duration) parts.push(formatDuration(v.duration));
          parts.push(`${v.sentenceCount} 句`);
          parts.push(`${v.vocabCount} 个重点词`);
          const local = v.hasLocalVideo ? '<span class="badge">本地视频</span>' : '';
          return `<a class="video-item" href="/watch?v=${encodeURIComponent(v.id)}">
            <div class="vtitle">${escapeHtml(v.title)}</div>
            <div class="meta"><span>${parts.join(' · ')}</span>${local}</div>
          </a>`;
        })
        .join('');
      return `<div class="channel-group">
        <div class="channel-name">${escapeHtml(channel)}（${videos.length}）</div>
        ${rows}
      </div>`;
    })
    .join('');
}

function applySearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return renderLibrary(libraryItems);
  renderLibrary(
    libraryItems.filter(
      (v) =>
        v.title.toLowerCase().includes(q) || (v.channel || '').toLowerCase().includes(q)
    )
  );
}

// 双模式：本地跑在 Node 服务上走 /api/library；部署到云端（纯静态）时
// 接口不存在，自动降级读 manifest.json，并隐藏"生成"功能（生成只能在电脑上做）
async function loadLibrary() {
  let data = null;
  try {
    const res = await fetch('/api/library');
    if (res.ok) data = await res.json();
  } catch {
    // 静态托管上会走到这里
  }
  if (!data || !data.ok) {
    document.body.classList.add('static-mode');
    try {
      const res = await fetch('manifest.json');
      data = await res.json();
    } catch {
      data = null;
    }
  }
  if (!data || !data.ok) {
    libraryListEl.innerHTML = '<div class="empty">视频库加载失败</div>';
    return;
  }
  libraryItems = data.items;
  applySearch();
}

async function submit() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus('请先粘贴一个 YouTube 链接', true);
    return;
  }
  submitBtn.disabled = true;
  setStatus('正在获取字幕并翻译，可能需要几十秒…');

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || '生成失败');
    }
    window.location.href = `/watch?v=${data.id}`;
  } catch (err) {
    setStatus(err.message, true);
    submitBtn.disabled = false;
  }
}

submitBtn.addEventListener('click', submit);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});
searchInput.addEventListener('input', applySearch);

// ---------- 批量缓存一个博主 ----------
const batchUrlInput = document.getElementById('batch-url');
const batchLimitInput = document.getElementById('batch-limit');
const batchStartBtn = document.getElementById('batch-start');
const batchProgressEl = document.getElementById('batch-progress');
const batchBarFill = document.getElementById('batch-bar-fill');
const batchTextEl = document.getElementById('batch-text');
const batchFailsEl = document.getElementById('batch-fails');
const batchStopBtn = document.getElementById('batch-stop');

let batchTimer = null;
let batchLastDone = -1;

function renderBatch(job) {
  if (!job) return;
  batchProgressEl.style.display = 'block';
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  batchBarFill.style.width = `${pct}%`;

  if (job.running) {
    batchStartBtn.disabled = true;
    batchStopBtn.style.display = '';
    const cur = job.current ? `正在处理：${job.current}` : '正在获取…';
    batchTextEl.textContent = `${job.channel || ''} · ${job.done}/${job.total} · ${cur}${
      job.cancelled ? '（取消中，本条完成后停止）' : ''
    }`;
  } else {
    batchStartBtn.disabled = false;
    batchStopBtn.style.display = 'none';
    batchTextEl.textContent = `${job.channel || ''} · 完成：新增 ${job.okCount}，已有跳过 ${job.skipped}，失败 ${
      job.failed.length
    }${job.cancelled ? '（已取消剩余）' : ''}`;
  }

  batchFailsEl.innerHTML = (job.failed || [])
    .map((f) => `<div>✕ ${escapeHtml(f.title)}：${escapeHtml(f.error || '')}</div>`)
    .join('');

  // 每完成一个视频就刷新一次视频库，新学习页立刻可点
  if (job.done !== batchLastDone) {
    batchLastDone = job.done;
    loadLibrary();
  }
}

async function pollBatch() {
  try {
    const res = await fetch('/api/batch/status');
    const data = await res.json();
    if (!data.ok || !data.job) return stopPolling();
    renderBatch(data.job);
    if (!data.job.running) stopPolling();
  } catch {
    stopPolling();
  }
}

function startPolling() {
  if (batchTimer) return;
  batchTimer = setInterval(pollBatch, 2000);
}

function stopPolling() {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }
}

async function startBatch() {
  const url = batchUrlInput.value.trim();
  if (!url) {
    batchProgressEl.style.display = 'block';
    batchTextEl.textContent = '请先粘贴博主主页或视频链接';
    return;
  }
  batchStartBtn.disabled = true;
  batchProgressEl.style.display = 'block';
  batchBarFill.style.width = '0%';
  batchFailsEl.innerHTML = '';
  batchLastDone = -1;
  batchTextEl.textContent = '正在获取频道视频列表…（十几秒）';

  try {
    const res = await fetch('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, limit: parseInt(batchLimitInput.value, 10) || 10 }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || '批量任务启动失败');
    renderBatch(data.job);
    startPolling();
  } catch (err) {
    batchTextEl.textContent = err.message;
    batchStartBtn.disabled = false;
  }
}

batchStartBtn?.addEventListener('click', startBatch);
batchUrlInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startBatch();
});
batchStopBtn?.addEventListener('click', async () => {
  try {
    await fetch('/api/batch/stop', { method: 'POST' });
  } catch {}
});

// 页面打开时如果后台还有批量任务在跑（比如中途关过页面），接着显示进度
(async () => {
  try {
    const res = await fetch('/api/batch/status');
    const data = await res.json();
    if (data.ok && data.job) {
      renderBatch(data.job);
      if (data.job.running) startPolling();
    }
  } catch {
    // 云端静态版没有这个接口，忽略
  }
})();

loadLibrary();
