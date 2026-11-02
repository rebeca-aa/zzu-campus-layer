/** 时间/日期小工具。全部按「无时区的墙上时间」处理，避免容器时区干扰。 */

/** 800 -> "08:00"，1010 -> "10:10" */
export function hhmm(n: number): string {
  const h = Math.floor(n / 100);
  const m = n % 100;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "08:00:00" -> "08:00"；"8:5" -> "08:05" */
export function hhmmss(s: string): string {
  const m = /(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return s;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

/** "08:00" -> 800 */
export function toHhmmInt(t: string): number {
  const m = /(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return 0;
  return Number(m[1]) * 100 + Number(m[2]);
}

const DAY = 86_400_000;

/** 把 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm:ss" 解析成 UTC 时间戳（只用于日期差）。 */
export function parseDate(s: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** 两个日期相差的天数 */
export function diffDays(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY);
}

/** 由学期首周周一与日期求教学周（1 基） */
export function weekOfDate(termStart: string, date: string): number {
  const d = diffDays(termStart, date);
  if (Number.isNaN(d)) return 0;
  return Math.floor(d / 7) + 1;
}

/**
 * 「现在算第几周」：服务端给了 currentWeek 就用它，否则用学期首周周一推。
 * 两样都没有（还没登录 / 学期信息没回来）就退回 1。
 */
export function currentWeekOf(
  term: { currentWeek?: number; startDate?: string } | null | undefined,
  today: string,
): number {
  if (term?.currentWeek && term.currentWeek > 0) return term.currentWeek;
  if (term?.startDate) {
    const w = weekOfDate(term.startDate, today);
    if (w > 0) return w;
  }
  return 1;
}

/** 1=周一 … 7=周日 */
export function weekdayOf(date: string): number {
  const ms = parseDate(date);
  const dow = new Date(ms).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** 教学周 + 星期 -> 日期 */
export function dateOfWeek(termStart: string, week: number, weekday: number): string {
  return formatDate(parseDate(termStart) + (week - 1) * 7 * DAY + (weekday - 1) * DAY);
}

export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY);
}

export function uniq(numbers: Array<number | undefined | null>): number[] {
  const set = new Set<number>();
  for (const n of numbers) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/** 北京时间「今天」。扩展运行在中国大陆，直接按 UTC+8 推算。 */
export function todayShanghai(now = Date.now()): string {
  return formatDate(now + 8 * 3_600_000);
}

/** 首页「今天的课」几点后翻到第二天（北京时间）。晚上八点，不是九点。 */
export const DAY_ROLLOVER_HOUR = 20;

/** 北京时间的小时（0–23）。 */
export function shanghaiHour(now = Date.now()): number {
  return new Date(now + 8 * 3_600_000).getUTCHours();
}

/**
 * 首页该显示哪一天：20 点以后算「明天」。
 * 只影响首页那张课表卡片，不影响通知/空教室/学期课表的「今天」。
 */
export function displayDayShanghai(
  now = Date.now(),
  rollHour = DAY_ROLLOVER_HOUR,
): { date: string; rolled: boolean } {
  const date = todayShanghai(now);
  const rolled = shanghaiHour(now) >= rollHour;
  return { date: rolled ? addDays(date, 1) : date, rolled };
}

/** 距离下一个「翻页点」还有多少毫秒（用于定时刷新首页）。 */
export function msUntilRollover(now = Date.now(), rollHour = DAY_ROLLOVER_HOUR): number {
  const sh = now + 8 * 3_600_000;
  const dayStart = Math.floor(sh / 86_400_000) * 86_400_000;
  const target = dayStart + rollHour * 3_600_000;
  return target > sh ? target - sh : target + 86_400_000 - sh;
}

/** 距离下一个北京时间 0 点还有多少毫秒（20 点翻到「明天」后，过午夜要翻回「今天」）。 */
export function msUntilMidnightShanghai(now = Date.now()): number {
  const sh = now + 8 * 3_600_000;
  return Math.floor(sh / 86_400_000) * 86_400_000 + 86_400_000 - sh;
}

/** 把连续周次压成 "1-8,10" 的文本 */
export function compressWeeks(weeks: number[]): string {
  const s = [...weeks].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const start = s[i];
    if (start === undefined) break;
    let end = start;
    while (s[i + 1] !== undefined && s[i + 1] === end + 1) {
      end += 1;
      i += 1;
    }
    out.push(start === end ? String(start) : `${start}-${end}`);
    i += 1;
  }
  return out.join(',');
}
