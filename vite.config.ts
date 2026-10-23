import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error 纯 JS 模块，无需类型声明
import { createLlmHandler } from './server/llm-proxy.mjs';

/**
 * 本地 LLM 代理：浏览器只请求 /api/llm，由本地服务转发到大模型接口。
 * 作用：① 绕过浏览器 CORS ② API Key 只放在 .env.local，不进前端代码
 */
function llmProxy(): Plugin {
  const handler = createLlmHandler() as (req: unknown, res: unknown) => void;
  return {
    name: 'aibeici-llm-proxy',
    configureServer(server) {
      server.middlewares.use('/api/llm', handler as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/llm', handler as never);
    },
  };
}

export default defineConfig({
  plugins: [react(), llmProxy()],
  server: { port: 5180, host: '127.0.0.1' },
  preview: { port: 5181, host: '127.0.0.1' },
  build: {
    // 打进 APK 时要兼容老一点的 Android WebView，用 AIBEICI_WEB_TARGET 覆盖
    target: process.env.AIBEICI_WEB_TARGET || 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
