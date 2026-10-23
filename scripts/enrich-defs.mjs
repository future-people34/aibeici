/**
 * 给缺英文释义的词补一句学习者向的定义（用作提示线索）。
 * 结果缓存到 data/raw/en-defs.json，build-dict 会合并进去。
 *
 *   node scripts/enrich-defs.mjs            # 补齐所有缺英释的词
 *   node scripts/enrich-defs.mjs --limit=100
 */
import fs from 'node:fs';
import path from 'node:path';

const WORDS = 'public/data/words.json';
const CACHE = 'data/raw/en-defs.json';
const BATCH = 30;
const CONCURRENCY = 3;
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
  console.error('apikey.txt 里没有可用的 Key，先把 Key 填进去再跑这个脚本。');
  process.exit(1);
}

const dict = JSON.parse(fs.readFileSync(WORDS, 'utf8'));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

const missing = dict.words
  .filter((w) => !w.senses.some((s) => s.en && s.en.length > 3))
  .filter((w) => !cache[w.w.toLowerCase()])
  .map((w) => w.w)
  .slice(0, LIMIT);

console.log(`缺英文释义的词：${missing.length} 个待补（缓存里已有 ${Object.keys(cache).length} 条）`);
if (!missing.length) {
  console.log('没有需要补的词。直接跑 node scripts/build-dict.mjs');
  process.exit(0);
}

const batches = [];
for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));

let done = 0;
let filled = 0;
let failed = 0;

async function runBatch(words) {
  const prompt = `为下面每个英文单词写一句面向中国大学英语六级考生的英文释义。
要求：
1. 每条不超过 18 个单词，用简单的英文解释这个词的意思。
2. 不要用该词本身或它的派生词来解释（禁止循环定义）。
3. 不要给中文，不要给例句。
只输出 JSON 对象，键是单词（原样小写），值是释义字符串：
{"example": "a learner's definition"}

单词列表：
${words.join('\n')}`;

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一位英语词典编辑，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  let obj = {};
  try {
    obj = JSON.parse(content);
  } catch {
    throw new Error(`返回不是 JSON：${content.slice(0, 80)}`);
  }

  for (const w of words) {
    const k = w.toLowerCase();
    const def = obj[k] ?? obj[w];
    if (typeof def === 'string' && def.trim().length > 6) {
      cache[k] = def.trim().replace(/\s+/g, ' ').slice(0, 180);
      filled++;
    }
  }
  done += words.length;
  console.log(`  进度 ${done}/${missing.length}，已补 ${filled} 条`);
}

for (let i = 0; i < batches.length; i += CONCURRENCY) {
  const slice = batches.slice(i, i + CONCURRENCY);
  try {
    await Promise.all(slice.map((b) => runBatch(b)));
  } catch (e) {
    failed++;
    console.error(`  一批失败：${e.message}`);
  }
  // 每轮落盘，避免中途断掉白干
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
}

fs.writeFileSync(CACHE, JSON.stringify(cache));
console.log(`\n完成：补了 ${filled} 条，缓存总计 ${Object.keys(cache).length} 条 → ${CACHE}`);
console.log('下一步：node scripts/build-dict.mjs');
