import type { Settings } from './types';

const KEY = 'aibeici:settings:v1';

export const DEFAULT_SETTINGS: Settings = {
  dailyNew: 15,
  dailyReviewCap: 60,
  pool: 'inc',
  apiKey: '',
  model: 'deepseek-chat',
  baseUrl: '',
  showPhonetic: true,
  autoSpeak: true,
  speakMode: 'us',
  retention: 0.9,
  readingEnabled: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function todayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 本地当天 23:59:59 的时间戳，用于「今天到期」判断 */
export function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
