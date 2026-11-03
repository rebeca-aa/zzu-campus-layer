/* 实测自页面地址栏：id → 房间名（回答里用它，别再显示「区域 8」） */
export const AREA_NAMES: Record<string, string> = {
  '3': '一楼大厅',
  '8': '工程与信息技术书库-1',
  '9': '工程与信息书库-2',
  '11': '社会科学书库-1',
  '12': '社会科学书库-2',
  '13': '语言文史书库',
  '14': '三楼西大厅',
  '15': '三楼中',
  '16': '三楼东大厅',
  '17': '自然与外文书库',
  '18': '电子阅览室',
  '19': '四楼西大厅',
  '20': '四楼东大厅',
  '76': '期刊阅览室',
};

/**
 * 图书馆空间预约（`order.lib.zzu.edu.cn`）的**免登录**部分。
 *
 * 实测（2026-10-22，校内网）：
 * - `POST /v4/space/index` 不需登录，返回 4 个馆 + 楼层 + 座位类型 + 可选日期；
 * - `POST /v4/space/pcTopFor` 不需登录，返回每个馆的 **实时总数/空闲数**（主校区 2527 / 930）；
 * - `POST /v4/Space/map`（座位图）、`/v4/space/confirm`（下单）**必须登录**，
 *   而登录用的就是统一身份认证的学号+密码（见 `/v4/index/bookingRules` 原文），
 *   所以扩展不碰账号密码，只给实时余位 + 直达链接。
 *
 * 只支持 http（443 拒绝连接），且仅校内网可达——校外用户会拿到明确的错误文案。
 */

import { send } from './http';
import { addDays, todayShanghai } from './util';

export const LIB_BASE = 'http://order.lib.zzu.edu.cn';

export interface LibraryPremise {
  id: string;
  name: string;
  total: number;
  free: number;
  /** 楼层（`children`）——「一楼还有位置吗」用得上 */
  floors?: LibraryFloor[];
}

export interface LibraryFloor {
  id: string;
  name: string;
  total: number;
  free: number;
}

export interface LibrarySeats {
  date: string;
  dates: string[];
  premises: LibraryPremise[];
  /** 直达「某馆某天」的座位页（需要登录才能下单，但看得到平面图） */
  url: string;
}

interface RawPremise {
  id?: string | number;
  name?: string;
  total_num?: string | number;
  free_num?: string | number;
  children?: RawPremise[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function librarySeatUrl(premiseId: string, date: string): string {
  return `${LIB_BASE}/h5/index.html#/seat/space?id=${encodeURIComponent(premiseId)}&date=${encodeURIComponent(date)}`;
}

interface LibTopBridge {
  libTopFor?: (areaId: string, date: string, reqId: string) => void;
  libLoggedIn?: () => boolean;
  loginLibrary?: () => void;
}

interface LibTopWindow {
  CampusNotify?: LibTopBridge;
  __libSeats?: (reqId: string, json: string) => void;
  __libSeatWaiters?: Record<string, (json: string) => void>;
}

function bridgeTopFor(date: string): Promise<string> | null {
  const w = (typeof window === 'undefined' ? undefined : window) as LibTopWindow | undefined;
  const bridge = w?.CampusNotify;
  if (!w || !bridge || typeof bridge.libTopFor !== 'function') return null;
  const reqId = 'top' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
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
      reject(new Error('[原生] 图书馆接口超时（20 秒没回）'));
    }, 20_000);
    w.__libSeatWaiters![reqId] = (json: string) => {
      clearTimeout(timer);
      resolve(json);
    };
    bridge.libTopFor!('1', date, reqId);
  });
}

export function parseTopFor(
  data: { date?: string[]; list?: RawPremise[] },
  date = '',
): LibrarySeats {
  const dates = Array.isArray(data.date) ? data.date.map(String) : [];
  const picked = date || dates[0] || '';
  const premises = (data.list ?? []).map((x) => {
    const floors = Array.isArray(x.children)
      ? x.children.map((c) => ({
          id: String(c.id ?? ''),
          name: String(c.name ?? ''),
          total: num(c.total_num),
          free: num(c.free_num),
        }))
      : [];
    return {
      id: String(x.id ?? ''),
      name: String(x.name ?? ''),
      total: num(x.total_num),
      free: num(x.free_num),
      ...(floors.length ? { floors } : {}),
    };
  });
  return {
    date: picked,
    dates,
    premises,
    url: librarySeatUrl(premises[0]?.id ?? '1', picked),
  };
}


/**
 * 从图书馆服务端读「它接受哪两天」，并把调用方给的日期夹进这个范围。
 * 原因：该接口只接受今天/明天，其它日期一律回 code:0 + 空列表（不是报错），
 * 一旦某台设备的本地日期算偏一天，就会稳定读不到座位。
 */
