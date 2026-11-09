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
