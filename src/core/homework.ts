/**
 * 作业模块：数据、存储、解析、分享码、统计、提醒。
 *
 * 这里只放纯逻辑（不碰 DOM、不碰 chrome），界面在 `pwa/views.tsx`：
 * 这样解析规则、去重、分享码合并这些容易出错的地方都能被单测直接覆盖。
 *
 * 数据源是班级群，没有 API——只能「粘贴/分享 → 解析 → 确认」，
 * 所以解析一律是「宁可漏，不可错」：拿不准的字段留空，让用户补。
 */
import { getKV, type KV } from './kv';

export type HomeworkStatus = 'todo' | 'done';

export interface HomeworkItem {
  /** 稳定 id：改标题、改时间都不换，提醒取消也靠它 */
  id: string;
  /** 作业内容，比如「习题册 3.1–3.4」 */
  title: string;
  /** 课程名：可以空着，统计时归到「未分类」 */
  course?: string;
  /** 截止时间（毫秒时间戳） */
  dueAt: number;
  /** 提交时间：有值就是已交，不再提醒 */
  doneAt?: number;
  /** 备注：交纸质、传雨课堂之类 */
  note?: string;
  /** 从哪来的：手动 / 群消息解析 / 作业码导入 */
  source?: 'manual' | 'paste' | 'share' | 'import';
  createdAt: number;
}

export interface HomeworkRemind {
  /** 前一天晚上提醒 */
  prev: boolean;
  /** 当天早上提醒 */
  sameDay: boolean;
  /** 到期前几小时提醒 */
  soon: boolean;
  prevHour: number;
  sameDayHour: number;
  soonHours: number;
  /** 每周汇总一次（0=周日）；null 表示不开 */
  summaryWeekday: number | null;
  summaryHour: number;
}

export interface HomeworkSettings {
  remind: HomeworkRemind;
  /**
   * 订阅地址（可选）：作业码里可以带一个静态 JSON 地址，
   * 将来学委把它填成 Gist 原始链接就能自动更新；现在只存不用。
   */
  feedUrl?: string;
  /** 上次导入的作业码元信息，用来提示「有更新」 */
  lastImport?: { at: number; version: number; from?: string };
}

export const HOMEWORK_KEY = 'homework';
export const HOMEWORK_SETTINGS_KEY = 'homeworkSettings';

/** 一条作业最多留多久：太老的（半年前）直接从统计里淡出，但列表还留着 */
export const MAX_ITEMS = 400;

export const DEFAULT_REMIND: HomeworkRemind = {
  prev: true,
  sameDay: true,
  soon: true,
  prevHour: 20,
  sameDayHour: 8,
  soonHours: 2,
  summaryWeekday: null,
  summaryHour: 21,
};

export const DEFAULT_SETTINGS: HomeworkSettings = { remind: { ...DEFAULT_REMIND } };

