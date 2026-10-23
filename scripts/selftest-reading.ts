/**
 * 阅读理解校验逻辑自测（不调用模型）
 *   node_modules/@esbuild/win32-x64/esbuild.exe scripts/selftest-reading.ts --bundle --platform=node --format=esm --outfile=data/tmp/selftest-reading.mjs
 *   node data/tmp/selftest-reading.mjs
 */
import fs from 'node:fs';
import { appearsIn, shuffleQuestion, validateReading } from '../src/lib/reading';
import type { Word } from '../src/lib/types';

const dict = JSON.parse(fs.readFileSync('public/data/words.json', 'utf8')) as { words: Word[] };
const map = new Map(dict.words.map((w) => [w.w.toLowerCase(), w]));
const pick = (w: string): Word => {
  const x = map.get(w);
  if (!x) throw new Error(`词库没有 ${w}`);
  return x;
};

let fails = 0;
function assert(cond: boolean, msg: string) {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${msg}`);
  if (!cond) fails++;
}
function expectThrow(fn: () => void, msg: string) {
  try {
    fn();
    assert(false, msg + '（本应抛错但没有）');
  } catch {
    assert(true, msg);
  }
}

console.log('=== 词形还原命中 ===');
const abandon = pick('abandon');
assert(appearsIn('They abandoned the plan.', abandon), 'abandoned 命中 abandon');
assert(appearsIn('abandoning', abandon), 'abandoning 命中 abandon');
assert(!appearsIn('The band played.', abandon), 'band 不应命中 abandon');

const deteriorate = pick('deteriorate');
assert(appearsIn('The situation deteriorated quickly.', deteriorate), 'deteriorated 命中 deteriorate');

console.log('\n=== 合法返回 ===');
const words = ['abandon', 'deteriorate', 'ambiguous'].map(pick);
const goodBody = `Companies often abandon long-term plans when quarterly numbers look weak. \
Managers may deteriorate their own credibility if they keep changing course. \
The message such leaders send is ambiguous at best. `.repeat(6);

const good = validateReading(
  {
    title: 'Why Firms Give Up',
    body: goodBody,
    questions: [1, 2, 3].map((i) => ({
      q: `问题 ${i}`,
      options: ['A', 'B', 'C', 'D'],
      answer: 0,
      explain: '因为第一句提到了',
    })),
  },
  words,
);
assert(good.covered.length === 3 && good.missing.length === 0, '三个目标词全部命中');
assert(good.questions.length === 3, '保留 3 道题');

console.log('\n=== 不合法返回 ===');
expectThrow(() => validateReading({ body: 'too short', questions: [] }, words), '太短的文章被拒绝');
expectThrow(
  () => validateReading({ body: goodBody, questions: [{ q: 'x', options: ['A'], answer: 0 }] }, words),
  '选项不足 4 个的题被拒绝',
);
expectThrow(
  () =>
    validateReading(
      {
        body: goodBody,
        questions: [
          { q: 'a', options: ['A', 'B', 'C', 'D'], answer: 9 },
          { q: 'b', options: ['A', 'B', 'C', 'D'], answer: 9 },
          { q: 'c', options: ['A', 'B', 'C', 'D'], answer: 9 },
        ],
      },
      words,
    ),
  '答案下标越界的题被拒绝',
);

console.log('\n=== 覆盖不足时能报出来（用于触发重写） ===');
const partial = validateReading(
  {
    body: goodBody,
    questions: [1, 2, 3].map((i) => ({ q: `q${i}`, options: ['A', 'B', 'C', 'D'], answer: 1, explain: 'x' })),
  },
  [...words, pick('attorney')],
);
console.log('covered:', partial.covered.join(','), '| missing:', partial.missing.join(','));
assert(partial.missing.length === 1 && partial.missing[0] === 'attorney', '缺失目标词被识别出来');

console.log('\n=== 选项打乱（模型总把答案写在第一个）===');
const demoQ = {
  q: '文中作者对这个观点持什么态度？',
  options: ['支持', '反对', '中立', '没提'],
  answer: 0,
  explain: '第一段明确表示赞成',
};
let wrongAnswers = 0;
const pos = [0, 0, 0, 0];
for (let i = 0; i < 2000; i++) {
  const s = shuffleQuestion(demoQ);
  // 打乱后，「正确答案那个位置上的选项」必须还是原来那条
  if (s.options[s.answer] !== demoQ.options[demoQ.answer]) wrongAnswers++;
  // 四个选项都要还在
  if (new Set(s.options).size !== 4) wrongAnswers++;
  pos[s.answer]++;
}
console.log(`  2000 次打乱，正确答案落在 A/B/C/D 的次数：${pos.join(' / ')}`);
assert(wrongAnswers === 0, '打乱后答案下标与选项始终对应');
const even = pos.every((n) => n > 300 && n < 700);
assert(even, '四个位置分布大致均匀（各约 25%）');

const keptFirst = [0, 1, 2, 3].map(() => shuffleQuestion(demoQ).answer);
console.log(`  原始答案是第 1 个时，打乱后可能落到的位置：${[...new Set(keptFirst)].sort().join(',')}`);
assert(new Set(keptFirst).size > 1 || true, '（随机性由上面的分布断言保证）');

console.log(`\n${fails === 0 ? '全部断言通过' : `${fails} 个断言失败`}`);
process.exit(fails === 0 ? 0 : 1);
