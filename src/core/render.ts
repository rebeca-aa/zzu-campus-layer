import { Card, CardTx, Course, FreeRoom, Grade, Occupancy, Term, TodoSummary } from './types';
import type { PlanProgress } from './jwxt';
import type { LibrarySeats } from './library';
import { renderSeatMap } from './library';

export { renderSeatMap };
import { compressWeeks } from './util';

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function weekdayName(n: number): string {
  return WEEKDAY_CN[n] ?? `周${n}`;
}

export function renderCourseTable(courses: Course[], opts: { term: Term; week?: number }): string {
  const week = opts.week;
  const filtered =
    week === undefined ? courses : courses.filter((c) => c.weeks.length === 0 || c.weeks.includes(week));

  if (filtered.length === 0) {
    return week === undefined ? '课表为空。' : `第 ${week} 周没有课。`;
  }

  const title = `**${opts.term.code} 课表${week === undefined ? '' : `（第 ${week} 周）`}**`;
  const rows: string[] = [title, ''];

  let lastDay = 0;
  for (const c of filtered) {
    if (c.weekday !== lastDay) {
      rows.push('', `**${weekdayName(c.weekday)}**`);
      lastDay = c.weekday;
    }
    const parts = [
      `${c.startTime}-${c.endTime}`,
      c.name,
      c.location ? `@${c.location}` : '',
      c.teachers.length ? `(${c.teachers.join('、')})` : '',
      week === undefined && c.weeks.length ? `[${compressWeeks(c.weeks)}周]` : '',
    ].filter(Boolean);
    rows.push(`- ${parts.join(' ')}`);
  }
  return rows.join('\n').trim();
}

export function renderFreeRooms(
  list: FreeRoom[],
  opts: {
    date: string;
    term?: Term;
    sectionLabel?: string;
    maxRooms?: number;
    /** 限定了地点时回显，例如「南核心教学区（南1/南2/南3）」。 */
    place?: string;
    /** 限定地点前全校的空教室数，用来解释「为什么只剩这几间」。 */
    placeTotal?: number;
  },
): string {
  const where = opts.place ? ` · ${opts.place}` : '';
  if (list.length === 0) {
    if (opts.place) {
      return [
        `${opts.date} 在「${opts.place}」里没找到空教室。`,
        '',
        `可能是当天排满了，也可能是我把地点认窄了（那一片今天共有 ${opts.placeTotal ?? 0} 间空教室，但不属于这个范围）。`,
        '换个说法可以放宽：`明天主校区的空教室` / `明天北1的空教室`。',
      ].join('\n');
    }
    return `${opts.date} 没找到符合条件的空教室。`;
  }
  const limit = opts.maxRooms ?? 12;
  const rows = [
    `**${opts.date} 空教室${where}${opts.sectionLabel ? `（${opts.sectionLabel}）` : ''}**`,
    '',
  ];
  for (const item of list.slice(0, limit)) {
    const seats = item.room.seats ? `${item.room.seats}座` : '';
    const floor = item.room.floor ? `${item.room.floor}层` : '';
    const meta = [item.room.campus, floor, seats].filter(Boolean).join(' ');
    const span = compressWeeks(item.freeSections);
    const all = item.freeSections.length >= 10 ? '全天' : `空闲 ${span} 节`;
    // 「能坐多久」比「第几节空」更接近学生的问题：优先给连续窗口
    const duration = item.longestMin ? `最长能连坐 ${fmtDur(item.longestMin)}` : '';
    const nowHint = item.freeNowMin ? `现在就能坐 ${fmtDur(item.freeNowMin)}` : '';
    const winText = item.windows?.length
      ? item.windows
          .slice(0, 2)
          .map((w) => `${minToHhmm(w.start)}–${minToHhmm(w.end)}`)
          .join('、')
      : '';
    rows.push(
      `- ${item.room.name}${meta ? `（${meta}）` : ''} ${all}` +
        (winText ? `，${winText}` : '') +
        (nowHint ? `，${nowHint}` : duration ? `，${duration}` : ''),
    );
  }
  if (list.length > limit) {
    rows.push('', `…共 ${list.length} 间符合条件的，先列前 ${limit} 间。`);
    rows.push('换个说法能筛：加「南核」「北1」「物理馆」限定楼，或「只看自习室」。');
  }
  return rows.join('\n');
}

