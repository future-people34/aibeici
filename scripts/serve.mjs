/**
 * 轻量静态服务器：托管 vite 构建产物 dist/，并把 /api/llm 转发给大模型。
 * 用法：node scripts/serve.mjs [端口]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmHandler, resolveKey } from '../server/llm-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
// 端口优先级：命令行第一个参数（必须是纯数字）> 环境变量 PORT > 5181
const argPort = Number(process.argv[2]);
const PORT =
  Number.isInteger(argPort) && argPort > 0 && argPort < 65536
    ? argPort
    : Number(process.env.PORT || 5181);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const llm = createLlmHandler();

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('没有找到 dist/index.html，先执行 `npm run build`。');
  process.exit(1);
}

function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
  if (file.endsWith('index.html') || file.endsWith('sw.js')) {
    res.setHeader('cache-control', 'no-cache');
  } else {
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  }
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (url.pathname.startsWith('/api/llm')) {
    llm(req, res);
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(DIST, rel);

  // 防目录穿越
  if (!file.startsWith(DIST)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }

  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    sendFile(res, file);
    return;
  }

  // SPA 回退
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) {
    sendFile(res, index);
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, HOST, () => {
  const { key, source } = resolveKey();
  console.log(`爱背词已启动：http://${HOST}:${PORT}`);
  console.log(`API Key：${key ? `已从 ${source} 读取` : '未找到（填到 apikey.txt 即可）'}`);
  console.log('关闭这个窗口即可停止服务。');
});