let seq = 0;
/** 不依赖 crypto.randomUUID（老 WebView 没有） */
export function newHomeworkId(): string {
  seq = (seq + 1) % 1000;
  return `h${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clampHour = (n: unknown, fallback: number): number => {
  const v = typeof n === 'number' ? Math.trunc(n) : Number.NaN;
  return Number.isFinite(v) && v >= 0 && v <= 23 ? v : fallback;
};

/** 洗数据：宁可丢一条脏的，也不让整个列表炸掉 */
export function normalizeHomework(raw: unknown): HomeworkItem[] {
  if (!Array.isArray(raw)) return [];
  const out: HomeworkItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const title = oneLine(typeof o.title === 'string' ? o.title : '');
    const dueAt = typeof o.dueAt === 'number' && Number.isFinite(o.dueAt) ? o.dueAt : 0;
    if (!title || !dueAt) continue;
    const id = typeof o.id === 'string' && o.id ? o.id : newHomeworkId();
    if (seen.has(id)) continue;
    seen.add(id);
    const course = oneLine(typeof o.course === 'string' ? o.course : '') || undefined;
    const note = oneLine(typeof o.note === 'string' ? o.note : '') || undefined;
    const doneAt = typeof o.doneAt === 'number' && Number.isFinite(o.doneAt) ? o.doneAt : undefined;
    const createdAt = typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : Date.now();
    const source = o.source === 'manual' || o.source === 'paste' || o.source === 'share' || o.source === 'import'
      ? o.source
      : undefined;
    out.push({ id, title: title.slice(0, 160), ...(course ? { course: course.slice(0, 60) } : {}), dueAt, ...(doneAt ? { doneAt } : {}), ...(note ? { note: note.slice(0, 200) } : {}), ...(source ? { source } : {}), createdAt });
    if (out.length >= MAX_ITEMS) break;
  }
  return out.sort((a, b) => a.dueAt - b.dueAt);
}

export function normalizeSettings(raw: unknown): HomeworkSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const r = (o.remind && typeof o.remind === 'object' ? o.remind : {}) as Record<string, unknown>;
  const weekdayRaw = typeof r.summaryWeekday === 'number' ? Math.trunc(r.summaryWeekday) : null;
  const remind: HomeworkRemind = {
    prev: typeof r.prev === 'boolean' ? r.prev : DEFAULT_REMIND.prev,
    sameDay: typeof r.sameDay === 'boolean' ? r.sameDay : DEFAULT_REMIND.sameDay,
    soon: typeof r.soon === 'boolean' ? r.soon : DEFAULT_REMIND.soon,
    prevHour: clampHour(r.prevHour, DEFAULT_REMIND.prevHour),
    sameDayHour: clampHour(r.sameDayHour, DEFAULT_REMIND.sameDayHour),
    soonHours: typeof r.soonHours === 'number' && r.soonHours >= 1 && r.soonHours <= 24 ? Math.trunc(r.soonHours) : DEFAULT_REMIND.soonHours,
    summaryWeekday: weekdayRaw !== null && weekdayRaw >= 0 && weekdayRaw <= 6 ? weekdayRaw : null,
    summaryHour: clampHour(r.summaryHour, DEFAULT_REMIND.summaryHour),
  };
  const feedUrl = typeof o.feedUrl === 'string' && /^https?:\/\//.test(o.feedUrl) ? o.feedUrl.slice(0, 400) : undefined;
  const rawImport = (o.lastImport && typeof o.lastImport === 'object' ? o.lastImport : undefined) as Record<string, unknown> | undefined;
  const lastImport =
    rawImport && typeof rawImport.at === 'number'
      ? {
          at: rawImport.at,
          version: typeof rawImport.version === 'number' ? rawImport.version : 0,
          ...(typeof rawImport.from === 'string' ? { from: rawImport.from.slice(0, 40) } : {}),
        }
      : undefined;
  return { remind, ...(feedUrl ? { feedUrl } : {}), ...(lastImport ? { lastImport } : {}) };
}

export async function loadHomework(kv: KV = getKV()): Promise<HomeworkItem[]> {
  try {
    const stored = await kv.get<{ v?: number; items?: unknown }>(HOMEWORK_KEY);
    return normalizeHomework(stored?.items);
  } catch {
    return [];
  }
}

export async function saveHomework(items: readonly HomeworkItem[], kv: KV = getKV()): Promise<HomeworkItem[]> {
  const clean = normalizeHomework(items);
  await kv.set(HOMEWORK_KEY, { v: 1, items: clean });
  return clean;
}

export async function loadHomeworkSettings(kv: KV = getKV()): Promise<HomeworkSettings> {
  try {
    const stored = await kv.get<unknown>(HOMEWORK_SETTINGS_KEY);
    return normalizeSettings(stored);
  } catch {
    return { remind: { ...DEFAULT_REMIND } };
  }
}

export async function saveHomeworkSettings(settings: HomeworkSettings, kv: KV = getKV()): Promise<HomeworkSettings> {
  const clean = normalizeSettings(settings);
  await kv.set(HOMEWORK_SETTINGS_KEY, clean);
  return clean;
}

export interface HomeworkDraft {
  title: string;
  course?: string;
  dueAt: number;
  note?: string;
  source?: HomeworkItem['source'];
}

/** 加一条：内容空或时间不合法就直接报中文原因，界面照抄 */
export function addHomework(items: readonly HomeworkItem[], draft: HomeworkDraft, now = Date.now()): HomeworkItem[] {
  const title = oneLine(draft.title).slice(0, 160);
  if (!title) throw new Error('写点作业内容再保存');
  if (!Number.isFinite(draft.dueAt)) throw new Error('截止时间没填对');
  const course = oneLine(draft.course ?? '').slice(0, 60) || undefined;
  const note = oneLine(draft.note ?? '').slice(0, 200) || undefined;
  const item: HomeworkItem = {
    id: newHomeworkId(),
    title,
    ...(course ? { course } : {}),
    dueAt: draft.dueAt,
    ...(note ? { note } : {}),
    source: draft.source ?? 'manual',
    createdAt: now,
  };
  return normalizeHomework([...items, item]);
}

export function updateHomework(items: readonly HomeworkItem[], id: string, patch: Partial<HomeworkDraft>): HomeworkItem[] {
  const next = items.map((item) => {
    if (item.id !== id) return item;
    const title = patch.title !== undefined ? oneLine(patch.title).slice(0, 160) : item.title;
    if (!title) throw new Error('作业内容不能为空');
    const course = patch.course !== undefined ? oneLine(patch.course).slice(0, 60) : item.course ?? '';
    const note = patch.note !== undefined ? oneLine(patch.note).slice(0, 200) : item.note ?? '';
    return {
      ...item,
      title,
      ...(course ? { course } : { course: undefined }),
      dueAt: patch.dueAt ?? item.dueAt,
      ...(note ? { note } : { note: undefined }),
    } as HomeworkItem;
  });
  return normalizeHomework(next);
}

export function removeHomework(items: readonly HomeworkItem[], id: string): HomeworkItem[] {
  return normalizeHomework(items.filter((item) => item.id !== id));
}

/**
 * 点「提交」：打上 doneAt；再点一次撤销。
 * 提醒那边靠「有没有 doneAt」来判断要不要排闹钟，所以这里改完必须重排。
 */
export function toggleHomeworkDone(items: readonly HomeworkItem[], id: string, now = Date.now()): HomeworkItem[] {
  return normalizeHomework(
    items.map((item) => {
      if (item.id !== id) return item;
      if (item.doneAt) {
        const { doneAt, ...rest } = item;
        void doneAt;
        return rest as HomeworkItem;
      }
      return { ...item, doneAt: now };
    }),
  );
}

export interface HomeworkStats {
  /** 没交的（含逾期） */
  todo: number;
  /** 没交且已过截止 */
  overdue: number;
  /** 没交且今天内到期 */
  today: number;
  /** 未来 7 天内要交 */
  week: number;
  /** 已交 */
  done: number;
  /** 全部 */
  total: number;
  /** 完成率 0–100，四舍五入；没有作业时是 0 */
  rate: number;
  /** 按课程分：没交/已交/迟交 */
  byCourse: Array<{ course: string; todo: number; done: number; late: number }>;
}

const DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function homeworkStats(items: readonly HomeworkItem[], now = Date.now()): HomeworkStats {
  const dayStart = startOfDay(now);
  const dayEnd = dayStart + DAY;
  let todo = 0;
  let overdue = 0;
  let today = 0;
  let week = 0;
  let done = 0;
  const byCourse = new Map<string, { todo: number; done: number; late: number }>();
  const bucket = (course: string) => {
    const key = course || '未分类';
    let row = byCourse.get(key);
    if (!row) {
      row = { todo: 0, done: 0, late: 0 };
      byCourse.set(key, row);
    }
    return row;
  };
  for (const item of items) {
    const row = bucket(item.course ?? '');
    if (item.doneAt) {
      done += 1;
      row.done += 1;
      if (item.doneAt > item.dueAt) row.late += 1;
      continue;
    }
    todo += 1;
    row.todo += 1;
    if (item.dueAt < now) overdue += 1;
    else {
      if (item.dueAt < dayEnd) today += 1;
      if (item.dueAt < now + 7 * DAY) week += 1;
    }
  }
  const total = items.length;
  return {
    todo,
    overdue,
    today,
    week,
    done,
    total,
    rate: total ? Math.round((done / total) * 100) : 0,
    byCourse: [...byCourse.entries()]
      .map(([course, v]) => ({ course, ...v }))
      .sort((a, b) => b.todo + b.done - (a.todo + a.done)),
  };
}

/** 一条作业现在的状态，界面按这个上色 */
export function homeworkState(item: HomeworkItem, now = Date.now()): 'done' | 'overdue' | 'today' | 'soon' | 'later' {
  if (item.doneAt) return 'done';
  if (item.dueAt < now) return 'overdue';
  if (item.dueAt < startOfDay(now) + DAY) return 'today';
  if (item.dueAt < now + 3 * DAY) return 'soon';
  return 'later';
}

/** 「还有 14 小时」「逾期 1 天」这种短文案 */
export function remainText(item: HomeworkItem, now = Date.now()): string {
  if (item.doneAt) return '已提交';
  const diff = item.dueAt - now;
  if (diff < 0) {
    const days = Math.floor(-diff / DAY);
    if (days >= 1) return `逾期 ${days} 天`;
    const hours = Math.max(1, Math.floor(-diff / 3_600_000));
    return `逾期 ${hours} 小时`;
  }
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return `还有 ${Math.max(1, Math.floor(diff / 60_000))} 分钟`;
  if (hours < 24) return `还有 ${hours} 小时`;
  return `还有 ${Math.floor(hours / 24)} 天`;
}

/** 格式化「11-16 22:00」；跨年才带年份 */
export function dueText(dueAt: number, now = Date.now()): string {
  const d = new Date(dueAt);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${sameYear ? date : `${d.getFullYear()}-${date}`} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 解析 ─────────────────────────────────────────────────────────────

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

function weekdayIndex(text: string): number | null {
  const m = /(?:周|星期)([一二三四五六日天])/.exec(text);
  if (!m) return null;
  const num = CN_NUM[m[1]!];
  if (!num) return null;
  // JS: 0=周日 … 6=周六；中文的 1..7（7=周日）
  return num === 7 ? 0 : num;
}

/** 从一段话里猜截止时间；猜不到返回 null（绝不瞎猜） */
export function parseDueAt(text: string, now = Date.now()): number | null {
  const src = text.replace(/\s+/g, ' ');
  const timeMatch = /(\d{1,2})\s*[:：点时]\s*(\d{1,2})?/.exec(src);
  let hour = 23;
  let minute = 59;
  if (timeMatch) {
    const h = Number(timeMatch[1]);
    if (Number.isFinite(h) && h >= 0 && h <= 23) {
      hour = h;
      minute = timeMatch[2] ? Math.min(59, Number(timeMatch[2])) : 0;
    }
    if (/下午|晚上|晚间/.test(src) && hour < 12) hour += 12;
    /* 「周日晚 12 点」是这一天的最后一刻，不是中午 12 点 */
    if (/晚|夜|凌晨/.test(src) && hour === 12) {
      hour = 23;
      minute = 59;
    }
  }

  const base = new Date(now);
  const setAt = (d: Date): number => {
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };

  // 1) 绝对日期：11-16 / 11月16日 / 11/16
  //    注意别把「习题册 3.1–3.4」里的 1-3 当成日期
  const absRe = /(\d{1,2})\s*[-月/]\s*(\d{1,2})/g;
  for (let abs = absRe.exec(src); abs; abs = absRe.exec(src)) {
    const before = src.slice(Math.max(0, abs.index - 1), abs.index);
    const after = src.slice(abs.index + abs[0].length, abs.index + abs[0].length + 1);
    if (/[\d.]/.test(before) || /[\d.]/.test(after)) continue;
    const month = Number(abs[1]);
    const day = Number(abs[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const d = new Date(base);
    d.setMonth(month - 1, day);
    let ts = setAt(d);
    if (ts < now - 7 * DAY) {
      d.setFullYear(d.getFullYear() + 1);
      ts = setAt(d);
    }
    return ts;
  }

  // 2) 相对日：今天/明天/后天
  if (/今天|今晚/.test(src)) return setAt(base);
  if (/明天|明晚/.test(src)) {
    const d = new Date(now + DAY);
    return setAt(d);
  }
  if (/后天/.test(src)) {
    const d = new Date(now + 2 * DAY);
    return setAt(d);
  }

  // 3) 周几：本周五 / 下周三 / 星期五（默认取「最近的将来」）
  const wd = weekdayIndex(src);
  if (wd !== null) {
    const todayWd = base.getDay();
    let delta = (wd - todayWd + 7) % 7;
    /* 「周五前交」这种话，今天正好周五就算今天 */
    if (delta === 0 && !/前|截|之前/.test(src)) delta = 7;
    if (/下周/.test(src)) delta += 7;
    const d = new Date(now + delta * DAY);
    return setAt(d);
  }

  return null;
}

/** 去掉「@所有人」「作业：」这类噪音，留下能当标题的一句 */
function cleanTitle(raw: string): string {
  let s = raw.replace(/@所有人|@全体成员/g, ' ');
  s = s.replace(/^[\s:：,，。\-]+/, '');
  s = s.replace(/^(作业|通知|提醒)\s*[:：]\s*/, '');
  const first = s.split(/[。！!\n]/)[0] ?? '';
  return oneLine(first).slice(0, 80);
}

/**
 * 从一段群消息里解析出一条（或几条）作业。
 * 规则：先按「句号/换行」切句，找带日期或周几的句子当一条；
 * 课程名只在明显写了「xx课/xx作业」时猜，猜不到就留空——宁可漏。
 */
export function parseHomework(text: string, now = Date.now()): HomeworkDraft[] {
  const body = text.replace(/\r/g, '');
  if (!body.trim()) return [];
  const chunks = body
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！!])/))
    .map((s) => s.trim())
    .filter(Boolean);

  const out: HomeworkDraft[] = [];
  for (const sentence of chunks) {
    const dueAt = parseDueAt(sentence, now);
    if (!dueAt) continue;
    const title = cleanTitle(sentence);
    if (!title) continue;
    const note = /纸质|打印|手写/.test(sentence) ? '交纸质' : /雨课堂|学习通|超星/.test(sentence) ? '线上提交' : undefined;
    out.push({ title, dueAt, ...(note ? { note } : {}), source: 'paste' });
    if (out.length >= 6) break;
  }
  // 一句都没解析出来时，退化成「整段当标题 + 默认明天 23:59」，让用户自己改时间
  if (out.length === 0) {
    const title = cleanTitle(body);
    if (title) out.push({ title, dueAt: startOfDay(now) + DAY + 23 * 3_600_000 + 59 * 60_000, source: 'paste' });
  }
  return out;
}

// ── 分享码 ───────────────────────────────────────────────────────────

export interface HomeworkCode {
  v: 1;
  version: number;
  at: number;
  from?: string;
  /** 订阅地址（可选）：填了就能升级成自动更新 */
  feed?: string;
  items: Array<Pick<HomeworkItem, 'title' | 'course' | 'dueAt' | 'note'>>;
}

const CODE_PREFIX = 'HW1.';

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64decode(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 导出作业码：只带必要字段，重复的（同标题+同截止）合并 */
export function encodeHomeworkCode(
  items: readonly HomeworkItem[],
  meta: { version?: number; from?: string; feedUrl?: string; now?: number } = {},
): string {
  const seen = new Set<string>();
  const list: HomeworkCode['items'] = [];
  for (const item of items) {
    const key = `${item.title}|${item.dueAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      title: item.title,
      ...(item.course ? { course: item.course } : {}),
      dueAt: item.dueAt,
      ...(item.note ? { note: item.note } : {}),
    });
  }
  const code: HomeworkCode = {
    v: 1,
    version: meta.version ?? (meta.now ?? Date.now()),
    at: meta.now ?? Date.now(),
    ...(meta.from ? { from: meta.from } : {}),
    ...(meta.feedUrl ? { feed: meta.feedUrl } : {}),
    items: list,
  };
  return CODE_PREFIX + b64encode(JSON.stringify(code));
}

