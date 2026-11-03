import { addDays } from './util';
declare const __APP_VERSION__: string;
/**
 * 与「图书馆空间预约」页面里的 content script 通信。
 *
 * 分工：
 * - 读座位/下单这些事必须带着**页面自己的登录态**（`sessionStorage.token`），
 *   而 `space/confirm` 还要用页面自己的 AES 加密，所以一律交给 content script；
 * - Service Worker 只负责找到那个标签页、发消息、把结果转成工具能用的形状。
 *
 * 找不到标签页不是错误，而是「这条路现在不能用」——调用方要能优雅降级。
 */

import { resolveLibraryArea, resolveLibraryDate, areaCandidates, areaIdByName, areaNameOf } from './library';
import { parseSeatMap, type LibSeatMap } from './library';
import type { BookOutcome } from './libBook';

const LIB_URL_PATTERN = 'http://order.lib.zzu.edu.cn/*';

export interface LibTabResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function hasTabs(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.tabs?.query);
}

export async function findLibraryTab(): Promise<chrome.tabs.Tab | null> {
  if (!hasTabs()) return null;
  try {
    const tabs = await chrome.tabs.query({ url: LIB_URL_PATTERN });
    return tabs[0] ?? null;
  } catch {
    return null;
  }
}

async function send<T>(tabId: number, type: string, args: unknown): Promise<LibTabResult<T>> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type, args })) as LibTabResult<T> | undefined;
    if (!res) return { ok: false, error: '页面没有回应（可能刚刷新）。' };
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      return { ok: false, error: '图书馆页面还没准备好，刷新一下那个标签页再试。' };
    }
    return { ok: false, error: msg };
  }
}

/** 读某个区域某天的座位图（需要那个标签页已经登录） */
/** 直接在页面里读 sessionStorage.token——绕开 content script 版本漂移 */
async function pageToken(tabId: number): Promise<string> {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.sessionStorage.getItem('token') ?? '',
    });
    const v = out?.[0]?.result;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/** 后台直接打图书馆接口（host_permissions 已含该域，SW 的 fetch 不受页面 CORS 限制） */
/** 把服务端返回浓缩成一行诊断：code / message / list 条数 / 是否含 day。 */
function describePayload(raw: unknown): string {
  const o = (raw ?? {}) as Record<string, unknown>;
  const data = (o.data ?? {}) as Record<string, unknown>;
  const list = (data.list ?? data.seats ?? []) as unknown[];
  const code = o.code ?? o.status ?? "?";
  const msg = typeof o.message === "string" ? o.message : typeof o.msg === "string" ? o.msg : "";
  const keys = Object.keys(data).slice(0, 6).join(",");
  return `code=${String(code)} msg=${msg || "-"} list=${Array.isArray(list) ? list.length : "非数组"} keys=${keys || "-"}`;
}

async function fetchSeatsDirect(areaId: string, day: string, token: string): Promise<unknown> {
  const res = await fetch('http://order.lib.zzu.edu.cn/v4/Space/seat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      authorization: 'bearer' + token,
    },
    body: JSON.stringify({
      id: areaId,
      day,
      label_id: [],
      start_time: '07:30',
      end_time: '22:30',
      begdate: '',
      enddate: '',
    }),
  });
  return res.json();
}

interface LibBridge {
  libSeats?: (areaId: string, date: string, reqId: string) => void;
  loginLibrary?: () => void;
}

interface LibWindow {
  CampusNotify?: LibBridge;
  __libSeats?: (reqId: string, json: string) => void;
  __libSeatWaiters?: Record<string, (json: string) => void>;
}

/** 安卓壳原生桥：CampusNotify.libSeats(areaId, date, reqId) → window.__libSeats(reqId, json)。 */
function bridgeNativeSeats(areaId: string, date: string): Promise<string> | null {
  const w = (typeof window === 'undefined' ? undefined : window) as LibWindow | undefined;
  const bridge = w?.CampusNotify;
  if (!w || !bridge || typeof bridge.libSeats !== 'function') return null;
  const reqId = 'lib' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
  w.__libSeatWaiters = w.__libSeatWaiters ?? {};
  w.__libSeats = (id: string, json: string) => {
    const fn = w.__libSeatWaiters?.[id];
    if (fn) {
      delete w.__libSeatWaiters![id];
      fn(json);
    }
  };
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      delete w.__libSeatWaiters![reqId];
      reject(new Error('图书馆接口超时（20 秒没回）'));
    }, 120_000);
    w.__libSeatWaiters![reqId] = (json: string) => {
      clearTimeout(timer);
      resolve(json);
    };
    bridge.libSeats!(areaId, date, reqId);
  });
}

