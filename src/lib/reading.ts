import { idbPut, kvGet, kvSet } from './db';
import { chat, parseJsonLoose } from './llm';
import type { Question, Reading, Settings, Word } from './types';

const TOPICS = [
  '城市生活与通勤',
  '科技如何改变教育',
  '环境保护与可持续消费',
  '职场沟通与团队协作',
  '健康作息与运动习惯',
  '人工智能对社会的影响',
  '旅行与跨文化交流',
  '消费习惯与广告',
];

function hashNum(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判断文章里是否出现了该词（含变形） */
export function appearsIn(body: string, word: Word): boolean {
  const text = body.toLowerCase();
  for (const form of word.forms) {
    if (!form) continue;
    const re = new RegExp(`\\b${escapeRe(form.toLowerCase())}\\b`, 'i');
    if (re.test(text)) return true;
  }
  return false;
}

function countWords(body: string): number {
  return body.trim().split(/\s+/).filter(Boolean).length;
}

function pickQuestions(raw: any): Question[] {
  const out: Question[] = [];
  for (const q of Array.isArray(raw) ? raw : []) {
    const text = String(q?.q || '').trim();
    const options = (Array.isArray(q?.options) ? q.options : []).map((o: any) => String(o).trim());
    const answer = Number(q?.answer);
    if (!text || options.length !== 4 || !Number.isInteger(answer) || answer < 0 || answer > 3) continue;
    if (new Set(options).size !== 4) continue; // 选项重复的话题目有歧义，直接不要
    out.push({ q: text, options, answer, explain: String(q?.explain || '').trim().slice(0, 300) });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * 打乱四个选项的顺序，并同步换算正确答案的下标。
 *
 * 模型有很强的「把正确答案写在第一个」的偏好（位置偏差），光在提示词里要求
 * 「正确答案不要总放 A」基本没用，必须在本地重排。
 */
export function shuffleQuestion(q: Question): Question {
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const options = order.map((old) => q.options[old]);
  const answer = order.indexOf(q.answer);
  return { ...q, options, answer: answer >= 0 ? answer : q.answer };
}

function buildMessages(targets: Word[], topic: string, missing: string[] = [], strict = false) {
  const list = targets
    .map((w) => `- ${w.w}${w.senses[0] ? `（${w.senses[0].p ? `${w.senses[0].p}. ` : ''}${w.senses[0].cn}）` : ''}`)
    .join('\n');

  const system = `你是一位给中国大学英语六级考生编写阅读材料的作者。
写一篇英语短文，并出 5 道单选题。
硬性要求：
1. 正文 260–330 个英文单词，语言自然流畅，风格接近英美报刊的科普或评论文章。
2. 下面列出的每个目标词，都必须在正文中至少出现一次。可以按其语法需要使用变形（复数、过去式、派生词）。这是最硬的要求，必须逐词核对。
3. 目标词之外的用词不要超过六级大纲水平，避免生僻词和专有名词堆砌。
4. 句子以中长句为主，难度对标六级阅读真题。
5. 5 道题的题型分布：1 道主旨题、2 道细节题、1 道词义猜测题（考目标词在文中的意思）、1 道推理题。
   每题 4 个选项，只有一个正确答案，错误选项要有迷惑性，答案必须有原文依据。
   正确答案不要总是放在第一个选项，四道题的答案位置要打散。explain 用中文写解析。
只输出 JSON，不要任何多余文字：
{"title":"英文标题","body":"英文正文","questions":[{"q":"题目","options":["选项A","选项B","选项C","选项D"],"answer":2,"explain":"中文解析"}]}`;

  const user = `目标词（必须全部出现在正文里）：
${list}

写作主题方向：${topic}
${strict && missing.length ? `\n注意：上一版遗漏了这些词，这次务必让它们出现在正文中：${missing.join('、')}` : ''}`;

  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export interface ReadingDraft {
  title: string;
  body: string;
  covered: string[];
  missing: string[];
  questions: Question[];
}

/**
 * 校验并规整模型返回的文章：长度、目标词覆盖、题目结构。
 * 不合格直接抛错，由上层决定重试还是失败。
 */
export function validateReading(raw: any, words: Word[]): ReadingDraft {
  const body = String(raw?.body || '').trim();
  const title = String(raw?.title || '').trim() || 'Reading';
  const n = countWords(body);
  if (n < 120) throw new Error(`文章太短（${n} 词）`);
  if (n > 600) throw new Error(`文章太长（${n} 词）`);

  const covered: string[] = [];
  const missing: string[] = [];
  for (const w of words) (appearsIn(body, w) ? covered : missing).push(w.w);

  // 校验通过后立刻打乱选项：模型几乎总是把正确答案放第一个
  const questions = pickQuestions(raw?.questions).map(shuffleQuestion);
  if (questions.length < 3) throw new Error(`题目不够（${questions.length} 道）`);

  return { title, body, covered, missing, questions };
}

export async function getCachedReading(id: string): Promise<Reading | undefined> {
  return kvGet<Reading>(`reading:${id}`);
}

export interface GenerateOptions {
  date: string;
  targets: Word[];
  settings: Settings;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

/**
 * 生成（并缓存）当天的阅读理解。
 * 一次失败会用「遗漏词清单」重试一次；仍不达标则照用，但在 UI 上标注缺失词。
 */
export async function generateReading({
  date,
  targets,
  settings,
  signal,
  onProgress,
}: GenerateOptions): Promise<Reading> {
  const words = targets.slice(0, 18);
  const sig = `${date}|${settings.model}|${words.map((w) => w.w).join(',')}`;
  const id = hashNum(sig).toString(36);

  const cached = await getCachedReading(id);
  if (cached) return cached;

  const topic = TOPICS[hashNum(date) % TOPICS.length];
  let missing: string[] = [];
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      onProgress?.(attempt === 0 ? '正在根据今天的词写一篇短文…' : '补上遗漏的目标词，重写一次…');
      const { content } = await chat(
        {
          messages: buildMessages(words, topic, missing, attempt > 0),
          temperature: 0.85,
          json: true,
          maxTokens: 2200,
          signal,
        },
        settings,
      );

      const raw = parseJsonLoose<any>(content);
      const valid = validateReading(raw, words);

      const coverage = valid.covered.length / words.length;
      if (coverage < 0.85 && attempt === 0) {
        missing = valid.missing;
        continue; // 换一版
      }

      const reading: Reading = {
        id,
        sig,
        date,
        title: valid.title,
        body: valid.body,
        covered: valid.covered,
        missing: valid.missing,
        questions: valid.questions,
        at: Date.now(),
      };
      await kvSet(`reading:${id}`, reading);
      await kvSet(`reading:${date}`, reading);
      await idbPut('readings', reading);
      return reading;
    } catch (e) {
      lastError = e;
      if (attempt === 1) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('阅读理解生成失败');
}

/** 取当天已生成的阅读（可能没有） */
export async function findTodayReading(date: string): Promise<Reading | undefined> {
  return kvGet<Reading>(`reading:${date}`);
}

/**
 * 把文章译成中文（做完题后给对照用）。
 * 按文章 id 缓存，同一篇只翻一次；失败不写缓存，下次还能重试。
 */
export async function translateReading(
  reading: Reading,
  settings: Settings,
  signal?: AbortSignal,
): Promise<string> {
  const key = `trans:${reading.id}`;
  const cached = await kvGet<string>(key);
  if (cached) return cached;

  const { content } = await chat(
    {
      messages: [
        {
          role: 'system',
          content:
            '你是一位给中国学生做对照阅读的译者。把英文短文译成自然、通顺的现代汉语，' +
            '准确传达原意，保留原来的段落划分。只输出译文正文，不要标题、不要任何说明或标注。',
        },
        { role: 'user', content: reading.body },
      ],
      temperature: 0.3,
      maxTokens: 1800,
      signal,
    },
    settings,
  );

  const text = content
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/, '')
    .trim();
  if (!text) throw new Error('翻译返回空内容');
  await kvSet(key, text);
  return text;
}
