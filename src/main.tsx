import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { isNative } from './lib/native';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 安卓 APK 里资源本来就在本地，不需要 Service Worker（还会带来更新不及时的风险）
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNative()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
