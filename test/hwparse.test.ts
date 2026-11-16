import { describe, expect, it } from 'vitest';
import { normalizeLlmItems, parseHomeworkSmart, sameHomeworkTitle } from '../src/core/hwParse';

/** 与 homework.test.ts 对齐：2026-11-13 09:00 周五 */
const NOW = new Date(2026, 10, 13, 9, 0, 0, 0).getTime();
const DAY = 86_400_000;

const SETTINGS = { enabled: true, provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' };
const MESSAGE = '@所有人 高数作业：习题册 3.1–3.4 周五前交，纸质交到学委那儿。';

describe('parseHomeworkSmart', () => {
  it('有 Key 就用模型结果（容忍 ```json 包裹）', async () => {
    const chat = async () =>
      '```json\n{"items":[{"title":"习题册 3.1–3.4","course":"高等数学","due":"2026-11-20T23:59:00+08:00","note":"交纸质"}]}\n```';
    const out = await parseHomeworkSmart(MESSAGE, { now: NOW, settings: SETTINGS, chat });
    expect(out.via).toBe('llm');
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]!.title).toBe('习题册 3.1–3.4');
    expect(out.drafts[0]!.course).toBe('高等数学');
    expect(out.drafts[0]!.note).toBe('交纸质');
    expect(out.drafts[0]!.dueAt).toBe(new Date('2026-11-20T23:59:00+08:00').getTime());
    expect(out.note).toContain('DeepSeek');
  });

  it('模型漏掉的条目由规则补进来', async () => {
    /* 模型只认出第一条，第二条（英语作文）漏了 */
    const chat = async () => '{"items":[{"title":"习题册 3.1–3.4","due":"2026-11-20T23:59:00+08:00"}]}';
    const text = `${MESSAGE}英语作文二记得传雨课堂，周日晚上12点前。`;
    const out = await parseHomeworkSmart(text, { now: NOW, settings: SETTINGS, chat });
    expect(out.via).toBe('llm');
    expect(out.drafts.some((d) => d.title.includes('英语作文'))).toBe(true);
    expect(out.note).toContain('规则补了');
  });

  it('模型调用失败退回规则，并说明原因', async () => {
    const chat = async () => {
      throw new Error('连不上 DeepSeek 官方');
    };
    const out = await parseHomeworkSmart(MESSAGE, { now: NOW, settings: SETTINGS, chat });
    expect(out.via).toBe('rule');
    expect(out.note).toContain('先用规则识别');
    expect(out.drafts.length).toBeGreaterThan(0);
    expect(out.drafts[0]!.title).toContain('习题册');
  });

  it('没填 Key 不打网络请求，直接用规则', async () => {
    let called = false;
    const chat = async () => {
      called = true;
      return '{}';
    };
    const out = await parseHomeworkSmart(MESSAGE, {
      now: NOW,
      settings: { ...SETTINGS, apiKey: '  ' },
      chat,
    });
    expect(called).toBe(false);
    expect(out.via).toBe('rule');
    expect(out.note).toContain('还没填模型 Key');
  });

  it('设置里关掉模型就不问模型', async () => {
    let called = false;
    const chat = async () => {
      called = true;
      return '{}';
    };
    const out = await parseHomeworkSmart(MESSAGE, { now: NOW, settings: { ...SETTINGS, enabled: false }, chat });
    expect(called).toBe(false);
    expect(out.via).toBe('rule');
    expect(out.note).toContain('关掉了');
  });

  it('模型吐的东西解析不了就退回规则', async () => {
    const chat = async () => '这段我没看懂，你再说一遍？';
    const out = await parseHomeworkSmart(MESSAGE, { now: NOW, settings: SETTINGS, chat });
    expect(out.via).toBe('rule');
    expect(out.drafts.length).toBeGreaterThan(0);
  });

  it('空输入不炸', async () => {
    const out = await parseHomeworkSmart('   ', { now: NOW, settings: SETTINGS, chat: async () => '{}' });
    expect(out.drafts).toHaveLength(0);
    expect(out.via).toBe('rule');
  });
});

describe('normalizeLlmItems', () => {
  it('没写时间的按明天 23:59 兜底，并计数', () => {
    const out = normalizeLlmItems({ items: [{ title: '大物实验报告' }] }, NOW);
    expect(out.guessed).toBe(1);
    expect(out.drafts[0]!.dueAt).toBe(new Date(2026, 10, 14, 23, 59).getTime());
  });

  it('去年/前年的日期往后推一年', () => {
    const out = normalizeLlmItems({ items: [{ title: '实验报告', due: '2025-11-20T23:59:00+08:00' }] }, NOW);
    const due = out.drafts[0]!.dueAt;
    expect(due).toBeGreaterThan(NOW);
    expect(new Date(due).getFullYear()).toBe(2026);
  });

  it('同一标题同一时间只留一条', () => {
    const out = normalizeLlmItems(
      {
        items: [
          { title: '习题册 3.1', due: '2026-11-20T23:59:00+08:00' },
          { title: '习题册 3.1', due: '2026-11-20T23:59:00+08:00' },
        ],
      },
      NOW,
    );
    expect(out.drafts).toHaveLength(1);
  });

  it('课程名从标题里剥掉，避免重复显示', () => {
    const out = normalizeLlmItems({ items: [{ title: '高数作业：习题册 3.2', course: '高数', due: '2026-11-20T23:59:00+08:00' }] }, NOW);
    expect(out.drafts[0]!.title).toBe('习题册 3.2');
    expect(out.drafts[0]!.course).toBe('高数');
  });
});

describe('sameHomeworkTitle', () => {
  it('同一条作业的不同写法算同一条', () => {
    expect(sameHomeworkTitle('习题册 3.1–3.4', '习题册3.1-3.4')).toBe(true);
    expect(sameHomeworkTitle('英语作文二', '高数习题')).toBe(false);
    expect(sameHomeworkTitle('实验报告', '大学物理实验报告')).toBe(true);
  });

  it('空串不算', () => {
    expect(sameHomeworkTitle('', '')).toBe(false);
  });
});
