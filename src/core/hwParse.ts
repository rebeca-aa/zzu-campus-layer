/**
 * 作业识别：先用模型抽一遍，抽不动再退回规则。
 *
 * 为什么要有这一层：群里的话是「给人看的」，格式随便——
 *   「@所有人 这周的作业：高数习题 3.1–3.4 周五交；大物实验报告下周一之前；
 *     英语作文二记得传雨课堂，周日晚上12点前」
 * 规则只能靠「句子里有日期」硬切，漏得厉害（2026-11 之前的版本就是这样）。
 * 模型读一段话、按字段吐 JSON 的准确率明显高，所以这里把模型当主路径，
 * **但结果仍然只是草稿**：界面让用户逐条过一遍再进清单（宁可错过也不错）。
 *
 * 两条硬约束：
 *  - 没有 Key / 模型关了 / 调用失败，一律静默退回 `parseHomework`，功能不能因此挂掉；
 *  - 模型给的时间一律再过一遍本地 `parseDueAt` 兜底/夹正，绝不直接信它编的年份。
 */
import { LlmError, llmChat, llmChatVision, resolveProvider, visionModelFor } from './llm';
import { getLlmSettings, type LlmSettingsStored } from './storage';
import { parseDueAt, parseHomework, type HomeworkDraft } from './homework';

const DAY = 86_400_000;
/** 一次最多出这条数，多了用户也懒得看 */
const MAX_ITEMS = 8;

export interface HwParseOutcome {
  drafts: HomeworkDraft[];
  /** llm = 模型抽的；rule = 规则抽的（退化路径） */
  via: 'llm' | 'rule';
  /** 给界面的一句话：为什么走这条路径、补了几条 */
  note?: string;
}

