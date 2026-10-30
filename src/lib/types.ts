/** 词条中的一个义项 */
export interface Sense {
  /** 词性：n / v / vt / vi / adj / adv ... */
  p: string;
  /** 中文释义：放弃, 抛弃, 遗弃 */
  cn: string;
  /** 英英释义（可能为空） */
  en: string;
}

export interface Example {
  en: string;
  cn: string;
}

/** 词库条目，字段名做短以压缩体积 */
export interface Word {
  /** 单词 */
  w: string;
  /** 英式音标 */
  uk: string;
  /** 美式音标 */
  us: string;
  /** 备用音标（ECDICT 原始格式） */
  ph: string;
  /** 词频排名，越小越常用；999999 表示未收录 */
  f: number;
  bnc: number;
  collins: number;
  oxford: number;
  /** 1 = 四级基础词，0 = 六级增量词 */
  c4: number;
  senses: Sense[];
  ex: Example[];
  syn: string[];
  /** 英文近义词：给「既没例句也没英文释义」的词做提示兜底 */
  synEn?: string[];
  /** 一句中文词义提示（模型生成，已避开标准译词），用于提示的最后一级 */
  zhHint?: string;
  /** 中文助记（词根拆解 / 联想 / 搭配），答对答错都会显示 */
  mnemonic?: string;
  /** 该词的常见变形，用于校验阅读文章是否包含目标词 */
  forms: string[];
  /** 本地规则判分用的可接受中文答案键 */
  accept: string[];
  /**
   * 词性错配的弱答案键：形/副词的「去 的」形式撞上了派生词根的意思
   * （如 environmental 的「环境」＝ environment）。命中时判 partial 而不是 correct。
   */
  weak?: string[];
}

export type Verdict = 'correct' | 'partial' | 'wrong';

export interface JudgeResult {
  verdict: Verdict;
  /** 命中的义项序号（从 1 开始；0 表示未命中） */
  matched: number;
  /** 给用户的中文反馈 */
  reason: string;
  /** 记忆提示，可为空 */
  hint: string;
  /** 判分来源：本地规则 / 大模型 */
  source: 'rule' | 'llm' | 'fallback';
}

export interface Question {
  q: string;
  options: string[];
  /** 正确选项下标，从 0 开始 */
  answer: number;
  explain: string;
}

export interface Reading {
  id: string;
  /** 用于去重的签名（日期 + 词表） */
  sig: string;
  date: string;
  title: string;
  body: string;
  /** 实际出现在文章里的目标词 */
  covered: string[];
  /** 未出现的目标词 */
  missing: string[];
  questions: Question[];
  at: number;
}

/** 记忆卡片状态 */
export interface MemCard {
  /** 单词小写，主键 */
  id: string;
  w: string;
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  /** 0=New 1=Learning 2=Review 3=Relearning */
  state: number;
  last_review?: number;
  introducedAt: number;
  /** 累计作答次数与正确次数（用于统计） */
  seen: number;
  okCount: number;
  /** 进入易忘词名单时的答错次数（≥3 表示间隔被压制过） */
  leech?: number;
}

export interface Attempt {
  id?: number;
  w: string;
  input: string;
  verdict: Verdict;
  /** 用户在看到答案前用掉了几级提示 */
  hint: number;
  /** 作答耗时（毫秒） */
  ms: number;
  at: number;
  source: 'new' | 'review';
  reason: string;
}

export interface Settings {
  /** 每日新词量 */
  dailyNew: number;
  /** 每日复习上限 */
  dailyReviewCap: number;
  /** 学习范围：inc = 六级增量词，all = 六级全量 */
  pool: 'inc' | 'all';
  apiKey: string;
  model: string;
  baseUrl: string;
  /** 显示音标 */
  showPhonetic: boolean;
  /** 自动朗读 */
  autoSpeak: boolean;
  /** 发音来源：在线美音 / 在线英音 / 系统语音 */
  speakMode: 'us' | 'uk' | 'system';
  /**
   * 复习强度＝目标记忆保持率。
   * 0.95 紧凑（曲线陡、复习密）、0.9 标准、0.85 宽松（间隔更长）
   */
  retention: number;
  /** 学完生成阅读理解 */
  readingEnabled: boolean;
}

export interface DayPlan {
  date: string;
  newIds: string[];
  reviewIds: string[];
  /** 已完成的新词/复习词数 */
  newDone: string[];
  reviewDone: string[];
  /** 计划生成时的说明（例如新词量被自动下调） */
  note?: string;
}

export interface UsageRecord {
  /** 当日 key：YYYY-MM-DD */
  day: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
}
