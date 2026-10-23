import { useState } from 'react';
import { chat } from '../lib/llm';
import type { Settings } from '../lib/types';

interface Props {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  onDone: () => void;
  onSkip: () => void;
}

/**
 * 首次启动的密钥引导。
 * App 里不再内置任何 Key，判分和写文章都靠使用者自己的 Key。
 */
export default function FirstRun({ settings, onUpdate, onDone, onSkip }: Props) {
  const [key, setKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.model || 'deepseek-chat');
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl || '');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const k = key.trim();
    if (!k) {
      setError('请先填入 API Key');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // 直接拿这份配置试一次真实请求，避免填错了还以为能用
      const next: Settings = {
        ...settings,
        apiKey: k,
        model: model.trim() || 'deepseek-chat',
        baseUrl: baseUrl.trim(),
      };
      const { content } = await chat(
        { messages: [{ role: 'user', content: '只回复两个字：可用' }], temperature: 0, maxTokens: 10 },
        next,
      );
      if (!content.trim()) throw new Error('模型没有返回内容');
      onUpdate({ apiKey: next.apiKey, model: next.model, baseUrl: next.baseUrl });
      onDone();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay">
      <div className="overlay-inner">
        <div className="firstrun">
          <div className="brand" style={{ marginBottom: 4 }}>
            爱背词
            <small>CET-6 · AI 释义判分</small>
          </div>

          <h2 style={{ margin: '18px 0 8px', fontSize: 21 }}>还差一步：填你自己的 API Key</h2>
          <p className="tiny muted" style={{ margin: '0 0 18px', lineHeight: 1.7 }}>
            App 里不内置任何 API Key。判分、写阅读理解都走你这个 Key，按用量计费，
            每天 15 新词 + 60 复习大约每月 3–5 元。
          </p>

          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            <div className="desc">
              在{' '}
              <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
                platform.deepseek.com/api_keys
              </a>{' '}
              创建。只保存在这台设备上，不会上传，之后也能在「设置」里换。
            </div>
          </div>

          {advanced ? (
            <>
              <div className="field">
                <label>模型名称</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat"
                  spellCheck={false}
                />
                <div className="desc">换别家模型时填它的模型名，例如 glm-4-flash、qwen-plus。</div>
              </div>
              <div className="field">
                <label>接口地址（可选）</label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com"
                  spellCheck={false}
                />
                <div className="desc">留空就用默认的 DeepSeek 接口。</div>
              </div>
            </>
          ) : (
            <button className="btn-quiet" style={{ padding: '4px 0 12px' }} onClick={() => setAdvanced(true)}>
              用其他模型？展开高级选项
            </button>
          )}

          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? '正在验证…' : '保存并验证'}
          </button>

          {error && (
            <div className="notice err" style={{ marginTop: 14, textAlign: 'left' }}>
              验证没通过：{error}
            </div>
          )}

          <div style={{ marginTop: 22, textAlign: 'center' }}>
            <button className="btn-quiet" onClick={onSkip}>
              先跳过，只用本地判分
            </button>
            <p className="tiny muted" style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
              跳过之后只能做本地精确比对，模糊答案判不了、阅读理解也生成不了。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