export function decodeHomeworkCode(raw: string): HomeworkCode {
  const text = raw.trim();
  if (!text) throw new Error('作业码是空的');
  const body = text.startsWith(CODE_PREFIX) ? text.slice(CODE_PREFIX.length) : text;
  if (!body) throw new Error('作业码不完整');
  let json: unknown;
  try {
    json = JSON.parse(b64decode(body));
  } catch {
    throw new Error('这段不像是作业码：复制的时候可能断了');
  }
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (!Array.isArray(o.items)) throw new Error('作业码里没有作业');
  const items: HomeworkCode['items'] = [];
  for (const entry of o.items) {
    if (!entry || typeof entry !== 'object') continue;
    const it = entry as Record<string, unknown>;
    const title = oneLine(typeof it.title === 'string' ? it.title : '');
    const dueAt = typeof it.dueAt === 'number' && Number.isFinite(it.dueAt) ? it.dueAt : 0;
    if (!title || !dueAt) continue;
    items.push({
      title: title.slice(0, 160),
      ...(typeof it.course === 'string' && it.course ? { course: it.course.slice(0, 60) } : {}),
      dueAt,
      ...(typeof it.note === 'string' && it.note ? { note: it.note.slice(0, 200) } : {}),
    });
  }
  if (!items.length) throw new Error('作业码里没有能用的作业');
  return {
    v: 1,
    version: typeof o.version === 'number' ? o.version : 0,
    at: typeof o.at === 'number' ? o.at : Date.now(),
    ...(typeof o.from === 'string' && o.from ? { from: o.from.slice(0, 40) } : {}),
    ...(typeof o.feed === 'string' && /^https?:\/\//.test(o.feed) ? { feed: o.feed.slice(0, 400) } : {}),
    items,
  };
}

export type ImportMode = 'replace' | 'merge';

export interface ImportResult {
  items: HomeworkItem[];
  added: number;
  replaced: number;
}

/**
 * 导入作业码。
 * - replace：以对方的为准（本地的全清掉），适合「学委是权威」的班
 * - merge：保留自己的，补上对方缺的；按「标题 + 截止」去重
 */
export function importHomeworkCode(
  local: readonly HomeworkItem[],
  code: HomeworkCode,
  mode: ImportMode,
  now = Date.now(),
): ImportResult {
  const incoming: HomeworkItem[] = code.items.map((it) => ({
    id: newHomeworkId(),
    title: it.title,
    ...(it.course ? { course: it.course } : {}),
    dueAt: it.dueAt,
    ...(it.note ? { note: it.note } : {}),
    source: 'import' as const,
    createdAt: now,
  }));
  if (mode === 'replace') {
    return { items: normalizeHomework(incoming), added: incoming.length, replaced: local.length };
  }
  const keyOf = (it: { title: string; dueAt: number }) => `${it.title}|${it.dueAt}`;
  const have = new Set(local.map(keyOf));
  const fresh = incoming.filter((it) => !have.has(keyOf(it)));
  return { items: normalizeHomework([...local, ...fresh]), added: fresh.length, replaced: 0 };
}

// ── 提醒 ─────────────────────────────────────────────────────────────

export interface HomeworkReminder {
  at: number;
  title: string;
  body: string;
}

const HW_LEAD = new Set(['prev', 'sameDay', 'soon']);

/**
 * 排提醒：只排「没交的」和「还没到点的」。
 * 每天三档：前一天 / 当天 / 到期前几小时；选了每周汇总就再加一条汇总。
 */
export function homeworkReminders(
  items: readonly HomeworkItem[],
  settings: HomeworkSettings,
  now = Date.now(),
  days = 21,
): HomeworkReminder[] {
  const r = settings.remind;
  const out: HomeworkReminder[] = [];
  const horizon = now + days * DAY;
  for (const item of items) {
    if (item.doneAt) continue;
    if (item.dueAt < now) continue;
    if (item.dueAt > horizon) continue;
    const dueDay = startOfDay(item.dueAt);
    const label = item.course ? `${item.course} · ${item.title}` : item.title;
    const at = (ts: number) => out.push({ at: ts, title: '作业提醒', body: `${label}（${dueText(item.dueAt, now)} 截止）` });
    if (r.prev) {
      const ts = dueDay - DAY + r.prevHour * 3_600_000;
      if (ts > now + 60_000) at(ts);
    }
    if (r.sameDay) {
      const ts = dueDay + r.sameDayHour * 3_600_000;
      if (ts > now + 60_000 && ts < item.dueAt) at(ts);
    }
    if (r.soon) {
      const ts = item.dueAt - r.soonHours * 3_600_000;
      if (ts > now + 60_000) at(ts);
    }
  }
  if (r.summaryWeekday !== null) {
    // 下一个汇总点
    const d = new Date(now);
    const delta = (r.summaryWeekday - d.getDay() + 7) % 7 || 7;
    const ts = startOfDay(now + delta * DAY) + r.summaryHour * 3_600_000;
    const pending = items.filter((it) => !it.doneAt && it.dueAt >= ts - 7 * DAY);
    if (pending.length && ts > now + 60_000) {
      out.push({ at: ts, title: '本周作业汇总', body: `这周还有 ${pending.length} 份没交，点开看看` });
    }
  }
  void HW_LEAD;
  return out.sort((a, b) => a.at - b.at);
}
