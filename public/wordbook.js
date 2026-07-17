const searchInput = document.getElementById('search');
const analyzeBtn = document.getElementById('analyze-btn');
const analyzeStatus = document.getElementById('analyze-status');
const listEl = document.getElementById('list');
const countLine = document.getElementById('count-line');
const filtersEl = document.getElementById('filters');

let items = [];
let medicalTotal = 0;
let medicalAnalyzed = 0;
let activeFilter = 'all';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TYPE_CLASS = { 前缀: 'p-prefix', 词根: 'p-root', 后缀: 'p-suffix', 连接元音: 'p-vowel' };

function renderPieces(parts) {
  return parts
    .map((p, i) => {
      const cls = TYPE_CLASS[p.type] || 'p-root';
      const plus = i > 0 ? '<span class="plus">+</span>' : '';
      return `${plus}<span class="piece ${cls}">
        <span class="p-txt">${escapeHtml(p.piece)}</span>
        <span class="p-mean">${escapeHtml(p.meaning || '')}</span>
        <span class="p-type">${escapeHtml(p.type || '')}</span>
      </span>`;
    })
    .join('');
}

function renderMorph(item) {
  const m = item.morph;
  const isMedical = item.level === '医学' || item.level === '术语';
  if (m && m.parts && m.parts.length) {
    const literal = m.literal
      ? `<div class="literal">字面直译：<b>${escapeHtml(m.literal)}</b></div>`
      : '';
    return `<div class="morph"><div class="pieces">${renderPieces(m.parts)}</div>${literal}</div>`;
  }
  if (m && (!m.parts || !m.parts.length)) {
    return '<div class="no-morph">（普通词，无希腊-拉丁词根可拆）</div>';
  }
  if (isMedical) {
    return '<div class="no-morph">尚未拆解 · 点上方「生成词根拆解」</div>';
  }
  return '';
}

function matchesFilter(item) {
  switch (activeFilter) {
    case 'all': return true;
    case '医学': return item.level === '医学';
    case '术语': return item.level === '术语';
    case 'general': return item.level !== '医学' && item.level !== '术语';
    case 'hasMorph': return item.morph && item.morph.parts && item.morph.parts.length;
    default: return true;
  }
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const filtered = items.filter(
    (it) =>
      matchesFilter(it) &&
      (!q || it.term.toLowerCase().includes(q) || (it.zh || '').toLowerCase().includes(q))
  );

  countLine.textContent = `共 ${items.length} 词 · 当前显示 ${filtered.length} · 医学词已拆解 ${medicalAnalyzed}/${medicalTotal}`;

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty">没有匹配的单词。先在视频里生成学习页，生词会自动进这里。</div>';
    return;
  }

  listEl.innerHTML = filtered
    .map((it) => {
      const level = it.level ? `<span class="level">${escapeHtml(it.level)}</span>` : '';
      const freq = it.count > 1 ? `<span class="freq">出现 ${it.count} 次</span>` : '';
      return `<div class="word">
        <div class="word-head">
          <span class="term">${escapeHtml(it.term)}</span>${level}${freq}
        </div>
        <div class="zh">${escapeHtml(it.zh || '')}</div>
        ${renderMorph(it)}
      </div>`;
    })
    .join('');
}

function applyData(data) {
  items = data.items || [];
  medicalTotal = data.medicalTotal || 0;
  medicalAnalyzed = data.medicalAnalyzed || 0;
  render();
}

// 双模式：本地走 /api/wordbook；云端静态版降级读 wordbook.json 并隐藏拆解按钮
async function loadWordbook() {
  let data = null;
  try {
    const res = await fetch('/api/wordbook');
    if (res.ok) data = await res.json();
  } catch {
    // 静态托管走这里
  }
  if (!data || !data.ok) {
    document.body.classList.add('static-mode');
    try {
      const res = await fetch('wordbook.json');
      data = await res.json();
    } catch {
      data = null;
    }
  }
  if (!data || !data.ok) {
    listEl.innerHTML = '<div class="empty">单词本加载失败</div>';
    return;
  }
  applyData(data);
}

async function analyze() {
  analyzeBtn.disabled = true;
  analyzeStatus.classList.remove('error');
  analyzeStatus.textContent = '正在用 AI 拆解医学词的词根词缀，可能需要几十秒…';
  try {
    const res = await fetch('/api/wordbook/analyze', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || '拆解失败');
    applyData(data);
    analyzeStatus.textContent =
      data.analyzed > 0 ? `本次新拆解 ${data.analyzed} 个医学词` : '所有医学词都已拆解 ✅';
  } catch (err) {
    analyzeStatus.textContent = err.message;
    analyzeStatus.classList.add('error');
  } finally {
    analyzeBtn.disabled = false;
  }
}

filtersEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filtersEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
  activeFilter = chip.dataset.filter;
  render();
});

searchInput.addEventListener('input', render);
analyzeBtn.addEventListener('click', analyze);

loadWordbook();
