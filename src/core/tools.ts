import { z } from 'zod';
import { CampusService, byDuration } from './services';
import { PORTAL_SERVICES, matchServices } from './catalog';
import { coursesToIcs } from './ics';
import { resolvePlace, roomInPlace } from './place';
import { planStudy, renderStudyPlan } from './study';
import { pickRoom, resolveLibraryDate, seatMapDataUri, areaIdByName, FLOOR_AREA_ID, FLOOR_AREA_ALTS, areaNameOf, floorOfArea } from './library';
import { renderCard, renderCourseTable, renderFreeRooms, renderGrades, renderLibrarySeats, renderPlanProgress, renderSeatMap, renderTodos } from './render';
import { readLibrarySeats } from './libtab';
import { addDays, dateOfWeek, todayShanghai, weekOfDate, weekdayOf } from './util';
import { buildCards, cardId, cardLine, filterCards, renderCards, sortCards, toPlainText, todayDigest } from './notice';
import { CATEGORY_LABEL, expandNoticeQuery as expandQuery } from './noticeRules';

// 同义词扩词表现在在 noticeRules.ts（老搜索与通知卡片共用一份）。
// 这里保留原来的导出名，免得调用方和测试跟着改。
export { expandQuery };

export interface ToolResult {
  /** 给用户看的正文 */
  text: string;
  /** 结构化产物（UI 可下载/复制） */
  data?: Record<string, unknown>;
}

export interface ToolDefinition<A> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  run: (args: A, svc: CampusService) => Promise<ToolResult>;
}

const dayArg = z.union([z.literal('today'), z.literal('tomorrow'), z.number().int().min(1).max(7)]).optional();
const periodArg = z.union([z.literal('morning'), z.literal('afternoon'), z.literal('evening')]).optional();

/** 按教室名前缀数出楼栋分布：「南1 18 · 南2 11 · 南4 12」。楼太多（>12 栋）就不给，免得刷屏。 */
function formatBreakdown(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const prefix = name.split('_')[0] || name;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  if (counts.size <= 1 || counts.size > 12) return '';
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
}
function resolveDay(day: 'today' | 'tomorrow' | number | undefined, today: string): { weekday: number; date: string; dated: boolean } {
  if (day === undefined) return { weekday: 0, date: today, dated: false };
  // 数字只是星期几，落不到具体某一天，所以不能拿它去推周次
  if (typeof day === 'number') return { weekday: day, date: today, dated: false };
  const date = day === 'tomorrow' ? addDays(today, 1) : today;
  return { weekday: weekdayOf(date), date, dated: true };
}

/** 一节课表查询最终落在「第几周、星期几、哪一天」。 */
export interface ScheduleWindow {
  /** 教学周次；没算出来时 undefined（渲染时就不按周过滤） */
  week?: number;
  weekday: number;
  /** 能确定具体日期才给，界面上带日期更好读 */
  date?: string;
  /** 目标日期落在学期教学周之外（假期/开学前） */
  outOfTerm: boolean;
}

/**
 * 周次要跟着**目标日期**走，不是跟着「今天第几周」走。
 * 例如周日问「明天有课吗」，明天已经是下一周，拿本周周次筛就会筛错，
 * 标题写「第 7 周」却列着第 8 周的日期——这正是课表与实际不符的根源。
 */
export function resolveScheduleWindow(
  args: { week?: number; weekOffset?: number; day?: 'today' | 'tomorrow' | number },
  term: { startDate: string; currentWeek?: number; weeks: number[] },
  today: string,
): ScheduleWindow {
  const { weekday, date, dated } = resolveDay(args.day, today);
  const current = term.currentWeek && term.currentWeek > 0 ? term.currentWeek : weekOfDate(term.startDate, today);
  let week: number;
  if (typeof args.week === 'number' && args.week > 0) {
    week = args.week;
  } else if (typeof args.weekOffset === 'number' && args.weekOffset !== 0) {
    week = current + args.weekOffset;
  } else if (dated) {
    week = weekOfDate(term.startDate, date);
  } else {
    week = current;
  }
  const last = term.weeks.length ? Math.max(...term.weeks) : Math.max(current, 1);
  const outOfTerm = week < 1 || week > last;
  // 只在「日期确实落在这一周」时才把日期显示出来，避免又出现日期与周次对不上
  const shownDate = dated && weekOfDate(term.startDate, date) === week ? date : undefined;
  const day = shownDate ?? (weekday && !outOfTerm ? dateOfWeek(term.startDate, week, weekday) : undefined);
  return {
    week,
    weekday,
    ...(day ? { date: day } : {}),
    outOfTerm,
  };
}

