import { Fragment, render } from 'preact';

declare const __APP_VERSION__: string;
import { HoldButton } from '../src/ui/hold';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ask } from '../src/core/agent';
import { getKV, parseImportLink } from '../src/core/kv';
import { probeLlm } from '../src/core/llm';
import { buildReminderBlocks, nextReminder, pushReminders } from '../src/core/remind';
import { ageText, readCache, writeCache } from '../src/core/offline';
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
import { LoginPage } from './login-card';
import { CampusMap, RichText, download } from '../src/ui/rich';
import { loadHomeBars, saveHomeBars, type HomeBar } from '../src/core/homeBars';
import { noticesToIcs } from '../src/core/ics';
import { loadTranscript, saveTranscript, trimTranscript } from '../src/core/transcript';
import type { NoticeCard, TodayDigest } from '../src/core/notice';
import { NOTICE_CATEGORIES, type NoticeCategory } from '../src/core/noticeRules';
import {
  DEFAULT_NOTICE_PREFS,
  getNoticePrefs,
  markNoticeRead,
  setNoticePrefs,
  withAllSeen,
  countUnseen,
  type NoticePrefs,
} from '../src/core/noticeStore';
import { getNoticeBody, runTool } from '../src/core/tools';
import {
  loadSurvey,
  markAsked,
  markOptOut,
  markSubmitted,
  recordLaunch,
  saveSurvey,
  shouldAsk,
  surveyStatusText,
  surveyUrl,
  type SurveyState,
} from '../src/core/survey';
import { displayDayShanghai, msUntilMidnightShanghai, msUntilRollover, todayShanghai, weekOfDate } from '../src/core/util';
import type { Term } from '../src/core/types';
import { NoticeBoard } from '../src/ui/notice';
import { CompassView, HomeView, HueLine, LineSlider, MineView, ScheduleView, TabBar, WeatherView, type Caller, type TabKey } from './views';
import { fetchRelease, isNewer, SEEN_KEY, shouldAnnounce, type Release } from './update';
import {
  applyCustomVars,
  CUSTOM_PRESETS,
  CUSTOM_KEY,
  DEFAULT_CUSTOM,
  derivePalette,
  normalizeCustom,
  parseThemeKey,
  type CustomTheme,
  type ThemeKey,
} from '../src/core/theme';
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
const CAS_LOGIN_PORTAL =
  'https://cas.s.zzu.edu.cn/cas/login?service=' +
  encodeURIComponent('https://uniapp.s.zzu.edu.cn/pages/tab/index/index');

/* 常用语改成可编辑列表（原来写死在 QUICK 里）：存 kv，改动立刻落盘。
   初始值先用出厂的，等 refresh() 读到用户自己的列表再替换，避免闪一下空条。 */

const TERM_CACHE_KEY = 'campus-layer:termCache';

/** 学期信息落一份本地缓存：接口抖一下也不至于把课表页打回「第 1 周」。 */
function readCachedTerm(): Term | null {
  try {
    const raw = localStorage.getItem(TERM_CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<Term>;
    if (!o || typeof o.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.startDate)) return null;
    return {
      id: String(o.id ?? ''),
      code: String(o.code ?? ''),
      startDate: o.startDate,
      endDate: String(o.endDate ?? ''),
      weeks: Array.isArray(o.weeks) ? o.weeks : [],
      ...(typeof o.currentWeek === 'number' ? { currentWeek: o.currentWeek } : {}),
    } as Term;
  } catch {
    return null;
  }
}

function writeCachedTerm(t: Term): void {
  try {
    localStorage.setItem(TERM_CACHE_KEY, JSON.stringify(t));
  } catch {
    /* 存不下也不影响用 */
  }
}

function pushNote(text: string) {
  window.dispatchEvent(new CustomEvent("campus-note", { detail: text }));
}

/** 四套配色：前三套写死，第四套「自定义」由 src/core/theme.ts 现算变量。 */
type ThemeName = ThemeKey;

/** 状态栏/地址栏跟着配色走，免得换完主题上边还留着旧颜色。 */
const THEME_COLOR: Record<Exclude<ThemeKey, 'custom'>, string> = {
  cream: '#f4ebd7',
  ink: '#0b1220',
  teal: '#07191a',
  pink: '#fdeef8',
};

const THEME_LABEL: Record<ThemeName, string> = {
  cream: '米白',
  ink: '藏青',
  teal: '蓝绿',
  pink: '亮粉',
  custom: '自定义',
};

