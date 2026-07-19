const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { extractVideoId } = require('./lib/videoId');
const { groupIntoSentences } = require('./lib/segments');
const { translateAndExtractVocab, extractVocabOnly, analyzeMorphology } = require('./lib/openai');

const PORT = process.env.PORT || 4300;
const DATA_DIR = path.join(__dirname, 'data');
// Python 路径：优先环境变量，其次本机已知安装位置，最后交给 PATH 解析（换电脑也能跑）
const KNOWN_PYTHON = 'C:\\Users\\admin\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const PYTHON_EXE =
  process.env.PYTHON_EXE || (fs.existsSync(KNOWN_PYTHON) ? KNOWN_PYTHON : 'python');

const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// 可选的登录 cookies：被 YouTube 判定为 "not a bot" 时，放一份 Netscape 格式的
// cookies.txt 到这里即可用真实登录态抓取（见 README）。存在才用，不存在照常匿名抓。
const COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt');

// 只有像真实登录态的 cookies 才交给 yt-dlp。半失效文件（缺 LOGIN_INFO）反而
// 干扰匿名请求——与 fetch_transcript.py / list_channel.py 的校验口径一致（轻量版）。
function cookiesUsable() {
  try {
    const txt = fs.readFileSync(COOKIES_FILE, 'utf-8');
    return /\bLOGIN_INFO\b/.test(txt) && /\b(SAPISID|__Secure-1PAPISID|__Secure-3PAPISID)\b/.test(txt);
  } catch {
    return false;
  }
}
function cookieArgs(prefix) {
  // prefix: yt-dlp CLI 用 '--cookies'（下载视频）
  return cookiesUsable() ? [prefix, COOKIES_FILE] : [];
}
function pythonEnv() {
  // COOKIES_FILE 始终传给脚本，由脚本自身做完整校验（jar 解析 + 过期检查）
  return fs.existsSync(COOKIES_FILE) ? { ...process.env, COOKIES_FILE } : process.env;
}

const app = express();
// 允许浏览器插件（运行在 youtube.com 页面里）调用本地接口
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(VIDEOS_DIR));

function cachePath(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

function videoPath(id) {
  return path.join(VIDEOS_DIR, `${id}.mp4`);
}

// 生成时顺带把视频下到本地（480p mp4）。之后播放走本地文件，不再需要 VPN。
// yt-dlp 下载中是 .part 文件，完成才改名 .mp4，所以 existsSync 即代表下载完成。
// 批量缓存时会一次进来几十个视频，用队列限制并发，避免同时开几十个 yt-dlp。
const inflightDownloads = new Set(); // 排队中 + 下载中
const downloadQueue = [];
let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 2;

function downloadVideoInBackground(id) {
  if (fs.existsSync(videoPath(id)) || inflightDownloads.has(id)) return;
  inflightDownloads.add(id);
  downloadQueue.push(id);
  pumpDownloadQueue();
}

function pumpDownloadQueue() {
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length) {
    startDownload(downloadQueue.shift());
  }
}

function startDownload(id) {
  activeDownloads++;
  console.log(`开始后台下载视频: ${id}`);
  const done = () => {
    inflightDownloads.delete(id);
    activeDownloads--;
    pumpDownloadQueue();
  };
  const child = spawn(PYTHON_EXE, [
    '-m', 'yt_dlp',
    // 优先 H.264 (avc1)：手机/HLS 全兼容。AV1/VP9 会导致切片和老手机播放失败
    '-f', 'bv*[height<=480][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480]/b',
    '--merge-output-format', 'mp4',
    '--no-warnings',
    ...cookieArgs('--cookies'),
    '-o', videoPath(id),
    `https://www.youtube.com/watch?v=${id}`,
  ]);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.on('close', (code) => {
    done();
    if (code === 0) {
      console.log(`视频下载完成: ${id}`);
    } else {
      console.warn(`视频下载失败 (${id}), 将继续使用在线播放器: ${stderr.slice(-300)}`);
    }
  });
  child.on('error', (err) => {
    done();
    console.warn(`视频下载进程启动失败: ${err.message}`);
  });
}

