import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PRESETS,
  DEFAULT_CUSTOM,
  applyCustomVars,
  contrast,
  customVars,
  derivePalette,
  ensureContrast,
  hexToRgb,
  hslToRgb,
  hueAt,
  normalizeCustom,
  parseThemeKey,
  rgbToHex,
} from '../src/core/theme';

/** 把 "rgba(1, 2, 3, .5)" 解成 [1,2,3] */
function channels(css: string): [number, number, number] {
  const inner = /rgba?\(([^)]+)\)/.exec(css)?.[1] ?? '';
  const [r, g, b] = inner.split(',').map((n) => Number(n.trim()));
  return [r ?? 0, g ?? 0, b ?? 0];
}
const asRgb = (css: string) => {
  const [r, g, b] = channels(css);
  return { r, g, b };
};

describe('theme 颜色工具', () => {
  it('hsl 转 rgb 再转 hex：红绿蓝都对', () => {
    expect(rgbToHex(hslToRgb(0, 100, 50))).toBe('#ff0000');
    expect(rgbToHex(hslToRgb(120, 100, 50))).toBe('#00ff00');
    expect(rgbToHex(hslToRgb(240, 100, 50))).toBe('#0000ff');
  });

  it('hexToRgb 只吃 6 位，带不带 # 都行', () => {
    expect(hexToRgb('#0e1a14')).toEqual({ r: 14, g: 26, b: 20 });
    expect(hexToRgb('0E1A14')).toEqual({ r: 14, g: 26, b: 20 });
    expect(hexToRgb('#abc')).toBeNull();
    expect(hexToRgb('nope')).toBeNull();
  });

  it('黑底白字的对比度是 21，同色是 1', () => {
    expect(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0);
    expect(contrast({ r: 90, g: 90, b: 90 }, { r: 90, g: 90, b: 90 })).toBeCloseTo(1, 5);
  });

  it('ensureContrast 会把太接近的前景推开', () => {
    const bg = { r: 30, g: 40, b: 34 };
    const faint = { r: 40, g: 50, b: 44 };
    const fixed = ensureContrast(faint, bg, 4.5);
    expect(contrast(fixed, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('theme 自定义参数', () => {
  it('缺字段补默认值', () => {
    expect(normalizeCustom({})).toEqual(DEFAULT_CUSTOM);
    expect(normalizeCustom(null)).toEqual(DEFAULT_CUSTOM);
  });

  it('越界的值夹回范围', () => {
    const c = normalizeCustom({ bgHue: 999, bgLevel: -20, panelAlpha: 0, radius: 99, scale: 500, shade: 900 });
    expect(c.bgHue).toBe(360);
    expect(c.bgLevel).toBe(0);
    expect(c.panelAlpha).toBe(40);
    expect(c.radius).toBe(24);
    expect(c.scale).toBe(115);
    expect(c.shade).toBe(100);
  });

  it('脏数据（字符串、NaN）当没填', () => {
    const c = normalizeCustom({ bgHue: '红', bgLevel: Number.NaN });
    expect(c.bgHue).toBe(DEFAULT_CUSTOM.bgHue);
    expect(c.bgLevel).toBe(DEFAULT_CUSTOM.bgLevel);
  });

  it('主题名认不出就当 ink', () => {
    expect(parseThemeKey('custom')).toBe('custom');
    expect(parseThemeKey('cream')).toBe('cream');
    expect(parseThemeKey('teal')).toBe('teal');
    expect(parseThemeKey('dark')).toBe('ink');
    expect(parseThemeKey(undefined)).toBe('ink');
  });

  it('三个预设都能直接用（配色合法、对比度够）', () => {
    for (const p of CUSTOM_PRESETS) {
      const vars = customVars(p.theme);
      expect(vars['--bg']).toMatch(/^#[0-9a-f]{6}$/);
      expect(vars['--accent']).toMatch(/^#[0-9a-f]{6}$/);
      const text = hexToRgb(vars['--text']!)!;
      expect(contrast(text, asRgb(vars['--panel']!))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('theme 配色推导', () => {
  it('深色底给浅字、浅色底给深字', () => {
    const dark = derivePalette({ ...DEFAULT_CUSTOM, bgLevel: 95 });
    expect(dark.dark).toBe(true);
    const light = derivePalette({ ...DEFAULT_CUSTOM, bgLevel: 5 });
    expect(light.dark).toBe(false);
    expect(contrast(hexToRgb(light.text)!, hexToRgb(light.bg)!)).toBeGreaterThan(4.5);
  });

  it('不管底色怎么滑，正文和面板的对比度都够（≥ 4.5）', () => {
    for (const level of [0, 20, 40, 55, 70, 88, 100]) {
      const p = derivePalette({ ...DEFAULT_CUSTOM, bgLevel: level });
      expect(contrast(hexToRgb(p.text)!, asRgb(p.panel))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hexToRgb(p.accent)!, hexToRgb(p.bg)!)).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('面板透明度写进 rgba，深浅影响面板和背景的距离', () => {
    const flat = derivePalette({ ...DEFAULT_CUSTOM, shade: 0, panelAlpha: 100 });
    const lift = derivePalette({ ...DEFAULT_CUSTOM, shade: 100, panelAlpha: 100 });
    expect(flat.panel).toMatch(/^rgba\(/);
    const dist = (panel: string) => Math.abs(channels(panel)[0] - hexToRgb(flat.bg)!.r);
    expect(dist(lift.panel)).toBeGreaterThan(dist(flat.panel));
    expect(derivePalette({ ...DEFAULT_CUSTOM, panelAlpha: 60 }).panel).toContain(', 0.6)');
  });

  it('圆角和字号原样带出', () => {
    const p = derivePalette({ ...DEFAULT_CUSTOM, radius: 20, scale: 110 });
    expect(p.radius).toBe('20px');
    expect(p.scale).toBe('110%');
    expect(customVars({ ...DEFAULT_CUSTOM, radius: 20 })['--radius']).toBe('20px');
  });

  it('applyCustomVars 写变量，传 null 时清空', () => {
    const style = new Map<string, string>();
    const el = {
      style: {
        setProperty: (k: string, v: string) => style.set(k, v),
        removeProperty: (k: string) => style.delete(k),
      },
    } as unknown as HTMLElement;
    applyCustomVars(DEFAULT_CUSTOM, el);
    expect(style.get('--accent')).toMatch(/^#[0-9a-f]{6}$/);
    expect(style.get('color-scheme')).toBe('dark');
    applyCustomVars(null, el);
    expect(style.size).toBe(0);
  });

  it('hueAt 给滑杆圆点上色，同色相浅底更深', () => {
    const deep = hueAt(200, 80);
    const pale = hueAt(200, 10);
    expect(deep).toMatch(/^#[0-9a-f]{6}$/);
    const lum = (hex: string) => {
      const c = hexToRgb(hex)!;
      return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    };
    expect(lum(pale)).toBeGreaterThan(lum(deep));
  });
});
