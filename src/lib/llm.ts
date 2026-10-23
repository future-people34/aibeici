import { kvGet, kvSet } from './db';
import { isNative, nativePost } from './native';
import { todayKey } from './settings';
import type { Settings, UsageRecord } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  temperature?: number;
  json?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
}

const ENDPOINT = '/api/llm';

/** 检查本地代理是否可用（以及服务端从哪个文件读到了 Key） */
export async function probeProxy(): Promise<{
  ok: boolean;
  hasServerKey: boolean;
  keySource: string;
  model: string;
} | null> {
  try {
    const r = await fetch(ENDPOINT);
    if (!r.ok) return null;
    const d = await r.json();
    return {
      ok: Boolean(d.ok),
      hasServerKey: Boolean(d.hasKey),
      keySource: String(d.keySource || ''),
      model: String(d.defaultModel || ''),
    };
  } catch {
    return null;
  }
}

async function recordUsage(usage: ChatResult['usage']): Promise<void> {
  const key = `usage:${todayKey()}`;
  const cur =
    (await kvGet<UsageRecord>(key)) ?? { day: todayKey(), calls: 0, promptTokens: 0, completionTokens: 0 };
  cur.calls += 1;
  if (usage) {
    cur.promptTokens += usage.prompt_tokens || 0;
    cur.completionTokens += usage.completion_tokens || 0;
  }
  await kvSet(key, cur);
}

export async function chat(opts: ChatOptions, settings: Settings): Promise<ChatResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (settings.apiKey) headers['x-api-key'] = settings.apiKey;
  if (settings.baseUrl) headers['x-base-url'] = settings.baseUrl;

  const body: Record<string, unknown> = {
    model: settings.model || 'deepseek-chat',
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
    stream: false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  // 安卓：走原生桥（浏览器里直连大模型会被 CORS 挡住）
  let ok: boolean;
  let status: number;
  let text: string;
  if (isNative()) {
    const r = await nativePost(ENDPOINT, headers, JSON.stringify(body));
    status = r.status;
    text = r.body;
    ok = status >= 200 && status < 300;
  } else {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(120_000),
    });
    status = res.status;
    ok = res.ok;
    text = await res.text();
  }

  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }

  if (!ok) {
    const msg =
      data?.error?.message || data?.error || data?.message || `模型接口返回 HTTP ${status}`;
    throw new Error(String(msg));
  }

  const content: string = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage
    ? { prompt_tokens: data.usage.prompt_tokens ?? 0, completion_tokens: data.usage.completion_tokens ?? 0 }
    : null;
  await recordUsage(usage);

  if (!content) throw new Error('模型返回了空内容');
  return { content, usage };
}

/** 解析模型返回的 JSON（容忍 ```json 包裹） */
export function parseJsonLoose<T>(text: string): T {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s) as T;
}
