/**
 * 主页课表下面的「自定义栏」。
 *
 * 每一栏是一条长条：左边是用户自己起的标题和一段要发给 AI 的话。
 * 点长条 → 跳到 AI 栏并把这段话直接发出去；
 * 板块右上角只有一个小「+」，点开设置窗统一增删改所有栏。
 *
 * 还有一条特殊的长条：一卡通余额。它不走会话，点一下直接刷新余额，
 * 在设置窗里用开关控制显不显示。
 *
 * 和「常用语」(`quickAsk.ts`) 是两套东西：常用语是输入框上面的小药丸、一句话直接发；
 * 这里是主页上的长条、文案可以写长一点。所以单独一个存储键，互不干扰。
 */
import { getKV, type KV } from './kv';

export interface HomeBar {
  /** 稳定 id：编辑、删除都靠它，改文案不会认错 */
  id: string;
  /** chat=点一下把 text 发出去；card=一卡通余额条，点一下刷新余额 */
  kind?: 'chat' | 'card';
  /** 长条上的标题（留空时退回文本第一句） */
  label: string;
  /** 点下去要发给 AI 的那段话；一卡通栏不用 */
  text: string;
  /** 出厂自带的那几条：主页上排成 2x2 的小块，用户自己加的仍是整行长条 */
  builtin?: boolean;
}

export const HOME_BARS_KEY = 'homeBars';

/** 存储版本：2 起带一卡通栏，老数据读进来顺手补上默认栏 */
export const HOME_BARS_VERSION = 2;

/** 主页就这么点地方，6 条到头；再多就成列表页了 */
export const MAX_HOME_BARS = 6;
/** 标题上限：长条只有一行，再长也显示不全 */
export const MAX_HOME_BAR_LABEL = 24;
/** 正文上限：发给 AI 的一段话，不是作文 */
export const MAX_HOME_BAR_TEXT = 240;

/** 一卡通栏的固定 id：开关、渲染都认它，用户改不了 */
export const CARD_HOME_BAR_ID = 'card';
export const CARD_HOME_BAR_LABEL = '校园卡';

/** 第一次打开就自带的两条 */
export const DEFAULT_HOME_BAR_TEXT: ReadonlyArray<{ label: string; text: string }> = [
  { label: '图书馆', text: '今天图书馆一楼空余座位图' },
  { label: '空教室', text: '南核空教室' },
];

let seq = 0;