/** 上午 1-4 节 / 下午 5-8 节 / 晚上 9-10 节，按开始时间判。 */
export function inPeriod(startTime: string, period: 'morning' | 'afternoon' | 'evening'): boolean {
  const hour = Number(startTime.slice(0, 2));
  if (!Number.isFinite(hour)) return true;
  if (period === 'morning') return hour < 12;
  if (period === 'afternoon') return hour >= 12 && hour < 18;
  return hour >= 18;
}

const PERIOD_LABEL: Record<'morning' | 'afternoon' | 'evening', string> = {
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
};

export const getSchedule: ToolDefinition<{
  week?: number;
  weekOffset?: number;
  day?: 'today' | 'tomorrow' | number;
  period?: 'morning' | 'afternoon' | 'evening';
}> = {
  name: 'get_schedule',
  description: '查询课表：默认当前教学周，可按周次、按天、按时段（上午/下午/晚上）过滤。',
  schema: z.object({
    week: z.number().int().min(0).max(30).optional(),
    /** 相对周次：0=本周、1=下周、-1=上周。比让模型自己算周号可靠。 */
    weekOffset: z.number().int().min(-4).max(4).optional(),
    day: dayArg,
    period: periodArg,
  }),
  async run(args, svc) {
    const term = await svc.term();
    const today = todayShanghai();
    const window = resolveScheduleWindow(args, term, today);
    const week = window.week;
    let courses = await svc.courses();
    const { weekday } = window;
    if (weekday) courses = courses.filter((c) => c.weekday === weekday);
    // 周次在这里就筛掉，count / data.courses 才不会把别的周的课算进来
    if (week) courses = courses.filter((c) => c.weeks.length === 0 || c.weeks.includes(week));
    if (args.period) courses = courses.filter((c) => inPeriod(c.startTime, args.period!));
    const text = renderCourseTable(courses, { term, ...(week ? { week } : {}) });
    // 指定了「某天 / 某时段」却一条都没有时，别直接甩「课表为空」，
    // 要说清楚是那个时段没课——否则用户以为查错了。
    const label = args.period ? PERIOD_LABEL[args.period] : '';
    const dayLabel = window.date ?? '';
    const head = dayLabel ? `${dayLabel}${label ? ` ${label}` : ''}` : label ? `本${label}` : '';
    const empty = courses.length === 0 && (weekday > 0 || Boolean(args.period) || Boolean(window.outOfTerm));
    const body = window.outOfTerm
      ? `${head ? `${head} · ` : ''}不在本学期教学周内（第 1–${Math.max(...term.weeks, 1)} 周），那天没有课。`
      : empty
        ? `${head ? `${head} · ` : ''}没有课。`
        : head
          ? `${head} · ${text}`
          : text;
    return {
      text: body,
      data: {
        count: courses.length,
        week: week ?? null,
        ...(args.period ? { period: args.period } : {}),
        ...(dayLabel ? { date: dayLabel } : {}),
        ...(window.outOfTerm ? { outOfTerm: true } : {}),
        courses,
      },
    };
  },
};

