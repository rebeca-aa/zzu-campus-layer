import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyIntent,
  classifyIntentVerbose,
  canSeeImages,
  llmChat,
  llmChatVision,
  mintApiKey,
  parseIntentsJson,
  parseModelReply,
  probeLlm,
  stripThink,
  visionModelFor,
  type LlmSettings,
} from '../src/core/llm';

const cfg: LlmSettings = { enabled: true, provider: 'school', apiKey: 'sk-test', model: 'DeepSeek-R1' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stripThink', () => {
  it('去掉 DeepSeek-R1 的推理段', () => {
    const raw = '<think>\n用户问课表，用 get_schedule\n</think>\n{"tool":"get_schedule"}';
    expect(stripThink(raw)).toBe('{"tool":"get_schedule"}');
  });

  it('没有 think 段时原样返回', () => {
    expect(stripThink('  hello  ')).toBe('hello');
  });
});

describe('parseIntentsJson', () => {
  it('解析正常 JSON', () => {
    const got = parseIntentsJson('{"tool":"find_notices","args":{"keyword":"考试"}}');
    expect(got).toEqual({ tool: 'find_notices', args: { keyword: '考试' }, reason: 'LLM 判定' });
  });

  it('模型编了不存在的工具名（老提示词里的 search_notice）→ 返回 null，不崩', () => {
    expect(parseIntentsJson('{"tool":"search_notice","args":{"keyword":"考试"}}')).toBeNull();
  });

  it('容忍包裹在解释文字和 think 段里', () => {
    const raw = '好的<think>x</think>结果如下：{"tool":"get_schedule","args":{"day":"tomorrow"}} 以上。';
    expect(parseIntentsJson(raw)?.args).toEqual({ day: 'tomorrow' });
  });

  it('args 缺省时补空对象', () => {
    expect(parseIntentsJson('{"tool":"get_grades"}')?.args).toEqual({});
  });

  it('模型把没用到的参数写成 null 时剥掉（R1 常见）', () => {
    const raw = '{"tool":"find_free_room","args":{"date":null,"sections":null,"minSeats":null,"campus":null,"limit":[]}}';
    expect(parseIntentsJson(raw)?.args).toEqual({});
    const kept = parseIntentsJson('{"tool":"find_free_room","args":{"campus":"主校区","minSeats":100,"sections":[]}}');
    expect(kept?.args).toEqual({ campus: '主校区', minSeats: 100 });
  });

  it('参数类型不对时收敛：sections:5 → [5]，campus:1 丢掉', () => {
    const got = parseIntentsJson('{"tool":"find_free_room","args":{"campus":1,"sections":5,"minSeats":"100"}}');
    expect(got?.args).toEqual({ sections: [5], minSeats: 100 });
  });

  it('day 允许数字与字符串两种写法', () => {
    expect(parseIntentsJson('{"tool":"get_schedule","args":{"day":"3"}}')?.args).toEqual({ day: 3 });
    expect(parseIntentsJson('{"tool":"get_schedule","args":{"day":"tomorrow"}}')?.args).toEqual({ day: 'tomorrow' });
    expect(parseIntentsJson('{"tool":"get_schedule","args":{"day":"随便"}}')?.args).toEqual({});
  });

  it('tool 为 null 视为没听懂', () => {
    expect(parseIntentsJson('{"tool":null}')).toBeNull();
  });

  it('工具名不在白名单里 → null（不让模型乱造工具）', () => {
    expect(parseIntentsJson('{"tool":"drop_database"}')).toBeNull();
  });

  it('非 JSON → null', () => {
    expect(parseIntentsJson('我不知道')).toBeNull();
    expect(parseIntentsJson('{broken')).toBeNull();
  });
});

