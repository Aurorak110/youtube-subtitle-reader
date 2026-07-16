// 一次性修复脚本：对已有缓存重新翻译并重挑生词。
// 用途：旧缓存是在「按数组位置回填」的老逻辑下生成的，可能整体错位一句。
// 本脚本保留原有句子切分与词级时间戳（sentences.text/start/words 不变），
// 只用修好的按编号回填逻辑重算每句 zh 和 vocab，然后覆盖写回。
//
// 用法：
//   node scripts/retranslate_cache.js            # 处理 data/ 下全部缓存
//   node scripts/retranslate_cache.js ID1 ID2    # 只处理指定视频

const fs = require('fs');
const path = require('path');
const { translateAndExtractVocab } = require('../lib/openai');

const DATA_DIR = path.join(__dirname, '..', 'data');

async function main() {
  const argIds = process.argv.slice(2);
  const files = argIds.length
    ? argIds.map((id) => `${id}.json`)
    : fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json');

  for (const f of files) {
    const full = path.join(DATA_DIR, f);
    if (!fs.existsSync(full)) {
      console.warn(`跳过（不存在）: ${f}`);
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch {
      console.warn(`跳过（无法解析）: ${f}`);
      continue;
    }
    if (!payload.id || !Array.isArray(payload.sentences) || !payload.sentences.length) {
      console.warn(`跳过（无句子）: ${f}`);
      continue;
    }

    // 只保留切分与时间信息，清掉旧的 zh 交给重译
    const rawSentences = payload.sentences.map((s) => ({
      index: s.index,
      start: s.start,
      text: s.text,
      words: s.words,
    }));

    console.log(`重译 ${payload.id}（${rawSentences.length} 句）: ${payload.title || ''}`);
    const t0 = Date.now();
    const { sentences, vocab } = await translateAndExtractVocab(rawSentences, payload.title);

    // 安全阀：若大量句子未译（多半是网络中断/API 系统性失败），
    // 绝不用这份残缺结果覆盖已有完整缓存，否则会把好数据冲成空白。
    const missing = sentences.filter((s) => !s.zh).length;
    const missRatio = missing / sentences.length;
    const took = ((Date.now() - t0) / 1000).toFixed(0);
    if (missRatio > 0.1) {
      console.warn(
        `  ✗ 放弃写入 ${payload.id}：${missing}/${sentences.length} 句未译（${(missRatio * 100).toFixed(0)}%），` +
          `疑似网络/API 故障。原缓存保持不变，请稍后重试。用时 ${took}s`
      );
      continue;
    }

    // 备份原文件一次，防手滑
    const bak = full + '.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(full, bak);

    payload.sentences = sentences;
    payload.vocab = vocab;
    fs.writeFileSync(full, JSON.stringify(payload));

    console.log(
      `  ✓ 完成，用时 ${took}s，生词 ${vocab.length} 条` +
        (missing ? `，仍有 ${missing} 句未译` : '') +
        `（原文件已备份为 ${path.basename(bak)}）`
    );
  }
  console.log('全部处理完毕。');
}

main().catch((err) => {
  console.error('重译失败:', err);
  process.exit(1);
});
