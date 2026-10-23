import { useEffect, useRef, useState } from 'react';
import SpeakerButton from '../components/SpeakerButton';
import { getWord, pronounce } from '../lib/dict';
import { hintCount, hintFor, judge } from '../lib/judge';
import { humanInterval, isLeech } from '../lib/srs';
import type { DayPlan, JudgeResult, MemCard, Settings, Word } from '../lib/types';
import type { AnswerPayload } from '../App';

type Item = { word: Word; type: 'new' | 'review'; retry?: number };

interface Props {
  plan: DayPlan;
  settings: Settings;
  onAnswer: (p: AnswerPayload) => Promise<MemCard>;
  onExit: () => void;
  onFinish: () => void;
  hasReading: boolean;
}

/** 同一个词当天最多再考 2 次，整场最多插入 12 次，避免答错一堆时队列无限膨胀 */
const RETRY_MAX_PER_WORD = 2;
const RETRY_MAX_TOTAL = 12;
/** 答错后隔 3 个词再考一次（相当于遗忘曲线最陡的那一段） */
const RETRY_GAP = 3;

function buildQueue(plan: DayPlan): Item[] {
  const out: Item[] = [];
  for (const id of plan.reviewIds) {
    if (plan.reviewDone.includes(id)) continue;
    const w = getWord(id);
    if (w) out.push({ word: w, type: 'review' });
  }
  for (const id of plan.newIds) {
    if (plan.newDone.includes(id)) continue;
    const w = getWord(id);
    if (w) out.push({ word: w, type: 'new' });
  }
  return out;
}

const VERDICT_LABEL: Record<string, string> = {
  correct: '答对了',
  partial: '部分正确',
  wrong: '答错了',
};