/** 时间戳 + 序号 + 随机尾，不依赖 crypto.randomUUID（老 WebView 没有） */
function newHomeBarId(): string {
  seq = (seq + 1) % 1000;
  return `hb${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 是不是一卡通那条（不吃会话、直接查余额） */
export function isCardBar(bar: HomeBar): boolean {
  return bar.kind === 'card';
}

export function createCardBar(): HomeBar {
  return { id: CARD_HOME_BAR_ID, kind: 'card', label: CARD_HOME_BAR_LABEL, text: '', builtin: true };
}

const DEFAULT_TEXTS = new Set(DEFAULT_HOME_BAR_TEXT.map((d) => d.text));

/** 出厂自带的栏（图书馆 / 空教室 / 校园卡）：主页上按 2x2 排 */
export function isBuiltinBar(bar: HomeBar): boolean {
  return bar.builtin === true || isCardBar(bar) || DEFAULT_TEXTS.has(bar.text);
}

/** 全新安装时的三条：图书馆、空教室、一卡通 */
export function defaultHomeBars(): HomeBar[] {
  const bars = DEFAULT_HOME_BAR_TEXT.map((item) => ({ id: newHomeBarId(), label: item.label, text: item.text, builtin: true }));
  return [...bars, createCardBar()];
}

/** 老数据 / 缺默认栏时补齐：默认两条（已有同文案就跳过）+ 一卡通，最多 6 条且一卡通永远在最后 */
export function withDefaultHomeBars(items: HomeBar[]): HomeBar[] {
  const chat = items.filter((bar) => !isCardBar(bar)).slice(0, MAX_HOME_BARS - 1);
  for (const def of DEFAULT_HOME_BAR_TEXT) {
    if (chat.some((bar) => bar.text === def.text)) continue;
    if (chat.length >= MAX_HOME_BARS - 1) break;
    chat.push({ id: newHomeBarId(), label: def.label, text: def.text, builtin: true });
  }
  return [...chat, createCardBar()];
}

/** 设置窗里的「一卡通」开关：开了就补到末尾，关了就拿掉 */
export function setCardBarVisible(items: HomeBar[], visible: boolean): HomeBar[] {
  const rest = items.filter((bar) => !isCardBar(bar));
  if (!visible) return rest;
  if (rest.length >= MAX_HOME_BARS) return rest;
  return [...rest, createCardBar()];
}

/**
 * 把存储里读到的东西洗成合法列表。
 * 返回 `undefined` 表示这份数据没法用（调用方回落成默认列表）；空数组是合法结果。
 */
export function normalizeHomeBars(raw: unknown): HomeBar[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HomeBar[] = [];
  const seen = new Set<string>();
  let hasCard = false;
  for (const entry of raw) {
    let label = '';
    let text = '';
    let id = '';
    let builtin = false;
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      if (o.kind === 'card') {
        if (hasCard) continue;
        hasCard = true;
        label = oneLine(typeof o.label === 'string' ? o.label : '').slice(0, MAX_HOME_BAR_LABEL) || CARD_HOME_BAR_LABEL;
        out.push({ id: typeof o.id === 'string' && o.id ? o.id : CARD_HOME_BAR_ID, kind: 'card', label, text: '', builtin: true });
        if (out.length >= MAX_HOME_BARS) break;
        continue;
      }
    }
    if (typeof entry === 'string') {
      label = entry;
      text = entry;
    } else if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      const rawText = typeof o.text === 'string' ? o.text : typeof o.prompt === 'string' ? o.prompt : '';
      const rawLabel =
        typeof o.label === 'string' ? o.label : typeof o.title === 'string' ? o.title : typeof o.name === 'string' ? o.name : '';
      text = rawText;
      label = rawLabel;
      if (typeof o.id === 'string') id = o.id;
      if (o.builtin === true) builtin = true;
      if (!text) text = label;
      if (!label) label = text;
    }
    text = oneLine(text).slice(0, MAX_HOME_BAR_TEXT);
    if (DEFAULT_TEXTS.has(text)) builtin = true;
    label = oneLine(label).slice(0, MAX_HOME_BAR_LABEL) || text.slice(0, MAX_HOME_BAR_LABEL);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ id: id || newHomeBarId(), label, text, ...(builtin ? { builtin: true } : {}) });
    if (out.length >= MAX_HOME_BARS) break;
  }
  return out;
}

/** 读列表：没存过 / 存坏了 → 默认三条；老版本存的数据补上默认栏。 */
export async function loadHomeBars(kv: KV = getKV()): Promise<HomeBar[]> {
  try {
    const stored = await kv.get<{ v?: number; items?: unknown }>(HOME_BARS_KEY);
    if (!stored || typeof stored !== 'object') return defaultHomeBars();
    const items = normalizeHomeBars((stored as { items?: unknown }).items);
    if (!items) return defaultHomeBars();
    const version = (stored as { v?: unknown }).v;
    if (typeof version === 'number' && version >= HOME_BARS_VERSION) return items;
    return withDefaultHomeBars(items);
  } catch {
    return defaultHomeBars();
  }
}

/** 写列表：先洗干净再落盘，返回值就是真正存下去的版本。 */
export async function saveHomeBars(items: HomeBar[], kv: KV = getKV()): Promise<HomeBar[]> {
  const clean = normalizeHomeBars(items) ?? [];
  await kv.set(HOME_BARS_KEY, { v: HOME_BARS_VERSION, items: clean });
  return clean;
}

/** 加一条。出错时抛中文原因，界面直接显示 message。 */
export function addHomeBar(items: HomeBar[], raw: string, label?: string): HomeBar[] {
  const text = oneLine(raw).slice(0, MAX_HOME_BAR_TEXT);
  if (!text) throw new Error('写点内容再保存');
  if (items.some((item) => !isCardBar(item) && item.text === text)) throw new Error('这句已经在里面了');
  if (items.length >= MAX_HOME_BARS) throw new Error(`最多 ${MAX_HOME_BARS} 条，先删一条再加`);
  const shown = oneLine(label ?? '').slice(0, MAX_HOME_BAR_LABEL) || text.slice(0, MAX_HOME_BAR_LABEL);
  return [...items, { id: newHomeBarId(), label: shown, text }];
}

/** 改一条（标题 / 正文）。空内容或和别的重复就抛错。 */
export function updateHomeBar(items: HomeBar[], id: string, patch: { label?: string; text?: string }): HomeBar[] {
  const at = items.findIndex((item) => item.id === id);
  if (at < 0) return items;
  const current = items[at]!;
  if (isCardBar(current)) return items;
  const text = oneLine(patch.text ?? current.text).slice(0, MAX_HOME_BAR_TEXT);
  if (!text) throw new Error('内容不能是空的');
  if (items.some((item) => item.id !== id && !isCardBar(item) && item.text === text)) throw new Error('这句已经在里面了');
  const label = oneLine(patch.label ?? current.label).slice(0, MAX_HOME_BAR_LABEL) || text.slice(0, MAX_HOME_BAR_LABEL);
  const next = items.slice();
  next[at] = { ...current, label, text };
  return next;
}

/** 删一条（按 id）。 */
export function removeHomeBar(items: HomeBar[], id: string): HomeBar[] {
  return items.filter((item) => item.id !== id);
}