function withVideoStatus(payload) {
  const hasLocalVideo = fs.existsSync(videoPath(payload.id));
  return {
    ...payload,
    hasLocalVideo,
    // 有本地文件时播放器直接用它（不需要梯子）；否则前端退回 YouTube 在线播放器
    videoUrl: hasLocalVideo ? `/videos/${payload.id}.mp4` : null,
    downloading: inflightDownloads.has(payload.id),
  };
}

// 跑一个「输出单行 JSON」的 Python 脚本并解析结果（COOKIES_FILE 存在时经环境变量传给脚本）
function runPythonJson(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_EXE, [path.join(__dirname, 'scripts', script), ...args], { env: pythonEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', () => {
      const line = stdout.trim().split('\n').pop();
      if (!line) return reject(new Error(stderr || `${script} 无输出`));
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`${script} 输出解析失败: ${e.message}\n${stderr}`));
      }
    });
  });
}

function runFetchTranscript(videoId) {
  return runPythonJson('fetch_transcript.py', [videoId]);
}

function runListChannel(url, limit) {
  return runPythonJson('list_channel.py', [url, String(limit)]);
}

// YouTube 有时对无 cookies 的出口 IP 弹 "Sign in to confirm you're not a bot"。
// 出现这个错误时给出可操作的提示（放一份 data/cookies.txt 即可用登录态绕过）。
function isBotCheckError(msg) {
  return /sign in to confirm|not a bot/i.test(String(msg || ''));
}
const BOT_CHECK_HINT =
  'YouTube 要求登录验证（多为频繁抓取触发的临时限制）。稍等几小时通常自动恢复；' +
  '若持续，请导出一份浏览器 cookies 放到 data/cookies.txt（见 README「cookies」一节）。';

// 完整生成管线：抓字幕 → 翻译 + 挑生词 → 写缓存。单个生成和批量缓存共用。
// 字幕不可用（无英文字幕等）时抛出带 expected 标记的错误，方便上层区分 422/500。
async function generatePayload(videoId) {
  let transcriptResult;
  try {
    transcriptResult = await runFetchTranscript(videoId);
  } catch (e) {
    transcriptResult = { ok: false, error: e.message };
  }
  if (!transcriptResult.ok) {
    const msg = isBotCheckError(transcriptResult.error) ? BOT_CHECK_HINT : transcriptResult.error;
    throw Object.assign(new Error(msg), { expected: true });
  }

  const rawSentences = groupIntoSentences(transcriptResult.cues);
  const { sentences, vocab } = await translateAndExtractVocab(rawSentences, transcriptResult.title);

  const payload = {
    ok: true,
    id: videoId,
    title: transcriptResult.title,
    channel: transcriptResult.channel || '',
    duration: transcriptResult.duration,
    isGenerated: transcriptResult.isGenerated,
    sentences,
    vocab,
  };
  fs.writeFileSync(cachePath(videoId), JSON.stringify(payload));
  return payload;
}

app.post('/api/generate', async (req, res) => {
  try {
    const videoId = extractVideoId(req.body.url);
    if (!videoId) {
      return res.status(400).json({ ok: false, error: '无法识别的 YouTube 链接' });
    }

    const cache = cachePath(videoId);
    if (fs.existsSync(cache)) {
      downloadVideoInBackground(videoId);
      return res.json(withVideoStatus(JSON.parse(fs.readFileSync(cache, 'utf-8'))));
    }

    const payload = await generatePayload(videoId);
    downloadVideoInBackground(videoId);
    res.json(withVideoStatus(payload));
  } catch (err) {
    if (err.expected) {
      return res.status(422).json({ ok: false, error: err.message });
    }
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '生成失败' });
  }
});

// ---------- 批量缓存一个博主的视频 ----------
// 同一时间只允许一个批量任务（翻译 API 和带宽都吃不消并行多个博主）。
// 任务在后台逐个视频跑，前端轮询 /api/batch/status 展示进度。
let batchJob = null;

