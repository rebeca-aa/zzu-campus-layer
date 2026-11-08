/**
 * 天气：Open-Meteo（免费、无需 key、CORS 全开）。
 *
 * 坐标写死主校区（郑州大学新校区附近），不申请定位权限。
 * 只取「昨天 / 今天 / 明天 / 后天」四天 + 实时，30 分钟缓存；
 * 拉失败时退回上一次缓存（哪怕过期），界面上标明是旧数据。
 */
import { getKV } from './kv';

export interface WeatherDay {
  date: string;
  code: number;
  label: string;
  icon: WeatherIconName;
  max: number;
  min: number;
  /** 降水概率 %；接口没给就是 null */
  rain: number | null;
}

export interface WeatherNow {
  temp: number;
  feels: number;
  code: number;
  label: string;
  icon: WeatherIconName;
  humidity?: number;
  wind?: number;
  at: string;
}

export interface WeatherHour {
  /** '2026-11-08T15:00'（已是北京时间） */
  time: string;
  temp: number;
  code: number;
  icon: WeatherIconName;
  rain: number | null;
}

export interface Weather {
  now: WeatherNow;
  days: WeatherDay[];
  /** 今天 24 小时的逐小时预报 */
  hours: WeatherHour[];
  /** 这份数据是什么时候拉的（毫秒） */
  fetchedAt: number;
}

export type WeatherIconName =
  | 'sun'
  | 'partly'
  | 'cloud'
  | 'overcast'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'sleet'
  | 'thunder';

const KEY = 'weather';
const TTL = 30 * 60_000;

/** 主校区（郑大新校区）大致坐标 */
export const ZHENGZHOU = { latitude: 34.817, longitude: 113.531 };

const CODES: Record<number, { label: string; icon: WeatherIconName }> = {
  0: { label: '晴', icon: 'sun' },
  1: { label: '晴间多云', icon: 'partly' },
  2: { label: '多云', icon: 'cloud' },
  3: { label: '阴', icon: 'overcast' },
  45: { label: '有雾', icon: 'fog' },
  48: { label: '雾凇', icon: 'fog' },
  51: { label: '小毛毛雨', icon: 'drizzle' },
  53: { label: '毛毛雨', icon: 'drizzle' },
  55: { label: '大毛毛雨', icon: 'drizzle' },
  56: { label: '冻毛毛雨', icon: 'sleet' },
  57: { label: '强冻毛毛雨', icon: 'sleet' },
  61: { label: '小雨', icon: 'rain' },
  63: { label: '中雨', icon: 'rain' },
  65: { label: '大雨', icon: 'rain' },
  66: { label: '冻雨', icon: 'sleet' },
  67: { label: '强冻雨', icon: 'sleet' },
  71: { label: '小雪', icon: 'snow' },
  73: { label: '中雪', icon: 'snow' },
  75: { label: '大雪', icon: 'snow' },
  77: { label: '米雪', icon: 'snow' },
  80: { label: '阵雨', icon: 'rain' },
  81: { label: '强阵雨', icon: 'rain' },
  82: { label: '暴阵雨', icon: 'rain' },
  85: { label: '小阵雪', icon: 'snow' },
  86: { label: '大阵雪', icon: 'snow' },
  95: { label: '雷阵雨', icon: 'thunder' },
  96: { label: '雷暴伴冰雹', icon: 'thunder' },
  99: { label: '强雷暴伴冰雹', icon: 'thunder' },
};

/** WMO 天气码 → 中文说法 */
export function weatherLabel(code: number): string {
  return CODES[code]?.label ?? '未知';
}

/** WMO 天气码 → 画哪个图标 */
export function weatherIcon(code: number): WeatherIconName {
  return CODES[code]?.icon ?? 'cloud';
}

