import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareVersion, isNewer, parseRelease, shouldAnnounce } from '../pwa/update';

describe('版本号比较', () => {
  it('逐段按数字比，不当成小数', () => {
    expect(compareVersion('0.2.10', '0.2.9')).toBe(1);
    expect(compareVersion('0.2.9', '0.2.10')).toBe(-1);
    expect(compareVersion('0.3.0', '0.2.99')).toBe(1);
  });

  it('段数不一样时缺的按 0 算', () => {
    expect(compareVersion('0.3', '0.3.0')).toBe(0);
    expect(compareVersion('0.3.1', '0.3')).toBe(1);
  });

  it('一样就返回 0', () => {
    expect(compareVersion('0.2.75', '0.2.75')).toBe(0);
  });
});

describe('要不要提示有新版本', () => {
  it('远端更新才提示', () => {
    expect(isNewer('0.2.76', '0.2.75')).toBe(true);
    expect(isNewer('0.2.75', '0.2.75')).toBe(false);
    expect(isNewer('0.2.74', '0.2.75')).toBe(false);
  });

  it('本地版本号是空的就不提示（构建没注入版本）', () => {
    expect(isNewer('0.2.76', '')).toBe(false);
  });
});

describe('更新公告', () => {
  it('本地比上次记录的新才弹', () => {
    expect(shouldAnnounce('0.2.76', '0.2.75')).toBe(true);
    expect(shouldAnnounce('0.2.75', '0.2.75')).toBe(false);
    expect(shouldAnnounce('0.2.74', '0.2.75')).toBe(false);
  });

  it('第一次装（没有记录）不弹公告', () => {
    expect(shouldAnnounce('0.2.75', null)).toBe(false);
  });
});

describe('version.json 解析', () => {
  it('正常内容原样带出来', () => {
    const r = parseRelease({ version: '0.2.76', notes: ['修了 A', '加了 B'], publishedAt: '2026-10-30T00:00:00Z' });
    expect(r).toEqual({ version: '0.2.76', notes: ['修了 A', '加了 B'], publishedAt: '2026-10-30T00:00:00Z' });
  });

  it('脏数据不会炸：没版本号返回 null，notes 里的空串和非字符串被扔掉', () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({})).toBeNull();
    expect(parseRelease({ version: 'x' })).toBeNull();
    expect(parseRelease({ version: '0.2.76', notes: ['ok', '', 3, null] })?.notes).toEqual(['ok']);
  });

  it('notes 最多留 6 条，避免公告撑满屏', () => {
    const many = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 条`);
    expect(parseRelease({ version: '1.0.0', notes: many })?.notes).toHaveLength(6);
  });
});

describe('仓库里的 version.json 跟 package.json 对得上', () => {
  it('两个版本号必须一致，否则发版会漏改', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const release = JSON.parse(readFileSync(new URL('../public/version.json', import.meta.url), 'utf8')) as {
      version: string;
      notes: string[];
    };
    expect(release.version).toBe(pkg.version);
    expect(release.notes.length).toBeGreaterThan(0);
  });
});
