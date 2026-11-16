/**
 * 作业文本的「结构解析」：不接模型时用的规则路径。
 *
 * 群里的作业通知大致三种结构，先认结构再抽字段，而不是按句号乱切：
 *   - block  块型：有「作业内容 / 截止时间」这类标签（一个作业 + 若干说明）
 *   - list   列表型：多行，且至少两行带日期或有「课程:」前缀
 *   - single 单条：其余
 */
import { parseDueAt, type HomeworkDraft } from './homework';

export type HwShape = 'block' | 'list' | 'single';

export interface RuleParseResult {
  shape: HwShape;
  drafts: HomeworkDraft[];
  /** 给人看的说明，例如「列表 7 行 → 5 条，丢掉 1 行提醒」 */
  info: string;
}

/** 课程别名：命中就当作这门课（保留原文里的叫法） */
const ALIASES: Array<[RegExp, string]> = [
  [/高等数学|高数|微积分/, '微积分'],
  [/大学英语|大英|英语/, '英语'],
  [/线性代数|线代/, '线性代数'],
  [/心理健康/, '心理健康'],
  [/高级语言程序设计|程序设计|高级语言/, '高级语言程序设计'],
  [/大学物理|物理/, '大学物理'],
  [/思修|毛概|马克思主义|思想政治|习概|习近平/, '思想政治'],
];

/** 这些行是通知/提醒，不是作业 */
const NOISE = /提醒|请注意|请大家|同学们|逾期|无法提交|不要错过|如果提交|私聊|谢谢|加油|注意截止|按时完成|以上/;

/** 平台词，用作备注 */
const PLATFORMS: Array<[RegExp, string]> = [
  [/学习通|超星/, '学习通'],
  [/雨课堂/, '雨课堂'],
  [/PTA/i, 'PTA'],
  [/MOOC|慕课/i, '中国大学 MOOC'],
  [/iwrite|iWrite/i, 'iWrite'],
  [/U校园/u, 'U校园'],
];

function stripSymbols(line: string): string {
  return line
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/^[\s|:：·•\-—–]+/, '')
    .replace(/^@所有人|^@全体成员/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 全角标点统一成半角，方便正则只写一套 */
function normalize(text: string): string[] {
  const unified = text
    .replace(/[：]/g, ':')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，、]/g, (c) => (c === '，' ? ',' : '、'))
    .replace(/\r\n?/g, '\n');
  return unified
    .split('\n')
    .map(stripSymbols)
    .filter((l) => l.length > 0);
}

function matchCourse(text: string): string | undefined {
  for (const [re, name] of ALIASES) if (re.test(text)) return name;
  return undefined;
}

function matchPlatform(text: string): string | undefined {
  for (const [re, name] of PLATFORMS) if (re.test(text)) return name;
  return undefined;
}

/** 行尾的括号组：能解析成日期的当日期，其余当备注 */
function takeBrackets(line: string): { rest: string; due?: number; note?: string } {
  let rest = line.trim();
  let due: number | undefined;
  let note: string | undefined;
  for (let i = 0; i < 4; i += 1) {
    const m = /[\(【\[]([^()【】\[\]]{1,30})[\)】\]]\s*$/.exec(rest);
    if (!m) break;
    const inner = m[1]!.trim();
    const ts = parseDueAt(inner);
    if (ts && !due) due = ts;
    else if (!note && inner.length <= 20) note = inner;
    rest = rest.slice(0, m.index).trim();
  }
  return { rest, ...(due ? { due } : {}), ...(note ? { note } : {}) };
}

/** 去掉行首的序号/项目符号 */
function stripBullet(line: string): string {
  return line.replace(/^\s*(?:\d{1,2}\s*[.、)．]|[①②③④⑤⑥⑦⑧⑨⑩]|[-·•*])\s*/, '').trim();
}

/** 「课程:正文」里的课程前缀（必须能认成课程，否则原样保留） */
function splitPrefix(line: string): { course?: string; rest: string } {
  const m = /^([^:]{2,12}):\s*(.+)$/.exec(line);
  if (!m) return { rest: line };
  const left = m[1]!.trim();
  const course = matchCourse(left);
  if (course) return { course, rest: m[2]!.trim() };
  return { rest: line };
}

function cleanTitle(title: string): string {
  return title
    .replace(/^(另外提醒|补充|还有|另|再提醒)\s*/, '')
    .replace(/^[:：,，]\s*/, '')
    .replace(/[。.;；,，]\s*$/, '')
    .trim();
}

function emptyDraft(title: string, due: number, course?: string, note?: string): HomeworkDraft {
  return {
    title: title.slice(0, 160),
    ...(course ? { course } : {}),
    dueAt: due,
    ...(note ? { note: note.slice(0, 200) } : {}),
  };
}