export const findFreeRoom: ToolDefinition<{
  date?: string;
  campus?: string;
  minSeats?: number;
  sections?: number[];
  roomTypeIds?: string[];
  limit?: number;
  /** 地点词：南核 / 北核 / 北1 / 物理馆…（按教室名前缀过滤） */
  building?: string;
}> = {
  name: 'find_free_room',
  description: '查空教室：全部教室减去当天占用，可按校区、楼/教学区、座位数、指定节次筛选。',
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    campus: z.string().optional(),
    // 地点词：南核（南1–南5）、北核（北1–北5）、北1、物理馆…
    building: z.string().min(1).optional(),
    minSeats: z.number().int().min(0).optional(),
    sections: z.array(z.number().int().min(1).max(20)).optional(),
    // 默认只查普通教室 + 多媒体教室（学号能进的真实上课教室）；
    // 想找实验室可以传 ["5"]（房间类型见 /room/place/roomTypes）。
    roomTypeIds: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async run(args, svc) {
    const date = args.date ?? todayShanghai();
    // 地点词先解析：南核/北1 这种前缀本身就只存在于一个校区里。
    // 真机踩过的坑：LLM 听到「南核」会顺手补一个 campus:'南校区'，
    // 服务端先按南校区取教室，再按南1–5 前缀筛，结果必然是 0 间，
    // 还会把「那一片有 50 间空教室」当解释甩出来。所以两者同时给时，地点词说了算。
    let place = args.building ? resolvePlace(args.building) : null;
    let campusId: string | undefined;
    if (args.campus) {
      const campuses = await svc.campuses();
      const hit = campuses.find((c) => c.name.includes(args.campus!) || c.id === args.campus);
      if (hit) {
        // 地点词优先：给了「南核」就不再按校区取教室
        if (!place) campusId = hit.id;
      } else {
        // 模型还有个习惯：把「南核」直接塞进 campus。
        // 认得出是地点词就当地点词用，别因为一句参数名报「没找到校区」。
        const asPlace = place ?? resolvePlace(args.campus);
        if (asPlace) place = asPlace;
        else throw new Error(`没找到校区「${args.campus}」，可用：${campuses.map((c) => c.name).join('、')}`);
      }
    }
    const rooms = await svc.freeRooms({
      date,
      ...(campusId ? { campusId } : {}),
      ...(args.minSeats ? { minSeats: args.minSeats } : {}),
      ...(args.sections?.length ? { sections: args.sections } : {}),
      ...(args.roomTypeIds?.length ? { roomTypeIds: args.roomTypeIds } : {}),
      // 不截断：让渲染层拿到真实总数（它会自己只列前 12 间并说明「共 N 间」）
      limit: args.limit,
    });
    // 地点词（南核/北1/物理馆）按教室名前缀过滤。
    // 不做服务端 buildingIds：那套 id 不透明、跨学期会变，名字前缀才是学生嘴里的那个东西。
    const scoped = place ? rooms.filter((r) => roomInPlace(r.room.name, place)) : rooms;
    const label = args.sections?.length ? `第 ${args.sections.join('/')} 节` : '';
    // 教室里本来带 campusNameZh，但模型爱问「这是哪个校区」；直接把唯一校区写进标题，
    // 再给一行按楼栋的分布，省得它自己猜。
    const campusNames = [...new Set(scoped.map((r) => r.room.campus).filter(Boolean))] as string[];
    const campus = campusNames.length === 1 ? campusNames[0] : '';
    const breakdown = place ? formatBreakdown(scoped.map((r) => r.room.name)) : '';
    // 空结果时把这次的真实条件回显出来：用户/模型都能立刻看出是「节次太窄」还是「座位数太高」。
    const filters = [
      place ? `地点 ${place.label}` : '',
      args.campus && campusId ? `校区 ${args.campus}` : '',
      args.sections?.length ? `第 ${args.sections.join('/')} 节都空` : '',
      args.minSeats ? `至少 ${args.minSeats} 座` : '',
      args.roomTypeIds?.length ? `教室类型 ${args.roomTypeIds.join('/')}` : '',
    ]
      .filter(Boolean)
      .join('，');
    return {
      text: renderFreeRooms(byDuration(scoped), {
        date,
        sectionLabel: label,
        maxRooms: args.limit ?? 12,
        ...(campus ? { campus } : {}),
        ...(place ? { place: place.label } : {}),
        ...(place ? { placeTotal: rooms.length } : {}),
        ...(breakdown ? { breakdown } : {}),
        ...(filters ? { filters } : {}),
      }),
      data: {
        date,
        count: scoped.length,
        rooms: scoped,
        ...(campus ? { campus } : {}),
        ...(place ? { place: place.label } : {}),
      },
    };
  },
};

