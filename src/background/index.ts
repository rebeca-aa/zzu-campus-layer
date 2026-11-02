import { todayShanghai } from '../core/util';
import { ask } from '../core/agent';
import { buildDigest, daysBetween, gradeFingerprint, newGradeNames } from '../core/watch';
import {
  buildCards,
  daysLeft,
  dueCards,
  dueLabel,
  parseNoticeNotification,
  type NoticeCard,
} from '../core/notice';
import { setNoticeFocus } from '../core/noticeStore';
import { CampusService } from '../core/services';
import type { CampusSession } from '../core/services';
import {
  ensureValidToken,
  clearTokens,
  exportTokenBundle,
  getChatSession,
  getLlmSettings,
  loadSession,
  saveChatSession,
  setLlmSettings,
  tokenStatuses,
  type LlmSettingsStored,
  type TokenSource,
  getWatchState,
  setWatchState,
} from '../core/storage';
import { mintApiKey, probeLlm, resolveProvider } from '../core/llm';
import { ensureFresh, ensureRenewed, hasUsableToken } from '../core/renew';
import { autoLoginLibrary, bookLibrarySeat, findLibraryTab } from '../core/libtab';
import { describeBook, type BookOutcome } from '../core/libBook';
import { TOOLS, getNoticeBody, runTool } from '../core/tools';

type Incoming =
  | { type: 'token'; source: TokenSource | 'chat'; token: string; reason?: string }
  | { type: 'ask'; text: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }
  | { type: 'status' }
  | { type: 'clear' }
  | { type: 'tool'; tool: keyof typeof TOOLS; args?: unknown }
  | { type: 'settings:get' }
  | { type: 'settings:set'; patch: Partial<LlmSettingsStored> }
  | { type: 'llm:test'; patch?: Partial<LlmSettingsStored> }
  | { type: 'chat:sync' }
  | { type: 'bundle:export' }
  | { type: 'lib:book'; args: { areaId: string; date: string; seatNo: string } }
  | { type: 'lib:status' }
  | { type: 'lib:autologin'; args: { account: string; password: string } }
  | { type: 'notice:detail'; id: string }
  | { type: 'ping' };

interface Reply<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

