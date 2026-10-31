/**
 * 通知的「个人设置」：订阅哪些分类、关注哪些关键词、哪些已读。
 *
 * 为什么不直接写进 kv.ts：kv.ts 是**存储抽象**（chrome.storage.local / localStorage 二选一），
 * 业务键全堆进去就变成杂物间。这里跟 storage.ts 一样，是「一层薄封装 + 明确的数据形状」。
 *
 * 形状很关键：手机上（PWA）和扩展共用同一份形状，以后要跨设备搬就用这里整体导出。
 */
import { getKV } from './kv';
import { NOTICE_CATEGORIES, type NoticeCategory } from './noticeRules';

export interface NoticePrefs {
  /** 订阅的分类；空数组 = 全订阅（默认，不做选择困难） */
  categories: NoticeCategory[];
  /** 额外关注的关键词，命中就提醒（例如「挑战杯」「选课」） */
  keywords: string[];
  /** 已读卡片 id（`来源:原始 id`），只留最近 1000 条 */
  readIds: string[];
  /**
   * 「点过铃铛时已经看到的」卡片 id——只影响铃铛红点，不影响已读/未读。
   * 红点数 = 卡片里不在 seenIds 的条数，所以点完铃铛红点归零，但列表里仍是未读。
   */
  seenIds: string[];
  updatedAt: number;
}

const KEY = 'noticePrefs';
const MAX_READ_IDS = 1000;

export const DEFAULT_NOTICE_PREFS: NoticePrefs = {
  categories: [],
  keywords: [],
  readIds: [],
  seenIds: [],
  updatedAt: 0,
};

function sanitizeCategories(raw: unknown): NoticeCategory[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(NOTICE_CATEGORIES);
  return raw.filter((x): x is NoticeCategory => typeof x === 'string' && known.has(x));
}

function sanitizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

export async function getNoticePrefs(): Promise<NoticePrefs> {
  const stored = (await getKV().get<Partial<NoticePrefs>>(KEY)) ?? {};
  return {
    categories: sanitizeCategories(stored.categories),
    keywords: sanitizeKeywords(stored.keywords),
    readIds: Array.isArray(stored.readIds) ? stored.readIds.filter((x) => typeof x === 'string') : [],
    seenIds: Array.isArray(stored.seenIds) ? stored.seenIds.filter((x) => typeof x === 'string') : [],
    updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : 0,
  };
}

export async function setNoticePrefs(patch: Partial<Omit<NoticePrefs, 'updatedAt'>>): Promise<NoticePrefs> {
  const current = await getNoticePrefs();
  const next: NoticePrefs = {
    categories: patch.categories ? sanitizeCategories(patch.categories) : current.categories,
    keywords: patch.keywords ? sanitizeKeywords(patch.keywords) : current.keywords,
    readIds: patch.readIds ? patch.readIds.slice(-MAX_READ_IDS) : current.readIds,
    seenIds: patch.seenIds ? patch.seenIds.slice(-MAX_READ_IDS) : current.seenIds,
    updatedAt: Date.now(),
  };
  await getKV().set(KEY, next);
  return next;
}

/** 订阅的分类；没选过 = 全订阅。UI 的 tab 直接用它决定显示哪些。 */
export function subscribedCategories(prefs: NoticePrefs): NoticeCategory[] {
  return prefs.categories.length > 0 ? prefs.categories : [...NOTICE_CATEGORIES];
}

export async function markNoticeRead(id: string): Promise<NoticePrefs> {
  const prefs = await getNoticePrefs();
  const patch: Partial<Omit<NoticePrefs, 'updatedAt'>> = {};
  if (!prefs.readIds.includes(id)) patch.readIds = [...prefs.readIds, id];
  /* 单独点开某条也算「看到了」，红点别为它亮着 */
  if (!prefs.seenIds.includes(id)) patch.seenIds = [...prefs.seenIds, id];
  if (!patch.readIds && !patch.seenIds) return prefs;
  return setNoticePrefs(patch);
}

export async function isNoticeRead(id: string): Promise<boolean> {
  const prefs = await getNoticePrefs();
  return prefs.readIds.includes(id);
}

/**
 * 「点了铃铛」＝ 这批通知我算看到了：把这些 id 记进 seenIds（**不动 readIds**）。
 * 效果：铃铛红点归零，但列表里它们仍然是未读；之后新来的通知不在 seenIds 里，红点会重新亮并显示条数。
 * 没有新增时返回 null（调用方就不用写存储）。
 */
export function withAllSeen(prefs: NoticePrefs, cards: Array<{ id: string }>): NoticePrefs | null {
  const have = new Set(prefs.seenIds);
  const add: string[] = [];
  for (const card of cards) {
    const id = typeof card?.id === 'string' ? card.id : '';
    if (id && !have.has(id)) {
      have.add(id);
      add.push(id);
    }
  }
  if (add.length === 0) return null;
  return {
    ...prefs,
    seenIds: [...prefs.seenIds, ...add].slice(-MAX_READ_IDS),
    updatedAt: Date.now(),
  };
}

/** 铃铛红点该显示几：只数「没在 seenIds 里」的卡片，与已读/未读无关。 */
export function countUnseen(prefs: NoticePrefs, cards: Array<{ id: string }>): number {
  const seen = new Set(prefs.seenIds);
  let n = 0;
  for (const card of cards) {
    const id = typeof card?.id === 'string' ? card.id : '';
    if (id && !seen.has(id)) n += 1;
  }
  return n;
}

/** 一键清空已读（调试/重置用）。 */
export async function clearNoticeRead(): Promise<NoticePrefs> {
  return setNoticePrefs({ readIds: [] });
}

// ---- 「点系统通知 → 打开面板并定位到那张卡」的交接 ----
// 面板可能没开，所以先把目标 id 落盘，面板打开时取走（取走即删，免得每次都跳）。

const FOCUS_KEY = 'noticeFocus';

export async function setNoticeFocus(id: string): Promise<void> {
  await getKV().set(FOCUS_KEY, { id, at: Date.now() });
}

/** 取走待定位的卡片 id（超过 maxAgeMs 视为过期，顺手清掉）。 */
export async function takeNoticeFocus(maxAgeMs = 60 * 60_000): Promise<string | null> {
  const raw = await getKV().get<{ id?: string; at?: number }>(FOCUS_KEY);
  if (!raw?.id || typeof raw.at !== 'number') return null;
  await getKV().remove(FOCUS_KEY);
  return Date.now() - raw.at <= maxAgeMs ? raw.id : null;
}
