/**
 * 三个后端、三套响应信封，统一成一个调用入口。
 *
 * 实测要点（见 docs/campus-site-probe.md）：
 * - 鉴权走 `X-Id-Token` 头，不依赖 cookie，响应带 `access-control-allow-origin: *`。
 * - 业务失败**不体现在 HTTP 状态码**上：未登录是 200 + `{code:-1,...}`，
 *   缺参是 200 + `{code:500,...}`，所以必须解业务码。
 */

export const PORTAL_API = 'https://info.s.zzu.edu.cn/portal-api';
export const EAMS_DOOR = 'https://jwxt.zzu.edu.cn/eams-door/api/v1';
export const EAMS_MICRO = 'https://jwxt.zzu.edu.cn/eams-micro-server/api/v1';
/** 办事/待办（事务中心） */
export const TTC_API = 'https://transaction.s.zzu.edu.cn/ttc';
/** 消息中心（未读数） */
export const MESSAGE_API = 'https://message-service.s.zzu.edu.cn/center';

export class ApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  constructor(message: string, status = 0, code?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
  /** 未登录 / token 失效（服务端用 code -1 表达） */
  get isAuth(): boolean {
    return this.code === -1 || /没有访问权限|登录/.test(this.message);
  }
}

export type Source = 'portal' | 'jwxt';

/** 给用户看的一句话，而不是 let 出 HTTP 401 这种。 */
export function authHint(source: Source): string {
  return source === 'jwxt'
    ? '教务登录态已失效，请重新打开 https://jwxt.zzu.edu.cn 登录一次'
    : '门户登录态已失效，请重新打开 https://uniapp.s.zzu.edu.cn 登录一次';
}

/**
 * 换个 token 再试一次的钩子。
 *
 * 门户票只有 8 小时、教务票 30 天，但两张都是同一个 CAS 签的。真实情况是：
 * 门户票一过期，用户就得重新登一次——哪怕他手里那张 30 天的教务票还好好的。
 * 所以这里留一个钩子：某个源判 `code:-1` 时，问一句「另一个源有没有能用的票」，
 * 有就换上去重打一次。能不能用由服务端说了算，结果会缓存（见 storage.ts），
 * 顶不上就记下来，别每次请求都白试两遍。
 */
export interface TokenSwap {
  alt(source: Source, tried: string): Promise<string | undefined>;
  verdict(source: Source, ok: boolean): Promise<void>;
}

let swap: TokenSwap | null = null;

export function setTokenSwap(handler: TokenSwap | null): void {
  swap = handler;
}

interface SendOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token: string;
  source: Source;
  /** 部分接口要求表单编码；默认 JSON */
  form?: boolean;
  signal?: AbortSignal;
}

function baseHeaders(source: Source, token: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Id-Token': token,
    'X-Terminal-Info': 'h5',
    'X-Device-Info': 'PCWin32NT',
    Accept: 'application/json, text/plain, */*',
  };
  if (json) headers['content-type'] = 'application/json';
  else headers['content-type'] = 'application/x-www-form-urlencoded';
  if (source === 'portal') headers.Origin = 'https://uniapp.s.zzu.edu.cn';
  else headers.Origin = 'https://jwxt.zzu.edu.cn';
  return headers;
}

interface EnvelopeShape {
  code?: number;
  result?: number;
  success?: boolean;
  data?: unknown;
  message?: string;
  msg?: string;
}

function isEnvelope(v: unknown): v is EnvelopeShape {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return 'code' in o || 'result' in o;
}

/** 解信封。code/result 为 0 或 code 为 200 视为成功。 */
export function unwrap<T>(json: unknown, source: Source = 'jwxt'): T {
  if (isEnvelope(json)) {
    const code = json.code ?? json.result;
    const ok = code === 0 || code === 200 || json.success === true;
    if (!ok) {
      const message = json.message ?? json.msg ?? `接口返回 code=${String(code)}`;
      const isAuth = code === -1 || /没有访问权限|登录/.test(String(message));
      throw new ApiError(isAuth ? authHint(source) : String(message), 200, typeof code === 'number' ? code : undefined);
    }
    if ('data' in json) return json.data as T;
  }
  return json as T;
}

/** 单次请求最多等这么久；超时当作可重试的网络错误 */
const TIMEOUT_MS = 8_000;

/** 把浏览器那几句英文换成用户能懂的话 */
function humanNetError(e: unknown, aborted: boolean): string {
  if (aborted) return '网络有点慢，8 秒没回应，稍后再试一次';
  const msg = (e as Error)?.message ?? '';
  if (/offline|Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    return '连不上服务器：检查一下网络（校园网 / VPN），再试一次';
  }
  return `网络异常：${msg}`;
}

/** 只有「网络层」的错误值得偷偷重试一次；鉴权/业务错误不重试 */
function worthRetry(e: unknown): boolean {
  return e instanceof ApiError && e.status === 0;
}

export async function send<T>(url: string, opts: SendOptions): Promise<T> {
  const attempt = (token: string): Promise<T> => sendOnce<T>(url, { ...opts, token });
  try {
    return await attempt(opts.token);
  } catch (e) {
    /* 弱网下第一次常常是 DNS/握手抽风，隔 300ms 再试一次成功率很高 */
    if (worthRetry(e)) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        return await attempt(opts.token);
      } catch (e2) {
        e = e2;
      }
    }
    if (!(e instanceof ApiError) || !e.isAuth || !swap) throw e;
    let alt: string | undefined;
    try {
      alt = await swap.alt(opts.source, opts.token);
    } catch {
      alt = undefined;
    }
    if (!alt) throw e;
    try {
      const out = await attempt(alt);
      void swap.verdict(opts.source, true).catch(() => undefined);
      return out;
    } catch (e2) {
      void swap.verdict(opts.source, false).catch(() => undefined);
      // 换票也没用的话，报原来的那句（「门户登录态已失效…」），别暴露实现细节
      throw e;
    }
  }
}

async function sendOnce<T>(url: string, opts: SendOptions): Promise<T> {
  const method = opts.method ?? 'GET';
  const json = method === 'POST' && opts.body !== undefined && !opts.form;
  const init: RequestInit = {
    method,
    headers: baseHeaders(opts.source, opts.token, json),
    credentials: 'omit',
    cache: 'no-store',
  };
  if (method === 'POST' && opts.body !== undefined) {
    init.body = json ? JSON.stringify(opts.body) : new URLSearchParams(opts.body as Record<string, string>).toString();
  }

  /* 弱网时别无限等：8 秒没动静就当超时，交给上层重试或报错 */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  init.signal = ctrl.signal;

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    clearTimeout(timer);
    throw new ApiError(humanNetError(e, ctrl.signal.aborted), 0);
  }
  clearTimeout(timer);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`, res.status);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(authHint(opts.source), res.status);
  }
  return unwrap<T>(parsed, opts.source);
}

export function get<T>(base: string, path: string, opts: Omit<SendOptions, 'method' | 'body'>): Promise<T> {
  return send<T>(base + path, { ...opts, method: 'GET' });
}

export function post<T>(
  base: string,
  path: string,
  body: unknown,
  opts: Omit<SendOptions, 'method' | 'body'>,
): Promise<T> {
  return send<T>(base + path, { ...opts, method: 'POST', body });
}
