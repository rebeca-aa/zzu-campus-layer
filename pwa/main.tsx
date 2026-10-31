import { render } from 'preact';

declare const __APP_VERSION__: string;
import { HoldButton } from '../src/ui/hold';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ask } from '../src/core/agent';
import { getKV, parseImportLink } from '../src/core/kv';
import { probeLlm } from '../src/core/llm';
import { buildReminderBlocks, pushReminders } from '../src/core/remind';
import { CampusService } from '../src/core/services';
import {
  clearTokens,
  exportTokenBundle,
  getLlmSettings,
  importTokenBundle,
  loadSession,
  setLlmSettings,
  tokenStatuses,
  type LlmSettingsStored,
  type TokenStatus,
} from '../src/core/storage';
import { LlmFields } from '../src/ui/llm-fields';
import { AppCreds } from '../src/ui/app-creds';
import { QuickAskBar, QuickAskEditor } from '../src/ui/quick-asks';
import { CampusMap, RichText, download } from '../src/ui/rich';
import {
  defaultQuickAsks,
  loadQuickAsks,
  resetQuickAsks,
  saveQuickAsks,
  type QuickAsk,
} from '../src/core/quickAsk';
import { noticesToIcs } from '../src/core/ics';
import { loadTranscript, saveTranscript, trimTranscript } from '../src/core/transcript';
import type { NoticeCard, TodayDigest } from '../src/core/notice';
import { NOTICE_CATEGORIES, type NoticeCategory } from '../src/core/noticeRules';
import {
  DEFAULT_NOTICE_PREFS,
  getNoticePrefs,
  markNoticeRead,
  setNoticePrefs,
  type NoticePrefs,
} from '../src/core/noticeStore';
import { getNoticeBody, runTool } from '../src/core/tools';
import { todayShanghai } from '../src/core/util';
import type { Term } from '../src/core/types';
import { NoticeBoard } from '../src/ui/notice';
import { HomeView, MineView, ScheduleView, TabBar, type Caller, type TabKey } from './views';
import { fetchRelease, SEEN_KEY, shouldAnnounce, type Release } from './update';
import './style.css';
import './tabs.css';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  tool?: string;
  data?: Record<string, unknown>;
  error?: boolean;
  via?: 'agent' | 'rule' | 'llm' | 'llm-chat' | 'none';
  /** agent 模式这一轮调过的工具，按顺序 */
  steps?: string[];
  /** 模型没帮上忙的原因 */
  llmError?: string;
}

const CAS_LOGIN =
  'https://cas.s.zzu.edu.cn/cas/login?service=' +
  // 故意指到门户的一个静态样式文件：CAS 只按 host 白名单放行，
  // 而静态文件不会启动那个 uni-app SPA —— SPA 一启动就会把 ?ticket= 从地址栏抹掉。
  encodeURIComponent('https://uniapp.s.zzu.edu.cn/static/index.a5c69d49.css');
/* 门户的登录入口：同一个 CAS，只是 service 换成门户首页；拿到的票在门户/教务两边都能用。 */
const LIB_LOGIN = 'http://order.lib.zzu.edu.cn/h5/index.html#/seat/index';
const CAS_LOGIN_PORTAL =
  'https://cas.s.zzu.edu.cn/cas/login?service=' +
  encodeURIComponent('https://uniapp.s.zzu.edu.cn/pages/tab/index/index');

/* 常用语改成可编辑列表（原来写死在 QUICK 里）：存 kv，改动立刻落盘。
   初始值先用出厂的，等 refresh() 读到用户自己的列表再替换，避免闪一下空条。 */

function pushNote(text: string) {
  window.dispatchEvent(new CustomEvent("campus-note", { detail: text }));
}

/** 三套配色。teal 是后加的「蓝绿」：和 ink 共用深色骨架，只换一组变量。 */
type ThemeName = 'cream' | 'ink' | 'teal';

/** 状态栏/地址栏跟着配色走，免得换完主题上边还留着旧颜色。 */
const THEME_COLOR: Record<ThemeName, string> = {
  cream: '#f4ebd7',
  ink: '#0b1220',
  teal: '#07191a',
};

function syncThemeMeta(next: ThemeName): void {
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next]);
}

