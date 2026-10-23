import { isNative, nativeSpeak, nativeStopSpeak } from './native';
import type { Word } from './types';

interface DictFile {
  v: number;
  count: number;
  words: Word[];
}

let all: Word[] | null = null;
let loading: Promise<Word[]> | null = null;

export function loadDict(): Promise<Word[]> {
  if (all) return Promise.resolve(all);
  if (!loading) {
    loading = fetch('/data/words.json', { cache: 'force-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`词库加载失败：HTTP ${r.status}`);
        return r.json() as Promise<DictFile>;
      })
      .then((d) => {
        all = d.words;
        return all;
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

/** 已加载的词库（同步访问，需先 await loadDict） */
export function dictSync(): Word[] {
  return all ?? [];
}

let index: Map<string, Word> | null = null;

export function wordMap(): Map<string, Word> {
  if (!index || index.size !== (all?.length ?? 0)) {
    index = new Map<string, Word>();
    for (const w of all ?? []) index.set(w.w.toLowerCase(), w);
  }
  return index;
}

export function getWord(w: string): Word | undefined {
  return wordMap().get(w.toLowerCase());
}

/** 按学习范围取候选池（词库已按「增量词优先 + 词频」排好序） */
export function poolOf(words: Word[], pool: 'inc' | 'all'): Word[] {
  return pool === 'inc' ? words.filter((w) => !w.c4) : words;
}

/* ==================== 发音 ==================== */

/** 发音方式：在线美音 / 在线英音 / 系统语音 */
export type SpeakMode = 'us' | 'uk' | 'system';
/** 实际走的通道，便于界面上给出准确反馈 */
export type SpeakChannel = 'online' | 'tts' | 'none';

/** 在线音频失败后冷却多久再重试（太短会反复等超时，太长会一直用系统语音） */
const ONLINE_COOLDOWN_MS = 15_000;
/** 在线音频最多等这么久，超过就切系统语音 */
const ONLINE_TIMEOUT_MS = 3000;
/** 超过这么多字符、或含空格的，一律认为是句子 —— 单词音频接口不支持句子 */
const SENTENCE_HINT = 20;

let audioEl: HTMLAudioElement | null = null;
let onlineDownUntil = 0;
let cachedVoices: SpeechSynthesisVoice[] = [];
let voicesRequested = false;
/** 刚刚取消过语音合成：下一次说话要错开一帧，否则 Chrome 会吞掉 */
let cancelPending = false;

function isSentence(text: string): boolean {
  return /\s/.test(text) || text.length > SENTENCE_HINT;
}

function ensureVoices(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const synth = window.speechSynthesis;
  const apply = () => {
    const v = synth.getVoices();
    if (v.length) cachedVoices = v;
  };
  apply();
  if (cachedVoices.length || voicesRequested) return;
  voicesRequested = true;
  // Chrome 首次取语音列表是空的，要等 voiceschanged
  synth.addEventListener?.('voiceschanged', apply);
  setTimeout(apply, 600);
  setTimeout(apply, 1500);
}

/** 优先英音/美音，其次任何 en-* 语音 */
function pickVoice(): SpeechSynthesisVoice | null {
  const prefs = [/^en[-_]US$/i, /^en[-_]GB$/i, /^en/i];
  for (const re of prefs) {
    const v = cachedVoices.find((x) => re.test(x.lang));
    if (v) return v;
  }
  return cachedVoices.find((x) => /english|us english|zira|david|aria/i.test(x.name)) ?? null;
}

/** 当前环境有没有可用的英文语音（没有的话句子朗读不可能出声） */
export function hasEnglishVoice(): boolean {
  ensureVoices();
  return isNative() || Boolean(pickVoice());
}

function getAudio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
  }
  return audioEl;
}

/** 只停播放，不动语音合成（语音的取消放在真正要说话之前，避免 cancel+speak 同帧被丢弃） */
function stopAudio(): void {
  if (audioEl) {
    try {
      audioEl.pause();
    } catch {
      /* 忽略 */
    }
  }
}

/** 停掉正在播的所有声音（音频 + 语音合成），避免单词和句子叠在一起播 */
function stopPlayback(): void {
  stopAudio();
  try {
    const synth = window.speechSynthesis;
    if (synth && (synth.speaking || synth.pending)) {
      synth.cancel();
      cancelPending = true;
    }
  } catch {
    /* 忽略 */
  }
}

export function stopSpeaking(): void {
  stopAudio();
  nativeStopSpeak();
  cancelPending = false;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* 忽略 */
  }
}

/**
 * 用系统语音朗读。
 * 关键点：Chrome 里「cancel() 之后同一个 tick 内 speak()」经常被吞掉，
 * 所以只要刚取消过，就延后一帧再说话。
 */
function speakSystem(text: string): boolean {
  const synth = window.speechSynthesis;
  if (!synth) return false;
  ensureVoices();

  const voice = pickVoice();
  const start = () => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = voice?.lang || 'en-US';
      if (voice) u.voice = voice;
      u.rate = 0.92;
      synth.resume?.();
      synth.speak(u);
    } catch {
      /* 忽略 */
    }
  };

  if (synth.speaking || synth.pending || cancelPending) {
    if (synth.speaking || synth.pending) synth.cancel();
    cancelPending = false;
    setTimeout(start, 100);
  } else {
    start();
  }
  return true;
}