describe('llmChat', () => {
  it('带上 Bearer key 并剥掉 think', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '<think>嗯</think>收到' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const text = await llmChat(cfg, [{ role: 'user', content: 'hi' }]);
    expect(text).toBe('收到');
    expect(calls[0]?.url).toBe('http://chat.zzu.edu.cn/api/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: 'DeepSeek-R1', stream: false });
  });

  it('content 为空时退回 reasoning_content（推理模型只把话说在思考里）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '', reasoning_content: '{"items":[{"title":"高数习题"}]}' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const text = await llmChat(cfg, [{ role: 'user', content: 'hi' }]);
    expect(text).toContain('高数习题');
  });
  it('401 抛 LlmError 且标为鉴权失败，并把报错翻成人话', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: 'Your session has expired' }), { status: 401 })),
    );
    await expect(llmChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      status: 401,
      isAuth: true,
    });
    await expect(llmChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /API Key 无效或已过期（Your session has expired）/,
    );
  });

  it('换服务商时打到对应地址，且模型名留空就用预设默认值', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      }),
    );
    await llmChat({ provider: 'deepseek', apiKey: 'sk-x', model: '' }, [{ role: 'user', content: 'hi' }]);
    expect(calls[0]?.url).toBe('https://api.deepseek.com/chat/completions');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: 'deepseek-flash' });

    await llmChat({ provider: 'siliconflow', apiKey: 'sk-x', model: '' }, [{ role: 'user', content: 'hi' }]);
    expect(calls[1]?.url).toBe('https://api.siliconflow.cn/v1/chat/completions');
  });

  it('未知服务商回落到学校预设', async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ url });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      }),
    );
    await llmChat({ provider: 'nope', apiKey: 'sk-x', model: 'm' }, [{ role: 'user', content: 'hi' }]);
    expect(calls[0]?.url).toBe('http://chat.zzu.edu.cn/api/chat/completions');
  });

  it('余额不足/限流各有各的说法', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 })));
    await expect(llmChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/余额不足/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    await expect(llmChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/限流/);
  });

  it('没有 key 时不发请求', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(llmChat({ provider: 'school', apiKey: '', model: 'x' }, [])).rejects.toMatchObject({ status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('mintApiKey', () => {
  it('用页面会话换 sk- key（POST /api/v1/auths/api_key）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ api_key: 'sk-abc123' }), { status: 200 });
      }),
    );
    await expect(mintApiKey('session.jwt.here')).resolves.toBe('sk-abc123');
    expect(calls[0]?.url).toBe('http://chat.zzu.edu.cn/api/v1/auths/api_key');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer session.jwt.here');
  });

  it('会话过期时抛鉴权错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"detail":"Your session has expired"}', { status: 401 })),
    );
    await expect(mintApiKey('expired.jwt.here')).rejects.toMatchObject({ status: 401, isAuth: true });
  });

  it('服务端没给 sk- 前缀时视为失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ api_key: 'oops' }), { status: 200 })));
    await expect(mintApiKey('session.jwt.here')).rejects.toThrow(/sk-/);
  });

  it('没有会话时不发请求', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(mintApiKey('')).rejects.toMatchObject({ status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('parseModelReply：模型自由回答', () => {
  it('纯文本就是回答', () => {
    expect(parseModelReply('你好呀，我是校园助手。')).toBe('你好呀，我是校园助手。');
  });

  it('{"reply": ...} 也认', () => {
    expect(parseModelReply('{"reply":"想查什么？"}')).toBe('想查什么？');
  });

  it('工具调用不算回答', () => {
    expect(parseModelReply('{"tool":"get_schedule","args":{}}')).toBeNull();
  });

  it('剥掉 think 段再判断', () => {
    expect(parseModelReply('<think>说句你好</think>你好')).toBe('你好');
  });

  it('空内容返回 null', () => {
    expect(parseModelReply('   ')).toBeNull();
  });
});

describe('classifyIntent', () => {
  it('正常判定出意图', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"find_free_room","args":{"date":"2026-10-22"}}' } }] }), {
          status: 200,
        }),
      ),
    );
    const got = await classifyIntent('后天想找个安静地方看书', '2026-10-21', cfg);
    expect(got?.tool).toBe('find_free_room');
    expect(got?.args).toEqual({ date: '2026-10-22' });
  });

  it('没开开关或没 key 时直接返回 null（不发请求）', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await classifyIntent('随便问问', '2026-10-21', { ...cfg, enabled: false })).toBeNull();
    expect(await classifyIntent('随便问问', '2026-10-21', { ...cfg, apiKey: '' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('网络挂了也返回 null，不把异常抛给上层', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await classifyIntent('明天有课吗', '2026-10-21', cfg)).toBeNull();
  });

  it('https 页面调 http 服务时直接放弃，不白等 30 秒', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    vi.stubGlobal('location', { protocol: 'https:' });
    expect(await classifyIntent('后天下午哪个屋子能看书', '2026-10-21', cfg)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    // 换成 https 服务商就该放行
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"get_grades"}' } }] }), { status: 200 })),
    );
    const got = await classifyIntent('我考得怎么样', '2026-10-21', { ...cfg, provider: 'deepseek' });
    expect(got?.tool).toBe('get_grades');
  });

  it('模型胡说八道时返回 null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '我觉得应该查成绩' } }] }), { status: 200 })),
    );
    expect(await classifyIntent('那个啥', '2026-10-21', cfg)).toBeNull();
  });
});

