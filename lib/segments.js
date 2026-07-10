const SENTENCE_END_RE = /[.!?…]["')\]]*$/;
// 常见缩写，句号不代表句子结束
const ABBREV_RE = /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|St|vs|etc|e\.g|i\.e|U\.S|a\.m|p\.m)\.$/i;
const MAX_WORDS = 40;

// 把字幕块拆成带插值时间戳的单词流：字幕块时长按单词数均分。
// 这样句号出现在字幕块中间时也能精确断句，且每句起始时间准确。
function cuesToWords(cues) {
  const words = [];
  for (const cue of cues) {
    const tokens = cue.text.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const step = (cue.duration || 0) / tokens.length;
    tokens.forEach((tok, i) => {
      words.push({ w: tok, t: cue.start + i * step });
    });
  }
  return words;
}

function groupIntoSentences(cues) {
  const words = cuesToWords(cues);
  const sentences = [];
  let buffer = [];
  let bufferStart = null;

  const flush = () => {
    if (buffer.length) {
      sentences.push({
        start: bufferStart,
        text: buffer.map((x) => x.w).join(' '),
        // 保留每个词的插值时间戳，前端用来做逐词跟读高亮
        words: buffer.map((x) => ({ w: x.w, t: Math.round(x.t * 100) / 100 })),
      });
    }
    buffer = [];
    bufferStart = null;
  };

  for (const { w, t } of words) {
    if (bufferStart === null) bufferStart = t;
    buffer.push({ w, t });

    const endsLikeSentence = SENTENCE_END_RE.test(w) && !ABBREV_RE.test(buffer.map((x) => x.w).join(' '));
    if (endsLikeSentence || buffer.length >= MAX_WORDS) {
      flush();
    }
  }
  flush();

  return sentences.map((s, index) => ({ index, ...s }));
}

module.exports = { groupIntoSentences };
