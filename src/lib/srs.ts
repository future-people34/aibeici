import { fsrs, Rating, type Card as FsrsCard, type Grade } from 'ts-fsrs';
import type { MemCard, Verdict } from './types';

/**
 * 调度基于 FSRS，它本身就是艾宾浩斯遗忘曲线的数据拟合版本：
 * 记忆保持率 R(t, S) = (1 + FACTOR·t/S)^DECAY，每次作答的评分（Again/Hard/Good/Easy）
 * 会更新这个词的「记忆强度 S」和「难度 D」，下次间隔就按想要的保持率反算出来。
 *
 * 这里额外加了两件事：
 *  1) 复习强度可调（目标保持率），相当于让曲线更陡或更平；
 *  2) 易忘词保护：同一个词反复答错，就把它的间隔强行压回去，不允许它「假装记住了」。
 */

/** 目标记忆保持率：越高，复习越密、间隔越短 */
const DEFAULT_RETENTION = 0.9;

/** 答错到这个次数就进入易忘词名单，限制最大间隔 */
const LEECH_SOFT = 3;
const LEECH_HARD = 5;
const LEECH_CAP_SOFT_DAYS = 7;
const LEECH_CAP_HARD_DAYS = 4;

let retention = DEFAULT_RETENTION;
let scheduler = buildScheduler();

function buildScheduler() {
  return fsrs({
    request_retention: retention,
    // 365 天封顶，避免早期版本算出十年后这种荒唐间隔
    maximum_interval: 365,
    enable_fuzz: false,
    enable_short_term: true,
  });
}

/** 切换复习强度；只影响之后的评分，已排好的日期不变 */
export function configureSrs(value?: number): void {
  const next = value && value > 0.5 && value <= 0.99 ? value : DEFAULT_RETENTION;
  if (Math.abs(next - retention) < 1e-9) return;
  retention = next;
  scheduler = buildScheduler();
}

export function currentRetention(): number {
  return retention;
}

export function newCard(w: string): MemCard {
  const now = Date.now();
  return {
    id: w.toLowerCase(),
    w,
    due: now,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    introducedAt: now,
    seen: 0,
    okCount: 0,
  };
}

function toFsrs(c: MemCard): FsrsCard {
  return {
    due: new Date(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review ? new Date(c.last_review) : undefined,
  } as FsrsCard;
}

/**
 * 把一次作答映射成 FSRS 评分：
 *  - 判错 / 直接看答案      → Again(1)  间隔压回最短，明天一定再考
 *  - 部分正确 / 用了提示    → Hard(2)
 *  - 正确                   → Good(3)
 *  - 正确且秒答（<3s、无提示）→ Easy(4)
 */
export function ratingFor(verdict: Verdict, hintLevel: number, ms: number): Rating {
  if (verdict === 'wrong') return Rating.Again;
  if (verdict === 'partial') return Rating.Hard;
  if (hintLevel > 0) return Rating.Hard;
  if (ms < 3000) return Rating.Easy;
  return Rating.Good;
}

export function applyRating(card: MemCard, rating: Rating, now = Date.now()): MemCard {
  // 从没见过的词不该因为「秒答」直接跳到十几天后：首次作答最多给到 Good。
  // （Easy 在 FSRS 里表示「明显很熟」，而刚出现的词谈不上熟。）
  const effective = card.reps === 0 && rating === Rating.Easy ? Rating.Good : rating;
  const item = scheduler.next(toFsrs(card), new Date(now), effective as unknown as Grade);
  const next = item.card;
  const ok = effective !== Rating.Again;

  let due = +next.due;
  const lapses = next.lapses;

  // 易忘词保护：反复答错的词，不管算法算出多长，都压回 7 天 / 4 天以内
  const capDays =
    lapses >= LEECH_HARD ? LEECH_CAP_HARD_DAYS : lapses >= LEECH_SOFT ? LEECH_CAP_SOFT_DAYS : 0;
  if (capDays > 0) {
    const capAt = now + capDays * 86_400_000;
    if (due > capAt) due = capAt;
  }

  return {
    ...card,
    due,
    stability: next.stability,
    difficulty: next.difficulty,
    elapsed_days: next.elapsed_days,
    scheduled_days: next.scheduled_days,
    reps: next.reps,
    lapses,
    state: next.state,
    last_review: now,
    seen: card.seen + 1,
    okCount: card.okCount + (ok ? 1 : 0),
    leech: lapses >= LEECH_SOFT ? lapses : card.leech,
  };
}

/** 当前记忆保持率（0-1）：用来直观展示遗忘曲线上的位置 */
export function retrievability(card: MemCard, now = Date.now()): number {
  if (card.reps === 0 || card.stability <= 0) return 1;
  try {
    const r = scheduler.get_retrievability(toFsrs(card), new Date(now), false);
    const n = typeof r === 'number' ? r : Number(r);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  } catch {
    return 0;
  }
}

/** 把毫秒差写成「10 分钟后 / 4 天后」这种人话 */
export function humanInterval(ms: number): string {
  const minute = 60_000;
  if (ms < 45_000) return '马上';
  const m = Math.round(ms / minute);
  if (m < 60) return `${m} 分钟后`;
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `${h} 小时后`;
  const d = Math.round(ms / 86_400_000);
  if (d < 30) return `${d} 天后`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `约 ${mo} 个月后`;
  return `约 ${(d / 365).toFixed(1)} 年后`;
}

/** 预计下次复习间隔（天） */
export function intervalDays(card: MemCard): number {
  const ms = card.due - (card.last_review ?? card.introducedAt);
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function isMastered(card: MemCard): boolean {
  return card.state === 2 && card.stability >= 21;
}

export function isLeech(card: MemCard): boolean {
  return (card.leech ?? card.lapses) >= LEECH_SOFT;
}

export function cardStage(card: MemCard): 'new' | 'learning' | 'young' | 'mature' {
  if (card.reps === 0) return 'new';
  if (card.state === 0 || card.state === 1 || card.state === 3) return 'learning';
  return card.stability >= 21 ? 'mature' : 'young';
}
