/**
 * 上传前自查：把 apikey.txt 里的密钥在「将要提交的文件」里搜一遍，
 * 同时统计体积、列出可能不该提交的目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-android',
  'android-sdk',
  '.pnpm-store',
  '.pnpm-cache',
  '.npm-cache',
  'raw',
  'tmp',
  'build',
]);

function readKey() {
  const p = 'apikey.txt';
  if (!fs.existsSync(p)) return '';
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const v = (line.includes('=') ? line.split('=').slice(1).join('=') : line).trim();
    if (/^[\x21-\x7e]{16,}$/.test(v)) return v;
  }
  return '';
}

const key = readKey();
if (!key) {
  console.log('apikey.txt 里没有密钥，跳过内容扫描');
}

const files = [];
function walk(dir, depth = 0) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.git') && e.name !== '.gitignore' && e.name !== '.github') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, depth + 1);
    } else {
      files.push(p);
    }
  }
}
walk('.');

let total = 0;
const hits = [];
const big = [];
for (const f of files) {
  const size = fs.statSync(f).size;
  total += size;
  if (size > 1024 * 1024) big.push([f, size]);
  if (!key) continue;
  // 只扫文本类文件
  if (!/\.(ts|tsx|js|mjs|json|md|css|html|java|xml|yaml|yml|txt|cmd|py|gitignore)$/.test(f)) continue;
  try {
    if (fs.readFileSync(f, 'utf8').includes(key)) hits.push(f);
  } catch {
    /* 二进制 */
  }
}

console.log(`\n将提交的文件：${files.length} 个，合计 ${(total / 1024 / 1024).toFixed(2)} MB`);
console.log('\n大于 1 MB 的文件：');
for (const [f, s] of big.sort((a, b) => b[1] - a[1])) {
  console.log(`  ${(s / 1024 / 1024).toFixed(2)} MB  ${f}`);
}

// 命中的文件如果已经被 .gitignore 排除，就不算泄露
function isIgnored(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dangerous = hits.filter((h) => !isIgnored(h));
const safe = hits.filter((h) => isIgnored(h));

console.log(
  `\n密钥泄露检查：${dangerous.length ? '✗ 有 ' + dangerous.length + ' 个会被提交的文件含密钥' : '✓ 不会被提交的文件里没有密钥'}`,
);
for (const d of dangerous) console.log('  ⚠ 必须移除：' + d);
for (const s of safe) console.log(`  · ${s}（已被 .gitignore 排除，不会上传）`);

const byExt = new Map();
for (const f of files) {
  const ext = path.extname(f) || '(无扩展名)';
  byExt.set(ext, (byExt.get(ext) || 0) + 1);
}
console.log('\n文件类型分布：', [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([e, n]) => `${e}:${n}`).join('  '));