export async function resolveLibraryDate(date?: string): Promise<{ date: string; dates: string[]; adjusted: boolean }> {
  /*
   * 这接口只接受「今天 / 明天」，其它日期一律 code=610（不是空列表，是直接报错）。
   * 而馆站只有 http、PWA 在 https ⇒ 这里**不能再依赖网络**去问服务端日期窗口：
   * 混合内容被拦后 fallback 会把模型给的旧日期原样发出去，于是四层全 610。
   * 所以先按本地（Asia/Shanghai）算出今天/明天，网络只用于"如果通了就校正"。
   */
  const today = todayShanghai();
  const tomorrow = addDays(today, 1);
  const local = [today, tomorrow];
  const wanted = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';

  let dates = local;
  try {
    const res = await send<{ data?: { date?: string[] } }>(LIB_BASE + '/v4/space/index', {
      method: 'POST',
      body: JSON.stringify({ id: '1' }),
      token: '',
      source: 'portal',
    });
    const list = res?.data?.date;
    const got = Array.isArray(list)
      ? list.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      : [];
    if (got.length) dates = got;
  } catch {
    /* 混合内容/离线：用本地算的今天明天，别把功能卡死 */
  }

  if (wanted && dates.includes(wanted)) return { date: wanted, dates, adjusted: false };
  return { date: dates[0] ?? today, dates, adjusted: Boolean(wanted) };
}

/*
 * 楼层名 → 主校区可预约区域 id（实测 2026-10-26）。
 *
 * 这必须是**本地常量**：PWA 跑在 https（github.io），而图书馆站只有 http，
 * 混合内容会拦掉 /v4/space/index，靠网络查表永远失败，于是原样把模型给的 "4" 发出去 → 610。
 * 值来源：/v4/space/index 的 storey[].list（每层第一个房间）：
 *   一楼 2（大厅，parentId=馆）、二楼 72（工程与信息技术书库-1）、三楼 52、四楼 53。
 */
/* 同一层的其它可预约房间（610 = 该房间当天未开放时，挨个试下一个） */
export const FLOOR_AREA_ALTS: Record<string, string[]> = {
  /* 用户从图书馆页面地址栏逐个报来的实测 id，别再放进楼层级旧 id
     （71/61/72/24/52/53/2/4/5/6 都是楼层或历史残留，放进来会重复出"未命名区域"） */
  一楼: ['3'],
  二楼: ['8', '9', '11', '12'],
  三楼: ['13', '14', '15', '16', '17'],
  四楼: ['18', '19', '20', '76'],
};

export const FLOOR_AREA_ID: Record<string, string> = {
  一楼: '3',
  二楼: '8',
  三楼: '13',
  四楼: '18',
};

/* 楼层名 ← 旧的写死 id（一楼早先写成 3，服务端楼层表里主校区一楼其实是 2） */
const FLOOR_OF_LEGACY_ID: Record<string, string> = {
  '3': '一楼', '2': '一楼', '71': '一楼', '61': '一楼',
  '8': '二楼', '9': '二楼', '11': '二楼', '12': '二楼', '72': '二楼', '24': '二楼', '4': '二楼',
  '13': '三楼', '14': '三楼', '15': '三楼', '16': '三楼', '17': '三楼', '52': '三楼', '5': '三楼',
  '18': '四楼', '19': '四楼', '20': '四楼', '76': '四楼', '53': '四楼', '6': '四楼',
};

/**
 * 把模型/规则可能给的各种写法都归一到楼层名：
 * 旧 area id（3）、中文楼层（"一楼"/"1楼"/"一层"/"大厅"）、
 * 误传成馆 id 的（1/10/60/70 → 按一楼处理）。
 */
function floorFromAreaId(areaId: string): string {
  const hit = FLOOR_OF_LEGACY_ID[areaId];
  if (hit) return hit;
  const raw = String(areaId ?? '').trim();
  if (/一楼|1\s*楼|一层|大厅/.test(raw)) return '一楼';
  if (/二楼|2\s*楼|二层/.test(raw)) return '二楼';
  if (/三楼|3\s*楼|三层/.test(raw)) return '三楼';
  if (/四楼|4\s*楼|四层/.test(raw)) return '四楼';
  if (['1', '10', '60', '70'].includes(raw)) return '一楼';
  return '';
}

type FloorMap = { at: number; floors: Record<string, string>; ids: Set<string> };
let _floorCache: FloorMap | null = null;

/**
 * 按「楼层名」从服务端楼层表现查可预约区域 id（主校区 premiseId='1'）。
 *
 * 关键事实（2026-10-26 实测）：服务端 storey[].list 里放的其实是**房间**，
 * 它们的 parentId 指向楼层、不是馆；只有一楼大厅那种才 parentId=馆。
 * 所以取每层第一个房间作为该层的代表 id（二楼 72、三楼 52、四楼 53…）。
 * 传入 id 若不在服务端清单里（模型瞎填的 "3"），回落一楼，避免 610。
 */