function apiUrl(): string {
  const q = new URLSearchParams({
    latitude: String(ZHENGZHOU.latitude),
    longitude: String(ZHENGZHOU.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    timezone: 'Asia/Shanghai',
    past_days: '1',
    forecast_days: '3',
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

interface RawWeather {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: (number | null)[];
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    weather_code?: number[];
    precipitation_probability?: (number | null)[];
  };
}

/** 接口 JSON → 界面用的结构；脏数据整块丢掉 */
export function parseWeather(raw: unknown, fetchedAt = Date.now()): Weather {
  const o = raw as RawWeather;
  const cur = o?.current;
  const daily = o?.daily;
  if (!cur || typeof cur.temperature_2m !== 'number' || typeof cur.weather_code !== 'number') {
    throw new Error('天气接口返回的数据不完整');
  }
  if (!daily?.time?.length || !daily.weather_code?.length) {
    throw new Error('天气接口没给预报');
  }
  const days: WeatherDay[] = daily.time.map((date, i) => {
    const code = daily.weather_code?.[i] ?? 0;
    const max = daily.temperature_2m_max?.[i];
    const min = daily.temperature_2m_min?.[i];
    if (typeof max !== 'number' || typeof min !== 'number') {
      throw new Error('天气接口没给温度');
    }
    const rain = daily.precipitation_probability_max?.[i];
    return {
      date,
      code,
      label: weatherLabel(code),
      icon: weatherIcon(code),
      max,
      min,
      rain: typeof rain === 'number' ? rain : null,
    };
  });
  const hours: WeatherHour[] = [];
  const ht = o.hourly?.time ?? [];
  const htemp = o.hourly?.temperature_2m ?? [];
  const hcode = o.hourly?.weather_code ?? [];
  const hrain = o.hourly?.precipitation_probability ?? [];
  for (let i = 0; i < ht.length; i += 1) {
    const time = ht[i];
    const temp = htemp[i];
    const code = hcode[i];
    if (typeof time !== 'string' || typeof temp !== 'number' || typeof code !== 'number') continue;
    const rain = hrain[i];
    hours.push({
      time,
      temp,
      code,
      icon: weatherIcon(code),
      rain: typeof rain === 'number' ? rain : null,
    });
  }

  return {
    now: {
      temp: cur.temperature_2m,
      feels: typeof cur.apparent_temperature === 'number' ? cur.apparent_temperature : cur.temperature_2m,
      code: cur.weather_code,
      label: weatherLabel(cur.weather_code),
      icon: weatherIcon(cur.weather_code),
      ...(typeof cur.relative_humidity_2m === 'number' ? { humidity: cur.relative_humidity_2m } : {}),
      ...(typeof cur.wind_speed_10m === 'number' ? { wind: cur.wind_speed_10m } : {}),
      at: typeof cur.time === 'string' ? cur.time : '',
    },
    days,
    hours,
    fetchedAt,
  };
}

export interface DressAdvice {
  /** 主建议：穿什么 */
  main: string;
  /** 附加提醒：带伞 / 防滑 / 防风，没有就是空串 */
  extra: string;
}

/** 按「体感/代表温度」给着装建议；晚上 22 点后会用明天的温度调这个函数 */
export function dressAdviceFor(temp: number, day?: WeatherDay, wind = 0): DressAdvice {
  const t = Math.round(temp);
  let main: string;
  if (t >= 30) main = '短袖短裤，注意防晒';
  else if (t >= 24) main = '短袖 + 薄外套';
  else if (t >= 18) main = '长袖 + 薄外套';
  else if (t >= 12) main = '毛衣 + 外套';
  else if (t >= 5) main = '厚外套 / 棉服';
  else main = '羽绒服 + 围巾手套';

  let extra = '';
  const icon = day?.icon;
  if (icon === 'rain' || icon === 'drizzle' || icon === 'thunder') extra = '有雨，记得带伞';
  else if (icon === 'snow' || icon === 'sleet') extra = '有雨雪，注意防滑';
  else if (wind >= 35) extra = '风大，加件防风外套';
  return { main, extra };
}

/** 今日着装建议：按体感温度分档，再看有没有雨雪、风大不大 */
export function dressAdvice(now: WeatherNow, day?: WeatherDay): DressAdvice {
  return dressAdviceFor(now.feels, day ?? { icon: now.icon } as WeatherDay, now.wind ?? 0);
}

/** 今天有没有雨：看今天的天气码和降水概率，返回给用户看的一句话（没雨返回 null） */
export function rainReminder(day: WeatherDay | undefined): string | null {
  if (!day) return null;
  const rainy = day.icon === 'rain' || day.icon === 'drizzle' || day.icon === 'thunder' || day.icon === 'sleet';
  const chance = day.rain ?? 0;
  if (!rainy && chance < 50) return null;
  const tail = chance > 0 ? `（降水概率 ${chance}%）` : '';
  if (day.icon === 'thunder') return `今天有雷阵雨${tail}，出门带伞，尽量别在树下停留。`;
  if (day.icon === 'snow' || day.icon === 'sleet') return `今天有雨雪${tail}，路滑，注意保暖。`;
  return `今天有雨${tail}，出门记得带伞。`;
}

async function readCache(): Promise<{ at: number; data: Weather } | null> {
  try {
    const raw = await getKV().get<{ at: number; data: Weather }>(KEY);
    if (!raw || typeof raw.at !== 'number' || !raw.data?.now || !Array.isArray(raw.data.days)) return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeCache(data: Weather): Promise<void> {
  try {
    await getKV().set(KEY, { at: Date.now(), data });
  } catch {
    /* 存不下就算了 */
  }
}

/**
 * 拉天气。30 分钟内直接读缓存；过期就重拉，拉失败退回旧缓存（用 fetchedAt 判断新鲜度）。
 */
export async function loadWeather(now = Date.now(), force = false): Promise<Weather> {
  const cached = await readCache();
  if (cached && !force && now - cached.at < TTL) return cached.data;

  try {
    const res = await fetch(apiUrl(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`天气接口 HTTP ${res.status}`);
    const data = parseWeather(await res.json(), now);
    void writeCache(data);
    return data;
  } catch (e) {
    if (cached) return cached.data;
    throw e instanceof Error ? e : new Error(String(e));
  }
}
