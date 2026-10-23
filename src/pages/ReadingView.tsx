import { useEffect, useMemo, useState } from 'react';
import { getWord, pronounce } from '../lib/dict';
import { generateReading, translateReading } from '../lib/reading';
import { todayKey } from '../lib/settings';
import type { Reading, Settings, Word } from '../lib/types';

interface Props {
  preload: Promise<Reading> | null;
  settings: Settings;
  targets: Word[];
  onExit: () => void;
}

const STEPS = ['正在根据今天的词构思文体…', '正在把目标词织进句子里…', '正在出题并核对答案…'];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default function ReadingView({ preload, settings, targets, onExit }: Props) {
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(true);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [translation, setTranslation] = useState('');
  const [transLoading, setTransLoading] = useState(false);
  const [transError, setTransError] = useState('');

  useEffect(() => {
    let alive = true;
    const task =
      preload ??
      (targets.length
        ? generateReading({ date: todayKey(), targets, settings })
        : Promise.reject(new Error('今天还没有要复习的词，先去学几个吧。')));
    task
      .then((r) => {
        if (alive) setReading(r);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message || e));
      })
      .finally(() => {
        if (alive) setWaiting(false);
      });
    const timer = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 3200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 交卷后才生成全文翻译（按文章缓存，同一篇只翻一次） */
  const loadTranslation = async () => {
    if (!reading || transLoading) return;
    setTransLoading(true);
    setTransError('');
    try {
      const text = await translateReading(reading, settings);
      setTranslation(text);
    } catch (e) {
      setTransError(String((e as Error)?.message || e));
    } finally {
      setTransLoading(false);
    }
  };

  useEffect(() => {
    if (!submitted || !reading || translation || transLoading || transError) return;
    void loadTranslation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, reading]);

  /** 本文出现的生词（按文章顺序去重） */
  const vocab = useMemo(() => {
    if (!reading) return [] as Word[];
    return reading.covered
      .map((w) => getWord(w))
      .filter((w): w is Word => Boolean(w));
  }, [reading]);

  const markRe = useMemo(() => {
    if (!reading) return null;
    const forms = new Set<string>();
    for (const w of reading.covered) {
      const word = getWord(w);
      for (const f of word?.forms ?? [w]) if (f) forms.add(f.toLowerCase());
      forms.add(w.toLowerCase());
    }
    const list = [...forms].sort((a, b) => b.length - a.length);
    if (!list.length) return null;
    return new RegExp(`\\b(${list.map(escapeRe).join('|')})\\b`, 'gi');
  }, [reading]);

  const renderParagraph = (text: string, key: number) => {
    if (!markRe) return <p key={key}>{text}</p>;
    const segs = text.split(markRe);
    return (
      <p key={key}>
        {segs.map((seg, i) =>
          i % 2 === 1 ? (
            <span
              className="mark"
              key={i}
              onClick={() => void pronounce(seg, settings.speakMode)}
              title="点击朗读"
            >
              {seg}
            </span>
          ) : (
            <span key={i}>{seg}</span>
          ),
        )}
      </p>
    );
  };

  const score = reading ? reading.questions.filter((q, i) => answers[i] === q.answer).length : 0;

  if (waiting) {
    return (
      <div className="overlay">
        <div className="overlay-inner">
          <div className="study-head">
            <button className="icon-btn" onClick={onExit} aria-label="返回">
              ✕
            </button>
            <div className="progress">
              <i style={{ width: '45%' }} />
            </div>
          </div>
          <div className="finish">
            <div className="spinner" />
            <h2 style={{ marginTop: 22, fontSize: 17 }}>正在写今天的阅读</h2>
            <p className="muted tiny" style={{ maxWidth: 300, margin: '6px auto 0' }}>
              {STEPS[step]}
            </p>
            <p className="tiny muted" style={{ maxWidth: 320, margin: '18px auto 0' }}>
              文章会把你今天学的 {Math.min(18, targets.length)} 个词尽量都用进去，通常 10–25 秒。
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !reading) {
    return (
      <div className="overlay">
        <div className="overlay-inner">
          <div className="study-head">
            <button className="icon-btn" onClick={onExit} aria-label="返回">
              ✕
            </button>
            <div className="progress">
              <i style={{ width: '100%' }} />
            </div>
          </div>
          <div className="finish">
            <div className="notice err" style={{ textAlign: 'left' }}>
              {error || '没有生成文章'}
            </div>
            <p className="tiny muted">
              检查一下「设置」里的模型配置；也可以直接回到今日，明天再试。
            </p>
            <button className="btn btn-ghost" onClick={onExit}>
              回到今日
            </button>
          </div>
        </div>
      </div>
    );
  }

  const paragraphs = reading.body.split(/\n+/).filter(Boolean);

  return (
    <div className="overlay">
      <div className="overlay-inner">
        <div className="study-head">
          <button className="icon-btn" onClick={onExit} aria-label="返回">
            ✕
          </button>
          <div className="progress">
            <i style={{ width: '100%' }} />
          </div>
          <div className="counter">{reading.body.split(/\s+/).length} 词</div>
        </div>

        <h1
          style={{
            fontFamily: "'Iowan Old Style', Georgia, serif",
            fontSize: 24,
            lineHeight: 1.3,
            margin: '6px 0 14px',
          }}
        >
          {reading.title}
        </h1>

        <div className="reading-body">{paragraphs.map((p, i) => renderParagraph(p, i))}</div>

        <p className="tiny muted">
          划线的词是今天的目标词（{reading.covered.length} 个）。
          {reading.missing.length > 0 && ` 还有 ${reading.missing.length} 个没能写进去：${reading.missing.join('、')}。`}
        </p>

        <hr className="sep" />

        <div className="card-title" style={{ marginBottom: 4 }}>
          <span>理解检查</span>
          <span className="tiny">{submitted ? `答对 ${score} / ${reading.questions.length}` : '做完再看解析'}</span>
        </div>

        {reading.questions.map((q, qi) => {
          const picked = answers[qi];
          return (
            <div className="q" key={qi}>
              <h4>
                {qi + 1}. {q.q}
              </h4>
              {q.options.map((opt, oi) => {
                const cls = submitted
                  ? oi === q.answer
                    ? 'opt ok'
                    : oi === picked
                      ? 'opt bad'
                      : 'opt'
                  : picked === oi
                    ? 'opt sel'
                    : 'opt';
                return (
                  <button
                    key={oi}
                    className={cls}
                    onClick={() => !submitted && setAnswers((a) => ({ ...a, [qi]: oi }))}
                    disabled={submitted}
                  >
                    <span className="k">{String.fromCharCode(65 + oi)}</span>
                    <span>{opt}</span>
                  </button>
                );
              })}
              {submitted && q.explain && <div className="explain">{q.explain}</div>}
            </div>
          );
        })}

        <div style={{ marginTop: 18 }}>
          {submitted ? (
            <>
              {/* 复盘：本文生词 + 全文翻译 */}
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-title">
                  <span>本文生词（{vocab.length} 个）</span>
                  <span className="tiny">点单词可朗读</span>
                </div>
                <div className="wl">
                  {vocab.map((w) => (
                    <button
                      key={w.w}
                      type="button"
                      className="wl-row"
                      onClick={() => void pronounce(w.w, settings.speakMode)}
                      title="点击朗读"
                    >
                      <span className="wl-word">{w.w}</span>
                      <span className="wl-cn">
                        {w.senses
                          .map((s) => `${s.p ? `${s.p}. ` : ''}${s.cn}`)
                          .join('；')
                          .slice(0, 72)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="card">
                <div className="card-title">
                  <span>全文翻译</span>
                  <span className="tiny">{transLoading ? '正在翻译…' : translation ? '对照阅读用' : ''}</span>
                </div>
                {translation ? (
                  <div className="trans">
                    {translation
                      .split(/\n+/)
                      .filter(Boolean)
                      .map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                  </div>
                ) : transError ? (
                  <>
                    <p className="tiny muted" style={{ marginTop: 0 }}>
                      翻译失败：{transError}
                    </p>
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setTransError('');
                        void loadTranslation();
                      }}
                    >
                      重新翻译
                    </button>
                  </>
                ) : (
                  <div className="center" style={{ padding: '12px 0' }}>
                    <div className="spinner" />
                  </div>
                )}
              </div>

              <div style={{ marginTop: 18 }}>
                <button className="btn btn-primary" onClick={onExit}>
                  完成 ✓
                </button>
              </div>
            </>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => setSubmitted(true)}
              disabled={Object.keys(answers).length < reading.questions.length}
            >
              提交答案
            </button>
          )}
        </div>
        <div style={{ height: 20 }} />
      </div>
    </div>
  );
}
