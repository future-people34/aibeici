import { useCallback, useEffect, useRef, useState } from 'react';
import { getWord, loadDict } from './lib/dict';
import { idbAll, idbClear, idbDel, idbPut } from './lib/db';
import { probeProxy } from './lib/llm';
import { dueCards, dueForecast, getPlan, loadCards, saveCard, savePlan } from './lib/plan';
import { generateReading } from './lib/reading';
import { applyRating, configureSrs, newCard, ratingFor } from './lib/srs';
import { loadSettings, saveSettings, todayKey } from './lib/settings';
import type { Attempt, DayPlan, JudgeResult, MemCard, Reading, Settings, Word } from './lib/types';
import FirstRun from './pages/FirstRun';
import ReadingView from './pages/ReadingView';
import SettingsPage from './pages/SettingsPage';
import Stats from './pages/Stats';
import Study from './pages/Study';
import Today from './pages/Today';

type Tab = 'today' | 'stats' | 'settings';
type Overlay = 'none' | 'study' | 'reading';
/** 首次使用：还没有 Key 时先引导用户填 */
type KeyState = 'checking' | 'needs' | 'ok';

export interface AnswerPayload {
  word: Word;
  type: 'new' | 'review';
  input: string;
  hint: number;
  ms: number;
  result: JudgeResult;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [words, setWords] = useState<Word[]>([]);
  const [cards, setCards] = useState<MemCard[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [tab, setTab] = useState<Tab>('today');
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyState, setKeyState] = useState<KeyState>('checking');

  const readingRef = useRef<Promise<Reading> | null>(null);

