// 把本地生成的学习数据导出为纯静态网站 (site/)，用于部署到 Cloudflare Pages。
// 本地下载过的视频会切成 HLS 小片段一起发布（Pages 单文件限 25MB，切片后每片不到 1MB），
// 这样手机在云端看视频画面也不需要梯子。
// 用法: node scripts/export_site.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const HLS_DIR = path.join(DATA_DIR, 'hls');
const SITE_DIR = path.join(ROOT, 'site');

function videoCodec(mp4) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', mp4,
  ]);
  return (r.stdout || '').toString().trim();
}

// 把 mp4 切成 HLS。H.264 源直接换封装（几秒）；AV1/VP9 等源必须转码成
// H.264（几分钟，一次性），否则 TS 片段在手机上无法播放。
// 结果缓存在 data/hls/<id>/，之后每次发布直接复用
function ensureHls(id) {
  const mp4 = path.join(VIDEOS_DIR, `${id}.mp4`);
  if (!fs.existsSync(mp4)) return false;
  const outDir = path.join(HLS_DIR, id);
  const playlist = path.join(outDir, 'index.m3u8');
  if (fs.existsSync(playlist)) return true;

  const codec = videoCodec(mp4);
  // 转码时每 2 秒一个关键帧：跳转时几乎不用回退解码，点句子跳转更快
  const codecArgs =
    codec === 'h264'
      ? ['-c', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
         '-force_key_frames', 'expr:gte(t,n_forced*2)',
         '-c:a', 'aac', '-b:a', '128k'];
  if (codec !== 'h264') {
    console.log(`视频 ${id} 是 ${codec || '未知'} 编码，正在转码为 H.264（一次性，可能需要几分钟）…`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const result = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-i', mp4,
    ...codecArgs,
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_segment_filename', path.join(outDir, 'seg_%04d.ts'),
    playlist,
  ]);
  if (result.status !== 0) {
    console.warn(`HLS 切片失败 (${id})，云端将退回 YouTube 播放器: ${(result.stderr || '').toString().slice(-200)}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    return false;
  }
  return true;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
}

fs.rmSync(SITE_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE_DIR, 'data'), { recursive: true });

for (const f of fs.readdirSync(PUBLIC_DIR)) {
  const full = path.join(PUBLIC_DIR, f);
  if (fs.statSync(full).isFile()) {
    fs.copyFileSync(full, path.join(SITE_DIR, f));
  }
}

const items = [];
for (const f of fs.readdirSync(DATA_DIR)) {
  if (!f.endsWith('.json')) continue;
  try {
    const full = path.join(DATA_DIR, f);
    const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
    if (!data.id || !data.sentences) continue;

    const hasHls = ensureHls(data.id);
    if (hasHls) {
      copyDir(path.join(HLS_DIR, data.id), path.join(SITE_DIR, 'videos', data.id));
      data.videoUrl = `videos/${data.id}/index.m3u8`;
    } else {
      delete data.videoUrl;
    }
    fs.writeFileSync(path.join(SITE_DIR, 'data', `${data.id}.json`), JSON.stringify(data));

    items.push({
      id: data.id,
      title: data.title || data.id,
      channel: data.channel || '',
      duration: data.duration || null,
      sentenceCount: data.sentences.length,
      vocabCount: (data.vocab || []).length,
      hasLocalVideo: hasHls,
      addedAt: fs.statSync(full).mtimeMs,
    });
  } catch {
    // 损坏的缓存跳过
  }
}
items.sort((a, b) => b.addedAt - a.addedAt);
fs.writeFileSync(path.join(SITE_DIR, 'manifest.json'), JSON.stringify({ ok: true, items }));

console.log(`导出完成: ${items.length} 个视频 -> ${SITE_DIR}`);
