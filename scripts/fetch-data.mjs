/**
 * 下载构建词库所需的原始数据到 data/raw/
 * 只用公开数据源，全部可重新获取。
 *
 * 用法：node scripts/fetch-data.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RAW = 'data/raw';
const TMP = 'data/tmp';
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const FILES = [
  // 六级词书（含音标、英英释义、例句、同义词），三本合并使用
  ['CET6_1.jsonl', 'https://cdn.jsdelivr.net/gh/KyleBing/dict@master/book-json-full/CET6_1.json'],
  ['CET6_2.jsonl', 'https://cdn.jsdelivr.net/gh/KyleBing/dict@master/book-json-full/CET6_2.json'],
  ['CET6_3.jsonl', 'https://cdn.jsdelivr.net/gh/KyleBing/dict@master/book-json-full/CET6_3.json'],
  // 四级词表，用来区分「六级增量词」和「四级基础词」
  [
    'cet4.json',
    'https://cdn.jsdelivr.net/gh/KyleBing/english-vocabulary@master/json/3-CET4-%E9%A1%BA%E5%BA%8F.json',
  ],
  // 词形变化表（把读文章时的 wrote/writing 还原成 write）
  ['lemma.en.txt', 'https://cdn.jsdelivr.net/gh/skywind3000/ECDICT@master/lemma.en.txt'],
  // 词频表（决定新词的学习顺序）
  ['en_50k.txt', 'https://cdn.jsdelivr.net/gh/hermitdave/FrequencyWords@master/content/2018/en/en_50k.txt'],
  ['google10k.txt', 'https://cdn.jsdelivr.net/gh/first20hours/google-10000-english@master/google-10000-english-usa.txt'],
];

for (const [name, url] of FILES) {
  const dest = path.join(RAW, name);
  if (fs.existsSync(dest)) {
    console.log(`跳过（已存在） ${name}`);
    continue;
  }
  process.stdout.write(`下载 ${name} … `);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`失败 HTTP ${res.status}`);
    continue;
  }
  fs.writeFileSync(dest, await res.text());
  console.log(`${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
}

// ECDICT 主词库（含 cet6 标签、音标、双语释义、BNC/COCA 词频），通过 npm 分发获取
const ECDICT_CSV = path.join(TMP, 'ecdict', 'package', 'assets', 'ecdict.csv');
if (fs.existsSync(ECDICT_CSV)) {
  console.log('跳过（已存在） ECDICT 主词库');
} else {
  console.log('下载 ECDICT 主词库（约 23 MB，解开约 66 MB）…');
  execSync('npm pack ecdict@0.0.4 --pack-destination data/tmp --cache .npm-cache', {
    stdio: 'inherit',
  });
  fs.mkdirSync(path.join(TMP, 'ecdict'), { recursive: true });
  execSync(`tar -xzf ${path.join(TMP, 'ecdict-0.0.4.tgz')} -C ${path.join(TMP, 'ecdict')}`, {
    stdio: 'inherit',
  });
}

console.log('\n原始数据就绪。下一步：node scripts/build-dict.mjs');
