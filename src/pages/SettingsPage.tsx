import { useEffect, useState } from 'react';
import { idbPut } from '../lib/db';
import { pronounce, type SpeakChannel } from '../lib/dict';
import { chat, probeProxy } from '../lib/llm';
import type { Attempt, MemCard, Settings } from '../lib/types';

interface Props {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  onReplan: () => Promise<void>;
  onExport: () => void;
  onReset: () => Promise<void>;
  cardCount: number;
}

export default function SettingsPage({ settings, onUpdate, onReplan, onExport, onReset, cardCount }: Props) {
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [proxy, setProxy] = useState<{ hasKey: boolean; keySource: string; model: string } | null>(null);
  const [replanning, setReplanning] = useState(false);
  const [audioMsg, setAudioMsg] = useState('');
  const [audioTesting, setAudioTesting] = useState(false);

  useEffect(() => {
    probeProxy().then((r) => setProxy(r ? { hasKey: r.hasServerKey, keySource: r.keySource, model: r.model } : null));
  }, []);

  const test = async () => {
    setTesting(true);
    setTestMsg('');
    try {
      const { content } = await chat(
        { messages: [{ role: 'user', content: '只回复两个字：可用' }], temperature: 0, maxTokens: 20 },
        settings,
      );
      setTestMsg(`连接正常：${content.trim().slice(0, 20)}`);
    } catch (e) {
      setTestMsg(`连接失败：${String((e as Error).message || e)}`);
    } finally {
      setTesting(false);
    }
  };

  /** 发音自检：分别试一个单词和一句例句，告诉你实际走了哪条通道 */
  const testAudio = async () => {
    setAudioTesting(true);
    setAudioMsg('正在测试…');
    const label = (c: SpeakChannel) =>
      c === 'online' ? '在线音频 ✓' : c === 'tts' ? '系统语音 ✓' : '失败 ✗';
    try {
      const word = await pronounce('environmental', settings.speakMode);
      const sentence = await pronounce(
        'the environmental damage caused by the chemical industry',
        settings.speakMode,
      );
      setAudioMsg(`单词：${label(word)}　｜　例句：${label(sentence)}`);
    } catch (e) {
      setAudioMsg(`测试出错：${String((e as Error).message || e)}`);
    } finally {
      setAudioTesting(false);
    }
  };

  const importData = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as {
        cards?: MemCard[];
        attempts?: Attempt[];
      };
      let n = 0;
      for (const c of data.cards ?? []) {
        await idbPut('cards', c);
        n++;
      }
      for (const a of data.attempts ?? []) {
        await idbPut('attempts', { ...a, id: undefined });
      }
      alert(`已导入 ${n} 张记忆卡片，刷新页面后生效。`);
    } catch (e) {
      alert(`导入失败：${String((e as Error).message || e)}`);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-title">
          <span>每日计划</span>
          <span className="tiny">改动立即生效，明天的计划按新设置生成</span>
        </div>

        <div className="field">
          <label>
            每天新词 <span className="hl">{settings.dailyNew}</span> 个
          </label>
          <input
            className="slider"
            type="range"
            min={5}
            max={60}
            step={5}
            value={settings.dailyNew}
            onChange={(e) => onUpdate({ dailyNew: Number(e.target.value) })}
          />
          <div className="desc">
            建议 10–20 个。定得越多，后面几天的复习压力越大；如果复习积压，系统会自动帮你下调新词量。
          </div>
        </div>

        <div className="field">
          <label>
            每天复习上限 <span className="hl">{settings.dailyReviewCap}</span> 个
          </label>
          <input
            className="slider"
            type="range"
            min={20}
            max={200}
            step={10}
            value={settings.dailyReviewCap}
            onChange={(e) => onUpdate({ dailyReviewCap: Number(e.target.value) })}
          />
          <div className="desc">超出上限的复习词会顺延到明天，不会被丢掉。</div>
        </div>

        <div className="field">
          <label>复习强度</label>
          <select
            value={String(settings.retention)}
            onChange={(e) => onUpdate({ retention: Number(e.target.value) })}
          >
            <option value="0.95">紧凑 —— 目标记住 95%，复习更频繁</option>
            <option value="0.9">标准 —— 目标记住 90%（推荐）</option>
            <option value="0.85">宽松 —— 目标记住 85%，间隔更长</option>
          </select>
          <div className="desc">
            这是遗忘曲线的「目标记忆保持率」：每个词的下次复习间隔由它反算出来（记住 95% 的间隔大约是
            记住 85% 的一半）。改动只影响之后的作答，已经排好的日期不会变。
          </div>
        </div>

        <div className="field">
          <label>学习范围</label>
          <select
            value={settings.pool}
            onChange={(e) => onUpdate({ pool: e.target.value as Settings['pool'] })}
          >
            <option value="inc">六级增量词（约 1880 个 · 排除四级基础词）</option>
            <option value="all">六级全量（约 5200 个 · 含四级词）</option>
          </select>
          <div className="desc">
            已学过 {cardCount} 个词。换范围不会丢进度，只是把新词的来源换掉。
          </div>
        </div>

        <button
          className="btn btn-ghost"
          disabled={replanning}
          onClick={async () => {
            setReplanning(true);
            await onReplan();
            setReplanning(false);
            alert('今天的计划已重新生成（已完成的词不会重复出现）。');
          }}
        >
          {replanning ? '正在重排…' : '按新设置重排今天的计划'}
        </button>
      </div>

      <div className="card">
        <div className="card-title">
          <span>模型</span>
          <span className="tiny">
            {settings.apiKey
              ? 'Key 来源：本页填写'
              : proxy === null
                ? '本地代理未连接'
                : proxy.hasKey
                  ? `Key 来源：${proxy.keySource || 'apikey.txt'}`
                  : '未找到 API Key'}
          </span>
        </div>

        <div className="field">
          <label>API Key</label>
          <input
            type="password"
            value={settings.apiKey}
            onChange={(e) => onUpdate({ apiKey: e.target.value })}
            placeholder={proxy?.hasKey ? `已使用 ${proxy.keySource} 里的 Key，这里可留空` : 'sk-...'}
            autoComplete="off"
          />
          <div className="desc">
            推荐做法：把 Key 填到项目根目录的 <code>apikey.txt</code> 里，只填一次，之后双击「启动爱背词」就能用。
            <br />
            这里的输入框只用于临时覆盖，会存在这台设备的浏览器里。
          </div>
        </div>

        <div className="field">
          <label>模型名称</label>
          <input
            type="text"
            value={settings.model}
            onChange={(e) => onUpdate({ model: e.target.value })}
            placeholder="deepseek-chat"
          />
          <div className="desc">
            任何 OpenAI 兼容模型都行，例如 <code>deepseek-chat</code>、<code>glm-4-flash</code>、
            <code>qwen-plus</code>。
          </div>
        </div>

        <div className="field">
          <label>接口地址（可选）</label>
          <input
            type="text"
            value={settings.baseUrl}
            onChange={(e) => onUpdate({ baseUrl: e.target.value })}
            placeholder="https://api.deepseek.com"
          />
          <div className="desc">换用别家模型时填它的 base_url，请求会走本机代理转发。</div>
        </div>

        <button className="btn btn-ghost" onClick={test} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        {testMsg && (
          <div className={`notice ${testMsg.startsWith('连接失败') ? 'err' : ''}`} style={{ marginTop: 12 }}>
            {testMsg}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">
          <span>偏好</span>
        </div>
        <div className="row-between">
          <span>显示音标</span>
          <button
            className="switch"
            aria-checked={settings.showPhonetic}
            onClick={() => onUpdate({ showPhonetic: !settings.showPhonetic })}
          />
        </div>
        <div className="row-between">
          <span>出现新词时自动朗读</span>
          <button
            className="switch"
            aria-checked={settings.autoSpeak}
            onClick={() => onUpdate({ autoSpeak: !settings.autoSpeak })}
          />
        </div>
        <div className="row-between">
          <span>发音</span>
          <select
            className="mini-select"
            value={settings.speakMode}
            onChange={(e) => onUpdate({ speakMode: e.target.value as Settings['speakMode'] })}
          >
            <option value="us">美音</option>
            <option value="uk">英音</option>
            <option value="system">系统语音</option>
          </select>
        </div>
        <p className="tiny muted" style={{ margin: '2px 0 10px' }}>
          单词用在线真人音频（有道/百度），例句用百度朗读；都失败才退回系统语音，断网也能用。
        </p>
        <button className="btn btn-ghost" onClick={testAudio} disabled={audioTesting}>
          {audioTesting ? '正在测试发音…' : '测试发音'}
        </button>
        {audioMsg && (
          <div className={`notice ${audioMsg.includes('✗') ? 'err' : ''}`} style={{ marginTop: 12 }}>
            {audioMsg}
          </div>
        )}
        <div className="row-between">
          <span>学完后生成阅读理解</span>
          <button
            className="switch"
            aria-checked={settings.readingEnabled}
            onClick={() => onUpdate({ readingEnabled: !settings.readingEnabled })}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <span>数据</span>
          <span className="tiny">全部存在本机浏览器里</span>
        </div>
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button className="btn btn-ghost" onClick={onExport}>
            导出备份
          </button>
          <label className="btn btn-ghost" style={{ margin: 0 }}>
            导入备份
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importData(f);
              }}
            />
          </label>
        </div>
        <button
          className="btn btn-ghost"
          style={{ color: 'var(--red)' }}
          onClick={async () => {
            if (!confirm('确定清空所有学习记录、记忆卡片和缓存？此操作不可恢复。')) return;
            await onReset();
            alert('已清空。');
          }}
        >
          清空所有数据
        </button>
      </div>

      <div className="card">
        <div className="card-title">关于</div>
        <p className="tiny muted" style={{ margin: 0, lineHeight: 1.7 }}>
          词库来自 ECDICT（MIT 许可）与公开六级词书，共 5200 个六级词。
          <br />
          判分是三层结构：本地精确匹配 → 本地义项比对 → 大模型语义判断，命中的结果会被缓存，同一个答案不会重复问模型。
          <br />
          复习调度使用 FSRS，和 Anki 同一套算法思路。
        </p>
      </div>
    </>
  );
}
