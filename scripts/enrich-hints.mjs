/**
 * 为每个词生成一句「中文提示」，用于「看英文写中文」时的最后一级提示。
 * 要求避开标准译词本身，避免直接给答案。
 * 结果缓存到 data/raw/zh-hints.json，build-dict 会合并进去。
 *
 *   node scripts/enrich-hints.mjs            # 补齐所有缺提示的词
 *   node scripts/enrich-hints.mjs --limit=60
 */
import fs from 'node:fs';
import path from 'node:path';

const WORDS = 'public/data/words.json';
const CACHE = 'data/raw/zh-hints.json';
const BATCH = 40;
const CONCURRENCY = 4;
const MODEL = 'deepseek-chat';

const argv = process.argv.slice(2);
const limitArg = argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

function readKey() {
  const p = path.resolve('apikey.txt');
  if (!fs.existsSync(p)) return '';
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const v = (line.includes('=') ? line.split('=').slice(1).join('=') : line).trim();
    if (/^[\x21-\x7e]{16,}$/.test(v)) return v;
  }
  return '';
}

const key = readKey();
if (!key) {
  console.error('apikey.txt 里没有可用的 Key。');
  process.exit(1);
}

const dict = JSON.parse(fs.readFileSync(WORDS, 'utf8'));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

const pending = dict.words
  .filter((w) => !cache[w.w.toLowerCase()])
  .slice(0, LIMIT);

console.log(`待生成中文提示：${pending.length} 个（缓存已有 ${Object.keys(cache).length} 条）`);
if (!pending.length) {
  console.log('没有需要生成的词。');
  process.exit(0);
}

const batches = [];
for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));

let done = 0;
let filled = 0;
let failed = 0;

async function runBatch(items) {
  const list = items
    .map((w) => {
      const cn = w.senses.map((s) => s.cn).join('；').slice(0, 60);
      return `${w.w}\t标准释义：${cn}`;
    })
    .join('\n');

  const prompt = `下面每个英文单词后面跟着它的标准中文释义。请为每个词写一句中文提示，帮助正在「看英文写中文」的学生想起词义。

硬性要求：
1. 每条不超过 26 个汉字，一句话，读完要能大致想到意思。
2. **绝对不要出现标准释义里的原词**（我在下面给了标准释义，你必须换一种说法）。
   例如标准释义是「恶化」，你可以写「变得比原来更糟」；标准释义是「参加者」，可以写「参与其中的那个人」。
3. 不要出现英文，不要写例句，不要解释词性变化。
4. 语气像老师给的提示，不要写成字典条目。

只输出 JSON 对象，键是单词（原样小写），值是中文提示：
{"example": "变得比原来更糟"}

单词列表（制表符分隔）：
${list}`;

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一位经验丰富的英语词汇老师，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' },
      max_tokens: 3000,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 100)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  let obj = {};
  try {
    obj = JSON.parse(content);
  } catch {
    throw new Error(`返回不是 JSON：${content.slice(0, 60)}`);
  }

  for (const w of items) {
    const k = w.w.toLowerCase();
    const hint = obj[k] ?? obj[w.w];
    if (typeof hint === 'string' && hint.trim().length >= 4) {
      cache[k] = hint.trim().replace(/\s+/g, '').slice(0, 40);
      filled++;
    }
  }
  done += items.length;
  console.log(`  进度 ${done}/${pending.length}，已生成 ${filled} 条`);
}

for (let i = 0; i < batches.length; i += CONCURRENCY) {
  const slice = batches.slice(i, i + CONCURRENCY);
  try {
    await Promise.all(slice.map((b) => runBatch(b)));
  } catch (e) {
    failed++;
    console.error(`  一批失败：${e.message}`);
  }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
}

fs.writeFileSync(CACHE, JSON.stringify(cache));
console.log(`\n完成：生成 ${filled} 条，缓存总计 ${Object.keys(cache).length} 条${failed ? `，${failed} 批失败` : ''}`);
console.log('下一步：node scripts/build-dict.mjs');
