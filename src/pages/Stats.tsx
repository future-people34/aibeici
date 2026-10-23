import { useEffect, useMemo, useState } from 'react';
import { kvGet } from '../lib/db';
import { cardStage, isLeech, isMastered } from '../lib/srs';
import { todayKey } from '../lib/settings';
import type { Attempt, MemCard, UsageRecord } from '../lib/types';

interface Props {
  cards: MemCard[];
  attempts: Attempt[];
  forecast: { label: string; count: number }[];
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function Stats({ cards, attempts, forecast }: Props) {
  const [usage, setUsage] = useState<UsageRecord | null>(null);

  useEffect(() => {
    let alive = true;
    kvGet<UsageRecord>(`usage:${todayKey()}`).then((u) => {
      if (alive) setUsage(u ?? null);
    });
    return () => {
      alive = false;
    };
  }, [attempts.length]);

  const stat = useMemo(() => {
    const today = new Date().toDateString();
    const learnedToday = cards.filter((c) => new Date(c.introducedAt).toDateString() === today).length;
    const mastered = cards.filter(isMastered).length;
    const stages = { learning: 0, young: 0, mature: 0 };
    for (const c of cards) {
      const s = cardStage(c);
      if (s === 'learning' || s === 'new') stages.learning++;
      else if (s === 'young') stages.young++;
      else stages.mature++;
    }
    const total = attempts.length;
    const right = attempts.filter((a) => a.verdict === 'correct').length;
    const partial = attempts.filter((a) => a.verdict === 'partial').length;
    const leeches = cards.filter((c) => isLeech(c)).length;

    const counts = new Map<string, number>();
    for (const a of attempts) counts.set(dayKey(a.at), (counts.get(dayKey(a.at)) ?? 0) + 1);

    const cells: { key: string; count: number }[] = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    for (let i = 55; i >= 0; i--) {
      const day = new Date(d.getTime() - i * 86_400_000);
      const k = dayKey(day.getTime());
      cells.push({ key: k, count: counts.get(k) ?? 0 });
    }
    const byDay = [...counts.values()];
    const peak = Math.max(1, ...byDay);

    return {
      learnedToday,
      mastered,
      stages,
      total,
      right,
      partial,
      accuracy: total ? Math.round((right / total) * 100) : 0,
      semi: total ? Math.round(((right + partial * 0.5) / total) * 100) : 0,
      cells,
      peak,
      activeDays: counts.size,
      leeches,
    };
  }, [cards, attempts]);

  const cost = usage
    ? (usage.promptTokens * 2 + usage.completionTokens * 8) / 1_000_000
    : 0;
  return (
    <>
      <div className="grid2" style={{ marginBottom: 14 }}>
        <div className="metric">
          <b>{cards.length}</b>
          <span>累计学过</span>
        </div>
        <div className="metric">
          <b>{stat.mastered}</b>
          <span>已掌握（记忆强度 ≥ 21 天）</span>
        </div>
        <div className="metric">
          <b>{stat.accuracy}%</b>
          <span>一次答对率 · 共 {stat.total} 次作答</span>
        </div>
        <div className="metric">
          <b>{stat.learnedToday}</b>
          <span>今天新学</span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <span>记忆阶段</span>
          <span className="tiny">{stat.activeDays} 天有学习记录</span>
        </div>
        <div className="split" style={{ marginTop: 0 }}>
          <div className="pill">
            <span className="k">学习中</span>
            <b>{stat.stages.learning}</b>
          </div>
          <div className="pill">
            <span className="k">巩固中</span>
            <b>{stat.stages.young}</b>
          </div>
        </div>
        <div className="pill" style={{ marginTop: 10 }}>
          <span className="k">已掌握</span>
          <b>{stat.stages.mature}</b>
        </div>
        <div className="pill" style={{ marginTop: 10 }}>
          <span className="k">易忘词（答错 ≥3 次，间隔被压制）</span>
          <b>{stat.leeches}</b>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <span>最近 8 周</span>
          <span className="tiny">每天作答数量</span>
        </div>
        <div className="heat">
          {stat.cells.map((c) => {
            const level = c.count === 0 ? 0 : Math.min(4, 1 + Math.floor((c.count / stat.peak) * 3));
            return <i key={c.key} data-l={level} title={`${c.key}：${c.count} 次`} />;
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <span>未来 7 天待复习</span>
          <span className="tiny">按当前记忆状态推算</span>
        </div>
        <div className="bars">
          {forecast.map((f) => {
            const max = Math.max(1, ...forecast.map((x) => x.count));
            return (
              <div key={f.label}>
                <i style={{ height: `${Math.max(4, (f.count / max) * 52)}px` }} title={`${f.count} 个`} />
                <span>{f.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <span>今天的模型用量</span>
          <span className="tiny">按 deepseek-chat 价格估算</span>
        </div>
        {usage ? (
          <>
            <div className="split" style={{ marginTop: 0 }}>
              <div className="pill">
                <span className="k">调用</span>
                <b>{usage.calls} 次</b>
              </div>
              <div className="pill">
                <span className="k">估算花费</span>
                <b>¥{cost.toFixed(3)}</b>
              </div>
            </div>
            <p className="tiny muted" style={{ margin: '10px 0 0' }}>
              输入 {usage.promptTokens.toLocaleString()} tokens · 输出{' '}
              {usage.completionTokens.toLocaleString()} tokens。本地规则命中的判分不会调用模型，所以实际调用次数远低于作答次数。
            </p>
          </>
        ) : (
          <p className="tiny muted" style={{ margin: 0 }}>
            今天还没有调用过模型。所有能本地判定的答案都会直接判掉，不花钱。
          </p>
        )}
      </div>
    </>
  );
}
