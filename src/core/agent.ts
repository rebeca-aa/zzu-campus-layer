import { CampusService, CampusSession } from './services';
import { AREA_NAMES } from './library';
import { extractRoomName, helpText, parseIntent, relativeDayOffset, relativeWeekOffset, type Intent } from './intent';
import {
  classifyIntentVerbose,
  llmChatWithTools,
  resolveProvider,
  type LlmSettings,
  type WireMessage,
} from './llm';
import { TOOLS, ToolName, runTool } from './tools';
import { activeToolSpecs } from './toolspec';
import { resolveUtterance } from './utterance';
import { addDays, todayShanghai, weekdayOf } from './util';

export interface AskResult {
  text: string;
  tool?: ToolName;
  data?: Record<string, unknown>;
  error?: string;
  /**
   * 这条回答是怎么来的：
   *  - agent   ：模型带工具循环自己编排（新默认，需要支持 function calling 的模型）
   *  - rule    ：规则层直接命中（没配模型 / 模型不可用时仍然可用）
   *  - llm     ：老路径：模型只判一个工具（学校 R1 那种不支持的模型）
   *  - llm-chat：老路径：模型直接说话
   *  - none    ：谁都没接住
   */
  via?: 'agent' | 'rule' | 'llm' | 'llm-chat' | 'none';
  /** 模型没帮上忙时的原因（界面要显示，否则用户分不清「模型挂了」和「没听懂」） */
  llmError?: string;
  /** 这次调用模型花了多久 */
  llmMs?: number;
  /** 学校 key 失效后自动换了一次并重试成功（由 background 填） */
  llmRefreshed?: boolean;
  /** agent 模式下这一轮调了哪些工具（按顺序，界面可以画成轨迹） */
  steps?: string[];
}

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskOptions {
  /** 模型配置；不传或 enabled=false 时退化成纯规则 */
  llm?: LlmSettings;
  /** 最近几轮对话，让「那明天呢」这种追问有上下文 */
  history?: HistoryItem[];
  /** 工具循环最多跑几步（默认 4） */
  maxSteps?: number;
}

const MAX_HISTORY = 8;
const MAX_TOOL_PAYLOAD = 3000;

/** 只给界面用的重字段：模型看了没用，还会挤掉上下文（座位图 data URI 一个人就 20KB） */
const UI_ONLY_KEYS = ['image', 'seats', 'ics', 'raw', 'svg'];

/** 工具返回给模型的内容：正文 + 精简后的结构化数据。 */
function toolMessage(text: string, data: Record<string, unknown> | undefined): string {
  let slim: Record<string, unknown> | undefined;
  if (data) {
    slim = {};
    for (const [k, v] of Object.entries(data)) {
      if (UI_ONLY_KEYS.includes(k)) continue;
      slim[k] = v;
    }
    if (Array.isArray(slim.seats)) delete slim.seats;
  }
  const payload = JSON.stringify({ text, ...(slim && Object.keys(slim).length ? { data: slim } : {}) });
  return payload.length > MAX_TOOL_PAYLOAD ? `${payload.slice(0, MAX_TOOL_PAYLOAD)}…(截断)` : payload;
}

/**
 * 用户原话里已经说清楚的相对日期/时段，覆盖模型给的值。
 * 模型算日期不可靠（实测把「后天」算成明天），这条规则比提示词管用。
 */
/* 用户原话里可能出现的房间名 → 服务端区域 id（实测） */
const ROOM_NAMES_OF_TEXT: Record<string, string> = {
  一楼大厅: '3',
  '工程与信息技术书库-1': '8',
  工程与信息技术书库: '8',
  '工程与信息书库-2': '9',
  '社会科学书库-1': '11',
  '社会科学书库-2': '12',
  社会科学书库: '11',
  语言文史书库: '13',
  三楼西大厅: '14',
  三楼中: '15',
  三楼东大厅: '16',
  自然与外文书库: '17',
  电子阅览室: '18',
  四楼西大厅: '19',
  四楼东大厅: '20',
  期刊阅览室: '76',
};

