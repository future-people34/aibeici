/**
 * FSRS 调度自测：确认评分能正确拉长/缩短复习间隔
 *   node_modules/@esbuild/win32-x64/esbuild.exe scripts/selftest-srs.ts --bundle --platform=node --format=esm --outfile=data/tmp/selftest-srs.mjs
 *   node data/tmp/selftest-srs.mjs
 */
import { Rating } from 'ts-fsrs';
import {
  applyRating,
  cardStage,
  configureSrs,
  isLeech,
  isMastered,
  newCard,
  ratingFor,
  retrievability,
} from '../src/lib/srs';
import type { MemCard } from '../src/lib/types';

function daysBetween(a: number, b: number): number {
  return Math.round((b - a) / 86_400_000);
}

let fails = 0;
function assert(cond: boolean, msg: string) {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${msg}`);
  if (!cond) fails++;
}

console.log('=== 评分映射 ===');
assert(ratingFor('wrong', 0, 5000) === Rating.Again, '答错 → Again');
assert(ratingFor('partial', 0, 5000) === Rating.Hard, '部分正确 → Hard');
assert(ratingFor('correct', 2, 5000) === Rating.Hard, '答对但用了提示 → Hard');
assert(ratingFor('correct', 0, 8000) === Rating.Good, '正常答对 → Good');
assert(ratingFor('correct', 0, 1500) === Rating.Easy, '秒答 → Easy');

console.log('\n=== 连续答对，间隔应逐步拉长 ===');
let card = newCard('abandon');
let now = Date.now();
const intervals: number[] = [];
for (let i = 0; i < 5; i++) {
  card = applyRating(card, Rating.Good, now);
  intervals.push(daysBetween(now, card.due));
  now = card.due;
}
console.log('间隔天数：', intervals.join(' → '));
assert(intervals[4] > intervals[0], '第 5 次间隔大于第 1 次');
assert(intervals.every((v, i) => i === 0 || v >= intervals[i - 1]), '间隔单调不减');
assert(isMastered(card), '连对 5 次后进入「已掌握」');
assert(cardStage(card) === 'mature', '阶段为 mature');

console.log('\n=== 答错一次，间隔应显著缩短 ===');
const before = daysBetween(Date.now(), card.due);
const lapsed = applyRating(card, Rating.Again, card.due);
const after = daysBetween(card.due, lapsed.due);
console.log(`答错前间隔 ${before} 天，答错后 ${after} 天`);
assert(after < before, '答错后间隔变短');
assert(lapsed.lapses === card.lapses + 1, 'lapses 计数 +1');

console.log('\n=== 新卡第一次作答 ===');
const fresh = newCard('deteriorate');
const first = applyRating(fresh, Rating.Good, Date.now());
console.log(`新卡 → 状态 ${first.state}，${daysBetween(Date.now(), first.due)} 天后复习`);
assert(first.reps === 1 && first.state >= 1, '新卡进入学习/复习状态');
assert(first.due > Date.now(), '到期时间在未来');

console.log('\n=== 复习强度（目标保持率）会改变间隔 ===');
function intervalAfter(retention: number, times: number): number {
  configureSrs(retention);
  let card = newCard('calibrate');
  let now = Date.now();
  for (let i = 0; i < times; i++) {
    card = applyRating(card, Rating.Good, now);
    now = Math.max(card.due, now + 1000);
  }
  return card.scheduled_days;
}
const loose = intervalAfter(0.85, 4);
const standard = intervalAfter(0.9, 4);
const tight = intervalAfter(0.95, 4);
console.log(`目标保持率 85% → ${loose} 天；90% → ${standard} 天；95% → ${tight} 天`);
assert(tight < standard && standard < loose, '目标保持率越高，间隔越短');
configureSrs(0.9);

console.log('\n=== 易忘词保护：反复答错的词不允许间隔拉长 ===');
const now0 = Date.now();
const leechBase: MemCard = {
  ...newCard('stubborn'),
  lapses: 5,
  stability: 200,
  difficulty: 8,
  state: 2,
  reps: 10,
  scheduled_days: 100,
  last_review: now0 - 30 * 86_400_000,
  due: now0,
};
const capped = applyRating(leechBase, Rating.Good, now0);
const cappedDays = (capped.due - now0) / 86_400_000;
console.log(`答错 5 次的词，答对后间隔 ${cappedDays.toFixed(1)} 天（正常应远大于此）`);
assert(cappedDays <= 4.01, '答错 ≥5 次时间隔被压在 4 天内');
assert(isLeech(capped), '标记为易忘词');

const mildBase: MemCard = { ...leechBase, lapses: 3 };
const mild = applyRating(mildBase, Rating.Good, now0);
const mildDays = (mild.due - now0) / 86_400_000;
console.log(`答错 3 次的词，答对后间隔 ${mildDays.toFixed(1)} 天`);
assert(mildDays <= 7.01, '答错 ≥3 次时间隔被压在 7 天内');

console.log('\n=== 记忆保持率（遗忘曲线位置） ===');
const matured = { ...leechBase, lapses: 0, leech: 0, last_review: now0 - 10 * 86_400_000 };
const r0 = retrievability(matured, now0);
const rFresh = retrievability(newCard('brandnew'), now0);
console.log(`成熟词 10 天后保持率 ${(r0 * 100).toFixed(1)}%；新词 ${(rFresh * 100).toFixed(0)}%`);
assert(r0 > 0 && r0 < 1, '成熟词的保持率在 0 与 1 之间');
assert(rFresh === 1, '新词视为完全没忘');

console.log('\n=== 首次见到的词不允许「秒答」直接跳远 ===');
configureSrs(0.9);
const firstEasy = applyRating(newCard('brandnew'), Rating.Easy, Date.now());
const firstEasyMin = (firstEasy.due - Date.now()) / 60_000;
console.log(`新词按 Easy 作答 → ${firstEasyMin.toFixed(0)} 分钟后复习（应约 10 分钟，而不是十几天）`);
assert(firstEasyMin <= 15, '首次作答不会跳到天级间隔');

const secondEasy = applyRating(
  { ...newCard('seen'), reps: 1, state: 2, stability: 3, difficulty: 5, last_review: Date.now() },
  Rating.Easy,
  Date.now(),
);
const secondEasyDays = (secondEasy.due - Date.now()) / 86_400_000;
console.log(`复习过的词按 Easy 作答 → ${secondEasyDays.toFixed(0)} 天后复习（Easy 才生效）`);
assert(secondEasyDays > 1, '见过的词按 Easy 仍可拉长间隔');

console.log(`\n${fails === 0 ? '全部断言通过' : `${fails} 个断言失败`}`);
process.exit(fails === 0 ? 0 : 1);