type ChatFn = (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>;

export interface HwParseOptions {
  now?: number;
  /** 允许调用方直接给设置（界面里已经读过了，省一次 IO） */
  settings?: Pick<LlmSettingsStored, 'enabled' | 'provider' | 'apiKey' | 'model'>;
  /** 测试注入：替换真实的 llmChat */
  chat?: ChatFn;
  timeoutMs?: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 提示词里要写清「今天是几号几点、星期几」，模型猜日期全靠它 */
function nowLine(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WD[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function systemPrompt(now: number): string {
  return [
    '你是作业信息抽取器，只做一件事：从一段群消息里挑出「要交的作业」，输出 JSON。',
    `现在是 ${nowLine(now)}（北京时间）。今天是星期${WD[new Date(now).getDay()]}。`,
    '',
    '输出格式（只输出 JSON，不要解释、不要代码块）：',
    '{"items":[{"title":"习题册 3.1–3.4","course":"高等数学","due":"2026-11-20T23:59:00+08:00","note":"交纸质"}]}',
    '',
    '规则：',
    '1. title：要交的东西，去掉「@所有人」「通知」「作业：」这类前缀和寒暄，≤60 字；不要带截止时间。',
    '2. course：只有原文能看出课程名才写（如「高数作业」「大学物理实验」），看不出就省略这个字段。',
    '3. due：必须带时区的完整时间（如 2026-11-20T23:59:00+08:00）。',
    '   - 「周五前」= 本周五 23:59（今天已经过了就下周）；「下周一」= 下周一 23:59；',
    '   - 「明天中午」= 明天 12:00；「明晚 8 点」= 明天 20:00；「周日晚 12 点」= 周日 23:59；',
    '   - 只说了「这周内」= 本周日 23:59；完全没提时间的条目不要输出。',
    '4. note：只写交法（纸质 / 学习通 / 雨课堂 / 实验报告），没有就省略。',
    '5. 一段话里可能有好几门课、好几条作业：逐条拆开，同一个作业不要重复输出。',
    '6. 拿不准的字段宁可省略，不要编。',
  ].join('\n');
}

/** 模型爱把 JSON 包在 ```json 里，也爱在前后加解释——取第一个 { 到最后一个 } */
function extractJson(raw: string): unknown {
  const text = raw.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    /* 也可能直接吐了数组 */
    const a = text.indexOf('[');
    const b = text.lastIndexOf(']');
    if (a < 0 || b <= a) return null;
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 从可能被截断 / 夹了废话的回复里捞出完整的条目对象。
 * 模型写到一半被 max_tokens 掐断时，整段 JSON.parse 会失败，
 * 但前面几条其实都是完整的——按大括号配对扫，能捞一条是一条。
 */
function salvageItems(text: string): unknown[] {
  const out: unknown[] = [];
  const isTitle = (o: Record<string, unknown>): boolean =>
    ['title', 'name', 'content', 'text'].some((k) => typeof o[k] === 'string' && String(o[k]).trim());
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    /* 这一段没配对（整个外壳被截断）就继续从里面找，别整段放弃 */
    if (end < 0) continue;
    try {
      const obj = JSON.parse(text.slice(i, end + 1)) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && isTitle(obj as Record<string, unknown>)) {
        out.push(obj);
        i = end;
      }
      /* 不是条目（比如最外层的 {"items":[...]}）就继续扫里面 */
    } catch {
      /* 这一段不是合法对象，继续往后扫 */
    }
  }
  return out;
}
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 「高数作业：」这种前缀去掉，课程名已经单列在 course 里了。
 *  只剥「课程 + 作业/报告 + 冒号」——「英语作文二」里的「作文」是作业名本身，剥了就剩个「二」。 */
function stripCoursePrefix(title: string, course: string | undefined): string {
  if (!course) return title;
  const re = course.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^${re}\\s*(?:课)?\\s*(?:作业本|作业|实验报告|报告)\\s*[:：,，]?\\s*`);
  const stripped = title.replace(head, '').trim();
  return stripped.length >= 2 && stripped !== title ? stripped : title;
}

export interface NormalizedLlmItems {
  drafts: HomeworkDraft[];
  /** 有几条时间是我们替它兜底的（没写清楚 / 编得太离谱） */
  guessed: number;
}

/** 把模型吐的东西洗成草稿：字段别名、时间夹正、去重、上限 */
export function normalizeLlmItems(raw: unknown, now = Date.now()): NormalizedLlmItems {
  const box = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(raw) ? raw : Array.isArray(box.items) ? box.items : [];
  const out: HomeworkDraft[] = [];
  const seen = new Set<string>();
  let guessed = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const rawTitle = oneLine(String(o.title ?? o.name ?? o.content ?? o.text ?? ''));
    if (!rawTitle) continue;
    const course = oneLine(String(o.course ?? o.subject ?? o.kemu ?? '')).slice(0, 30) || undefined;
    const title = stripCoursePrefix(rawTitle, course).slice(0, 80);
    if (!title) continue;
    const noteRaw = oneLine(String(o.note ?? o.how ?? o.submit ?? '')).slice(0, 60);
    const dueRaw = o.due ?? o.dueAt ?? o.deadline ?? o.date;

    let dueAt = Number.NaN;
    if (typeof dueRaw === 'number' && Number.isFinite(dueRaw)) dueAt = dueRaw;
    else if (typeof dueRaw === 'string' && dueRaw.trim()) {
      const parsed = Date.parse(dueRaw);
      if (Number.isFinite(parsed)) dueAt = parsed;
      else {
        const local = parseDueAt(dueRaw, now);
        if (local !== null) dueAt = local;
      }
    }
    /* 模型偶尔会给一个「去年」的日期（它记住的训练数据），跨得太远就往后推一年 */
    if (Number.isFinite(dueAt) && dueAt < now - 40 * DAY) dueAt += 365 * DAY;
    if (!Number.isFinite(dueAt)) {
      /* 兜底：明天 23:59，界面里用户能改 */
      const d = new Date(now + DAY);
      d.setHours(23, 59, 0, 0);
      dueAt = d.getTime();
      guessed += 1;
    }
    const key = `${title}|${dueAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      ...(course ? { course } : {}),
      dueAt,
      ...(noteRaw ? { note: noteRaw } : {}),
      source: 'paste',
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return { drafts: out, guessed };
}

/** 比标题是不是同一条作业：去标点空白后互相包含，或字符二元组重合过半 */
export function sameHomeworkTitle(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(x);
  const gb = grams(y);
  if (!ga.size || !gb.size) return false;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / Math.min(ga.size, gb.size) >= 0.6;
}

function ruleOutcome(text: string, now: number, note: string): HwParseOutcome {
  return { drafts: parseHomework(text, now), via: 'rule', note };
}

/**
 * 识别一段群消息。
 * 只会在「有 Key 且模型开着」时真的发请求；其它情况同步退化成规则解析。
 */
export async function parseHomeworkSmart(text: string, opts: HwParseOptions = {}): Promise<HwParseOutcome> {
  const now = opts.now ?? Date.now();
  const body = text.trim();
  if (!body) return { drafts: [], via: 'rule', note: '先粘一段群消息进来' };

  let settings: Pick<LlmSettingsStored, 'enabled' | 'provider' | 'apiKey' | 'model'>;
  try {
    settings = opts.settings ?? (await getLlmSettings());
  } catch {
    return ruleOutcome(text, now, '读不到模型设置，用的是规则识别');
  }
  if (!settings.enabled) return ruleOutcome(text, now, '模型在设置里关掉了，用的是规则识别');
  if (!settings.apiKey.trim()) {
    return ruleOutcome(text, now, '还没填模型 Key：先用规则识别，去「我的 → 模型」配一个会更准');
  }

  const chat: ChatFn =
    opts.chat ??
    ((messages) =>
      llmChat(
        { provider: settings.provider, apiKey: settings.apiKey, model: settings.model },
        messages,
        { maxTokens: 900, temperature: 0, timeoutMs: opts.timeoutMs ?? 30_000 },
      ));

  let raw: string;
  try {
    raw = await chat([
      { role: 'system', content: systemPrompt(now) },
      { role: 'user', content: `群消息原文：\n${body}` },
    ]);
  } catch (err) {
    const msg = err instanceof LlmError ? err.message : (err as Error)?.message ?? String(err);
    return ruleOutcome(text, now, `模型没答上来（${msg}），先用规则识别`);
  }

  const parsedText = extractJson(raw);
  let { drafts: llmDrafts, guessed } = normalizeLlmItems(parsedText, now);
  if (!llmDrafts.length) {
    /* 和读图一样：JSON 被截断时按对象逐个捞，别整段丢掉 */
    const salvaged = salvageItems(raw);
    if (salvaged.length) {
      const again = normalizeLlmItems(salvaged, now);
      if (again.drafts.length) {
        llmDrafts = again.drafts;
        guessed = again.guessed;
      }
    }
  }
  if (!llmDrafts.length) {
    return ruleOutcome(text, now, '模型说这段里没有能定的作业，改用规则识别');
  }

  /* 规则结果里模型漏掉的补进来（模型偶尔会漏掉最后一条），按标题去重 */
  const merged = llmDrafts.slice();
  let added = 0;
  for (const rule of parseHomework(text, now)) {
    if (added >= MAX_ITEMS - merged.length) break;
    if (merged.some((d) => sameHomeworkTitle(d.title, rule.title) || d.dueAt === rule.dueAt)) continue;
    merged.push(rule);
    added += 1;
  }

  const label = resolveProvider(settings.provider).label;
  const bits: string[] = [`${label} 识别`];
  if (added) bits.push(`规则补了 ${added} 条`);
  const endedCnt = merged.filter((d) => d.dueAt < now).length;
  if (endedCnt) bits.push(`${endedCnt} 条截止时间已经过了，加进去会算逾期`);
  if (guessed) bits.push(`${guessed} 条没写清截止，先按明天 23:59`);
  return { drafts: merged, via: 'llm', note: bits.join(' · ') };
}

/* ─────────────────────────── 读图 ─────────────────────────── */

/** 一次最多读几张：多了既慢又贵，手机上截图一般 1–3 张就够 */
const MAX_IMAGES = 4;

type VisionChatFn = (prompt: string, images: string[], model: string) => Promise<string>;

export interface HwImageOptions {
  now?: number;
  settings?: Pick<LlmSettingsStored, 'enabled' | 'provider' | 'apiKey' | 'model'>;
  /** 测试注入：替换真实的 llmChatVision */
  chat?: VisionChatFn;
  timeoutMs?: number;
}

function imagePrompt(now: number): string {
  return [
    systemPrompt(now).replace('从一段群消息里挑出', '从截图里挑出').replace('群消息原文：', ''),
    '',
    '这次输入是图片（群消息截图、通知截图、作业清单截图，可能糊、可能歪）。',
    '先把图里的文字在心里读出来，再按上面的规则拆成作业条目；',
    '图里如果是一张表格或者一列清单，就一条一条拆，别合并成一条。',
    '图里没有需要交的作业（比如只是闲聊、只是课程表）就输出 {"items":[]}。',
  ].join('\n');
}

/** 把服务商的「不支持图片」类报错翻成一句能指导用户的话 */
function imageErrorHint(msg: string): string {
  if (/image|vision|multimodal|content|attachment|modality|invalid_request|400|422/i.test(msg)) {
    return `这个模型好像不认图（${msg.slice(0, 80)}）——换一个识图模型再试，或者把文字直接粘进来`;
  }
  return `读图失败：${msg}`;
}

/**
 * 从截图里识别作业：只走模型（图里的字规则读不出来）。
 * 模型不能看图 / 没 Key / 调用失败时返回空草稿 + 说明，界面照常提示用户。
 */
export async function parseHomeworkFromImages(
  images: string[],
  opts: HwImageOptions = {},
): Promise<HwParseOutcome> {
  const now = opts.now ?? Date.now();
  const list = images.filter((u) => /^(data:image\/|https?:)/.test(u)).slice(0, MAX_IMAGES);
  if (!list.length) return { drafts: [], via: 'llm', note: '没拿到图片：换一张再试' };

  let settings: Pick<LlmSettingsStored, 'enabled' | 'provider' | 'apiKey' | 'model'>;
  try {
    settings = opts.settings ?? (await getLlmSettings());
  } catch {
    return { drafts: [], via: 'llm', note: '读不到模型设置，没法读图' };
  }
  const label = resolveProvider(settings.provider).label;
  if (!settings.enabled) {
    return { drafts: [], via: 'llm', note: '模型在设置里关掉了；读图只能靠模型，去「我的 → 模型」打开它' };
  }
  if (!settings.apiKey.trim()) {
    return {
      drafts: [],
      via: 'llm',
      note: '读图要靠模型：去「我的 → 模型」填一个支持看图的 Key（DeepSeek 官方、硅基流动、百炼、智谱、Moonshot、OpenRouter 都行）',
    };
  }
  const target = visionModelFor(settings);
  if (!target) {
    return {
      drafts: [],
      via: 'llm',
      note: `${label} 这边没有能看图的模型（它只能读文字）：换 DeepSeek 官方 / 硅基流动 / 百炼 / 智谱 / Moonshot / OpenRouter 再试`,
    };
  }

  const chat: VisionChatFn =
    opts.chat ??
    ((prompt, imgs, model) =>
      llmChatVision(
        { provider: settings.provider, apiKey: settings.apiKey, model: settings.model },
        prompt,
        imgs,
        { model, maxTokens: 4000, temperature: 0, timeoutMs: opts.timeoutMs ?? 45_000 },
      ));

  type Attempt = { raw: string; drafts: HomeworkDraft[]; guessed: number; empty: boolean };
  const attempt = async (prompt: string): Promise<Attempt> => {
    const raw = await chat(prompt, list, target.model);
    const parsed = extractJson(raw);
    const entries = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown[] })?.items;
    const first = normalizeLlmItems(parsed, now);
    if (first.drafts.length) return { raw, drafts: first.drafts, guessed: first.guessed, empty: false };
    /* 整段解析失败或被截断时，按对象逐个捞（模型常常只差最后几个字符） */
    const salvaged = salvageItems(raw);
    if (salvaged.length) {
      const again = normalizeLlmItems(salvaged, now);
      if (again.drafts.length) {
        return { raw, drafts: again.drafts, guessed: again.guessed, empty: false };
      }
    }
    return { raw, drafts: [], guessed: 0, empty: Array.isArray(entries) && entries.length === 0 };
  };

  let best: Attempt;
  try {
    best = await attempt(imagePrompt(now));
  } catch (err) {
    const msg = err instanceof LlmError ? err.message : (err as Error)?.message ?? String(err);
    return { drafts: [], via: 'llm', note: imageErrorHint(msg) };
  }

  /* 模型有时候先回一段解释、或者把 JSON 说在「思考」里。再要一次，这次只许 JSON。 */
  if (!best.drafts.length) {
    try {
      const again = await attempt(
        `${imagePrompt(now)}\n上一轮没有给出可用的 JSON。这次只输出一个 JSON 对象，不要解释、不要代码块。`,
      );
      if (again.drafts.length || (!best.raw.trim() && again.raw.trim())) best = again;
    } catch {
      /* 第二次失败就按第一次的结果说明原因 */
    }
  }

  if (!best.drafts.length) {
    if (best.empty) {
      return { drafts: [], via: 'llm', note: '图里没认出要交的作业；字迹太糊的话，直接把文字粘进来更稳' };
    }
    const peek = oneLine(best.raw).slice(0, 60);
    return {
      drafts: [],
      via: 'llm',
      note: peek
        ? `模型没读出能用的作业（它先说：${peek}…），换个清楚点的截图再试`
        : '模型回了空内容：可能是推理模型把结果写在思考里了，去「我的 → 模型」换个识图模型再试',
    };
  }
  const { drafts, guessed } = best;

  const bits: string[] = [
    `${label} 的 ${target.model.split('/').pop() ?? target.model} 读的${list.length > 1 ? ` ${list.length} 张图` : '图'}`,
  ];
  if (target.switched) bits.push(`你配的 ${settings.model || '默认模型'} 看不了图，顺手换了识图模型`);
  const ended = drafts.filter((d) => d.dueAt < now).length;
  if (ended) bits.push(`${ended} 条截止时间已经过了，加进去会算逾期`);
  if (guessed) bits.push(`${guessed} 条没写清截止，先按明天 23:59`);
  bits.push(`共 ${drafts.length} 条`);
  return { drafts, via: 'llm', note: bits.join(' · ') };
}