export function applyTextHints(name: string, args: Record<string, unknown>, text: string, today: string): Record<string, unknown> {
  // FLOOR_HINT：座位图/余量的 areaId 只信用户原话里的楼层，别信模型自己编的数字
  {
    const toolName = String(name ?? '');
    if (toolName === 'library_seat_map' || toolName === 'library_seats' || toolName === 'book_library_seat') {
      const floor = /(一|1)\s*楼|大厅/.test(text)
        ? '一楼'
        : /(二|2)\s*楼/.test(text)
          ? '二楼'
          : /(三|3)\s*楼/.test(text)
            ? '三楼'
            : /(四|4)\s*楼/.test(text)
              ? '四楼'
              : '';
      const room = Object.keys(ROOM_NAMES_OF_TEXT).find((r) => text.includes(r));
      const next = { ...(args as Record<string, unknown>) };
      if (room) next.areaId = ROOM_NAMES_OF_TEXT[room];
      else if (floor) next.areaId = floor;
      else if (typeof next.areaId === 'string' && Object.values(ROOM_NAMES_OF_TEXT).includes(next.areaId)) {
        // 模型给的就是房间名，保留
      }
      args = next;
    }
  }
  /* ROOM_HINT：用户点名了某间房（如"工程与信息书库-2"）→ 固定成单间查询，
     不许再带 floor（否则工具会按"整层展开"返回所有房间的图） */
  if (/library_seat_map|book_library_seat/.test(name)) {
    const roomHit = Object.entries(AREA_NAMES)
      .map(([id, name]) => ({ id, name }))
      .filter(
        (it) =>
          it.name.length >= 3 &&
          (text.includes(it.name) ||
            (it.name.length >= 4 && text.includes(it.name.slice(0, 4)))),
      )
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (roomHit) {
      args = { ...args, room: roomHit.name, areaId: roomHit.id };
      delete (args as Record<string, unknown>).floor;
    }
  }



  const out = { ...args };
  const off = relativeDayOffset(text);
  const period = /上午|早上|一早/.test(text)
    ? 'morning'
    : /下午|午后/.test(text)
      ? 'afternoon'
      : /晚上|夜里|傍晚/.test(text)
        ? 'evening'
        : undefined;
  if (name === 'find_free_room') {
    if (off !== undefined) out.date = addDays(today, off);
    if (period && !out.sections) {
      out.sections = period === 'morning' ? [1, 2, 3, 4] : period === 'afternoon' ? [5, 6, 7, 8] : [9, 10];
    }
  }
  if (name === 'get_schedule') {
    if (off !== undefined) out.day = off === 0 ? 'today' : off === 1 ? 'tomorrow' : weekdayOf(addDays(today, off));
    if (period && !out.period) out.period = period;
    // 周次也一样：用户说了「下周」就按相对周算；只说了「第 N 周」才用绝对周次。
    if (!/第\s*\d{1,2}\s*周/.test(text)) {
      const weekOffset = relativeWeekOffset(text);
      const dated = off === 0 || off === 1;
      if (weekOffset !== undefined && weekOffset !== 0) {
        delete out.week;
        out.weekOffset = weekOffset;
      } else if (dated) {
        // 按天查时周次必须由日期推，模型/正则塞进来的绝对周次一律丢掉
        delete out.week;
        delete out.weekOffset;
      }
    }
  }
  if (name === 'library_seat_map') {
    // 模型常常漏掉房间名；用户话里带了就补上（只给楼层时不补，那是「列全部房间」）
    const room = extractRoomName(text);
    if (room) out.room = room;
    else delete out.room;
  }
  return out;
}

function parseToolArgs(raw: string): Record<string, unknown> {
  const text = (raw ?? '').trim();
  if (!text) return {};
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  } catch {
    // 模型偶尔会带 ```json 包裹或尾逗号，抠第一对花括号再试一次
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        const j = JSON.parse(text.slice(s, e + 1)) as unknown;
        return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}

/**
 * 模型当执行核心的循环：给工具规格 → 模型要数据就调工具 → 结果回灌 → 直到它给出回答。
 *
 * 与老路径的区别：以前模型只输出 `{"tool":...}` 一个决定，正文永远由模板渲染；
 * 现在模型自己决定调几次、调哪几个，回答也由它组织（工具结果作为唯一事实来源）。
 */
