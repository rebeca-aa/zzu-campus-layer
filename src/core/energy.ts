/**
 * 宿舍电量（一卡通电控）。
 *
 * 协议来自 ZZU.Py 的 ECardClient（MIT），这里只用它查余额那一小段：
 *   1. GET  /server/auth/host/open?host=11&org=2&token=<CAS userToken>  → 302，Location 里带 tid
 *   2. POST /server/auth/getToken  { tid }                              → accessToken / refreshToken
 *   3. POST /server/utilities/account  Authorization: <accessToken>
 *          { utilityType:'electric', area, building, level, room, ... }  → 剩余电量
 *
 * 房间号形如 `99-1--1-101`（区域-楼--单元-房间）。
 */
import { getKV } from './kv';

export const ECARD_BASE = 'https://ecard.v.zzu.edu.cn';
/** accessToken 名义上 45 分钟一刷，这里保守一点按 30 分钟算 */
const TOKEN_TTL = 30 * 60_000;

/**
 * 一卡通这几个接口**没有 CORS 头**（实测：`OPTIONS` 预检直接 403，`GET /h5/index.html`
 * 不带 `Access-Control-Allow-Origin`），所以网页里 `fetch` 会被浏览器拦掉，
 * 只有两种环境能真的发出去：
 *   1. 安卓壳：走 `CampusNet.http` 这个原生通道；
 *   2. 扩展面板（MV3 侧栏）：有 host_permissions，浏览器放行。
 * 网页 PWA 里无论怎么写都发不出去，只能老实告诉用户。
 */
interface NativeNet {
  http?: (method: string, url: string, headersJson: string, body: string) => string;
}

function nativeNet(): NativeNet | null {
  const w = globalThis as unknown as { CampusNet?: NativeNet };
  return w.CampusNet && typeof w.CampusNet.http === 'function' ? w.CampusNet : null;
}

/** 当前环境能不能直接连一卡通（安卓壳 / 扩展里为 true） */
export function nativeNetAvailable(): boolean {
  return nativeNet() !== null;
}

export interface EcardResponse {
  status: number;
  text: string;
  /** 跳转目标：壳里是 Location 头，浏览器里是跟随之后的最终 URL */
  location: string;
}

async function ecardRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<EcardResponse> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const net = nativeNet();
  if (net?.http) {
    const raw = net.http(method, url, JSON.stringify(headers), payload);
    let parsed: { status?: number; body?: string; location?: string; error?: string };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new Error('壳里的网络通道返回了看不懂的东西。');
    }
    if (parsed.error) throw new Error(`壳里发请求失败：${parsed.error}`);
    return { status: parsed.status ?? 0, text: parsed.body ?? '', location: parsed.location ?? '' };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(payload ? { body: payload } : {}),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
    });
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('浏览器不让网页直接访问一卡通（跨域限制）：装安卓壳，或用电脑上的扩展面板。');
    }
    throw err;
  }
  return {
    status: res.status,
    text: await res.text(),
    location: res.url || res.headers.get('location') || '',
  };
}
export const ENERGY_KEY = 'energy';
export const ENERGY_STATE_KEY = 'energyState';
export const HISTORY_LIMIT = 60;
/** 低于这两个数就变黄 / 变红（度） */
export const WARN_LEVEL = 20;
export const LOW_LEVEL = 8;

export interface EnergyReading {
  /** 照明剩余（度） */
  light?: number;
  /** 空调剩余（度） */
  ac?: number;
  /** 服务端给的默认房间（如果有） */
  defaultRoom?: string;
  /** 这次读的时间 */
  at: string;
}

export interface EnergySettings {
  lightRoom?: string;
  acRoom?: string;
}

export interface EnergyPoint {
  /** YYYY-MM-DD */
  d: string;
  light?: number;
  ac?: number;
}

/** 房间号 → 接口要的四个字段 */
export function parseRoom(room: string): { area: string; building: string; level: string; room: string } | null {
  const m = /^(\d+)-(\d+)--(\d+)-(\d+)$/.exec(room.trim());
  if (!m) return null;
  return { area: m[1]!, building: m[2]!, level: m[3]!, room: room.trim() };
}

