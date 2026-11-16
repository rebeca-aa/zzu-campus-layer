import { describe, expect, it } from 'vitest';
import { addMemo, normalizeMemos, removeMemo, updateMemo } from '../src/core/memo';

const one = (text: string, ts: number, id = 'a') => ({ id, text, createdAt: ts, updatedAt: ts });

describe('normalizeMemos', () => {
  it('只留合法条目，脏数据不炸', () => {
    expect(normalizeMemos(null)).toEqual([]);
    expect(normalizeMemos('x')).toEqual([]);
    expect(
      normalizeMemos([one('记得交作业', 1), { text: '' }, { text: 3 }, null]),
    ).toEqual([one('记得交作业', 1)]);
  });

  it('重复 id、超长文本会被处理', () => {
    const list = normalizeMemos([
      { id: 'dup', text: 'a', createdAt: 1, updatedAt: 1 },
      { id: 'dup', text: 'b', createdAt: 2, updatedAt: 2 },
      { id: 'long', text: 'x'.repeat(2000), createdAt: 3, updatedAt: 3 },
    ]);
    expect(list).toHaveLength(2);
    expect(list[1]!.text.length).toBeLessThanOrEqual(1000);
  });
});

describe('add / update / remove', () => {
  it('新记录在最前面', () => {
    const list = addMemo([one('旧', 1)], '新', 2);
    expect(list.map((m) => m.text)).toEqual(['新', '旧']);
  });

  it('空文本不新增', () => {
    expect(addMemo([], '   ', 1)).toEqual([]);
  });

  it('改文本会更新 updatedAt；改成空等于删除', () => {
    const list = [one('旧', 1)];
    expect(updateMemo(list, 'a', '新', 5)[0]).toMatchObject({ text: '新', updatedAt: 5, createdAt: 1 });
    expect(updateMemo(list, 'a', '', 5)).toEqual([]);
  });

  it('删除按 id', () => {
    expect(removeMemo([one('a', 1, 'a'), one('b', 2, 'b')], 'a').map((m) => m.id)).toEqual(['b']);
  });
});

describe('提醒时间', () => {
  it('normalize 保留合法 remindAt，丢掉脏值', () => {
    const list = normalizeMemos([
      { id: 'a', text: '有提醒', createdAt: 1, updatedAt: 1, remindAt: 1700000000000 },
      { id: 'b', text: '脏提醒', createdAt: 2, updatedAt: 2, remindAt: 'tomorrow' },
      { id: 'c', text: '零提醒', createdAt: 3, updatedAt: 3, remindAt: 0 },
    ]);
    expect(list[0]!.remindAt).toBe(1700000000000);
    expect(list[1]!.remindAt).toBeUndefined();
    expect(list[2]!.remindAt).toBeUndefined();
  });

  it('新增可以带提醒，编辑可以改或清', () => {
    const withRemind = addMemo([], '交作业', 1, 1700000000000);
    expect(withRemind[0]!.remindAt).toBe(1700000000000);

    const changed = updateMemo(withRemind, withRemind[0]!.id, '交作业', 2, 1800000000000);
    expect(changed[0]!.remindAt).toBe(1800000000000);

    const cleared = updateMemo(changed, changed[0]!.id, '交作业', 3, null);
    expect(cleared[0]!.remindAt).toBeUndefined();
  });
});
