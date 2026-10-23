import { useEffect, useRef, useState } from 'react';
import { pronounce, type SpeakMode } from '../lib/dict';

interface Props {
  /** 要朗读的内容（单词或整句） */
  text: string;
  mode: SpeakMode;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * 发音按钮：点击朗读，播放期间图标会轻微跳动。
 * 在线音频失败会自动退回系统语音；两条路都不通时会短暂变红提示，而不是静默无反应。
 */
export default function SpeakerButton({ text, mode, size = 'md', className = '' }: Props) {
  const [state, setState] = useState<'idle' | 'playing' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const play = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (timer.current) window.clearTimeout(timer.current);
    setState('playing');
    const channel = await pronounce(text, mode);
    timer.current = window.setTimeout(() => setState(channel === 'none' ? 'failed' : 'idle'), channel === 'none' ? 1800 : 650);
  };

  const label =
    state === 'failed' ? '这个浏览器没有可用的发音引擎' : state === 'playing' ? '正在朗读…' : '朗读';

  return (
    <button
      type="button"
      className={`speaker ${size} ${state === 'playing' ? 'playing' : ''} ${state === 'failed' ? 'failed' : ''} ${className}`}
      onClick={play}
      aria-label={`朗读 ${text}`}
      title={label}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 5 6.6 8.4H3.5v7.2h3.1L11 19V5z" />
        <path d="M14.8 8.6a4.6 4.6 0 0 1 0 6.8" />
        <path d="M17.7 6a8.2 8.2 0 0 1 0 12" />
      </svg>
    </button>
  );
}