  // 判断有没有可用的 Key：页面里填的，或者本地服务端配置的
  useEffect(() => {
    let alive = true;
    (async () => {
      if (settings.apiKey) {
        if (alive) setKeyState('ok');
        return;
      }
      const proxy = await probeProxy();
      if (!alive) return;
      setKeyState(proxy?.hasServerKey ? 'ok' : 'needs');
    })();
    return () => {
      alive = false;
    };
    // 只在首次挂载时判断，之后由引导页/设置页自己接管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const dict = await loadDict();
        const loadedCards = await loadCards();
        const loadedAttempts = await idbAll<Attempt>('attempts');
        const { plan: p } = await getPlan(dict, settings);
        if (!alive) return;
        setWords(dict);
        setCards(loadedCards);
        setAttempts(loadedAttempts);
        setPlan(p);
      } catch (e) {
        if (alive) setError(String((e as Error)?.message || e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // 只在首次挂载时加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  // 复习强度（目标记忆保持率）变化时重建调度器
  useEffect(() => {
    configureSrs(settings.retention);
  }, [settings.retention]);

  const replan = useCallback(async () => {
    if (!words.length) return;
    await idbDel('kv', `plan:${todayKey()}`);
    const { plan: p } = await getPlan(words, settings);
    setPlan(p);
    readingRef.current = null;
  }, [words, settings]);

  const handleAnswer = useCallback(
    async (payload: AnswerPayload): Promise<MemCard> => {
      const id = payload.word.w.toLowerCase();
      const existing = cards.find((c) => c.id === id) ?? newCard(payload.word.w);
      const rating = ratingFor(payload.result.verdict, payload.hint, payload.ms);
      const next = applyRating(existing, rating);
      await saveCard(next);
      setCards((prev) => [...prev.filter((c) => c.id !== id), next]);

      const at = Date.now();
      const attempt: Attempt = {
        w: payload.word.w,
        input: payload.input,
        verdict: payload.result.verdict,
        hint: payload.hint,
        ms: payload.ms,
        at,
        source: payload.type,
        reason: payload.result.reason,
      };
      await idbPut('attempts', attempt);
      setAttempts((prev) => [...prev, attempt]);

      if (plan) {
        const key = payload.type === 'new' ? 'newDone' : 'reviewDone';
        if (!plan[key].includes(payload.word.w)) {
          const updated: DayPlan = { ...plan, [key]: [...plan[key], payload.word.w] };
          await savePlan(updated);
          setPlan(updated);
        }
      }
      return next;
    },
    [cards, plan],
  );

  const readingTargets = useCallback((): Word[] => {
    if (!plan) return [];
    const ids = [...plan.newIds, ...plan.reviewIds];
    const seen = new Set<string>();
    const out: Word[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const w = getWord(id);
      if (w) out.push(w);
    }
    return out;
  }, [plan]);

  const startReading = useCallback((): Promise<Reading> | null => {
    if (!settings.readingEnabled) return null;
    if (readingRef.current) return readingRef.current;
    const targets = readingTargets();
    if (!targets.length) return null;
    const p = generateReading({ date: todayKey(), targets, settings });
    p.catch(() => {
      readingRef.current = null;
    });
    readingRef.current = p;
    return p;
  }, [readingTargets, settings]);

  const beginStudy = useCallback(() => {
    setOverlay('study');
    startReading();
  }, [startReading]);

  const openReading = useCallback(() => {
    setOverlay('reading');
  }, []);

  const exportData = useCallback(() => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), settings, cards, attempts };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aibeici-backup-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [settings, cards, attempts]);

  const resetAll = useCallback(async () => {
    const stores = ['cards', 'attempts', 'readings', 'kv', 'cache'] as const;
    for (const s of stores) await idbClear(s);
    setCards([]);
    setAttempts([]);
    readingRef.current = null;
    if (words.length) {
      const { plan: p } = await getPlan(words, settings);
      setPlan(p);
    }
  }, [words, settings]);

  if (loading) {
    return (
      <div className="app">
        <div className="finish">
          <div className="spinner" />
          <p className="muted tiny" style={{ marginTop: 14 }}>
            正在加载词库…
          </p>
        </div>
      </div>
    );
  }

  // 没有 Key 就先引导填（App 内不内置任何 Key）
  if (keyState === 'needs') {
    return (
      <FirstRun
        settings={settings}
        onUpdate={updateSettings}
        onDone={() => setKeyState('ok')}
        onSkip={() => setKeyState('ok')}
      />
    );
  }

  if (error) {
    return (
      <div className="app">
        <div className="card" style={{ marginTop: 60 }}>
          <h3 style={{ marginTop: 0 }}>加载失败</h3>
          <p className="tiny muted">{error}</p>
          <button className="btn btn-ghost" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }

  const due = dueCards(cards);

  return (
    <>
      <div className="app">
        <div className="topbar">
          <div className="brand">
            爱背词
            <small>CET-6 · AI 释义判分</small>
          </div>
          <div className="date">{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}</div>
        </div>

        {tab === 'today' && (
          <Today
            plan={plan}
            cards={cards}
            attempts={attempts}
            settings={settings}
            totalWords={words.length}
            forecast={dueForecast(cards, 5)}
            dueCount={due.length}
            onStart={beginStudy}
            onReading={openReading}
          />
        )}
        {tab === 'stats' && <Stats cards={cards} attempts={attempts} forecast={dueForecast(cards, 7)} />}
        {tab === 'settings' && (
          <SettingsPage
            settings={settings}
            onUpdate={updateSettings}
            onReplan={replan}
            onExport={exportData}
            onReset={resetAll}
            cardCount={cards.length}
          />
        )}

        <nav className="tabbar">
          <div className="tabbar-inner">
            <button className={tab === 'today' ? 'on' : ''} onClick={() => setTab('today')}>
              <span className="ic">◉</span>今日
            </button>
            <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>
              <span className="ic">▤</span>统计
            </button>
            <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
              <span className="ic">⚙</span>设置
            </button>
          </div>
        </nav>
      </div>

      {overlay === 'study' && plan && (
        <Study
          plan={plan}
          settings={settings}
          onAnswer={handleAnswer}
          onExit={() => setOverlay('none')}
          onFinish={() => setOverlay(settings.readingEnabled ? 'reading' : 'none')}
          hasReading={settings.readingEnabled}
        />
      )}

      {overlay === 'reading' && (
        <ReadingView
          preload={readingRef.current}
          settings={settings}
          targets={readingTargets()}
          onExit={() => setOverlay('none')}
        />
      )}
    </>
  );
}
