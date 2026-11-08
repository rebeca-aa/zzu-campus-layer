/**
 * 第四套配色：自定义。
 *
 * 前三套（米白 / 藏青 / 蓝绿）是写死的 CSS 变量；自定义这层只让用户挑「色相 + 明度」，
 * 其余（面板、描边、次要文字、链接、气泡）都按固定比例从底色推出来 —— 只留一个调色盘，
 * 免得出现「某个角落的颜色不跟手」。所有函数都是纯的，方便单测。
 */

export type ThemeKey = 'cream' | 'ink' | 'teal' | 'pink' | 'custom';

export const THEME_KEYS: ThemeKey[] = ['cream', 'ink', 'teal', 'pink', 'custom'];

export const CUSTOM_KEY = 'themeCustom';

export interface CustomTheme {
  /** 背景色相 0–360（红→紫转一圈） */
  bgHue: number;
  /** 背景明度 0（白）–100（黑） */
  bgLevel: number;
  /** 文字色相 0–360；明度由对比度自动定，不用用户操心 */
  textHue: number;
  /** 强调色色相 0–360 */
  accentHue: number;
  /** 面板相对背景浮起多少 0–100 */
  shade: number;
  /** 面板透明度 40–100（配合毛玻璃） */
  panelAlpha: number;
  /** 圆角 8–24px */
  radius: number;
  /** 字号 90–115% */
  scale: number;
}

export const DEFAULT_CUSTOM: CustomTheme = {
  bgHue: 145,
  bgLevel: 88,
  textHue: 145,
  accentHue: 32,
  shade: 62,
  panelAlpha: 86,
  radius: 14,
  scale: 100,
};

export interface CustomPreset {
  id: string;
  name: string;
  theme: CustomTheme;
}

/** 三个预设：先套一个，再微调。 */
export const CUSTOM_PRESETS: CustomPreset[] = [
  {
    id: 'green',
    name: '墨绿',
    theme: { ...DEFAULT_CUSTOM, bgHue: 150, bgLevel: 88, textHue: 150, accentHue: 34, shade: 60 },
  },
  {
    id: 'warm',
    name: '暖棕',
    theme: { ...DEFAULT_CUSTOM, bgHue: 26, bgLevel: 90, textHue: 32, accentHue: 12, shade: 55 },
  },
  {
    id: 'violet',
    name: '紫夜',
    theme: { ...DEFAULT_CUSTOM, bgHue: 258, bgLevel: 90, textHue: 250, accentHue: 285, shade: 58 },
  },
];

/** 色相线用的几个停靠点（红→紫），UI 和文档都引用它。 */
export const HUE_STOPS = [
  { at: 0, hex: '#e5484d' },
  { at: 17, hex: '#f5872b' },
  { at: 32, hex: '#f5d90a' },
  { at: 49, hex: '#46a758' },
  { at: 61, hex: '#12a594' },
  { at: 77, hex: '#3e63dd' },
  { at: 100, hex: '#8e4ec6' },
] as const;

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** h: 0–360, s: 0–100, l: 0–100 */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp(s, 0, 100) / 100;
  const ll = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  const seg = Math.floor(hh / 60) % 6;
  const pairs: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = pairs[seg] ?? [0, 0, 0];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const hex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1);
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function channel(n: number): number {
  const v = n / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgb): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 对比度，1–21。 */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 把前景往「更亮」或「更暗」推，直到对比度够。
 *
 * 关键是先挑方向：底色偏暗就往白推、偏亮就往黑推；中间那段两头都够不着的，
 * 走完全程取最好的那个，实在不行给纯黑/纯白 —— 宁可难看，也不给看不清。
 */
export function ensureContrast(fg: Rgb, bg: Rgb, target = 4.5): Rgb {
  if (contrast(fg, bg) >= target) return fg;
  const pole = contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK;
  let best = fg;
  let bestRatio = contrast(fg, bg);
  for (let i = 1; i <= 10; i += 1) {
    const cand = mix(fg, pole, i / 10);
    const ratio = contrast(cand, bg);
    if (ratio > bestRatio) {
      best = cand;
      bestRatio = ratio;
    }
    if (ratio >= target) return cand;
  }
  if (contrast(pole, bg) > bestRatio) return pole;
  return best;
}

export function normalizeCustom(raw: unknown): CustomTheme {
  const o = (raw ?? {}) as Partial<Record<keyof CustomTheme, unknown>>;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    bgHue: clamp(num(o.bgHue, DEFAULT_CUSTOM.bgHue), 0, 360),
    bgLevel: clamp(num(o.bgLevel, DEFAULT_CUSTOM.bgLevel), 0, 100),
    textHue: clamp(num(o.textHue, DEFAULT_CUSTOM.textHue), 0, 360),
    accentHue: clamp(num(o.accentHue, DEFAULT_CUSTOM.accentHue), 0, 360),
    shade: clamp(num(o.shade, DEFAULT_CUSTOM.shade), 0, 100),
    panelAlpha: clamp(num(o.panelAlpha, DEFAULT_CUSTOM.panelAlpha), 40, 100),
    radius: clamp(num(o.radius, DEFAULT_CUSTOM.radius), 8, 24),
    scale: clamp(num(o.scale, DEFAULT_CUSTOM.scale), 90, 115),
  };
}

