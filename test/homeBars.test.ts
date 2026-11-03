import { describe, expect, it } from 'vitest';
import {
  CARD_HOME_BAR_ID,
  HOME_BARS_KEY,
  HOME_BARS_VERSION,
  MAX_HOME_BARS,
  MAX_HOME_BAR_LABEL,
  MAX_HOME_BAR_TEXT,
  addHomeBar,
  createCardBar,
  isCardBar,
  loadHomeBars,
  normalizeHomeBars,
  removeHomeBar,
  saveHomeBars,
  setCardBarVisible,
  updateHomeBar,
  type HomeBar,
} from '../src/core/homeBars';
import type { KV } from '../src/core/kv';

/** 内存版 KV：node 环境里也能跑，不碰 localStorage。 */
function memKV(seed: Record<string, unknown> = {}): KV {
  const store: Record<string, unknown> = { ...seed };
  return {
    async get<T>(key: string) {
      return store[key] as T | undefined;
    },
    async set(key: string, value: unknown) {
      store[key] = JSON.parse(JSON.stringify(value));
    },
    async remove(key: string) {
      delete store[key];
    },
  };
}

const list = (...texts: string[]): HomeBar[] => texts.map((text, i) => ({ id: `id-${i}`, label: text, text }));

describe('normalizeHomeBars', () => {
  it('非数组一律不认', () => {
    expect(normalizeHomeBars(undefined)).toBeUndefined();
    expect(normalizeHomeBars(null)).toBeUndefined();
    expect(normalizeHomeBars({})).toBeUndefined();
    expect(normalizeHomeBars('x')).toBeUndefined();
  });

  it('接受纯字符串、label/text、title/prompt 几种写法', () => {
    const out = normalizeHomeBars([
      '问空教室',
      { label: '拿快递', text: '帮我看看校园卡余额' },
      { title: '问课表', prompt: '明天有课吗' },
    ]);
    expect(out?.map((b) => [b.label, b.text])).toEqual([
      ['问空教室', '问空教室'],
      ['拿快递', '帮我看看校园卡余额'],
      ['问课表', '明天有课吗'],
    ]);
    expect(out?.every((b) => b.id)).toBe(true);
  });

  it('缺 label 时用正文顶上，缺正文时用 label 顶上', () => {
    const out = normalizeHomeBars([{ text: '只给了正文' }, { label: '只给了标题' }]);
    expect(out?.[0]?.label).toBe('只给了正文');
    expect(out?.[1]?.text).toBe('只给了标题');
  });

  it('空白字符压成一行，超长截断', () => {
    const out = normalizeHomeBars([{ label: '  我的\n标题  ', text: `  第一行\n第二行 ${'x'.repeat(500)}` }]);
    expect(out?.[0]?.label).toBe('我的 标题');
    expect(out?.[0]?.text.startsWith('第一行 第二行')).toBe(true);
    expect(out?.[0]?.text.length).toBe(MAX_HOME_BAR_TEXT);
    expect((normalizeHomeBars([{ label: 'y'.repeat(100), text: 'z' }])?.[0]?.label ?? '').length).toBe(MAX_HOME_BAR_LABEL);
  });

  it('正文重复的只留第一条，空正文直接丢掉，最多 MAX_HOME_BARS 条', () => {
    const many = Array.from({ length: MAX_HOME_BARS + 3 }, (_, i) => ({ label: `t${i}`, text: `p${i}` }));
    const out = normalizeHomeBars([{ label: 'a', text: ' ' }, { label: 'b', text: 'dup' }, { label: 'c', text: 'dup' }, ...many]);
    expect(out?.length).toBe(MAX_HOME_BARS);
    expect(out?.filter((b) => b.text === 'dup').length).toBe(1);
    expect(out?.some((b) => b.text === '')).toBe(false);
  });
});