async function runAgent(
  text: string,
  session: CampusSession,
  cfg: LlmSettings,
  opts: AskOptions,
): Promise<AskResult> {
  const today = session.today ?? todayShanghai();
  const svc = new CampusService(session);
  const tools = activeToolSpecs();
  const t0 = Date.now();

  const messages: WireMessage[] = [
    { role: 'system', content: buildAgentPrompt(today) },
    ...(opts.history ?? [])
      .slice(-MAX_HISTORY)
      .filter((h) => h.content?.trim())
      .map((h) => ({ role: h.role, content: h.content }) as WireMessage),
    { role: 'user', content: text },
  ];

  const used: string[] = [];
  let lastTool: { name: ToolName; text: string; data?: Record<string, unknown> } | null = null;
  let answer = '';
  const maxSteps = opts.maxSteps ?? 4;

  for (let step = 0; step < maxSteps; step += 1) {
    const reply = await llmChatWithTools(cfg, messages, tools, {
      // 带工具的模型（deepseek-chat 等）单轮 2-6s，给够余量
      timeoutMs: 45_000,
      maxTokens: 1200,
      temperature: 0.2,
    });

    if (reply.toolCalls.length === 0) {
      answer = reply.content.trim();
      break;
    }

    messages.push({
      role: 'assistant',
      content: reply.content || null,
      tool_calls: reply.toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.argsRaw || '{}' },
      })),
    });

    for (const call of reply.toolCalls) {
      const name = call.name as ToolName;
      if (!(name in TOOLS)) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: `没有叫 ${call.name} 的工具，可用：${Object.keys(TOOLS).join('、')}` }),
        });
        continue;
      }
      const args = applyTextHints(name, parseToolArgs(call.argsRaw), text, today);
      used.push(name);
      try {
        const result = await runTool(name, args, svc);
        lastTool = { name, text: result.text, ...(result.data ? { data: result.data } : {}) };
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolMessage(result.text, result.data) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: msg }) });
      }
    }
  }

  // 模型一步就停了、没说人话 → 用最后一个工具的结果兜底（宁可给原始数据，也别空着）
  if (!answer) {
    if (lastTool) answer = lastTool.text;
    else answer = '这个我没查到东西，换个说法试试？';
  }

  return {
    text: answer,
    ...(lastTool ? { tool: lastTool.name } : {}),
    ...(lastTool?.data ? { data: lastTool.data } : {}),
    via: 'agent',
    llmMs: Date.now() - t0,
    ...(used.length ? { steps: used } : {}),
  };
}

function buildAgentPrompt(today: string): string {
  return [
    '你是「校园信息层」的助手，服务对象是一名郑州大学学生本人。你手里有工具，能直接查他自己的数据。',
    '',
    '工作方式：',
    '- 需要他的真实数据（课表、空教室、通知、成绩、考试、学分、一卡通、待办）时，**调用工具**，不要凭印象回答。',
    '- 一次没查够可以再调；拿到结果后，用自然的话回答他，就像你在替他查系统。',
    '- 只使用工具返回的内容。工具没给的数字、课程名、教室名、通知标题，**一律不许编**；查不到就直说没查到。',
    '- 用户说的是「今天/明天/后天」时，不要自己换算成具体日期，把日期参数留给服务端（工具说明里有写）。',
    '- 用户要「预约座位」「报名」「交材料」这类**必须本人操作**的事：说明目前只能给入口，不能替他完成，',
    '  然后用 open_service 给出入口。别假装已经预约成功。',
    '- 图书馆座位相关的**不要贴网址、不要让他点链接**（那个站网页登录在 App 里走不通）。',
    '  没登录就说去「我的 → 图书馆登录」用学号 + 图书馆密码登一次，回来再说；已经登录就直接给座位图。',
    '- 「南核」是南核心教学区（南1–南5 的楼），**不是「南校区」**。用户说南核/北核/南4 这类楼或教学区时，',
    '  只填 find_free_room 的 building，不要补 campus；补了 campus 会被按校区先筛，结果直接变 0 间。',
    '- 回答用中文，短句为主，可以用 `-` 列表；不要输出 JSON、不要贴大段表格、不要重复用户的问题。',
    '- 涉及他自己数据时，引用具体值（几点上课、余额多少），但别把整个 JSON 倒出来。',
    '',
    '风格：像一个熟悉教务系统、说话干脆的学长。不知道就说不知道。',
    `今天是 ${today}（周${'一二三四五六日'[weekdayOf(today) - 1] ?? '?'}），时区 Asia/Shanghai。`,
  ].join('\n');
}

