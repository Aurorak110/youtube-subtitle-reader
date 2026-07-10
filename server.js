const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { extractVideoId } = require('./lib/videoId');
const { groupIntoSentences } = require('./lib/segments');
const { translateAndExtractVocab, extractVocabOnly } = require('./lib/openai');

const PORT = process.env.PORT || 4300;
const DATA_DIR = path.join(__dirname, 'data');
// Python 路径：优先环境变量，其次本机已知安装位置，最后交给 PATH 解析（换电脑也能跑）
const KNOWN_PYTHON = 'C:\\Users\\admin\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const PYTHON_EXE =
  process.env.PYTHON_EXE || (fs.existsSync(KNOWN_PYTHON) ? KNOWN_PYTHON : 'python');

const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

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
const inflightDownloads = new Set();
function downloadVideoInBackground(id) {
  if (fs.existsSync(videoPath(id)) || inflightDownloads.has(id)) return;
  inflightDownloads.add(id);
  console.log(`开始后台下载视频: ${id}`);
  const child = spawn(PYTHON_EXE, [
    '-m', 'yt_dlp',
    // 优先 H.264 (avc1)：手机/HLS 全兼容。AV1/VP9 会导致切片和老手机播放失败
    '-f', 'bv*[height<=480][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480]/b',
    '--merge-output-format', 'mp4',
    '--no-warnings',
    '-o', videoPath(id),
    `https://www.youtube.com/watch?v=${id}`,
  ]);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.on('close', (code) => {
    inflightDownloads.delete(id);
    if (code === 0) {
      console.log(`视频下载完成: ${id}`);
    } else {
      console.warn(`视频下载失败 (${id}), 将继续使用在线播放器: ${stderr.slice(-300)}`);
    }
  });
  child.on('error', (err) => {
    inflightDownloads.delete(id);
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

function runFetchTranscript(videoId) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_EXE, [path.join(__dirname, 'scripts', 'fetch_transcript.py'), videoId]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', () => {
      const line = stdout.trim().split('\n').pop();
      if (!line) return reject(new Error(stderr || '字幕脚本无输出'));
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`字幕脚本输出解析失败: ${e.message}\n${stderr}`));
      }
    });
  });
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

    const transcriptResult = await runFetchTranscript(videoId);
    if (!transcriptResult.ok) {
      return res.status(422).json({ ok: false, error: transcriptResult.error });
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

    fs.writeFileSync(cache, JSON.stringify(payload));
    downloadVideoInBackground(videoId);
    res.json(withVideoStatus(payload));
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '生成失败' });
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
