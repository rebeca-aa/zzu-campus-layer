import { getKV } from './kv';

/**
 * 离线兜底用的小缓存。
 *
 * 只存「上一次拿到的数据」，用来在没网/接口抽风时先把界面填上，
 * 不参与任何业务判断 —— 真数据回来就覆盖。默认留 7 天。
 */
const PREFIX = 'cache:';
const MAX_AGE = 7 * 24 * 3_600_000;

export interface Cached<T> {
  at: number;
  data: T;
}

export async function readCache<T>(key: string, maxAgeMs = MAX_AGE): Promise<Cached<T> | null> {
  try {
    const raw = await getKV().get<Cached<T>>(PREFIX + key);
    if (!raw || typeof raw.at !== 'number' || raw.data === undefined || raw.data === null) return null;
    if (Date.now() - raw.at > maxAgeMs) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    await getKV().set(PREFIX + key, { at: Date.now(), data });
  } catch {
    /* 存不下就算了，别影响主流程 */
  }
}

/** 「3 分钟前」这种，给界面提示用。 */
export function ageText(at: number, now = Date.now()): string {
  const ms = Math.max(0, now - at);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