const DEFAULT_LEAD = 2 * 24 * 60 * 60 * 1000;

/** 认结构 */
export function detectShape(text: string): HwShape {
  const lines = normalize(text);
  if (/作业内容:|截止时间:|截止:|提交时间:|交时间:/.test(lines.join('\n'))) return 'block';
  const dateLines = lines.filter((l) => parseDueAt(l) !== null).length;
  const prefixLines = lines.filter((l) => /^[^:]{2,12}:\s*\S/.test(l)).length;
  if (lines.length >= 3 && (dateLines >= 2 || prefixLines >= 2)) return 'list';
  return 'single';
}

function parseBlock(lines: string[], now: number): RuleParseResult {
  const all = lines.join('\n');
  const content = /作业内容:\s*([^\n]+)/.exec(all)?.[1]?.trim();
  const dueRaw =
    /(?:截止时间|截止|提交时间|交时间):\s*([^\n]+)/.exec(all)?.[1]?.trim() ?? '';
  const due = parseDueAt(dueRaw || all, now) ?? now + DEFAULT_LEAD;

  const course = matchCourse(all);
  const note = matchPlatform(all);

  let title = content;
  if (!title) {
    /* 「另外提醒：线性代数第0章…」这种带「提醒」但确实在说作业的行要留下 */
    const body = lines.find(
      (l) =>
        !/作业内容:|截止时间:|截止:|提交时间:|交时间:/.test(l) &&
        !(NOISE.test(l) && !/作业/.test(l)),
    );
    title = body ? cleanTitle(body) : '作业';
    // 「线性代数第0章、第一章作业(学习通上提交)」把备注从标题里摘掉
    title = title.replace(/[\(【\[][^)】\]]*[\)】\]]/g, '').trim();
    if (course && title.startsWith(course)) title = title.slice(course.length).trim();
  }

  const drafts = [emptyDraft(cleanTitle(title ?? '作业') || '作业', due, course, note)];
  return { shape: 'block', drafts, info: `按「作业内容 / 截止时间」认成 1 条` };
}

function parseList(lines: string[], now: number): RuleParseResult {
  const drafts: HomeworkDraft[] = [];
  let lastCourse: string | undefined;
  let dropped = 0;

  for (const raw of lines) {
    const line = stripBullet(raw);
    if (!line) continue;
    // 标题行（「作业通知:」「各科近期作业汇总:」）与提醒行都跳过
    if (/^[^:]{2,16}:\s*$/.test(line)) { dropped += 1; continue; }
    if (NOISE.test(line) && parseDueAt(line) === null) { dropped += 1; continue; }

    const { rest, due: bracketDue, note } = takeBrackets(line);
    const { course: prefixCourse, rest: body } = splitPrefix(rest);
    const due = bracketDue ?? parseDueAt(body, now) ?? 0;
    const title = cleanTitle(body);

    const course = prefixCourse ?? matchCourse(title) ?? undefined;
    const inherit = !course && lastCourse && !matchCourse(title) ? lastCourse : undefined;
    if (!title || title.length < 2) { dropped += 1; continue; }

    drafts.push(
      emptyDraft(title, due || now + DEFAULT_LEAD, course ?? inherit, note ?? matchPlatform(line)),
    );
    lastCourse = course ?? inherit ?? lastCourse;
  }

  const got = drafts.length;
  const info = `按列表识别：${lines.length} 行 → ${got} 条${dropped ? `，跳过 ${dropped} 行通知` : ''}`;
  return { shape: 'list', drafts, info };
}

function parseSingle(lines: string[], now: number): RuleParseResult {
  const all = lines.join(' ');
  const due = parseDueAt(all, now) ?? now + DEFAULT_LEAD;
  const course = matchCourse(all);
  const note = matchPlatform(all);
  const body = all
    .replace(/(?:截止时间|截止|提交时间|交时间):\s*[^\s]+/g, '')
    .replace(/[\(【\[][^)】\]]*[\)】\]]/g, '')
    .replace(/^[^:]{2,12}:\s*/, '');
  const title = cleanTitle(body) || '作业';
  return { shape: 'single', drafts: [emptyDraft(title, due, course, note)], info: '按单条识别：1 条' };
}

/** 入口：认结构 + 抽字段。纯函数，不联网、不碰 DOM。 */
export function parseByStructure(text: string, now = Date.now()): RuleParseResult {
  const lines = normalize(text);
  if (lines.length === 0) return { shape: 'single', drafts: [], info: '没有可识别的内容' };
  const shape = detectShape(text);
  if (shape === 'block') return parseBlock(lines, now);
  if (shape === 'list') return parseList(lines, now);
  return parseSingle(lines, now);
}
