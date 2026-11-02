/**
 * 极小的键值存储抽象。
 * 扩展里是 `chrome.storage.local`，网页（PWA）里是 `localStorage`。
 * 之所以单独抽出来：`src/core/*` 要同时跑在扩展和手机网页里，不能直接吃 `chrome.*`。
 */

import { THEME_KEYS, normalizeCustom, parseThemeKey, type CustomTheme, type ThemeKey } from './theme';

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const PREFIX = 'campus-layer:';

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

const chromeKV: KV = {
  async get<T>(key: string) {
    const got = await chrome.storage.local.get(key);
    return got[key] as T | undefined;
  },
  async set(key: string, value: unknown) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key: string) {
    await chrome.storage.local.remove(key);
  },
};

const localKV: KV = {
  async get<T>(key: string) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  },
  async set(key: string, value: unknown) {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  },
  async remove(key: string) {
    localStorage.removeItem(PREFIX + key);
  },
};

/** 当前环境可用的存储。每次调用都重新判断，便于测试里换环境。 */
export function getKV(): KV {
  return hasChromeStorage() ? chromeKV : localKV;
}

/** 手机端「整套登录态」的导出/导入格式（一次性粘贴）。 */
export interface BundleLlm {
  apiKey: string;
  /** 预设 id（school/deepseek/…），空 = 学校 */
  provider?: string;
  model?: string;
  enabled?: boolean;
}

export interface TokenBundle {
  v: 1;
  jwxt?: string;
  portal?: string;
  /** 模型的 key 与预设：桌面端填过一次，手机端就不用再填。 */
  llm?: BundleLlm;
  /** 外观：桌面端调好的配色，换设备后不用重调一遍。 */
  theme?: BundleTheme;
  at: number;
}

/** 外观随码走：只带「哪套主题 + 自定义那几个数」。 */
export interface BundleTheme {
  name: ThemeKey;
  custom?: CustomTheme;
}

export function encodeBundle(bundle: TokenBundle): string {
  const json = JSON.stringify(bundle);
  // 只含 ASCII（JWT 是 base64url），直接 btoa 即可
  return btoa(json).replace(/=+$/, '');
}

export function decodeBundle(code: string): TokenBundle {
  const trimmed = code.trim().replace(/\s+/g, '');
  const padded = trimmed + '='.repeat((4 - (trimmed.length % 4)) % 4);
  let parsed: Partial<TokenBundle>;
  try {
    parsed = JSON.parse(atob(padded)) as Partial<TokenBundle>;
  } catch {
    throw new Error('这段验证码不是本项目的格式');
  }
  if (parsed.v !== 1) throw new Error('这段验证码不是本项目的格式');
  const jwxt = typeof parsed.jwxt === 'string' && parsed.jwxt.split('.').length === 3 ? parsed.jwxt : undefined;
  const portal = typeof parsed.portal === 'string' && parsed.portal.split('.').length === 3 ? parsed.portal : undefined;
  const rawLlm = (parsed as { llm?: unknown }).llm;
  let llm: BundleLlm | undefined;
  if (rawLlm && typeof rawLlm === 'object') {
    const o = rawLlm as Record<string, unknown>;
    if (typeof o.apiKey === 'string' && o.apiKey.startsWith('sk-')) {
      llm = {
        apiKey: o.apiKey,
        ...(typeof o.provider === 'string' && o.provider ? { provider: o.provider } : {}),
        ...(typeof o.model === 'string' && o.model ? { model: o.model } : {}),
        ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : {}),
      };
    }
  }
  if (!jwxt && !portal) throw new Error('这段验证码里没有可用的登录态');
  const rawTheme = (parsed as { theme?: unknown }).theme;
  let theme: BundleTheme | undefined;
  if (rawTheme && typeof rawTheme === 'object') {
    const o = rawTheme as Record<string, unknown>;
    /* 认不出的主题名就丢掉：不能悄悄把对方的主题拽回默认，那比不带更糟 */
    const name =
      typeof o.name === 'string' && (THEME_KEYS as readonly string[]).includes(o.name)
        ? (o.name as ThemeKey)
        : undefined;
    if (name) {
      theme = {
        name,
        ...(o.custom && typeof o.custom === 'object' ? { custom: normalizeCustom(o.custom) } : {}),
      };
    }
  }
  return {
    v: 1,
    ...(jwxt ? { jwxt } : {}),
    ...(portal ? { portal } : {}),
    ...(llm ? { llm } : {}),
    ...(theme ? { theme } : {}),
    at: Date.now(),
  };
}