export async function resolveLibraryArea(areaId: string, premiseId = '1'): Promise<string> {
  const raw = String(areaId ?? '').trim();
  const floor = floorFromAreaId(raw);

  // ① 本地表优先（不依赖网络，https 页面也一定能用）
  if (floor && FLOOR_AREA_ID[floor]) return FLOOR_AREA_ID[floor];

  // ② 已经是服务端认识的房间 id（72/52/53/71/61/24…）就原样用
  if (Object.values(FLOOR_AREA_ID).includes(raw)) return raw;
  if (Object.keys(FLOOR_OF_LEGACY_ID).includes(raw) && floor && FLOOR_AREA_ID[floor]) {
    return FLOOR_AREA_ID[floor];
  }

  // ③ 本地表覆盖不到的（别的馆/别的楼层）：再问服务端
  const cached = _floorCache && Date.now() - _floorCache.at < 5 * 60 * 1000 ? _floorCache : null;
  if (cached && floor && cached.floors[floor]) return cached.floors[floor];
  if (cached && !floor && cached.ids.has(raw)) return raw;

  try {
    const res = await send<{
      data?: {
        storey?: Array<{
          name?: string;
          list?: Array<{ id?: string | number; parentId?: string | number }>;
        }>;
      };
    }>(LIB_BASE + '/v4/space/index', {
      method: 'POST',
      body: JSON.stringify({ id: premiseId }),
      token: '',
      source: 'portal',
    });

    const floors: Record<string, string> = {};
    const ids = new Set<string>();
    for (const st of res?.data?.storey ?? []) {
      const name = String(st?.name ?? '').trim();
      const list = (st?.list ?? []).filter((x) => x?.id != null);
      for (const item of list) ids.add(String(item.id));
      if (!list.length) continue;
      const direct = list.find((x) => String(x?.parentId ?? '') === premiseId);
      const pick = direct ?? list[0];
      if (pick?.id != null) floors[name] = String(pick.id);
    }

    if (Object.keys(floors).length) {
      _floorCache = { at: Date.now(), floors, ids };
      if (floor && floors[floor]) return floors[floor];
      if (ids.has(raw)) return raw;
      if (floors['一楼']) return floors['一楼'];
    }
  } catch {
    /* 网络不通（多半是混合内容）：落到下面的兜底 */
  }

  // ④ 兜底：认不出就一楼，绝不把野 id 发出去换 610
  if (floor && FLOOR_AREA_ID[floor]) return FLOOR_AREA_ID[floor];
  return Object.values(FLOOR_AREA_ID).includes(raw) ? raw : (FLOOR_AREA_ID['一楼'] ?? raw);
}

/**
 * 给一个 areaId，返回「该层依次要试的 id 列表」。
 * 馆站对未开放的房间回 code=610（不是空列表），所以必须能换下一个房间重试。
 */
const AREA_IDS_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(AREA_NAMES).map(([id, name]) => [name, id]),
);

export function areaIdByName(text: string): string | undefined {
  const t = String(text ?? '').trim();
  if (!t) return undefined;
  if (AREA_IDS_BY_NAME[t]) return AREA_IDS_BY_NAME[t];
  const hit = Object.entries(AREA_NAMES).find(([, name]) => name.includes(t) || t.includes(name));
  return hit ? hit[0] : undefined;
}

export function areaNameOf(id: string): string | undefined {
  return AREA_NAMES[String(id ?? '').trim()];
}

export function areaCandidates(areaId: string): string[] {
  const exact = String(areaId ?? '').trim();
  const floor = floorFromAreaId(exact);
  const head = floor && FLOOR_AREA_ID[floor] ? [FLOOR_AREA_ID[floor] as string] : [];
  const alts = floor ? (FLOOR_AREA_ALTS[floor] ?? []) : [];
  /* 用户/模型明确给了 id 时，必须先试它自己，否则整层都会读成默认那一间 */
  const out = [exact, ...head, ...alts].filter((x) => x && x !== 'undefined');
  return [...new Set(out)];
}

/** area id → 楼层名（一楼/二楼/…），认不出返回 undefined */
export function floorOfArea(areaId: string): string | undefined {
  return floorFromAreaId(String(areaId ?? '').trim()) || undefined;
}