function App() {
  const [statuses, setStatuses] = useState<TokenStatus[]>([]);  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  /* 底部四栏：主页 / AI / 学期课表 / 我的 */
  const [tab, setTab] = useState<TabKey>('home');
  /* 我的下面的二级页 */
  const [sub, setSub] = useState<'none' | 'theme' | 'settings' | 'about'>('none');
  const [term, setTerm] = useState<Term | null>(null);
  const [homeRefresh, setHomeRefresh] = useState(0);
  const [homeBusy, setHomeBusy] = useState(false);
  /* 新版本已就绪（等用户点「立即更新」）与「刚更新完」的公告 */
  const [updateReady, setUpdateReady] = useState(false);
  const [updateNotes, setUpdateNotes] = useState<string[]>([]);
  const [announce, setAnnounce] = useState<Release | null>(null);
  const swReg = useRef<ServiceWorkerRegistration | null>(null);
  const [sheet, setSheet] = useState<'none' | 'login'>('none');
  /* 面板切换方向：fwd = 新面板从右边滑进来，back = 退回时从左边滑回来 */
  const [navDir, setNavDir] = useState<'fwd' | 'back'>('fwd');
  /* 首屏不滑，免得一进页面就动一下 */
  const [booted, setBooted] = useState(false);
  useEffect(() => setBooted(true), []);
  /* 在安卓壳里（壳注入了 CampusNotify）登录由原生菜单接管，不需要用户复制地址 */
  const inShell = typeof (window as unknown as { CampusNotify?: unknown }).CampusNotify !== 'undefined';

/* 自动续期：登录态过期/失效时先静默续一次；失败才把用户送到登录面板。
   续期由壳里的 LoginActivity(silent) 完成，结果经 window.__campusRenew('ok'|'fail') 回来。 */
type RenewBridge = { renewLogin?: () => void };
let renewWaiters: Array<(ok: boolean) => void> = [];
const renewApi = (): RenewBridge | undefined => (window as unknown as { CampusNotify?: RenewBridge }).CampusNotify;
const canAutoRenew = (): boolean => typeof renewApi()?.renewLogin === 'function';
function renewOnce(timeoutMs = 45_000): Promise<boolean> {
  const b = renewApi();
  if (typeof b?.renewLogin !== 'function') return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    renewWaiters.push((ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
    try {
      b.renewLogin?.();
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}
const AUTH_LOST_RE = /未登录|没有访问权限|登录态|token\s*(过期|无效|已过期)|已过期|expired|unauthor/i;
const looksAuthLost = (msg: string): boolean => AUTH_LOST_RE.test(msg);

  const [paste, setPaste] = useState('');
  const [note, setNote] = useState('');
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState('');
  const [llm, setLlm] = useState<LlmSettingsStored>({
    enabled: true,
    provider: 'school',
    apiKey: '',
    model: 'DeepSeek-R1',
  });
  /** 'chat' = 问答，'notices' = 通知时间线。`#notices` 可直接深链到时间线。 */
  const [view, setView] = useState<'chat' | 'notices'>(
    typeof location !== 'undefined' && location.hash === '#notices' ? 'notices' : 'chat',
  );
  const [noticeCards, setNoticeCards] = useState<NoticeCard[]>([]);
  const [noticeDigest, setNoticeDigest] = useState<TodayDigest | null>(null);
  /** 壳里点「立即续期」：调原生桥，成功/失败由 __campusRenew 回调。 */
  async function doRenew() {
    const bridge = (window as any).CampusNotify;
    const has = typeof bridge?.renewLogin === 'function';
    setRenewNote('');
    if (!has) {
      setRenewNote('fail');
      pushNote('这个包里没有续期接口：装的不是 0.2.28 之后的包，或者 WebView 没加载新前端。');
      return;
    }
    setRenewBusy(true);
    setRenewStep('已发出，等壳回话…');
    try {
      bridge.renewLogin?.();
    } catch (e) {
      setRenewBusy(false);
      setRenewStep('');
      setRenewNote('fail');
      pushNote('调续期接口失败：' + String(e));
    }
  }

  /* 两类通知分开控制：课前提醒默认开（学生本来就想被提醒），资讯通知默认关（不打扰）。 */
  const [notifyClass, setNotifyClass] = useState(true);
  const [renewBusy, setRenewBusy] = useState(false);
  const [renewNote, setRenewNote] = useState<'' | 'ok' | 'fail'>('');
  const [renewStep, setRenewStep] = useState('');
  const buildVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  /* 配色：cream=米白 / ink=黑+藏青 / teal=黑+蓝绿（默认 ink） */
  const [theme, setTheme] = useState<ThemeName>('ink');
  const applyTheme = async (next: ThemeName) => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    syncThemeMeta(next);
    await getKV().set('theme', next);
  };
  const [notifyNews, setNotifyNews] = useState(false);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [noticeError, setNoticeError] = useState('');
  const [noticePrefs, setNoticePrefsState] = useState<NoticePrefs>(DEFAULT_NOTICE_PREFS);
  /* 输入框上面那排常用语：可加、可删、可上下挪，自己维护顺序 */
  const [quickAsks, setQuickAsks] = useState<QuickAsk[]>(defaultQuickAsks);
  const [quickEditing, setQuickEditing] = useState(false);
  const [today] = useState(todayShanghai());
  const scroller = useRef<HTMLElement | null>(null);
  /* refresh() 读完存档之前别回写，否则会用空列表把上次的记录覆盖掉 */
  const hydrated = useRef(false);
  /* 刚从存档恢复出来的那一批：这一帧不滚到底，让人从最上面开始看 */
  const restored = useRef<Message[] | null>(null);
  /* 用户往回翻的时候别把他拽回底部 */
  const stickBottom = useRef(true);
  const isHttps = typeof location !== 'undefined' && location.protocol === 'https:';

  async function refresh() {
    setStatuses(await tokenStatuses());
    setLlm(await getLlmSettings());
    setNoticePrefsState(await getNoticePrefs());
      const themePref = await getKV().get<string>('theme');
      const t: ThemeName = themePref === 'cream' || themePref === 'teal' ? themePref : 'ink';
      setTheme(t);
      document.documentElement.dataset.theme = t;
      syncThemeMeta(t);
      const classPref = await getKV().get<boolean>('notifyClass');
      const newsPref = await getKV().get<boolean>('notifyNews');
      setNotifyClass(classPref !== false);
      setNotifyNews(newsPref === true);
      setQuickAsks(await loadQuickAsks());
      // 上次聊的那几条带回来：换页面/重开不该从空白开始
      const items = await loadTranscript<Message>();
      restored.current = items;
      setMessages(items);
      hydrated.current = true;
  }

  /** 常用语变了：先把界面换掉（点一下就有反应），再异步落库。 */
  function patchQuickAsks(next: QuickAsk[]): void {
    setQuickAsks(next);
    void saveQuickAsks(next).catch(() => undefined);
  }

  async function resetQuickAskList(): Promise<void> {
    setQuickAsks(await resetQuickAsks());
  }

  /** 手机端直接跑工具（没有 background），卡片管线与桌面完全同一条。 */
  async function loadNotices(): Promise<void> {
    if (noticeBusy) return;
    setNoticeBusy(true);
    setNoticeError('');
    try {
      let session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        setNoticeError('还没有登录态：点右上角「登录态」导入一次。');
        return;
      }
      const out = await runTool('find_notices', { limit: 50 }, new CampusService(session));
      const payload = out.data as { cards?: NoticeCard[]; digest?: TodayDigest } | undefined;
      setNoticeCards(payload?.cards ?? []);
      setNoticeDigest(payload?.digest ?? null);
    if (payload?.digest) void notifyFresh(payload.digest);
    } catch (e) {
      setNoticeError(e instanceof Error ? e.message : String(e));
    } finally {
      setNoticeBusy(false);
    }
  }

  async function loadNoticeDetail(card: NoticeCard): Promise<string | null> {
    const session = await loadSession();
    const body = await getNoticeBody(new CampusService(session), card.id);
    return body?.text ?? null;
  }

  function saveNoticeIcs(card: NoticeCard): void {
    download(`通知-${card.deadline ?? card.eventStart ?? today}.ics`, noticesToIcs([card]));
  }

  async function readNotice(id: string): Promise<void> {
    setNoticePrefsState(await markNoticeRead(id));
  }

  async function toggleCategory(category: NoticeCategory): Promise<void> {
    const current = noticePrefs.categories.length > 0 ? noticePrefs.categories : [...NOTICE_CATEGORIES];
    const next = current.includes(category) ? current.filter((item) => item !== category) : [...current, category];
    if (next.length === 0) return;
    setNoticePrefsState(await setNoticePrefs({ categories: next.length === NOTICE_CATEGORIES.length ? [] : next }));
  }

  async function patchLlm(patch: Partial<LlmSettingsStored>) {
    const next = await setLlmSettings(patch);
    setLlm(next);
  }

  useEffect(() => {
    void refresh();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('./pwa-sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          swReg.current = reg;
          void reg.update();
          /* 已经装好、只是等着接管的那种，一进来就提示 */
          if (reg.waiting && navigator.serviceWorker.controller) void offerUpdate();
          reg.addEventListener('updatefound', () => {
            const sw = reg.installing;
            if (!sw) return;
            sw.addEventListener('statechange', () => {
              /* 装好但先不接管：弹窗等用户点「立即更新」 */
              if (sw.state === 'installed' && navigator.serviceWorker.controller) void offerUpdate();
            });
          });
        })
        .catch(() => undefined);
    }
    // 装了安卓壳的话，每次打开都把未来 7 天的课前提醒重排一遍
    void syncReminders();
  }, []);

  /* 恢复存档：在绘制之前直接跳到底部（最新一条），不带滑下去那一段动画 */
  useLayoutEffect(() => {
    if (restored.current !== messages) return;
    restored.current = null;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!stickBottom.current) return;
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  /* 每次聊完落一次盘：只留最近 10 条，重字段在 transcript.ts 里洗掉 */
  useEffect(() => {
    if (!hydrated.current) return;
    const timer = setTimeout(() => {
      void saveTranscript(messages).catch(() => undefined);
    }, 200);
    return () => clearTimeout(timer);
  }, [messages]);

  const jwxt = statuses.find((s) => s.source === 'jwxt');
  const portal = statuses.find((s) => s.source === 'portal');
  const ready = Boolean(jwxt?.valid || portal?.valid);
  /* 票是 8 小时的；剩不到 2 小时就先续，别等它过期了再补救 */
  const NEAR_EXPIRY_MS = 2 * 3_600_000;
  const shouldRenewNow =
    Boolean(jwxt?.present) && (!jwxt?.valid || (jwxt?.remainingMs ?? Number.POSITIVE_INFINITY) < NEAR_EXPIRY_MS);
  useEffect(() => {
    if (ready) void loadNotices();
  }, [ready]);

  /** 算未来 7 天的课前提醒并交给壳（没有壳时 pushReminders 返回 false，什么也不做）。 */
  async function syncReminders() {
    if (!notifyClass) return;
    try {
      const session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) return;
      const svc = new CampusService(session);
      const [courses, term] = await Promise.all([svc.courses(), svc.term().catch(() => undefined)]);
      pushReminders(buildReminderBlocks(courses, { termStart: term?.startDate }));
    } catch {
      /* 提醒排不上不该影响聊天 */
    }
  }

  async function submit(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setMessages((m) => trimTranscript([...m, { role: 'user', text: question }]));
    setInput('');
    setBusy(true);
    try {
      let session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        setMessages((m) =>
          trimTranscript([
            ...m,
            { role: 'assistant', text: '还没有登录态：点右上角「登录态」，从电脑上的扩展面板复制一段码粘进来。', error: true },
          ]),
        );
        setNavDir('fwd');
        setSheet('login');
        return;
      }
      /* 开销很小：只剩 0 次续期机会时也照样先问一次（用户可能刚在别处续过） */
      if (shouldRenewNow && canAutoRenew()) {
        setNote(jwxt?.valid ? '登录态快到期了，先自动续一次…' : '登录态过期了，正在自动续期…');
        const ok = await renewOnce();
        setNote(ok ? '续期成功' : '');
        if (!ok) {
          /* 续不上就把人送到登录面板，别让他对着报错猜 */
          setNavDir('fwd');
          setSheet('login');
          setNote('自动续期没成功，请重新登录一次');
        } else {
          session = await loadSession();
        }
      }
      let res = await ask(question, session, {
        llm,
        // 把最近几轮带上，模型才接得住「那明天呢」这种追问
        history: messages
          .slice(-6)
          .filter((m) => m.text.trim())
          .map((m) => ({ role: m.role, content: m.text })),
      });
      if (res.error && looksAuthLost(res.text) && canAutoRenew()) {
        setNote('登录态失效，正在自动续期…');
        const ok = await renewOnce();
        if (ok) {
          session = await loadSession();
          res = await ask(question, session, {
            llm,
            history: messages
              .slice(-6)
              .filter((m) => m.text.trim())
              .map((m) => ({ role: m.role, content: m.text })),
          });
          setNote('已续期并重试');
        } else {
          setNote('自动续期没成功，请重新登录一次');
          setNavDir('fwd');
          setSheet('login');
        }
      }
      setMessages((m) =>
        trimTranscript([
          ...m,
          {
            role: 'assistant',
            text: res.text,
            ...(res.tool ? { tool: res.tool } : {}),
            ...(res.data ? { data: res.data } : {}),
            ...(res.via ? { via: res.via } : {}),
            ...(res.steps ? { steps: res.steps } : {}),
            ...(res.llmError ? { llmError: res.llmError } : {}),
            ...(res.error ? { error: true } : {}),
          },
        ]),
      );
    } catch (e) {
      setMessages((m) => trimTranscript([...m, { role: 'assistant', text: String(e), error: true }]));
    } finally {
      setBusy(false);
    }
  }

  /** 从剪贴板取一次：能认出来就直接导入，省掉「再点保存」那一下。 */
  /**
   * 给原生壳（Android WebView）用一个入口：壳里登录成功后直接调
   *   window.__campusImport("<idToken 或完整网址>")
   * 就完成导入，用户不需要复制任何东西。
   */
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__campusRenew = (r: string) => {
      setRenewBusy(false);
      setRenewStep('');
      setRenewNote(r === 'ok' ? 'ok' : 'fail');
      const ok = /ok/i.test(String(r ?? ''));
      const waiters = renewWaiters;
      renewWaiters = [];
      waiters.forEach((fn) => {
        try {
          fn(ok);
        } catch {
          /* 单个等待者出错不影响其它人 */
        }
      });
      void refresh();
    };
    w.__campusImport = async (raw: string): Promise<string> => {
      try {
        const bundle = parseImportLink(String(raw ?? ''));
        const next = await importTokenBundle(needPortal(bundle));
        setStatuses(next);
        setLlm(await getLlmSettings());
        setSheet('none');
        setNote('登录态已导入');
        setTimeout(() => setNote(''), 2500);
        return 'ok';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        /* 失败时把面板打开，否则用户只看到「已交给页面处理」 */
        setNavDir('fwd');
        setSheet('login');
        setNote(msg);
        return msg;
      }
    };
    return () => {
      delete w.__campusImport;
    };
  }, []);

  async function readClip(): Promise<void> {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setNote('浏览器不让读剪贴板（需要 https + 一次授权），长按输入框手动粘贴一次');
      return;
    }
    if (!text.trim()) {
      setNote('剪贴板是空的，先去学校页面复制地址栏');
      return;
    }
    try {
      const bundle = parseImportLink(text.trim());
      const next = await importTokenBundle(bundle);
      setStatuses(next);
      setLlm(await getLlmSettings());
      setPaste('');
      setSheet('none');
      setNote(bundle.llm?.apiKey ? '导入成功（含模型 key）' : '导入成功');
      setTimeout(() => setNote(''), 2500);
    } catch (e) {
      setPaste(text.trim());
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function doImport() {
    try {
      /* 三种都能收：同步码 / 裸 token / 学校页面的地址 */
      const bundle = parseImportLink(paste);
      const next = await importTokenBundle(bundle);
      setStatuses(next);
      setLlm(await getLlmSettings());
      setPaste('');
      setSheet('none');
      setNote(bundle.llm?.apiKey ? '导入成功（含模型 key）' : '导入成功');
      setTimeout(() => setNote(''), 2500);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  /** 手机端直接打一次模型接口，把真实原因显示出来。 */
  async function testLlm(): Promise<void> {
    setTesting(true);
    setTestNote('测试中…');
    const cfg = { ...(await getLlmSettings()), enabled: true };
    const r = await probeLlm(cfg);
    setTesting(false);
    setTestNote(r.ok ? `连通 ✓ ${r.ms}ms（${r.model} 回：${r.text || ''}）` : `失败 ✗ ${r.error ?? '未知原因'}`);
  }

  /* 从分享链接自动导入：链接形如 .../pwa/index.html#code=<同步码> 或 #token=<JWT>
     —— 一台有登录态的设备点「复制分享链接」，发给另一台设备点开即可，不用手打码。 */
  useEffect(() => {
    const src = (location.hash || '').replace(/^#/, '') || '';
    const m = /(?:code|token|idToken)=([^&]+)/i.exec(src);
    const hit = m && m[1] ? m[1] : '';
    if (!hit) return;
    (async () => {
      try {
        const raw = decodeURIComponent(hit);
        const bundle = parseImportLink(raw);
        const st = await importTokenBundle(bundle);
        setStatuses(st);
        const llmNow = await getLlmSettings();
        setLlm(llmNow);
        setNote('已从链接导入登录态');
        setTimeout(() => setNote(''), 2500);
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
      } finally {
        history.replaceState(null, '', location.pathname + location.search);
      }
    })();
  }, []);

  /** 打开任一类通知时才申请权限（不打扰用户）。 */
  async function ensureNotifyPermission() {
    const bridge = (window as unknown as { CampusNotify?: { askNotify?: () => void } }).CampusNotify;
    if (bridge?.askNotify) {
      bridge.askNotify();
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* 忽略 */
      }
    }
  }

  async function toggleClass(next: boolean) {
    setNotifyClass(next);
    await getKV().set('notifyClass', next);
    if (next) {
      await ensureNotifyPermission();
      void syncReminders();
    } else {
      // 关掉的时候把壳里已排的闹钟一起撤了，不然明天早上还会响
      pushReminders([]);
    }
    setNote(next ? '已开启课前提醒' : '已关闭课前提醒');
    setTimeout(() => setNote(''), 2500);
  }

  async function toggleNews(next: boolean) {
    setNotifyNews(next);
    await getKV().set('notifyNews', next);
    if (next) await ensureNotifyPermission();
    setNote(next ? '已开启资讯通知' : '已关闭资讯通知');
    setTimeout(() => setNote(''), 2500);
  }

  /** 有新通知时弹一条系统通知；同一天只弹一次，且必须用户自己开了开关。 */
  async function notifyFresh(d: TodayDigest) {
    if (!notifyNews) return;
    const day = todayShanghai();
    if ((await getKV().get<string>('notifyDay')) === day) return;
    await getKV().set('notifyDay', day);
    const title = '今天有 ' + d.fresh.length + ' 条新通知';
    const body = d.fresh.slice(0, 3).map((c) => c.title).join('\n');
    const bridge = (window as unknown as { CampusNotify?: { notify?: (t: string, b: string) => void } }).CampusNotify;
    if (bridge?.notify) {
      bridge.notify(title, body);
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(title, { body }); } catch { /* 忽略 */ }
    }
  }

  /** 一次导入补全两边的票：CAS 票在门户/教务通用，省得用户再登一次门户。 */
  function needPortal<T extends { jwxt?: string; portal?: string }>(bundle: T): T {
    return bundle.jwxt && !bundle.portal ? { ...bundle, portal: bundle.jwxt } : bundle;
  }

  /** 壳内登录：调原生桥唤起壳里的登录页（登录完由壳把地址回灌给页面）。 */
  async function shellLogin() {
    const bridge = (window as unknown as { CampusNotify?: { login?: () => void } }).CampusNotify;
    if (bridge?.login) {
      bridge.login();
      return;
    }
    setNote('这个版本没有登录入口，点「复制登录页链接」，粘到浏览器里登录');
    setTimeout(() => setNote(''), 4000);
  }

  /** 复制登录页链接：让用户在自己的浏览器里打开（那里一定有地址栏，能复制 ticket）。 */
  async function copyLoginUrl() {
    try {
      await navigator.clipboard.writeText(CAS_LOGIN);
      setNote('登录页链接已复制，粘到浏览器地址栏打开');
    } catch {
      setNote('浏览器不让复制，请长按下面的按钮「打开学校登录页」→ 在新标签页里打开');
    }
    setTimeout(() => setNote(''), 4000);
  }

  /** 手机端没有 content script；这里生成「分享链接」，发给另一台设备点开即用。 */
  async function shareLink() {
    try {
      const code = await exportTokenBundle();
      const url = location.origin + location.pathname + '#code=' + encodeURIComponent(code);
      await navigator.clipboard.writeText(url);
      setNote('分享链接已复制（长度 ' + url.length + '），发给另一台设备点开即可');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setNote(''), 4000);
  }

  /** 手机端没有 content script，导出码主要是方便测试时把手机上的搬到别处。 */
  async function doExport() {
    try {
      const code = await exportTokenBundle();
      await navigator.clipboard.writeText(code);
      setNote('已复制（长度 ' + code.length + '）');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setNote(''), 3000);
  }

  /** 面板进出动画用的类名：开新面板从右边滑入，退回从左边滑入 */
  const slide = booted ? (navDir === 'fwd' ? ' slide-in-right' : ' slide-in-left') : '';

  /** 各页面统一走这个：拿会话 → 跑工具 → 兜住错误，返回给人看的一句话 */
  const call = useCallback<Caller>(async (name, args = {}) => {
    try {
      const session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        return { ok: false, error: '还没登录：去「我的 → 账号」登录一次' };
      }
      const out = await runTool(name as Parameters<typeof runTool>[0], args, new CampusService(session));
      return { ok: true, data: out };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, []);

  /* 学期信息：总周数、当前第几周 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const session = await loadSession();
        if (!session.jwxtToken && !session.portalToken) return;
        const t = await new CampusService(session).term();
        if (alive) setTerm(t);
      } catch {
        /* 没登录 / 断网就先不显示周次 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [homeRefresh]);

  const refreshHome = useCallback(() => {
    setHomeBusy(true);
    setHomeRefresh((n) => n + 1);
    void tokenStatuses().then(setStatuses);
    window.setTimeout(() => setHomeBusy(false), 800);
  }, []);

  const themeLabel = theme === 'cream' ? '米白' : theme === 'teal' ? '蓝绿' : '藏青';

  /* 有新版本装好了：弹窗，并把这次更新的说明一起拿出来 */
  const offerUpdate = useCallback(() => {
    setUpdateReady(true);
    void fetchRelease().then((r) => setUpdateNotes(r?.notes ?? []));
  }, []);

  const applyUpdate = useCallback(() => {
    const reg = swReg.current;
    if (!reg?.waiting) {
      location.reload();
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }, []);

  /* 更新完第一次跑：如果这个版本还没公告过，就把这次更新说明弹一次 */
  useEffect(() => {
    if (!buildVersion) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(SEEN_KEY);
    } catch {
      /* 隐私模式拿不到就算了 */
    }
    if (shouldAnnounce(buildVersion, seen)) {
      void fetchRelease().then((r) => {
        if (r && r.version === buildVersion) setAnnounce(r);
      });
    }
    try {
      localStorage.setItem(SEEN_KEY, buildVersion);
    } catch {
      /* 同上 */
    }
  }, []);

  const unread = noticeCards.filter((c) => !noticePrefs.readIds.includes(c.id)).length;
  const openNotices = () => {
    setNavDir('fwd');
    setTab('ai');
    setView('notices');
    if (noticeCards.length === 0 && !noticeBusy) void loadNotices();
  };

  return (
    <div class="app">
      {tab === 'home' && (
        <HomeView
          today={today}
          call={call}
          refreshKey={homeRefresh}
          busy={homeBusy}
          unread={unread}
          onOpen={(kind) => {
            /* 没登录就先让用户登录，别问一句再被回「还没 token」 */
            if (!jwxt?.valid) {
              setNavDir('fwd');
              setSheet('login');
              return;
            }
            if (kind === 'library') {
              setNavDir('fwd');
              setTab('ai');
              void submit('图书馆还有位置吗');
              return;
            }
            if (kind === 'rooms') {
              setNavDir('fwd');
              setTab('ai');
              void submit('今天的空教室');
              return;
            }
            setNavDir('fwd');
            setTab('ai');
            void submit('我卡里还有多少钱');
          }}
          onSchedule={() => setTab('schedule')}
          onBell={openNotices}
          onNotice={openNotices}
          onRefresh={refreshHome}
        />
      )}

      {tab === 'schedule' && (
        <ScheduleView call={call} term={term} today={today} refreshKey={homeRefresh} />
      )}

      {tab === 'mine' && (
        <MineView
          version={buildVersion}
          themeLabel={themeLabel}
          jwtText={jwxt ? (jwxt.valid ? (jwxt.remainingText ?? '可用') : '已过期') : '未登录'}
          portalText={portal ? (portal.valid ? (portal.remainingText ?? '可用') : '已过期') : '未登录'}
          notifyClass={notifyClass}
          notifyNews={notifyNews}
          hasShell={inShell}
          renewBusy={renewBusy}
          onLogin={() => {
            setNavDir('fwd');
            setSheet('login');
          }}
          onLibraryLogin={() => {
            const b = (window as unknown as { CampusNotify?: { loginLibrary?: () => void } }).CampusNotify;
            if (b?.loginLibrary) b.loginLibrary();
            else window.open(LIB_LOGIN, '_blank', 'noreferrer');
          }}
          onRenew={() => void doRenew()}
          onToggleClass={(v) => void toggleClass(v)}
          onToggleNews={(v) => void toggleNews(v)}
          onTheme={() => {
            setNavDir('fwd');
            setSub('theme');
          }}
          onSettings={() => {
            setNavDir('fwd');
            setSub('settings');
          }}
          onAbout={() => {
            setNavDir('fwd');
            setSub('about');
          }}
        />
      )}

      {tab === 'ai' && (
        <header class="top">
          <div class="who">
            <h1>AI</h1>
            <div class="sub">问课表、空教室、图书馆、校园卡</div>
          </div>
          <div class="acts">
            <button class="iconbtn" onClick={openNotices} aria-label="通知">
              {unread > 0 && <span class="dot">{unread > 99 ? '99+' : unread}</span>}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
                <path d="M13.7 17a2 2 0 0 1-3.4 0" />
              </svg>
            </button>
          </div>
        </header>
      )}

      {sheet === 'login' && (
        <section class={`subpage${slide}`} key="login">
          <div class="subhead">
            <button
              onClick={() => {
                setNavDir('back');
                setSheet('none');
              }}
            >
              ‹ 返回
            </button>
            <strong>账号</strong>
          </div>
          {inShell ? (
            <>
              <p class="hint">
                <strong>用学校账号登录一次就行</strong>——登录完会自动回到这里，不用复制任何东西。
              </p>
              <p class="row">
                <button class="primary" onClick={() => void shellLogin()}>
                  用学校账号登录
                </button>
                <a
              class="ghost"
              href={LIB_LOGIN}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                const b = (window as unknown as { CampusNotify?: { loginLibrary?: () => void } }).CampusNotify;
                if (b?.loginLibrary) {
                  e.preventDefault();
                  b.loginLibrary();
                }
              }}
            >
            登录图书馆
          </a>
          <button class="ghost" onClick={() => void readClip()}>
                  从剪贴板导入
                </button>
              </p>
              <p class="hint">换手机、清了数据之后才需要重新登录。</p>
            </>
          ) : (
            <>
              <p class="hint">
                <strong>办法一（推荐）：用学校账号登录</strong>
                <br />
                登录页上<strong>勾一下「记住我」</strong>：教务票能用 30 天，桌面上的扩展还会在过期时自己续一次，不用天天重登。
              </p>
              <p class="row">
                <a class="primary" href={CAS_LOGIN} target="_blank" rel="noreferrer">
                  打开学校登录页
                </a>
                <button class="ghost" onClick={() => void copyLoginUrl()}>
                  复制登录页链接
                </button>
              </p>
              <p class="row">
                <a class="ghost" href={CAS_LOGIN_PORTAL} target="_blank" rel="noreferrer">
                  登录门户（拿门户票）
                </a>
              </p>
              <p class="hint">
                登录成功后会跳到<strong>一屏代码文本</strong>，这时<strong>长按地址栏 → 复制整条网址 → 回来粘到下面</strong>。
                <br />跳到 404 或空白页也照样复制地址栏里的网址。
                <br />如果新打开的页面里<strong>没有地址栏</strong>，先点「复制登录页链接」，粘到自己手机的浏览器里打开。
              </p>
              <p class="hint">
                <strong>办法二：「豫见郑大」App 分享链接</strong>（鸿蒙版可用）：App 里任意页面 → 分享 / 复制链接 → 粘到下面。
              </p>
              <p class="hint">
                装了<strong>安卓壳</strong>的话最省事：在壳里点菜单「登录」，登录完自动灌进来，<strong>不用复制任何东西</strong>。
              </p>
            </>
          )}
          <textarea
            rows={4}
            placeholder="把复制的整条网址粘到这里"
            value={paste}
            onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)}
          />
          {note && <p class="hint warn">{note}</p>}
          <div class="row">
            <button class="primary" onClick={() => void doImport()} disabled={!paste.trim()}>
              保存
            </button>
            <button class="ghost" onClick={() => void readClip()}>
              从剪贴板读取
            </button>
            <button class="ghost" onClick={() => void doExport()}>
              导出当前码
            </button>
            <button class="ghost" onClick={() => void shareLink()}>
              复制分享链接
            </button>
            <button
              class="ghost"
              onClick={async () => {
                await clearTokens();
                setStatuses(await tokenStatuses());
                setNote('已清除');
              }}
            >
              清除
            </button>
          </div>
          {note && <p class="note">{note}</p>}
          <p class="hint" style="opacity:.6">前端 v{buildVersion} · 壳桥：{typeof (window as any).CampusNotify?.renewLogin === 'function' ? '可用' : '不可用'}</p>
          <div class="theme-row" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <button type="button" class="ghost" disabled={renewBusy} onClick={() => void doRenew()}>
              {renewBusy ? '续期中…' : '立即续期（验登录）'}
            </button>
            <span class="hint" style="opacity:.7">
              壳桥：{typeof (window as any).CampusNotify?.renewLogin === 'function' ? '可用' : '不可用'}
            </span>
            {renewStep && <span class="hint">{renewStep}</span>}
            {renewNote === 'ok' && <span class="hint ok">续期成功</span>}
            {renewNote === 'fail' && <span class="hint warn">续期失败（看下面提示）</span>}
          </div>
          <div class="theme-row">
              <span>配色</span>
              <button type="button" class={theme === 'cream' ? 'ghost on' : 'ghost'} onClick={() => void applyTheme('cream')}>米白</button>
              <button type="button" class={theme === 'ink' ? 'ghost on' : 'ghost'} onClick={() => void applyTheme('ink')}>藏青</button>
              <button type="button" class={theme === 'teal' ? 'ghost on' : 'ghost'} onClick={() => void applyTheme('teal')}>蓝绿</button>
            </div>
            <label class="row" style="align-items:center;gap:8px">
            <input
              type="checkbox"
              checked={notifyClass}
              onChange={(e) => void toggleClass((e.target as HTMLInputElement).checked)}
            />
            <span>课前提醒（每节课开课前 30 分钟各弹一条）</span>
          </label>
          <label class="row" style="align-items:center;gap:8px">
            <input
              type="checkbox"
              checked={notifyNews}
              onChange={(e) => void toggleNews((e.target as HTMLInputElement).checked)}
            />
            <span>资讯通知（有新通知时提醒一次）</span>
          </label>
          <p class="hint">
            当前状态：教务 {jwxt?.present ? (jwxt.valid ? jwxt.remainingText : '已过期') : '未导入'} · 门户{' '}
            {portal?.present ? (portal.valid ? portal.remainingText : '已过期') : '未导入'}
            {jwxt?.expText ? `（教务到期 ${jwxt.expText}）` : ''}
          </p>

          <LlmFields
            value={llm}
            httpsPage={isHttps}
            onChange={(patch) => {
              setLlm({ ...llm, ...patch });
              void patchLlm(patch);
            }}
          />
          <div class="row">
            <button class="mini" onClick={() => void testLlm()} disabled={testing}>
              {testing ? '测试中…' : '测试连接'}
            </button>
          </div>
          {testNote ? <p class={testNote.startsWith('连通') ? 'hint ok' : 'hint warn'}>{testNote}</p> : null}

          <AppCreds browserOnly />
        </section>
      )}

      {view === 'notices' && (
        <section class={`subpage${slide}`} key="notices">
          <div class="subhead">
            <button
              onClick={() => {
                setNavDir('back');
                setView('chat');
              }}
            >
              ‹ 返回
            </button>
            <strong>通知</strong>
          </div>
          <NoticeBoard
            cards={noticeCards}
            digest={noticeDigest}
            prefs={noticePrefs}
            today={today}
            loading={noticeBusy}
            error={noticeError}
            onRefresh={() => void loadNotices()}
            onRead={(id) => void readNotice(id)}
            onIcs={saveNoticeIcs}
            onDetail={loadNoticeDetail}
            onToggleCategory={(category) => void toggleCategory(category)}
          />
        </section>
      )}

      {tab === 'ai' && view === 'chat' && (
        <main
          ref={scroller}
          class={`tabbody chat-body ${slide}`}
          key="chat"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          }}
        >
        
        {messages.length === 0 && (
          <div class="chat-empty">
            <p class="ce-title">问点什么？</p>
            <p class="ce-sub">课表、空教室、图书馆、校园卡，直接用平常话说就行。</p>
            {(quickAsks.length ? quickAsks.slice(0, 3) : []).map((q) => (
              <button class="ce-ask" key={q.id} onClick={() => void submit(q.text)}>
                {q.label}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div class={`msg ${m.role}`} key={`${i}-${m.role}`}>
            <div class={m.error ? 'bubble error' : 'bubble'}>
              {m.role === 'assistant' && !m.error ? <RichText text={m.text} /> : <pre>{m.text}</pre>}
              {m.role === 'assistant' && !m.error && m.tool === 'get_schedule' && <CampusMap />}
              {m.role === 'assistant' && !m.error && typeof m.data?.image === 'string' && (
                <figure class="seatmap">
                  {Array.isArray((m.data as any).images) && (m.data as any).images.length > 1
              ? ((m.data as any).images as { areaName: string; image: string }[]).map((it, i) => (
                  <span className="seatmap-item" key={i}>
                    <img src={it.image} alt={`${it.areaName} 座位图`} />
                    <em>{it.areaName}</em>
                  </span>
                ))
              : <img src={String(m.data.image)} alt={String(m.data.imageAlt ?? '座位平面图')} />}
                  <figcaption>绿点是空的 · 灰点已占</figcaption>
                </figure>
              )}
              {m.role === 'assistant' && !m.error && m.data?.action && (
                <HoldButton
                  label={String((m.data.action as { label?: string }).label ?? '长按确认预约')}
                  hint="长按 1.2 秒才会真的提交，松手取消"
                  onConfirm={() => void confirmBook(m.data!.action as { areaId: string; date: string; seatNo: string })}
                />
              )}
              {m.role === 'assistant' && !m.error && typeof m.data?.url === 'string' && (
                <a class="go" href={m.data.url} target="_blank" rel="noreferrer">
                  打开 {typeof m.data.name === 'string' ? m.data.name : '链接'} ↗
                </a>
              )}
              {m.role === 'assistant' && !m.error && m.via === 'agent' && (
                <em class="via">
                  模型编排{m.steps?.length ? ` · ${m.steps.join(' → ')}` : ''}
                </em>
              )}
              {m.role === 'assistant' && !m.error && m.via === 'llm' && <em class="via">由模型判定</em>}
              {m.role === 'assistant' && !m.error && m.via === 'llm-chat' && <em class="via">由模型回答</em>}
              {m.role === 'assistant' && !m.error && m.llmError && <p class="hint warn">模型没帮上忙：{m.llmError}</p>}
              {typeof m.data?.ics === 'string' && (
                <button class="ghost" onClick={() => download(String(m.data?.filename ?? 'zzu.ics'), String(m.data?.ics))}>
                  下载 {String(m.data?.filename ?? 'zzu.ics')}
                </button>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div class="msg assistant">
            <div class="bubble">{llm.enabled ? '查询中…（认不出的说法会先问模型）' : '查询中…'}</div>
          </div>
        )}
        <div />
      </main>
      )}

      {tab === 'ai' && view === 'chat' && sheet === 'none' && (
        <>
          <div class="dock">
        <img class="deco" src="./deco.png" alt="" aria-hidden="true" />
        {quickEditing && (
          <QuickAskEditor
            items={quickAsks}
            onChange={patchQuickAsks}
            onClose={() => setQuickEditing(false)}
            onReset={() => void resetQuickAskList()}
          />
        )}
        <QuickAskBar
          items={quickAsks}
          disabled={busy}
          editing={quickEditing}
          onEdit={() => setQuickEditing((v) => !v)}
          onPick={(text) => {
            setQuickEditing(false);
            void submit(text);
          }}
        />

          <form
            class="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(input);
            }}
          >
            <input
              value={input}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
              placeholder="问点什么，比如「明天下午有空的教室吗」"
              enterkeyhint="send"
            />
            <button type="submit" disabled={busy || !input.trim()}>
              发送
            </button>
          </form>
        </div>
        </>
      )}

      {sub === 'theme' && (
        <section class={`subpage${slide}`} key="theme">
          <div class="subhead">
            <button
              onClick={() => {
                setNavDir('back');
                setSub('none');
              }}
            >
              ‹ 返回
            </button>
            <strong>外观</strong>
          </div>
          <div class="tabbody">
            <div class="card">
              <div class="cardhead">
                <strong>配色</strong>
                <span>现在：{themeLabel}</span>
              </div>
              <div class="theme-pick">
                {(
                  [
                    ['cream', '米白'],
                    ['ink', '藏青'],
                    ['teal', '蓝绿'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    class={`theme-opt${theme === key ? ' on' : ''}`}
                    onClick={() => void applyTheme(key)}
                  >
                    <i class={`sw-${key}`} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {sub === 'settings' && (
        <section class={`subpage${slide}`} key="settings">
          <div class="subhead">
            <button
              onClick={() => {
                setNavDir('back');
                setSub('none');
              }}
            >
              ‹ 返回
            </button>
            <strong>设置</strong>
          </div>
          <div class="tabbody">
            <div class="card">
              <div class="cardhead">
                <strong>模型</strong>
                <span>{llm.enabled ? '兜底已开' : '只用本地规则'}</span>
              </div>
              <LlmFields
                value={llm}
                httpsPage={isHttps}
                onChange={(patch) => {
                  setLlm({ ...llm, ...patch });
                  void patchLlm(patch);
                }}
              />
              <div class="row">
                <button class="mini" onClick={() => void testLlm()} disabled={testing}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
              </div>
              {testNote ? <p class={testNote.startsWith('连通') ? 'hint ok' : 'hint warn'}>{testNote}</p> : null}
            </div>
          </div>
        </section>
      )}

      {sub === 'about' && (
        <section class={`subpage${slide}`} key="about">
          <div class="subhead">
            <button
              onClick={() => {
                setNavDir('back');
                setSub('none');
              }}
            >
              ‹ 返回
            </button>
            <strong>关于</strong>
          </div>
          <div class="tabbody">
            <div class="card">
              <div class="cardhead">
                <strong>版本</strong>
                <span>{buildVersion}</span>
              </div>
              <div class="about-row">
                <span class="k">前端</span>
                <span class="v">{buildVersion}</span>
              </div>
              <div class="about-row">
                <span class="k">壳桥</span>
                <span class="v">{inShell ? '可用' : '不可用（浏览器里打开）'}</span>
              </div>
              <div class="about-row">
                <span class="k">数据来源</span>
                <span class="v">教务 · 门户 · 图书馆 · 一卡通，都是学校自己的接口</span>
              </div>
              <div class="about-row">
                <span class="k">隐私</span>
                <span class="v">只在本机处理，登录票不上传</span>
              </div>
              <div class="about-row">
                <span class="k">源码</span>
                <span class="v">
                  <a class="link" href="https://github.com/rebeca-aa/zzu-campus-layer" target="_blank" rel="noreferrer">
                    github.com/rebeca-aa/zzu-campus-layer
                  </a>
                </span>
              </div>
            </div>
          </div>
        </section>
      )}

      <TabBar
        tab={tab}
        onTab={(next) => {
          setSub('none');
          setView('chat');
          setTab(next);
        }}
      />

      {updateReady && (
        <div class="dialog-wrap" role="dialog" aria-modal="true">
          <div class="dialog">
            <div class="d-title">新版本已就绪</div>
            <p class="d-sub">刷新一下就是新版。登录态、常用语、聊天记录都留在本机，不会丢。</p>
            {updateNotes.length > 0 && (
              <ul class="d-notes">
                {updateNotes.map((n) => (
                  <li>{n}</li>
                ))}
              </ul>
            )}
            <div class="d-actions">
              <button class="ghost" onClick={() => setUpdateReady(false)}>
                稍后
              </button>
              <button class="primary" onClick={applyUpdate}>
                立即更新
              </button>
            </div>
          </div>
        </div>
      )}

      {announce && (
        <div class="dialog-wrap" role="dialog" aria-modal="true">
          <div class="dialog">
            <div class="d-title">已经更新到 v{announce.version}</div>
            <p class="d-sub">这次改了这些：</p>
            {announce.notes.length > 0 ? (
              <ul class="d-notes">
                {announce.notes.map((n) => (
                  <li>{n}</li>
                ))}
              </ul>
            ) : (
              <p class="d-sub">（这版没有写更新说明）</p>
            )}
            <div class="d-actions">
              <button class="primary" onClick={() => setAnnounce(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 长按确认后真的下单：壳里有原生桥就走桥；浏览器里没有这个能力。 */
async function confirmBook(action: { areaId: string; date: string; seatNo: string }) {
  const bridge = (window as unknown as {
    CampusNotify?: { bookSeat?: (a: string, d: string, s: string, req: string) => void };
  }).CampusNotify;
  if (!bridge?.bookSeat) {
    pushNote("下单只能在安卓壳里做（或电脑端扩展）：手机浏览器没有向图书馆页面提交的权限。");
    return;
  }
  const reqId = String(Date.now());
  const r = await new Promise<{ ok: boolean; error?: string; msg?: string }>((resolve) => {
    const w = window as unknown as Record<string, unknown>;
    const timer = setTimeout(() => resolve({ ok: false, error: "等了 60 秒没回音，可能页面卡住了" }), 60000);
    w.__libSeats = (_id: string, json: string) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(json) as { ok: boolean; error?: string; msg?: string });
      } catch {
        resolve({ ok: false, error: "原生返回的内容看不懂" });
      }
    };
  });
  bridge.bookSeat(action.areaId, action.date, action.seatNo, reqId);
  pushNote(r.ok ? `座位 ${action.seatNo} 预约成功（${r.msg ?? "页面已提示成功"}）` : `没约成：${r.error ?? "未知原因"}`);
}
render(<App />, document.getElementById('app')!);