export default function Study({ plan, settings, onAnswer, onExit, onFinish, hasReading }: Props) {
  const [queue, setQueue] = useState<Item[]>(() => buildQueue(plan));
  const [idx, setIdx] = useState(0);
  const [answered, setAnswered] = useState(0);
  const [input, setInput] = useState('');
  const [hintLevel, setHintLevel] = useState(0);
  const [phase, setPhase] = useState<'input' | 'judging' | 'result'>('input');
  const [result, setResult] = useState<JudgeResult | null>(null);
  const [rated, setRated] = useState<MemCard | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [log, setLog] = useState<{ verdict: string; hint: number; type: 'new' | 'review'; retry: boolean }[]>([]);
  const [retryCount, setRetryCount] = useState(0);
  const startedAt = useRef(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const retries = useRef<Map<string, number>>(new Map());
  const retryTotal = useRef(0);

  const current = queue[idx];
  const finished = idx >= queue.length;
  const remaining = Math.max(0, queue.length - idx);
  const progress = answered + remaining > 0 ? answered / (answered + remaining) : 0;

  useEffect(() => {
    if (!current) return;
    startedAt.current = Date.now();
    setInput('');
    setHintLevel(0);
    setResult(null);
    setRated(null);
    setPhase('input');
    setRevealed(false);
    if (settings.autoSpeak) void pronounce(current.word.w, settings.speakMode);
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(t);
    // 仅在切换单词时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  /** 当场答错的词，隔几个词再考一次（次日还会再复习，这里是遗忘曲线最陡的一段） */
  const scheduleRetry = (item: Item) => {
    const id = item.word.w.toLowerCase();
    const used = retries.current.get(id) ?? 0;
    if (used >= RETRY_MAX_PER_WORD || retryTotal.current >= RETRY_MAX_TOTAL) return;
    retries.current.set(id, used + 1);
    retryTotal.current += 1;
    setRetryCount(retryTotal.current);
    setQueue((q) => {
      const at = Math.min(q.length, idx + 1 + RETRY_GAP);
      const copy = [...q];
      copy.splice(at, 0, { ...item, retry: used + 1 });
      return copy;
    });
  };

  if (finished || !current) {
    const total = log.length;
    const right = log.filter((l) => l.verdict === 'correct' && l.hint === 0 && !l.retry).length;
    const newCount = log.filter((l) => l.type === 'new' && !l.retry).length;
    const revCount = log.filter((l) => l.type === 'review' && !l.retry).length;
    return (
      <div className="overlay">
        <div className="overlay-inner">
          <div className="finish">
            <div className="big">✓</div>
            <h2 style={{ margin: '10px 0 6px' }}>{total ? '这一轮学完了' : '今天已经没有要学的词了'}</h2>
            {total > 0 && (
              <p className="muted" style={{ margin: 0, lineHeight: 1.8 }}>
                作答 {total} 次 · 一次答对 {right} 个（{Math.round((right / Math.max(1, newCount + revCount)) * 100)}%）
                <br />
                新词 {newCount} / 复习 {revCount}
                {retryCount > 0 && ` / 当场重考 ${retryCount} 次`}
              </p>
            )}
            <div style={{ marginTop: 28 }}>
              {hasReading ? (
                <button className="btn btn-primary" onClick={onFinish} disabled={!total}>
                  去读今天的文章 →
                </button>
              ) : (
                <button className="btn btn-primary" onClick={onExit}>
                  回到今日
                </button>
              )}
              <button className="btn btn-quiet" style={{ marginTop: 8 }} onClick={onExit}>
                先不读，回到今日
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const submit = async () => {
    const text = input.trim();
    if (!text || phase !== 'input') return;
    setPhase('judging');
    const ms = Date.now() - startedAt.current;
    const res = await judge(current.word, text, settings);
    setResult(res);
    setPhase('result');
    setAnswered((n) => n + 1);
    setLog((l) => [...l, { verdict: res.verdict, hint: hintLevel, type: current.type, retry: Boolean(current.retry) }]);
    const card = await onAnswer({ word: current.word, type: current.type, input: text, hint: hintLevel, ms, result: res });
    setRated(card ?? null);
    if (res.verdict === 'wrong') scheduleRetry(current);
  };

  const giveUp = async () => {
    if (phase !== 'input') return;
    const maxHints = hintCount(current.word);
    // 还有可用线索就再给一级，把线索用完了才直接给答案
    if (hintLevel < maxHints) {
      setHintLevel(hintLevel + 1);
      return;
    }
    const res: JudgeResult = {
      verdict: 'wrong',
      matched: 0,
      reason: '这次直接看了答案。记住它的样子，等下会再考你一次。',
      hint: '',
      source: 'rule',
    };
    setHintLevel(maxHints);
    setResult(res);
    setRevealed(true);
    setPhase('result');
    setAnswered((n) => n + 1);
    setLog((l) => [...l, { verdict: 'wrong', hint: maxHints, type: current.type, retry: Boolean(current.retry) }]);
    const card = await onAnswer({
      word: current.word,
      type: current.type,
      input: '',
      hint: maxHints,
      ms: Date.now() - startedAt.current,
      result: res,
    });
    setRated(card ?? null);
    scheduleRetry(current);
  };

  const next = () => setIdx((i) => i + 1);

  const word = current.word;
  const phonetic = word.uk || word.us || word.ph;
  const verdictClass = result ? `v-${result.verdict}` : '';

  return (
    <div className="overlay">
      <div className="overlay-inner">
        <div className="study-head">
          <button className="icon-btn" onClick={onExit} aria-label="退出">
            ✕
          </button>
          <div className="progress">
            <i style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="counter">
            {Math.min(answered + 1, answered + remaining)}/{answered + remaining}
          </div>
        </div>

        <div className="word-block">
          <div
            className="word"
            onClick={() => void pronounce(word.w, settings.speakMode)}
            title="点击单词也可以朗读"
          >
            {word.w}
          </div>
          <div className="phonetic">
            {settings.showPhonetic && phonetic && <span>/{phonetic}/</span>}
            <SpeakerButton text={word.w} mode={settings.speakMode} />
          </div>
          <div style={{ marginTop: 12 }}>
            {current.retry ? (
              <span className="tag retry">当场重考 {current.retry}</span>
            ) : (
              <span className={`tag ${current.type}`}>{current.type === 'new' ? '新词' : '复习'}</span>
            )}
          </div>
        </div>

        {phase === 'input' && (
          <>
            {hintLevel > 0 && (
              <div className="hint">
                <div>{hintFor(word, hintLevel)}</div>
                {hintLevel < hintCount(word) && (
                  <div className="tiny muted" style={{ marginTop: 6 }}>
                    还有 {hintCount(word) - hintLevel} 级提示
                  </div>
                )}
              </div>
            )}
            <div className="answer-area">
              <input
                ref={inputRef}
                className="input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                placeholder="写下它的中文意思…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="go"
              />
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button
                  className="btn btn-ghost"
                  style={{ flex: '0 0 40%' }}
                  onClick={giveUp}
                  disabled={phase !== 'input'}
                >
                  {hintLevel === 0 ? '不认识' : hintLevel < hintCount(word) ? '再给点提示' : '直接看答案'}
                </button>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={submit} disabled={!input.trim()}>
                  提交
                </button>
              </div>
            </div>
          </>
        )}

        {phase === 'judging' && (
          <div className="answer-area center" style={{ paddingBottom: 40 }}>
            <div className="spinner" />
            <p className="tiny muted" style={{ marginTop: 12 }}>
              正在核对你的答案…
            </p>
          </div>
        )}

        {phase === 'result' && result && (
          <div className="result answer-area">
            <div className={`verdict ${verdictClass}`}>
              <span className="dot" />
              {revealed ? '已给出答案' : VERDICT_LABEL[result.verdict]}
              {result.source === 'llm' && <span className="tiny muted">· 模型判定</span>}
            </div>

            {input.trim() && (
              <div className="your-answer">
                你写的：<b style={{ color: 'var(--ink-2)' }}>{input.trim()}</b>
              </div>
            )}

            <div>
              {word.senses.map((s, i) => (
                <div className={`sense ${result.matched === i + 1 ? 'hit' : ''}`} key={i}>
                  <span className="pos">{s.p || '—'}</span>
                  <span>
                    {s.cn}
                    {s.en && <span className="en">{s.en}</span>}
                  </span>
                </div>
              ))}
            </div>

            {result.reason && (
              <div className="reason">
                <b>点评</b>　{result.reason}
              </div>
            )}
            {result.hint && (
              <div className="reason" style={{ background: 'var(--amber-soft)' }}>
                <b>记法</b>　{result.hint}
              </div>
            )}

            {word.ex[0] && (
              <div className="example">
                <div className="ex-line">
                  <span>{word.ex[0].en}</span>
                  <SpeakerButton text={word.ex[0].en} mode={settings.speakMode} size="sm" />
                </div>
                <em>{word.ex[0].cn}</em>
              </div>
            )}

            {rated && (
              <div className="schedule" title="按遗忘曲线算出的下次复习时间">
                <span>下次复习</span>
                <b>{humanInterval(rated.due - Date.now())}</b>
                {isLeech(rated) && <em>已答错 {rated.lapses} 次，间隔被限制</em>}
              </div>
            )}

            <div style={{ marginTop: 18 }}>
              <button
                className="btn btn-primary"
                onClick={next}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') next();
                }}
              >
                {idx + 1 >= queue.length ? '完成这一轮' : '下一个 →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
