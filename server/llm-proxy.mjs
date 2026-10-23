/**
 * 本地大模型代理（Vite 开发/预览服务器与 scripts/serve.mjs 共用）
 *
 * 浏览器把请求发到 /api/llm，由本地服务转发到 OpenAI 兼容接口。
 * 作用：① 绕开浏览器 CORS ② API Key 只存在本地文件里，不进前端代码
 *
 * Key 的查找顺序：
 *   1. 请求头 x-api-key（页面上「设置」里填的）
 *   2. 项目根目录 apikey.txt
 *   3. 项目根目录 .env.local 的 DEEPSEEK_API_KEY
 *   4. 环境变量 DEEPSEEK_API_KEY
 */
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = 'apikey.txt';
const ENV_FILE = '.env.local';

/** 读取 .env.local（避免引入 dotenv 依赖） */
export function readEnvLocal() {
  const p = path.resolve(process.cwd(), ENV_FILE);
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * 读取 apikey.txt。格式很宽松：
 *   DEEPSEEK_API_KEY=sk-xxx     ← 推荐
 *   sk-xxx                      ← 只贴一串也行
 * 以 # 开头的行会被忽略，所以文件里的说明文字不影响。
 */
export function readKeyFile() {
  const p = path.resolve(process.cwd(), KEY_FILE);
  const out = { key: '', model: '', baseUrl: '', source: '' };
  if (!fs.existsSync(p)) return out;

  let bare = '';
  const kv = {};
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) {
      kv[m[1].toUpperCase()] = m[2].replace(/^["']|["']$/g, '').trim();
    } else if (!bare) {
      bare = line.replace(/^["']|["']$/g, '').trim();
    }
  }

  const candidate = kv.DEEPSEEK_API_KEY || kv.API_KEY || kv.KEY || bare || '';
  // 只接受不含空白的可打印 ASCII，且长度足够 —— 这样占位文字不会被误当成 Key
  if (/^[\x21-\x7e]{16,}$/.test(candidate)) {
    out.key = candidate;
    out.source = KEY_FILE;
  }
  if (kv.DEEPSEEK_MODEL) out.model = kv.DEEPSEEK_MODEL;
  if (kv.DEEPSEEK_BASE_URL) out.baseUrl = kv.DEEPSEEK_BASE_URL;
  return out;
}

/** 汇总各来源，返回实际生效的 Key 与它的出处 */
export function resolveKey(headerKey = '') {
  if (headerKey) return { key: String(headerKey), source: '页面设置' };

  const file = readKeyFile();
  if (file.key) return { key: file.key, source: KEY_FILE };

  const env = readEnvLocal();
  const fromEnv = env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  if (fromEnv) return { key: fromEnv, source: ENV_FILE };

  return { key: '', source: '' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function createLlmHandler() {
  return async function handler(req, res) {
    const send = (code, obj) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET') {
      const file = readKeyFile();
      const env = readEnvLocal();
      const resolved = resolveKey();
      return send(200, {
        ok: true,
        hasKey: Boolean(resolved.key),
        keySource: resolved.source,
        defaultModel:
          file.model || env.DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      });
    }
    if (req.method !== 'POST') return send(405, { error: '只支持 POST' });

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return send(400, { error: '请求体不是合法 JSON' });
    }

    const resolved = resolveKey(req.headers['x-api-key'] || '');
    if (!resolved.key) {
      return send(401, {
        error: `没有找到 API Key。请把 Key 填到项目根目录的 ${KEY_FILE} 里（格式：DEEPSEEK_API_KEY=sk-...），然后重启；也可以临时在页面「设置」里填。`,
      });
    }

    const file = readKeyFile();
    const env = readEnvLocal();
    const base = String(
      req.headers['x-base-url'] ||
        file.baseUrl ||
        env.DEEPSEEK_BASE_URL ||
        process.env.DEEPSEEK_BASE_URL ||
        'https://api.deepseek.com',
    ).replace(/\/+$/, '');

    const started = Date.now();
    try {
      const upstream = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${resolved.key}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await upstream.text();
      let usage = null;
      try {
        usage = JSON.parse(text)?.usage ?? null;
      } catch {
        /* ignore */
      }
      console.log(
        `[llm] ${payload?.model || '?'} ${upstream.status} ${Date.now() - started}ms` +
          (usage ? ` tokens ${usage.prompt_tokens}+${usage.completion_tokens}` : '') +
          ` key:${resolved.source}`,
      );
      res.statusCode = upstream.status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(text);
    } catch (e) {
      send(502, { error: `调用大模型失败：${e?.message || e}` });
    }
  };
}