/**
 * 通知卡片：结构化（分类 + 时间 + 地点 + 截止），不是关键词列表。
 *
 * 这是**唯一**的通知入口：老路径 `search_notice`（纯关键词 contains、命不中就回「最近的通知」）
 * 已经并进来——它和新路径共用 noticeRules 的同义词表，留着两套只会让「最近有比赛吗」和
 * 「最近有什么比赛」给出两种形态的答案。现在关键词走 `keyword`，时间窗走 `withinDays`。
 */
export const findNotices: ToolDefinition<{
  category?: 'lecture' | 'competition' | 'activity' | 'meeting' | 'academic' | 'life';
  topic?: string;
  keyword?: string;
  withinDays?: number;
  sort?: 'published' | 'deadline';
  limit?: number;
}> = {
  name: 'find_notices',
  description:
    '查通知卡片（讲座/比赛/活动/会议/教务/生活 六类，教务还会细分到选课/考试/成绩/学籍/毕业/实习等子类）。' +
    '每条给出：标题、分类、活动时间、地点、报名截止。可按分类/子类筛、按最近 N 天或 N 天内截止筛、按发布时间或截止时间排序。' +
    '用户问「最近的通知」「今天有什么讲座」「最近有比赛吗」「×× 什么时候截止」都用它。',
  schema: z.object({
    category: z.enum(['lecture', 'competition', 'activity', 'meeting', 'academic', 'life']).optional(),
    topic: z.string().min(1).optional(),
    keyword: z.string().min(1).optional(),
    withinDays: z.number().int().min(0).max(365).optional(),
    sort: z.enum(['published', 'deadline']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async run(args, svc) {
    const today = todayShanghai();
    // 多抓一些：分类/时间窗都在客户端做，服务端 limit 只决定「抓多少回来」。
    // 注意 services.notices 已按发布时间倒序再截断，所以 80 条是「最新的 80 条」。
    const notices = await svc.notices({ limit: 80 });
    const cards = buildCards(notices, { today });
    const picked = filterCards(cards, {
      ...(args.category ? { categories: [args.category] } : {}),
      ...(args.keyword ? { keyword: args.keyword } : {}),
      ...(args.withinDays !== undefined ? { withinDays: args.withinDays } : {}),
      today,
    });
    // 子类（教务细分：选课/考试/成绩/学籍/毕业/实习…）按标签或标题匹配
    const scoped = args.topic
      ? picked.filter((card) => (card.topicLabel ?? '').includes(args.topic!) || card.title.includes(args.topic!))
      : picked;
    const sorted = sortCards(scoped, args.sort ?? 'published');
    const shown = sorted.slice(0, args.limit ?? 12);
    const digest = todayDigest(cards, today);

    if (shown.length > 0) {
      return {
        text: renderCards(shown, { today, ...(args.keyword ? { keyword: args.keyword } : {}) }),
        data: {
          count: sorted.length,
          today,
          ...(args.category ? { category: args.category, categoryLabel: CATEGORY_LABEL[args.category] } : {}),
          ...(args.topic ? { topic: args.topic } : {}),
          ...(args.withinDays !== undefined ? { withinDays: args.withinDays } : {}),
          cards: shown,
          digest,
        },
      };
    }

    // 没命中不要只回一句「没有」：说清楚筛了什么，并把「今天的状况 + 最近几条」摆出来
    const scope = [
      args.category ? CATEGORY_LABEL[args.category] : '',
      args.topic ?? '',
      args.withinDays !== undefined ? `最近 ${args.withinDays} 天` : '',
      args.keyword ? `关键词「${args.keyword}」` : '',
    ].filter(Boolean);
    const recent = sortCards(cards, 'published').slice(0, 3);
    const lines = [`没有${scope.length ? scope.join(' · ') + ' 的' : ''}通知。`, '', `今天：${digest.line}。`];
    if (recent.length > 0) {
      lines.push('', '最近的通知：');
      for (const card of recent) lines.push(cardLine(card, today));
    }
    return {
      text: lines.join('\n'),
      data: { count: 0, today, cards: [], digest },
    };
  },
};

export interface NoticeBody {
  id: string;
  title: string;
  /** 纯文本正文（教务有完整 HTML，转文本后给 UI，接口 HTML 不进 DOM） */
  text: string;
  url?: string;
}

/**
 * 单条通知的正文。
 * 卡片里只有 160 字摘要，想读全文时按 id 回查一次（`svc.notices` 有缓存，几乎不额外打请求）。
 * 参数收成 `Pick<CampusService,'notices'>`，单测里给个假对象就能测，不用真 token。
 */
export async function getNoticeBody(
  svc: Pick<CampusService, 'notices'>,
  id: string,
): Promise<NoticeBody | null> {
  const notices = await svc.notices({ limit: 80 });
  const hit = notices.find((notice) => cardId(notice) === id);
  if (!hit) return null;
  const text = hit.contentHtml ? toPlainText(hit.contentHtml) : hit.summary;
  return { id, title: hit.title, text: text.slice(0, 6000), ...(hit.url ? { url: hit.url } : {}) };
}

export const getGrades: ToolDefinition<{ course?: string }> = {
  name: 'get_grades',
  description:
    '查成绩与绩点，可按课程名过滤（如“高数”“线性代数”）。返回每门课的分数、学分、绩点，以及服务端给出的构成分（平时/期中/期末/卷面等，字段因课而异）。',
  schema: z.object({ course: z.string().min(1).optional() }),
  async run(args, svc) {
    const grades = await svc.grades();
    return {
      text: renderGrades(grades, { ...(args.course ? { course: args.course } : {}) }),
      data: { count: grades.length, grades, ...(args.course ? { course: args.course } : {}) },
    };
  },
};

export const getExams: ToolDefinition<Record<string, never>> = {
  name: 'get_exams',
  description: '查考试安排。',
  schema: z.object({}),
  async run(_args, svc) {
    const exams = await svc.exams();
    if (exams.length === 0) return { text: '当前学期没有考试安排（或还没发布）。', data: { count: 0 } };
    const rows = ['**考试安排**', ''];
    for (const e of exams) {
      rows.push(`- ${e.courseName ?? '未知课程'} ${e.examTime ?? ''} ${e.place ?? ''} ${e.seatNo ? `座位 ${e.seatNo}` : ''}`);
    }
    return { text: rows.join('\n'), data: { count: exams.length, exams } };
  },
};

export const exportIcs: ToolDefinition<{ fromWeek?: number; toWeek?: number }> = {
  name: 'export_ics',
  description: '把整个学期的课表导出成 iCalendar（.ics），可导入手机日历。',
  schema: z.object({
    fromWeek: z.number().int().min(1).max(30).optional(),
    toWeek: z.number().int().min(1).max(30).optional(),
  }),
  async run(args, svc) {
    const term = await svc.term();
    const courses = await svc.courses();
    const ics = coursesToIcs(courses, {
      term,
      ...(args.fromWeek ? { fromWeek: args.fromWeek } : {}),
      ...(args.toWeek ? { toWeek: args.toWeek } : {}),
    });
    const events = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
    return {
      text: `已生成 ${term.code} 课表日历：${events} 个日程（${courses.length} 门课）。`,
      data: { filename: `zzu-${term.code}.ics`, ics, events },
    };
  },
};

export const getPlanProgress: ToolDefinition<{ code?: string }> = {
  name: 'get_plan_progress',
  description: '查培养方案完成情况：要求学分、已通过、在修、还差多少，以及各模块进度。',
  schema: z.object({
    // 培养类型 code：主修=01（见 /plan/search/completion/cultivateTypes）
    code: z.string().min(1).optional(),
  }),
  async run(args, svc) {
    const plan = await svc.planProgress(args.code ?? '01');
    return {
      text: renderPlanProgress(plan),
      data: {
        requiredCredits: plan.requiredCredits,
        passedCredits: plan.passedCredits,
        takingCredits: plan.takingCredits,
        missingCourses: plan.missingCourses,
        modules: plan.modules,
      },
    };
  },
};

export const openService: ToolDefinition<{ keyword: string }> = {
  name: 'open_service',
  description:
    '把门户里的服务直接打开：给关键词（报修/食堂/奖学金…），返回入口链接。座位预约例外——那个站网页登录走不通，不给链接，只提示去「我的 → 图书馆登录」。',
  schema: z.object({ keyword: z.string().min(1) }),
  async run(args) {
    const hits = matchServices(args.keyword, 3);
    if (hits.length === 0) {
      const names = PORTAL_SERVICES.map((s) => s.name).join('、');
      return { text: `没找到「${args.keyword}」对应的服务。可用的有：${names}。`, data: { matched: 0 } };
    }
    const best = hits[0]!;
    const rows = [`**${best.service.name}**`, '', best.service.what];
    if (best.service.campusOnly) rows.push('', '_仅校内网 / VPN 可用_');
    /* 有的站登录页在 App 里走不通：不给链接，改指设置面板，免得点进去白忙一场 */
    if (best.service.noLink) {
      rows.push('', '这个入口的网页登录用不了：请到「我的 → 图书馆登录」用学校账号登录，回来再试。');
    }
    // 链接交给面板渲染成按钮（data.url），正文不重复贴一遍裸 URL
    if (hits.length > 1) {
      rows.push('', '其他可能相关的：');
      for (const h of hits.slice(1)) rows.push(`- ${h.service.name}`);
    }
    return {
      text: rows.join('\n'),
      data: {
        matched: hits.length,
        name: best.service.name,
        ...(best.service.noLink ? { noLink: true } : { url: best.service.url }),
        what: best.service.what,
      },
    };
  },
};

export const getCard: ToolDefinition<Record<string, never>> = {
  name: 'get_card',
  description: '查校园一卡通：余额、最近消费与充值。',
  schema: z.object({}),
  async run(_args, svc) {
    const card = await svc.card();
    return {
      text: renderCard(card),
      data: {
        balance: card.balance,
        ...(card.appUrl ? { url: card.appUrl, name: '一卡通' } : {}),
      },
    };
  },
};

export const getTodos: ToolDefinition<Record<string, never>> = {
  name: 'get_todos',
  description: '查有没有要办的事：待办/在办/待申请计数与具体事项。',
  schema: z.object({}),
  async run(_args, svc) {
    const todos = await svc.todos();
    const itemUrl = todos.items.find((i) => typeof i.url === 'string' && i.url)?.url;
    return {
      text: renderTodos(todos),
      data: {
        counts: todos.counts,
        items: todos.items.length,
        ...(itemUrl ? { url: itemUrl } : {}),
      },
    };
  },
};

const FLOOR_NAMES = ['一楼', '二楼', '三楼', '四楼'] as const;
type FloorName = (typeof FLOOR_NAMES)[number];

/**
 * 把模型给的语义参数折算成馆站的区域 id。
 * 模型只需要说"二楼"或"语言文史书库"，不用（也不该）记数字 id。
 */
function resolveLibraryArea(args: { floor?: string; room?: string; areaId?: string }): string {
  if (args.room) {
    const byRoom = areaIdByName(args.room);
    if (byRoom) return byRoom;
  }
  const f = args.floor as FloorName | undefined;
  if (f && FLOOR_AREA_ID[f]) return FLOOR_AREA_ID[f];
  if (args.areaId) return args.areaId;
  return FLOOR_AREA_ID['一楼'] ?? '3';
}

export const librarySeatTool: ToolDefinition<{ date?: string }> = {
  name: 'library_seats',
  description:
    '查图书馆还有多少空座（各馆实时空闲/总数），需要“今天/明天图书馆还有位置吗”“自习去哪坐”时用。只给余量和入口，选座/预约本人做。',
  schema: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  async run(args, svc) {
    const seats = await svc.librarySeats(args.date);
    return {
      text: renderLibrarySeats(seats),
      data: {
        date: seats.date,
        premises: seats.premises,
        free: seats.premises.reduce((n, p) => n + p.free, 0),
        total: seats.premises.reduce((n, p) => n + p.total, 0),
        name: '图书馆座位',
      },
    };
  },
};

export const librarySeatMapTool: ToolDefinition<{
  floor?: FloorName;
  room?: string;
  areaId?: string;
  date: string;
}> = {
  name: 'library_seat_map',
  description:
    '读图书馆某个区域某天的**座位级**数据（哪个座位号空着）。需要用户先在「我的 → 图书馆登录」登录（别让他点网页链接，那个登录用不了，也不要输出网址）。用户问“一楼大厅还有哪些座位”“二楼有哪些房间”“三楼自习室 A 区还有位置吗”“靠窗还有位置吗”“订 001”时先调这个确认。二层以上一层里有多间房：只给楼层会把每间都画出来，给了 room 就只画那一间。',
  schema: z.object({
    floor: z.enum(FLOOR_NAMES).optional(),
    room: z.string().min(1).optional(),
    areaId: z.string().min(1).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  async run(args) {
    const area = resolveLibraryArea(args);

    /* 没点名房间、但能确定楼层时：把这一层的房间逐个读一遍，别只读第一个 */
    const floorName = (args.floor ?? floorOfArea(args.areaId ?? '')) as FloorName | undefined;
    /* areaId 若已指向"某间具体房间"（如二楼 9），就按单间处理，绝不整层展开 */
    const givenId = String(args.areaId ?? '').trim();
    const isSpecificRoom = Boolean(givenId) && Boolean(areaNameOf(givenId)) && givenId !== FLOOR_AREA_ID[floorName ?? ''];
    if (!args.room && floorName && !isSpecificRoom) {
      const ids: string[] = [...new Set(FLOOR_AREA_ALTS[floorName] ?? [])];
      if (ids.length > 1) {
        const rows: string[] = [];
        const images: { areaName: string; image: string }[] = [];
        for (const id of ids) {
          const one = await readLibrarySeats({ areaId: id, date: args.date });
          const label = areaNameOf(id) ?? `区域 ${id}`;
          if (!one.ok || !one.data || !one.data.seats.length) {
            const why = (one.error ?? '读不到').replace(/^[^：]*：/, '').slice(0, 40);
            rows.push(`- ${label}（${id}）：${why}`);
            continue;
          }
          const free = one.data.seats.filter((x) => x.free).length;
          rows.push(`- **${label}**（${id}）：${one.data.total ?? one.data.seats.length} 座，空 ${free}`);
          const uri = seatMapDataUri(one.data);
          if (uri) images.push({ areaName: one.data.areaName ?? label, image: uri });
        }
        const head = `${args.date} ${floorName} · 共 ${ids.length} 间`;
        const tail =
          '\n要哪一间的座位图就说名字（例如「二楼工程与信息书库-2 座位图」），我再只画那一间。';
        return {
          text: `${head}\n\n${rows.join('\n')}${tail}`,
          data: {
            date: args.date,
            floor: floorName,
            rooms: ids,
            images,
            image: images[0]?.image,
            imageAlt: images[0] ? `${images[0].areaName} 座位图` : undefined,
          },
        };
      }
    }

    const res = await readLibrarySeats({ areaId: area, date: args.date });
    if (!res.ok || !res.data) {
      /* 这里**不给链接**：那个站的网页登录在 App 里走不通，点进去也登不上。
         统一让用户去「我的 → 图书馆登录」，AI 也照这个说。
         错误文案里可能已经带了这句引导，那就别重复第二遍。 */
      const why = res.error ?? '读不到座位图。';
      const hint = why.includes('我的 → 图书馆登录')
        ? ''
        : '\n\n登录入口在「我的 → 图书馆登录」：用学号 + 图书馆密码登一次，回来再说一次就行（别从网页链接进，那个登录用不了）。';
      return {
        text: `${why}${hint}`,
        data: { error: true, args },
      };
    }
    if (!res.data.seats.length) {
      const raw = JSON.stringify(res.data.raw ?? res.data).slice(0, 900);
      return {
        text: `这次没解析出座位号（接口可能改了字段名）。原始返回片段：\n\`\`\`json\n${raw}\n\`\`\`\n把这段发我，我按真实字段改解析。`,
        data: { error: true, raw: res.data.raw },
      };
    }

    /* 点名了某一间就只画那间；没点名就把这一层所有房间都列出来 + 各画一张 */
    const whole = res.data;
    let map: typeof whole = whole;
    let note = '';
    if (args.room) {
      const picked = pickRoom(whole, args.room);
      if (picked) {
        map = picked;
      } else if ((whole.rooms?.length ?? 0) > 1) {
        note = `这层没有叫「${args.room}」的房间，下面是全部 ${whole.rooms!.length} 间。`;
      }
    }

    const text = [note, renderSeatMap(map)].filter(Boolean).join('\n\n');
    const image = seatMapDataUri(map);
    return {
      text,
      data: {
        areaId: area,
        date: args.date,
        ...(args.room ? { room: args.room } : {}),
        free: map.seats.filter((s) => s.free).length,
        total: map.seats.length,
        ...(map.rooms?.length ? { rooms: map.rooms.map((r) => ({ name: r.name, free: r.free ?? 0, total: r.total ?? r.seats.length })) } : {}),
        seats: map.seats.slice(0, 200),
        ...(image ? { image, imageAlt: '图书馆座位平面图' } : {}),
        name: '图书馆座位图',
      },
    };
  },
};

/**
 * 下单工具：**只产出「待确认」的动作用户看**，绝不自己下单。
 * 真正的执行由面板上的长按按钮触发（`lib:book` → content script 操作页面）。
 */
export const bookLibrarySeatTool: ToolDefinition<{
  floor?: FloorName;
  room?: string;
  areaId?: string;
  date: string;
  seatNo: string;
}> = {
  name: 'book_library_seat',
  description:
    '准备一条图书馆座位预约（**不会真的下单**）。用户说“帮我订 001”“订一楼大厅 A12，明天”时调用；返回后界面上会出现需要**长按**的确认按钮，用户长按才会真的提交。',
  schema: z.object({
    floor: z.enum(FLOOR_NAMES).optional(),
    room: z.string().min(1).optional(),
    areaId: z.string().min(1).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    seatNo: z.string().min(1),
  }),
  async run(args) {
    const area = resolveLibraryArea(args);
    return {
      text: `要预约 **${args.date}** 的座位 **${args.seatNo}**（区域 ${area}）。\n下面那个按钮要**长按**才会提交，误触不会下单。`,
      data: {
        action: {
          kind: 'library-book',
          areaId: area,
          date: args.date,
          seatNo: args.seatNo,
          label: `长按预约 ${args.seatNo}`,
        },
      },
    };
  },
};

const studySpotTool: ToolDefinition<{ date?: string; needMinutes?: number; near?: string; maxWalkMin?: number }> = {
  name: 'find_study_spot',
  description:
    '找「现在就能连续坐一会儿」的地方：同时看空教室和图书馆余量，按能坐多久和步行距离排序。用户说「我想自习两小时」「哪能安静看会儿书」就用它。',
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    needMinutes: z.number().int().positive().max(720).optional(),
    near: z.string().min(1).optional(),
    maxWalkMin: z.number().int().positive().max(60).optional(),
  }),
  async run(args, svc) {
    const date = args.date ?? todayShanghai();
    const needMinutes = args.needMinutes ?? 120;
    const rooms = await svc.freeRooms({ date });
    let library: Awaited<ReturnType<typeof svc.librarySeats>> | undefined;
    try {
      library = await svc.librarySeats(date);
    } catch {
      library = undefined; // 校外/断网时图书馆不是必须项
    }
    const plan = planStudy({
      needMinutes,
      rooms,
      library,
      ...(args.near ? { near: args.near } : {}),
      ...(args.maxWalkMin ? { maxWalkMin: args.maxWalkMin } : {}),
    });
    return {
      text: renderStudyPlan(plan, { date, ...(args.near ? { near: args.near } : {}) }),
      data: { needMinutes, options: plan.options, libraryNote: plan.libraryNote ?? null },
    };
  },
};

export const TOOLS = {
  get_schedule: getSchedule,
  find_free_room: findFreeRoom,
  find_study_spot: studySpotTool,
  find_notices: findNotices,
  get_grades: getGrades,
  get_exams: getExams,
  get_plan_progress: getPlanProgress,
  get_card: getCard,
  get_todos: getTodos,
  library_seats: librarySeatTool,
  library_seat_map: librarySeatMapTool,
  book_library_seat: bookLibrarySeatTool,
  open_service: openService,
  export_ics: exportIcs,
} as const;

export type ToolName = keyof typeof TOOLS;

export async function runTool(name: ToolName, args: unknown, svc: CampusService): Promise<ToolResult> {
  const def = TOOLS[name] as ToolDefinition<unknown>;
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('；');
    throw new Error(`参数不合法（${name}）：${detail}`);
  }
  return def.run(parsed.data, svc);
}
