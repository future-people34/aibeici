import { cacheGet, cacheSet } from './db';
import { getWord } from './dict';
import { chat, parseJsonLoose, type ChatMessage } from './llm';
import type { JudgeResult, Settings, Word, Verdict } from './types';

const PUNCT =
  /[，,。.；;：:、！!？?（）()【】\[\]「」《》〈〉“”‘’"'`~@#$%^&*+=|\\/<>\-—_·…\s\u3000]/g;

/** 归一化：全角转半角、去标点空白、小写 */
export function normalize(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000]/g, ' ')
    .toLowerCase()
    .replace(PUNCT, '')
    .trim();
}

/** 把一条中文释义拆成可比较的短键，如 "放弃；抛弃，遗弃" → [放弃, 抛弃, 遗弃] */
export function splitKeys(cn: string): string[] {
  const out: string[] = [];
  for (const raw of String(cn || '').split(/[；;，,、/|]/)) {
    let s = normalize(raw).replace(/^(的|地|得)/, '');
    s = s.replace(/(的|地|得)$/, '');
    if (!s || s.length < 2 || s.length > 12) continue;
    if (!/[\u4e00-\u9fa5]/.test(s)) continue;
    out.push(s);
  }
  return out;
}

const GIVE_UP = /^(不知道|不知道什么意思|不会|不认识|忘了|忘记|没学过|不懂|不知道啊|不知道哦)$/;

/** 带猜测口吻的答案（"好像""是不是""可能"）不能靠字符串匹配判对，交给模型 */
const HEDGE = /不知道|不确定|不记得|忘了|忘记|是不是|可能|也许|好像|大概|估计|猜|感觉|什么意思|啥/;

/** 本地规则层：确定性、零成本、零延迟 */
export function ruleJudge(word: Word, rawInput: string): JudgeResult | null {
  const inp = normalize(rawInput);
  if (!inp) return null;
  if (GIVE_UP.test(inp)) {
    return { verdict: 'wrong', matched: 0, reason: '这个词还没建立印象，先看答案吧。', hint: '', source: 'rule' };
  }
  if (inp.length > 24) return null; // 长句交给模型
  if (HEDGE.test(inp)) return null; // 猜测口吻交给模型

  // 义项级键表
  const senseKeys: string[][] = word.senses.map((s) => splitKeys(s.cn));
  const acceptSet = new Set(word.accept.map((k) => normalize(k)).filter((k) => k.length >= 2));

  const hitSense = (key: string): number => {
    for (let i = 0; i < senseKeys.length; i++) {
      if (senseKeys[i].some((k) => k === key || k.includes(key) || key.includes(k))) return i + 1;
    }
    return 0;
  };

  // 1. 精确命中
  if (acceptSet.has(inp)) {
    return {
      verdict: 'correct',
      matched: hitSense(inp),
      reason: `「${inp}」就是它的一个释义。`,
      hint: '',
      source: 'rule',
    };
  }

  // 2. 词性错配：形/副词答成了词根的意思（如 environmental 答「环境」）
  //    必须在下面的宽松匹配之前判断 —— 否则「环境」会因为它是「环境的」的前缀而被判对。
  const weakSet = new Set((word.weak ?? []).map((k) => normalize(k)).filter((k) => k.length >= 2));
  if (weakSet.has(inp)) {
    return posMismatch(word, inp);
  }

  // 3. 用户写了更长的解释，包含某个义项键
  for (const key of acceptSet) {
    if (key.length >= 2 && inp.includes(key)) {
      return {
        verdict: 'correct',
        matched: hitSense(key),
        reason: `包含了「${key}」这一义，答对了。`,
        hint: '',
        source: 'rule',
      };
    }
  }

  // 4. 用户只写了义项的一半（如「世故」对「老于世故」）
  if (inp.length >= 2) {
    for (const key of acceptSet) {
      if (key.includes(inp)) {
        return {
          verdict: 'correct',
          matched: hitSense(key),
          reason: `方向对了，它的一个释义是「${key}」。`,
          hint: '',
          source: 'rule',
        };
      }
    }
  }

  // 5. 输入里带着词性错配的键，但比它更长（如「环境方面」）
  const hitWeak = [...weakSet].find((k) => inp.includes(k));
  if (hitWeak) return posMismatch(word, hitWeak);

  return null;
}

