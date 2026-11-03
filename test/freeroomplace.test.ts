import { describe, expect, it } from 'vitest';
import { findFreeRoom } from '../src/core/tools';
import type { CampusService } from '../src/core/services';
import type { FreeRoom } from '../src/core/types';

/**
 * 真机回归：LLM 听到「南核空教室」时会顺手补一个 campus:'南校区'。
 * 服务端一旦先按南校区取教室，再按南1–5 前缀筛，结果必然 0 间，
 * 并且会把「那一片今天共有 N 间空教室」当成解释甩出来（用户看到的就是 0 间）。
 * 规则：给了地点词（building）就以地点词为准，campus 让位。
 */

function room(name: string, campus = '主校区'): FreeRoom {
  return {
    room: { id: name, name, campus, seats: 60 },
    freeSections: [5, 6, 7, 8],
    windows: [{ start: 840, end: 1080 }],
    longestMin: 240,
  };
}

function stub(): { svc: CampusService; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const svc = {
    campuses: async () => [
      { id: '2', name: '主校区' },
      { id: '3', name: '南校区' },
    ],
    freeRooms: async (opts: Record<string, unknown>) => {
      calls.push(opts);
      return [room('南4_101'), room('南2_204'), room('南区21_509', '南校区')];
    },
  } as unknown as CampusService;
  return { svc, calls };
}

describe('find_free_room 的地点词优先于校区', () => {
  it('同时给 building 和 campus 时不按校区取教室', async () => {
    const { svc, calls } = stub();
    const got = await findFreeRoom.run({ building: '南核', campus: '南校区' }, svc);
    expect(calls[0]?.campusId).toBeUndefined();
    expect(got.data?.count).toBe(2);
    expect(got.text).toContain('南4_101');
    expect(got.text).toContain('南核心教学区（南1–南5）');
  });

  it('只给校区时仍然按校区取教室', async () => {
    const { svc, calls } = stub();
    await findFreeRoom.run({ campus: '南校区' }, svc);
    expect(calls[0]?.campusId).toBe('3');
  });
});