export async function readLibrarySeats(args: {
  areaId: string;
  date: string;
}): Promise<
  LibTabResult<LibSeatMap & { tried: string[]; raw?: unknown; diag?: string }>
> {
  // BY_NAME_LIFTED：允许直接传「语言文史书库」这种房间名
  args = { ...args, areaId: areaIdByName(args.areaId) ?? args.areaId };

  // DATE_CLAMP：座位图也只用服务端认的那两天（余量链路早就夹过，这里补上）
  {
    const fixed = (await resolveLibraryDate(args.date)).date;
    /* 明确给了已知房间 id（如二楼 9）就用它自己；只有认不出的 id 才归一成楼层默认间，
       否则整层所有房间都会读成第一间 */
    const rawArea = String(args.areaId ?? '').trim();
    const areaFixed = areaNameOf(rawArea) ? rawArea : await resolveLibraryArea(rawArea);
    args = { ...args, date: fixed, areaId: areaFixed };
  }
  // 安卓壳：走原生桥（原生 HTTP 不受 CORS / 混合内容限制）
  // 同层可能有多个房间：610 = 该房间当天未开放，挨个试，别再原样把野 id 发出去。
  // 桥在不在由 bridgeNativeSeats() 自己判断（没有桥它返回 null，循环直接 break 落到网页路径）
  const cands = areaCandidates(args.areaId);
  const triedIds: string[] = [];
  let bridgeErr = '';
  // 610 = 该区域当天不可约（常见原因是已过可预约时间或当天已满），
  // 所以先试请求的日期，全 610 再试明天一次。
  for (const day of [args.date, addDays(args.date, 1)]) {
  for (const id of cands) {
    const bridged = bridgeNativeSeats(id, day);
    if (!bridged) break;
    const json = await bridged;
    let outer: { ok?: boolean; error?: string; raw?: unknown };
    try {
      outer = JSON.parse(json) as { ok?: boolean; error?: string; raw?: unknown };
    } catch {
      return { ok: false, error: '原生桥返回的不是 JSON' };
    }
    triedIds.push(id);
    if (!outer.ok) {
      bridgeErr = String(outer.error ?? '');
      continue;
    }

    const raw = (outer.raw ?? {}) as { code?: number | string; message?: string };
    if (String(raw.code) === '10001') {
      const msg = String(raw.message ?? '');
      const kicked = /其他设备|其他终端|已在别处|已从其他/.test(msg);
      return {
        ok: false,
        error: kicked
          ? '图书馆只允许一台设备在线：刚才在手机或电脑上登录过，这里被顶掉了。点「登录图书馆」重登一次就好。'
          : `图书馆要重新登录（${msg || '未登录'}）：点设置面板里的「登录图书馆」。`,
      };
    }

    const seats = parseSeatMap(outer.raw).seats;
    if (seats.length === 0) {
      bridgeErr = describePayload(outer.raw);
      continue;
    }
    return {
      ok: true,
      data: {
        seats,
        areaId: id,
        areaName: areaNameOf(id),
        tried: triedIds,
        diag: `date=${day} ${describePayload(outer.raw)}` + (day !== args.date ? '（今天已过可预约时间，下面是明天的）' : ''),
      },
    };
  }
  }
  // 桥没拿到：把试过的 id 记下来，继续走下面的网页路径（那里还会再试一次）
  if (bridgeErr) console.warn('[lib] 桥试过', triedIds.join('、'), bridgeErr);
  const cn = typeof window === 'undefined' ? undefined : (window as any).CampusNotify;
  const bridgeInfo =
    '[lib] 诊断 v' +
    (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '?') +
    ' · 壳桥' + (cn ? '有' : '无') +
    ' · 方法' + (cn ? '(' + Object.keys(cn).join(',') + ')' : '-') +
    ' · libSeats' + (cn && typeof cn.libSeats === 'function' ? '✓' : '✗');

  const tab = await findLibraryTab();
  if (!tab?.id) {
    /* 诊断信息只写控制台，别塞进给用户看的回复里（以前那行「[诊断 …]」会原样出现在 AI 气泡里） */
    console.warn(bridgeInfo, bridgeErr ? '桥返回：' + bridgeErr : '桥不可用');
    return {
      ok: false,
      error:
        '图书馆座位图要用那个站自己的登录态，我这边拿不到。在「我的 → 图书馆登录」用学校账号（学号 + 图书馆密码）登一次，回来再说一次「一楼座位图」。',
    };
  }

  // 模型给的 areaId 经常是「一楼」的另一个编码（storeys 里 2、payload 里 3），
  // 所以拿到空座位表就换下一个候选 id 再试——座位表非空才说明 id 对。
  const token = await pageToken(tab.id);
  const candidates = areaCandidates(args.areaId);
  const tried: string[] = [];
  let empty: {
    seats: { no: string; status: string; free: boolean }[];
    areaId: string;
    tried: string[];
    raw?: unknown;
    date?: string;
  } = {
    seats: [],
    areaId: args.areaId,
    tried,
  };
  for (const id of candidates) {
    tried.push(id);
    let payload: unknown;
    try {
      payload = await fetchSeatsDirect(id, args.date, token);
    } catch {
      payload = undefined;
    }
    let parsed = parseSeatMap(payload);
    if (parsed.seats.length === 0) {
      // 后台直连读不到时退回 content script（万一 token 在页面里但 SW 被拦）
      const res = await send<{ ok?: boolean; seat?: unknown; error?: string }>(tab.id, 'lib:probe', {
        areaId: id,
        date: args.date,
      });
      if (res.ok) {
        payload = res.data?.seat;
        parsed = parseSeatMap(payload);
      }
    }
    const here = { seats: parsed.seats, areaId: id, tried, raw: payload, date: args.date };
    if (parsed.seats.length > 0) return { ok: true, data: here };
    empty = here;
  }
  return { ok: true, data: empty };
}

