/**
 * 打包安卓 APK（不需要 Android Studio / Gradle / 联网 Gradle 依赖）
 *
 *   node scripts/fetch-sdk.mjs    # 第一次：下载 JDK + build-tools + android.jar
 *   node scripts/build-apk.mjs    # 之后每次打包
 *
 * 流程：vite build → aapt2 编译资源 → aapt2 link → javac → d8 → 合并 dex → zipalign → apksigner
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const EXE = process.platform === 'win32' ? '.exe' : '';
const SDK = 'android-sdk';
const JDK_BIN = path.join(SDK, 'jdk', 'bin');
const BT = path.join(SDK, 'build-tools', '34.0.0');
const ANDROID_JAR = path.join(SDK, 'platforms', 'android-34', 'android.jar');

const JAVA = path.join(JDK_BIN, `java${EXE}`);
const JAVAC = path.join(JDK_BIN, `javac${EXE}`);
const KEYTOOL = path.join(JDK_BIN, `keytool${EXE}`);
const AAPT2 = path.join(BT, `aapt2${EXE}`);
const ZIPALIGN = path.join(BT, `zipalign${EXE}`);
const D8_JAR = path.join(BT, 'lib', 'd8.jar');
const APKSIGNER_JAR = path.join(BT, 'lib', 'apksigner.jar');

const BUILD = path.join('android', 'build');
const OUT_DIR = 'dist-android';
const KS = path.join('android', 'aibeici.keystore');

const argv = process.argv.slice(2);
const skipWeb = argv.includes('--skip-web');
/**
 * 默认**不**把 Key 打进 APK —— 分发出去的包不该带任何人的密钥，
 * 首次启动时由使用者自己填。确实想内置（只自己用）时加 --with-key。
 */
const withKey = argv.includes('--with-key');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

// 版本号：命令行 --version-code / --version-name 优先，其次读 AndroidManifest
const manifestXml = fs.readFileSync(path.join('android', 'AndroidManifest.xml'), 'utf8');
const pick = (re, fallback) => (manifestXml.match(re)?.[1] ?? fallback);
const cliNum = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const versionName =
  cliNum('version-name') || pick(/android:versionName="([^"]+)"/, pkg.version || '1.0.0');
const versionCode = Number(cliNum('version-code') || pick(/android:versionCode="(\d+)"/, '1'));

