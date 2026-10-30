/**
 * 为每个词生成一条中文助记（词根拆解 / 联想 / 搭配），不管这次答对答错都能看到。
 * 结果缓存到 data/raw/mnemonics.json，build-dict 会合并进词库。
 *
 *   node scripts/enrich-mnemonics.mjs            # 补齐所有缺助记的词
 *   node scripts/enrich-mnemonics.mjs --limit=40
 */
import fs from 'node:fs';
import path from 'node:path';

const WORDS = 'public/data/words.json';
const CACHE = 'data/raw/mnemonics.json';
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

console.log(`待生成助记：${pending.length} 个（缓存已有 ${Object.keys(cache).length} 条）`);
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
      const pos = w.senses.map((s) => s.p).filter(Boolean)[0] || '';
      const cn = w.senses.map((s) => s.cn).join('；').slice(0, 40);
      return `${w.w}\t${pos ? pos + '. ' : ''}${cn}`;
    })
    .join('\n');

  const prompt = `下面每行是一个英文单词和它的标准中文释义（制表符分隔）。请给每个词写一条中文助记，帮人把它记住。

要求（很重要，请逐条遵守）：
1. 一条，中文，不超过 45 个字，写在一行里。
2. **优先用真实的构词法**：拆词根、前缀、后缀，并说明它和词义的关系。
   例：incredible → 「in-（不）+ credible（可信的）→ 不可信的」
3. 词根不明显时，给一个**具体的联想画面**或**最常用的搭配**。
   例：abandon → 「常搭配 abandon a plan，把计划一丢不管」
4. 不要只是把中文释义再抄一遍 —— 那不算助记。
5. 不要编低俗、说不通或极度牵强的谐音；宁可只给搭配，也不要硬凑。
6. **不确定真实词源时，不要硬编词根**。宁可写成「联想：……」（给一个具体画面）或「常搭配……」（给常用搭配）。
   编造词源比没有助记更糟，会让人记错。
7. 不要出现英文长句，不要解释词性变化。

只输出 JSON 对象，键是单词（原样小写），值是助记：
{"example": "in-（不）+ credible（可信的）→ 不可信的"}

单词列表：
${list}`;

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是一位擅长词源与记忆法的英语老师，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.6,
      response_format: { type: 'json_object' },
      max_tokens: 3500,
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
    const m = obj[k] ?? obj[w.w];
    if (typeof m !== 'string') continue;
    const text = m.trim().replace(/\s+/g, ' ');
    if (text.length < 4 || text.length > 90) continue;
    if (!/[\u4e00-\u9fa5]/.test(text)) continue;
    cache[k] = text;
    filled++;
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
