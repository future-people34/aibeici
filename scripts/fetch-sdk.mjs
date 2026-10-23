/**
 * 下载并解压打包 APK 所需的工具链（不需要 Android Studio / Gradle）
 *   node scripts/fetch-sdk.mjs
 *
 * 安装到 android-sdk/：
 *   jdk/                     Corretto JDK 17（javac / keytool / java）
 *   build-tools/34.0.0/      aapt2 / d8 / zipalign / apksigner
 *   platforms/android-34/    android.jar
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SDK = 'android-sdk';
const TMP = path.join(SDK, '.download');

const PACKAGES = [
  {
    name: 'JDK 17 (Corretto)',
    url: 'https://corretto.aws/downloads/latest/amazon-corretto-17-x64-windows-jdk.zip',
    target: 'jdk',
    probe: ['jdk/bin/javac.exe', 'jdk/bin/java.exe'],
  },
  {
    name: 'Android build-tools 34',
    url: 'https://dl.google.com/android/repository/build-tools_r34-windows.zip',
    target: 'build-tools/34.0.0',
    probe: ['build-tools/34.0.0/aapt2.exe', 'build-tools/34.0.0/zipalign.exe'],
  },
  {
    name: 'Android platform 34 (android.jar)',
    url: 'https://dl.google.com/android/repository/platform-34-ext7_r03.zip',
    target: 'platforms/android-34',
    probe: ['platforms/android-34/android.jar'],
  },
];

const MB = (n) => (n / 1024 / 1024).toFixed(1);

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const file = fs.createWriteStream(dest);
  let got = 0;
  let lastPrint = 0;
  for await (const chunk of res.body) {
    file.write(chunk);
    got += chunk.length;
    const now = Date.now();
    if (now - lastPrint > 700) {
      lastPrint = now;
      const pct = total ? ` ${((got / total) * 100).toFixed(0)}%` : '';
      process.stdout.write(`\r    ${MB(got)}${total ? `/${MB(total)}` : ''} MB${pct}   `);
    }
  }
  await new Promise((r) => file.end(r));
  process.stdout.write(`\r    ${MB(got)} MB 完成${' '.repeat(12)}\n`);
}

function extract(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // Windows 10+ 自带 bsdtar，可以直接解 zip
  execFileSync('tar', ['-xf', zip, '-C', destDir], { stdio: 'inherit' });
}

function findSingleDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  return entries.length === 1 ? path.join(dir, entries[0].name) : null;
}

fs.mkdirSync(TMP, { recursive: true });

for (const pkg of PACKAGES) {
  const okAlready = pkg.probe.every((f) => fs.existsSync(path.join(SDK, f)));
  if (okAlready) {
    console.log(`跳过 ${pkg.name}（已安装）`);
    continue;
  }

  console.log(`\n[${pkg.name}]`);
  const zip = path.join(TMP, path.basename(new URL(pkg.url).pathname));
  if (!fs.existsSync(zip)) {
    console.log(`  下载 ${pkg.url}`);
    await download(pkg.url, zip);
  } else {
    console.log(`  已有压缩包 ${path.basename(zip)}`);
  }

  const dest = path.join(SDK, pkg.target);
  const staging = `${dest}.__tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  console.log('  解压…');
  extract(zip, staging);

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 压缩包里通常再套一层目录（JDK 是带版本号的，platform 是 android-34），统一剥掉
  const entries = fs.readdirSync(staging);
  const inner = findSingleDir(staging);
  if (inner && entries.length === 1) {
    fs.renameSync(inner, dest);
    fs.rmSync(staging, { recursive: true, force: true });
  } else {
    fs.renameSync(staging, dest);
  }
  const missing = pkg.probe.filter((f) => !fs.existsSync(path.join(SDK, f)));
  if (missing.length) {
    console.error(`  ✗ 解压后缺少：${missing.join(', ')}`);
    console.error(`    实际目录：${fs.readdirSync(dest).slice(0, 12).join(', ')}`);
    process.exit(1);
  }
  console.log(`  ✓ 装好了 → ${dest}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n工具链就绪，运行 node scripts/build-apk.mjs 开始打包。');