export async function librarySeats(opts: { date?: string } = {}): Promise<LibrarySeats> {
  const resolved = await resolveLibraryDate(opts.date);
  opts = { ...opts, date: resolved.date };  const bridgedTop = bridgeTopFor(opts.date ?? '');
  if (bridgedTop) {
    const raw = await bridgedTop;
    let outer: { ok?: boolean; error?: string; raw?: unknown };
    try {
      outer = JSON.parse(raw) as { ok?: boolean; error?: string; raw?: unknown };
    } catch {
      throw new Error('原生桥返回的不是 JSON');
    }
    if (!outer.ok) throw new Error(`[原生] ${outer.error ?? '图书馆接口失败'}`);
    const data = (outer.raw as { data?: { date?: string[]; list?: RawPremise[] } }).data;
    if (!data) throw new Error('图书馆接口没返回 data');
    return parseTopFor(data, opts.date ?? '');
  }

  const date = opts.date ?? '';
  let res: Response;
  try {
    res = await fetch(`${LIB_BASE}/v4/space/pcTopFor`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: LIB_BASE,
        referer: `${LIB_BASE}/h5/`,
      },
      body: JSON.stringify({ id: '1', ...(date ? { date } : {}) }),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`连不上图书馆预约系统（${msg}）【走的是网页直连，没用上原生桥】。它只在校内网能访问，校外先连 VPN；若你在安卓壳里看到这句，说明壳版本过旧或页面缓存没刷新。`);
  }

  if (!res.ok) throw new Error(`图书馆预约系统返回 HTTP ${res.status}。`);

  const json = (await res.json()) as {
    code?: number;
    message?: string;
    data?: { date?: string[]; list?: RawPremise[] };
  };
  if (json.code !== 0 || !json.data) {
    throw new Error(`图书馆预约系统报错：${json.message ?? `code=${String(json.code)}`}`);
  }

  return parseTopFor(json.data, date);
}

/* ------------------------------------------------------------------ */
/* 座位级（需要页面里的登录态，由 content/library.js 代取）            */
/* ------------------------------------------------------------------ */

export interface LibSeat {
  /** 座位号，页面上的可读编号，如 `001`、`A12` */
  no: string;
  /** 原始状态字符串，服务端给什么就是什么 */
  status: string;
  free: boolean;
  /** 页面平面图上的坐标（真实接口给 `point_x`/`point_y`），拿不到就不画图 */
  x?: number;
  y?: number;
}

export interface LibSeatMap {
  areaName?: string;
  total?: number;
  free?: number;
  seats: LibSeat[];
  /**
   * 楼层里的房间（自习室 / 阅览区）。
   * 一楼是一整个大厅，只有一间；二三四楼有很多间，每间有自己的座位图和坐标，
   * 混在一张图上会互相压着，所以按房间分开画。
   */
  rooms?: LibRoom[];
  /** 实际使用的日期（服务端只认今天/明天，会被夹紧） */
  date?: string;
  /** 实际使用的区域 id */
  areaId?: string;
}

export interface LibRoom {
  name: string;
  seats: LibSeat[];
  total?: number;
  free?: number;
  /** 房间 id（接口给了就带上，下单时可能有用） */
  id?: string;
}

/**
 * 状态词：只认**明确的文字**。
 * 数字编码（`1`/`0`）不敢猜——站点用 1 表示"可用"还是"已占"没有文档，
 * 猜错会把已占的座位当成空的，所以一律当成"状态未知"。
 */
const FREE_RE = /^(free|empty|available|idle)$|空闲|可用|可选/i;
const USED_RE = /used|occupied|busy|booked|使用|占用|已约|不可选/i;
const NUMERIC_STATUS_RE = /^-?\d+$/;

/** 宽松取数：数字或数字字符串都收，其它（null/空串/NaN）返回 undefined */
const numOr = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const seatNo = (o: Record<string, unknown>): string => {
  for (const k of ['no', 'name', 'seat_no', 'seatNo', 'num', 'number', 'code', 'title']) {
    const v = o[k];
    if (typeof v === 'string' || typeof v === 'number') {
      const st = String(v).trim();
      if (st && st.length <= 12) return st;
    }
  }
  return '';
};

/**
 * 状态：真实接口同时给 `status`（数字）和 `status_name`（中文）。
 * 优先用中文名判空/占，数字只作为后备显示。
 */
const seatStatus = (o: Record<string, unknown>): string => {
  for (const k of ['status_name', 'statusName', 'status', 'state', 'seat_status', 'seatStatus', 'use_status', 'type']) {
    const v = o[k];
    if (typeof v === 'string' || typeof v === 'number') {
      const st = String(v);
      if (st !== '') return st;
    }
  }
  return '';
};

/** 数字状态码的语义（实测一楼 216 个座位时 status 与 status_name 成对出现，据此确认） */
const STATUS_NUM: Record<string, { label: string; free: boolean }> = {
  '1': { label: '可用', free: true },
  '2': { label: '使用中', free: false },
  '3': { label: '预约中', free: false },
  '4': { label: '临时离开', free: false },
};

const ROOM_NAME_FIELDS = ['room_name', 'roomName', 'area_name', 'areaName', 'label_name', 'labelName', 'space_name', 'spaceName', 'name', 'title'];

/** 房间名：只认长度合理的字符串，避免把座位号/状态当成房间名 */
function roomNameOf(obj: Record<string, unknown>): string {
  for (const k of ROOM_NAME_FIELDS) {
    const v = obj[k];
    if (typeof v === 'string') {
      const st = v.trim();
      if (st && st.length <= 24 && !/^\d+$/.test(st)) return st;
    }
  }
  return '';
}

