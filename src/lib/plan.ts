import { idbAll, idbPut, kvGet, kvSet } from './db';
import { poolOf } from './dict';
import { endOfToday, todayKey } from './settings';
import type { Attempt, DayPlan, MemCard, Settings, Word } from './types';

export async function loadCards(): Promise<MemCard[]> {
  return idbAll<MemCard>('cards');
}

export async function saveCard(card: MemCard): Promise<void> {
  await idbPut('cards', card);
}

/** 到期判断：到期时间 ≤ 今天 23:59:59.999 的都算「今天该复习」 */
export function dueCards(cards: MemCard[]): MemCard[] {
  const limit = endOfToday();
  return cards.filter((c) => c.due <= limit).sort((a, b) => a.due - b.due);
}

/** 今天到点但还没复习的、答错次数多的词，排在队列最前面 */
function overdueRank(c: MemCard): number {
  return (c.leech ?? 0) >= 3 ? 0 : 1;
}

/**
 * 生成（或读取）当天的学习计划。
 *
 * 复习词的选择完全由每个词的到期时间决定：
 *   due ≤ 今天结束  → 进队列，按到期时间升序（拖最久的先复习）
 *   超出每日上限的部分顺延到明天（due 仍然是过期状态，不会丢）
 *
 * 新词量会被三重因素下调，避免复习雪崩：
 *   ① 今天待复习数量 ≥ 上限            → 降到 1/3
 *   ② 今天待复习数量 > 上限的 80%      → 减半
 *   ③ 最近 3 天正确率低于 65%           → 再打 6 折（说明整体没记牢，先消化旧的）
 */
export async function getPlan(words: Word[], settings: Settings): Promise<{ plan: DayPlan; note?: string }> {
  const date = todayKey();
  const saved = await kvGet<DayPlan>(`plan:${date}`);
  if (saved) return { plan: saved, note: saved.note };

  const cards = await loadCards();
  const known = new Set(cards.map((c) => c.id));
  const pool = poolOf(words, settings.pool);

  const due = dueCards(cards);
  const cap = Math.max(10, settings.dailyReviewCap);
  // 易忘词优先，其余按到期时间升序（最该复习的在最前）
  const reviewIds = [...due]
    .sort((a, b) => overdueRank(a) - overdueRank(b) || a.due - b.due)
    .slice(0, cap)
    .map((c) => c.w);

  let newBudget = Math.max(0, settings.dailyNew);
  const notes: string[] = [];

  if (due.length >= cap) {
    newBudget = Math.max(3, Math.floor(newBudget / 3));
    notes.push(`今天待复习 ${due.length} 个，已超过上限，新词量自动降到 ${newBudget} 个`);
  } else if (due.length > cap * 0.8) {
    newBudget = Math.max(5, Math.floor(newBudget / 2));
    notes.push(`今天待复习 ${due.length} 个，比较重，新词量临时减半到 ${newBudget} 个`);
  }

  // 用最近 3 天的实际作答表现再调一次：整体正确率低就先别加新词
  const attempts = await idbAll<Attempt>('attempts');
  const cutoff = Date.now() - 3 * 86_400_000;
  const recent = attempts.filter((a) => a.at >= cutoff);
  if (recent.length >= 15) {
    const accuracy = recent.filter((a) => a.verdict === 'correct').length / recent.length;
    if (accuracy < 0.65 && newBudget > 3) {
      const before = newBudget;
      newBudget = Math.max(3, Math.floor(newBudget * 0.6));
      notes.push(
        `最近 3 天正确率只有 ${Math.round(accuracy * 100)}%，新词量从 ${before} 降到 ${newBudget} 个`,
      );
    }
  }

  const newIds = pool
    .filter((w) => !known.has(w.w.toLowerCase()))
    .slice(0, newBudget)
    .map((w) => w.w);

  const plan: DayPlan = {
    date,
    newIds,
    reviewIds,
    newDone: [],
    reviewDone: [],
    note: notes.length ? notes.join('；') + '。' : undefined,
  };
  await kvSet(`plan:${date}`, plan);
  return { plan, note: plan.note };
}

export async function savePlan(plan: DayPlan): Promise<void> {
  await kvSet(`plan:${plan.date}`, plan);
}

/** 未来若干天「待复习」的真实预测（基于现有卡片到期时间） */
export function dueForecast(cards: MemCard[], days = 7): { label: string; count: number }[] {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const out: { label: string; count: number }[] = [];
  for (let i = 1; i <= days; i++) {
    const start = base.getTime() + i * 86_400_000;
    const end = start + 86_400_000;
    const count = cards.filter((c) => c.due > start && c.due <= end).length;
    const d = new Date(start);
    out.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, count });
  }
  return out;
}
