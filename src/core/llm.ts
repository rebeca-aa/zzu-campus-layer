/**
 * LLM 接入层：默认是学校自带的 Open WebUI（chat.zzu.edu.cn），
 * 也可以换成任意 OpenAI 兼容服务商（用户自己填 key）。
 *
 * 定位：**只做意图分类**，绝不生成课表/通知内容。
 * 原因见 docs/school-llm-evaluation.md：数据必须来自学校接口，幻觉不能进渲染层。
 *
 * 硬约束（都是实测，见 docs/deploy-pwa.md）：
 *  - 学校服务只在校园网内可达（内网 10.67.16.3），而且是 **http**；
 *    HTTPS 页面调用会被浏览器按混合内容拦掉 —— 只影响学校这一个预设；
 *  - 第三方服务商（DeepSeek 官方/硅基流动/百炼/Moonshot/OpenRouter）都是 https，
 *    已逐个验证 CORS 放行，纯前端可直连；
 *  - key 一律由用户自己提供，不内置、不上传。
 */
import { z } from 'zod';
import type { Intent } from './intent';
import { TOOLS } from './tools';
import { weekdayOf } from './util';

/** 学校 WebUI 的地址（用于预设与「一键换 key」）。 */
export const LLM_BASE = 'http://chat.zzu.edu.cn';
export const DEFAULT_MODEL = 'DeepSeek-R1';

export interface LlmProvider {
  id: string;
  label: string;
  /** OpenAI 兼容 base（不含 /chat/completions） */
  baseUrl: string;
  /** 预设模型名，用户可以改 */
  model: string;
  /** 这个服务商这边「能看图」的模型名；没有就说明它没有识图模型 */
  vision?: string;
  /** 只有校园网 / VPN 可达 */
  campusOnly?: boolean;
  /** 是否支持原生 function calling（决定走「工具循环」还是老的 JSON 判意图） */
  supportsTools?: boolean;
  /** 界面上的一句提示 */
  hint?: string;
}

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    vision: 'glm-4v-flash',
    hint: '智谱的对话接口不允许浏览器跨域直连：手机 PWA 用不了，浏览器扩展里可以（扩展不受 CORS 限制）。',
  },
  {
    id: 'school',
    label: 'DS-R1（学校，仅校园网）',
    // 学校这层是 Open WebUI，接口挂在 /api 下（/api/chat/completions）
    baseUrl: `${LLM_BASE}/api`,
    model: DEFAULT_MODEL,
    campusOnly: true,
    // 学校现在只给 R1（推理模型，带 think 段），没有 function calling；
    // 走老的「JSON 判意图」路径，别指望它可靠地调工具。
    supportsTools: false,
    hint: 'DS-R1 · 只能校园网 / VPN · 手机端用不了（页面是 https，它是 http）· 也看不了图。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    supportsTools: true,
    hint: 'deepseek-chat（v4 代）支持工具调用，快且便宜，推荐（看图要换别的服务商）。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    vision: 'Qwen/Qwen2.5-VL-7B-Instruct',
    supportsTools: true,
  },
  {
    id: 'dashscope',
    label: '阿里百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    vision: 'qwen-vl-max',
    supportsTools: true,
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    vision: 'moonshot-v1-8k-vision-preview',
    supportsTools: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    vision: 'google/gemini-2.0-flash-001',
    supportsTools: true,
  },
];

export const DEFAULT_PROVIDER = 'school';

/** 按 id 取预设；未知 id 回落到第一个（学校）。 */
export function resolveProvider(id: string | undefined): LlmProvider {
  return LLM_PROVIDERS.find((p) => p.id === id) ?? (LLM_PROVIDERS.find((p) => p.id === DEFAULT_PROVIDER) ?? LLM_PROVIDERS[0] as LlmProvider);
}