/**
 * 宽容解析：不假设字段名。
 * 服务端的座位列表字段名改过（`seat_list`/`list`/`seats`/数组本身），
 * 所以这里递归找「看起来像座位」的对象，认不出来就返回空。
 *
 * 同时**按房间分组**：二三四楼一层里有多个自习室，每个房间有自己的坐标系，
 * 全部平铺到一张图上会互相压住，所以这里记住每个座位属于哪个房间。
 */
export function parseSeatMap(raw: unknown): LibSeatMap {
  const out: LibSeatMap = { seats: [] };
  const rooms = new Map<number, LibRoom>();
  const seenInRoom = new Map<number, Set<string>>();
  const ROOT_ROOM = 0;
  let roomSeq = 0;

  /* 每个「盛座位的那一层对象」算一间房：名字有就用，没有就叫「房间 N」 */
  const roomOfObject = new WeakMap<object, number>();
  const roomFor = (obj: object): number => {
    let id = roomOfObject.get(obj);
    if (id === undefined) {
      id = ++roomSeq;
      roomOfObject.set(obj, id);
      rooms.set(id, { name: roomNameOf(obj as Record<string, unknown>), seats: [] });
    }
    return id;
  };

  const looksLikeSeatObj = (o: Record<string, unknown>): boolean => {
    const no = seatNo(o);
    const status = seatStatus(o);
    return Boolean(no) && (status !== '' || 'x' in o || 'y' in o || 'left' in o || 'top' in o || 'point_x' in o);
  };

  /** 这一层对象下面是否直接挂着一串座位（是的话它就是「房间」） */
  const isRoomContainer = (obj: Record<string, unknown>): boolean => {
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        const seats = v.filter((x) => x && typeof x === 'object' && looksLikeSeatObj(x as Record<string, unknown>));
        if (seats.length >= 2) return true;
      }
    }
    return false;
  };

  const add = (roomId: number, seat: LibSeat): void => {
    const seen = seenInRoom.get(roomId) ?? new Set<string>();
    if (seen.has(seat.no)) return;
    seen.add(seat.no);
    seenInRoom.set(roomId, seen);
    const room = rooms.get(roomId) ?? { name: '', seats: [] };
    if (!rooms.has(roomId)) rooms.set(roomId, room);
    room.seats.push(seat);
    out.seats.push(seat);
  };

  const visit = (node: unknown, depth: number, roomId: number): void => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, roomId);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    if (typeof obj.area_name === 'string' && obj.area_name && !out.areaName) out.areaName = obj.area_name;
    /* 有些返回把整区名放在 `name` 里（例如 data.name = "一楼大厅"）：只在还没见到座位时用，免得把房间名当区名 */
    if (!out.areaName && !out.seats.length && !looksLikeSeatObj(obj)) {
      const nm = roomNameOf(obj);
      if (nm) out.areaName = nm;
    }
    const t = Number(obj.total_num ?? obj.total);
    if (Number.isFinite(t) && t > 0 && out.total === undefined) out.total = t;
    const f = Number(obj.free_num ?? obj.free);
    if (Number.isFinite(f) && f >= 0 && out.free === undefined) out.free = f;

    const no = seatNo(obj);
    const status = seatStatus(obj);
    if (looksLikeSeatObj(obj)) {
      const byName = status !== '' && FREE_RE.test(status) && !USED_RE.test(status);
      const byNum = STATUS_NUM[status]?.free ?? false;
      const free = status !== '' ? byName || byNum : false;
      const x = numOr(obj.point_x ?? obj.x ?? obj.left);
      const y = numOr(obj.point_y ?? obj.y ?? obj.top);
      const seat: LibSeat = { no, status, free, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
      /* 座位自己带房间名（且不是整区名）就单开一间，不然跟随所在容器 */
      const own = roomNameOf(obj);
      add(own && own !== out.areaName ? roomFor(obj) : roomId, seat);
      return;
    }

    const nextRoom = isRoomContainer(obj) ? roomFor(obj) : roomId;
    for (const v of Object.values(obj)) if (v && typeof v === 'object') visit(v, depth + 1, nextRoom);
  };

  visit(raw, 0, ROOT_ROOM);
  if (!rooms.has(ROOT_ROOM)) rooms.set(ROOT_ROOM, { name: '', seats: [] });

  out.seats.sort((a, b) => a.no.localeCompare(b.no, 'zh'));
  const list = [...rooms.values()].filter((r) => r.seats.length > 0);
  for (const r of list) {
    r.total = r.seats.length;
    r.free = r.seats.filter((s) => s.free).length;
  }
  const named = list.filter((r) => r.name);
  /* 一楼的整层就是一间大厅：只有真的分出多间（或唯一那间有自己的名字）才分层显示 */
  if (list.length > 1 || (named.length === 1 && list.length === 1 && named[0]!.name !== out.areaName)) {
    out.rooms = list;
  }
  if (out.free === undefined && out.seats.length) out.free = out.seats.filter((s) => s.free).length;
  return out;
}