function syncThemeMeta(next: ThemeName, custom?: CustomTheme): void {
  const color = next === 'custom' && custom ? derivePalette(custom).bg : THEME_COLOR[next === 'custom' ? 'ink' : next];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

function App() {
  const [statuses, setStatuses] = useState<TokenStatus[]>([]);  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  /* 底部四栏：主页 / AI / 学期课表 / 我的 */
  const [tab, setTab] = useState<TabKey>('home');
  /* 我的下面的二级页 */
  const [sub, setSub] = useState<'none' | 'theme' | 'settings' | 'about' | 'survey'>('none');
  const [term, setTerm] = useState<Term | null>(() => {
    const cached = readCachedTerm();
    if (!cached) return null;
    const w = weekOfDate(cached.startDate, todayShanghai());
    return { ...cached, ...(w > 0 ? { currentWeek: w } : {}) };
  });
  /* 每次进课表页都重拉一次学期信息（周次可能是好几天前拉的） */
  const [termTick, setTermTick] = useState(0);
  const [homeRefresh, setHomeRefresh] = useState(0);
  const [homeBusy, setHomeBusy] = useState(false);
  /* 新版本已就绪（等用户点「立即更新」）与「刚更新完」的公告 */
  const [updateReady, setUpdateReady] = useState(false);
  const [updateNotes, setUpdateNotes] = useState<string[]>([]);
  const [announce, setAnnounce] = useState<Release | null>(null);
  /** 线上最新版（「我的 → 检查更新」查到的），有更新的版本时铃铛旁/该行亮红点 */
  const [remote, setRemote] = useState<Release | null>(null);
  const [checking, setChecking] = useState(false);
  const [uptodate, setUptodate] = useState(false);
  /* 打开通知前在哪一栏，关掉时回那一栏（不是回 AI） */
  const [noticeFrom, setNoticeFrom] = useState<TabKey>('home');
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
  /** 下一条课前提醒的时间戳（界面显示「下一条：今天 13:30」） */
  const [nextRemindAt, setNextRemindAt] = useState<number | null>(null);
  /** 安卓壳没给「闹钟和提醒」权限：只能排不精确闹钟，会晚到 */
  const [remindExactWarn, setRemindExactWarn] = useState(false);
  const [renewBusy, setRenewBusy] = useState(false);
  const [renewNote, setRenewNote] = useState<'' | 'ok' | 'fail'>('');
  const [renewStep, setRenewStep] = useState('');
  const buildVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  /* 扩展里（侧栏）有 host_permissions，跨域请求浏览器会放行；网页版没有 */
  const inExtension =
    typeof (globalThis as unknown as { chrome?: { runtime?: { id?: unknown } } }).chrome?.runtime?.id === 'string';
  /* 配色：cream=米白 / ink=黑+藏青 / teal=黑+蓝绿 / custom=自己调（默认 ink） */
  const [theme, setTheme] = useState<ThemeName>('ink');
  const [themeCustom, setThemeCustom] = useState<CustomTheme>(DEFAULT_CUSTOM);
  /** 字号：立刻生效 + 记在本机 */
  const setFontScale = (n: number) => {
    const v = Math.max(90, Math.min(115, Math.round(n)));
    setFontScaleState(v);
    document.documentElement.style.setProperty('--zoom-scale', String(v / 100));
    void getKV().set('fontScale', v);
  };

  const paint = (next: ThemeName, custom: CustomTheme) => {
    document.documentElement.dataset.theme = next;
    if (next === 'custom') {
      /* 卡片、入口那几块要按「深色/浅色」挑配色，给 CSS 一个可判断的标记 */
      document.documentElement.dataset.scheme = derivePalette(custom).dark ? 'dark' : 'light';
    } else {
      delete document.documentElement.dataset.scheme;
    }
    applyCustomVars(next === 'custom' ? custom : null);
    syncThemeMeta(next, custom);
  };
  const applyTheme = async (next: ThemeName) => {
    setTheme(next);
    paint(next, themeCustom);
    await getKV().set('theme', next);
  };
  /* 导入码、换设备之后：把存储里那套配色重新套上（不重拉数据） */
  const adoptStoredTheme = async () => {
    const name = parseThemeKey(await getKV().get<string>('theme'));
    const custom = normalizeCustom(await getKV().get<CustomTheme>(CUSTOM_KEY));
    setThemeCustom(custom);
    setTheme(name);
    paint(name, custom);
  };
  /* 调自定义的任一格：立刻生效 + 落盘（切回前三套时保留，下次切回来还在） */
  const patchCustom = (patch: Partial<CustomTheme>) => {
    const next = normalizeCustom({ ...themeCustom, ...patch });
    setThemeCustom(next);
    if (theme === 'custom') paint('custom', next);
    void getKV().set(CUSTOM_KEY, next);
  };
  const [notifyNews, setNotifyNews] = useState(false);
  /* 问卷：什么时候问、问的时候带什么参数，全在 src/core/survey.ts 里 */
  const [survey, setSurvey] = useState<SurveyState | null>(null);
  const [surveyAsk, setSurveyAsk] = useState(false);
  /* 登录页的「其他方式」：默认收着，浏览器里换不了票时自动展开 */
  const [moreOpen, setMoreOpen] = useState(false);
  /** 全局字号（90–115），所有配色共用，走 --zoom-scale */
  const [fontScale, setFontScaleState] = useState(100);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [noticeError, setNoticeError] = useState('');
  const [noticePrefs, setNoticePrefsState] = useState<NoticePrefs>(DEFAULT_NOTICE_PREFS);
  /* 主页课表下面的自定义栏（长条 + 右侧「+」），存 homeBars */
  const [homeBars, setHomeBars] = useState<HomeBar[]>([]);
  const [today, setToday] = useState(todayShanghai());
  /* 壳里的 WebView 会活好几天：跨过午夜要自己把「今天」翻过去，
     否则课表页还用昨天的日期算周次和星期几 */
  useEffect(() => {
    const sync = () => setToday(todayShanghai());
    const id = window.setInterval(sync, 60_000);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);
  /* 首页课表：20 点后自动显示「明天」的那张，过点后定时翻页 */
  const [homeDay, setHomeDay] = useState(() => displayDayShanghai());
  useEffect(() => {
    let timer = 0;
    const sync = () => setHomeDay(displayDayShanghai());
    const arm = () => {
      /* 20:00 翻到明天，0 点再翻回「今天」——长开着的页面两个点都要踩到 */
      const wait = Math.min(msUntilRollover(), msUntilMidnightShanghai());
      timer = window.setTimeout(() => {
        sync();
        arm();
      }, wait + 1500);
    };
    arm();
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', sync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', sync);
    };
  }, []);
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
    void adoptStoredTheme();
    setNoticePrefsState(await getNoticePrefs());
      const themePref = await getKV().get<string>('theme');
      const t: ThemeName = parseThemeKey(themePref);
      const customPref = normalizeCustom(await getKV().get<CustomTheme>(CUSTOM_KEY));
      setThemeCustom(customPref);
      setTheme(t);
      paint(t, customPref);
      const scalePref = await getKV().get<number>('fontScale');
      if (typeof scalePref === 'number' && scalePref >= 90 && scalePref <= 115) {
        setFontScaleState(Math.round(scalePref));
        document.documentElement.style.setProperty('--zoom-scale', String(Math.round(scalePref) / 100));
      }
      const classPref = await getKV().get<boolean>('notifyClass');
      const newsPref = await getKV().get<boolean>('notifyNews');
      setNotifyClass(classPref !== false);
      setNotifyNews(newsPref === true);
      /* 上次没发出去的半句话，接回来 */
      const draft = await getKV().get<string>('draft');
      if (typeof draft === 'string' && draft) setInput(draft);
      setHomeBars(await loadHomeBars());
      // 上次聊的那几条带回来：换页面/重开不该从空白开始
      const items = await loadTranscript<Message>();
      restored.current = items;
      setMessages(items);
      hydrated.current = true;
  }

  /** 主页自定义栏变了：同样先换界面，再异步落库。 */
  function patchHomeBars(next: HomeBar[]): void {
    setHomeBars(next);
    void saveHomeBars(next).catch(() => undefined);
  }

  /** 手机端直接跑工具（没有 background），卡片管线与桌面完全同一条。 */
  async function loadNotices(): Promise<void> {
    if (noticeBusy) return;
    setNoticeBusy(true);
    setNoticeError('');
    try {
      let session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        setNoticeError('还没登录：去「我的 → 登录」登录一次，通知就会出来。');
        return;
      }
      const out = await runTool('find_notices', { limit: 50 }, new CampusService(session));
      const payload = out.data as { cards?: NoticeCard[]; digest?: TodayDigest } | undefined;
      const cards = payload?.cards ?? [];
      setNoticeCards(cards);
      setNoticeDigest(payload?.digest ?? null);
      void writeCache('notices', { cards, digest: payload?.digest ?? null });
    if (payload?.digest) void notifyFresh(payload.digest);
    } catch (e) {
      /* 断网时把上次的通知拿出来顶上 */
      const cached = await readCache<{ cards: NoticeCard[]; digest: TodayDigest | null }>('notices');
      if (cached) {
        setNoticeCards(cached.data.cards);
        setNoticeDigest(cached.data.digest ?? null);
        setNoticeError(`离线：通知是 ${ageText(cached.at)}的`);
      } else {
        setNoticeError(e instanceof Error ? e.message : String(e));
      }
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

  /*
   * 从别的栏切回 AI 时，聊天区是重新挂载的，scrollTop 会回到 0（看着像「每次都跳最上方」）。
   * 进来就直接停在最新一条，不播动画；顺便把「贴着底」的状态重置，之后新消息才会自动跟随。
   */
  useLayoutEffect(() => {
    if (tab !== 'ai' || view !== 'chat') return;
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickBottom.current = true;
  }, [tab, view]);

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
  /**
   * 教务票快到期时在「我的」顶部提醒一次。
   * 只提示教务那张（30 天），门户票只有 8 小时、本来就靠自动续期，提醒它只会吵。
   */
  const jwxtDaysLeft =
    jwxt?.valid && typeof jwxt.remainingMs === 'number' ? Math.floor(jwxt.remainingMs / 86_400_000) : null;
  const loginWarn =
    jwxtDaysLeft !== null && jwxtDaysLeft <= 3
      ? jwxtDaysLeft <= 0
        ? '登录今天就到期了，点这里续一次'
        : `登录还有 ${jwxtDaysLeft} 天到期，点这里续一次`
      : undefined;
  /* 票是 8 小时的；剩不到 2 小时就先续，别等它过期了再补救 */
  const NEAR_EXPIRY_MS = 2 * 3_600_000;
  const shouldRenewNow =
    Boolean(jwxt?.present) && (!jwxt?.valid || (jwxt?.remainingMs ?? Number.POSITIVE_INFINITY) < NEAR_EXPIRY_MS);
  useEffect(() => {
    if (ready) void loadNotices();
  }, [ready]);

  /**
   * 算未来两周的课前提醒并交给壳（没有壳时 pushReminders 返回 false，什么也不做）。
   *
   * 除了挂载和切开关，还要在「回到前台」和「每 30 分钟」重排一次：
   * 否则 App 一直开着（不重启），排好的窗口不会往后滚，开了 7～14 天之后就断档。
   */
  /* 网页版没有系统闹钟：页面开着的时候就近排几个浏览器通知（关掉页面就没了） */
  const browserTimers = useRef<number[]>([]);
  const armBrowserNotifications = useCallback((blocks: ReturnType<typeof buildReminderBlocks>) => {
    for (const id of browserTimers.current) window.clearTimeout(id);
    browserTimers.current = [];
    const shell = typeof window !== 'undefined' ? window.CampusNotify : undefined;
    if (shell && typeof shell.setReminders === 'function') return; // 壳里交给系统闹钟
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const now = Date.now();
    for (const b of blocks) {
      const delay = b.at - now;
      if (delay <= 0 || delay > 12 * 3600_000) continue;
      browserTimers.current.push(
        window.setTimeout(() => {
          try {
            new Notification(b.title, { body: b.body });
          } catch {
            /* 通知失败不该影响别的 */
          }
        }, delay),
      );
    }
  }, []);

  const syncReminders = useCallback(async () => {
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
  }, [notifyClass]);

  useEffect(() => {
    if (!ready) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncReminders();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, 30 * 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [ready, syncReminders]);

  async function submit(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setMessages((m) => trimTranscript([...m, { role: 'user', text: question }]));
    setInput('');
    /* 发出去就把草稿清掉；顺手收键盘，别让它挡住回答 */
    void getKV().set('draft', '');
    (document.activeElement as HTMLElement | null)?.blur?.();
    setBusy(true);
    try {
      let session = await loadSession();
      if (!session.jwxtToken && !session.portalToken) {
        setMessages((m) =>
          trimTranscript([
            ...m,
            { role: 'assistant', text: '还没登录：去「我的 → 账号」登录一次（电脑上也可以用扩展面板复制的码导入），然后再问我。', error: true },
          ]),
        );
        setNavDir('fwd');
        openLogin();
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
          openLogin();
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
          openLogin();
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
        void adoptStoredTheme();
        stepBack();
        setNote('登录态已导入');
        setTimeout(() => setNote(''), 2500);
        return 'ok';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        /* 失败时把面板打开，否则用户只看到「已交给页面处理」 */
        setNavDir('fwd');
        openLogin();
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
      void adoptStoredTheme();
      setPaste('');
      stepBack();
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
      void adoptStoredTheme();
      setPaste('');
      stepBack();
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
        void adoptStoredTheme();
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

  /* 切到课表页：把「今天」和学期周次都重新对一次 */
  useEffect(() => {
    if (tab !== 'schedule') return;
    setToday(todayShanghai());
    setTermTick((n) => n + 1);
  }, [tab]);

  /* 学期信息：总周数、当前第几周（跨天/切回前台会跟着 today 重拉一次） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const session = await loadSession();
        if (!session.jwxtToken && !session.portalToken) return;
        const t = await new CampusService(session).term();
        if (alive) {
          setTerm(t);
          writeCachedTerm(t);
        }
      } catch {
        /* 没登录 / 断网就先不显示周次 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [homeRefresh, today, termTick]);

  /* 主页那个刷新：重拉今天的课、图书馆余量、空教室、余额、最新通知，顺带刷一次登录态 */
  const refreshHome = useCallback(() => {
    setHomeBusy(true);
    setHomeRefresh((n) => n + 1);
    void tokenStatuses().then(setStatuses);
    void refresh();
    window.setTimeout(() => setHomeBusy(false), 1200);
  }, []);

  const themeLabel = THEME_LABEL[theme];


  /* 进来自动静默查一次线上版本：有新版就在「检查更新」那行亮红点（不弹窗） */
  useEffect(() => {
    void fetchRelease()
      .then((r) => setRemote(r ?? null))
      .catch(() => undefined);
  }, []);

  /* 有新版本装好了：弹窗，并把这次更新的说明一起拿出来 */
  const offerUpdate = useCallback(() => {
    setUpdateReady(true);
    void fetchRelease().then((r) => setUpdateNotes(r?.notes ?? []));
  }, []);

  /* 「我的 → 检查更新」：主动查一次线上 version.json，有新版才亮红点 */
  const checkUpdate = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    try {
      const r = await fetchRelease();
      setRemote(r ?? null);
      if (r && isNewer(r.version, buildVersion)) {
        setUpdateNotes(r.notes);
        setUpdateReady(true);
      } else {
        setUptodate(true);
      }
    } catch {
      setUptodate(true);
    } finally {
      setChecking(false);
    }
  }, [checking]);

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

  const unread = countUnseen(noticePrefs, noticeCards);

  /* 通知是盖在当前页上的二级页：再点一次铃铛就收起来，回来还是原来那一栏 */
  const closeNotices = (dir: 'fwd' | 'back' = 'back') => {
    setNavDir(dir);
    stepBack();
  };
  const openNotices = () => {
    /* 铃铛只负责「打开」，关闭统一走返回条 / 手机返回键，避免点一下又关掉让人以为没反应 */
    mark();
    setNoticeFrom(tab);
    setNavDir('fwd');
    setView('notices');
    if (noticeCards.length === 0 && !noticeBusy) void loadNotices();
    /* 点了铃铛＝打算看这些通知，红点当场消掉；之后进来的新通知会重新亮 */
    const next = withAllSeen(noticePrefs, noticeCards);
    if (next) void setNoticePrefs({ seenIds: next.seenIds }).then(setNoticePrefsState);
  };

  /* 切栏动画：先把当前页克隆一份盖在上面淡出，新页从下方 14px 处浮上来（交叉淡入） */
  const snapHost = useRef<HTMLDivElement | null>(null);
  const goTab = (next: TabKey) => {
    if (next === tab) return;
    const host = snapHost.current;
    const current = document.querySelector('.app > .page-live');
    if (host && current) {
      const clone = current.cloneNode(true) as HTMLElement;
      clone.classList.remove('page-live');
      /* 快照要跟着原页的滚动位置，否则长列表会"跳回顶部" */
      const srcBodies = current.querySelectorAll('.tabbody');
      const cloneBodies = clone.querySelectorAll('.tabbody');
      srcBodies.forEach((el, i) => {
        const target = cloneBodies[i] as HTMLElement | undefined;
        if (target) {
          target.style.overflow = 'hidden';
          target.scrollTop = (el as HTMLElement).scrollTop;
        }
      });
      clone.querySelectorAll('button, input, textarea, a').forEach((el) => {
        (el as HTMLElement).setAttribute('tabindex', '-1');
      });
      host.replaceChildren(clone);
      host.classList.remove('fade-out');
      void host.offsetWidth; /* 强制重排，让动画每次都从头发一遍 */
      host.classList.add('fade-out');
    }
    mark();
    setTab(next);
  };

  /* 打开登录面板 / 二级页：都先压栈，返回时才回得来 */
  const openLogin = () => {
    mark();
    setNavDir('fwd');
    setSheet('login');
  };
  const openSub = (which: 'theme' | 'settings' | 'about' | 'survey') => {
    mark();
    setNavDir('fwd');
    setSub(which);
  };

  /* 问卷：进来先记一次打开，够条件了就在主页底部放一张小卡片（不弹全屏遮罩） */
  const surveyLogin = statuses.some((s) => s.valid);
  const openSurvey = (source: 'popup' | 'mine') => {
    if (!survey) return;
    const url = surveyUrl(survey, { version: buildVersion, theme, shell: inShell, login: surveyLogin, source });
    window.open(url, '_blank', 'noopener,noreferrer');
    const next = markAsked(survey, buildVersion);
    setSurvey(next);
    setSurveyAsk(false);
    void saveSurvey(next);
  };
  const surveyLater = () => {
    if (!survey) return;
    const next = markAsked(survey, buildVersion);
    setSurvey(next);
    setSurveyAsk(false);
    void saveSurvey(next);
  };
  const surveyNever = () => {
    if (!survey) return;
    const next = markOptOut(survey);
    setSurvey(next);
    setSurveyAsk(false);
    void saveSurvey(next);
  };
  const surveyDone = () => {
    if (!survey) return;
    const next = markSubmitted(survey);
    setSurvey(next);
    setSurveyAsk(false);
    void saveSurvey(next);
  };

  useEffect(() => {
    let alive = true;
    let timer = 0;
    void (async () => {
      const loaded = await loadSurvey();
      const next = recordLaunch(loaded);
      if (!alive) return;
      setSurvey(next);
      void saveSurvey(next);
      /* 停留 3 秒再问：进来就盖住课表最招人烦 */
      timer = window.setTimeout(() => {
        if (alive && shouldAsk(next, buildVersion)) setSurveyAsk(true);
      }, 3000);
    })();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  /* —— 后退栈：手机返回键 / 侧滑返回应该「退回上一页」，而不是直接退出 App ——
     规则：往前走的动作（切栏、开二级页）由下面的 effect 自动 push 一条历史；
     所有「返回」都走 stepBack() → history.back()，由 popstate 把状态还原回来。 */
  const snapKey = `${tab}|${view}|${sheet}|${sub}`;
  const stepBack = useCallback(() => {
    history.back();
  }, []);

  /* —— 返回栈 ——
     自己记一份「页面栈」，历史里只保留一条"哨兵"记录：按返回键时把哨兵吃掉，
     我们从栈里弹上一页出来，然后再布一次防（pushState 哨兵）。
     栈空了说明已经在根页面，这次就真的让浏览器退出。 */
  const stack = useRef<string[]>([]);

  /* 跳转前先把「当前在哪」压栈 —— 同步压，避免 effect 迟到一拍导致返回错位 */
  const mark = useCallback(() => {
    stack.current.push(`${tab}|${view}|${sheet}|${sub}`);
    if (stack.current.length > 40) stack.current.shift();
  }, [tab, view, sheet, sub]);

  useEffect(() => {
    const arm = () => history.pushState({ dsh: 1 }, '');
    arm();
    const onPop = () => {
      const prev = stack.current.pop();
      if (!prev) return; /* 到根了：这次不放哨兵，交给系统退出 */
      arm(); /* 每次都重新布防，否则下一次返回就真的退出去了 */
      const [t, v, s, b] = prev.split('|');
      setNavDir('back');
      setTab((t as TabKey) || 'home');
      setView(v === 'notices' ? 'notices' : 'chat');
      setSheet(s === 'login' ? 'login' : 'none');
      setSub(b === 'theme' || b === 'settings' || b === 'about' || b === 'survey' ? b : 'none');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    /* 只挂一次 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div class="app" data-view={view} data-tab={tab} data-sub={sub} data-sheet={sheet}>
      <div class="page-snapshot" ref={snapHost} aria-hidden="true" />
      {tab === 'home' && (
        <div class="page-live" key="home">
          <HomeView
            today={homeDay.date}
            rolled={homeDay.rolled}
            call={call}
            refreshKey={homeRefresh}
            busy={homeBusy}
            unread={unread}
            onBell={openNotices}
            onRefresh={refreshHome}
            onOpenSchedule={() => {
              setNavDir('fwd');
              goTab('schedule');
            }}
            onCompass={() => {
              setNavDir('fwd');
              goTab('compass');
            }}
            bars={homeBars}
            onBarsChange={patchHomeBars}
            onPickBar={(text) => {
              /* 点长条：切到 AI 栏，直接把这句话发出去 */
              goTab('ai');
              void submit(text);
            }}
            {...(surveyAsk
              ? {
                  survey: {
                    onFill: () => openSurvey('popup'),
                    onLater: surveyLater,
                    onNever: surveyNever,
                  },
                }
              : {})}
          />
        </div>
      )}

      {tab === 'compass' && (
        <div class="page-live" key="compass">
          <CompassView onBack={() => goTab('home')} />
        </div>
      )}

      {tab === 'schedule' && (
        <div class="page-live" key="schedule">
          <ScheduleView
            theme={theme}
            call={call}
            term={term}
            today={today}
            refreshKey={homeRefresh}
            onBack={() => goTab('home')}
          />
        </div>
      )}

      {tab === 'weather' && (
        <div class="page-live" key="weather">
          <WeatherView today={today} />
        </div>
      )}

      {tab === 'mine' && (
        <div class="page-live" key="mine">
          <MineView
          loginWarn={loginWarn}
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
            openLogin();
          }}
          onLibraryLogin={() => {
            const b = (window as unknown as { CampusNotify?: { loginLibrary?: () => void } }).CampusNotify;
            if (b?.loginLibrary) {
              b.loginLibrary();
              return;
            }
            /* 不给网页留路：那个站的网页登录在 App 里走不通，浏览器 / iOS 也一律不打算支持，
               只在安卓壳（有原生通道）里做这件事。 */
            window.alert('图书馆登录要在安卓 App 里进行：当前环境没有登录通道，请改用安卓 App。');
          }}
          onRenew={() => void doRenew()}
          onToggleClass={(v) => void toggleClass(v)}
          onToggleNews={(v) => void toggleNews(v)}
          onTheme={() => {
            setNavDir('fwd');
            openSub('theme');
          }}
          onSettings={() => {
            setNavDir('fwd');
            openSub('settings');
          }}
          onAbout={() => {
            setNavDir('fwd');
            openSub('about');
          }}
          onCheckUpdate={() => void checkUpdate()}
          checking={checking}
          onSurvey={() => {
            setNavDir('fwd');
            openSub('survey');
          }}
          surveyStatus={survey ? surveyStatusText(survey) : '30 秒，帮我把这东西做好用一点'}
          {...(remote && isNewer(remote.version, buildVersion) ? { updateVersion: remote.version } : {})}
        />
        </div>
      )}

      {tab === 'ai' && (
        <div class="page-live" key="ai">
          <header class="top">
            <div class="who">
              <h1>AI</h1>
              <div class="sub">问课表、空教室、图书馆、校园卡</div>
            </div>
          </header>



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

      {view === 'chat' && sheet === 'none' && (
        <>
          <div class="dock">
        <img class="deco" src="./deco.png" alt="" aria-hidden="true" />

          <form
            class="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(input);
            }}
          >
            <input
              value={input}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setInput(v);
                /* 记住没发出去的半句话：切走再回来还在 */
                void getKV().set('draft', v);
              }}
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
        </div>
      )}

      {sheet === 'login' && (
        <section class={`subpage${slide}`} key="login">
          <div class="subhead">
            <button
              onClick={() => {
                setNavDir('back');
                stepBack();
              }}
            >
              ‹ 返回
            </button>
            <strong>登录</strong>
          </div>
          <div class="tabbody">
            <LoginPage
              signedIn={jwxt?.valid ? jwxt.remainingText : ''}
              onSignedIn={() => void refresh()}
              onOpenLogin={() => {
                window.open(CAS_LOGIN, '_blank', 'noreferrer');
                setMoreOpen(true);
              }}
            />
            <p class="hint login-status">
              教务 {jwxt?.present ? (jwxt.valid ? jwxt.remainingText : '已过期') : '未登录'} · 门户{' '}
              {portal?.present ? (portal.valid ? portal.remainingText : '已过期') : '未登录'}
            </p>
            <details
              class="more"
              open={moreOpen}
              onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>其他方式</summary>
              <div class="more-body">
                <p class="row">
                  {inShell ? (
                    <button class="ghost" onClick={() => void shellLogin()}>
                      用学校账号登录
                    </button>
                  ) : (
                    <a class="ghost" href={CAS_LOGIN} target="_blank" rel="noreferrer">
                      打开学校登录页
                    </a>
                  )}
                  <button class="ghost" onClick={() => void copyLoginUrl()}>
                    复制登录页链接
                  </button>
                  <button class="ghost" onClick={() => void readClip()}>
                    从剪贴板读取
                  </button>
                </p>
                <textarea
                  rows={3}
                  placeholder="登录完把地址栏那条网址粘到这里"
                  value={paste}
                  onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)}
                />
                <p class="row">
                  <button class="primary" onClick={() => void doImport()} disabled={!paste.trim()}>
                    保存
                  </button>
                  <button class="ghost" onClick={() => void doExport()} title="复制到剪贴板，里面是明文">
                    导出码
                  </button>
                  <button class="ghost" onClick={() => void shareLink()}>
                    分享链接
                  </button>
                  <button
                    class="ghost"
                    onClick={async () => {
                      /* 清掉就找不回来了，先问一句 */
                      if (!window.confirm('清掉这台设备上的登录票？清完要重新登录。')) return;
                      await clearTokens();
                      setStatuses(await tokenStatuses());
                      setNote('已清除');
                    }}
                  >
                    清除
                  </button>
                </p>
                {note && <p class="hint warn">{note}</p>}
                <p class="hint" style="margin-top:2px">
                  导出码是<strong>明文</strong>，粘完就删，别发群里。
                </p>
                <p class="row">
                  <button type="button" class="ghost" disabled={renewBusy} onClick={() => void doRenew()}>
                    {renewBusy ? '续期中…' : '续期'}
                  </button>
                  {renewStep && <span class="hint">{renewStep}</span>}
                  {renewNote === 'ok' && <span class="hint ok">续期成功</span>}
                  {renewNote === 'fail' && <span class="hint warn">续期失败</span>}
                </p>
                <p class="hint" style="opacity:.6">
                  v{buildVersion}
                </p>
              </div>
            </details>
          </div>
        </section>
      )}

      {sub === 'theme' && (
        <section class={`subpage${slide}`} key="theme">
          <div class="subhead">
            <button
              onClick={() => {
                setNavDir('back');
                stepBack();
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
              <div class="theme-pick has-custom">
                {(
                  [
                    ['cream', '米白'],
                    ['ink', '藏青'],
                    ['teal', '蓝绿'],
                    ['pink', '亮粉'],
                    ['custom', '自定义'],
                  ] as const
                ).map(([key, label], index) => (
                  <Fragment key={key}>
                    {/* 三枚放一行，「自定义」自己换到下一行，窄屏也不会被裁掉 */}
                    {key === 'custom' ? <span class="theme-break" aria-hidden="true" /> : null}
                    <button
                      class={`theme-opt${theme === key ? ' on' : ''}`}
                      onClick={() => void applyTheme(key)}
                    >
                      <i class={`sw-${key}`} />
                      {label}
                    </button>
                  </Fragment>
                ))}
              </div>
              {theme === 'custom' ? (
                <p class="hint">拖那条线就行：从左到右是红到紫。下面这条白到黑管深浅。</p>
              ) : (
                <p class="hint">选「自定义」可以自己配色、调深浅和字号。</p>
              )}
            </div>

            {theme === 'custom' ? (
              <>
                <div class="card">
                  <div class="cardhead">
                    <strong>颜色</strong>
                    <span>拖那条线</span>
                  </div>
                  <HueLine
                    label="背景"
                    hex={derivePalette(themeCustom).bg}
                    hue={themeCustom.bgHue}
                    onChange={(hue) => patchCustom({ bgHue: hue })}
                    level={themeCustom.bgLevel}
                    onLevel={(bgLevel) => patchCustom({ bgLevel })}
                  />
                  <HueLine
                    label="文字"
                    hex={derivePalette(themeCustom).text}
                    hue={themeCustom.textHue}
                    onChange={(hue) => patchCustom({ textHue: hue })}
                  />
                  <HueLine
                    label="强调色"
                    hex={derivePalette(themeCustom).accent}
                    hue={themeCustom.accentHue}
                    onChange={(hue) => patchCustom({ accentHue: hue })}
                  />
                  <p class="hint">文字的深浅会按对比度自动挑，保证看得清；强调色用在按钮、选中的栏和链接。</p>
                </div>

                <div class="card">
                  <div class="cardhead">
                    <strong>质感</strong>
                    <span>统一生效</span>
                  </div>
                  <LineSlider
                    label="深浅"
                    value={themeCustom.shade}
                    min={0}
                    max={100}
                    onChange={(shade) => patchCustom({ shade })}
                  />
                  <LineSlider
                    label="卡片透明"
                    value={themeCustom.panelAlpha}
                    min={40}
                    max={100}
                    suffix="%"
                    onChange={(panelAlpha) => patchCustom({ panelAlpha })}
                  />
                  <LineSlider
                    label="圆角"
                    value={themeCustom.radius}
                    min={8}
                    max={24}
                    onChange={(radius) => patchCustom({ radius })}
                  />
                </div>

                <div class="card">
                  <div class="cardhead">
                    <strong>预设</strong>
                    <span>点一下先套上，再微调</span>
                  </div>
                  <div class="preset-row">
                    {CUSTOM_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        class="preset"
                        onClick={() => {
                          setThemeCustom(p.theme);
                          if (theme === 'custom') paint('custom', p.theme);
                          void getKV().set(CUSTOM_KEY, p.theme);
                        }}
                      >
                        <i style={`background:${derivePalette(p.theme).bg}`} />
                        <span>{p.name}</span>
                      </button>
                    ))}
                  </div>
                  <div class="row" style="margin-top:10px">
                    <button
                      class="mini"
                      onClick={() => {
                        setThemeCustom(DEFAULT_CUSTOM);
                        if (theme === 'custom') paint('custom', DEFAULT_CUSTOM);
                        void getKV().set(CUSTOM_KEY, DEFAULT_CUSTOM);
                      }}
                    >
                      恢复默认
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            <div class="card">
              <div class="cardhead">
                <strong>字号</strong>
                <span>所有配色都生效</span>
              </div>
              <LineSlider
                label="整体大小"
                value={fontScale}
                min={90}
                max={115}
                suffix="%"
                onChange={(n) => setFontScale(n)}
              />
              <p class="hint">只影响显示，不改系统字体。看不清就调大一点，最大 115%。</p>
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
                stepBack();
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


      {sub === 'survey' && (
        <section class={`subpage${slide}`} key="survey">
          <div class="subhead">
            <button
              onClick={() => {
                setNavDir('back');
                stepBack();
              }}
            >
              ‹ 返回
            </button>
            <strong>反馈与问卷</strong>
          </div>
          <div class="tabbody">
            <div class="card">
              <div class="cardhead">
                <strong>30 秒问卷</strong>
                <span>匿名</span>
              </div>
              <p class="hint">想知道你平时怎么用它、哪里最别扭。填完就不再打扰；不想填，点下面「不再提醒」就行。</p>
              <p class="hint">
                只会带上：版本 {buildVersion}、当前配色、{inShell ? '装在 App 里' : '浏览器里打开'}、
                {surveyLogin ? '已登录' : '未登录'} 这四项。<strong>不收登录票、学号、聊天记录</strong>。
              </p>
              <button class="primary wide" onClick={() => openSurvey('mine')}>
                去填问卷 ↗
              </button>
              <div class="row" style="gap:8px;margin-top:10px">
                <button class="ghost" onClick={surveyDone}>
                  我填过了
                </button>
                <button class="ghost" onClick={surveyNever}>
                  不再提醒
                </button>
              </div>
              <p class="hint" style="margin-top:8px">
                {survey ? surveyStatusText(survey) : '30 秒，帮我把这东西做好用一点'}
              </p>
            </div>

            <div class="card">
              <div class="cardhead">
                <strong>其他方式</strong>
                <span>不用问卷也行</span>
              </div>
              <div class="about-row">
                <span class="k">提个 Issue</span>
                <span class="v">
                  <a
                    class="link"
                    href={`https://github.com/rebeca-aa/zzu-campus-layer/issues/new?title=${encodeURIComponent('[反馈] ')}&body=${encodeURIComponent(`版本：${buildVersion}\n\n我的问题/建议：\n`)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    在 GitHub 上写，带版本号，公开可追踪
                  </a>
                </span>
              </div>
              <p class="hint">
                不方便公开的话，也可以在「我的 → 账号」里找到联系方式；不过问卷那份最省事，只有选择题。
              </p>
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
                stepBack();
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
                <span class="v">教务 · 门户 · 图书馆，都是学校自己的接口</span>
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
            <div class="card credit">
              <div class="cardhead">
                <strong>开源与致谢</strong>
                <span>MIT / Apache-2.0</span>
              </div>
              <div class="about-row">
                <span class="k">Preact</span>
                <span class="v">
                  Jason Miller 与贡献者 · MIT ·{' '}
                  <a class="link" href="https://preactjs.com" target="_blank" rel="noreferrer">
                    官网
                  </a>
                  <br />
                  界面这一层
                </span>
              </div>
              <div class="about-row">
                <span class="k">Zod</span>
                <span class="v">
                  Colin McDonnell · MIT ·{' '}
                  <a class="link" href="https://zod.dev" target="_blank" rel="noreferrer">
                    官网
                  </a>
                  <br />
                  工具参数校验
                </span>
              </div>
              <div class="about-row">
                <span class="k">Vite</span>
                <span class="v">
                  Evan You 与 Vite 团队 · MIT ·{' '}
                  <a class="link" href="https://vite.dev" target="_blank" rel="noreferrer">
                    官网
                  </a>
                  <br />
                  构建（开发期依赖）
                </span>
              </div>
              <div class="about-row">
                <span class="k">TypeScript</span>
                <span class="v">
                  Microsoft · Apache-2.0 ·{' '}
                  <a class="link" href="https://www.typescriptlang.org" target="_blank" rel="noreferrer">
                    官网
                  </a>
                  <br />
                  类型检查（开发期依赖）
                </span>
              </div>
              <div class="about-row">
                <span class="k">Vitest</span>
                <span class="v">
                  Anthony Fu 等 · MIT ·{' '}
                  <a class="link" href="https://vitest.dev" target="_blank" rel="noreferrer">
                    官网
                  </a>
                  <br />
                  单元测试（开发期依赖）
                </span>
              </div>
              <div class="about-row">
                <span class="k">类型定义</span>
                <span class="v">@types/chrome · @types/node · DefinitelyTyped 社区 · MIT（开发期依赖）</span>
              </div>
              <p class="hint">
                许可与版权归各位作者所有。
              </p>
            </div>
          </div>
        </section>
      )}

      {view === 'notices' && (
        <section class={`subpage${slide}`} key="notices">
          <div class="subhead">
            <button
              onClick={() => {
                closeNotices();
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

      <TabBar
        tab={tab}
        onTab={(next) => {
          /* 二级页盖着时点底栏＝直接去那一栏（把它当一次前进，返回还能回到二级页） */
          if (sub !== 'none' || sheet !== 'none' || view !== 'chat') {
            mark();
            setView('chat');
            setSub('none');
            setSheet('none');
            setTab(next);
            return;
          }
          goTab(next);
        }}
      />

      {updateReady && (
        <div class="dialog-wrap" role="dialog" aria-modal="true">
          <div class="dialog">
            <div class="d-title">{remote?.version ? `发现新版本 v${remote.version}` : '新版本已就绪'}</div>
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

      {uptodate && (
        <div class="dialog-wrap" role="dialog" aria-modal="true">
          <div class="dialog">
            <div class="d-title">已经是最新版</div>
            <p class="d-sub">当前 v{buildVersion}，没有更新的版本了。</p>
            <div class="d-actions">
              <button class="primary" onClick={() => setUptodate(false)}>
                知道了
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