export function parseThemeKey(raw: unknown): ThemeKey {
  return raw === 'cream' || raw === 'teal' || raw === 'pink' || raw === 'custom' ? raw : 'ink';
}

/** 按 HTML 里那套变量名给出配色；全部是合法 CSS 值。 */
export interface Palette {
  bg: string;
  panel: string;
  text: string;
  dim: string;
  hairline: string;
  accent: string;
  link: string;
  placeholder: string;
  selfBubble: string;
  selfBubbleText: string;
  headerLine: string;
  shade: string;
  radius: string;
  scale: string;
  dark: boolean;
}

export function derivePalette(c: CustomTheme): Palette {
  const t = normalizeCustom(c);
  // 背景：0 → 近白，100 → 近黑
  const bgL = 97 - t.bgLevel * 0.85;
  const dark = bgL < 55;
  const bg = hslToRgb(t.bgHue, dark ? 26 : 34, bgL);

  // 面板：往「更亮」或「更暗」推一点，推多少由 shade 决定
  const lift = (t.shade / 100) * (dark ? 0.3 : 0.1);
  const panelSolid = mix(bg, dark ? WHITE : WHITE, lift);
  const panelAlpha = t.panelAlpha / 100;
  const panel = dark || panelAlpha < 100 ? panelSolid : panelSolid;

  // 文字：色相听用户的，明度由底色决定
  const textBase = hslToRgb(t.textHue, 16, dark ? 93 : 18);
  const text = ensureContrast(textBase, panel, 7);
  const dimBase = hslToRgb(t.textHue, 12, dark ? 64 : 42);
  const dim = ensureContrast(dimBase, panel, 3.2);

  const hairline = rgbToHex(mix(panelSolid, dark ? WHITE : BLACK, dark ? 0.1 : 0.12));
  // 强调色先按「深底偏亮、浅底偏深」给一版，再和底色拉开到至少 3:1，
  // 免得用户把色相调到跟底色一个颜色、按钮直接看不见
  const accent = ensureContrast(hslToRgb(t.accentHue, 64, dark ? 62 : 44), bg, 3);
  const link = rgbToHex(mix(accent, dark ? WHITE : BLACK, dark ? 0.22 : 0.1));
  const placeholder = rgbToHex(mix(panelSolid, text, 0.45));
  const onAccent = contrast(WHITE, accent) >= 3.6 ? WHITE : BLACK;

  return {
    bg: rgbToHex(bg),
    panel: `rgba(${Math.round(panelSolid.r)}, ${Math.round(panelSolid.g)}, ${Math.round(panelSolid.b)}, ${round(panelAlpha, 2)})`,
    text: rgbToHex(text),
    dim: rgbToHex(dim),
    hairline: `#${hairline.slice(1)}`,
    accent: rgbToHex(accent),
    link,
    placeholder,
    selfBubble: rgbToHex(accent),
    selfBubbleText: rgbToHex(onAccent),
    headerLine: hairline,
    shade: rgbToHex(mix(bg, dark ? BLACK : WHITE, dark ? 0.18 : 0.04)),
    radius: `${round(t.radius)}px`,
    scale: `${round(t.scale)}%`,
    dark,
  };
}

/** 转成可以直接 setProperty 的一组变量。 */
export function customVars(c: CustomTheme): Record<string, string> {
  const p = derivePalette(c);
  return {
    '--bg': p.bg,
    '--panel': p.panel,
    '--text': p.text,
    '--dim': p.dim,
    '--line': p.hairline,
    '--hairline': p.hairline,
    '--accent': p.accent,
    '--link': p.link,
    '--placeholder': p.placeholder,
    '--self-bubble': p.selfBubble,
    '--self-bubble-text': p.selfBubbleText,
    '--header-line': p.headerLine,
    '--shade': p.shade,
    '--radius': p.radius,
  };
}

export const CUSTOM_VAR_NAMES = Object.keys(customVars(DEFAULT_CUSTOM));

/** 浏览器里把变量挂到 <html>；离开自定义时清掉。 */
export function applyCustomVars(theme: CustomTheme | null, root?: HTMLElement): void {
  const el = root ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  if (!el) return;
  for (const name of CUSTOM_VAR_NAMES) el.style.removeProperty(name);
  if (!theme) {
    el.style.removeProperty('color-scheme');
    return;
  }
  const vars = customVars(theme);
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
  el.style.setProperty('color-scheme', derivePalette(theme).dark ? 'dark' : 'light');
}

/** 色相线的位置（0–100）→ 该处颜色，给滑杆的小圆点用。 */
export function hueAt(hue: number, level: number, sat = 62): string {
  return rgbToHex(hslToRgb(hue, sat, 100 - level * 0.8));
}