app.post('/api/batch', async (req, res) => {
  if (batchJob && batchJob.running) {
    return res.status(409).json({ ok: false, error: '已有批量任务在进行中，请等它完成或先取消', job: batchJob });
  }
  const url = String(req.body.url || '').trim();
  const limit = Math.max(1, Math.min(50, parseInt(req.body.limit, 10) || 10));
  if (!url) {
    return res.status(400).json({ ok: false, error: '请提供博主主页链接（或该博主任意一个视频的链接）' });
  }

  try {
    const listing = await runListChannel(url, limit);
    if (!listing.ok) {
      return res.status(422).json({ ok: false, error: listing.error });
    }
    if (!listing.videos.length) {
      return res.status(422).json({ ok: false, error: '该频道没有找到可用视频' });
    }

    batchJob = {
      running: true,
      cancelled: false,
      channel: listing.channel || '',
      total: listing.videos.length,
      done: 0,
      okCount: 0,
      skipped: 0,
      failed: [],
      current: '',
      startedAt: Date.now(),
      finishedAt: null,
      items: listing.videos.map((v) => ({ id: v.id, title: v.title, status: 'pending' })),
    };
    runBatchJob(); // 后台跑，不 await
    res.json({ ok: true, job: batchJob });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '获取频道视频列表失败' });
  }
});

async function runBatchJob() {
  const job = batchJob;
  console.log(`批量缓存开始: ${job.channel}（${job.total} 个视频）`);
  for (const item of job.items) {
    if (job.cancelled) {
      item.status = 'cancelled';
      continue;
    }
    if (fs.existsSync(cachePath(item.id))) {
      item.status = 'skipped';
      job.skipped++;
      job.done++;
      downloadVideoInBackground(item.id); // 缓存有了但视频可能还没下
      continue;
    }
    item.status = 'working';
    job.current = item.title;
    try {
      await generatePayload(item.id);
      item.status = 'ok';
      job.okCount++;
      downloadVideoInBackground(item.id);
      console.log(`批量缓存完成 (${job.done + 1}/${job.total}): ${item.title}`);
    } catch (err) {
      item.status = 'failed';
      item.error = err.message;
      job.failed.push({ id: item.id, title: item.title, error: err.message });
      console.warn(`批量缓存失败 (${item.id}): ${err.message}`);
    }
    job.done++;
  }
  job.running = false;
  job.current = '';
  job.finishedAt = Date.now();
  console.log(
    `批量缓存结束: 新增 ${job.okCount}，已有跳过 ${job.skipped}，失败 ${job.failed.length}${job.cancelled ? '（用户取消）' : ''}`
  );
}

app.get('/api/batch/status', (req, res) => {
  res.json({ ok: true, job: batchJob });
});

app.post('/api/batch/stop', (req, res) => {
  if (batchJob && batchJob.running) batchJob.cancelled = true;
  res.json({ ok: true, job: batchJob });
});

