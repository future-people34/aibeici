/**
 * 安卓壳（android/src/.../MainActivity.java）暴露给网页的桥。
 * 浏览器里没有这个对象，所有函数都会自动退回普通 fetch / speechSynthesis。
 *
 * 为什么需要它：
 *  - 浏览器直连大模型会被 CORS 挡住，安卓端由 Java 用 HttpURLConnection 转发；
 *  - Android WebView 基本不支持 speechSynthesis，系统语音兜底改用原生 TextToSpeech。
 */

export interface AndroidBridge {
  post(id: string, url: string, headersJson: string, body: string): void;
  speak(text: string, rate: number): void;
  stop(): void;
  hasKey(): boolean;
}

declare global {
  interface Window {
    AndroidBridge?: AndroidBridge;
    __androidHttpDone?: (id: string, status: number, body: string) => void;
  }
}

export function nativeBridge(): AndroidBridge | null {
  if (typeof window === 'undefined') return null;
  return window.AndroidBridge ?? null;
}

export function isNative(): boolean {
  return nativeBridge() !== null;
}

export interface NativeResponse {
  status: number;
  body: string;
}

let seq = 0;
const pending = new Map<string, (r: NativeResponse) => void>();
let hooked = false;

function ensureHook(): void {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  window.__androidHttpDone = (id, status, body) => {
    const cb = pending.get(id);
    if (cb) {
      pending.delete(id);
      cb({ status, body });
    }
  };
}

/** 走原生 HTTP 发一个请求（安卓端用来绕开 CORS） */
export function nativePost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<NativeResponse> {
  const bridge = nativeBridge();
  if (!bridge) return Promise.reject(new Error('当前环境没有安卓桥'));
  ensureHook();

  const id = `n${++seq}`;
  return new Promise<NativeResponse>((resolve) => {
    pending.set(id, resolve);
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ status: 504, body: '{"error":"安卓端请求超时"}' });
      }
    }, 130_000);

    try {
      bridge.post(id, url, JSON.stringify(headers), body);
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ status: 599, body: JSON.stringify({ error: String(e) }) });
    }
  });
}

/** 用安卓原生 TTS 朗读；没有桥时返回 false */
export function nativeSpeak(text: string, rate = 0.9): boolean {
  const bridge = nativeBridge();
  if (!bridge) return false;
  try {
    bridge.speak(text, rate);
    return true;
  } catch {
    return false;
  }
}

export function nativeStopSpeak(): void {
  try {
    nativeBridge()?.stop();
  } catch {
    /* 忽略 */
  }
}
