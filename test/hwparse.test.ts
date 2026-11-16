import { describe, expect, it } from 'vitest';
import { normalizeLlmItems, parseHomeworkFromImages, parseHomeworkSmart, sameHomeworkTitle, splitSegments } from '../src/core/hwParse';

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

describe('parseHomeworkFromImages：读截图', () => {
  const IMG = 'data:image/png;base64,iVBORw0KGgo=';
  const VISION = { enabled: true, provider: 'siliconflow', apiKey: 'sk-test', model: 'Qwen/Qwen2.5-7B-Instruct' };

  it('用服务商的识图模型读图，图里几项就出几条', async () => {
    const seen: Array<{ prompt: string; images: string[]; model: string }> = [];
    const chat = async (prompt: string, images: string[], model: string) => {
      seen.push({ prompt, images, model });
      return '```json\n{"items":[{"title":"习题册 3.1–3.4","course":"高数","due":"2026-11-20T23:59:00+08:00"},{"title":"大物实验报告","due":"2026-11-25T23:59:00+08:00"}]}\n```';
    };
    const out = await parseHomeworkFromImages([IMG], { now: NOW, settings: VISION, chat });
    expect(out.via).toBe('llm');
    expect(out.drafts).toHaveLength(2);
    expect(out.drafts.map((d) => d.title)).toEqual(['习题册 3.1–3.4', '大物实验报告']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.images).toEqual([IMG]);
    /* 用户配的是 Qwen2.5-7B（看不了图），自动换成同服务商的 VL 模型 */
    expect(seen[0]!.model).toContain('VL');
    expect(out.note).toContain('看不了图');
    expect(out.note).toContain('共 2 条');
  });

  it('配的本来就是识图模型，就不换', async () => {
    const chat = async (_p: string, _i: string[], model: string) => {
      expect(model).toBe('Qwen/Qwen2.5-VL-7B-Instruct');
      return '{"items":[{"title":"英语作文二","due":"2026-11-15T23:59:00+08:00"}]}';
    };
    const out = await parseHomeworkFromImages([IMG], {
      now: NOW,
      settings: { ...VISION, model: 'Qwen/Qwen2.5-VL-7B-Instruct' },
      chat,
    });
    expect(out.drafts).toHaveLength(1);
    expect(out.note).not.toContain('看不了图');
  });

  it('多张图一起读，结果合并', async () => {
    const chat = async (_p: string, images: string[]) => {
      expect(images).toHaveLength(2);
      return '{"items":[{"title":"习题册 3.1–3.4","due":"2026-11-20T23:59:00+08:00"},{"title":"英语作文二","due":"2026-11-22T23:59:00+08:00"}]}';
    };
    const out = await parseHomeworkFromImages([IMG, IMG.replace('png', 'jpeg')], {
      now: NOW,
      settings: VISION,
      chat,
    });
    expect(out.drafts).toHaveLength(2);
    expect(out.note).toContain('2 张图');
  });

  it('没填 Key / 服务商没有识图模型时，给一句能照着做的话，且不发请求', async () => {
    let called = false;
    const chat = async () => {
      called = true;
      return '{}';
    };
    const noKey = await parseHomeworkFromImages([IMG], { now: NOW, settings: { ...VISION, apiKey: '' }, chat });
    expect(noKey.drafts).toHaveLength(0);
    expect(noKey.note).toContain('支持看图的 Key');
    const noVision = await parseHomeworkFromImages([IMG], {
      now: NOW,
      settings: { enabled: true, provider: 'school', apiKey: 'sk-x', model: 'DeepSeek-R1' },
      chat,
    });
    expect(noVision.drafts).toHaveLength(0);
    expect(noVision.note).toContain('没有能看图的模型');
    expect(called).toBe(false);
  });

  it('DeepSeek 官方：配的是纯文字模型，也会换成 deepseek-flash 读图', async () => {
    const chat = async (_prompt: string, _images: string[], model: string) => {
      got = model;
      return '{"items":[{"title":"高数习题","due":"2026-11-20T23:59:00+08:00"}]}';
    };
    let got = '';
    const out = await parseHomeworkFromImages([IMG], {
      now: NOW,
      settings: { enabled: true, provider: 'deepseek', apiKey: 'sk-x', model: 'deepseek-chat' },
      chat,
    });
    expect(got).toBe('deepseek-flash');
    expect(out.drafts).toHaveLength(1);
    expect(out.note).toContain('顺手换了识图模型');
  });

  it('模型不认图时把原话带出来', async () => {
    const chat = async () => {
      const err = new Error('400 invalid_request_error: this model does not support image input');
      throw err;
    };
    const out = await parseHomeworkFromImages([IMG], { now: NOW, settings: VISION, chat });
    expect(out.drafts).toHaveLength(0);
    expect(out.note).toContain('不认图');
  });

  it('图里没有作业就明说，不硬凑', async () => {
    const chat = async () => '{"items":[]}';
    const out = await parseHomeworkFromImages([IMG], { now: NOW, settings: VISION, chat });
    expect(out.drafts).toHaveLength(0);
    expect(out.note).toContain('没认出');
  });
  it('第一次回空话、第二次给出 JSON 就用第二次的', async () => {
    let n = 0;
    const chat = async () => {
      n += 1;
      return n === 1 ? '好的，我看一下这张图。图里提到了高数作业。' : '{"items":[{"title":"高数习题","due":"2026-11-20T23:59:00+08:00"}]}';
    };
    const out = await parseHomeworkFromImages([IMG], { now: NOW, settings: VISION, chat });
    expect(n).toBe(2);
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]?.title).toContain('高数');
  });

  it('两次都不给 JSON 就把模型原话带出来', async () => {
    const chat = async () => '抱歉，这张图太模糊了，我看不清里面写的是什么。';
    const out = await parseHomeworkFromImages([IMG], { now: NOW, settings: VISION, chat });
    expect(out.drafts).toHaveLength(0);
    expect(out.note).toContain('它先说');
    expect(out.note).toContain('看不清');
  });

  it('模型回空内容时说清是空内容，不甩锅给截图', async () => {
    const chat = async () => '';
    const out = await parseHomeworkFromImages([IMG], { now: NOW, settings: VISION, chat });
    expect(out.drafts).toHaveLength(0);
    expect(out.note).toContain('空内容');
  });
  it('JSON 被截断时，把前面完整的几条捞出来', async () => {
    const cut = '{"items":[{"title":"iWrite3","course":"英语","due":"2026-11-14T23:59:00+08:00"},{"title":"大物实验报告","course":"大物","due":"2026-11-20T23:59:00+08:00"},{"title":"英语作文二","cou';
    const chat = async () => cut;
    const out = await parseHomeworkFromImages([IMG], { now: NOW, settings: VISION, chat });
    expect(out.drafts).toHaveLength(2);
    expect(out.drafts.map((d) => d.title)).toEqual(['iWrite3', '大物实验报告']);
  });

  it('整段 JSON 都坏了也能捞出带 title 的对象', async () => {
    const chat = async () => '好的：{"title":"iWrite3","course":"英语","due":"2026-11-14T23:59:00+08:00"} 就这些';
    const out = await parseHomeworkFromImages([IMG], { now: NOW, settings: VISION, chat });
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]?.course).toBe('英语');
  });
  it('截止已经过去的条目照样出草稿，并在说明里点出来', async () => {
    const chat = async () => '{"items":[{"title":"iWrite3","course":"英语","due":"2026-11-10T23:59:00+08:00"}]}';
    const out = await parseHomeworkFromImages([IMG], { now: NOW, settings: VISION, chat });
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]?.dueAt).toBeLessThan(NOW);
    expect(out.note).toContain('截止时间已经过了');
  });
});

