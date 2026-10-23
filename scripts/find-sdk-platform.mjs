/**
 * 从 Google 的 SDK 仓库清单里找出 platform 包的确切 zip 文件名，
 * 并输出下载地址，供 build-apk 脚本使用。
 */
const res = await fetch('https://dl.google.com/android/repository/repository2-3.xml');
const text = await res.text();

const blocks = text.split('<remotePackage').slice(1);
const found = [];

for (const block of blocks) {
  const pathMatch = block.match(/path="(platforms;android-[^"]+)"/);
  if (!pathMatch) continue;
  const version = pathMatch[1].split(';')[1];
  const num = Number(version.replace('android-', ''));
  if (!Number.isFinite(num) || num < 30) continue;
  const urls = [...block.matchAll(/<url>([^<]+\.zip)<\/url>/g)].map((m) => m[1]);
  for (const u of urls) found.push({ version, num, url: u });
}

found.sort((a, b) => b.num - a.num);
for (const f of found.slice(0, 10)) console.log(f.num, f.version, f.url);
