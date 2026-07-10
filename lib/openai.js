const { ProxyAgent, fetch: undiciFetch } = require('undici');
const fs = require('fs');
const path = require('path');

// config.json (项目根目录) 优先于环境变量，方便直接填写国内可充值的兼容服务
// 格式: { "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat" }
let fileConfig = {};
const configPath = path.join(__dirname, '..', 'config.json');
if (fs.existsSync(configPath)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.warn(`config.json 解析失败，已忽略: ${e.message}`);
  }
}

const API_KEY = fileConfig.apiKey || process.env.OPENAI_API_KEY;
const BASE_URL = (fileConfig.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const OPENAI_MODEL = fileConfig.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CHUNK_SIZE = 20;
const CONCURRENCY = 3;
const MAX_TOKENS = 8000;

const PROXY_URL =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
// 国内服务(DeepSeek等)不需要走代理，OpenAI 需要
const needProxy = BASE_URL.includes('api.openai.com');
const dispatcher = needProxy && PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker));
  return results;
}

async function callOpenAI(messages) {
  const apiKey = API_KEY;
  if (!apiKey) throw new Error('API key 未设置（填写 config.json 或环境变量 OPENAI_API_KEY）');

  const res = await undiciFetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
    }),
    dispatcher,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API 请求失败 (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI 返回内容为空');
  // 有的模型(如 deepseek)会输出 ```json 包裹或字符串里带未转义的控制字符
  content = content.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(content);
  } catch {
    return JSON.parse(content.replace(/[\u0000-\u001f]/g, ' '));
  }
}

// 生词挑选标准：两处提取共用，保证口径一致
const VOCAB_CRITERIA =
  '挑选标准（严格执行）：' +
  '只挑 CEFR B2 及以上难度的内容——专业术语（医学、神经科学、科技等）、地道习语、短语动词、母语者常用但教科书少见的搭配、一词多义在本句取非常见义的词。' +
  '严禁收录初中高中级别的常见词（如 big、house、important、problem、different、because 这类词绝对不要选）。' +
  '优先挑中国学习者容易理解错、或查词典也不容易查到本句用法的表达。' +
  '每条包含：term（原文，保持句中的原形拼写）、zh（贴合本句语境的简洁中文释义）、' +
  'level（取值只能是 "术语"、"习语"、"短语动词"、"搭配"、"B2"、"C1"、"C2" 之一）、sentenceIndex（出现在哪一句的编号）。';

function buildPrompt(sentences, videoTitle) {
  const numbered = sentences.map((s, i) => `[${i}] ${s.text}`).join('\n');
  return [
    {
      role: 'system',
      content:
        '你是一个帮助中国用户学习英语的助手。给定一段英文视频字幕的若干句子（每句带编号），请完成两件事：' +
        '1) 把每一句翻译成自然、准确的中文；' +
        '2) 从这些句子中挑选出对英语学习者真正有价值的高级词汇和表达。' +
        VOCAB_CRITERIA +
        '只输出 JSON，不要输出多余文字。JSON 格式：' +
        '{"translations": ["第0句中文翻译", "第1句中文翻译", ...], "vocab": [{"term": "词或搭配原文", "zh": "简洁中文释义", "level": "C1", "sentenceIndex": 0}]}。' +
        'translations 数组长度必须与输入句子数量完全一致，按顺序一一对应。vocab 最多挑 12 条，宁缺毋滥，不要凑数。',
    },
    {
      role: 'user',
      content: `视频标题：${videoTitle || '(未知)'}\n\n句子列表：\n${numbered}`,
    },
  ];
}

async function processChunk(sentencesChunk, videoTitle) {
  const messages = buildPrompt(sentencesChunk, videoTitle);
  let result;
  try {
    result = await callOpenAI(messages);
  } catch (err) {
    console.warn(`翻译批次失败，重试一次: ${err.message}`);
    result = await callOpenAI(messages);
  }
  const translations = Array.isArray(result.translations) ? result.translations : [];
  const vocab = Array.isArray(result.vocab) ? result.vocab : [];
  return { translations, vocab };
}

