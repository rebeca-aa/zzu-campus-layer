/**
 * 教务（教学管理平台 / jwxt.zzu.edu.cn）数据源。
 * 两层：eams-door 门面（首页聚合）+ eams-micro-server（业务 BFF）。
 * 全部接口实测见 docs/campus-site-probe.md §9。
 */
import { EAMS_DOOR, EAMS_MICRO, get, post } from './http';
import { Course, CourseUnit, Exam, Grade, Notice, Occupancy, Room, Term } from './types';
import { hhmm, uniq, weekOfDate, weekdayOf } from './util';

export interface JwxtOptions {
  token: string;
  signal?: AbortSignal;
}

interface RawSemester {
  id: number;
  code: string;
  startDate: string;
  endDate: string;
  weekIndices?: number[];
  season?: string | null;
}

function toTerm(raw: RawSemester, currentWeek?: number): Term {
  return Term.parse({
    id: String(raw.id),
    code: raw.code,
    startDate: raw.startDate,
    endDate: raw.endDate,
    weeks: raw.weekIndices ?? [],
    ...(currentWeek !== undefined && currentWeek > 0 ? { currentWeek } : {}),
    ...(raw.season ? { season: raw.season } : {}),
  });
}

export async function jwxtCurrentTerm(opts: JwxtOptions): Promise<Term> {
  const raw = await get<RawSemester>(EAMS_MICRO, '/semester/current-semester', {
    token: opts.token,
    source: 'jwxt',
  });
  let currentWeek = 0;
  try {
    currentWeek = await jwxtCurrentWeek(opts, raw.id);
  } catch {
    currentWeek = 0;
  }
  return toTerm(raw, currentWeek);
}

