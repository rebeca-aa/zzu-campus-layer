import { describe, expect, it } from 'vitest';
import { countUnseen, withAllSeen, type NoticePrefs } from '../src/core/noticeStore';

function prefsOf(readIds: string[], seenIds: string[] = []): NoticePrefs {
  return { categories: [], keywords: [], readIds, seenIds, updatedAt: 0 };
}

describe('withAllSeen：点铃铛只消红点，不改已读', () => {
  it('把没见过的卡片记进 seenIds，readIds 一点不动', () => {
    const before = prefsOf([], []);
    const next = withAllSeen(before, [{ id: 'a' }, { id: 'b' }]);
    expect(next).not.toBeNull();
    expect(next!.seenIds).toEqual(['a', 'b']);
    expect(next!.readIds).toEqual([]);
    expect(next!.updatedAt).toBeGreaterThan(0);
  });

  it('已经见过的不会重复写', () => {
    const next = withAllSeen(prefsOf([], ['a']), [{ id: 'a' }, { id: 'b' }]);
    expect(next!.seenIds).toEqual(['a', 'b']);
  });

  it('全都见过 → 返回 null，不写存储', () => {
    expect(withAllSeen(prefsOf([], ['a', 'b']), [{ id: 'a' }, { id: 'b' }])).toBeNull();
  });

  it('同一批重复 id 只记一次，脏数据跳过', () => {
    const next = withAllSeen(prefsOf([], []), [{ id: 'a' }, { id: 'a' }, { id: '' }, {} as { id: string }]);
    expect(next!.seenIds).toEqual(['a']);
  });

  it('不改动入参', () => {
    const before = prefsOf([], []);
    withAllSeen(before, [{ id: 'a' }]);
    expect(before.seenIds).toEqual([]);
  });

  it('超过 1000 条只留最近 1000 条', () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ id: `n${i}` }));
    const next = withAllSeen(prefsOf([], []), many);
    expect(next!.seenIds).toHaveLength(1000);
    expect(next!.seenIds[999]).toBe('n1199');
  });
});

describe('countUnseen：红点只数「没见过的」', () => {
  it('未见过 = 全部', () => {
    expect(countUnseen(prefsOf([], []), [{ id: 'a' }, { id: 'b' }])).toBe(2);
  });

  it('点过铃铛之后归零，但那些卡片仍是未读', () => {
    const prefs = prefsOf([], ['a', 'b']);
    expect(countUnseen(prefs, [{ id: 'a' }, { id: 'b' }])).toBe(0);
    expect(prefs.readIds).toEqual([]);
  });

  it('来了新通知 → 只数新的那几条', () => {
    expect(countUnseen(prefsOf([], ['a', 'b']), [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(1);
  });

  it('已读但没见过（比如别处读过）仍计入红点', () => {
    expect(countUnseen(prefsOf(['a'], []), [{ id: 'a' }])).toBe(1);
  });

  it('脏数据不计数', () => {
    expect(countUnseen(prefsOf([], []), [{ id: '' }, {} as { id: string }])).toBe(0);
  });
});