/** 按房间名筛（只问某一间时用），匹配不到返回 undefined */
export function pickRoom<T extends LibSeatMap>(m: T, want: string): T | undefined {
  const rooms = m.rooms ?? [];
  if (!rooms.length) return undefined;
  const q = want.replace(/\s+/g, '').toLowerCase();
  if (!q) return undefined;
  const hit =
    rooms.find((r) => r.name.replace(/\s+/g, '').toLowerCase() === q) ??
    rooms.find((r) => {
      const n = r.name.replace(/\s+/g, '').toLowerCase();
      return n.includes(q) || q.includes(n);
    });
  if (!hit) return undefined;
  return { ...m, rooms: [hit], seats: hit.seats, free: hit.free, total: hit.total };
}

/** 图的配色：跟深色界面同一套，免得在聊天里突然出现一块荧光绿 */
const MAP_BG = '#0b0f14';
const PLATE_BG = '#10151c';
const PLATE_LINE = '#1b222c';
const MAP_INK = '#e6edf3';
const MAP_MUTED = '#8b949e';
const MAP_FREE = '#3ddc84';
const MAP_TAKEN = '#3c4654';

/** 画布左右留白（房间底板离画布边缘的距离） */
const PLATE_X = 10;
/** 房间底板内边距 */
const PLATE_PAD = 12;
/** 房间标题行高度 */
const ROOM_HEAD = 28;
/** 顶部整图标题行高度 */
const HEAD_H = 40;
/** 底部图例行高度 */
const FOOT_H = 30;

/**
 * 把座位坐标画成 SVG 平面图（真实接口给 point_x/point_y）。
 * 一层里有多间房时**每间单独一块**（坐标是各房间自己的，混着画会叠成一团）。
 * 只给**空闲**座位标号；标号会做碰撞检测，挤不下的就不标。
 * 拿不到坐标就不画——宁可说「看不到图」，也不画一张假图。
 */
export function seatMapSvg(m: LibSeatMap, opts: { width?: number; labels?: boolean } = {}): string | undefined {
  const W = opts.width ?? 720;
  const wantLabels = opts.labels !== false;
  const multi = (m.rooms?.length ?? 0) > 1;
  const groups = multi ? m.rooms! : [{ name: '', seats: m.seats }];
  /* 单层给足纵向空间；多间时每间压扁一点，整张图不至于长得离谱 */
  const maxSeatH = multi ? 360 : 500;
  const plateW = W - PLATE_X * 2;
  const seatW = plateW - PLATE_PAD * 2;

  const panels: { title: string; free: number; total: number; labeled: number; inner: string; height: number }[] = [];
  for (const g of groups) {
    const pts = g.seats.filter((s) => typeof s.x === 'number' && typeof s.y === 'number') as SeatPoint[];
    if (pts.length < 4) continue;
    const drawn = layoutSeatMap(pts, seatW, wantLabels, maxSeatH);
    panels.push({
      title: multi ? g.name || `房间 ${panels.length + 1}` : '',
      free: pts.filter((s) => s.free).length,
      total: pts.length,
      labeled: drawn.labeled,
      inner: drawn.inner,
      height: drawn.height,
    });
  }
  if (!panels.length) return undefined;

  const freeAll = m.seats.filter((s) => s.free).length;
  const labeledAll = panels.reduce((n, p) => n + p.labeled, 0);
  const head = multi ? `${m.areaName || '这一层'} · ${panels.length} 间` : m.areaName || '图书馆座位图';
  const right = [
    m.date,
    `空 ${freeAll} / 共 ${m.seats.length}`,
    wantLabels && labeledAll < freeAll ? `标号 ${labeledAll}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const parts: string[] = [];
  parts.push(
    `<text x="${PLATE_X + 6}" y="26" fill="${MAP_INK}" font-size="15" font-weight="700" font-family="system-ui,sans-serif">${esc(head)}</text>`,
    `<text x="${W - PLATE_X - 6}" y="26" text-anchor="end" fill="${MAP_MUTED}" font-size="12" font-family="system-ui,sans-serif">${esc(right)}</text>`,
  );

  let y = HEAD_H;
  for (const p of panels) {
    const h = ROOM_HEAD + p.height;
    parts.push(`<g transform="translate(0,${y})">`);
    parts.push(
      `<rect x="${PLATE_X}" y="0" width="${plateW}" height="${h}" rx="16" fill="${PLATE_BG}" stroke="${PLATE_LINE}"/>`,
    );
    if (p.title) {
      parts.push(
        `<text x="${PLATE_X + PLATE_PAD + 2}" y="${ROOM_HEAD - 9}" fill="${MAP_INK}" font-size="13" font-weight="600" font-family="system-ui,sans-serif">${esc(p.title)}</text>`,
      );
      parts.push(
        `<text x="${W - PLATE_X - PLATE_PAD - 2}" y="${ROOM_HEAD - 9}" text-anchor="end" fill="${MAP_MUTED}" font-size="11.5" font-family="system-ui,sans-serif">空 ${p.free} / 共 ${p.total}${
          wantLabels && p.labeled < p.free ? ` · 标号 ${p.labeled}` : ''
        }</text>`,
      );
    }
    parts.push(`<g transform="translate(${PLATE_X + PLATE_PAD},${ROOM_HEAD})">${p.inner}</g>`);
    parts.push('</g>');
    y += h + 14;
  }

  const H = y - 14 + FOOT_H;
  parts.push(
    `<g transform="translate(${PLATE_X + 8},${H - 19})">`,
    `<circle cx="0" cy="0" r="4.2" fill="${MAP_FREE}"/>`,
    `<text x="9" y="4" fill="${MAP_MUTED}" font-size="11.5" font-family="system-ui,sans-serif">空闲</text>`,
    `<circle cx="62" cy="0" r="4.2" fill="${MAP_TAKEN}"/>`,
    `<text x="71" y="4" fill="${MAP_MUTED}" font-size="11.5" font-family="system-ui,sans-serif">已占</text>`,
    `<text x="${W - PLATE_X * 2 - 8}" y="4" text-anchor="end" fill="#5d6673" font-size="11" font-family="system-ui,sans-serif">圈里的数字是空位号，订座时说它就成</text>`,
    `</g>`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif">`,
    `<rect width="100%" height="100%" rx="18" fill="${MAP_BG}"/>`,
    parts.join(''),
    '</svg>',
  ].join('');
}

