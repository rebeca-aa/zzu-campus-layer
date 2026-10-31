import { describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  levelOf,
  parseRoom,
  pickBalance,
  pickRoom,
  pushPoint,
  type EnergyPoint,
} from '../src/core/energy';

describe('parseRoom', () => {
  it('认 99-1--1-101 这种格式', () => {
    expect(parseRoom('99-1--1-101')).toEqual({ area: '99', building: '1', level: '1', room: '99-1--1-101' });
    expect(parseRoom(' 105-105--215-12001 ')).toEqual({ area: '105', building: '105', level: '215', room: '105-105--215-12001' });
  });

  it('格式不对返回 null', () => {
    for (const bad of ['', '99', '99-1', '99-1--1', '99--1-101', 'a-b--c-d']) {
      expect(parseRoom(bad)).toBeNull();
    }
  });
});

describe('pickBalance', () => {
  it('认常见的余额字段', () => {
    expect(pickBalance({ resultData: { surplus: 12.5 } })).toBe(12.5);
    expect(pickBalance({ resultData: { balance: '8.25' } })).toBe(8.25);
    expect(pickBalance({ resultData: { list: [{ room: 'x', remain: 3 }] } })).toBe(3);
  });

  it('嵌套深一点也能找到', () => {
    expect(pickBalance({ code: 0, resultData: { data: { electric: { quantity: 42 } } } })).toBe(42);
  });

  it('找不到或不合法时返回 undefined', () => {
    expect(pickBalance({})).toBeUndefined();
    expect(pickBalance(null)).toBeUndefined();
    expect(pickBalance({ resultData: { surplus: 'n/a' } })).toBeUndefined();
  });

  it('不会把 id 当余额', () => {
    expect(pickBalance({ resultData: { id: 12345, name: '101' } })).toBeUndefined();
  });
});

describe('pickRoom', () => {
  it('从 location.room 里取房间号', () => {
    expect(pickRoom({ resultData: { location: { room: '99-1--1-101' } } })).toBe('99-1--1-101');
  });

  it('没有合法房间号时返回 undefined', () => {
    expect(pickRoom({ resultData: { location: { room: '' } } })).toBeUndefined();
    expect(pickRoom({ resultData: {} })).toBeUndefined();
  });
});

describe('levelOf', () => {
  it('按阈值分档', () => {
    expect(levelOf(undefined)).toBe('none');
    expect(levelOf(5)).toBe('low');
    expect(levelOf(8)).toBe('low');
    expect(levelOf(9)).toBe('warn');
    expect(levelOf(20)).toBe('warn');
    expect(levelOf(21)).toBe('ok');
  });
});

describe('pushPoint', () => {
  const p = (d: string, light?: number): EnergyPoint => ({ d, ...(light === undefined ? {} : { light }) });

  it('同一天覆盖', () => {
    const list = pushPoint([p('2026-10-30', 10)], p('2026-10-30', 9));
    expect(list).toEqual([{ d: '2026-10-30', light: 9 }]);
  });

  it('乱序进来也按日期排好', () => {
    const list = pushPoint([p('2026-10-30', 10)], p('2026-10-28', 12));
    expect(list.map((x) => x.d)).toEqual(['2026-10-28', '2026-10-30']);
  });

  it('超过上限只留最近的', () => {
    let list: EnergyPoint[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      list = pushPoint(list, p(d, i));
    }
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[list.length - 1]!.light).toBe(HISTORY_LIMIT + 9);
  });
});
