/**
 * 打印 FSRS 在真实参数下给出的到期时间间隔，用来回答「第二天复习哪些词」
 *   node_modules/@esbuild/win32-x64/esbuild.exe scripts/selftest-timing.ts --bundle --platform=node --format=esm --outfile=data/tmp/selftest-timing.mjs
 *   node data/tmp/selftest-timing.mjs
 */
import { Rating } from 'ts-fsrs';
import { applyRating, newCard } from '../src/lib/srs';
import type { MemCard } from '../src/lib/types';

function fmt(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60 * 1000) return `${Math.round(abs / 1000)} 秒`;
  if (abs < 3600 * 1000) return `${Math.round(abs / 60000)} 分钟`;
  if (abs < 86400 * 1000) return `${(abs / 3600000).toFixed(1)} 小时`;
  return `${(abs / 86400000).toFixed(1)} 天`;
}

function trace(label: string, ratings: Rating[]) {
  console.log(`\n【${label}】`);
  const now = Date.now();
  let card: MemCard = newCard('demo');
  let t = now;
  let step = 0;
  for (const r of ratings) {
    card = applyRating(card, r, t);
    step++;
    const delta = card.due - t;
    const name = r === Rating.Again ? 'Again(答错)' : r === Rating.Hard ? 'Hard(提示)' : r === Rating.Good ? 'Good(答对)' : 'Easy(秒答)';
    console.log(
      `  第${step}次 ${name.padEnd(12)} → 状态 ${card.state}  due = 现在 +${fmt(delta).padEnd(8)} (${new Date(card.due).toLocaleString('zh-CN')})`,
    );
    t = card.due > t ? card.due : t + 60_000; // 模拟到期后再复习
  }
  return card;
}

console.log('当前时间：', new Date().toLocaleString('zh-CN'));

trace('新词第一次就答对（Good）', [Rating.Good]);
trace('新词第一次用了提示（Hard）', [Rating.Hard]);
trace('新词直接看答案（Again）', [Rating.Again]);
trace('连续答对，看间隔怎么拉开', [Rating.Good, Rating.Good, Rating.Good, Rating.Good]);