/** 播放在线音频；只认真正的网络/格式错误为失败，自动播放被拦不算 */
function playOnline(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const el = getAudio();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      el.removeEventListener('error', onError);
      el.removeEventListener('playing', onPlaying);
      if (ok) {
        onlineDownUntil = 0;
      } else {
        try {
          el.pause();
        } catch {
          /* 忽略 */
        }
        onlineDownUntil = Date.now() + ONLINE_COOLDOWN_MS;
      }
      resolve(ok);
    };

    const onError = () => finish(false);
    const onPlaying = () => finish(true);

    timer = setTimeout(() => finish(false), ONLINE_TIMEOUT_MS);
    el.addEventListener('error', onError);
    el.addEventListener('playing', onPlaying);

    try {
      el.pause();
    } catch {
      /* 忽略 */
    }
    el.src = url;
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err: unknown) => {
        const name = (err as { name?: string })?.name;
        // 自动播放被浏览器拦下，不代表在线音频不可用，不触发冷却
        if (name === 'NotAllowedError' || name === 'AbortError') return;
        finish(false);
      });
    }
  });
}

/** 单词音频（有道人声）。只对 20 字符以内的词条有效，超过会返回 500 */
const YOUDAO_MAX_LEN = 20;

function youdaoUrl(text: string, mode: SpeakMode): string {
  const type = mode === 'uk' ? 1 : 2;
  return `https://dict.youdao.com/dictvoice?type=${type}&audio=${encodeURIComponent(text)}`;
}

/** 句子音频（百度翻译的朗读接口），要求请求不带 Referer，见 index.html 的 meta referrer */
function baiduUrl(text: string): string {
  return `https://fanyi.baidu.com/gettts?lan=en&text=${encodeURIComponent(text)}&spd=3&source=web`;
}

/**
 * 朗读单词或句子。
 *  - 单词：有道真人音频优先 → 百度 → 系统语音
 *  - 句子：有道不支持整句（>20 字符返回 500），直接走百度
 */
export async function pronounce(text: string, mode: SpeakMode = 'us'): Promise<SpeakChannel> {
  const t = String(text || '').trim();
  if (!t) return 'none';
  ensureVoices();
  stopPlayback();

  const useTts = (): SpeakChannel => {
    // 安卓壳的原生 TTS 比 WebView 的语音合成可靠得多
    if (nativeSpeak(t, 0.92)) return 'tts';
    return speakSystem(t) ? 'tts' : 'none';
  };

  if (mode !== 'system' && Date.now() >= onlineDownUntil) {
    const urls =
      !isSentence(t) && t.length <= YOUDAO_MAX_LEN
        ? [youdaoUrl(t, mode), baiduUrl(t)]
        : [baiduUrl(t)];
    for (const url of urls) {
      // 串行尝试：前一个失败再试下一个
      // eslint-disable-next-line no-await-in-loop
      if (await playOnline(url)) return 'online';
    }
  }

  return useTts();
}