/** SVG 文本转义（房间名里有 & < > 时不至于把图弄坏） */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface SeatPoint {
  no: string;
  x?: number;
  y?: number;
  free: boolean;
  status: string;
}

function layoutSeatMap(
  pts: SeatPoint[],
  W: number,
  wantLabels: boolean,
  maxH = 600,
): { inner: string; width: number; height: number; labeled: number; freeCount: number } {
  const PAD = 10;
  const xs = pts.map((s) => s.x as number);
  const ys = pts.map((s) => s.y as number);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  /* 两个方向都留 1px，免得所有座位在同一水平/垂直线上时除零 */
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  /* 宽高都要装得下：取较小的那个比例，绝不把底部一排裁掉 */
  const scale = Math.min((W - PAD * 2) / spanX, (maxH - PAD * 2) / spanY);
  const usedW = spanX * scale;
  const usedH = spanY * scale;
  /* 房间里座位少的时候居中摆，不要都挤在左上角 */
  const ox = PAD + Math.max(0, (W - PAD * 2 - usedW) / 2);
  const oy = PAD + Math.max(0, (maxH - PAD * 2 - usedH) / 2);
  const H = Math.max(60, Math.round(usedH + PAD * 2));
  const r = Math.max(3.2, Math.min(8, scale * 0.62));

  const at = (s: SeatPoint) => ({
    cx: ox + ((s.x as number) - minX) * scale,
    cy: oy + ((s.y as number) - minY) * scale,
  });

  /* 已落位的标号盒子，用来做碰撞检测（数字估宽足够准） */
  const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const hit = (b: { x1: number; y1: number; x2: number; y2: number }) =>
    boxes.some((o) => !(b.x2 < o.x1 || b.x1 > o.x2 || b.y2 < o.y1 || b.y1 > o.y2));

  const free = pts.filter((s) => s.free);
  const fs = Math.max(8.5, Math.min(11.5, Math.round(scale * 0.95 * 10) / 10));
  const labels: string[] = [];
  let labeled = 0;

  /* 每个标号先试近处 8 个方位，再试远一圈；**只要会压到任何座位点就不标**，宁缺不糊 */
  const centers = pts.map((q) => at(q));

  if (wantLabels && free.length) {
    for (const seat of free.slice().sort((a, b) => a.no.localeCompare(b.no, 'zh'))) {
      const { cx, cy } = at(seat);
      const w = seat.no.length * fs * 0.6;
      const h = fs;

      const ring: number[] = [r + 1.6, r + 5, r + 9];
      const candidates: { x: number; y: number }[] = [];
      for (const gap of ring) {
        candidates.push(
          { x: cx + gap, y: cy + fs * 0.3 },
          { x: cx - gap - w, y: cy + fs * 0.3 },
          { x: cx - w / 2, y: cy + gap + h * 0.85 },
          { x: cx - w / 2, y: cy - gap - h * 0.12 },
          { x: cx + gap * 0.72, y: cy - gap * 0.72 },
          { x: cx - gap * 0.72 - w, y: cy - gap * 0.72 },
          { x: cx + gap * 0.72, y: cy + gap * 0.72 + h * 0.7 },
          { x: cx - gap * 0.72 - w, y: cy + gap * 0.72 + h * 0.7 },
        );
      }

      let box: { x1: number; y1: number; x2: number; y2: number } | undefined;
      for (const c of candidates) {
        const b = { x1: c.x, y1: c.y - h * 0.7, x2: c.x + w, y2: c.y + h * 0.3 };
        if (b.x1 < 2 || b.x2 > W - 2 || b.y1 < 1 || b.y2 > H - 1) continue;
        if (hit(b)) continue;
        const covers = centers.some(
          (q) => q.cx + r > b.x1 && q.cx - r < b.x2 && q.cy + r > b.y1 && q.cy - r < b.y2,
        );
        if (covers) continue;
        box = b;
        break;
      }
      if (!box) continue;

      boxes.push(box);
      labels.push(
        '<text x="' + box.x1.toFixed(1) + '" y="' + (box.y2 - 1).toFixed(1) +
          '" fill="#dcffea" font-size="' + fs + '" font-family="ui-monospace,monospace" letter-spacing="0.2"' +
          ' stroke="#06170d" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">' + seat.no + '</text>',
      );
      labeled++;
    }
  }

  const dots = pts
    .map((s) => {
      const { cx, cy } = at(s);
      /* 空位：亮绿点 + 一圈淡淡的光晕；已占：压暗的灰点，不抢视线 */
      const core = s.free
        ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${MAP_FREE}" data-seat="${esc(s.no)}"/>` +
          `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 2.1).toFixed(1)}" fill="${MAP_FREE}" opacity="0.13"/>`
        : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 0.92).toFixed(1)}" fill="${MAP_TAKEN}" data-seat="${esc(s.no)}"/>`;
      const tip = s.free ? '空闲' : s.status && !/^\d+$/.test(s.status) ? s.status : '已占';
      return `${core}<title>${s.no} · ${tip}</title>`;
    })
    .join('');

  /* 标号压不下时不在这里写字（会撞到最后一排座位），交给房间标题右边那句 */
  const inner = [dots, labels.join('')].join('');

  return { inner, width: W, height: H, labeled, freeCount: free.length };
}