/** 从返回里猜一个"余额"数字：不同账号/校区字段名不完全一样，按关键词挑 */
export function pickBalance(node: unknown, depth = 0): number | undefined {
  if (!node || depth > 6) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = pickBalance(item, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  const wants = /(surplus|remain|balance|electric|energy|amount|quantity|available)/i;
  for (const [key, value] of Object.entries(obj)) {
    if (!wants.test(key)) continue;
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(n)) return n;
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const hit = pickBalance(value, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** 从返回里捞默认房间号（形如 99-1--1-101） */
export function pickRoom(node: unknown, depth = 0): string | undefined {
  if (!node || depth > 6) return undefined;
  if (typeof node === 'string') return parseRoom(node) ? node : undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = pickRoom(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string' && /room/i.test(key)) {
      const hit = pickRoom(value, depth + 1);
      if (hit) return hit;
    }
    if (value && typeof value === 'object') {
      const hit = pickRoom(value, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

let cached: { token: string; access: string; exp: number } | null = null;

/**
 * 拿到 ecard 的 accessToken（内部缓存 30 分钟）。
 *
 * ⚠️ 这里必须 `redirect: 'follow'` 而不是 `'manual'`：
 * 浏览器里 `redirect:'manual'` 拿到的是 opaque-redirect，**读不到 Location 头**
 * （`headers.get('location')` 恒为 null、`status` 恒为 0），
 * 跟着跳转过去反而能从 `res.url` 里直接看见 `?tid=…`。
 * 之前用 manual，网页版永远判定「一卡通没认这个登录态」，自动识别一次都没成功过。
 */
export async function ecardToken(userToken: string, now = Date.now()): Promise<string> {
  if (cached && cached.token === userToken && cached.exp > now) return cached.access;
  const open = await ecardRequest(
    'GET',
    `${ECARD_BASE}/server/auth/host/open?host=11&org=2&token=${encodeURIComponent(userToken)}`,
  );
  const tid = /[?&]tid=([^&#]+)/.exec(open.location)?.[1];
  if (!tid) throw new Error('一卡通没认这个登录态：去「我的 → 账号」重新登录一次试试。');
  const res = await ecardRequest('POST', `${ECARD_BASE}/server/auth/getToken`, {}, {
    tid: decodeURIComponent(tid),
  });
  let json: { resultData?: { accessToken?: string } };
  try {
    json = JSON.parse(res.text) as typeof json;
  } catch {
    throw new Error('一卡通换 token 时返回了看不懂的内容。');
  }
  const access = json.resultData?.accessToken;
  if (!access) throw new Error('一卡通没给 accessToken（可能登录态过期了）。');
  cached = { token: userToken, access, exp: now + TOKEN_TTL };
  return access;
}

/** 查询某个房间的剩余电量；room 为空时由服务端给默认房间 */
export async function fetchRoomBalance(userToken: string, room: string): Promise<{ balance: number; defaultRoom?: string }> {
  const parsed = parseRoom(room);
  if (!parsed) throw new Error(`房间号格式不对：${room}（应该像 99-1--1-101）`);
  const access = await ecardToken(userToken);
  const res = await ecardRequest('POST', `${ECARD_BASE}/server/utilities/account`, { authorization: access }, {
    utilityType: 'electric',
    bigArea: '',
    area: parsed.area,
    building: parsed.building,
    unit: '',
    level: parsed.level,
    room: parsed.room,
    subArea: '',
  });
  let json: unknown;
  try {
    json = JSON.parse(res.text) as unknown;
  } catch {
    throw new Error('一卡通返回了看不懂的内容，可能登录态过期了。');
  }
  const balance = pickBalance(json);
  if (balance === undefined) throw new Error('一卡通没返回能看懂的余额，可能这个房间号不存在。');
  return { balance, ...(pickRoom(json) ? { defaultRoom: pickRoom(json) } : {}) };
}

/**
 * 用「空房间号」问一次：如果服务端认得出你绑定的房间，会把房间号一起带回来。
 *
 * 这条路来自 `zzupy` 的 `get_default_room()`——**走的是 `/server/utilities/config`**
 * （body 只有 `{utilityType:'electric'}`），返回 `resultData.location.room`。
 * 早先我照着 account 接口空着房间号问，那条路服务端不认，所以永远问不出来。
 */
export async function discoverRoom(userToken: string): Promise<string | undefined> {
  const access = await ecardToken(userToken);
  const res = await ecardRequest('POST', `${ECARD_BASE}/server/utilities/config`, { authorization: access }, {
    utilityType: 'electric',
  });
  let json: { resultData?: { location?: { room?: unknown } } };
  try {
    json = JSON.parse(res.text) as typeof json;
  } catch {
    return undefined;
  }
  const room = json.resultData?.location?.room;
  if (typeof room === 'string' && parseRoom(room)) return room;
  return pickRoom(json);
}

const LOCATION_URL = `${ECARD_BASE}/server/utilities/location`;

export interface PlaceOption {
  id: string;
  name: string;
}

/**
 * 由「上一级的 id」推出 `/server/utilities/location` 要什么参数。
 *
 * 层级按 id 里 `-` 的个数判断（和 `zzupy.get_room_dict()` 一致）：
 * `''` → 校区、`99` → 楼、`99-1` → 单元、`99-1--1` → 房间。
 */
export function locationQuery(parentId: string): {
  locationType: 'bigArea' | 'building' | 'unit' | 'room';
  area: string;
  building: string;
  level: string;
} | null {
  const id = parentId.trim();
  if (!id) return { locationType: 'bigArea', area: '', building: '', level: '' };
  const dashes = id.split('-').length - 1;
  if (dashes === 0) return { locationType: 'building', area: id, building: '', level: '' };
  if (dashes === 1) {
    const [area = '', building = ''] = id.split('-');
    return { locationType: 'unit', area, building, level: '' };
  }
  if (dashes === 3) {
    const [head = '', tail = ''] = id.split('--');
    const [area = '', building = ''] = head.split('-');
    const level = tail.split('-')[0] ?? '';
    return { locationType: 'room', area, building, level };
  }
  return null;
}

/** 拉下一级的房间/楼/层列表（校园卡没绑房间时，用它让用户选题） */
export async function fetchPlaces(userToken: string, parentId = ''): Promise<PlaceOption[]> {
  const query = locationQuery(parentId);
  if (!query) throw new Error(`房间号格式不对：${parentId}`);
  const access = await ecardToken(userToken);
  const res = await ecardRequest('POST', LOCATION_URL, { authorization: access }, {
    utilityType: 'electric',
    locationType: query.locationType,
    bigArea: '',
    area: query.area,
    building: query.building,
    unit: '',
    level: query.level,
    room: '',
    subArea: '',
  });
  let json: { resultData?: { locationList?: unknown } };
  try {
    json = JSON.parse(res.text) as typeof json;
  } catch {
    return [];
  }
  const list = json.resultData?.locationList;
  if (!Array.isArray(list)) return [];
  const out: PlaceOption[] = [];
  for (const item of list) {
    const id = (item as { id?: unknown }).id;
    const name = (item as { name?: unknown }).name;
    if (typeof id === 'string' && id && typeof name === 'string' && name) out.push({ id, name });
  }
  return out;
}

/** 一次读照明 + 空调两组表 */
export async function readEnergy(userToken: string, settings: EnergySettings): Promise<EnergyReading> {
  const at = new Date().toISOString();
  const out: EnergyReading = { at };
  if (!settings.lightRoom && !settings.acRoom) throw new Error('还没设置房间号：先点「设置房间」填一次。');
  if (settings.lightRoom) {
    const r = await fetchRoomBalance(userToken, settings.lightRoom);
    out.light = r.balance;
    if (r.defaultRoom) out.defaultRoom = r.defaultRoom;
  }
  if (settings.acRoom) {
    const r = await fetchRoomBalance(userToken, settings.acRoom);
    out.ac = r.balance;
  }
  return out;
}

export function loadSettings(kv = getKV()): Promise<EnergySettings> {
  return kv.get<EnergySettings>(ENERGY_STATE_KEY).then((s) => (s && typeof s === 'object' ? s : {}));
}

export function saveSettings(s: EnergySettings, kv = getKV()): Promise<void> {
  return kv.set(ENERGY_STATE_KEY, s);
}

export function loadHistory(kv = getKV()): Promise<EnergyPoint[]> {
  return kv.get<EnergyPoint[]>(ENERGY_KEY).then((list) => (Array.isArray(list) ? list.filter((p) => p && typeof p.d === 'string') : []));
}

export function saveHistory(list: EnergyPoint[], kv = getKV()): Promise<void> {
  return kv.set(ENERGY_KEY, list);
}

/** 同一天只留最后一条，最多 HISTORY_LIMIT 天 */
export function pushPoint(list: EnergyPoint[], point: EnergyPoint): EnergyPoint[] {
  const rest = list.filter((p) => p.d !== point.d);
  const next = [...rest, point].sort((a, b) => a.d.localeCompare(b.d));
  return next.slice(Math.max(0, next.length - HISTORY_LIMIT));
}

export function levelOf(v: number | undefined): 'ok' | 'warn' | 'low' | 'none' {
  if (v === undefined) return 'none';
  if (v <= LOW_LEVEL) return 'low';
  if (v <= WARN_LEVEL) return 'warn';
  return 'ok';
}