export async function bookLibrarySeat(args: {
  areaId: string;
  date: string;
  seatNo: string;
}): Promise<LibTabResult<BookOutcome>> {
  const tab = await findLibraryTab();
  if (!tab?.id) return { ok: false, error: '没有打开图书馆预约页面，没法代你下单。' };
  const res = await send<BookOutcome>(tab.id, 'lib:book', args);
  if (!res.ok) return { ok: false, error: res.error ?? '下单失败' };
  return { ok: true, data: res.data };
}

const LIB_HOME = 'http://order.lib.zzu.edu.cn/h5/index.html';

/**
 * 用存下来的学号 + 图书馆密码登一次。
 *
 * 图书馆是独立账号体系，跟 30 天那张票无关，所以这里只能“真的去点一次登录页”：
 * 没有标签页就开一个，等它加载完，让 content script 填表单、点登录、等 token。
 * 碰到验证码或密码不对会如实报错，不会假装成功。
 */
export async function autoLoginLibrary(args: {
  account: string;
  password: string;
}): Promise<LibTabResult<{ token?: string; already?: boolean }>> {
  let tab = await findLibraryTab();
  let tabId = tab?.id;
  if (!tabId) {
    const created = await chrome.tabs.create({ url: LIB_HOME, active: false });
    if (!created.id) return { ok: false, error: '开不了图书馆页面' };
    tabId = created.id;
    await waitTabLoaded(tabId, 12_000);
  }
  const res = await send<{ token?: string; already?: boolean }>(tabId, 'lib:autologin', args);
  if (!res.ok) return { ok: false, error: res.error ?? '登录失败' };
  return { ok: true, data: res.data ?? {} };
}

/** 等标签页加载完（拿不到 onUpdated 时退化成 sleep） */
function waitTabLoaded(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(finish, timeoutMs);
  });
}