/** 给 <img src> 用的 data URI（不依赖 btoa 的 latin1 限制） */
export function seatMapDataUri(m: LibSeatMap, opts: { width?: number; labels?: boolean } = {}): string | undefined {
  const svg = seatMapSvg(m, opts);
  if (!svg) return undefined;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export function renderSeatMap(m: LibSeatMap, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 40;
  const rows: string[] = [];
  const rooms = m.rooms ?? [];
  const multi = rooms.length > 1;
  const area = m.areaName ? ` · ${m.areaName}` : '';
  const freeSeats = m.seats.filter((s) => s.free);
  const meta = [m.date ? `日期 ${m.date}` : '', m.areaName ? m.areaName : m.areaId ? (AREA_NAMES[m.areaId] || `区域 ${m.areaId}`) : '']
    .filter(Boolean)
    .join(' · ');
  rows.push(`**图书馆座位图${area}**`, meta ? `${meta}\n` : '');
  if (!m.seats.length) {
    rows.push('没解析出座位（可能接口字段变了，或者座位图还没加载完）。');
    return rows.join('\n');
  }

  if (multi) {
    // 一层多间：先把房间列清楚，每间报一次余量
    const floor = m.areaName || '这一层';
    rows.push(`${floor}分了 **${rooms.length}** 间，共 ${m.seats.length} 个座位、空闲 **${freeSeats.length}** 个：`, '');
    for (const r of rooms) {
      const free = r.seats.filter((s) => s.free);
      rows.push(`- **${r.name || '未命名房间'}**：空 ${free.length} / 共 ${r.seats.length}`);
    }
    rows.push('', `图里每间房一块，块头写着房间名。只想知道某一间，就说「${floor} <房间名> 座位图」。`);
    rows.push('', '要订就说座位号（例如「订 001，今天」），确认时会让你长按按钮。');
    return rows.join('\n');
  }

  rows.push(`共 ${m.seats.length} 个座位，当前空闲 **${freeSeats.length}** 个。`);
  if (freeSeats.length) {
    const show = freeSeats.slice(0, limit).map((s) => s.no);
    rows.push(`空闲座位：${show.join('、')}${freeSeats.length > limit ? ` …还有 ${freeSeats.length - limit} 个` : ''}`);
  } else if (m.seats.every((s) => s.status === '' || NUMERIC_STATUS_RE.test(s.status))) {
    // 服务端只给数字编码时，别硬猜空闲/占用
    rows.push(
      '这个接口的状态是数字编码，我不敢猜哪个是"空"，所以没有替你标空闲。' +
        '在图书馆页面里看绿色座位（需要先在「我的 → 图书馆登录」登录）。',
    );
  }
  rows.push('', '要订就说座位号（例如「订 001，今天」），确认时会让你长按按钮。');
  return rows.join('\n');
}