/** 答成了词根/派生词的意思，词性对不上 → partial */
function posMismatch(word: Word, key: string): JudgeResult {
  const strong = word.accept.find((k) => k.startsWith(key) && k !== key);
  const pos = posNameOf(word);
  return {
    verdict: 'partial',
    matched: 0,
    reason: strong
      ? `「${key}」是它词根的意思；${word.w} 这里是${pos}，应该答「${strong}」这种形式。`
      : `「${key}」是它词根的意思；${word.w} 这里是${pos}，词性对不上。`,
    hint: '',
    source: 'rule',
  };
}

const POS_CN: Record<string, string> = {
  n: '名词',
  v: '动词',
  vt: '动词',
  vi: '动词',
  adj: '形容词',
  adv: '副词',
  prep: '介词',
  conj: '连词',
  pron: '代词',
  num: '数词',
};

function posNameOf(word: Word): string {
  const p = word.senses.find((s) => s.p)?.p ?? '';
  return POS_CN[p] ?? (p ? p : '另一种词性');
}

function buildPrompt(word: Word, input: string): ChatMessage[] {
  const list = word.senses
    .map((s, i) => `${i + 1}. ${s.p ? `${s.p}. ` : ''}${s.cn}${s.en ? `（${s.en}）` : ''}`)
    .join('\n');
  const ex = word.ex[0] ? `例句：${word.ex[0].en}（${word.ex[0].cn}）` : '';

  const system = `你是一位严格但鼓励式的中国英语老师，负责判断学生写出的中文释义是否正确。
判定标准：
- correct：抓住了该词的核心含义，且词性一致。同义词、近义表述、口语化说法都算对，不必与参考答案逐字一致。
- partial：方向大致对但有问题。例如词性弄错、只答到字面、只写了极泛的词（"的""东西""做"）、答成相近但不同的词。
- wrong：含义不对、与该词无关、或把它和另一个词混淆了。
词性要求（很重要）：
- 词性必须对得上。目标义项是形容词时，学生答成名词（例如 environmental 答"环境"）只能判 partial，并指出应该是"环境的"这类说法；副词同理（答成"环境"而不是"环境地/在环境方面"）。
- 派生词不是同一个词：environment / environmental / environmentally 是三个不同的词，不能因为词根相同就判对，只能按目标词当前义项的词性来判断。
- 动词义项要接受动词性表述（"使…""…化""做…"）；如果学生只答出该动词派生名词的意思（例如 decide 答"决定权"），判 partial。
补充规则：
- 学生写的若是该词的另一个真实义项（不在下面给出的义项里）且词性一致，判 correct；若词性不同，判 partial。
- 学生可能写英文、拼音或整句解释，一律按语义判断。
- reason 用中文，不超过 40 字，直接说结论和原因，不要复述学生答案。
- hint 给一句便于记忆的提示（词根、搭配、近义辨析均可），不超过 30 字；没有把握就留空字符串。
只输出 JSON，不要任何解释文字：
{"verdict":"correct|partial|wrong","matched":义项序号(1-${word.senses.length})或0,"reason":"...","hint":"..."}`;

  const user = `单词：${word.w}
${word.uk ? `音标：/${word.uk}/` : ''}
本课义项：
${list}
${ex}
学生写的释义：${input}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function coerce(raw: any, senseCount: number): JudgeResult {
  const v = String(raw?.verdict || '').toLowerCase();
  const verdict: Verdict = v === 'correct' ? 'correct' : v === 'partial' ? 'partial' : 'wrong';
  let matched = Number(raw?.matched);
  if (!Number.isFinite(matched) || matched < 0 || matched > senseCount) matched = 0;
  const reason = String(raw?.reason || '').slice(0, 80);
  const hint = String(raw?.hint || '').slice(0, 60);
  return { verdict, matched, reason, hint, source: 'llm' };
}

/**
 * 判分主流程：缓存 → 本地规则 → 大模型 → 兜底
 */
export async function judge(word: Word, input: string, settings: Settings): Promise<JudgeResult> {
  const key = `j|${word.w.toLowerCase()}|${normalize(input)}`;
  const cached = await cacheGet<JudgeResult>(key);
  if (cached) return cached;

  const ruled = ruleJudge(word, input);
  if (ruled) {
    if (ruled.verdict === 'correct') await cacheSet(key, ruled);
    return ruled;
  }

  try {
    const { content } = await chat({ messages: buildPrompt(word, input), temperature: 0, json: true, maxTokens: 300 }, settings);
    const result = coerce(parseJsonLoose(content), word.senses.length);
    await cacheSet(key, result);
    return result;
  } catch (e: any) {
    return {
      verdict: 'wrong',
      matched: 0,
      reason: `本地和模型都没能确认你的答案（${e?.message || e}）。先看正确答案。`,
      hint: '',
      source: 'fallback',
    };
  }
}

/** 展示用的完整释义 */
export function officialText(word: Word): { pos: string; cn: string; en: string }[] {
  return word.senses.map((s) => ({ pos: s.p, cn: s.cn, en: s.en }));
}

/** 派生后缀：能把词拆回一个真实存在的词根时，才给构词线索 */
const DERIV_SUFFIXES = [
  'ically',
  'ical',
  'ation',
  'ition',
  'ment',
  'ness',
  'ity',
  'ous',
  'ive',
  'ful',
  'less',
  'able',
  'ible',
  'al',
  'ic',
  'ly',
  'ist',
  'ize',
  'ify',
];

function rootHint(word: string): string {
  const w = word.toLowerCase();
  for (const suf of DERIV_SUFFIXES) {
    if (!w.endsWith(suf) || w.length - suf.length < 3) continue;
    const stem = w.slice(0, -suf.length);
    const base = [stem, `${stem}e`, `${stem}y`].find((c) => c !== w && getWord(c));
    if (base) return `${base} + -${suf}`;
  }
  return '';
}

/**
 * 把中文例句里表示目标词的部分挖掉，做成中文填空。
 * 译文常常是意译，找不到任何可挖的键时返回空串，宁可不给这条提示，
 * 也不要直接把带答案的整句摆出来。
 */
function blankChinese(cn: string, word: Word): string {
  const keys = [...word.accept, ...(word.weak ?? [])]
    .filter((k) => k.length >= 2)
    .sort((a, b) => b.length - a.length);
  let out = cn;
  let hit = 0;
  for (const k of keys) {
    if (!out.includes(k)) continue;
    out = out.split(k).join('______');
    hit++;
    if (hit >= 2) break;
  }
  return hit ? out : '';
}

/**
 * 提示阶梯：按「信息量递增」排序，只放这个词真正有的线索，而且要让人看得懂。
 *
 * 这个场景是「看着英文写中文」，单词已经显示在屏幕上，所以刻意排除：
 *  - 首字母（屏幕上就有）
 *  - 音节数 / 字母数（屏幕上就能数）
 *  - 中文标准译词（等于直接给答案）
 * 英文释义也不再作为提示 —— 背词的往往是英语基础弱的人，英文解释等于没给提示。
 */
function hintLadder(word: Word): string[] {
  const out: string[] = [];

  const root = rootHint(word.w);
  if (root) out.push(`构词：${root}`);

  const ex = word.ex[0];
  if (ex) {
    const cn = blankChinese(ex.cn, word);
    if (cn) out.push(`中文例句：${cn}`);
  }

  if (word.zhHint) out.push(`词义：${word.zhHint}`);

  // 兜底：万一既没中文例句也没中文提示，才退回英文释义
  if (!out.length) {
    const en = word.senses.find((s) => s.en)?.en;
    if (en) out.push(`英文释义：${en}`);
  }

  return out.slice(0, 3);
}

/** 这个词有几级提示可用（1~3）；0 表示没有现成线索 */
export function hintCount(word: Word): number {
  return hintLadder(word).length;
}

/** 取第 level 级提示（level 从 1 开始） */
export function hintFor(word: Word, level: number): string {
  const ladder = hintLadder(word);
  if (!ladder.length) {
    return `这个词没有现成的例句或英文释义可用，点「直接看答案」吧。`;
  }
  const idx = Math.min(Math.max(level, 1), ladder.length) - 1;
  const text = ladder[idx];
  // 第一级带上词性，因为卡片上不显示词性
  return idx === 0 ? `${posNameOf(word)}｜${text}` : text;
}

/** 展示答案用的文案（点「直接看答案」时用） */
export function revealText(word: Word): string {
  return `直接看答案：${word.senses.map((s) => `${s.p ? `${s.p}. ` : ''}${s.cn}`).join('；')}`;
}
