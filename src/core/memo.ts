/**
 * 备忘录：本机存的小便签。
 *
 * 只有文本，没有账号、不上传；存储走 getKV（壳里是原生 KV，浏览器里是 localStorage）。
 * 纯函数在这里，界面只负责渲染和调用。
 */
import { getKV } from './kv';

export interface Memo {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export const MEMO_KEY = 'memos';
export const MAX_MEMOS = 200;
export const MAX_MEMO_TEXT = 1000;

let seq = 0;
function newMemoId(now: number): string {
  seq = (seq + 1) % 1000;
  return `m${now.toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const clean = (s: string): string => s.replace(/\r\n/g, '\n').trim().slice(0, MAX_MEMO_TEXT);

/** 把存储里读到的东西洗成合法列表；认不出的整条丢掉，不炸界面 */
export function normalizeMemos(raw: unknown): Memo[] {
  if (!Array.isArray(raw)) return [];
  const out: Memo[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const text = typeof o.text === 'string' ? clean(o.text) : '';
    if (!text) continue;
    const id = typeof o.id === 'string' && o.id ? o.id : newMemoId(Date.now());
    if (seen.has(id)) continue;
    seen.add(id);
    const createdAt = typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : Date.now();
    const updatedAt = typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : createdAt;
    out.push({ id, text, createdAt, updatedAt });
    if (out.length >= MAX_MEMOS) break;
  }
  return out;
}

/** 新记录放最前面；超过上限丢最旧的 */
export function addMemo(list: Memo[], text: string, now = Date.now()): Memo[] {
  const t = clean(text);
  if (!t) return list;
  return [{ id: newMemoId(now), text: t, createdAt: now, updatedAt: now }, ...list].slice(0, MAX_MEMOS);
}

export function updateMemo(list: Memo[], id: string, text: string, now = Date.now()): Memo[] {
  const t = clean(text);
  if (!t) return removeMemo(list, id);
  return list.map((m) => (m.id === id ? { ...m, text: t, updatedAt: now } : m));
}

export function removeMemo(list: Memo[], id: string): Memo[] {
  return list.filter((m) => m.id !== id);
}

/** 读本机备忘录 */
export async function loadMemos(): Promise<Memo[]> {
  try {
    return normalizeMemos(await getKV().get<unknown>(MEMO_KEY));
  } catch {
    return [];
  }
}

/** 落盘（失败不抛，界面已经先更新了） */
export async function saveMemos(list: Memo[]): Promise<void> {
  try {
    await getKV().set(MEMO_KEY, list);
  } catch {
    /* 存不下就算了，下次再说 */
  }
}
