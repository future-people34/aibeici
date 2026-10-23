import type { Attempt, DayPlan, MemCard, Settings } from '../lib/types';

interface Props {
  plan: DayPlan | null;
  cards: MemCard[];
  attempts: Attempt[];
  settings: Settings;
  totalWords: number;
  forecast: { label: string; count: number }[];
  dueCount: number;
  onStart: () => void;
  onReading: () => void;
}

function streakOf(attempts: Attempt[]): number {
  const days = new Set(attempts.map((a) => new Date(a.at).toDateString()));
  const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(d.toDateString())) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

const R = 42;
const C = 2 * Math.PI * R;

export default function Today({
  plan,
  cards,
  attempts,
  settings,
  totalWords,
  forecast,
  dueCount,
  onStart,
  onReading,
}: Props) {
  const newLeft = plan ? plan.newIds.filter((w) => !plan.newDone.includes(w)) : [];
  const revLeft = plan ? plan.reviewIds.filter((w) => !plan.reviewDone.includes(w)) : [];
  const newDone = plan ? plan.newIds.length - newLeft.length : 0;
  const revDone = plan ? plan.reviewIds.length - revLeft.length : 0;
  const assigned = (plan?.newIds.length ?? 0) + (plan?.reviewIds.length ?? 0);
  const done = newDone + revDone;
  const left = newLeft.length + revLeft.length;
  const pct = assigned ? done / assigned : 0;
  const finished = assigned > 0 && left === 0;
  const minutes = Math.round(newLeft.length * 0.5 + revLeft.length * 0.25);
  const streak = streakOf(attempts);
  const maxF = Math.max(1, ...forecast.map((f) => f.count));

  return (
    <>
      <div className="card">
        <div className="hero">
          <div className="ring">
            <svg width="96" height="96" viewBox="0 0 96 96">
              <circle cx="48" cy="48" r={R} fill="none" stroke="#ece7db" strokeWidth="8" />
              <circle
                cx="48"
                cy="48"
                r={R}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - pct)}
                style={{ transition: 'stroke-dashoffset .5s ease' }}
              />
            </svg>
            <div className="ring-label">
              <b>{Math.round(pct * 100)}%</b>
              <span>今日</span>
            </div>
          </div>
          <div className="hero-text">
            {finished ? (
              <>
                <h2>今天的任务完成了</h2>
                <p>已学 {done} 个词，去读一篇文章巩固一下。</p>
              </>
            ) : assigned === 0 ? (
              <>
                <h2>词库已学完</h2>
                <p>当前范围内的单词都学过了，可以到设置里切换到「六级全量」。</p>
              </>
            ) : (
              <>
                <h2>还剩 {left} 个词</h2>
                <p>约 {minutes} 分钟 · 单词 {totalWords} 个 · 已学 {cards.length} 个</p>
              </>
            )}
          </div>
        </div>

        <div className="split">
          <div className="pill">
            <span className="k">新词</span>
            <b>
              {newDone}/{plan?.newIds.length ?? 0}
            </b>
          </div>
          <div className="pill">
            <span className="k">复习</span>
            <b>
              {revDone}/{plan?.reviewIds.length ?? 0}
            </b>
          </div>
        </div>

        {plan?.note && <div className="notice" style={{ marginTop: 14, marginBottom: 0 }}>{plan.note}</div>}

        <div style={{ marginTop: 16 }}>
          {finished ? (
            <button className="btn btn-primary" onClick={onReading}>
              读今天的文章 →
            </button>
          ) : assigned === 0 ? (
            <button className="btn btn-ghost" onClick={onReading}>
              去读一篇文章
            </button>
          ) : (
            <button className="btn btn-primary" onClick={onStart}>
              {done > 0 ? '继续学习' : '开始学习'} · {left} 词
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <span>接下来几天</span>
          <span className="tiny">待复习数量（按现有记忆状态推算）</span>
        </div>
        <div className="bars">
          {forecast.map((f) => (
            <div key={f.label}>
              <i style={{ height: `${Math.max(4, (f.count / maxF) * 52)}px` }} title={`${f.count} 个`} />
              <span>{f.label}</span>
            </div>
          ))}
        </div>
        <p className="tiny muted" style={{ margin: '10px 0 0' }}>
          今天到期复习 {dueCount} 个 · 每日复习上限 {settings.dailyReviewCap} 个
        </p>
      </div>

      <div className="grid2">
        <div className="metric">
          <b>{streak} 天</b>
          <span>连续学习</span>
        </div>
        <div className="metric">
          <b>{cards.length}</b>
          <span>累计学过（词）</span>
        </div>
      </div>
    </>
  );
}