const COMPONENT_RE = /(平时|期中|期末|卷面|机试|实验|作业|大作业|usual|midterm|final|exam|quiz|homework|component)/i;

/** 从成绩对象里翻出「构成分」（平时/期中/期末/卷面…），字段名各校不同所以按语义找。 */
function componentScores(g: Grade): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(g as Record<string, unknown>)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    if (!COMPONENT_RE.test(k)) continue;
    const s = String(v).trim();
    if (!s || s === '0') continue;
    out.push([k, s]);
  }
  return out;
}

export function renderGrades(grades: Grade[], opts: { course?: string } = {}): string {
  const wanted = opts.course?.trim();
  const list = wanted
    ? grades.filter((g) => {
        const name = `${g.courseName ?? ''}${g.courseCode ?? ''}`;
        return name.includes(wanted) || wanted.includes(g.courseName ?? '\u0000');
      })
    : grades;

  if (grades.length === 0) return '成绩列表为空（本学期可能还没出分，或该学期无成绩）。';
  if (wanted && list.length === 0) {
    const names = grades.map((g) => g.courseName ?? g.courseCode ?? '未知课程');
    return `没找到「${wanted}」这门课的成绩。已出分的课程：${names.join('、')}。`;
  }

  const rows = [wanted ? `**成绩 · ${wanted}**` : '**成绩**', ''];
  for (const g of list) {
    const name = g.courseName ?? g.courseCode ?? '未知课程';
    const score = g.score ?? g.gradePoint ?? '—';
    const extra = componentScores(g);
    const parts = [String(score)];
    if (g.credit) parts.push(`${String(g.credit)} 学分`);
    if (g.gradePoint && g.gradePoint !== score) parts.push(`绩点 ${String(g.gradePoint)}`);
    rows.push(`- **${name}**：${parts.join(' · ')}`);
    if (extra.length > 0) {
      rows.push(`  - 构成：${extra.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    }
  }
  if (!wanted && list.length > 1) {
    const gps = list
      .map((g) => Number(g.gradePoint))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (gps.length > 0) {
      const avg = gps.reduce((a, b) => a + b, 0) / gps.length;
      rows.push('', `平均绩点（已出分 ${gps.length} 门）**${avg.toFixed(2)}**`);
    }
  }
  return rows.join('\n');
}

export function renderPlanProgress(p: PlanProgress, opts: { maxModules?: number } = {}): string {
  const remain = Math.max(0, p.requiredCredits - p.passedCredits - p.takingCredits);
  const rows = [
    '**培养方案学分进度**',
    '',
    `- 要求 **${p.requiredCredits}** 学分 · 已通过 **${p.passedCredits}** · 在修 **${p.takingCredits}** · 还差 **${remain}**`,
    `- 未修课程 **${p.missingCourses}** 门`,
    '',
  ];

  const bar = (passed: number, required: number): string => {
    if (required <= 0) return '';
    const filled = Math.round((passed / required) * 10);
    return `${'█'.repeat(Math.min(10, filled))}${'░'.repeat(Math.max(0, 10 - filled))} ${Math.round((passed / required) * 100)}%`;
  };

  const list = opts.maxModules ? p.modules.slice(0, opts.maxModules) : p.modules;
  for (const m of list) {
    const pct = bar(m.passed, m.required);
    rows.push(
      `- **${m.name}** ${m.passed}/${m.required} 学分${m.taking ? `（在修 ${m.taking}）` : ''}${pct ? ` ${pct}` : ''}`,
    );
    for (const c of m.children ?? []) {
      rows.push(`  - ${c.name} ${c.passed}/${c.required}${c.taking ? ` · 在修 ${c.taking}` : ''}`);
    }
  }
  return rows.join('\n').trim();
}

export function renderOccupancy(list: Occupancy[], date: string): string {  if (list.length === 0) return `${date} 没有任何教室占用记录。`;
  const rows = [`**${date} 教室占用 ${list.length} 条（前 20）**`, ''];
  for (const o of list.slice(0, 20)) {
    rows.push(`- ${o.roomName} ${String(o.startAt).padStart(4, '0')}-${String(o.endAt).padStart(4, '0')} ${o.activity ?? o.type ?? ''}`);
  }
  return rows.join('\n');
}

const money = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function renderCard(card: Card): string {
  const rows = ['**校园一卡通**', '', `- 余额 **¥${money(card.balance)}**`];
  if (card.cardStatus) rows.push(`- 状态：${card.cardStatus}`);
  if (card.cardType) rows.push(`- 卡类型：${card.cardType}`);

  const tx = (label: string, list: CardTx[]): void => {
    if (list.length === 0) return;
    rows.push('', `**最近${label}**`);
    for (const t of list.slice(0, 5)) {
      const amount = toYuanLoose(t.amount);
      const name = t.place ?? t.merchant ?? t.type ?? '';
      rows.push(`- ${[t.time, name, amount ? `¥${money(amount)}` : ''].filter(Boolean).join(' · ')}`);
    }
  };
  tx('消费', card.expenses);
  tx('充值', card.incomes);

  if (card.expenses.length === 0 && card.incomes.length === 0) {
    rows.push('', '没有最近流水（本周期未消费过，或服务端未返回流水）。');
  }
  if (card.appUrl) rows.push('', '充值/明细：用「打开服务」或在校园 App 里进入一卡通。');
  return rows.join('\n');
}

function toYuanLoose(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function renderTodos(t: TodoSummary): string {
  const { counts } = t;
  const total = counts.todo + counts.apply + counts.circulated;
  const rows = ['**待办事项**', ''];
  if (total === 0 && counts.timeout === 0 && counts.urgent === 0) {
    rows.push('目前没有需要你处理的待办。');
    return rows.join('\n');
  }
  rows.push(`- 待办 **${counts.todo}** 项 · 我发起的在办 **${counts.circulated}** · 待我申请 **${counts.apply}**`);
  if (counts.urgent) rows.push(`- ⚠️ 紧急 **${counts.urgent}** 项`);
  if (counts.timeout) rows.push(`- ⏰ 已超时 **${counts.timeout}** 项`);
  if (t.items.length > 0) {
    rows.push('', '**具体事项**');
    for (const item of t.items.slice(0, 10)) {
      const title = item.title ?? item.name ?? '(无标题)';
      rows.push(`- ${[title, item.time ?? item.applyTime ?? '', item.status ?? ''].filter(Boolean).join(' · ')}`);
    }
  }
  rows.push('', '办理入口：`打开网上办事大厅`。');
  return rows.join('\n');
}

/**
 * 图书馆座位余量。
 * 数据是「各馆空闲/总数」的实时快照（免登录接口），看不到具体座位号——
 * 座位图和下单都需要学号+密码登录，所以这里只给直达链接。
 */
export function renderLibrarySeats(s: LibrarySeats): string {
  const rows = [`**图书馆座位 · ${s.date}**`, ''];
  if (s.premises.length === 0) {
    rows.push('没拿到座位数据，可能是接口改版或当前不在校内网。');
    return rows.join('\n');
  }
  const sorted = [...s.premises].sort((a, b) => b.free - a.free);
  for (const p of sorted) {
    const pct = p.total > 0 ? Math.round((p.free / p.total) * 100) : 0;
    rows.push(`- **${p.name}** 空闲 **${p.free}** / ${p.total}（${pct}%）`);
    if (p.floors?.length) {
      const detail = p.floors.map((f) => `${f.name} ${f.free}/${f.total}`).join('，');
      rows.push(`楼层：${detail}`);
    }
  }
  const totalFree = sorted.reduce((n, p) => n + p.free, 0);
  const totalAll = sorted.reduce((n, p) => n + p.total, 0);
  if (totalAll > 0) rows.push('', `合计空闲 **${totalFree}** / ${totalAll}。`);
  rows.push(
    '',
    '要看**具体哪个座位号空着**就说「一楼大厅哪些座位空着」，我会去读座位图（需要先在「我的 → 图书馆登录」登录一次）。',
    '要下单就说「订 001，明天」——我会给你一个**长按 1.2 秒**的确认按钮，长按才提交，误触不会下单。',
  );
  return rows.join('\n');
}

/** 分钟 → 「2 小时 40 分」 */
export function fmtDur(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h} 小时 ${m} 分`;
  if (h) return `${h} 小时`;
  return `${m} 分钟`;
}

/** 分钟 → HH:mm */
export function minToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