async function translateAndExtractVocab(sentences, videoTitle) {
  const chunks = chunkArray(sentences, CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(chunks, CONCURRENCY, (chunk) =>
    processChunk(chunk, videoTitle)
  );

  const enriched = sentences.map((s) => ({ ...s, zh: '' }));
  const vocabMap = new Map();

  chunks.forEach((chunk, chunkIdx) => {
    const { translations, vocab } = chunkResults[chunkIdx];
    const offset = chunkIdx * CHUNK_SIZE;

    chunk.forEach((_, localIdx) => {
      const globalIdx = offset + localIdx;
      if (enriched[globalIdx] && translations[localIdx]) {
        enriched[globalIdx].zh = translations[localIdx];
      }
    });

    vocab.forEach((v) => {
      if (!v || !v.term) return;
      const globalSentenceIndex = offset + (Number(v.sentenceIndex) || 0);
      const key = v.term.trim().toLowerCase();
      if (!vocabMap.has(key)) {
        vocabMap.set(key, {
          term: v.term.trim(),
          zh: v.zh || '',
          level: v.level || '',
          sentenceIndex: globalSentenceIndex,
        });
      }
    });
  });

  const vocabList = Array.from(vocabMap.values()).sort((a, b) => a.sentenceIndex - b.sentenceIndex);

  await fillMissingTranslations(enriched);

  return { sentences: enriched, vocab: vocabList };
}

// 模型偶尔返回的 translations 数组比输入短，导致部分句子翻译缺失；这里对缺失句单独补翻
async function fillMissingTranslations(enriched) {
  const REPAIR_BATCH = 10;
  const missing = enriched.filter((s) => !s.zh);
  if (!missing.length) return;
  console.log(`补翻缺失句子: ${missing.length} 句`);

  const batches = chunkArray(missing, REPAIR_BATCH);
  await mapWithConcurrency(batches, CONCURRENCY, async (batch) => {
    const numbered = batch.map((s, i) => `[${i}] ${s.text}`).join('\n');
    const messages = [
      {
        role: 'system',
        content:
          '把下面每一句英文翻译成自然、准确的中文。只输出 JSON：' +
          '{"translations": ["第0句中文", "第1句中文", ...]}，' +
          'translations 数组长度必须与输入句子数量完全一致，按顺序一一对应。',
      },
      { role: 'user', content: numbered },
    ];
    try {
      const result = await callOpenAI(messages);
      const translations = Array.isArray(result.translations) ? result.translations : [];
      batch.forEach((s, i) => {
        if (translations[i]) s.zh = translations[i];
      });
    } catch (err) {
      console.warn(`补翻批次失败，跳过: ${err.message}`);
    }
  });
}

// 对已有字幕重新提取重点词（不重新翻译），用于升级旧缓存
async function extractVocabOnly(sentences, videoTitle) {
  const chunks = chunkArray(sentences, CHUNK_SIZE);
  const vocabMap = new Map();

  const chunkVocabs = await mapWithConcurrency(chunks, CONCURRENCY, async (chunk) => {
    const numbered = chunk.map((s, i) => `[${i}] ${s.text}`).join('\n');
    const messages = [
      {
        role: 'system',
        content:
          '你是一个帮助中国用户学习英语的助手。从下面的英文字幕句子（每句带编号）中挑选出对英语学习者真正有价值的高级词汇和表达。' +
          VOCAB_CRITERIA +
          '只输出 JSON：' +
          '{"vocab": [{"term": "词或搭配原文", "zh": "简洁中文释义", "level": "C1", "sentenceIndex": 0}]}。' +
          '最多挑 12 条，宁缺毋滥，不要凑数。',
      },
      { role: 'user', content: `视频标题：${videoTitle || '(未知)'}\n\n句子列表：\n${numbered}` },
    ];
    try {
      const result = await callOpenAI(messages);
      return Array.isArray(result.vocab) ? result.vocab : [];
    } catch (err) {
      console.warn(`词汇提取批次失败，跳过: ${err.message}`);
      return [];
    }
  });

  chunks.forEach((chunk, chunkIdx) => {
    const offset = chunkIdx * CHUNK_SIZE;
    chunkVocabs[chunkIdx].forEach((v) => {
      if (!v || !v.term) return;
      const localIdx = Number(v.sentenceIndex) || 0;
      const globalSentenceIndex = offset + Math.min(localIdx, chunk.length - 1);
      const key = v.term.trim().toLowerCase();
      if (!vocabMap.has(key)) {
        vocabMap.set(key, { term: v.term.trim(), zh: v.zh || '', level: v.level || '', sentenceIndex: globalSentenceIndex });
      }
    });
  });

  return Array.from(vocabMap.values()).sort((a, b) => a.sentenceIndex - b.sentenceIndex);
}

module.exports = { translateAndExtractVocab, fillMissingTranslations, extractVocabOnly };
