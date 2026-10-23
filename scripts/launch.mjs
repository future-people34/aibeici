/**
 * 一键启动：检查配置 → 需要时自动构建 → 起服务 → 打开浏览器
 * 双击「启动爱背词.cmd」就是在跑这个脚本。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const PORT = Number(process.env.PORT || 5181);
const URL = `http://127.0.0.1:${PORT}/`;

const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable(url, timeout = 800) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch {
    return false;
  }
}

const NO_OPEN = process.env.AIBEICI_NO_OPEN === '1' || process.argv.includes('--no-open');

function openBrowser(url) {
  if (NO_OPEN) return;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* 打不开就让用户手动点链接 */
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function newestMtime(files) {
  let t = 0;
  for (const f of files) {
    try {
      const s = fs.statSync(f);
      if (s.mtimeMs > t) t = s.mtimeMs;
    } catch {
      /* 忽略不存在的文件 */
    }
  }
  return t;
}

/** 源码或词库比 dist 新，就需要重新构建 */
function needsBuild() {
  const index = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(index)) return true;
  if (!fs.existsSync(path.join(ROOT, 'dist', 'data', 'words.json'))) return true;

  const watched = [
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'public')),
    path.join(ROOT, 'index.html'),
    path.join(ROOT, 'vite.config.ts'),
    path.join(ROOT, 'package.json'),
  ];
  return newestMtime(watched) > fs.statSync(index).mtimeMs;
}

function keyStatus() {
  const p = path.join(ROOT, 'apikey.txt');
  if (!fs.existsSync(p)) return { ok: false, where: '没有 apikey.txt 文件' };
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    const val = (m ? m[2] : line).replace(/^["']|["']$/g, '').trim();
    if (m && !/API_KEY|^KEY$/i.test(m[1])) continue;
    if (/^[\x21-\x7e]{16,}$/.test(val)) return { ok: true, where: 'apikey.txt' };
  }
  const env = path.join(ROOT, '.env.local');
  if (fs.existsSync(env) && /DEEPSEEK_API_KEY\s*=\s*\S{16,}/.test(fs.readFileSync(env, 'utf8'))) {
    return { ok: true, where: '.env.local' };
  }
  return { ok: false, where: 'apikey.txt 里还没有填 Key' };
}

console.log('');
console.log(bold('  爱背词 · CET-6'));
console.log(dim('  ─────────────────────────────'));
console.log('');

// 已经在运行就不重复启动
if (await reachable(URL)) {
  console.log(green(`  ✓ 已经在运行：${URL}`));
  console.log(dim(NO_OPEN ? '    要停止请关掉那个窗口。' : '    已为你打开浏览器；要停止请关掉那个窗口。'));
  openBrowser(URL);
  console.log('');
  process.exit(0);
}

if (!fs.existsSync(path.join(ROOT, 'node_modules', 'vite'))) {
  console.log(red('  ✗ 还没有安装依赖。'));
  console.log('    请先在这个文件夹里打开命令行，运行：npm install');
  console.log('');
  process.exit(1);
}

const key = keyStatus();
if (key.ok) {
  console.log(green(`  ✓ API Key 已就绪（来自 ${key.where}）`));
} else {
  console.log(yellow(`  ! ${key.where}`));
  console.log(dim('    判分仍可用（本地精确比对），但模糊答案和阅读理解需要模型。'));
  console.log(dim(`    把 Key 填进 ${path.join(ROOT, 'apikey.txt')}`));
  console.log(dim('    格式：DEEPSEEK_API_KEY=sk-xxxxxxxx'));
  console.log('');
}

if (needsBuild()) {
  console.log(dim('  · 源码有更新，正在重新构建（只需几秒）…'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  } catch {
    console.log('');
    console.log(red('  ✗ 构建失败。'));
    console.log('    可以在项目目录运行 npm run build 看详细报错。');
    console.log('');
    process.exit(1);
  }
  console.log(green('  ✓ 构建完成'));
  console.log('');
}

process.env.PORT = String(PORT);
await import('./serve.mjs');

// 等服务真正监听后再打开浏览器
for (let i = 0; i < 40; i++) {
  if (await reachable(URL)) break;
  await sleep(150);
}
openBrowser(URL);

console.log('');
console.log(dim('  下次直接双击「启动爱背词.cmd」，Key 不用再填。'));
console.log('');
