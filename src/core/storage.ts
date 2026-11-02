/**
 * token 持久化。放 chrome.storage.local（不是 session），因为：
 * - 教务 token 实测 30 天、门户 8 小时，重启浏览器后仍应可用；
 * - 用户可在面板里一键清除。
 * 注意：这是本机存储，不会同步（未使用 storage.sync）。
 *
 * 存储形状：{ tokens: { jwxt?: {token,savedAt,expMs}, portal?: {...} } }
 */
import type { CampusSession } from './services';
import { tokenMeta } from './jwt';
import { getKV, encodeBundle, type BundleTheme, type TokenBundle } from './kv';
import { setTokenSwap } from './http';
import { CUSTOM_KEY, normalizeCustom, parseThemeKey } from './theme';

export type TokenSource = 'portal' | 'jwxt';

export interface StoredToken {
  token: string;
  savedAt: number;
  expMs?: number;
}

type StoreMap = Partial<Record<TokenSource, StoredToken>>;

const KEY = 'tokens';

/** 主题存在自己的键上（和 `pwa/main.tsx` 用的必须是同一个名字）。 */
const THEME_KEY = 'theme';

async function readStore(): Promise<StoreMap> {
  return (await getKV().get<StoreMap>(KEY)) ?? {};
}

async function writeStore(next: StoreMap): Promise<void> {
  await getKV().set(KEY, next);
}

export async function saveToken(source: TokenSource, token: string): Promise<void> {
  const store = await readStore();
  const meta = tokenMeta(token);
  const entry: StoredToken = {
    token,
    savedAt: Date.now(),
    ...(meta.expMs !== undefined ? { expMs: meta.expMs } : {}),
  };
  await writeStore({ ...store, [source]: entry });
}

export async function ensureValidToken(source: TokenSource, token: string): Promise<boolean> {
  const meta = tokenMeta(token);
  if (!meta.valid) return false;
  const store = await readStore();
  if (store[source]?.token === token) return true;
  await saveToken(source, token);
  return true;
}

export async function loadSession(today?: string): Promise<CampusSession> {
  const store = await readStore();
  const portal = store.portal;
  const jwxt = store.jwxt;
  return {
    ...(portal ? { portalToken: portal.token } : {}),
    ...(jwxt ? { jwxtToken: jwxt.token } : {}),
    ...(today ? { today } : {}),
  };
}

export interface TokenStatus {
  source: TokenSource;
  present: boolean;
  valid: boolean;
  expText?: string;
  remainingText?: string;
  /** 剩余有效期（毫秒），给「快到期就续一下」判断用 */
  remainingMs?: number;
}

function humanRemaining(ms: number): string {
  if (ms <= 0) return '已过期';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `${Math.floor(h / 24)} 天`;
  if (h >= 1) return `${h} 小时`;
  return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
}