function installSidePanelBehaviour(): void {
  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(installSidePanelBehaviour);
chrome.runtime.onStartup.addListener(installSidePanelBehaviour);

/**
 * 取登录态；票快到期（<2 h）或已经废了，就先自己续一次
 * （扩展里是一条 fetch 的静默换票；PWA 里退回后台标签页）。
 * 一张票都没有说明还没登录过——不空跑，直接返回现状让 UI 提示去登录。
 */
async function sessionOrRenew(): Promise<CampusSession> {
  const session = await loadSession();
  if (!session.jwxtToken && !session.portalToken) return session;
  // 剩得还多就什么都不做（ensureFresh 内部判断，不发请求）
  await ensureFresh();
  return loadSession();
}

async function handle(message: Incoming): Promise<Reply> {
  switch (message.type) {
    case 'token':
      if (message.source === 'chat') {
        await saveChatSession(message.token);
        // 拿到 WebUI 会话后顺手换一个 sk- key（已有 key 就不动，避免覆盖用户手填的）
        const cfg = await getLlmSettings();
        if (cfg.apiKey) return { ok: true, data: { saved: true, keyFilled: false } };
        try {
          const key = await mintApiKey(message.token);
          await setLlmSettings({ apiKey: key });
          return { ok: true, data: { saved: true, keyFilled: true } };
        } catch (e) {
          return { ok: true, data: { saved: true, keyFilled: false, why: (e as Error).message } };
        }
      }
      return { ok: true, data: { saved: await ensureValidToken(message.source, message.token) } };
    case 'chat:sync': {
      const session = await getChatSession();
      if (!session) {
        return { ok: false, error: '没读到 DeepSeek 页面：先在同一个浏览器打开 http://chat.zzu.edu.cn 并登录。' };
      }
      try {
        const key = await mintApiKey(session.token);
        // 一键换来的必然是学校 WebUI 的 key，顺手把服务商拨回学校
        return { ok: true, data: await setLlmSettings({ provider: 'school', apiKey: key }) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    case 'status':
      return { ok: true, data: await tokenStatuses() };
    case 'clear':
      await clearTokens();
      return { ok: true };
    case 'ask': {
      const session = await sessionOrRenew();
      if (!session.jwxtToken && !session.portalToken) {
        return {
          ok: false,
          error: '还没有 token。请先在本机登录一次「豫见郑大」或「教学管理平台」，扩展会自动采集。',
        };
      }
      const llm = await getLlmSettings();
      const extra = { llm, ...(message.history?.length ? { history: message.history } : {}) };
      let result = await ask(message.text, session, extra);

      // 学校那边的 sk- key 会失效（会话过期/被重置）。手上有 WebUI 会话就自动换一次再重试，
      // 免得用户看到「API Key 无效」还得自己去设置里点同步。
      if (result.llmError && resolveProvider(llm.provider).id === 'school') {
        const chat = await getChatSession();
        if (chat?.token) {
          try {
            const key = await mintApiKey(chat.token);
            const next = await setLlmSettings({ apiKey: key, enabled: true });
            result = await ask(message.text, session, { ...extra, llm: next });
            result = { ...result, ...(result.llmError ? {} : { llmRefreshed: true }) };
          } catch {
            /* 换不到就保留原来的错误 */
          }
        }
      }
      return { ok: true, data: result };
    }
    case 'settings:get':
      return { ok: true, data: await getLlmSettings() };
    case 'settings:set':
      return { ok: true, data: await setLlmSettings(message.patch ?? {}) };
    case 'llm:test': {
      // 先落盘（用户可能刚改完还没失焦），再用最新的配置试一次
      const cfg = message.patch ? await setLlmSettings(message.patch) : await getLlmSettings();
      return { ok: true, data: await probeLlm(cfg) };
    }
    case 'bundle:export':
      try {
        return { ok: true, data: await exportTokenBundle() };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    case 'tool': {
      const session = await sessionOrRenew();
      if (!session.jwxtToken && !session.portalToken) {
        return { ok: false, error: '还没有 token，请先登录一次校园系统。' };
      }
      const out = await runTool(message.tool, message.args ?? {}, new CampusService(session));
      return { ok: true, data: out };
    }
    case 'lib:book': {
      const out = await bookLibrarySeat(message.args);
      // 连页面都没搭上（没开标签页 / 页面没回应）也走同一套三态文案，
      // 这样界面永远只用一种方式展示预约结果，不会有的地方是错误气泡、有的地方是普通消息。
      const outcome: BookOutcome = out.ok
        ? (out.data ?? { cause: 'no_response' })
        : {
            cause: /没打开|没有打开/.test(out.error ?? '') ? 'no_tab' : 'page_dead',
            seatNo: message.args.seatNo,
            date: message.args.date,
            message: out.error,
          };
      const copy = describeBook({
        ...outcome,
        seatNo: outcome.seatNo ?? message.args.seatNo,
        date: outcome.date ?? message.args.date,
      });
      return {
        ok: true,
        data: {
          text: copy.text,
          data: { toast: copy, outcome },
        },
      };
    }
    case 'lib:status': {
      const tab = await findLibraryTab();
      return { ok: true, data: { open: Boolean(tab), url: tab?.url ?? null } };
    }
    case 'lib:autologin': {
      const out = await autoLoginLibrary(message.args);
      return out.ok ? { ok: true, data: out.data } : { ok: false, error: out.error };
    }
    case 'notice:detail': {
      // 卡片里只有摘要；读全文时按 id 回查一次（CampusService 有缓存）
      const session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        return { ok: false, error: '还没有 token，请先登录一次校园系统。' };
      }
      const body = await getNoticeBody(new CampusService(session), message.id);
      return body ? { ok: true, data: body } : { ok: false, error: '没找到这条通知（可能已被撤回）' };
    }
    case 'ping':
      return { ok: true, data: 'pong' };
    default:
      return { ok: false, error: '未知消息类型' };
  }
}

chrome.runtime.onMessage.addListener((message: Incoming, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return false;
  handle(message)
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});


/** 一天最多推几次：再多就是骚扰，但也不能「今天推过一次」就把后来出现的截止咽下去 */
const MAX_PUSHES_PER_DAY = 3;

/**
 * 每 6 小时跑一次：新出分、快到期的通知，有新的就推系统通知。
 *
 * 去重口径（改过一版，之前是错的）：
 * - 同一条截止只推一次：按卡片 id 记在 `notifiedIds` 里（跨天重置）；
 * - 同一天新出现别的截止 → 补推（老逻辑「notifiedOn === today 就 return」会把当天的新截止吞掉）；
 * - 出分一天只报一次，靠 `notifiedOn` 判断；
 * - 每天最多 `MAX_PUSHES_PER_DAY` 次。
 */
async function dailyWatch(): Promise<void> {
  // 6 小时一次的这个闹钟顺便当「保鲜」：票剩不到 2 小时就静默换一张
  // （扩展里只要一条 fetch，不占标签页；换不上就算了，别拦着下面的推送）
  await ensureFresh();
  const session = await loadSession();
  if (!session.jwxtToken && !session.portalToken) return;

  const today = todayShanghai();
  const state = await getWatchState();
  const sameDay = state.notifiedOn === today;
  const pushesOn = sameDay ? (state.pushesOn ?? 0) : 0;
  if (pushesOn >= MAX_PUSHES_PER_DAY) return;

  const svc = new CampusService(session);
  const grades: unknown[] = [];
  let cards: ReturnType<typeof buildCards> = [];

  try {
    const g = await svc.grades();
    grades.push(...(g as unknown[]));
  } catch {
    /* 没成绩权限就算了，不影响截止提醒 */
  }
  try {
    // 通知先过一遍卡片管线（分类/去重/截止抽取），提醒与面板上的口径就是同一套。
    // 取 80 条：services.notices 已按发布时间倒序，8 天内截止的通知基本都在里面。
    cards = buildCards(await svc.notices({ limit: 80 }), { today });
  } catch {
    /* 通知拿不到也算了 */
  }

  const fp = gradeFingerprint(grades);
  const fresh = state.gradeFp !== undefined && fp ? newGradeNames(grades, state.gradeFp) : [];
  const notifiedIds = sameDay ? (state.notifiedIds ?? []) : [];
  const due = dueCards(cards, today, 7).filter((card) => !notifiedIds.includes(card.id));
  const dues = due.map((card) => ({
    id: card.id,
    title: card.title,
    due: card.deadline ?? today,
    daysLeft: daysBetween(today, card.deadline ?? today),
  }));

  // 一条截止一条系统通知：点开能定位到那张卡（聚合通知只能打开时间线）。
  // 最多 3 条单卡，其余并成一条摘要，免得一次弹一屏。
  const head = due.slice(0, 3);
  for (const card of head) pushNoticeCard(card, today);
  if (due.length > head.length) {
    const rest = buildDigest({ today, dues: dues.slice(head.length), newGrades: [] });
    if (rest) pushNotification(`notice-more-${today}`, rest);
  }
  // 出分一天只报一次
  const gradeDigest = sameDay || fresh.length === 0 ? null : buildDigest({ today, dues: [], newGrades: fresh });
  if (gradeDigest) pushNotification(`watch-grades-${today}`, gradeDigest);

  const pushed = due.length > 0 || gradeDigest !== null;
  const nextIds = [...new Set([...notifiedIds, ...due.map((item) => item.id)])];
  await setWatchState({
    ...(fp ? { gradeFp: fp } : {}),
    ...(pushed ? { notifiedOn: today, pushesOn: pushesOn + 1, notifiedIds: nextIds } : {}),
  });
}

function pushNotification(id: string, payload: { title: string; body: string }): void {
  if (typeof chrome === 'undefined' || !chrome.notifications) return;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon-192.png',
    title: payload.title,
    message: payload.body,
  });
}

/** 单条截止通知：标题带分类，正文带「截止日期 + 还有几天 + 地点/部门」。 */
function pushNoticeCard(card: NoticeCard, today: string): void {
  const when = card.deadline
    ? `截止 ${card.deadline.slice(5)}${card.deadlineTime ?? ''}（${dueLabel(daysLeft(card, today))}）`
    : '新通知';
  const meta = [when, card.location, card.department].filter(Boolean).join(' · ');
  pushNotification(`notice-${card.id}`, { title: `[${card.categoryLabel}] ${card.title}`, body: meta || '点开看详情' });
}

/**
 * 点系统通知：先把目标写进存储（面板可能还没开），再尝试打开侧边栏。
 * 面板一开就取走这个 id，跳到对应卡片并高亮。
 */
async function focusFromNotification(notificationId: string): Promise<void> {
  const target = parseNoticeNotification(notificationId);
  if (!target) return;
  if (target.cardId) await setNoticeFocus(target.cardId);
  try {
    // 面板已经开着的话，直接让它切过去
    await chrome.runtime.sendMessage({ type: 'notice:focus', id: target.cardId ?? '' });
  } catch {
    /* 面板没开：sendMessage 会 reject，正常 */
  }
  try {
    const windowId = chrome.windows?.WINDOW_ID_CURRENT ?? -2;
    await chrome.sidePanel?.open({ windowId });
  } catch {
    /* 没有用户手势 / 浏览器不支持：没关系，下次打开面板也会跳过去 */
  }
}

chrome.notifications.onClicked.addListener((id) => {
  void focusFromNotification(id);
});

chrome.alarms.create('heartbeat', { periodInMinutes: 30 });
// 早 9 点后随便什么时候跑一次；periodInMinutes 保证扩展重装后也会再次拉起
chrome.alarms.create('daily-watch', { periodInMinutes: 6 * 60 });
void dailyWatch();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') void tokenStatuses();
  if (alarm.name === 'daily-watch') void dailyWatch();
});
