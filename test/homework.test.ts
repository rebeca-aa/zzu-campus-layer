import { describe, expect, it } from 'vitest';
import {
  addHomework,
  decodeHomeworkCode,
  dueText,
  encodeHomeworkCode,
  homeworkReminders,
  homeworkState,
  homeworkStats,
  importHomeworkCode,
  loadHomework,
  loadHomeworkSettings,
  normalizeHomework,
  normalizeSettings,
  parseDueAt,
  parseHomework,
  remainText,
  removeHomework,
  saveHomework,
  saveHomeworkSettings,
  toggleHomeworkDone,
  updateHomework,
  type HomeworkItem,
} from '../src/core/homework';

/** 固定一个「2026-11-13 09:00（周五）」当现在 */
const NOW = new Date(2026, 10, 13, 9, 0, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function item(patch: Partial<HomeworkItem> = {}): HomeworkItem {
  return { id: 'h1', title: '习题册 3.1', dueAt: NOW + 2 * DAY, createdAt: NOW, ...patch };
}

describe('normalizeHomework', () => {
  it('丢掉没标题、没时间的脏条目，并按截止时间排序', () => {
    const list = normalizeHomework([
      { title: '晚交的', dueAt: NOW + 3 * DAY },
      { title: '', dueAt: NOW },
      { title: '没时间' },
      { title: '早的', dueAt: NOW + DAY },
    ]);
    expect(list.map((x) => x.title)).toEqual(['早的', '晚交的']);
  });

  it('id 重复时只留第一条；非数组/垃圾输入给空数组', () => {
    const list = normalizeHomework([
      { id: 'x', title: 'A', dueAt: NOW + DAY },
      { id: 'x', title: 'B', dueAt: NOW + DAY },
    ]);
    expect(list).toHaveLength(1);
    expect(normalizeHomework('nope')).toEqual([]);
    expect(normalizeHomework(null)).toEqual([]);
  });
});

describe('add / update / remove / 提交', () => {
  it('加一条：自动按时间插入', () => {
    const list = addHomework([], { title: ' 线代 2.1 ', course: ' 线性代数 ', dueAt: NOW + DAY }, NOW);
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('线代 2.1');
    expect(list[0]!.course).toBe('线性代数');
    expect(list[0]!.source).toBe('manual');
  });

  it('内容为空、时间非法都报中文原因', () => {
    expect(() => addHomework([], { title: '   ', dueAt: NOW }, NOW)).toThrow('写点作业内容');
    expect(() => addHomework([], { title: 'x', dueAt: Number.NaN }, NOW)).toThrow('截止时间');
  });

  it('改一条：能改标题/课程/时间，空标题报错', () => {
    const list = [item()];
    const next = updateHomework(list, 'h1', { title: '习题册 3.2', dueAt: NOW + 3 * DAY });
    expect(next[0]!.title).toBe('习题册 3.2');
    expect(next[0]!.dueAt).toBe(NOW + 3 * DAY);
    expect(() => updateHomework(list, 'h1', { title: '' })).toThrow('不能为空');
  });

  it('删一条', () => {
    expect(removeHomework([item(), item({ id: 'h2' })], 'h1')).toHaveLength(1);
  });

  it('提交后带 doneAt，再点一次撤销', () => {
    const done = toggleHomeworkDone([item()], 'h1', NOW + HOUR);
    expect(done[0]!.doneAt).toBe(NOW + HOUR);
    const back = toggleHomeworkDone(done, 'h1', NOW + 2 * HOUR);
    expect(back[0]!.doneAt).toBeUndefined();
  });
});

describe('统计与状态', () => {
  it('分得出逾期 / 今天 / 本周 / 完成率', () => {
    const list = normalizeHomework([
      { title: 'A', dueAt: NOW - DAY }, // 逾期
      { title: 'B', dueAt: NOW + 2 * HOUR }, // 今天
      { title: 'C', dueAt: NOW + 3 * DAY }, // 本周
      { title: 'D', dueAt: NOW + 2 * DAY, doneAt: NOW }, // 已交
      { title: 'E', dueAt: NOW + 20 * DAY }, // 更远
    ]);
    const st = homeworkStats(list, NOW);
    expect(st).toMatchObject({ todo: 4, overdue: 1, today: 1, done: 1, total: 5, rate: 20 });
    expect(st.week).toBe(2);
  });

  it('按课程分组，没课程的归到「未分类」', () => {
    const list = normalizeHomework([
      { title: 'A', course: '高数', dueAt: NOW + DAY },
      { title: 'B', course: '高数', dueAt: NOW + DAY, doneAt: NOW },
      { title: 'C', dueAt: NOW + DAY },
    ]);
    const st = homeworkStats(list, NOW);
    expect(st.byCourse[0]).toMatchObject({ course: '高数', todo: 1, done: 1 });
    expect(st.byCourse.find((c) => c.course === '未分类')?.todo).toBe(1);
  });

  it('状态与剩余时间文案', () => {
    expect(homeworkState(item({ dueAt: NOW - HOUR }), NOW)).toBe('overdue');
    expect(homeworkState(item({ dueAt: NOW + 2 * HOUR }), NOW)).toBe('today');
    expect(homeworkState(item({ dueAt: NOW + 2 * DAY }), NOW)).toBe('soon');
    expect(homeworkState(item({ dueAt: NOW + 10 * DAY }), NOW)).toBe('later');
    expect(homeworkState(item({ doneAt: NOW }), NOW)).toBe('done');

    expect(remainText(item({ dueAt: NOW - 2 * DAY }), NOW)).toBe('逾期 2 天');
    expect(remainText(item({ dueAt: NOW + 14 * HOUR }), NOW)).toBe('还有 14 小时');
    expect(remainText(item({ doneAt: NOW }), NOW)).toBe('已提交');
  });

  it('截止时间显示成 11-16 22:00', () => {
    const due = new Date(2026, 10, 16, 22, 0, 0, 0).getTime();
    expect(dueText(due, NOW)).toBe('11-16 22:00');
  });
});

describe('解析截止时间', () => {
  it('认 11-16 / 11月16日，时间按 22:00', () => {
    expect(parseDueAt('11-16 22:00 前交', NOW)).toBe(new Date(2026, 10, 16, 22, 0).getTime());
    expect(parseDueAt('11月20日前交', NOW)).toBe(new Date(2026, 10, 20, 23, 59).getTime());
  });

  it('认今天 / 明天 / 后天', () => {
    expect(parseDueAt('明天交', NOW)).toBe(new Date(2026, 10, 14, 23, 59).getTime());
    expect(parseDueAt('后天中午12点前', NOW)).toBe(new Date(2026, 10, 15, 12, 0).getTime());
  });

  it('认周几：本周五 / 下周三', () => {
    expect(parseDueAt('这周五交', NOW)).toBe(new Date(2026, 10, 20, 23, 59).getTime());
    expect(parseDueAt('下周三 10:00', NOW)).toBe(new Date(2026, 10, 25, 10, 0).getTime());
  });

  it('认不出时间就返回 null，不瞎猜', () => {
    expect(parseDueAt('记得看群公告', NOW)).toBeNull();
  });

  it('不把「习题册 3.1–3.4」里的数字当成日期', () => {
    /* NOW 是周五，「周五前交」就是今天最后一刻 */
    expect(parseDueAt('习题册 3.1–3.4 周五前交', NOW)).toBe(new Date(2026, 10, 13, 23, 59).getTime());
    /* 没有周几、只有章节号时，认不出就是认不出 */
    expect(parseDueAt('习题册 3.1–3.4', NOW)).toBeNull();
  });

  it('「晚 12 点」按当天最后一刻算，不是中午', () => {
    expect(parseDueAt('周日晚 12 点前', NOW)).toBe(new Date(2026, 10, 15, 23, 59).getTime());
  });

  it('「周五前交」碰上今天就是周五，算今天', () => {
    expect(parseDueAt('周五前交', NOW)).toBe(new Date(2026, 10, 13, 23, 59).getTime());
    expect(parseDueAt('这周五交', NOW)).toBe(new Date(2026, 10, 20, 23, 59).getTime());
  });
});

describe('解析群消息', () => {
  it('一句话里两条作业，各带自己的截止时间', () => {
    const text = '@所有人 高数作业：习题册 3.1–3.4 周五前交，纸质交到学委那儿。英语作文二记得传雨课堂，周日晚上12点前。';
    const drafts = parseHomework(text, NOW);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.title).toContain('习题册');
    expect(drafts[0]!.note).toBe('交纸质');
    expect(drafts[1]!.title).toContain('英语作文二');
    expect(drafts[1]!.note).toBe('线上提交');
  });

  it('一句都解析不出时间时，退化成一条让用户自己改', () => {
    const drafts = parseHomework('作业：复习第三章', NOW);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toContain('复习第三章');
    expect(drafts[0]!.dueAt).toBeGreaterThan(NOW);
  });
});