/** 三段式 JWT 的最简判据（不校验签名，只看结构） */
/**
 * CAS 回调带的 `ticket` 本身是个 JWT，payload 里装着 idToken。
 * 这是 App 自己的做法（校方 H5 的 getTokenIfTicketExist：
 * `JSON.parse(base64url.decode(ticket.split('.')[1])).idToken`），
 * 所以浏览器里复制到带 ticket 的地址，我们也能就地解出真正的令牌。
 */
export function decodeCasTicket(ticket: string): string | undefined {
  const parts = ticket.split('.');
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(decodeURIComponent(escape(atob(padded)))) as Record<string, unknown>;
    const inner = json.idToken ?? json.id_token;
    return typeof inner === 'string' && looksJwt(inner) ? inner : undefined;
  } catch {
    return undefined;
  }
}

const looksJwt = (v: string): boolean =>
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v) && v.length > 20;

/**
 * 从「手机上粘过来的东西」里认出登录态。
 *
 * 支持三种粘贴内容：
 *  - 学校页面的完整地址（…/uniapp/index.html?idToken=eyJ…），手机上登录完直接复制地址栏即可；
 *  - 直接粘 X-Id-Token（eyJ…）；
 *  - 桌面面板生成的同步码（base64 bundle，走 decodeBundle）。
 *
 * ticket= 看起来像一次性票据，但它本身是个 JWT、payload 里装着 idToken（App 自己就是这么解的），所以先尝试 decodeCasTicket，解不出才报错。
 */
export function parseImportLink(raw: string): TokenBundle {
  const text = raw.trim();
  if (!text) throw new Error('粘的东西是空的');

  /* 1) 同步码（base64 bundle） */
  if (!/^https?:/i.test(text) && !looksJwt(text) && /^[A-Za-z0-9+/=_-]+$/.test(text) && text.length > 40) {
    try {
      return decodeBundle(text);
    } catch {
      /* 不是同步码，继续往下试 */
    }
  }

  /* 2) 直接就是 token（也可能粘来的是 CAS ticket，里面装着 idToken） */
  if (looksJwt(text)) {
    const inner = decodeCasTicket(text) ?? text;
    return { v: 1, jwxt: inner, at: Date.now() };
  }

  /* 3) 学校页面 / App 复制的链接
        直接全文扫 token 参数，兼容：
          https://jwxt.zzu.edu.cn/uniapp/index.html?idToken=eyJ…
          https://uniapp.s.zzu.edu.cn/...#/pages/tab/main/main?idToken=eyJ…
          https://x/index.html?from=app#/p?idToken=eyJ…（query 与 hash 同时有值）
          zzuitOffline://xxx?idToken=eyJ…（App 自定义 scheme）
          userToken= / token= / X-Id-Token=，URL 编码过也行
   */
  const grab = (src: string): string | undefined => {
    const re = /(?:idToken|userToken|token|X-Id-Token)=([^&#\s]+)/i;
    const m = re.exec(src);
    if (!m || !m[1]) return undefined;
    let v = m[1];
    try {
      v = decodeURIComponent(v);
    } catch {
      /* 保持原样 */
    }
    return looksJwt(v) ? v : undefined;
  };

  const fromRaw = grab(text);
  if (fromRaw) return { v: 1, jwxt: fromRaw, at: Date.now() };

  if (/^https?:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error('这段链接看起来不完整，重新复制一次地址栏');
    }
    const hash = url.hash || '';
    for (const src of [url.search, hash.slice(hash.indexOf('?') + 1)]) {
      const v = grab(src);
      if (v) return { v: 1, jwxt: v, at: Date.now() };
    }
  }

  const ticketHit = /[?&#]ticket=([^&#\s]+)/i.exec(text);
  if (ticketHit?.[1]) {
    let raw = ticketHit[1];
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* 原样用 */
    }
    const inner = decodeCasTicket(raw);
    if (inner) return { v: 1, jwxt: inner, at: Date.now() };
    throw new Error(
      '这段 ticket 里没有 idToken（可能是 CAS 的普通票据）。重新登录后复制跳转回来那一页的完整地址，或直接复制 App 的分享链接',
    );
  }

  throw new Error('没认出这是什么。可以粘学校页面的地址、eyJ… 开头的 token，或桌面生成的同步码');
}
