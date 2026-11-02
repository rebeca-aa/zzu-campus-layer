import { describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle, type TokenBundle } from '../src/core/kv';
import { DEFAULT_CUSTOM } from '../src/core/theme';

const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJpc3MiOiJjYXMuc3patW0ifQ', 'c2lnbmF0dXJl'].join('.');

const bundle = (extra: Partial<TokenBundle> = {}): TokenBundle => ({
  v: 1,
  jwxt: JWT,
  at: Date.now(),
  ...extra,
});

describe('导出码里的外观', () => {
  it('自定义配色能原样带过去', () => {
    const custom = { ...DEFAULT_CUSTOM, bgHue: 210, bgLevel: 20, accentHue: 300, radius: 20 };
    const back = decodeBundle(encodeBundle(bundle({ theme: { name: 'custom', custom } })));
    expect(back.theme?.name).toBe('custom');
    expect(back.theme?.custom?.bgHue).toBe(210);
    expect(back.theme?.custom?.radius).toBe(20);
  });

  it('内置主题只带名字，不带一坨用不上的数字', () => {
    const back = decodeBundle(encodeBundle(bundle({ theme: { name: 'teal' } })));
    expect(back.theme).toEqual({ name: 'teal' });
  });

  it('认不出的主题名就当没带（不炸）', () => {
    const code = encodeBundle(bundle({ theme: { name: 'neon' as never } }));
    expect(decodeBundle(code).theme).toBeUndefined();
  });

  it('自定义参数残缺时补默认值、越界夹回来', () => {
    const code = encodeBundle(
      bundle({ theme: { name: 'custom', custom: { bgHue: 999, radius: 1 } as never } }),
    );
    const custom = decodeBundle(code).theme?.custom;
    expect(custom?.bgHue).toBe(360);
    expect(custom?.radius).toBe(8);
    expect(custom?.panelAlpha).toBe(DEFAULT_CUSTOM.panelAlpha);
  });

  it('老版本导出的码（没有 theme 字段）照样能导', () => {
    const back = decodeBundle(encodeBundle(bundle()));
    expect(back.jwxt).toBe(JWT);
    expect(back.theme).toBeUndefined();
  });
});
