/**
 * 构建 CET-6 词库
 *
 * 数据来源：
 *  1. ECDICT（MIT, skywind3000/ECDICT）—— 权威 cet6 标签、音标、中文/英文释义、BNC/COCA 词频、词形变化
 *  2. KyleBing/dict 的 CET6 词书 —— 补充双语例句、同义词、更规范的国际音标
 *
 * 输出：public/data/words.json
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const RAW = 'data/raw';
const CSV = 'data/tmp/ecdict/package/assets/ecdict.csv';
const OUT = 'public/data/words.json';

// 原始数据没有提交进仓库（约 90 MB），缺了就给一条能照着做的提示
if (!fs.existsSync(CSV)) {
  console.error('');
  console.error('✗ 找不到 ECDICT 词库文件：' + CSV);
  console.error('  词库原始数据没有随仓库提交，先下载再构建：');
  console.error('    npm run fetch:data     # 约 90 MB，从 jsDelivr / npm 拉取');
  console.error('    npm run build:dict');
  console.error('');
  console.error('  只想直接用现成词库的话，public/data/words.json 已经在仓库里，不用重新构建。');
  console.error('');
  process.exit(1);
}

const POS_MAP = {
  n: 'n', v: 'v', vt: 'vt', vi: 'vi', adj: 'adj', a: 'adj', adv: 'adv', ad: 'adv',
  prep: 'prep', conj: 'conj', pron: 'pron', num: 'num', art: 'art',
  aux: 'aux', int: 'int', interj: 'int', abbr: 'abbr', pl: 'n',
};

function normalizePos(p) {
  if (!p) return '';
  const k = String(p).toLowerCase().replace(/[.\s]/g, '');
  if (!k) return '';
  return POS_MAP[k] || k.slice(0, 5);
}

function cleanText(s) {
  if (!s) return '';
  return String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const STOP_ACCEPT = new Set(['的', '地', '得', '了', '等', '等等', '某人', '某物', '某人某物']);

/** 把一条中文释义拆成若干候选片段 */
function splitItems(cn) {
  let s = String(cn || '');
  // 括号里是补充说明，整段去掉。否则 "(使)恶化" 会被拆成 "使)恶化" 这种垃圾
  s = s.replace(/[（(][^）)]*[）)]/g, ' ');
  s = s.replace(/[[\]【】]/g, ' ');
  return s
    .split(/[；;，,、/\n]+/)
    .map((x) => cleanText(x).replace(/\s/g, ''))
    .filter(Boolean);
}

function normalizeKey(raw) {
  let s = cleanText(raw).replace(/[\s]/g, '');
  s = s.replace(/^[a-zA-Z]{1,6}[.、]/, '');
  s = s.replace(/^[（(【[]|[）)】\]]$/g, '');
  s = s.replace(/[。；;，,、/|]+$/g, '');
  if (!s || s.length > 9) return '';
  if (STOP_ACCEPT.has(s)) return '';
  if (!/[\u4e00-\u9fa5]/.test(s)) return '';
  return s;
}

/**
 * 由中文释义生成答案键。
 *
 * 关键规则：形容词/副词去掉「的/地」之后不一定还是同一个意思。
 *   environmental adj. 环境的 → 去掉「的」得到「环境」，那是名词 environment 的意思，
 *   学生答「环境」不能算对。
 * 所以形/副词的「去 的」形式只进 candidate，由后面的派生词冲突检测决定升级还是降级。
 */
function buildAccept(senses, syns = []) {
  const keys = new Set();
  const candidates = new Set();

  const add = (raw, allowStrip) => {
    const s = normalizeKey(raw);
    if (!s) return;
    keys.add(s);
    if (!allowStrip) return;
    const stripped = s.replace(/(的|地|得)$/, '');
    if (stripped.length >= 2 && stripped !== s) candidates.add(stripped);
  };

  for (const s of senses) {
    for (const part of splitItems(s.cn)) add(part, true);
  }
  for (const s of syns) add(s, false);

  return { keys: [...keys], candidates: [...candidates] };
}

/** 推断一个英文词可能的词根（用于识别「答成了派生词的意思」） */
const SUFFIXES = [
  'ically', 'ically', 'ally', 'ically', 'ical', 'ally', 'ive', 'ous', 'ful', 'less',
  'able', 'ible', 'ary', 'ant', 'ent', 'al', 'ic', 'ly', 'ish', 'ed', 'ing', 'es', 's',
];