describe('loadHomeBars / saveHomeBars', () => {
  it('没存过就自带图书馆、空教室和一卡通三条', async () => {
    const bars = await loadHomeBars(memKV());
    expect(bars.map((b) => b.label)).toEqual(['图书馆', '空教室', '校园卡']);
    expect(bars.map((b) => b.text)).toEqual(['今天图书馆一楼空余座位图', '南核空教室', '']);
    expect(isCardBar(bars[2]!)).toBe(true);
  });

  it('存坏了也回落成默认三条', async () => {
    expect((await loadHomeBars(memKV({ [HOME_BARS_KEY]: { v: 1, items: 'oops' } }))).length).toBe(3);
    expect((await loadHomeBars(memKV({ [HOME_BARS_KEY]: 42 }))).length).toBe(3);
  });

  it('v1 老数据补上默认两条和一卡通，用户的栏留在前面', async () => {
    const kv = memKV({ [HOME_BARS_KEY]: { v: 1, items: [{ id: 'x', label: '查卡', text: '我卡里还有多少钱' }] } });
    const bars = await loadHomeBars(kv);
    expect(bars.map((b) => b.label)).toEqual(['查卡', '图书馆', '空教室', '校园卡']);
    expect(isCardBar(bars[bars.length - 1]!)).toBe(true);
  });

  it('v2 明确存了空列表就是空列表，不再塞默认', async () => {
    expect(await loadHomeBars(memKV({ [HOME_BARS_KEY]: { v: HOME_BARS_VERSION, items: [] } }))).toEqual([]);
  });

  it('存进去的是洗过的版本，读出来一样', async () => {
    const kv = memKV();
    const saved = await saveHomeBars([{ id: 'a', label: ' 标题 ', text: ' 内容 ' }], kv);
    expect(saved).toEqual([{ id: 'a', label: '标题', text: '内容' }]);
    expect(await loadHomeBars(kv)).toEqual(saved);
  });
});

describe('一卡通栏', () => {
  it('开 / 关只动最后那一条', () => {
    const chat = list('a', 'b');
    const on = setCardBarVisible(chat, true);
    expect(on.length).toBe(3);
    expect(isCardBar(on[2]!)).toBe(true);
    expect(setCardBarVisible(on, false).map((b) => b.label)).toEqual(['a', 'b']);
  });

  it('只认一条，标签缺省叫校园卡', () => {
    const out = normalizeHomeBars([{ kind: 'card' }, { kind: 'card' }, { label: 'x', text: 'y' }]);
    expect(out?.length).toBe(2);
    expect(out?.[0]).toEqual({ id: CARD_HOME_BAR_ID, kind: 'card', label: '校园卡', text: '' });
  });

  it('改 / 加都不影响一卡通', () => {
    const card = createCardBar();
    expect(updateHomeBar([card], CARD_HOME_BAR_ID, { text: 'x' })).toEqual([card]);
    expect(removeHomeBar([...list('a'), card], CARD_HOME_BAR_ID).map((b) => b.id)).toEqual(['id-0']);
  });
});

describe('add / update / remove', () => {
  it('加一条：自动补标题、保留用户写的标题', () => {
    expect(addHomeBar([], '明天有课吗')).toEqual([expect.objectContaining({ label: '明天有课吗', text: '明天有课吗' })]);
    expect(addHomeBar([], '明天有课吗', '课表')).toEqual([expect.objectContaining({ label: '课表', text: '明天有课吗' })]);
  });

  it('加一条：空内容、重复、超上限都报中文错', () => {
    expect(() => addHomeBar([], '   ')).toThrow('写点内容再保存');
    expect(() => addHomeBar(list('a'), ' a ')).toThrow('这句已经在里面了');
    expect(() => addHomeBar(list(...Array.from({ length: MAX_HOME_BARS }, (_, i) => `p${i}`)), '新的')).toThrow(
      `最多 ${MAX_HOME_BARS} 条，先删一条再加`,
    );
  });

  it('改一条：换标题不改正文，正文重复或空要报错', () => {
    const items = [{ id: 'a', label: '旧', text: '正文' }, { id: 'b', label: '别的', text: '另一句' }];
    expect(updateHomeBar(items, 'a', { label: '新标题' })[0]).toEqual({ id: 'a', label: '新标题', text: '正文' });
    expect(() => updateHomeBar(items, 'a', { text: '' })).toThrow('内容不能是空的');
    expect(() => updateHomeBar(items, 'a', { text: '另一句' })).toThrow('这句已经在里面了');
    expect(updateHomeBar(items, 'nope', { label: 'x' })).toBe(items);
  });

  it('删一条只删指定的那条', () => {
    const items = list('a', 'b', 'c');
    expect(removeHomeBar(items, 'id-1').map((b) => b.text)).toEqual(['a', 'c']);
  });
});
