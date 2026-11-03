import { describe, expect, it } from 'vitest';
import { parseIntent } from '../src/core/intent';
import { renderFreeRooms } from '../src/core/render';
import { resolvePlace, roomInPlace, roomPrefix } from '../src/core/place';
import type { FreeRoom } from '../src/core/types';

const room = (name: string, free = [1, 2, 3, 4]): FreeRoom => ({
  room: { id: name, name, campus: '主校区' },
  freeSections: free,
});

describe('resolvePlace：口语地点 → 教室名前缀', () => {
  it('南核 / 南核心教学区 都指南1–南5（实网 2026-11-03：南4 确实有教室）', () => {
    for (const s of ['明天南核空教室', '南核心教学区有空吗', '南核心区']) {
      const p = resolvePlace(s);
      expect(p?.prefixes).toEqual(['南1', '南2', '南3', '南4', '南5']);
    }
  });

  it('南核 认得出南4、南6 这种后来的楼号', () => {
    const p = resolvePlace('南核空教室')!;
    expect(roomInPlace('南4_101', p)).toBe(true);
    expect(roomInPlace('南6_201', p)).toBe(true);
    expect(roomInPlace('南1_303', p)).toBe(true);
    expect(roomInPlace('南区21_509', p)).toBe(false);
    expect(roomInPlace('北1_101', p)).toBe(false);
  });

  it('北核 指北1–北5', () => {
    expect(resolvePlace('北核哪里能自习')?.prefixes).toEqual(['北1', '北2', '北3', '北4', '北5']);
  });

  it('核心教学区 = 南北都算', () => {
    const p = resolvePlace('核心教学区空教室');
    expect(p?.prefixes).toContain('南1');
    expect(p?.prefixes).toContain('北4');
  });

  it('具体馆与楼号也能认', () => {
    expect(resolvePlace('物理馆空教室')?.prefixes).toEqual(['物']);
    expect(resolvePlace('北1 有空吗')?.prefixes).toEqual(['北1']);
    expect(resolvePlace('南3 第几节空着')?.prefixes).toEqual(['南3']);
  });

  it('「南校区」不是楼号，别误判', () => {
    expect(resolvePlace('南校区的空教室')).toBeNull();
  });

  it('没有任何地点词时返回 null', () => {
    expect(resolvePlace('明天下午有空教室吗')).toBeNull();
  });
});

describe('roomInPlace：前缀匹配', () => {
  it('南1_303 在「南核」里，北区2_101 不在', () => {
    const south = resolvePlace('南核')!;
    expect(roomInPlace('南1_303', south)).toBe(true);
    expect(roomInPlace('南2_406', south)).toBe(true);
    expect(roomInPlace('南4_106', south)).toBe(true);
    expect(roomInPlace('北1_101', south)).toBe(false);
    expect(roomInPlace('北区2_101', south)).toBe(false);
  });

  it('北1 不会把北区2 或北10 算进来', () => {
    const b1 = resolvePlace('北1')!;
    expect(roomInPlace('北1_101', b1)).toBe(true);
    expect(roomInPlace('北区1_101', b1)).toBe(false);
    expect(roomInPlace('北10_101', b1)).toBe(false);
  });

  it('前缀从教室名里取到下划线/空格/括号前', () => {
    expect(roomPrefix('南1_303')).toBe('南1');
    expect(roomPrefix('北区2_101')).toBe('北区2');
    expect(roomPrefix('物_505')).toBe('物');
  });
});

describe('parseIntent：地点词要进 args', () => {
  it('「明天南核空教室」带 building=南核', () => {
    const got = parseIntent('明天南核空教室', '2026-10-21');
    expect(got?.tool).toBe('find_free_room');
    expect(got?.args.building).toBe('南核');
    expect(got?.args.date).toBe('2026-10-22');
  });

  it('「明天北1的空教室」带 building=北1', () => {
    const got = parseIntent('明天北1的空教室', '2026-10-21');
    expect(got?.args.building).toBe('北1');
  });

  it('没说地点时不加 building（否则会被误当过滤条件）', () => {
    const got = parseIntent('明天下午的空教室', '2026-10-21');
    expect(got?.args.building).toBeUndefined();
  });
});

describe('renderFreeRooms：地点上下文', () => {
  const south = [room('南1_101'), room('南2_202')];

  it('标题里回显地点', () => {
    const text = renderFreeRooms(south, { date: '2026-10-22', place: '南核心教学区（南1/南2/南3）' });
    expect(text).toContain('南核心教学区');
    expect(text).toContain('南1_101');
  });

  it('地点里没空教室时说清楚，并给出放宽建议', () => {
    const text = renderFreeRooms([], { date: '2026-10-22', place: '南核心教学区', placeTotal: 590 });
    expect(text).toContain('没找到空教室');
    expect(text).toContain('590');
    expect(text).toContain('放宽');
  });

  it('没有地点时保持原来的说法', () => {
    expect(renderFreeRooms([], { date: '2026-10-22' })).toBe('2026-10-22 没找到符合条件的空教室。');
  });
});