describe('分享码', () => {
  const list = normalizeHomework([
    { title: 'A', course: '高数', dueAt: NOW + DAY, note: '交纸质' },
    { title: 'B', dueAt: NOW + 2 * DAY },
  ]);

  it('导出再导入，内容一致（重复的合并）', () => {
    const code = encodeHomeworkCode(list, { now: NOW, from: '学委' });
    const parsed = decodeHomeworkCode(code);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.from).toBe('学委');
    expect(parsed.items[0]!.title).toBe('A');
    expect(parsed.items[0]!.note).toBe('交纸质');
  });

  it('带上订阅地址，解出来还在', () => {
    const code = encodeHomeworkCode(list, { now: NOW, feedUrl: 'https://example.com/hw.json' });
    expect(decodeHomeworkCode(code).feed).toBe('https://example.com/hw.json');
  });

  it('合并：只补缺的，重复的不重复加', () => {
    const code = decodeHomeworkCode(encodeHomeworkCode(list, { now: NOW }));
    const local = normalizeHomework([{ title: 'A', dueAt: NOW + DAY }]);
    const res = importHomeworkCode(local, code, 'merge', NOW);
    expect(res.added).toBe(1); // 只补 B
    expect(res.items).toHaveLength(2);
  });

  it('覆盖：以对方的为准', () => {
    const code = decodeHomeworkCode(encodeHomeworkCode(list, { now: NOW }));
    const local = normalizeHomework([{ title: '我自己的', dueAt: NOW + DAY }]);
    const res = importHomeworkCode(local, code, 'replace', NOW);
    expect(res.replaced).toBe(1);
    expect(res.items.map((x) => x.title).sort()).toEqual(['A', 'B']);
  });

  it('乱码就报「不像是作业码」', () => {
    expect(() => decodeHomeworkCode('HW1.@@@')).toThrow('不像是作业码');
    expect(() => decodeHomeworkCode('')).toThrow('空的');
  });
});

