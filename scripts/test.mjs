/**
 * 自测：打包所有 selftest 脚本后逐个运行
 * 用法：npm test
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ESBUILD_CANDIDATES = [
  'node_modules/@esbuild/win32-x64/esbuild.exe',
  'node_modules/@esbuild/win32-arm64/esbuild.exe',
  'node_modules/@esbuild/linux-x64/bin/esbuild',
  'node_modules/@esbuild/linux-arm64/bin/esbuild',
  'node_modules/@esbuild/darwin-x64/bin/esbuild',
  'node_modules/@esbuild/darwin-arm64/bin/esbuild',
];

const bin = ESBUILD_CANDIDATES.find((p) => fs.existsSync(p));
if (!bin) {
  console.error('找不到 esbuild 可执行文件，先执行 npm install。');
  process.exit(1);
}

const tests = ['selftest-judge', 'selftest-srs', 'selftest-reading'];
const outDir = 'data/tmp';
fs.mkdirSync(outDir, { recursive: true });

let failed = 0;
for (const name of tests) {
  const out = path.join(outDir, `${name}.mjs`);
  console.log(`\n===== ${name} =====`);
  execFileSync(
    bin,
    [`scripts/${name}.ts`, '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`, '--log-level=warning'],
    { stdio: 'inherit' },
  );
  try {
    execFileSync(process.execPath, [out], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}

console.log(failed === 0 ? '\n全部自测通过。' : `\n${failed} 个自测失败。`);
process.exit(failed === 0 ? 0 : 1);
