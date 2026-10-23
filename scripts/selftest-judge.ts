/**
 * 判分规则层自测（不需要 API Key）
 * 打包运行：
 *   node_modules/@esbuild/win32-x64/esbuild.exe scripts/selftest-judge.ts --bundle --platform=node --format=esm --outfile=data/tmp/selftest-judge.mjs
 *   node data/tmp/selftest-judge.mjs
 */
import fs from 'node:fs';
import { loadDict } from '../src/lib/dict';
import { hintCount, hintFor, normalize, ruleJudge, splitKeys } from '../src/lib/judge';
import type { Word } from '../src/lib/types';

const dict = JSON.parse(fs.readFileSync('public/data/words.json', 'utf8')) as { words: Word[] };
// 让 dict.ts 的词库缓存就绪（构词提示要靠它按英文查词根）
globalThis.fetch = (async () => ({ ok: true, json: async () => dict })) as unknown as typeof fetch;
await loadDict();
const map = new Map(dict.words.map((w) => [w.w.toLowerCase(), w]));

function get(w: string): Word {
  const word = map.get(w.toLowerCase());
  if (!word) throw new Error(`词库中没有 ${w}`);
  return word;
}

let fails = 0;
function check(w: string, input: string, want: boolean, note = '') {
  const r = ruleJudge(get(w), input);
  const hit = r !== null && r.verdict === 'correct';
  const ok = hit === want;
  if (!ok) fails++;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(
    `[${mark}] ${w.padEnd(14)} "${input}" -> ${r ? r.verdict : 'null'}${note ? `  // ${note}` : ''}`,
  );
}

console.log('=== 归一化 ===');
console.log(normalize('  放弃 ，。 '), '|', normalize('ＡＢＣ'), '|', normalize('模棱两可'));
const keys = splitKeys('放弃, 抛弃；遗弃');
console.log('splitKeys:', keys.join(' / '));
if (keys.length !== 3) fails++;

console.log('\n=== 应当判对 ===');
check('abandon', '放弃', true);
check('abandon', '抛弃', true);
check('abandon', '遗弃', true);
check('abandon', '放纵', true, '第二个义项');
check('abandon', '放弃一切', true, '长一点的表述');
check('ambiguous', '模棱两可', true);
check('deteriorate', '恶化', true);
check('comply', '遵守', true, '同义词');
check('comply', '遵从', true);
check('sophisticated', '复杂的', true);

console.log('\n=== 应当交给模型 ===');
check('ambiguous', '含糊不清', false, '词库未收录的表述');
check('abandon', '沙漠', false, '与 abandon 无关');
check('abandon', '很好', false);
check('abandon', '弃', false, '单字信息量不足');
check('deteriorate', '变好', false, '反义');
check('comply', '抱怨', false, '和 complain 混淆');
check('abandon', '', false);
check('abandon', '这个词好像是放弃的意思因为它表示抛弃', false, '带猜测口吻');
check('abandon', '不知道是不是放弃', false, '自己都不确定');

console.log('\n=== 直接说不知道 ===');
const r = ruleJudge(get('abandon'), '不知道');
console.log(`[${r && r.verdict === 'wrong' ? 'PASS' : 'FAIL'}] 直接判 wrong：${r?.reason}`);
if (!r || r.verdict !== 'wrong') fails++;

console.log('\n=== 词性错配：形/副词答成词根名词，不能算对 ===');
function checkV(
  w: string,
  input: string,
  want: 'correct' | 'partial' | 'wrong' | 'null',
  note = '',
) {
  const res = ruleJudge(get(w), input);
  const got = res ? res.verdict : 'null';
  const ok = got === want;
  if (!ok) fails++;
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${w.padEnd(14)} "${input}" -> ${got}${note ? `  // ${note}` : ''}`,
  );
  if (got === 'partial' && res) console.log(`        点评：${res.reason}`);
}

checkV('environmental', '环境的', 'correct', '形容词形式');
checkV('environmental', '环境', 'partial', '答成了名词 environment 的意思');
checkV('environmental', '环保的', 'correct');
checkV('environment', '环境', 'correct', '名词词条，答名词是对的');
checkV('sophisticated', '复杂', 'correct', '复杂本身也是形容词，不该误伤');
checkV('consistent', '一致', 'partial', '答成了动词 consist 的意思');
checkV('deteriorate', '恶化', 'correct', '动词答动词');


console.log('\n=== 提示阶梯（中文优先，不能出现首字母/音节数这类废话）===');
function checkHint(w: string, level: number, mustHave: string[], mustNot: string[]) {
  const text = hintFor(get(w), level);
  const missing = mustHave.filter((m) => !text.includes(m));
  const bad = mustNot.filter((m) => text.includes(m));
  const ok = missing.length === 0 && bad.length === 0;
  if (!ok) fails++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${w} 第${level}级：${text.replace(/\n/g, ' / ')}`);
  if (missing.length) console.log(`        缺少：${missing.join('、')}`);
  if (bad.length) console.log(`        不该出现：${bad.join('、')}`);
}

const noEnglish = ['英文释义', '音节', '首字母'];
checkHint('environmental', 1, ['形容词', '构词', 'environment'], noEnglish);
checkHint('environmental', 2, ['中文例句', '______'], [...noEnglish, '英文例句']);
checkHint('environmental', 3, ['词义'], noEnglish);
checkHint('deteriorate', 1, ['中文例句', '______'], noEnglish);
checkHint('deteriorate', 2, ['词义'], [...noEnglish, '恶化']);

const envCount = hintCount(get('environmental'));
console.log(`[${envCount >= 2 ? 'PASS' : 'FAIL'}] environmental 有 ${envCount} 级可用提示`);
if (envCount < 2) fails++;

console.log('\n=== 全库：没有提示可用的词有多少 ===');
let zero = 0;
let one = 0;
for (const w of dict.words) {
  const n = hintCount(w);
  if (n === 0) zero++;
  else if (n === 1) one++;
}
console.log(`  0 级提示 ${zero} 个（${((zero / dict.words.length) * 100).toFixed(1)}%），1 级 ${one} 个`);
if (zero / dict.words.length > 0.03) {
  console.log('  FAIL 空提示占比过高');
  fails++;
} else {
  console.log('  PASS 空提示占比可接受');
}

console.log('\n=== 批量召回 / 误判 ===');
const pool = dict.words.filter((w) => !w.c4).slice(0, 400);
let recall = 0;
let recallTotal = 0;
for (const w of pool) {
  if (!w.accept.length) continue;
  recallTotal++;
  const res = ruleJudge(w, w.accept[0]);
  if (res && res.verdict === 'correct') recall++;
}
console.log(
  `本地可判率（用第一个答案键回答）：${recall}/${recallTotal} = ${((recall / recallTotal) * 100).toFixed(1)}%`,
);

let miss = 0;
let total = 0;
for (let i = 0; i < pool.length; i++) {
  const w = pool[i];
  const other = pool[(i * 37 + 11) % pool.length];
  if (!other.accept.length || other.w === w.w) continue;
  total++;
  const res = ruleJudge(w, other.accept[0]);
  if (!res || res.verdict !== 'correct') miss++;
}
console.log(
  `拿别人的答案来答的拦截率：${miss}/${total} = ${((miss / total) * 100).toFixed(1)}%（越高越安全）`,
);

console.log(`\n${fails === 0 ? '全部断言通过' : `${fails} 个断言失败`}`);
process.exit(fails === 0 ? 0 : 1);
