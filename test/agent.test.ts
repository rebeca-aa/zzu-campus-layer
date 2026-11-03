import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTextHints, ask } from '../src/core/agent';

/** 支持工具调用的模型（走 agent 循环） */
const AGENT_ON = { enabled: true, provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' };
/** 不支持工具调用的模型（走老的「JSON 判意图」） */
const CLASSIC_ON = { enabled: true, provider: 'school', apiKey: 'sk-test', model: 'DeepSeek-R1' };

const SESSION = { jwxtToken: 'x', today: '2026-10-21' };

function toolCall(id: string, name: string, args: unknown) {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

function answer(text: string) {
  return { choices: [{ finish_reason: 'stop', message: { content: text } }] };
}

/** 按顺序吐出预设响应；记录每次请求的 body 供断言。 */
function stubLlm(responses: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const fn = vi.fn(async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const body = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent 循环（支持 function calling 的模型）', () => {
  it('模型调工具 → 拿结果 → 再组织回答', async () => {
    const { bodies } = stubLlm([
      toolCall('c1', 'open_service', { keyword: '座位预约' }),
      answer('座位预约要从图书馆系统里选，我把入口放这儿了。'),
    ]);
    const got = await ask('随便问一句', SESSION, { llm: AGENT_ON });

    expect(got.via).toBe('agent');
    expect(got.steps).toEqual(['open_service']);
    expect(got.text).toContain('入口');
    /* 座位预约不再给链接：那个站的网页登录在 App 里走不通，只指去「我的 → 图书馆登录」 */
    expect(got.data?.url).toBeUndefined();
    expect(got.data?.noLink).toBe(true);

    // 第一次请求要带工具规格，第二次要把工具结果回灌
    expect(Array.isArray(bodies[0]?.tools)).toBe(true);
    expect((bodies[0]?.tools as unknown[]).length).toBeGreaterThan(5);
    const second = bodies[1]?.messages as Array<{ role: string; tool_call_id?: string }>;
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('c1');
  });

  it('工具返回的内容就是模型看到的全部事实（不额外塞渲染文本）', async () => {
    const { bodies } = stubLlm([toolCall('c1', 'open_service', { keyword: '报修' }), answer('ok')]);
    await ask('报修在哪', SESSION, { llm: AGENT_ON });
    const msgs = bodies[1]?.messages as Array<{ role: string; content: string }>;
    const payload = JSON.parse(msgs.find((m) => m.role === 'tool')!.content) as { text: string; data?: { url?: string } };
    expect(payload.text).toContain('网络报修');
    expect(payload.data?.url).toContain('repair-management-h5');
  });

  it('模型调了不存在的工具 → 把错误喂回去，让它自己纠正', async () => {
    const { bodies } = stubLlm([
      toolCall('c1', 'book_seat', { room: 'A1' }),
      answer('这个我做不到，只能给你入口。'),
    ]);
    const got = await ask('帮我约个座', SESSION, { llm: AGENT_ON });
    const msgs = bodies[1]?.messages as Array<{ role: string; content: string }>;
    const errPayload = JSON.parse(msgs.find((m) => m.role === 'tool')!.content) as { error?: string };
    expect(errPayload.error).toContain('没有叫 book_seat 的工具');
    expect(got.via).toBe('agent');
    expect(got.text).toContain('做不到');
  });

  it('模型一直调工具不肯说话 → 用最后一个工具结果兜底', async () => {
    stubLlm([toolCall('c1', 'open_service', { keyword: '图书馆' })]);
    const got = await ask('图书馆', SESSION, { llm: AGENT_ON, maxSteps: 2 });
    expect(got.via).toBe('agent');
    expect(got.text).toContain('图书馆');
    expect(got.steps).toEqual(['open_service', 'open_service']);
  });

  it('模型挂了（401）回落到规则层，并把原因带出来', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })));
    const got = await ask('那个啥呀', SESSION, { llm: AGENT_ON });
    expect(got.via).toBe('none');
    expect(got.text).toContain('可以'); // helpText
    expect(got.llmError).toContain('API Key 无效');
  });

  it('带上历史对话，追问才接得住', async () => {
    const { bodies } = stubLlm([answer('明天周三，你有两门课。')]);
    await ask('那明天呢', SESSION, {
      llm: AGENT_ON,
      history: [
        { role: 'user', content: '今天有课吗' },
        { role: 'assistant', content: '今天没课。' },
      ],
    });
    const msgs = bodies[0]?.messages as Array<{ role: string; content: string }>;
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.content)).toContain('今天有课吗');
    expect(msgs.at(-1)?.content).toBe('那明天呢');
  });
});

describe('老路径（不支持 function calling 的模型，例如学校 R1）', () => {
  it('规则命中时根本不问模型', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await ask('我卡里还有多少钱', SESSION, { llm: CLASSIC_ON }).catch(() => undefined);
    const calledLlm = spy.mock.calls.some((c) => String(c[0]).includes('chat.zzu.edu.cn'));
    expect(calledLlm).toBe(false);
  });

  it('「hello」由模型作答，不再甩功能清单', async () => {
    stubLlm([answer('你好，我是校园助手，可以直接问我课表或空教室。')]);
    const got = await ask('hello', SESSION, { llm: CLASSIC_ON });
    expect(got.via).toBe('llm-chat');
    expect(got.text).toContain('你好');
    expect(got.text).not.toContain('我可以直接回答这几类问题');
  });

  it('模型回 {"reply":…} 也认', async () => {
    stubLlm([answer('{"reply":"我在，想查什么？"}')]);
    const got = await ask('在吗', SESSION, { llm: CLASSIC_ON });
    expect(got.via).toBe('llm-chat');
    expect(got.text).toBe('我在，想查什么？');
  });

  it('模型啥也没说清时回落帮助文案（并带原因）', async () => {
    stubLlm([answer('{bad json')]);
    const got = await ask('那啥', SESSION, { llm: CLASSIC_ON });
    expect(got.via).toBe('none');
    expect(got.llmError ?? '').toContain('模型');
  });

  it('模型没开时不该有 llmError（用户自己关的，不用报警）', async () => {
    const got = await ask('那个啥呀', SESSION);
    expect(got.via).toBe('none');
    expect(got.llmError).toBeUndefined();
  });
});

describe('applyTextHints：相对日期与时段由规则覆盖模型', () => {
  it('「后天」算成 +2 天，别信模型', () => {
    const got = applyTextHints('find_free_room', { date: '2026-10-22' }, '后天南核空教室', '2026-10-21');
    expect(got.date).toBe('2026-10-23');
  });

  it('「明天」算成 +1 天', () => {
    const got = applyTextHints('find_free_room', {}, '明天哪间教室空着', '2026-10-21');
    expect(got.date).toBe('2026-10-22');
  });

  it('下午自动补 5-8 节（模型没给 sections 时）', () => {
    const got = applyTextHints('find_free_room', {}, '明天下午的空教室', '2026-10-21');
    expect(got.sections).toEqual([5, 6, 7, 8]);
  });

  it('课表：明天 → day=tomorrow，下午 → period=afternoon', () => {
    const got = applyTextHints('get_schedule', {}, '明天下午有课吗', '2026-10-21');
    expect(got.day).toBe('tomorrow');
    expect(got.period).toBe('afternoon');
  });

  it('周三这种绝对说法不覆盖模型给的值', () => {
    const got = applyTextHints('get_schedule', { day: 3 }, '周三有课吗', '2026-10-21');
    expect(got.day).toBe(3);
  });
});