describe('提醒', () => {
  it('未交的课按三档各排一条，已交/已过期的不排', () => {
    const list = normalizeHomework([
      { title: 'A', dueAt: NOW + 2 * DAY },
      { title: 'B', dueAt: NOW + 3 * DAY, doneAt: NOW },
      { title: 'C', dueAt: NOW - DAY },
    ]);
    const settings = normalizeSettings({
      remind: { prev: true, sameDay: true, soon: true, prevHour: 20, sameDayHour: 8, soonHours: 2 },
    });
    const reminders = homeworkReminders(list, settings, NOW);
    // A 有 3 条（前一天 20:00 / 当天 08:00 / 到期前 2 小时），B、C 一条没有
    expect(reminders).toHaveLength(3);
    expect(reminders.every((r) => r.body.includes('A'))).toBe(true);
    expect(reminders.map((r) => r.at)).toEqual([...reminders.map((r) => r.at)].sort((a, b) => a - b));
  });

  it('关掉的档不会排', () => {
    const list = normalizeHomework([{ title: 'A', dueAt: NOW + 2 * DAY }]);
    const settings = normalizeSettings({ remind: { prev: false, sameDay: false, soon: true, soonHours: 5 } });
    const reminders = homeworkReminders(list, settings, NOW);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.at).toBe(NOW + 2 * DAY - 5 * HOUR);
  });

  it('开了每周汇总会多一条', () => {
    const list = normalizeHomework([{ title: 'A', dueAt: NOW + 2 * DAY }]);
    const settings = normalizeSettings({ remind: { prev: true, sameDay: true, soon: true, summaryWeekday: 0, summaryHour: 21 } });
    const reminders = homeworkReminders(list, settings, NOW);
    expect(reminders.some((r) => r.title === '本周作业汇总')).toBe(true);
  });
});

describe('存取', () => {
  it('存进去再读出来，形状一致；坏数据不炸', async () => {
    const mem = new Map<string, unknown>();
    const kv = {
      get: async <T,>(k: string) => mem.get(k) as T | undefined,
      set: async (k: string, v: unknown) => void mem.set(k, v),
    };
    const saved = await saveHomework([item()], kv as never);
    expect(saved).toHaveLength(1);
    const loaded = await loadHomework(kv as never);
    expect(loaded[0]!.title).toBe('习题册 3.1');

    mem.set('homework', { v: 1, items: 'broken' });
    expect(await loadHomework(kv as never)).toEqual([]);

    await saveHomeworkSettings(normalizeSettings({ remind: { prevHour: 7 } }), kv as never);
    const settings = await loadHomeworkSettings(kv as never);
    expect(settings.remind.prevHour).toBe(7);
    expect(settings.remind.sameDayHour).toBe(8);
  });
});
