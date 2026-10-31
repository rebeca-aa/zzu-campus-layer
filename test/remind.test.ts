import { describe, expect, it } from 'vitest';
import { LEAD_MIN, REMIND_DAYS, buildReminderBlocks } from '../src/core/remind';
import type { Course } from '../src/core/types';

function course(p: Partial<Course> & { name: string; weekday: number; startTime: string; endTime: string }): Course {
  const { name, weekday, startTime, endTime, ...rest } = p;
  return {
    key: name + startTime,
    teachers: [],
    weeks: [],
    source: 'jwxt',
    name,
    weekday,
    startTime,
    endTime,
    ...rest,
  } as Course;
}

// 2026-10-21 是周三
const WED = 3;
const NOW = new Date('2026-10-21T07:00:00+08:00');
const at = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00+08:00`).getTime();

describe('课前提醒', () => {
  it('提前量是 30 分钟', () => {
    expect(LEAD_MIN).toBe(30);
  });

  it('单节课提前 30 分钟，正文带时间、节次与教室', () => {
    const blocks = buildReminderBlocks(
      [
        course({
          name: '线性代数',
          weekday: WED,
          startTime: '10:10',
          endTime: '11:50',
          location: '材_606',
          sectionStart: 3,
          sectionEnd: 4,
        }),
      ],
      { days: 1, now: NOW },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.at).toBe(at('09:40'));
    expect(blocks[0]!.body).toContain('10:10-11:50');
    expect(blocks[0]!.body).toContain('第3-4节');
    expect(blocks[0]!.body).toContain('材_606');
  });

  it('上午连着上的两节课各弹一条（不再合并），时间分别是各自的前 30 分钟', () => {
    const blocks = buildReminderBlocks(
      [
        course({ name: '微积分A', weekday: WED, startTime: '08:00', endTime: '09:40', location: '物_505' }),
        course({ name: '大学英语', weekday: WED, startTime: '10:10', endTime: '11:50', location: '北3_403' }),
      ],
      { days: 1, now: NOW },
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.at).toBe(at('07:30'));
    expect(blocks[0]!.title).toContain('微积分A');
    expect(blocks[0]!.body).not.toContain('大学英语');
    expect(blocks[1]!.at).toBe(at('09:40'));
    expect(blocks[1]!.title).toContain('大学英语');
  });

  it('满课的一天：几节课就有几条，按时间排序且互不相同', () => {
    const blocks = buildReminderBlocks(
      [
        course({ name: '课A', weekday: WED, startTime: '08:00', endTime: '09:40' }),
        course({ name: '课B', weekday: WED, startTime: '10:10', endTime: '11:50' }),
        course({ name: '课C', weekday: WED, startTime: '14:00', endTime: '15:40' }),
        course({ name: '课D', weekday: WED, startTime: '16:00', endTime: '17:40' }),
        course({ name: '课E', weekday: WED, startTime: '19:00', endTime: '20:40' }),
      ],
      { now: NOW, days: 1 },
    );
    expect(blocks).toHaveLength(5);
    expect(blocks.map((b) => b.at)).toEqual([
      at('07:30'),
      at('09:40'),
      at('13:30'),
      at('15:30'),
      at('18:30'),
    ]);
    const titles = new Set(blocks.map((b) => b.title));
    expect(titles.size).toBe(5);
  });

  it('同一节课被两个源重复给出时只提醒一次', () => {
    const base = { name: '数据结构', weekday: WED, startTime: '14:00', endTime: '15:40' };
    const blocks = buildReminderBlocks(
      [
        course({ ...base, key: 'portal:1', source: 'portal' }),
        course({ ...base, key: 'jwxt:2', source: 'jwxt' }),
      ],
      { days: 1, now: NOW },
    );
    expect(blocks).toHaveLength(1);
  });

  it('已经过点的课不再提醒（9:00 时 8:00 的课没有，10:10 的课还在）', () => {
    const blocks = buildReminderBlocks(
      [
        course({ name: '早课', weekday: WED, startTime: '08:00', endTime: '09:40' }),
        course({ name: '第二节', weekday: WED, startTime: '10:10', endTime: '11:50' }),
      ],
      { days: 1, now: new Date('2026-10-21T09:00:00+08:00') },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.title).toContain('第二节');
  });

  it('按教学周过滤：只在本周的课才排提醒', () => {
    const courses = [
      course({ name: '单周课', weekday: WED, startTime: '14:00', endTime: '15:40', weeks: [7] }),
      course({ name: '双周课', weekday: WED, startTime: '16:00', endTime: '17:40', weeks: [8] }),
    ];
    const blocks = buildReminderBlocks(courses, { now: NOW, termStart: '2026-09-07', days: 1 });
    const text = blocks.map((b) => `${b.title} ${b.body}`).join('|');
    expect(text).toContain('单周课');
    expect(text).not.toContain('双周课');
  });

  it('跨多天：每天每节课各一条，不因日期相邻而合并', () => {
    const c = [course({ name: '同一门课', weekday: WED, startTime: '08:00', endTime: '09:40' })];
    // 紧邻的两天都有这门课（周三=WED，周四=4）
    const two = buildReminderBlocks(
      [c[0]!, course({ ...c[0]!, key: 'thu', weekday: 4 })],
      { now: NOW, days: 2 },
    );
    expect(two).toHaveLength(2);
    expect(two[0]!.at).toBe(at('07:30'));
    expect(two[1]!.at).toBe(new Date('2026-10-22T07:30:00+08:00').getTime());
  });

  it('晚开 App 也不会漏：已经进了 30 分钟窗口就立刻补一条，标题说实话', () => {
    // 07:50 才打开，08:00 的课（正常提醒点 07:30 已过）
    const late = new Date('2026-10-21T07:50:00+08:00');
    const blocks = buildReminderBlocks(
      [course({ name: '早课', weekday: WED, startTime: '08:00', endTime: '09:40' })],
      { now: late, days: 1 },
    );
    expect(blocks).toHaveLength(1);
    /* 立刻补（5 秒后），而不是丢掉 */
    expect(blocks[0]!.at).toBe(late.getTime() + 5_000);
    expect(blocks[0]!.title).toContain('10 分钟后');
    expect(blocks[0]!.title).toContain('早课');
  });

  it('已经开课的仍然不补（08:05 时 08:00 的课没有）', () => {
    const blocks = buildReminderBlocks(
      [course({ name: '早课', weekday: WED, startTime: '08:00', endTime: '09:40' })],
      { now: new Date('2026-10-21T08:05:00+08:00'), days: 1 },
    );
    expect(blocks).toHaveLength(0);
  });

  it('正常提前量下标题还是「半小时后」', () => {
    const blocks = buildReminderBlocks(
      [course({ name: '早课', weekday: WED, startTime: '08:00', endTime: '09:40' })],
      { now: NOW, days: 1 },
    );
    expect(blocks[0]!.title).toBe('半小时后：早课');
  });

  it('默认往后排 14 天：一周以上没打开 App 也接得上', () => {
    expect(REMIND_DAYS).toBe(14);
    const blocks = buildReminderBlocks(
      [course({ name: '周课', weekday: WED, startTime: '08:00', endTime: '09:40' })],
      { now: NOW },
    );
    // 14 天里含两个周三（10-21、10-28）
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.at).toBe(new Date('2026-10-28T07:30:00+08:00').getTime());
  });
});