export async function jwxtCurrentWeek(opts: JwxtOptions, termId: number | string): Promise<number> {
  const n = await get<number | string>(EAMS_MICRO, `/semester/current-week/${termId}`, {
    token: opts.token,
    source: 'jwxt',
  });
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

export async function jwxtSemesters(opts: JwxtOptions): Promise<Term[]> {
  const raws = await get<RawSemester[]>(EAMS_MICRO, '/semester/std-semesters', {
    token: opts.token,
    source: 'jwxt',
  });
  return (raws ?? []).map((r) => toTerm(r));
}

interface RawScheduleItem {
  date: string;
  weekday: number;
  startTime: number;
  endTime: number;
  teacherName?: string | null;
  startUnit?: number | null;
  endUnit?: number | null;
  weekIndex?: number | null;
  room?: { nameZh?: string | null; building?: { nameZh?: string | null } | null; campus?: { nameZh?: string | null } | null } | null;
}

interface RawTableCourse {
  id: number;
  code?: string | null;
  campus?: { nameZh?: string | null } | null;
  course: { nameZh: string; credits?: number | null };
  teacherAssignmentList?: Array<string | null> | null;
  schedules?: RawScheduleItem[] | null;
  openDepartment?: { nameZh?: string | null } | null;
}

/**
 * 学生课表。返回按课程组织的结构，每门课带 12–40 条已实例化的上课时间，
 * 每条都带 weekIndex / startUnit / endUnit，比门户更权威。
 */
export async function jwxtCourseTable(opts: JwxtOptions, termId: number | string): Promise<Course[]> {
  const raws = await get<RawTableCourse[]>(EAMS_MICRO, `/lesson/student/course-table/${termId}`, {
    token: opts.token,
    source: 'jwxt',
  });
  return normalizeCourseTable(raws ?? []);
}

/** 纯函数版本，便于用 fixture 单测。 */
export function normalizeCourseTable(raws: RawTableCourse[]): Course[] {
  const groups = new Map<string, Course>();
  for (const item of raws ?? []) {
    const name = item.course?.nameZh;
    if (!name) continue;
    const teachers = (item.teacherAssignmentList ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0);
    for (const s of item.schedules ?? []) {
      if (!s.date) continue;
      const weekday = s.weekday ?? weekdayOf(s.date);
      const startTime = hhmm(s.startTime);
      const endTime = hhmm(s.endTime);
      const location = s.room?.nameZh ?? undefined;
      const key = [name, weekday, startTime, endTime, location ?? '', teachers.join('/')].join('|');
      const week = s.weekIndex ?? 0;
      const existing = groups.get(key);
      if (existing) {
        if (week > 0) existing.weeks = uniq([...existing.weeks, week]);
        continue;
      }
      groups.set(
        key,
        Course.parse({
          key,
          name,
          teachers,
          ...(location ? { location } : {}),
          ...(s.room?.campus?.nameZh ? { campus: s.room.campus.nameZh } : item.campus?.nameZh ? { campus: item.campus.nameZh } : {}),
          weekday,
          startTime,
          endTime,
          ...(typeof s.startUnit === 'number' ? { sectionStart: s.startUnit } : {}),
          ...(typeof s.endUnit === 'number' ? { sectionEnd: s.endUnit } : {}),
          weeks: week > 0 ? [week] : [],
          date: s.date,
          source: 'jwxt',
        }),
      );
    }
  }

  return [...groups.values()].sort(
    (a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime),
  );
}

/** 由门户风格的日期实例事件推出课程（教务不可用时的降级路径）。 */
export function coursesFromDateInstances(
  items: Array<{
    title: string;
    date: string;
    startTime: string;
    endTime: string;
    location?: string;
    teachers?: string[];
    sectionStart?: number;
    sectionEnd?: number;
    key?: string;
  }>,
  termStart: string,
): Course[] {
  const groups = new Map<string, Course>();
  for (const it of items) {
    const week = weekOfDate(termStart, it.date);
    const weekday = weekdayOf(it.date);
    const key = [it.title, weekday, it.startTime, it.endTime, it.location ?? '', (it.teachers ?? []).join('/')].join('|');
    const existing = groups.get(key);
    if (existing) {
      if (week > 0) existing.weeks = uniq([...existing.weeks, week]);
      continue;
    }
    groups.set(
      key,
      Course.parse({
        key,
        name: it.title,
        teachers: it.teachers ?? [],
        ...(it.location ? { location: it.location } : {}),
        weekday,
        startTime: it.startTime,
        endTime: it.endTime,
        ...(it.sectionStart !== undefined ? { sectionStart: it.sectionStart } : {}),
        ...(it.sectionEnd !== undefined ? { sectionEnd: it.sectionEnd } : {}),
        weeks: week > 0 ? [week] : [],
        date: it.date,
        source: 'jwxt',
      }),
    );
  }
  return [...groups.values()].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
}

export async function jwxtGrades(opts: JwxtOptions): Promise<Grade[]> {
  const raws = await get<unknown[]>(EAMS_MICRO, '/grade/student/grades', {
    token: opts.token,
    source: 'jwxt',
  });
  return (raws ?? []).map((r) => Grade.parse(r));
}

export async function jwxtExams(opts: JwxtOptions): Promise<Exam[]> {
  const raws = await get<unknown[]>(EAMS_MICRO, '/exam/student/exam', {
    token: opts.token,
    source: 'jwxt',
  });
  return (raws ?? []).map((r) => Exam.parse(r));
}

export interface PlanModule {
  name: string;
  required: number;
  passed: number;
  taking: number;
  result?: string;
  children?: PlanModule[];
  /** 未修课程数（只统计叶子模块的 planCourses） */
  missingCourses?: number;
}

export interface PlanProgress {
  /** 培养方案要求总学分 */
  requiredCredits: number;
  /** 已通过学分 */
  passedCredits: number;
  /** 在修学分 */
  takingCredits: number;
  /** 未修课程门数（叶子 planCourses 里 result=未修 的） */
  missingCourses: number;
  modules: PlanModule[];
}

type RawPlanNode = {
  type?: { nameZh?: string };
  requireInfo?: { requiredCredits?: number };
  passedCredits?: number;
  taking?: number;
  result?: string;
  children?: RawPlanNode[];
  planCourses?: Array<{ result?: string }>;
};

/** 培养方案完成情况：GET /plan/search/completion/info?code=01（code 来自 cultivateTypes）。 */
export async function jwxtPlanCompletion(opts: JwxtOptions, code = '01'): Promise<PlanProgress> {
  const data = await get<{ modules?: RawPlanNode[]; requireInfo?: { credits?: number } }>(
    EAMS_MICRO,
    `/plan/search/completion/info?code=${encodeURIComponent(code)}`,
    { token: opts.token, source: 'jwxt' },
  );

  const leafMissing = (n: RawPlanNode): number => {
    if (n.children?.length) return n.children.reduce((sum, c) => sum + leafMissing(c), 0);
    return (n.planCourses ?? []).filter((c) => c.result === '未修').length;
  };
  const conv = (n: RawPlanNode): PlanModule => ({
    name: n.type?.nameZh ?? '未命名模块',
    required: n.requireInfo?.requiredCredits ?? 0,
    passed: n.passedCredits ?? 0,
    taking: n.taking ?? 0,
    ...(n.result ? { result: n.result } : {}),
    ...(n.children?.length ? { children: n.children.map(conv) } : {}),
    missingCourses: leafMissing(n),
  });

  const modules = (data.modules ?? []).map(conv);
  return {
    requiredCredits: data.requireInfo?.credits ?? modules.reduce((s, m) => s + m.required, 0),
    passedCredits: modules.reduce((s, m) => s + m.passed, 0),
    takingCredits: modules.reduce((s, m) => s + m.taking, 0),
    missingCourses: modules.reduce((s, m) => s + (m.missingCourses ?? 0), 0),
    modules,
  };
}

/** 节次表：indexNo + HHmm 起止 */export async function jwxtCourseUnits(opts: JwxtOptions): Promise<CourseUnit[]> {
  const raws = await get<unknown[]>(EAMS_MICRO, '/room/system/course-units', {
    token: opts.token,
    source: 'jwxt',
  });
  return (raws ?? [])
    .map((r) => CourseUnit.parse(r))
    .sort((a, b) => a.indexNo - b.indexNo);
}

export interface Campus {
  id: string;
  name: string;
}

export async function jwxtCampuses(opts: JwxtOptions): Promise<Campus[]> {
  const raws = await get<Array<{ id: number; nameZh?: string; name?: string }>>(
    EAMS_MICRO,
    '/room/place/campus',
    { token: opts.token, source: 'jwxt' },
  );
  return (raws ?? []).map((c) => ({ id: String(c.id), name: c.nameZh ?? c.name ?? String(c.id) }));
}

export interface Building {
  id: string;
  name: string;
  campusId?: string;
}

/**
 * 楼栋列表。
 *
 * 坑：`/room/place/building` 不带 `campusAssoc` 会 500
 * （`MissingServletRequestParameterException`，2026-11-03 实测），
 * 所以这里没传校区时先查一次校区，默认取「主校区」。
 */
export async function jwxtBuildings(opts: JwxtOptions, campusId?: string): Promise<Building[]> {
  let campus = campusId;
  if (!campus) {
    const campuses = await jwxtCampuses(opts);
    campus = campuses.find((c) => c.name.includes('主校区'))?.id ?? campuses[0]?.id;
    if (!campus) return [];
  }
  const raws = await get<Array<{ id: number; nameZh?: string; name?: string; campusAssoc?: number }>>(
    EAMS_MICRO,
    `/room/place/building?campusAssoc=${encodeURIComponent(campus)}`,
    { token: opts.token, source: 'jwxt' },
  );
  return (raws ?? []).map((b) => ({
    id: String(b.id),
    name: b.nameZh ?? b.name ?? String(b.id),
    ...(b.campusAssoc !== undefined ? { campusId: String(b.campusAssoc) } : {}),
  }));
}

interface RoomsQuery {
  date: string;
  campusId?: string | null;
  buildingIds?: Array<string | number>;
  roomTypeIds?: Array<string | number>;
  floors?: number[];
  minSeat?: string;
  maxSeat?: string;
  pageSize?: number;
  page?: number;
}

export async function jwxtRooms(opts: JwxtOptions, q: RoomsQuery): Promise<{ rooms: Room[]; total: number }> {
  // campusAssoc 必须是数字：传字符串 "2" 服务端会返回 0 条（不报错，静默空结果）。
  const campusAssoc =
    q.campusId === undefined || q.campusId === null || q.campusId === ''
      ? null
      : Number.isNaN(Number(q.campusId))
        ? q.campusId
        : Number(q.campusId);

  const raw = await post<{
    data?: Array<{
      id: number;
      nameZh?: string | null;
      code?: string | null;
      buildingId?: number | null;
      campusNameZh?: string | null;
      floor?: number | null;
      seatsForLesson?: number | null;
      roomOccupationInfoVms?: Array<{
        roomName?: string | null;
        date?: string | null;
        startTime?: number | null;
        endTime?: number | null;
        activityName?: string | null;
        activityType?: string | null;
        teacherName?: string | null;
      }> | null;
    }>;
    _page_?: { totalRows?: number; rowsPerPage?: number };
  }>(EAMS_MICRO, '/room/place/rooms', {
    currentPage: q.page ?? 1,
    // 服务端耗时随 pageSize 线性增长（30 条约 150ms，500 条约 20s），
    // 所以宁可多翻几页：小页 + 并发，总耗时反而更低。
    pageSize: q.pageSize ?? 30,
    campusAssoc,
    buildingIds: (q.buildingIds ?? []).map((b) => (Number.isNaN(Number(b)) ? b : Number(b))),
    roomTypeIds: (q.roomTypeIds ?? []).map((b) => (Number.isNaN(Number(b)) ? b : Number(b))),
    floors: q.floors ?? [],
    minSeat: q.minSeat ?? '',
    maxSeat: q.maxSeat ?? '',
    date: q.date,
  }, { token: opts.token, source: 'jwxt' });

  const rooms = (raw.data ?? []).map((r) =>
    Room.parse({
      id: String(r.id),
      name: r.nameZh ?? String(r.id),
      ...(r.code ? { code: r.code } : {}),
      ...(r.buildingId !== null && r.buildingId !== undefined ? { buildingId: String(r.buildingId) } : {}),
      ...(r.campusNameZh ? { campus: r.campusNameZh } : {}),
      ...(typeof r.floor === 'number' ? { floor: r.floor } : {}),
      ...(typeof r.seatsForLesson === 'number' ? { seats: r.seatsForLesson } : {}),
      ...(Array.isArray(r.roomOccupationInfoVms)
        ? {
            occupied: r.roomOccupationInfoVms
              .filter((o) => typeof o.startTime === 'number' && typeof o.endTime === 'number')
              .map((o) => ({
                roomName: o.roomName ?? (r.nameZh ?? String(r.id)),
                date: o.date ?? q.date,
                startAt: o.startTime as number,
                endAt: o.endTime as number,
                ...(o.activityName ? { activity: o.activityName } : {}),
                ...(o.activityType ? { type: o.activityType } : {}),
                ...(o.teacherName ? { teacher: o.teacherName } : {}),
              })),
          }
        : {}),
    }),
  );
  return { rooms, total: raw._page_?.totalRows ?? rooms.length };
}

/**
 * 把全校教室抓全（约 1614 间）。
 * 首查一页拿总数，其余分页并发拉取；实测并发 12、pageSize 30 约 4s。
 */
/**
 * 默认只查"能上课的教室"：普通教室(1) + 多媒体教室(2)。
 * 实测（主校区 2026-10-21）：不过滤 1039 间（大量实验室/办公用房）、
 * 只查 1+2 是 379 间，正好是 物_505 / 北3_312 这类真实上课教室。
 * 服务端 roomTypeIds 接受数字或数字字符串，两种都实测有效。
 */
export const CLASSROOM_TYPE_IDS = ['1', '2'];

export async function jwxtAllRooms(
  opts: JwxtOptions,
  q: Omit<RoomsQuery, 'page' | 'pageSize'>,
  concurrency = 12,
): Promise<Room[]> {
  const first = await jwxtRooms(opts, { ...q, page: 1, pageSize: 30 });
  const total = first.total;
  const perPage = first.rooms.length || 30;
  const pageCount = Math.min(200, Math.ceil(total / perPage));
  if (pageCount <= 1) return first.rooms.slice(0, total);

  const out = [...first.rooms];
  const queue: number[] = [];
  for (let p = 2; p <= pageCount; p += 1) queue.push(p);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const page = queue[cursor];
      cursor += 1;
      if (page === undefined) return;
      const res = await jwxtRooms(opts, { ...q, page, pageSize: perPage });
      out.push(...res.rooms);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  // 并发下顺序会乱，按 id 稳定排序便于缓存与展示
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

export async function jwxtOccupancy(opts: JwxtOptions, date: string): Promise<Occupancy[]> {
  const raws = await post<Array<Record<string, unknown>>>(EAMS_MICRO, '/room/place/room-occupancy', { date }, {
    token: opts.token,
    source: 'jwxt',
  });
  return (raws ?? []).map((r) =>
    Occupancy.parse({
      roomName: String(r.roomName ?? ''),
      date: String(r.date ?? date),
      startAt: Number(r.startTime ?? 0),
      endAt: Number(r.endTime ?? 0),
      ...(r.activityName ? { activity: String(r.activityName) } : {}),
      ...(r.activityType ? { type: String(r.activityType) } : {}),
      ...(r.teacherName ? { teacher: String(r.teacherName) } : {}),
    }),
  );
}

interface RawNotice {
  id: number;
  title: string;
  content?: string | null;
  sendDateTime?: string | null;
  readCount?: number | null;
  department?: { nameZh?: string | null } | null;
}

/** 教务处通知：这里是唯一能拿到**完整正文**的渠道。 */
export async function jwxtNotices(opts: JwxtOptions): Promise<Notice[]> {
  const raw = await get<{ noticeShowVms?: RawNotice[] }>(EAMS_DOOR, '/protal-notice/get-notices', {
    token: opts.token,
    source: 'jwxt',
  });
  return (raw.noticeShowVms ?? []).map((n) =>
    Notice.parse({
      id: String(n.id),
      title: n.title,
      summary: stripHtml(n.content ?? '').slice(0, 200),
      ...(n.content ? { contentHtml: n.content } : {}),
      ...(n.sendDateTime ? { publishedAt: n.sendDateTime } : {}),
      ...(n.department?.nameZh ? { department: n.department.nameZh } : {}),
      ...(typeof n.readCount === 'number' ? { readCount: n.readCount } : {}),
      source: 'jwxt-notice',
    }),
  );
}

export interface JwxtUser {
  name: string;
  account: string;
  identity: string;
}

export async function jwxtUserInfo(opts: JwxtOptions): Promise<JwxtUser> {
  const raw = await get<{ user?: { nameZh?: string }; account?: string; identity?: string }>(
    EAMS_DOOR,
    '/portal/home/user-info',
    { token: opts.token, source: 'jwxt' },
  );
  return {
    name: raw.user?.nameZh ?? '',
    account: raw.account ?? '',
    identity: raw.identity ?? '',
  };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