function fmt(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export async function tokenStatuses(now = Date.now()): Promise<TokenStatus[]> {
  const store = await readStore();
  return (['jwxt', 'portal'] as TokenSource[]).map((source) => {
    const entry = store[source];
    if (!entry) return { source, present: false, valid: false };
    const meta = tokenMeta(entry.token, now);
    return {
      source,
      present: true,
      valid: meta.valid,
      ...(meta.expMs !== undefined ? { expText: fmt(meta.expMs) } : {}),
      ...(meta.remainingMs !== undefined ? { remainingText: humanRemaining(meta.remainingMs) } : {}),
      ...(meta.remainingMs !== undefined ? { remainingMs: meta.remainingMs } : {}),
    };
  });
}

export async function clearTokens(): Promise<void> {
  await writeStore({});
}

// ---- 学校 DeepSeek(Open WebUI) 的登录会话 ----
// content script 在 chat.zzu.edu.cn 上读到 localStorage.token 后传过来，
// 用于「一键换成 API Key」——免得用户手动粘贴。

const CHAT_KEY = 'chatSession';

export interface ChatSession {
  token: string;
  savedAt: number;
}

export async function saveChatSession(token: string): Promise<void> {
  await getKV().set(CHAT_KEY, { token, savedAt: Date.now() } satisfies ChatSession);
}

export async function getChatSession(): Promise<ChatSession | null> {
  return (await getKV().get<ChatSession>(CHAT_KEY)) ?? null;
}

// ---- 模型设置（学校 Open WebUI 的 API Key / 模型名） ----

const SETTINGS_KEY = 'llm';

export interface LlmSettingsStored {
  enabled: boolean;
  /** 预设 id（见 llm.ts 的 LLM_PROVIDERS），空 = 学校 */
  provider: string;
  apiKey: string;
  model: string;
}

const DEFAULT_SETTINGS: LlmSettingsStored = {
  enabled: true,
  provider: 'school',
  apiKey: '',
  model: 'DeepSeek-R1',
};

export async function getLlmSettings(): Promise<LlmSettingsStored> {
  const stored = (await getKV().get<Partial<LlmSettingsStored>>(SETTINGS_KEY)) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setLlmSettings(patch: Partial<LlmSettingsStored>): Promise<LlmSettingsStored> {
  const next = { ...(await getLlmSettings()), ...patch };
  await getKV().set(SETTINGS_KEY, next);
  return next;
}

// ---- 跨设备搬运登录态（桌面面板 → 手机 PWA） ----

/** 导出当前登录态为一段可粘贴的码（含 token、模型 key 与外观，不含任何其他信息）。 */
export async function exportTokenBundle(): Promise<string> {
  const store = await readStore();
  const llmSettings = await getLlmSettings();
  const themeName = parseThemeKey(await getKV().get<string>(THEME_KEY));
  const custom = normalizeCustom(await getKV().get<unknown>(CUSTOM_KEY));
  const bundle: TokenBundle = {
    v: 1,
    ...(store.jwxt ? { jwxt: store.jwxt.token } : {}),
    ...(store.portal ? { portal: store.portal.token } : {}),
    ...(llmSettings.apiKey
      ? {
          llm: {
            apiKey: llmSettings.apiKey,
            provider: llmSettings.provider,
            model: llmSettings.model,
            enabled: llmSettings.enabled,
          },
        }
      : {}),
    // 自定义那套只有当它就是当前主题时才值得带上，否则带过去也是被忽略的一坨数字
    theme: { name: themeName, ...(themeName === 'custom' ? { custom } : {}) },
    at: Date.now(),
  };
  if (!bundle.jwxt && !bundle.portal) throw new Error('本机还没有采集到登录态，先在浏览器里打开一次校园页面。');
  return encodeBundle(bundle);
}

/** 导入一段码。过期的票也收（只提示），因为用户可能想先看着）。 */
export async function importTokenBundle(bundle: TokenBundle): Promise<TokenStatus[]> {
  const now = Date.now();
  const store = await readStore();
  const next = { ...store };
  for (const source of ['jwxt', 'portal'] as TokenSource[]) {
    const token = bundle[source];
    if (!token) continue;
    const meta = tokenMeta(token, now);
    next[source] = { token, savedAt: now, ...(meta.expMs !== undefined ? { expMs: meta.expMs } : {}) };
  }
  await writeStore(next);
  if (bundle.llm?.apiKey) {
    await setLlmSettings({
      apiKey: bundle.llm.apiKey,
      ...(bundle.llm.provider ? { provider: bundle.llm.provider } : {}),
      ...(bundle.llm.model ? { model: bundle.llm.model } : {}),
      ...(typeof bundle.llm.enabled === 'boolean' ? { enabled: bundle.llm.enabled } : {}),
    });
  }
  // 外观：码里带过来就照它换（页面那边下次 refresh 会读到）
  const theme: BundleTheme | undefined = bundle.theme;
  if (theme?.name) {
    await getKV().set(THEME_KEY, theme.name);
    if (theme.custom) await getKV().set(CUSTOM_KEY, theme.custom);
  }
  return tokenStatuses(now);
}

export interface WatchState {
  /** 上次看到的成绩指纹（新出分靠它比较） */
  gradeFp?: string;
  /** 上次推送的日期（用来判断「今天是否已经推过」与「跨天重置」） */
  notifiedOn?: string;
  /** 今天已经提醒过哪些截止（卡片 id）——同一天新出现别的截止还会补推，同一条不会重复 */
  notifiedIds?: string[];
  /** 今天已经推了几次（每天有上限，免得 6 小时一次变骚扰） */
  pushesOn?: number;
}

const WATCH_KEY = 'watch';

export async function getWatchState(): Promise<WatchState> {
  return (await getKV().get<WatchState>(WATCH_KEY)) ?? {};
}

// ---- 两张票互相当备份 ----
// 门户票 8 小时、教务票 30 天，但都是 cas.s.zzu.edu.cn 签的。门户票过期时先拿教务票顶上，
// 用户就不用天天重登。能不能顶由服务端决定，结论缓存 6 小时，免得每次请求都白试一遍。

const SWAP_KEY = 'tokenSwap';
const SWAP_TTL = 6 * 3_600_000;

interface SwapState {
  verdict?: 'ok' | 'no';
  at?: number;
  source?: TokenSource;
}

export async function altToken(source: TokenSource, tried: string): Promise<string | undefined> {
  const state = (await getKV().get<SwapState>(SWAP_KEY)) ?? {};
  if (state.verdict === 'no' && typeof state.at === 'number' && Date.now() - state.at < SWAP_TTL) return undefined;
  const store = await readStore();
  const other: TokenSource = source === 'portal' ? 'jwxt' : 'portal';
  const candidate = store[other]?.token;
  if (!candidate || candidate === tried) return undefined;
  if (!tokenMeta(candidate).valid) return undefined;
  return candidate;
}

export async function noteSwapVerdict(source: TokenSource, ok: boolean): Promise<void> {
  await getKV().set(SWAP_KEY, { verdict: ok ? 'ok' : 'no', at: Date.now(), source } satisfies SwapState);
}

setTokenSwap({ alt: altToken, verdict: noteSwapVerdict });

export async function setWatchState(patch: Partial<WatchState>): Promise<WatchState> {
  const next = { ...(await getWatchState()), ...patch };
  await getKV().set(WATCH_KEY, next);
  return next;
}