/** 拼出 /chat/completions 地址（容忍预设里带尾斜杠）。 */
export function chatEndpoint(provider: LlmProvider): string {
  return `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 当前页面是不是 HTTPS（SW 与页面里都能用；node 测试里当 false）。 */
function isHttpsPage(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

export interface LlmSettings {
  enabled: boolean;
  provider: string;
  apiKey: string;
  /** 留空则用预设默认模型 */
  model: string;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  enabled: true,
  provider: DEFAULT_PROVIDER,
  apiKey: '',
  model: DEFAULT_MODEL,
};

/** 一条消息的内容：纯文本，或多模态片段（识图时用） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/** 模型名里带这些的，基本都能看图（各家的命名都不一样，只能猜个大概） */
const VISION_NAME = /(?:^|[/_-])(?:vl|vision|omni)(?:[/_.-]|$)|glm-4v|gpt-4o|gpt-4\.1|gemini|claude-3|internvl|pixtral|qwen2\.5-vl|qvq/i;

/** 这个模型名看起来能不能读图 */
export function canSeeImages(model: string): boolean {
  return VISION_NAME.test(model.trim());
}

export interface VisionTarget {
  /** 实际要用的模型名 */
  model: string;
  /** true = 用户配的模型看不了图，自动换成了服务商的识图模型 */
  switched: boolean;
}

/**
 * 决定「读图用哪个模型」：
 *  1. 用户配的模型本来就认图 → 直接用；
 *  2. 服务商预设里有识图模型 → 换成它（同一个 key）；
 *  3. 都没有（比如 DeepSeek 官方、学校 R1）→ null，界面提示换服务商。
 */
export function visionModelFor(
  cfg: Pick<LlmSettings, 'provider' | 'apiKey' | 'model'>,
): VisionTarget | null {
  const provider = resolveProvider(cfg.provider);
  const model = cfg.model.trim() || provider.model;
  if (canSeeImages(model)) return { model, switched: false };
  if (provider.vision) return { model: provider.vision, switched: true };
  return null;
}

/** 去掉 DeepSeek-R1 的推理段（`<think>…</think>`），只留答案。 */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|?thinking\|?>[\s\S]*?<\|\/?thinking\|?>/gi, '')
    .trim();
}

export class LlmError extends Error {
  readonly status: number;
  readonly isAuth: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.isAuth = status === 401 || status === 403;
  }
}

export interface ChatOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 限制输出长度：判意图只需要几十个 token，R1 的推理段不该无限长 */
  maxTokens?: number;
  /** 采样温度（工具循环里给低一点，减少乱填参数） */
  temperature?: number;
}

/** 把服务商的 HTTP 错误翻成人话（401/402/403/404/429 各有不同含义）。 */
function friendlyHttpError(status: number, raw: string, provider: LlmProvider): string {
  const detail = raw.trim().slice(0, 200) || `HTTP ${status}`;
  switch (status) {
    case 401:
      return `${provider.label} 的 API Key 无效或已过期（${detail}）`;
    case 402:
      return `${provider.label} 余额不足（${detail}）`;
    case 403:
      return `${provider.label} 拒绝了这个请求，可能是地域或额度限制（${detail}）`;
    case 404:
      return `${provider.label} 没有这个接口，或模型名不对（${detail}）`;
    case 429:
      return `${provider.label} 触发限流，等一会儿再试（${detail}）`;
    default:
      return detail;
  }
}

/** 线上消息（tool_calls / tool 角色都要原样回传，否则服务端会报错）。 */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

interface ChatPayload {
  model: string;
  messages: WireMessage[];
  stream: false;
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: 'auto';
}

interface ChatReply {
  content: string;
  toolCalls: Array<{ id: string; name: string; argsRaw: string }>;
  finish: string;
  ms: number;
}

/** 一次 POST /chat/completions，统一处理超时、错误翻译、混合内容提示。 */
async function postChat(
  cfg: Pick<LlmSettings, 'provider' | 'apiKey' | 'model'>,
  build: (provider: LlmProvider) => ChatPayload,
  opts: ChatOptions = {},
): Promise<ChatReply> {
  const provider = resolveProvider(cfg.provider);
  if (!cfg.apiKey) throw new LlmError(401, '还没有填 API Key');
  if (provider.baseUrl.startsWith('http:') && isHttpsPage()) {
    throw new LlmError(
      0,
      `${provider.label} 是 http 服务，HTTPS 页面调不了（混合内容限制）。换成 https 的服务商，或在校园网里用 http 打开。`,
    );
  }
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  const t0 = Date.now();
  try {
    const payload = build(provider);
    const res = await fetch(chatEndpoint(provider), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw.slice(0, 200);
      try {
        const j = JSON.parse(raw) as { detail?: string; error?: { message?: string } };
        if (typeof j.detail === 'string') msg = j.detail;
        else if (typeof j.error?.message === 'string') msg = j.error.message;
      } catch {
        /* 保留原文 */
      }
      throw new LlmError(res.status, friendlyHttpError(res.status, msg, provider));
    }
    const json = JSON.parse(raw) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
    };
    const choice = json.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c, i) => ({
        id: c.id ?? `call_${i}`,
        name: c.function!.name!,
        argsRaw: c.function?.arguments ?? '{}',
      }));
    return {
      content: stripThink(choice?.message?.content ?? ''),
      toolCalls,
      finish: choice?.finish_reason ?? 'stop',
      ms: Date.now() - t0,
    };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    const name = (e as { name?: string }).name;
    if (name === 'AbortError') {
      throw new LlmError(408, `${provider.label} 超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw new LlmError(
      0,
      provider.campusOnly
        ? `连不上 ${provider.label}（只有校园网 / VPN 可达）：${(e as Error).message}`
        : `连不上 ${provider.label}：${(e as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 调一次对话补全，返回纯文本（已剥掉 think 段）。 */
export async function llmChat(
  cfg: Pick<LlmSettings, 'provider' | 'apiKey' | 'model'>,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const reply = await postChat(
    cfg,
    (provider) => ({
      model: cfg.model.trim() || provider.model,
      messages,
      stream: false,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
    opts,
  );
  return reply.content;
}

/**
 * 带图的一次对话（OpenAI 兼容的多模态消息）。图片传 data URL 或 https 地址。
 * 模型能不能看图由调用方先过 `visionModelFor()` 判断——这里只管发出去。
 */
export async function llmChatVision(
  cfg: Pick<LlmSettings, 'provider' | 'apiKey' | 'model'>,
  prompt: string,
  images: string[],
  opts: ChatOptions & { model?: string } = {},
): Promise<string> {
  const parts: ContentPart[] = [
    { type: 'text', text: prompt },
    ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ];
  const reply = await postChat(
    cfg,
    (provider) => ({
      model: (opts.model ?? cfg.model).trim() || provider.model,
      messages: [{ role: 'user', content: parts }],
      stream: false,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    }),
    opts,
  );
  return reply.content;
}

/**
 * 带工具的一次对话（function calling）。模型可以返回 tool_calls，
 * 由 `agent.ts` 执行后把结果回灌，再问下一轮。
 */
export async function llmChatWithTools(
  cfg: Pick<LlmSettings, 'provider' | 'apiKey' | 'model'>,
  messages: WireMessage[],
  tools: unknown[],
  opts: ChatOptions = {},
): Promise<ChatReply> {
  return postChat(
    cfg,
    (provider) => ({
      model: cfg.model.trim() || provider.model,
      messages,
      stream: false,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      ...(tools.length ? { tools, tool_choice: 'auto' as const } : {}),
    }),
    opts,
  );
}

/** 用页面里的登录会话（WebUI 的 JWT）换一个长期 API Key；不用手动粘贴。 */
export async function mintApiKey(sessionToken: string, opts: ChatOptions = {}): Promise<string> {
  if (!sessionToken) throw new LlmError(401, '还没有登录 chat.zzu.edu.cn 的会话');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${LLM_BASE}/api/v1/auths/api_key`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new LlmError(res.status, raw.slice(0, 200) || '换取 API Key 失败');
    const json = JSON.parse(raw) as { api_key?: string };
    const key = (json.api_key ?? '').trim();
    if (!key.startsWith('sk-')) throw new LlmError(0, '服务端没返回 sk- key');
    return key;
  } catch (e) {
    if (e instanceof LlmError) throw e;
    const name = (e as { name?: string }).name;
    if (name === 'AbortError') throw new LlmError(408, '超时（可能不在校园网）');
    throw new LlmError(0, `连不上 chat.zzu.edu.cn：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const TOOL_NAMES = Object.keys(TOOLS) as Array<keyof typeof TOOLS>;

const intentSchema = z.object({
  tool: z.union([z.enum(TOOL_NAMES as [string, ...string[]]), z.null()]),
  args: z.record(z.unknown()).optional(),
});

const INT_ARGS = new Set(['minSeats', 'week', 'fromWeek', 'limit']);
const ARR_ARGS = new Set(['sections']);
const STR_ARGS = new Set(['campus', 'keyword', 'date', 'building']);

/**
 * 模型给的 args 类型常常不对（`campus: 1`、`sections: 5`、`minSeats: "100"`）。
 * 这里按已知的工具参数类型做一次保守收敛，收不动的直接丢掉，
 * 最后再用工具自己的 zod schema 校验，失败就退回空参数。
 */
function coerceArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === '') continue;
    if (ARR_ARGS.has(k)) {
      const arr = Array.isArray(v) ? v : [v];
      const nums = arr.map((x) => Number(x)).filter((n) => Number.isFinite(n));
      if (nums.length) out[k] = nums;
      continue;
    }
    if (k === 'day') {
      if (v === 'today' || v === 'tomorrow') out[k] = v;
      else {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= 7) out[k] = n;
      }
      continue;
    }
    if (INT_ARGS.has(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = Math.trunc(n);
      continue;
    }
    if (STR_ARGS.has(k)) {
      // campus: 1 这种「类型对不上语义」的值没有意义，丢掉比猜好
      if (typeof v !== 'string') continue;
      const s = v.trim();
      if (s) out[k] = s;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** 从模型输出里抠出第一个完整 JSON 对象并校验。解析失败 → null。 */
export function parseIntentsJson(raw: string): Intent | null {
  const text = stripThink(raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const check = intentSchema.safeParse(parsed);
  if (!check.success) return null;
  const { tool } = check.data;
  if (!tool) return null;
  // 模型爱把没用到的参数写成 null（DeepSeek-R1 尤其），先剥掉再收敛类型。
  const args = coerceArgs(check.data.args ?? {});
  const def = TOOLS[tool as keyof typeof TOOLS] as { schema: z.ZodType<unknown> } | undefined;
  // 模型可能编一个不存在的工具名（老提示词里出现过的 search_notice 之类），别让这里崩
  if (!def) return null;
  const schema = def.schema;
  const first = schema.safeParse(args);
  if (first.success) return { tool: tool as Intent['tool'], args: args, reason: 'LLM 判定' };
  const fallback = schema.safeParse({});
  if (!fallback.success) return null;
  return { tool: tool as Intent['tool'], args: {}, reason: 'LLM 判定（参数已丢弃）' };
}

function buildSystemPrompt(today: string): string {
  return [
    '你是郑州大学「校园信息层」的助手，服务对象是这名学生本人。',
    '',
    '你有两件事要做，二选一：',
    '1) 这句话需要查他本人的数据（课表/空教室/通知/成绩/考试/学分/一卡通/待办/学校服务入口）→',
    '   只输出一行严格 JSON：{"tool":"工具名","args":{...}}，不要任何解释、不要 markdown。',
    '2) 其它情况（打招呼、闲聊、问你是谁、问一般常识、问怎么用）→ 直接用中文正常回答，两三句就够，',
    '   不要输出 JSON，也不要罗列功能清单。',
    '',
    '可用工具与参数：',
    '- get_schedule：课表。args: { week?: number(1-20，仅在用户说「第 N 周」时用绝对周次),' +
      ' weekOffset?: number(0=本周、1=下周、-1=上周，用户说「下周/上周」时用它), day?: "today"|"tomorrow"|1-7 }',
    '- find_free_room：空教室/自习室。args: { date?: "YYYY-MM-DD", sections?: number[], minSeats?: number,' +
      ' campus?: string, building?: string }；building 填用户说的地点原词（南核 / 北核 / 北1 / 物理馆 / 材料馆）',
    '- find_notices：通知卡片（讲座/比赛/活动/会议/教务/生活）。args: { category?: "lecture"|"competition"|"activity"|"meeting"|"academic"|"life",' +
      ' topic?: string（教务子类：选课/考试/成绩/学籍/毕业/实习…）, keyword?: string, withinDays?: number(0-365),' +
      ' sort?: "published"|"deadline" }',
    '- get_grades：成绩/绩点。args: {}',
    '- get_exams：考试安排。args: {}',
    '- export_ics：导出日历。args: { fromWeek?: number }',
    '- get_plan_progress：培养方案学分进度（还差多少学分、哪些课没修）。args: {}',
    '- get_card：校园一卡通余额与最近流水。args: {}',
    '- get_todos：待办事项。args: {}',
    '- open_service：打开学校某个在线服务（座位预约、网上办事大厅、图书馆…）。args: { keyword: string }',
    '',
    '规矩：',
    '- 需要查数据时，只用上面列出的工具名；args 里没用到的参数直接省略，不要写 null。',
    '- 绝不编造数字、课程名、教室名、通知标题。你自己算不准日期（实测会把「后天」算成明天），',
    '  所以带「今天/明天/后天」的话，别自己换算成具体日期，交给工具的去相对日期参数（day/date 都可以留空）。',
    '- 实在既不用查数据、也说不出有用的话，就回一句「这个我帮不上，换个问法试试」。',
    `今天是 ${today}（周${'一二三四五六日'[weekdayOf(today) - 1] ?? '?'}）。`,
  ].join('\n');
}

/** 从模型输出里认出「自由回答」：纯文本，或 {"reply": "..."}。 */
export function parseModelReply(raw: string): string | null {
  const text = stripThink(raw).trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { reply?: unknown };
      if (typeof j.reply === 'string' && j.reply.trim()) return j.reply.trim();
    } catch {
      /* 落到下面当纯文本 */
    }
    return null;
  }
  return text.slice(0, 1200);
}


/** L1：规则没命中时，用模型判一次意图。任何异常都返回 null（回落反问）。 */
export async function classifyIntent(
  text: string,
  today: string,
  cfg: LlmSettings,
  opts: ChatOptions = {},
): Promise<Intent | null> {
  const attempt = await classifyIntentVerbose(text, today, cfg, opts);
  return attempt.intent;
}

export interface LlmAttempt {
  intent: Intent | null;
  /** 模型没判工具、而是直接回了句话（闲聊/解释/反问） */
  reply?: string;
  /** 为什么没判出来（给界面看的）；判出来了就没有这个字段 */
  error?: string;
  ms: number;
  /** 是否真的发过请求（没配置/被混合内容提前拦下时为 false） */
  called: boolean;
}

/**
 * 同 classifyIntent，但把「为什么没成」也带回来。
 * 之前这里静默吞掉所有异常，用户看到的是兜底帮助文案，
 * 完全分不清「模型挂了」和「模型觉得没听懂」——这个函数就是修那个。
 */
export async function classifyIntentVerbose(
  text: string,
  today: string,
  cfg: LlmSettings,
  opts: ChatOptions = {},
): Promise<LlmAttempt> {
  const t0 = Date.now();
  if (!cfg.enabled || !cfg.apiKey) {
    return { intent: null, ms: 0, called: false, error: cfg.enabled ? '还没有填 API Key' : '模型兜底没打开' };
  }
  const provider = resolveProvider(cfg.provider);
  // https 页面调 http 服务必被浏览器拦，别白等 30 秒
  if (provider.baseUrl.startsWith('http:') && isHttpsPage()) {
    return {
      intent: null,
      ms: 0,
      called: false,
      error: `${provider.label} 是 http 服务，HTTPS 页面会被浏览器按混合内容拦掉；换成 https 的服务商。`,
    };
  }
  try {
    // R1 带推理段，实测一次 11–25s；这里给到 30s，超时就当判不出（回落反问）。
    const answer = await llmChat(
      cfg,
      [
        { role: 'system', content: buildSystemPrompt(today) },
        { role: 'user', content: text },
      ],
      { timeoutMs: opts.timeoutMs ?? 30_000, maxTokens: 800, ...opts },
    );
    const intent = parseIntentsJson(answer);
    if (intent) return { intent, ms: Date.now() - t0, called: true };
    // 没判出工具 → 看它是不是在正常说话（打招呼、解释、反问都算）
    const reply = parseModelReply(answer);
    if (reply) return { intent: null, reply, ms: Date.now() - t0, called: true };
    return {
      intent: null,
      ms: Date.now() - t0,
      called: true,
      error: `模型没给出工具调用，也没给出可用的回答（回复：${answer.slice(0, 80) || '空'}）`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { intent: null, ms: Date.now() - t0, called: true, error: message };
  }
}

/** 「测试连接」用：发一条最短的请求，把状态、耗时、错误原文带回来。 */
export async function probeLlm(
  cfg: Pick<LlmSettings, 'provider' | 'apiKey' | 'model'>,
  opts: ChatOptions = {},
): Promise<{ ok: boolean; ms: number; model: string; text?: string; error?: string }> {
  const provider = resolveProvider(cfg.provider);
  const model = (cfg.model ?? '').trim() || provider.model;
  const t0 = Date.now();
  try {
    const text = await llmChat(cfg, [{ role: 'user', content: 'ping，只回一个 ok' }], {
      timeoutMs: opts.timeoutMs ?? 20_000,
      maxTokens: 16,
      ...opts,
    });
    return { ok: true, ms: Date.now() - t0, model, text: text.slice(0, 60) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, model, error: e instanceof Error ? e.message : String(e) };
  }
}
