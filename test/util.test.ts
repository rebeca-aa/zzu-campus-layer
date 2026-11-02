import { describe, expect, it } from 'vitest';
import { compressWeeks, currentWeekOf, dateOfWeek, hhmm, hhmmss, parseDate, toHhmmInt, uniq, weekOfDate, weekdayOf } from '../src/core/util';

describe('时间工具', () => {
  it('把 HHmm 整数格式化成 HH:mm', () => {
    expect(hhmm(800)).toBe('08:00');
    expect(hhmm(1010)).toBe('10:10');
    expect(hhmm(0)).toBe('00:00');
  });

  it('截断秒', () => {
    expect(hhmmss('08:00:00')).toBe('08:00');
    expect(hhmmss('8:05')).toBe('08:05');
    expect(hhmmss('13:30:00')).toBe('13:30');
  });

  it('HH:mm 还原成整数', () => {
    expect(toHhmmInt('08:00')).toBe(800);
    expect(toHhmmInt('19:55')).toBe(1955);
  });
});

describe('教学周推算', () => {
  const termStart = '2026-09-07';

  it('首周周一就是第 1 周', () => {
    expect(weekOfDate(termStart, '2026-09-07')).toBe(1);
    expect(weekdayOf('2026-09-07')).toBe(1);
  });

  it('10-19 落在第 7 周（与教务 current-week 一致）', () => {
    expect(weekOfDate(termStart, '2026-10-19')).toBe(7);
    expect(weekdayOf('2026-10-19')).toBe(1);
  });

  it('周次与日期可互推', () => {
    expect(dateOfWeek(termStart, 7, 1)).toBe('2026-10-19');
    expect(dateOfWeek(termStart, 7, 7)).toBe('2026-10-25');
    expect(dateOfWeek(termStart, 1, 1)).toBe(termStart);
  });

  it('日期解析对星期天友好', () => {
    expect(weekdayOf('2026-10-25')).toBe(7);
    expect(parseDate('2026-10-19 08:00:00')).toBe(parseDate('2026-10-19'));
  });
});

describe('杂项', () => {
  it('uniq 去重排序并丢弃非法值', () => {
    expect(uniq([3, 1, 2, 3, undefined, null, 0])).toEqual([1, 2, 3]);
  });

  it('compressWeeks 压缩连续区间', () => {
    expect(compressWeeks([1, 2, 3, 5])).toBe('1-3,5');
    expect(compressWeeks([4, 6, 8])).toBe('4,6,8');
    expect(compressWeeks([])).toBe('');
  });
});

describe('现在是第几周', () => {
  const TERM = { startDate: '2026-09-07' };

  it('服务端给了 currentWeek 就用它', () => {
    expect(currentWeekOf({ ...TERM, currentWeek: 8 }, '2026-10-31')).toBe(8);
  });

  it('没给 currentWeek 就按首周周一推（不会一直停在第 1 周）', () => {
    expect(currentWeekOf(TERM, '2026-10-31')).toBe(weekOfDate(TERM.startDate, '2026-10-31'));
    expect(currentWeekOf(TERM, '2026-10-31')).toBeGreaterThan(1);
  });

  it('currentWeek 是 0 / 负数时也照样自己推', () => {
    expect(currentWeekOf({ ...TERM, currentWeek: 0 }, '2026-10-31')).toBe(weekOfDate(TERM.startDate, '2026-10-31'));
  });

  it('学期还没开始 / 什么都还没有时退回 1', () => {
    expect(currentWeekOf(TERM, '2026-08-01')).toBe(1);
    expect(currentWeekOf(null, '2026-10-31')).toBe(1);
    expect(currentWeekOf({}, '2026-10-31')).toBe(1);
  });
});