describe('漏条自检：模型只给一条时按段补问', () => {
  const TWO_LINES = '高数作业：习题册 3.1-3.4 周五前交\n英语作文三 下周三之前交，传学习通';
  const settings = { enabled: true, provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-flash' } as const;

  it('两行两条作业，模型偷懒只回一条 → 逐段补问后能凑齐两条', async () => {
    let calls = 0;
    const chat = async (messages: Array<{ role: string; content: string }>) => {
      calls += 1;
      const user = messages[1]?.content ?? '';
      if (user.includes('英语作文三')) {
        return '{"items":[{"title":"英语作文三","due":"2026-11-18T23:59:00+08:00"}]}';
      }
      return '{"items":[{"title":"习题册 3.1–3.4","course":"高等数学","due":"2026-11-20T23:59:00+08:00"}]}';
    };
    const out = await parseHomeworkSmart(TWO_LINES, { now: NOW, settings, chat });
    expect(out.drafts.length).toBe(2);
    expect(out.drafts.map((d) => d.title).join('|')).toContain('英语作文三');
    expect(calls).toBeGreaterThan(2);
    expect(out.note).toContain('分段补了');
  });

  it('模型一次就给全了就不再多问', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return '{"items":[{"title":"习题册 3.1–3.4","course":"高等数学","due":"2026-11-20T23:59:00+08:00"},{"title":"英语作文三","course":"英语","due":"2026-11-18T23:59:00+08:00"}]}';
    };
    const out = await parseHomeworkSmart(TWO_LINES, { now: NOW, settings, chat });
    expect(out.drafts.length).toBe(2);
    expect(calls).toBe(1);
  });

  it('splitSegments 按行和句切，太短的碎句不算', () => {
    expect(splitSegments('第一条作业周五交\n\n好\n第二条作业下周一交')).toHaveLength(2);
    expect(splitSegments('交高数习题册。交英语作文三。')).toHaveLength(2);
    expect(splitSegments('只有一条作业需要交')).toHaveLength(1);
  });

  it('一句话里用「和」连着的两件事，第一次只回一条时会再确认一遍', async () => {
    let calls = 0;
    const chat = async (messages: Array<{ role: string; content: string }>) => {
      calls += 1;
      const user = messages[1]?.content ?? '';
      if (user.includes('再数') || user.includes('别硬拆')) {
        return '{"items":[{"title":"高数习题册","course":"高等数学","due":"2026-11-20T23:59:00+08:00"},{"title":"英语作文三","course":"英语","due":"2026-11-18T23:59:00+08:00"}]}';
      }
      return '{"items":[{"title":"高数习题册","course":"高等数学","due":"2026-11-20T23:59:00+08:00"}]}';
    };
    const out = await parseHomeworkSmart('周五前交高数习题册和英语作文三', { now: NOW, settings, chat });
    expect(out.drafts.length).toBe(2);
    expect(calls).toBe(2);
  });

  it('并列词但真的只有一条：再问一次也还是一条，不会硬拆', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return '{"items":[{"title":"高数习题册 3.1-3.4","course":"高等数学","due":"2026-11-20T23:59:00+08:00"}]}';
    };
    const out = await parseHomeworkSmart('周五前把习题册和作业本一起交', { now: NOW, settings, chat });
    expect(out.drafts.length).toBe(1);
    expect(calls).toBe(2);
    expect(out.note).not.toContain('分段补了');
  });
});