describe('classifyIntentVerbose', () => {
  it('401 不再是静默 null，而是带回可读原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"Invalid API key"}', { status: 401 })));
    const got = await classifyIntentVerbose('那个啥', '2026-10-21', { ...cfg, provider: 'deepseek' });
    expect(got.intent).toBeNull();
    expect(got.called).toBe(true);
    expect(got.error).toContain('API Key 无效');
  });

  it('网络不通（fetch 抛 TypeError）也带回原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const got = await classifyIntentVerbose('那个啥', '2026-10-21', { ...cfg, provider: 'deepseek' });
    expect(got.intent).toBeNull();
    expect(got.error).toContain('Failed to fetch');
  });

  it('没开开关 / 没填 key 时不发请求，也要说清原因', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const off = await classifyIntentVerbose('那个啥', '2026-10-21', { ...cfg, enabled: false });
    expect(off).toMatchObject({ intent: null, called: false });
    expect(off.error).toContain('没打开');
    const noKey = await classifyIntentVerbose('那个啥', '2026-10-21', { ...cfg, apiKey: '' });
    expect(noKey.error).toContain('API Key');
    expect(spy).not.toHaveBeenCalled();
  });

  it('判出来时不带 error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"get_todos"}' } }] }), { status: 200 })),
    );
    const got = await classifyIntentVerbose('有啥要办的', '2026-10-21', { ...cfg, provider: 'deepseek' });
    expect(got.intent?.tool).toBe('get_todos');
    expect(got.error).toBeUndefined();
  });
});

describe('probeLlm', () => {
  it('成功时回 ok + 耗时 + 模型名', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })),
    );
    const got = await probeLlm({ provider: 'deepseek', apiKey: 'sk-x', model: 'deepseek-chat' });
    expect(got).toMatchObject({ ok: true, model: 'deepseek-chat', text: 'ok' });
    expect(got.ms).toBeGreaterThanOrEqual(0);
  });

  it('失败时回 ok:false 和原文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })));
    const got = await probeLlm({ provider: 'deepseek', apiKey: 'sk-x', model: 'deepseek-chat' });
    expect(got.ok).toBe(false);
    expect(got.error).toContain('bad key');
  });
});

describe('识图：模型能不能看图', () => {
  it('名字里带 VL / vision / gemini 的算能看图', () => {
    expect(canSeeImages('Qwen/Qwen2.5-VL-7B-Instruct')).toBe(true);
    expect(canSeeImages('glm-4v-flash')).toBe(true);
    expect(canSeeImages('google/gemini-2.0-flash-001')).toBe(true);
    expect(canSeeImages('gpt-4o-mini')).toBe(true);
    expect(canSeeImages('deepseek-chat')).toBe(false);
    expect(canSeeImages('moonshot-v1-8k')).toBe(false);
    expect(canSeeImages('DeepSeek-R1')).toBe(false);
    /* V4.1 Flash 原生多模态：正式名与被官方路由的旧名都认 */
    expect(canSeeImages('deepseek-flash')).toBe(true);
    expect(canSeeImages('deepseek-v4-flash-vision-exp')).toBe(true);
  });

  it('用户配的模型看不了图，就换成同服务商的识图模型', () => {
    expect(visionModelFor({ provider: 'siliconflow', apiKey: 'k', model: '' })).toEqual({
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
      switched: true,
    });
    expect(visionModelFor({ provider: 'dashscope', apiKey: 'k', model: 'qwen-plus' })?.model).toBe('qwen-vl-max');
    expect(visionModelFor({ provider: 'siliconflow', apiKey: 'k', model: 'Qwen/Qwen2.5-VL-32B' })).toEqual({
      model: 'Qwen/Qwen2.5-VL-32B',
      switched: false,
    });
    /* 学校 R1 没有识图模型；DeepSeek 官方现在有 deepseek-flash */
    expect(visionModelFor({ provider: 'school', apiKey: 'k', model: 'DeepSeek-R1' })).toBeNull();
    expect(visionModelFor({ provider: 'deepseek', apiKey: 'k', model: 'deepseek-chat' })).toEqual({
      model: 'deepseek-flash',
      switched: true,
    });
    expect(visionModelFor({ provider: 'deepseek', apiKey: 'k', model: 'deepseek-flash' })).toEqual({
      model: 'deepseek-flash',
      switched: false,
    });
  });
});

describe('llmChatVision', () => {
  it('图片按多模态片段发出去，模型名用指定的那个', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      }),
    );
    const img = 'data:image/png;base64,iVBORw0KGgo=';
    const text = await llmChatVision(
      { provider: 'siliconflow', apiKey: 'sk-x', model: 'Qwen/Qwen2.5-7B-Instruct' },
      '读这张图',
      [img],
      { model: 'Qwen/Qwen2.5-VL-7B-Instruct', maxTokens: 64 },
    );
    expect(text).toBe('ok');
    expect(calls[0]!.url).toBe('https://api.siliconflow.cn/v1/chat/completions');
    expect(calls[0]!.body).toMatchObject({ model: 'Qwen/Qwen2.5-VL-7B-Instruct', max_tokens: 64, stream: false });
    const messages = calls[0]!.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: '读这张图' },
      { type: 'image_url', image_url: { url: img } },
    ]);
  });

  it('没 key 时不发请求', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(
      llmChatVision({ provider: 'siliconflow', apiKey: '', model: 'x' }, 'hi', []),
    ).rejects.toMatchObject({ status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });
});