function baseForms(word) {
  const out = new Set();
  for (const suf of SUFFIXES) {
    if (!word.endsWith(suf)) continue;
    const stem = word.slice(0, -suf.length);
    if (stem.length < 3) continue;
    out.add(stem);
    out.add(stem + 'e');
    out.add(stem + 'y');
    if (/([bcdfgklmnprstvz])\1$/.test(stem)) out.add(stem.slice(0, -1));
  }
  return [...out];
}

/** ------------------ 1. ECDICT ------------------ */

const cet4Set = new Set();
const ecdict = new Map();

await new Promise((resolve, reject) => {
  const rl = readline.createInterface({ input: fs.createReadStream(CSV), crlfDelay: Infinity });
  let n = 0;
  rl.on('line', (line) => {
    n++;
    if (n === 1) return;
    const c = parseCsvLine(line);
    const word = cleanText(c[0]);
    if (!word) return;
    const key = word.toLowerCase();
    const tag = (c[7] || '').toLowerCase();
    if (/\bcet4\b/.test(tag)) cet4Set.add(key);
    if (!/\bcet6\b/.test(tag)) return;
    // 仅保留单词（含连字符/撇号），过滤短语与专有名词
    if (!/^[a-z][a-z'\-]{1,24}$/.test(key)) return;
    ecdict.set(key, {
      w: word,
      phonetic: cleanText(c[1]),
      definition: c[2] || '',
      translation: c[3] || '',
      collins: Number(c[5]) || 0,
      oxford: Number(c[6]) || 0,
      freq: Number(c[9]) || Number(c[8]) || 0,
      bnc: Number(c[8]) || 0,
      exchange: c[10] || '',
    });
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});
console.error(`ECDICT: cet6 词条 ${ecdict.size}，cet4 集合 ${cet4Set.size}`);

/** 模型补充的英文释义（enrich-defs.mjs 产出），用来填 ECDICT 的空缺 */
const EN_DEFS = (() => {
  const p = path.join(RAW, 'en-defs.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    console.error('en-defs.json 解析失败，忽略');
    return {};
  }
})();
console.error(`补充英文释义：${Object.keys(EN_DEFS).length} 条`);

/** 模型生成的中文词义提示（enrich-hints.mjs 产出），给「看英文写中文」的最后一级提示 */
const ZH_HINTS = (() => {
  const p = path.join(RAW, 'zh-hints.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    console.error('zh-hints.json 解析失败，忽略');
    return {};
  }
})();
console.error(`中文词义提示：${Object.keys(ZH_HINTS).length} 条`);

/** 模型生成的中文助记（enrich-mnemonics.mjs 产出），答对答错都显示 */
const MNEMONICS = (() => {
  const p = path.join(RAW, 'mnemonics.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    console.error('mnemonics.json 解析失败，忽略');
    return {};
  }
})();
console.error(`中文助记：${Object.keys(MNEMONICS).length} 条`);

/** ------------------ 2. 词书例句/同义词 ------------------ */

const richMap = new Map();
/**
 * 默认**不**使用 KyleBing 词书 —— 那个仓库没有声明许可证，它的例句/同义词不宜再分发。
 * 加 --rich 才会把例句与同义词并进词库（自行确认授权后再这么做）。
 */
const RICH = process.argv.includes('--rich');
if (RICH) {
  console.error('--rich：把 KyleBing 词书的例句/同义词并入词库（请自行确认授权）');
} else {
  console.error('默认合规模式：只用 ECDICT + 模型生成内容，不含词书例句/同义词（加 --rich 才包含）');
}

for (const file of RICH ? ['CET6_1', 'CET6_2', 'CET6_3'] : []) {
  const p = path.join(RAW, `${file}.jsonl`);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const wc = obj?.content?.word?.content;
    const head = obj?.headWord || obj?.content?.word?.wordHead;
    if (!head || !wc) continue;
    const key = String(head).toLowerCase().trim();
    const ex = [];
    for (const s of wc.sentence?.sentences || []) {
      const en = cleanText(s.sContent).replace(/^[.\u2026\s]+/, '');
      if (en) ex.push({ en: en.slice(0, 240), cn: cleanText(s.sCn).slice(0, 160) });
      if (ex.length >= 2) break;
    }
    const syn = [];
    const synEn = [];
    for (const s of wc.syno?.synos || []) {
      for (const part of String(s.tran || '').split(/[；;，,、\/]/)) {
        const v = cleanText(part).replace(/[\[\]]/g, '');
        if (!v || !/[\u4e00-\u9fa5]/.test(v) || v.length > 8) continue;
        // 过滤源数据噪声：environment 的同义词里就带过一条 "环境环境"
        if (/^(.{2,})\1$/.test(v)) continue;
        syn.push(v);
      }
      // 顺带收英文近义词，给「没有例句也没有英文释义」的词做提示兜底
      for (const h of s.hwds || []) {
        const w2 = cleanText(h.w);
        if (!w2 || w2.toLowerCase() === key) continue;
        if (!/^[a-z][a-z'\- ]{1,24}$/.test(w2.toLowerCase())) continue;
        if (!synEn.includes(w2)) synEn.push(w2);
      }
      if (syn.length >= 6 && synEn.length >= 4) break;
    }
    const prev = richMap.get(key);
    const score = (e) => (e.ex.length ? 2 : 0) + (e.syn.length ? 1 : 0) + (e.uk ? 1 : 0) + (e.synEn.length ? 1 : 0);
    const cur = {
      uk: cleanText(wc.ukphone || wc.phone || ''),
      us: cleanText(wc.usphone || ''),
      ex,
      syn: [...new Set(syn)],
      synEn: synEn.slice(0, 4),
    };
    if (!prev || score(cur) > score(prev)) richMap.set(key, cur);
  }
}

/** ------------------ 3. 词形变化 ------------------ */

const lemmaForms = new Map();
fs.readFileSync(path.join(RAW, 'lemma.en.txt'), 'utf8')
  .split(/\r?\n/)
  .forEach((line) => {
    const m = line.match(/^([^\/;#][^\/]*)\/(\d+)\s*->\s*(.+)$/);
    if (!m) return;
    const lemma = m[1].trim().toLowerCase();
    const forms = m[3].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (lemma && forms.length) lemmaForms.set(lemma, forms);
  });

function buildForms(key, exchange) {
  const set = new Set([key]);
  for (const part of String(exchange || '').split('/')) {
    const v = part.replace(/^[a-z0-9]+:/i, '').trim().toLowerCase();
    if (v && /^[a-z'\- ]+$/.test(v)) set.add(v);
  }
  for (const f of lemmaForms.get(key) || []) set.add(f);
  return [...set].slice(0, 8);
}

/** ------------------ 4. 组装 ------------------ */

function parseTranslation(translation) {
  const senses = [];
  const seen = new Set();
  for (const line of String(translation || '').split(/\\n|\n/)) {
    let t = cleanText(line);
    if (!t) continue;
    const m = t.match(/^([a-zA-Z]{1,6}\.)\s*(.+)$/);
    const p = m ? normalizePos(m[1]) : '';
    let cn = m ? m[2] : t;
    // 去掉 [经] [化] [医] 这类领域标记
    cn = cleanText(cn.replace(/[\[【][^\]】]{1,8}[\]】]/g, ' '));
    if (!cn) continue;
    // 同一个意思重复出现（"n. 代理人, 律师" 与 "[经] 律师, 代理人"）只留一条
    const key = cn
      .split(/[,，;；、\/]/)
      .map((x) => cleanText(x))
      .filter(Boolean)
      .sort()
      .join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    senses.push({ p, cn });
  }
  return senses;
}

function parseDefinition(definition) {
  const map = new Map();
  for (const line of String(definition || '').split(/\\n|\n/)) {
    const t = cleanText(line);
    if (!t) continue;
    const m = t.match(/^([a-zA-Z]{1,6}\.)\s*(.+)$/);
    const p = m ? normalizePos(m[1]) : '';
    const en = m ? m[2] : t;
    if (p && !map.has(p)) map.set(p, en.slice(0, 180));
  }
  return map;
}

const words = [];
let dropInflected = 0;
let dropObscure = 0;
for (const [key, e] of ecdict) {
  // 丢弃专有名词（Jesus / Catholic / Egyptian 之类）
  if (/^[A-Z]/.test(e.w)) continue;
  // 丢弃屈折变体（grants / hypotheses 之类），只保留原形。
  // 判断依据不能依赖词书数据：sophisticated 虽然源自 sophisticate，
  // 但它本身是柯林斯/牛津收录的独立词条，必须保留。
  if (/(^|\/)0:/.test(e.exchange) && !richMap.has(key) && !e.collins && !e.oxford) {
    dropInflected++;
    continue;
  }
  // 丢弃既无词频、又非柯林斯/牛津核心词的生僻条目
  const f = e.freq || e.bnc || 0;
  if (!f && !e.collins && !e.oxford) {
    dropObscure++;
    continue;
  }
  const senses = parseTranslation(e.translation);
  if (!senses.length) continue;
  const defs = parseDefinition(e.definition);
  for (const s of senses) s.en = defs.get(s.p) || '';
  // ECDICT 没有英释的（约 1500 个），用 enrich-defs.mjs 补的那句顶上，保证总有提示可用
  if (!senses.some((s) => s.en && s.en.length > 3)) {
    const extra = EN_DEFS[key];
    if (extra && senses.length) senses[0].en = extra;
  }
  const rich = richMap.get(key);
  const { keys, candidates } = buildAccept(senses, rich?.syn || []);
  words.push({
    w: e.w,
    uk: rich?.uk || e.phonetic || '',
    us: rich?.us || '',
    ph: e.phonetic || '',
    f: f || 999999,
    bnc: e.bnc || 0,
    collins: e.collins,
    oxford: e.oxford,
    c4: cet4Set.has(key) ? 1 : 0,
    senses,
    ex: rich?.ex?.length ? rich.ex : [],
    syn: rich?.syn?.length ? rich.syn : [],
    synEn: rich?.synEn?.length ? rich.synEn : [],
    zhHint: ZH_HINTS[key] || '',
    mnemonic: MNEMONICS[key] || '',
    forms: buildForms(key, e.exchange),
    accept: keys.slice(0, 16),
    __candidates: candidates,
  });
}
console.error(`过滤：屈折变体 ${dropInflected}｜生僻条目 ${dropObscure}`);

/* ---------- 派生词冲突检测 ----------
 * 形容词「环境的」去掉「的」得到「环境」，而「环境」正是名词 environment 的释义。
 * 这种「答成了派生词词根的意思」的情况不能算对，降级为 weak（判 partial）。
 */
const acceptByWord = new Map();
for (const w of words) acceptByWord.set(w.w.toLowerCase(), new Set(w.accept));

let promoted = 0;
let demoted = 0;
const demotedExamples = [];

for (const w of words) {
  const senses = w.senses;
  // 只会「答成词根意思」的是形/副词类词条：有形容词/副词义项，且没有名词/动词义项。
  // 注意有些义项没有标注词性（p 为空），不能因此就否定它是形容词。
  const hasNounOrVerb = senses.some((s) => ['n', 'v', 'vt', 'vi'].includes(s.p));
  const hasModifier = senses.some((s) => s.p === 'adj' || s.p === 'adv');
  const isModifierWord = hasModifier && !hasNounOrVerb;

  // 释义里明确写出来的键，永远算对，不参与升降级
  const strongInit = new Set(w.accept);
  const accept = new Set(strongInit);
  const weak = new Set();

  for (const cand of w.__candidates || []) {
    if (strongInit.has(cand) || accept.has(cand)) continue;

    let conflictWith = '';
    if (isModifierWord) {
      for (const base of baseForms(w.w.toLowerCase())) {
        if (base === w.w.toLowerCase()) continue;
        const baseAccept = acceptByWord.get(base);
        if (baseAccept && baseAccept.has(cand)) {
          conflictWith = base;
          break;
        }
      }
    }

    if (conflictWith) {
      weak.add(cand);
      demoted++;
      if (demotedExamples.length < 6) demotedExamples.push(`${w.w}(「${cand}」↔ ${conflictWith})`);
    } else {
      accept.add(cand);
      promoted++;
    }
  }

  w.accept = [...accept].slice(0, 16);
  w.weak = [...weak];
  delete w.__candidates;
}

console.error(`派生词冲突：降级为 partial ${demoted} 条｜补入正确答案 ${promoted} 条`);
if (demotedExamples.length) console.error('  例：', demotedExamples.join('｜'));

// 排序：六级增量词在前（排除四级已覆盖的词），组内按词频（常用优先）→ 柯林斯星级 → 字母
words.sort((a, b) => a.c4 - b.c4 || a.f - b.f || b.collins - a.collins || a.w.localeCompare(b.w));

const out = {
  v: 3,
  source: 'ECDICT (MIT) + KyleBing/dict',
  generatedAt: new Date().toISOString(),
  count: words.length,
  words,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));

const inc = words.filter((w) => !w.c4);
console.error('--- 构建完成 ---');
console.error(`总词数 ${words.length}｜六级增量 ${inc.length}｜四级重叠 ${words.length - inc.length}`);
console.error(
  `音标 ${words.filter((w) => w.uk || w.ph).length}｜例句 ${words.filter((w) => w.ex.length).length}｜判分键 ${words.filter((w) => w.accept.length).length}｜弱键 ${words.filter((w) => (w.weak || []).length).length}`,
);
console.error(`输出 ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
console.error('增量词前 15:', inc.slice(0, 15).map((w) => `${w.w}(${w.f})`).join(' '));
console.error(
  '增量词 500/1000/2000:',
  [500, 1000, 2000].filter((i) => i < inc.length).map((i) => `${inc[i].w}(${inc[i].f})`).join(' '),
);
