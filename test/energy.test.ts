import { describe, expect, it } from 'vitest';
import {
  discoverRoom,
  ecardToken,
  fetchPlaces,
  HISTORY_LIMIT,
  levelOf,
  locationQuery,
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

describe('ecardToken', () => {
  it('跟随跳转后从最终 URL 里取 tid（浏览器里读不到 Location 头）', async () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.redirect ?? ''} ${url}`);
      if (url.includes('/server/auth/host/open')) {
        const res = new Response('', { status: 200 });
        Object.defineProperty(res, 'url', {
          value: 'https://ecard.v.zzu.edu.cn/h5/index.html?tid=TID-9#/',
        });
        return res;
      }
      return new Response(JSON.stringify({ resultData: { accessToken: 'ACC-9' } }));
    }) as typeof fetch;
    try {
      await expect(ecardToken('tok-url-1')).resolves.toBe('ACC-9');
      expect(seen.some((s) => s.startsWith('follow '))).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('既没有跳转也没有 tid 就报「没认登录态」', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('login page', { status: 200 })) as typeof fetch;
    try {
      await expect(ecardToken('tok-url-2')).rejects.toThrow('一卡通没认这个登录态');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('浏览器跨域被拦时说人话，不是干巴巴的 Failed to fetch', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    try {
      await expect(ecardToken('tok-cors-1')).rejects.toThrow('浏览器不让网页直接访问一卡通');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('discoverRoom', () => {
  const stub = (account: unknown) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/server/auth/host/open')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://ecard.v.zzu.edu.cn/h5/index.html?tid=TID-1#/' },
        });
      }
      if (url.includes('/server/auth/getToken')) {
        return new Response(JSON.stringify({ resultData: { accessToken: 'ACC-9' } }));
      }
      return new Response(JSON.stringify(account));
    }) as typeof fetch;
    return () => {
      globalThis.fetch = real;
    };
  };

  it('服务端带回房间号就用它', async () => {
    const restore = stub({ success: true, resultData: { location: { room: '99-1--1-101' } } });
    try {
      await expect(discoverRoom('cas-token')).resolves.toBe('99-1--1-101');
    } finally {
      restore();
    }
  });

  it('没带房间号就返回 undefined（让用户手填）', async () => {
    const restore = stub({ success: false, resultData: null });
    try {
      await expect(discoverRoom('cas-token')).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  it('走的是 config 接口（account 空着问是不认的）', async () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/server/auth/host/open')) {
        return new Response(null, { status: 302, headers: { location: 'https://x/h5/?tid=T' } });
      }
      if (url.includes('/server/auth/getToken')) {
        return new Response(JSON.stringify({ resultData: { accessToken: 'ACC' } }));
      }
      return new Response(JSON.stringify({ resultData: { location: { room: '99-1--1-101' } } }));
    }) as typeof fetch;
    try {
      await discoverRoom('cas-token');
      expect(seen.some((u) => u.includes('/server/utilities/config'))).toBe(true);
      expect(seen.some((u) => u.includes('/server/utilities/account'))).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('locationQuery', () => {
  it('按 id 里的横线数判断层级', () => {
    expect(locationQuery('')).toEqual({ locationType: 'bigArea', area: '', building: '', level: '' });
    expect(locationQuery('99')).toEqual({ locationType: 'building', area: '99', building: '', level: '' });
    expect(locationQuery('99-1')).toEqual({ locationType: 'unit', area: '99', building: '1', level: '' });
    expect(locationQuery('99-1--2')).toEqual({ locationType: 'room', area: '99', building: '1', level: '2' });
  });

  it('横线数不对就当非法', () => {
    expect(locationQuery('99-1-2')).toBeNull();
    expect(locationQuery('99-1--2-3-4')).toBeNull();
  });
});

describe('fetchPlaces', () => {
  it('把 locationList 洗成 {id,name}', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/server/auth/host/open')) {
        return new Response(null, { status: 302, headers: { location: 'https://x/h5/?tid=T' } });
      }
      if (url.includes('/server/auth/getToken')) {
        return new Response(JSON.stringify({ resultData: { accessToken: 'ACC' } }));
      }
      return new Response(
        JSON.stringify({
          resultData: {
            locationList: [
              { id: '99', name: '主校区' },
              { id: '', name: '脏数据' },
              { id: '98', name: '南校区' },
            ],
          },
        }),
      );
    }) as typeof fetch;
    try {
      await expect(fetchPlaces('cas-token', '')).resolves.toEqual([
        { id: '99', name: '主校区' },
        { id: '98', name: '南校区' },
      ]);
    } finally {
      globalThis.fetch = real;
    }
  });
});
