/**
 * 主页课表下面的「自定义栏」。
 *
 * 每一栏是一条长条：左边是用户自己起的标题和一段要发给 AI 的话。
 * 点长条 → 跳到 AI 栏，把这段话填进输入框（不自动发）；
 * 板块右上角只有一个小「+」，点开设置窗统一增删改所有栏。
 *
 * 和「常用语」(`quickAsk.ts`) 是两套东西：常用语是输入框上面的小药丸、一句话直接发；
 * 这里是主页上的长条、可以写一段话先填进输入框再改。所以单独一个存储键，互不干扰。
 */
import { getKV, type KV } from './kv';

export interface HomeBar {
  /** 稳定 id：编辑、删除都靠它，改文案不会认错 */
  id: string;
  /** 长条上的标题（留空时退回文本第一句） */
  label: string;
  /** 点下去要填进 AI 输入框的那段话 */
  text: string;
}

export const HOME_BARS_KEY = 'homeBars';

/** 主页就这么点地方，6 条到头；再多就成列表页了 */
export const MAX_HOME_BARS = 6;
/** 标题上限：长条只有一行，再长也显示不全 */
export const MAX_HOME_BAR_LABEL = 24;
/** 正文上限：填进输入框的一段话，不是作文 */
export const MAX_HOME_BAR_TEXT = 240;

let seq = 0;

/** 时间戳 + 序号 + 随机尾，不依赖 crypto.randomUUID（老 WebView 没有） */
function newHomeBarId(): string {
  seq = (seq + 1) % 1000;
  return `hb${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * 把存储里读到的东西洗成合法列表。
 * 返回 `undefined` 表示这份数据没法用（调用方回落成空列表）；空数组是合法结果。
 */
export function normalizeHomeBars(raw: unknown): HomeBar[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HomeBar[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let label = '';
    let text = '';
    let id = '';
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
      if (!text) text = label;
      if (!label) label = text;
    }
    text = oneLine(text).slice(0, MAX_HOME_BAR_TEXT);
    label = oneLine(label).slice(0, MAX_HOME_BAR_LABEL) || text.slice(0, MAX_HOME_BAR_LABEL);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ id: id || newHomeBarId(), label, text });
    if (out.length >= MAX_HOME_BARS) break;
  }
  return out;
}

/** 读列表：没存过 / 存坏了 → 空列表（主页只显示「添加」那一行）。 */
export async function loadHomeBars(kv: KV = getKV()): Promise<HomeBar[]> {
  try {
    const stored = await kv.get<{ v?: number; items?: unknown }>(HOME_BARS_KEY);
    if (!stored) return [];
    return normalizeHomeBars(stored.items) ?? [];
  } catch {
    return [];
  }
}

/** 写列表：先洗干净再落盘，返回值就是真正存下去的版本。 */
export async function saveHomeBars(items: HomeBar[], kv: KV = getKV()): Promise<HomeBar[]> {
  const clean = normalizeHomeBars(items) ?? [];
  await kv.set(HOME_BARS_KEY, { v: 1, items: clean });
  return clean;
}

/** 加一条。出错时抛中文原因，界面直接显示 message。 */
export function addHomeBar(items: HomeBar[], raw: string, label?: string): HomeBar[] {
  const text = oneLine(raw).slice(0, MAX_HOME_BAR_TEXT);
  if (!text) throw new Error('写点内容再保存');
  if (items.some((item) => item.text === text)) throw new Error('这句已经在里面了');
  if (items.length >= MAX_HOME_BARS) throw new Error(`最多 ${MAX_HOME_BARS} 条，先删一条再加`);
  const shown = oneLine(label ?? '').slice(0, MAX_HOME_BAR_LABEL) || text.slice(0, MAX_HOME_BAR_LABEL);
  return [...items, { id: newHomeBarId(), label: shown, text }];
}

/** 改一条（标题 / 正文）。空内容或和别的重复就抛错。 */
export function updateHomeBar(items: HomeBar[], id: string, patch: { label?: string; text?: string }): HomeBar[] {
  const at = items.findIndex((item) => item.id === id);
  if (at < 0) return items;
  const current = items[at]!;
  const text = oneLine(patch.text ?? current.text).slice(0, MAX_HOME_BAR_TEXT);
  if (!text) throw new Error('内容不能是空的');
  if (items.some((item) => item.id !== id && item.text === text)) throw new Error('这句已经在里面了');
  const label = oneLine(patch.label ?? current.label).slice(0, MAX_HOME_BAR_LABEL) || text.slice(0, MAX_HOME_BAR_LABEL);
  const next = items.slice();
  next[at] = { ...current, label, text };
  return next;
}

/** 删一条（按 id）。 */
export function removeHomeBar(items: HomeBar[], id: string): HomeBar[] {
  return items.filter((item) => item.id !== id);
}