/**
 * 说法库兜底：把「没被正则接住的一句话」对到语料里最像的那句。
 *
 * 只在**没配模型**时走这里，所以接了 key 的人行为一点没变。
 * 两道保险：分数要过 `EXECUTE_SCORE`；工具自己的 schema 必须认可这组参数——
 * 认可不了就当没听懂（宁可让用户重说，也不能跑错工具）。
 */
export function guessIntentByPhrase(text: string, today: string): Intent | null {
  const hit = resolveUtterance(text);
  if (!hit) return null;
  const def = TOOLS[hit.tool];
  const hinted = applyTextHints(hit.tool, hit.args ?? {}, text, today);
  const parsed = def.schema.safeParse(hinted);
  if (!parsed.success) return null;
  return {
    tool: hit.tool,
    args: parsed.data as Record<string, unknown>,
    reason: `说法库 ${hit.score.toFixed(2)}：「${hit.matched}」`,
  };
}

/** 老路径：规则优先，模型只判一个工具（给不支持 function calling 的模型用）。 */
async function runClassic(
  text: string,
  session: CampusSession,
  opts: AskOptions,
): Promise<AskResult> {
  const today = session.today ?? todayShanghai();
  const llm = opts.llm;
  const llmReady = Boolean(llm?.enabled && llm.apiKey);
  let intent = parseIntent(text, today);
  // 正则没接住、又没配模型 —— 用离线说法库再试一次（配了模型的人不会走到这里）
  if (!intent && !llmReady) intent = guessIntentByPhrase(text, today);
  let via: AskResult['via'] = intent ? 'rule' : 'none';
  let llmError: string | undefined;
  let llmMs: number | undefined;
  let llmReply: string | undefined;

  if (!intent && llmReady && llm) {
    const attempt = await classifyIntentVerbose(text, today, llm);
    llmMs = attempt.ms;
    if (attempt.intent) {
      intent = attempt.intent;
      via = 'llm';
    } else if (attempt.reply) {
      llmReply = attempt.reply;
    } else if (attempt.error) {
      llmError = attempt.error;
    }
  }

  if (!intent) {
    if (llmReply) return { text: llmReply, via: 'llm-chat', ...(llmMs ? { llmMs } : {}) };
    return {
      text: helpText(today),
      via: 'none',
      ...(llmError ? { llmError } : {}),
      ...(llmMs ? { llmMs } : {}),
    };
  }

  if (via === 'llm') {
    const off = relativeDayOffset(text);
    if (off !== undefined || /上午|下午|晚上/.test(text)) {
      intent.args = applyTextHints(intent.tool, intent.args as Record<string, unknown>, text, today);
    }
  }

  const svc = new CampusService(session);
  try {
    const result = await runTool(intent.tool, intent.args, svc);
    return {
      text: result.text,
      tool: intent.tool,
      via,
      ...(result.data ? { data: result.data } : {}),
      ...(llmMs ? { llmMs } : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { text: `出错了：${message}`, tool: intent.tool, via, error: message, ...(llmMs ? { llmMs } : {}) };
  }
}

/**
 * 一句话的完整处理链。
 *
 * 有支持 function calling 的模型 → 模型当执行核心（工具循环，回答也由它组织）；
 * 没有模型 / 模型不支持工具 → 退化成规则层（离线也能查课表），
 * 中途模型挂了也会回落到规则层，并把原因带在 `llmError` 里。
 */
export async function ask(text: string, session: CampusSession, opts: AskOptions = {}): Promise<AskResult> {

  const cfg = opts.llm;
  const canUseTools = Boolean(cfg?.enabled && cfg.apiKey && resolveProvider(cfg.provider).supportsTools);

  if (!canUseTools) return runClassic(text, session, opts);

  try {
    return await runAgent(text, session, cfg as LlmSettings, opts);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 模型这条路挂了（没网/401/超时），但规则层还能用——别让用户什么都没查到
    const fallback = await runClassic(text, session, opts);
    return { ...fallback, llmError: message };
  }
}