// ---------- 单词本：把所有视频的生词汇总成一本可复习的词书 ----------
// 词根词缀拆解结果单独缓存在 data/morphology.json（key = 小写词），只算一次不重复花钱。
const MORPH_FILE = path.join(DATA_DIR, 'morphology.json');
function loadMorph() {
  try {
    return JSON.parse(fs.readFileSync(MORPH_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

// 扫描所有视频缓存，按词条去重汇总；记录出现频次和出现在哪些视频
function aggregateWordbook() {
  const skip = new Set(['morphology.json', 'manifest.json']);
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') && !skip.has(f));
  const byTerm = new Map();
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
    } catch {
      continue;
    }
    if (!Array.isArray(data.vocab)) continue;
    for (const v of data.vocab) {
      if (!v || !v.term) continue;
      const key = v.term.trim().toLowerCase();
      if (!byTerm.has(key)) {
        byTerm.set(key, { term: v.term.trim(), zh: v.zh || '', level: v.level || '', count: 0, videos: [] });
      }
      const e = byTerm.get(key);
      e.count++;
      if (data.id && !e.videos.includes(data.id)) e.videos.push(data.id);
    }
  }
  return byTerm;
}

function isMedicalLevel(level) {
  return level === '医学' || level === '术语';
}

// 组装单词本：汇总 + 合并已缓存的词根拆解
function buildWordbook() {
  const byTerm = aggregateWordbook();
  const morph = loadMorph();
  const items = [...byTerm.values()].map((e) => ({
    ...e,
    morph: morph[e.term.toLowerCase()] || null,
  }));
  // 医学词优先、再按出现频次、再按字母
  items.sort((a, b) => {
    const am = isMedicalLevel(a.level) ? 0 : 1;
    const bm = isMedicalLevel(b.level) ? 0 : 1;
    return am - bm || b.count - a.count || a.term.localeCompare(b.term);
  });
  const medicalTotal = items.filter((i) => isMedicalLevel(i.level)).length;
  const medicalAnalyzed = items.filter((i) => isMedicalLevel(i.level) && i.morph).length;
  return { items, medicalTotal, medicalAnalyzed };
}

app.get('/api/wordbook', (req, res) => {
  res.json({ ok: true, ...buildWordbook() });
});

// 对还没拆解的医学词批量做词根词缀拆解，结果写入缓存
app.post('/api/wordbook/analyze', async (req, res) => {
  try {
    const byTerm = aggregateWordbook();
    const morph = loadMorph();
    const todo = [...byTerm.values()]
      .filter((e) => isMedicalLevel(e.level) && !morph[e.term.toLowerCase()])
      .map((e) => e.term);

    if (!todo.length) {
      return res.json({ ok: true, analyzed: 0, ...buildWordbook() });
    }

    const result = await analyzeMorphology(todo);
    result.forEach((val, key) => {
      morph[key] = val;
    });
    fs.writeFileSync(MORPH_FILE, JSON.stringify(morph));
    console.log(`词根拆解完成: 新增 ${result.size} 个词`);
    res.json({ ok: true, analyzed: result.size, ...buildWordbook() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '词根拆解失败' });
  }
});

// 视频库：列出所有已生成的学习页，按博主分组交给前端渲染
app.get('/api/library', (req, res) => {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    try {
      const full = path.join(DATA_DIR, f);
      const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
      if (!data.id || !data.sentences) continue;
      items.push({
        id: data.id,
        title: data.title || data.id,
        channel: data.channel || '',
        duration: data.duration || null,
        sentenceCount: data.sentences.length,
        vocabCount: (data.vocab || []).length,
        hasLocalVideo: fs.existsSync(videoPath(data.id)),
        addedAt: fs.statSync(full).mtimeMs,
      });
    } catch {
      // 损坏的缓存文件跳过，不影响其余条目
    }
  }
  items.sort((a, b) => b.addedAt - a.addedAt);
  res.json({ ok: true, items });
});

// 用升级后的挑词标准重新提取生词（不重新翻译，只花少量 API 费用）
app.post('/api/revocab/:id', async (req, res) => {
  try {
    const cache = cachePath(req.params.id);
    if (!fs.existsSync(cache)) {
      return res.status(404).json({ ok: false, error: '未找到该视频的缓存' });
    }
    const payload = JSON.parse(fs.readFileSync(cache, 'utf-8'));
    payload.vocab = await extractVocabOnly(payload.sentences, payload.title);
    fs.writeFileSync(cache, JSON.stringify(payload));
    res.json(withVideoStatus(payload));
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '重新提取失败' });
  }
});

app.get('/api/video/:id', (req, res) => {
  const cache = cachePath(req.params.id);
  if (!fs.existsSync(cache)) {
    return res.status(404).json({ ok: false, error: '未找到该视频的学习页，请先在首页生成' });
  }
  res.json(withVideoStatus(JSON.parse(fs.readFileSync(cache, 'utf-8'))));
});

app.get('/watch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

app.get('/wordbook', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wordbook.html'));
});

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nYouTube 双语字幕学习工具已启动`);
  console.log(`  电脑访问: http://localhost:${PORT}`);
  for (const ip of getLanIPs()) {
    console.log(`  手机访问 (同一WiFi): http://${ip}:${PORT}`);
  }
  console.log('');
});
