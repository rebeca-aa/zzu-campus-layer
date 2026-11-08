import { describe, expect, it } from 'vitest';
import { parseWeather, rainReminder, weatherIcon, weatherLabel } from '../src/core/weather';

describe('天气码 → 中文 / 图标', () => {
  it('常见天气', () => {
    expect(weatherLabel(0)).toBe('晴');
    expect(weatherLabel(3)).toBe('阴');
    expect(weatherLabel(61)).toBe('小雨');
    expect(weatherLabel(95)).toBe('雷阵雨');
  });

  it('没见过的码不炸', () => {
    expect(weatherLabel(1234)).toBe('未知');
    expect(weatherIcon(1234)).toBe('cloud');
  });

  it('图标按大类归', () => {
    expect(weatherIcon(0)).toBe('sun');
    expect(weatherIcon(2)).toBe('cloud');
    expect(weatherIcon(63)).toBe('rain');
    expect(weatherIcon(73)).toBe('snow');
    expect(weatherIcon(45)).toBe('fog');
  });
});

const SAMPLE = {
  current: {
    time: '2026-11-08T15:30',
    temperature_2m: 12.2,
    apparent_temperature: 7.8,
    weather_code: 2,
    relative_humidity_2m: 55,
    wind_speed_10m: 19.4,
  },
  daily: {
    time: ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'],
    weather_code: [80, 51, 1, 3],
    temperature_2m_max: [15.7, 13.3, 12.5, 17.1],
    temperature_2m_min: [8.0, 5.9, 1.9, 4.4],
    precipitation_probability_max: [100, 94, 0, null],
  },
  hourly: {
    time: ['2026-11-08T14:00', '2026-11-08T15:00', '2026-11-08T16:00'],
    temperature_2m: [13.1, 12.2, 11.4],
    weather_code: [61, 2, 3],
    precipitation_probability: [80, 20, 0],
  },
};

describe('parseWeather', () => {
  it('实时 + 四天预报都能解出来', () => {
    const w = parseWeather(SAMPLE, 1000);
    expect(w.fetchedAt).toBe(1000);
    expect(w.now.temp).toBe(12.2);
    expect(w.now.feels).toBe(7.8);
    expect(w.now.label).toBe('多云');
    expect(w.days.map((d) => d.date)).toEqual([
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
    ]);
    expect(w.days[0]).toMatchObject({ label: '阵雨', icon: 'rain', max: 15.7, min: 8, rain: 100 });
    expect(w.days[3]!.rain).toBeNull();
    expect(w.hours).toHaveLength(3);
    expect(w.hours[1]).toMatchObject({ time: '2026-11-08T15:00', temp: 12.2, icon: 'cloud', rain: 20 });
  });

  it('缺字段直接报错，不把半份数据塞给界面', () => {
    expect(() => parseWeather({})).toThrow();
    expect(() => parseWeather({ current: SAMPLE.current })).toThrow();
    expect(() => parseWeather({ current: SAMPLE.current, daily: { time: ['x'], weather_code: [1] } })).toThrow();
  });
});

describe('rainReminder', () => {
  it('有雨就提示带伞，并带上降水概率', () => {
    const msg = rainReminder({ date: '2026-11-08', code: 61, label: '小雨', icon: 'rain', max: 13, min: 6, rain: 94 });
    expect(msg).toContain('带伞');
    expect(msg).toContain('94');
  });

  it('雷阵雨单独提醒', () => {
    const msg = rainReminder({ date: '2026-11-08', code: 95, label: '雷阵雨', icon: 'thunder', max: 20, min: 10, rain: 70 });
    expect(msg).toContain('雷');
  });

  it('晴天 / 没数据不提示', () => {
    expect(rainReminder({ date: '2026-11-08', code: 0, label: '晴', icon: 'sun', max: 20, min: 8, rain: 0 })).toBeNull();
    expect(rainReminder(undefined)).toBeNull();
  });
});
