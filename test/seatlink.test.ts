import { describe, expect, it } from 'vitest';
import { openService } from '../src/core/tools';
import { PORTAL_SERVICES } from '../src/core/catalog';

/*
 * 座位预约不给链接：那个站的网页登录在 App 里走不通（点了也登不上），
 * 所以 AI 不许再甩链接，只能告诉用户去「我的 → 图书馆登录」。
 * 这条测试就是防回归：哪天有人把 url 加回去，这里会红。
 */
describe('座位预约不再甩链接', () => {
  it('open_service 对座位预约只给设置面板提示，不返回 url', async () => {
    const got = await openService.run({ keyword: '座位预约' }, undefined as never);

    expect(got.data?.url).toBeUndefined();
    expect(got.data).toMatchObject({ noLink: true, name: '座位预约' });
    expect(got.text).toContain('我的 → 图书馆登录');
    expect(got.text).not.toContain('order.lib.zzu.edu.cn');
  });

  it('其他服务照旧给链接（别误伤）', async () => {
    const got = await openService.run({ keyword: '报修' }, undefined as never);

    expect(got.data?.url).toMatch(/^https?:\/\//);
    expect(got.data?.noLink).toBeUndefined();
  });

  it('目录里只有座位预约标了 noLink', () => {
    const noLink = PORTAL_SERVICES.filter((s) => s.noLink).map((s) => s.name);
    expect(noLink).toEqual(['座位预约']);
  });
});
