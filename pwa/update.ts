/**
 * 版本更新：拿「这次发布说明」、比版本号、算要不要弹窗。
 * 纯函数为主，方便测；网络那一步单独一个 fetchRelease()。
 */

export interface Release {
  /** 发布版本，跟 package.json 的 version 对齐 */
  version: string;
  /** 这次更新了什么，一两句话一条 */
  notes: string[];
  /** 发布时间（ISO），只用来显示 */
  publishedAt?: string;
}

export const SEEN_KEY = 'seenVersion';
/** PWA 挂在 /pwa/ 下，扩展/独立包里在根上，两个位置都试一下 */
const VERSION_URLS = ['./version.json', '../version.json'];

/** 0.2.10 vs 0.2.9：逐段按数字比，缺的段当 0 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 远端版本比本地新才值得提示；一样或更旧都不弹 */
export function isNewer(remote: string, local: string): boolean {
  if (!remote || !local) return false; // 构建没注入版本时别乱提示
  return compareVersion(remote, local) > 0;
}

/** 把 version.json 洗成能用的形状；认不出就返回 null */
export function parseRelease(raw: unknown): Release | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === 'string' ? obj.version.trim() : '';
  if (!/^\d+\.\d+/.test(version)) return null;
  const notes = Array.isArray(obj.notes)
    ? obj.notes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim())
    : [];
  const publishedAt = typeof obj.publishedAt === 'string' ? obj.publishedAt : undefined;
  return { version, notes: notes.slice(0, 6), ...(publishedAt ? { publishedAt } : {}) };
}

/** 更新公告：只在这个版本第一次跑起来时弹一次 */
export function shouldAnnounce(local: string, seen: string | null): boolean {
  if (!local) return false;
  if (!seen) return false; // 第一次装，不算「更新」
  return compareVersion(local, seen) > 0;
}

export async function fetchRelease(signal?: AbortSignal): Promise<Release | null> {
  for (const url of VERSION_URLS) {
    try {
      const res = await fetch(url, { cache: 'no-store', signal });
      if (!res.ok) continue;
      const parsed = parseRelease(await res.json());
      if (parsed) return parsed;
    } catch {
      /* 换个路径再试 */
    }
  }
  return null;
}