function run(file, args, opts = {}) {
  execFileSync(file, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function step(title) {
  console.log(`\n\x1b[1m▶ ${title}\x1b[0m`);
}

/* ---------------- 前置检查 ---------------- */

for (const [name, p] of [
  ['JDK', JAVA],
  ['aapt2', AAPT2],
  ['android.jar', ANDROID_JAR],
]) {
  if (!fs.existsSync(p)) {
    console.error(`\n✗ 找不到 ${name}（${p}）`);
    console.error('  先运行：node scripts/fetch-sdk.mjs\n');
    process.exit(1);
  }
}

/* ---------------- 1. 构建前端 ---------------- */

if (!skipWeb) {
  step('构建前端（vite build，兼容老 WebView）');
  run(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    env: { ...process.env, AIBEICI_WEB_TARGET: 'chrome70' },
  });
} else {
  step('跳过前端构建（--skip-web）');
}

if (!fs.existsSync(path.join('dist', 'index.html'))) {
  console.error('✗ dist/index.html 不存在，先执行 npm run build');
  process.exit(1);
}

/* ---------------- 2. 准备 assets ---------------- */

step('准备 assets');
fs.rmSync(BUILD, { recursive: true, force: true });
const assetsDir = path.join(BUILD, 'assets');
const wwwDir = path.join(assetsDir, 'www');
copyDir('dist', wwwDir);

if (withKey) {
  if (fs.existsSync('apikey.txt')) {
    fs.copyFileSync('apikey.txt', path.join(assetsDir, 'apikey.txt'));
    console.log('  ! --with-key：已把 apikey.txt 内置进 APK（只建议自己用，别分发给别人）');
  } else {
    console.log('  ! 加了 --with-key 但找不到 apikey.txt，这个包装好后仍要手动填 Key');
  }
} else {
  console.log('  ✓ 不内置任何 Key：首次打开时由使用者填写自己的 Key');
}

const sizeMB = (dir) => walk(dir).reduce((s, f) => s + fs.statSync(f).size, 0) / 1024 / 1024;
console.log(`  内置网页资源 ${sizeMB(wwwDir).toFixed(1)} MB`);

/* ---------------- 3. 编译资源 ---------------- */

step('aapt2 编译资源');
const resZip = path.join(BUILD, 'res.zip');
run(AAPT2, ['compile', '--dir', path.join('android', 'res'), '-o', resZip]);

/* ---------------- 4. 链接资源，生成 R.java 与基础 APK ---------------- */

step('aapt2 链接资源');
const genDir = path.join(BUILD, 'gen');
const baseApk = path.join(BUILD, 'base.apk');
fs.mkdirSync(genDir, { recursive: true });

// aapt2 的 --version-code 会被 manifest 里的属性覆盖，所以直接改一份临时 manifest
const manifestPatched = path.join(BUILD, 'AndroidManifest.xml');
fs.writeFileSync(
  manifestPatched,
  manifestXml
    .replace(/android:versionCode="[^"]*"/, `android:versionCode="${versionCode}"`)
    .replace(/android:versionName="[^"]*"/, `android:versionName="${versionName}"`),
);
console.log(`  版本 ${versionName} (code ${versionCode})`);

// 注意：路径必须用正斜杠。传 Windows 反斜杠会让 aapt2 把 "assets/www\a.js" 这样的
// 反斜杠条目名写进 APK，Android 运行时按正斜杠查找就会找不到文件。
const posix = (p) => p.split(path.sep).join('/');
run(AAPT2, [
  'link',
  '-o', posix(baseApk),
  '-I', posix(ANDROID_JAR),
  '--manifest', posix(manifestPatched),
  '-R', posix(resZip),
  '--java', posix(genDir),
  '--min-sdk-version', '24',
  '--target-sdk-version', '34',
  '--auto-add-overlay',
  '-A', posix(assetsDir),
]);

/* ---------------- 5. 编译 Java ---------------- */

step('javac 编译 Java');
const classesDir = path.join(BUILD, 'classes');
fs.mkdirSync(classesDir, { recursive: true });
const sources = [
  ...walk(path.join('android', 'src')).filter((f) => f.endsWith('.java')),
  ...walk(genDir).filter((f) => f.endsWith('.java')),
];
console.log(`  ${sources.length} 个源文件`);
run(JAVAC, [
  '-encoding', 'UTF-8',
  '-source', '11',
  '-target', '11',
  '-nowarn',
  '-classpath', ANDROID_JAR,
  '-d', classesDir,
  ...sources,
]);

/* ---------------- 6. d8 转 dex ---------------- */

step('d8 转 dex');
const dexDir = path.join(BUILD, 'dex');
fs.mkdirSync(dexDir, { recursive: true });
const classFiles = walk(classesDir).filter((f) => f.endsWith('.class'));
run(JAVA, [
  '-cp', D8_JAR,
  'com.android.tools.r8.D8',
  '--release',
  '--min-api', '24',
  '--lib', ANDROID_JAR,
  '--output', dexDir,
  ...classFiles,
]);
const dexFile = path.join(dexDir, 'classes.dex');
if (!fs.existsSync(dexFile)) {
  console.error('✗ d8 没有产出 classes.dex');
  process.exit(1);
}
console.log(`  classes.dex ${(fs.statSync(dexFile).size / 1024).toFixed(0)} KB`);

/* ---------------- 7. 合并 dex 进 APK ---------------- */

step('合并 classes.dex');
const toolClasses = path.join(BUILD, 'tools');
fs.mkdirSync(toolClasses, { recursive: true });
run(JAVAC, ['-encoding', 'UTF-8', '-nowarn', '-d', toolClasses, path.join('android', 'tools', 'ZipTool.java')]);

const addRoot = path.join(BUILD, 'addroot');
fs.mkdirSync(addRoot, { recursive: true });
fs.copyFileSync(dexFile, path.join(addRoot, 'classes.dex'));
const unaligned = path.join(BUILD, 'app-unaligned.apk');
run(JAVA, ['-cp', toolClasses, 'ZipTool', baseApk, addRoot, unaligned]);

/* ---------------- 8. 对齐 ---------------- */

step('zipalign 对齐');
const aligned = path.join(BUILD, 'app-aligned.apk');
run(ZIPALIGN, ['-f', '-p', '4', unaligned, aligned]);

/* ---------------- 9. 签名 ---------------- */

step('签名');
if (!fs.existsSync(KS)) {
  console.log('  生成签名用的 keystore（自用够了；要上应用商店请换自己的）');
  run(KEYTOOL, [
    '-genkeypair',
    '-keystore', KS,
    '-alias', 'aibeici',
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-storepass', 'android',
    '-keypass', 'android',
    '-dname', 'CN=AiBeiCi, OU=Personal, O=AiBeiCi, C=CN',
  ]);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const outApk = path.join(OUT_DIR, 'aibeici.apk');
run(JAVA, [
  '-jar', APKSIGNER_JAR,
  'sign',
  '--ks', KS,
  '--ks-pass', 'pass:android',
  '--key-pass', 'pass:android',
  '--min-sdk-version', '24',
  '--out', outApk,
  aligned,
]);

/* ---------------- 10. 校验 ---------------- */

step('校验产物');
// 注意：这里用直通输出而不是捕获 stdout —— 某些受限环境不允许管道式子进程
run(AAPT2, ['dump', 'badging', outApk]);
run(JAVA, ['-jar', APKSIGNER_JAR, 'verify', '--min-sdk-version', '24', '--print-certs', outApk]);
console.log('  ✓ 签名有效');

const apkSize = fs.statSync(outApk).size / 1024 / 1024;
console.log(`\n\x1b[32m✔ 打包完成：${outApk}（${apkSize.toFixed(1)} MB）\x1b[0m`);
console.log('  传到手机上点击安装即可（需要允许「安装未知来源应用」）\n');
