import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { Course, Term } from '../src/core/types';
import { currentWeekOf, diffDays, shanghaiHour, weekdayOf } from '../src/core/util';
import { ageText, readCache, writeCache } from '../src/core/offline';
import { dressAdvice, dressAdviceFor, loadWeather, rainReminder, type Weather, type WeatherIconName } from '../src/core/weather';
import {
  dueText,
  homeworkState,
  homeworkStats,
  remainText,
  type HomeworkDraft,
  type HomeworkItem,
  type HomeworkRemind,
  type HomeworkSettings,
} from '../src/core/homework';
import { parseHomeworkFromImages, parseHomeworkSmart } from '../src/core/hwParse';
import { canPickNatively, pickImagesNative } from '../src/core/pick';
import {
  DEFAULT_HOME_BAR_FIXED,
  MAX_HOME_BARS,
  MAX_HOME_BAR_LABEL,
  MAX_HOME_BAR_TEXT,
  addHomeBar,
  cachedHomeBarFixed,
  createCardBar,
  isCardBar,
  isBuiltinBar,
  loadHomeBarFixed,
  saveHomeBarFixed,
  setCardBarVisible,
  updateHomeBar,
  type HomeBar,
  type HomeBarFixed,
} from '../src/core/homeBars';

export type TabKey = 'home' | 'ai' | 'weather' | 'schedule' | 'mine' | 'seat';

/** 一次工具调用的结果；失败时 ok=false，error 是给人看的一句话 */
export type Caller = (name: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }>;

/* 底部三栏：课表点主页课表卡片进、天气点主页天气块进，都不占底栏 */
const TABS: { key: TabKey; label: string }[] = [
  { key: 'home', label: '主页' },
  { key: 'ai', label: 'AI' },
  { key: 'mine', label: '我的' },
];

/** 底部四栏的图标：描边 1.8，24 网格，-currentColor 跟随选中态 */
type MineIconName = 'login' | 'library' | 'renew' | 'alarm' | 'bell' | 'theme' | 'gear' | 'edit' | 'download' | 'info';

/** 「我的」页的线框图标：统一 24 栅格、currentColor 描边，颜色由主题决定 */
function MineIcon({ name }: { name: MineIconName }) {
  const paths: Record<MineIconName, ComponentChildren> = {
    login: (
      <>
        <circle cx="12" cy="8" r="3.4" />
        <path d="M5.2 20c.6-3.5 3.3-5.6 6.8-5.6s6.2 2.1 6.8 5.6" />
      </>
    ),
    library: (
      <>
        <path d="M12 6.4c-1.5-1.3-3.5-2-5.9-2H4.4v13h1.7c2.4 0 4.4.7 5.9 2 1.5-1.3 3.5-2 5.9-2h1.7v-13h-1.7c-2.4 0-4.4.7-5.9 2z" />
        <path d="M12 6.4v13" />
      </>
    ),
    renew: (
      <>
        <rect x="4" y="5.5" width="16" height="15" rx="2.5" />
        <path d="M8 3.5v4M16 3.5v4M4 10.2h16" />
      </>
    ),
    alarm: (
      <>
        <circle cx="12" cy="13" r="6.4" />
        <path d="M12 10v3.2l2.1 1.3" />
        <path d="M5.2 4.8 7.3 2.9M18.8 4.8l-2.1-1.9" />
      </>
    ),
    bell: (
      <>
        <path d="M4.8 6.2h14.4v9.6h-8.6L6 19.2v-3.4H4.8z" />
        <path d="M8.6 10.2h6.8M8.6 12.8h4.4" />
      </>
    ),
    theme: (
      <>
        <path d="M12 3.6a8.4 8.4 0 1 0 0 16.8c1.3 0 1.9-.8 1.9-1.6 0-.8-.5-1.2-.5-1.9 0-1 .8-1.8 2-1.8h1.7c1.9 0 3.2-1.5 3.2-3.3C20.3 6.8 16.6 3.6 12 3.6z" />
        <circle cx="8.2" cy="9.2" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="15.6" cy="9.6" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    ),
    edit: (
      <>
        <path d="M4.2 19.8l1-3.9L15.3 5.8l2.9 2.9L8.1 18.8z" />
        <path d="M13.6 7.5l2.9 2.9" />
      </>
    ),
    download: (
      <>
        <circle cx="12" cy="12" r="8.4" />
        <path d="M12 7.8v7.4M8.9 12.3l3.1 3.1 3.1-3.1" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="8.4" />
        <path d="M12 11v5.2" />
        <circle cx="12" cy="8.1" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function TabIcon({ name }: { name: TabKey }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
    width: 24,
    height: 24,
  };
  if (name === 'home') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M4 10.5 12 4l8 6.5" />
        <path d="M6 9.8V19a1 1 0 0 0 1 1h3.2v-4.6h3.6V20H17a1 1 0 0 0 1-1V9.8" />
      </svg>
    );
  }
  if (name === 'ai') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M4.6 6.8A2.6 2.6 0 0 1 7.2 4.2h9.6a2.6 2.6 0 0 1 2.6 2.6v6.4a2.6 2.6 0 0 1-2.6 2.6H9.4L5.6 19v-2.9a2.6 2.6 0 0 1-1-2.1Z" />
        <path d="M12 8.2v4.4M9.8 10.4h4.4" />
      </svg>
    );
  }
  if (name === 'weather') {
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="9" cy="9.4" r="3.2" />
        <path d="M9 3.4v1.6M3.4 9.4H5M4.9 5.3l1.1 1.1M13.1 5.3l-1.1 1.1" />
        <path d="M10.6 19.4h7.1a3.1 3.1 0 0 0 .2-6.2 4.3 4.3 0 0 0-8.2.8 2.7 2.7 0 0 0 .9 5.4Z" />
      </svg>
    );
  }
  if (name === 'schedule') {
    return (
      <svg {...common} aria-hidden="true">
        <rect x="4" y="5.4" width="16" height="14.2" rx="2.4" />
        <path d="M4 9.6h16M8.6 3.8v3.2M15.4 3.8v3.2" />
        <path d="M8.4 13h.01M12 13h.01M15.6 13h.01M8.4 16.4h.01M12 16.4h.01" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true">
      <circle cx="12" cy="8.4" r="3.5" />
      <path d="M5.2 19.6a6.9 6.9 0 0 1 13.6 0" />
    </svg>
  );
}

export function TabBar({ tab, onTab }: { tab: TabKey; onTab: (t: TabKey) => void }) {
  /* 课表 / 天气 / 图书馆座位不是底部入口，但它们是从主页点进来的，所以高亮仍然停在「主页」 */
  const shown: TabKey = tab === 'schedule' || tab === 'weather' || tab === 'seat' ? 'home' : tab;
  return (
    <nav class="tabbar">
      {TABS.map((t) => (
        <button class={t.key === shown ? 'on' : ''} onClick={() => onTab(t.key)} key={t.key}>
          <span class="ic">
            <TabIcon name={t.key} />
          </span>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

/* ---------------- 主页 ---------------- */

/** 主页上次读到的东西，按天存一份，下次打开先铺出来再刷新 */
interface HomeCache {
  courses: Course[];
  week: number | null;
  at: number;
}

const homeCacheKey = (today: string) => `campus-layer:homeCache:${today}`;

function readHomeCache(today: string): HomeCache | null {
  try {
    const raw = localStorage.getItem(homeCacheKey(today));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HomeCache;
    if (!parsed || !Array.isArray(parsed.courses)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeHomeCache(today: string, data: HomeCache): void {
  try {
    localStorage.setItem(homeCacheKey(today), JSON.stringify(data));
    /* 顺手清掉前一天的，别越攒越多 */
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('campus-layer:homeCache:') && key !== homeCacheKey(today)) localStorage.removeItem(key);
    }
  } catch {
    /* 存不下就算了，不影响用 */
  }
}

export function HomeView(props: {
  today: string;
  /** 20 点后首页翻到「明天」：标题、文案、课表都按明天来 */
  rolled: boolean;
  call: Caller;
  refreshKey: number;
  onBell: () => void;
  unread: number;
  onRefresh: () => void;
  /** 点课表卡片进本周课表页 */
  onOpenSchedule: () => void;
  /** 点「天气」小块进天气页 */
  onWeather: () => void;
  /** 点「图书馆」条进座位图页（这条不再把话发给 AI） */
  onLibrary: () => void;
  /** 作业块：一行文案 + 逾期红点；点进作业页 */
  hw?: { text: string; dot?: boolean } | null;
  onHomework: () => void;
  busy: boolean;
  /** 课表下面那几条自定义栏：点长条直接把话发给 AI；右侧小「+」打开设置窗，统一增删改 */
  bars: HomeBar[];
  onBarsChange: (next: HomeBar[]) => void;
  onPickBar: (text: string) => void;
  /** 该问问卷时给一份文案和三个动作；不给就不显示 */
  survey?: { onFill: () => void; onLater: () => void; onNever: () => void } | null;
}) {
  const { today, call, refreshKey, rolled } = props;
  /* 上次打开时的结果：先铺出来，网络回来再覆盖，省得白屏等 */
  const cached = useMemo(() => readHomeCache(today), [today]);
  const [courses, setCourses] = useState<Course[] | null>(cached?.courses ?? null);
  const [week, setWeek] = useState<number | null>(cached?.week ?? null);
  const [err, setErr] = useState('');
  const [needLogin, setNeedLogin] = useState(false);

  useEffect(() => {
    let alive = true;
    setErr('');
    const authFail = (r: { ok: boolean; error?: string }) => !r.ok && /登录/.test(r.error ?? '');

    /* 课表排在第一个、单独一条：它最快回来，回来就立刻渲染 */
    void (async () => {
      const sched = await call('get_schedule', { day: rolled ? 'tomorrow' : 'today' });
      if (!alive) return;
      if (authFail(sched)) setNeedLogin(true);
      if (sched.ok && sched.data) {
        const payload = (sched.data as any).data ?? sched.data;
        setCourses(Array.isArray(payload?.courses) ? payload.courses : []);
        setWeek(typeof payload?.week === 'number' ? payload.week : null);
      } else {
        /* 拉不到就先留着缓存里的那节课，只提示一句，别把页面清成「今天没有课」 */
        setErr(sched.error ?? '');
      }
    })();

    return () => {
      alive = false;
    };
  }, [refreshKey, today, rolled]);

  /* 拿到新课表就落一份缓存，下次打开先铺它 */
  useEffect(() => {
    if (courses === null) return;
    writeHomeCache(today, { courses, week, at: Date.now() });
  }, [courses, week, today]);

  /* 一卡通栏：不走会话，直接问一次余额；点长条再刷新 */
  const cardShown = props.bars.some(isCardBar);
  const [cardBal, setCardBal] = useState('');
  const [cardBusy, setCardBusy] = useState(false);

  const loadCard = () => {
    setCardBusy(true);
    void (async () => {
      const res = await call('get_card');
      const bal = res.ok ? ((res.data as any)?.data ?? res.data)?.balance : undefined;
      setCardBal(bal === undefined ? '点一下再试' : `¥ ${Number(bal).toFixed(2)}`);
      setCardBusy(false);
    })();
  };

  useEffect(() => {
    if (!cardShown) return;
    loadCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardShown, refreshKey]);

  const nowMin = minutesOf(`${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`);
  const list = courses ?? [];
  /* 翻到明天时，「下一节」就是明天第一节，不能拿今天的时钟去比 */
  const next = rolled ? list[0] : list.find((c) => minutesOf(c.endTime) > nowMin);
  /* 下一节还有多久：今天才说「还有 N 分钟」，明天只说时间 */
  const nextStart = next ? minutesOf(next.startTime) : 0;
  const nextLive = Boolean(next) && !rolled && nextStart <= nowMin;
  const nextIn = rolled || !next
    ? ''
    : nextLive
      ? '正在上'
      : (() => {
          const m = nextStart - nowMin;
          if (m <= 0) return '';
          if (m < 60) return `还有 ${m} 分钟`;
          const h = Math.floor(m / 60);
          const r = m % 60;
          return r ? `还有 ${h} 小时 ${r} 分` : `还有 ${h} 小时`;
        })();
  /* 每门课一个固定颜色，跟「学期课表」那边同一套分配逻辑，但用更好区分的亮色 */
  const lessonColors = useMemo(() => assignColors(list, LESSON_COLORS), [list]);

  return (
    <>
      <header class="top">
        <div class="who">
          <div class="date">
            {props.today.replace(/-/g, ' / ')}
            {week ? ` · 第 ${week} 周` : ''}
          </div>
          <h1>{rolled ? '明天' : '今天'}</h1>
        </div>
        <div class="acts">
          <button class="iconbtn" onClick={props.onBell} aria-label="通知">
            {props.unread > 0 && <span class="dot">{props.unread > 99 ? '99+' : props.unread}</span>}
            <BellIcon />
          </button>
          <button
            class={`iconbtn${props.busy ? ' spin' : ''}`}
            onClick={props.onRefresh}
            aria-label="刷新"
            disabled={props.busy}
          >
            <RefreshIcon />
          </button>
        </div>
      </header>

      <main class="tabbody">
        <section
          class="card card-tap"
          role="button"
          tabIndex={0}
          aria-label="打开本周课表"
          onClick={props.onOpenSchedule}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              props.onOpenSchedule();
            }
          }}
        >
          <div class="cardhead">
            <strong>{rolled ? '明日课表' : '今日课表'}</strong>
            <span class="ch-right">
              本周课表
              <span class="chev" aria-hidden="true">
                ›
              </span>
            </span>
          </div>
          {needLogin && list.length === 0 ? (
            <p class="empty-line">还没登录：去「我的 → 登录」登录一次，这里会显示{rolled ? '明天' : '今天'}的课。</p>
          ) : (
            <>
              {err && (
                <p class="empty-line">
                  {err}
                  <button
                    class="link"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRefresh();
                    }}
                  >
                    重试
                  </button>
                </p>
              )}
              {!err && courses === null && <p class="empty-line">正在读课表…</p>}
              {!err && courses !== null && list.length === 0 && <p class="empty-line">{rolled ? '明天没有课，安心休息。' : '今天没有课，好好休息。'}</p>}
            </>
          )}
          <div class="lessons">
            {list.map((c) => {
              const done = !rolled && minutesOf(c.endTime) <= nowMin;
              const live = !rolled && !done && minutesOf(c.startTime) <= nowMin;
              return (
                <div
                  class={`lesson${done ? ' done' : ''}${live ? ' now' : ''}`}
                  key={c.key}
                  style={`--c:${lessonColors[c.name] ?? '#6a2f6d'}`}
                >
                  <div class="time">
                    {c.startTime}
                    <br />
                    {c.endTime}
                  </div>
                  <div class="body">
                    <div class="name">{c.name}</div>
                    <div class="meta">
                      {[c.location, c.teachers?.join('、')].filter(Boolean).join(' · ') || '地点待定'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div class="cardhead" style="margin:8px 0 0">
            <span>
              {needLogin && list.length === 0
                ? ''
                : next
                  ? `${rolled ? '明天' : '下一节'} ${next.startTime} ${shortName(next.name)}${nextIn ? ` · ${nextIn}` : ''}`
                  : rolled
                    ? '明天没课'
                    : '今天的课都上完了'}
            </span>
          </div>
        </section>

        <HomeBars
          bars={props.bars}
          onChange={props.onBarsChange}
          onPick={props.onPickBar}
          cardText={cardBal}
          cardBusy={cardBusy}
          onCardClick={loadCard}
          onWeather={props.onWeather}
          onLibrary={props.onLibrary}
          hwText={props.hw?.text ?? '还没作业'}
          hwDot={Boolean(props.hw?.dot)}
          onHomework={props.onHomework}
        />

        {props.survey && (
          <section class="survey-ask">
            <div class="sa-head">
              <strong>30 秒问卷</strong>
              <span>想知道你最常用哪块、哪里最别扭</span>
            </div>
            <p class="sa-note">匿名，只带版本号、配色这类信息；不收登录票、学号、聊天记录。</p>
            <div class="sa-acts">
              <button class="primary" onClick={props.survey.onFill}>
                去填
              </button>
              <button class="ghost" onClick={props.survey.onLater}>
                稍后
              </button>
              <button class="ghost" onClick={props.survey.onNever}>
                不再问
              </button>
            </div>
          </section>
        )}
      </main>
    </>
  );
}

/**
 * 主页课表下面的自定义栏。
 * 每条一行长条（标题 + 要发给 AI 的话），点长条直接把话发出去。
 * 板块右上角只留一个小「+」，点开弹出设置窗，统一增删改所有栏；
 * 设置窗里另有「校园卡」开关：开了就多一条只查余额、不进会话的长条。
 */
interface BarDraft {
  /** 编辑期间的行 key；新建行还没有 id */
  key: string;
  id: string | null;
  kind: 'chat' | 'card';
  label: string;
  /** 出厂那条图书馆：点它进座位图，不用写话术，也不许删 */
  lock?: boolean;
  text: string;
}

/** 设置窗打开时的草稿：栏列表 + 图书馆 / 天气 / 作业的显隐 */
interface BarSheet {
  rows: BarDraft[];
  fixed: HomeBarFixed;
}

let draftSeq = 0;
const newDraftKey = () => `d${(draftSeq += 1)}`;

function draftOf(bars: HomeBar[]): BarDraft[] {
  return bars.map((bar) => {
    const kind = bar.kind ?? 'chat';
    return {
      key: bar.id,
      id: bar.id,
      kind,
      label: bar.label,
      lock: isLibraryBar(bar),
      text: kind === 'card' ? '' : bar.text,
    };
  });
}

type BarGlyphName = 'book' | 'room' | 'card' | 'wx' | 'chat' | 'hw' | 'plus';

function BarGlyph({ name }: { name: BarGlyphName }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
    width: 20,
    height: 20,
    'aria-hidden': true,
  };
  if (name === 'book') {
    return (
      <svg {...common}>
        <path d="M12 6.4c-1.5-1.3-3.5-2-5.9-2H4.4v13h1.7c2.4 0 4.4.7 5.9 2 1.5-1.3 3.5-2 5.9-2h1.7v-13h-1.7c-2.4 0-4.4.7-5.9 2z" />
        <path d="M12 6.4v13" />
      </svg>
    );
  }
  if (name === 'room') {
    /* 空座位：椅背 + 坐面 + 两条腿 */
    return (
      <svg {...common}>
        <path d="M7.2 4.6h9.6a1.6 1.6 0 0 1 1.6 1.6v6.2H5.6V6.2a1.6 1.6 0 0 1 1.6-1.6Z" />
        <path d="M5.6 12.4h12.8" />
        <path d="M7.2 12.4v6.6M16.8 12.4v6.6" />
        <path d="M7.2 16.2h9.6" />
      </svg>
    );
  }
  if (name === 'card') {
    return (
      <svg {...common}>
        <rect x="3.5" y="5.5" width="17" height="13" rx="2.4" />
        <path d="M3.5 10h17M7 14.5h4" />
      </svg>
    );
  }
  if (name === 'plus') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.4" />
        <path d="M12 8.2v7.6M8.2 12h7.6" />
      </svg>
    );
  }
  if (name === 'hw') {
    return (
      <svg {...common}>
        <rect x="4.6" y="4.6" width="14.8" height="15" rx="2.2" />
        <path d="M8.6 4.6V3.4h6.8v1.2" />
        <path d="M8.4 12.4l2 2 4.2-4.4" />
      </svg>
    );
  }
  if (name === 'wx') {
    return (
      <svg {...common}>
        <circle cx="9" cy="9.4" r="3.2" />
        <path d="M9 3.4v1.6M3.4 9.4H5M4.9 5.3l1.1 1.1M13.1 5.3l-1.1 1.1" />
        <path d="M10.6 19.4h7.1a3.1 3.1 0 0 0 .2-6.2 4.3 4.3 0 0 0-8.2.8 2.7 2.7 0 0 0 .9 5.4Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4.8 6.2h14.4v9.6h-8.6L6 19.2v-3.4H4.8z" />
    </svg>
  );
}

/** 默认那几条按文案挑图标；用户改过文案就退回对话图标 */
function barGlyphOf(bar: HomeBar): BarGlyphName {
  if (bar.text.includes('图书馆')) return 'book';
  if (bar.text.includes('教室')) return 'room';
  return 'chat';
}

/** 出厂那条「图书馆」栏：显隐开关只认它，用户自己写到「图书馆」的栏不受影响 */
function isLibraryBar(bar: HomeBar): boolean {
  return isBuiltinBar(bar) && barGlyphOf(bar) === 'book';
}

function HomeBars(props: {
  bars: HomeBar[];
  onChange: (next: HomeBar[]) => void;
  onPick: (text: string) => void;
  /** 一卡通栏上显示的余额文案 / 正在查 / 点一下刷新 */
  cardText: string;
  cardBusy: boolean;
  onCardClick: () => void;
  /** 点天气块进天气页 */
  onWeather: () => void;
  /** 点图书馆条进座位图页 */
  onLibrary: () => void;
  /** 作业：一行文字 + 逾期红点 */
  hwText: string;
  hwDot: boolean;
  onHomework: () => void;
}) {
  /* null = 设置窗关着；rows 是正在编辑的整份列表，fixed 是图书馆 / 天气 / 作业的显隐草稿 */
  const [sheet, setSheet] = useState<BarSheet | null>(null);
  const [error, setError] = useState('');
  /* 主页固定入口的显隐：先按上次读到的画，再后台补一次，切页回来不会闪 */
  const [fixed, setFixed] = useState<HomeBarFixed>(() => cachedHomeBarFixed() ?? DEFAULT_HOME_BAR_FIXED);
  useEffect(() => {
    let alive = true;
    void loadHomeBarFixed().then((next) => {
      if (alive) setFixed(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  /* 天气条的小字：直接显示当日实时气温和天气（「晴 · 12°」）；拿不到就先空着，不留废话 */
  const [wxLine, setWxLine] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      loadWeather().then(
        (wx) => {
          if (alive) setWxLine(`${wx.now.label} · ${Math.round(wx.now.temp)}°`);
        },
        () => {
          /* 失败不提示，进天气页能看到完整错误 */
        },
      );
    void load();
    /* 手机网络偶尔抽风：10 秒后再补拉一次，成功就把实时气温填上 */
    const retry = window.setTimeout(() => {
      if (alive) void load();
    }, 10_000);
    return () => {
      alive = false;
      window.clearTimeout(retry);
    };
  }, []);

  const customBars = (fixed.library ? props.bars : props.bars.filter((bar) => !isLibraryBar(bar))).filter(
    (bar) => !isBuiltinBar(bar),
  );
  const libraryBar = fixed.library ? props.bars.find(isLibraryBar) : undefined;
  /* 空教室：内置里除图书馆、校园卡之外的那条 */
  const roomBars = props.bars.filter(
    (bar) => isBuiltinBar(bar) && !isCardBar(bar) && !isLibraryBar(bar),
  );

  const openSheet = () => {
    setError('');
    setSheet({ rows: draftOf(props.bars), fixed });
  };

  const closeSheet = () => {
    setSheet(null);
    setError('');
  };

  const patchRow = (key: string, patch: Partial<BarDraft>) => {
    setSheet((s) => (s ? { ...s, rows: s.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) } : s));
    setError('');
  };

  const addRow = () => {
    setSheet((s) => {
      if (!s || s.rows.filter((row) => row.kind !== 'card').length >= MAX_HOME_BARS) return s;
      return { ...s, rows: [...s.rows, { key: newDraftKey(), id: null, kind: 'chat', label: '', text: '' }] };
    });
    setError('');
  };

  const dropRow = (key: string) => {
    setSheet((s) => (s ? { ...s, rows: s.rows.filter((row) => row.key !== key) } : s));
    setError('');
  };

  /* 图书馆 / 天气 / 作业的开关：同样只改草稿，点保存才生效 */
  const toggleFixed = (key: keyof HomeBarFixed) => {
    setSheet((s) => (s ? { ...s, fixed: { ...s.fixed, [key]: !s.fixed[key] } } : s));
    setError('');
  };

  /* 校园卡开关：只在设置窗里改草稿，点保存才生效 */
  const toggleCard = () => {
    setSheet((s) => {
      if (!s) return s;
      if (s.rows.some((row) => row.kind === 'card')) return { ...s, rows: s.rows.filter((row) => row.kind !== 'card') };
      const card = createCardBar();
      return {
        ...s,
        rows: [...s.rows, { key: card.id, id: card.id, kind: 'card' as const, label: card.label, text: '' }],
      };
    });
    setError('');
  };

  const chatRows = sheet ? sheet.rows.filter((row) => row.kind !== 'card') : [];
  const cardOn = Boolean(sheet?.rows.some((row) => row.kind === 'card'));

  const saveAll = async () => {
    if (!sheet) return;
    try {
      /* 老栏按原顺序留下（一卡通归开关管），再逐条套用改动；新栏接在后面 */
      let next = props.bars.filter((bar) => !isCardBar(bar) && chatRows.some((row) => row.id === bar.id));
      for (const row of chatRows) {
        const text = row.text.trim();
        const label = row.label.trim();
        /* 整行空着就当没加；图书馆那条没有话术，不算漏填 */
        if (!text && !label) continue;
        if (!text && !row.lock) throw new Error('有一条还没写要发给 AI 的话');
        /* 图书馆那条只改标题，正文留着（它只用来认出这是出厂那条） */
        const body = row.lock ? row.text || '图书馆座位图' : text;
        next =
          row.id && next.some((bar) => bar.id === row.id)
            ? updateHomeBar(next, row.id, { label, text: body })
            : addHomeBar(next, body, label);
      }
      props.onChange(setCardBarVisible(next, cardOn));
      setFixed(await saveHomeBarFixed(sheet.fixed));
      closeSheet();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSheet();
    };
    /* 弹窗开着别让底下的页面跟着滚 */
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  return (
    <section class="bars" aria-label="自定义栏">
      <div class="bars-head">
        <button type="button" class="bars-add" aria-label="管理自定义栏" onClick={openSheet}>
          +
        </button>
      </div>
      <div class="bars-grid">
        {/* 顺序固定：作业 → 空教室 → 图书馆 → 天气；校园卡与备忘录不在主页显示 */}
        {fixed.homework ? (
          <button
            type="button"
            class={`bar bar-tile-hw${props.hwDot ? ' alert' : ''}`}
            onClick={props.onHomework}
          >
            {props.hwDot ? <span class="bar-dot" /> : null}
            <span class="bar-ic">
              <BarGlyph name="hw" />
            </span>
            <span class="bar-txt">
              <span class="bar-t">作业</span>
              <span class="bar-s">{props.hwText}</span>
            </span>
          </button>
        ) : null}
        {roomBars.map((bar) => (
          <button
            type="button"
            class="bar"
            key={bar.id}
            onClick={() => props.onPick(bar.text)}
            title={bar.text === bar.label ? undefined : bar.text}
          >
            <span class="bar-ic">
              <BarGlyph name="room" />
            </span>
            <span class="bar-txt">
              <span class="bar-t">{bar.label}</span>
              <span class="bar-s">{bar.text}</span>
            </span>
          </button>
        ))}
        {libraryBar ? (
          <button type="button" class="bar" onClick={props.onLibrary}>
            <span class="bar-ic">
              <BarGlyph name="book" />
            </span>
            <span class="bar-txt">
              <span class="bar-t">{libraryBar.label}</span>
              <span class="bar-s">点开看各楼层座位</span>
            </span>
          </button>
        ) : null}
        {fixed.weather ? (
          <button type="button" class="bar" onClick={props.onWeather}>
            <span class="bar-ic">
              <BarGlyph name="wx" />
            </span>
            <span class="bar-txt">
              <span class="bar-t">天气</span>
              {wxLine ? <span class="bar-s">{wxLine}</span> : null}
            </span>
          </button>
        ) : null}
      </div>
      {customBars.map((bar) => (
        <button
          type="button"
          class="bar"
          key={bar.id}
          onClick={() => props.onPick(bar.text)}
          title={bar.text === bar.label ? undefined : bar.text}
        >
          <span class="bar-ic">
            <BarGlyph name="plus" />
          </span>
          <span class="bar-txt">
            <span class="bar-t">{bar.label}</span>
            <span class="bar-s">{bar.text}</span>
          </span>
        </button>
      ))}
      {!libraryBar && roomBars.length === 0 && customBars.length === 0 && !fixed.weather && !fixed.homework ? (
        <p class="bars-empty">主页入口都藏起来了：点右上角 + 打开「显示」重新勾上。</p>
      ) : null}
      {sheet
        ? createPortal(
            <div
              class="bar-sheet"
              onClick={(e) => {
                if (e.target === e.currentTarget) closeSheet();
              }}
            >
              <div class="bar-sheet-panel" role="dialog" aria-modal="true" aria-label="主页栏位设置">
                <div class="bs-head">
                  <div class="bs-head-t">
                    主页栏位
                    <span class="bs-sub">开关控制显示哪些入口，改完点保存</span>
                  </div>
                  <button type="button" class="bs-x" aria-label="关闭" onClick={closeSheet}>
                    ×
                  </button>
                </div>
                <div class="bs-body">
                  <p class="bs-sec">显示</p>
                  <div class="bs-switches">
                    <button
                      type="button"
                      class={`bs-sw${sheet.fixed.library ? ' on' : ''}`}
                      role="switch"
                      aria-checked={sheet.fixed.library}
                      onClick={() => toggleFixed('library')}
                    >
                      <span class="bs-sw-ic">
                        <BarGlyph name="book" />
                      </span>
                      <span class="bs-sw-t">
                        图书馆
                        <em>点开看各楼层座位</em>
                      </span>
                      <span class="bs-knob" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class={`bs-sw${sheet.fixed.weather ? ' on' : ''}`}
                      role="switch"
                      aria-checked={sheet.fixed.weather}
                      onClick={() => toggleFixed('weather')}
                    >
                      <span class="bs-sw-ic">
                        <BarGlyph name="wx" />
                      </span>
                      <span class="bs-sw-t">
                        天气
                        <em>当日实时气温</em>
                      </span>
                      <span class="bs-knob" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class={`bs-sw${sheet.fixed.homework ? ' on' : ''}`}
                      role="switch"
                      aria-checked={sheet.fixed.homework}
                      onClick={() => toggleFixed('homework')}
                    >
                      <span class="bs-sw-ic">
                        <BarGlyph name="hw" />
                      </span>
                      <span class="bs-sw-t">
                        作业
                        <em>截止提醒 + 逾期红点</em>
                      </span>
                      <span class="bs-knob" aria-hidden="true" />
                    </button>
                  </div>
                  <p class="bs-sec">
                    栏位
                    <span class="bs-count">
                      {chatRows.length} / {MAX_HOME_BARS}
                    </span>
                  </p>
                  <div class="bs-list">
                    {chatRows.map((row) => (
                      <div class={`bs-row${row.lock ? ' bs-lock' : ''}`} key={row.key}>
                        <div class="bs-top">
                          {row.lock ? (
                            /* 图书馆是固定入口：名字不能改，否则认不出是不是它 */
                            <span class="bs-lock-name">{row.label}</span>
                          ) : (
                            <input
                              class="bs-label"
                              value={row.label}
                              maxLength={MAX_HOME_BAR_LABEL}
                              placeholder="标题，留空就用正文开头"
                              onInput={(e) => patchRow(row.key, { label: (e.target as HTMLInputElement).value })}
                            />
                          )}
                          {row.lock ? null : (
                            <button type="button" class="bs-del" aria-label="删掉这一条" onClick={() => dropRow(row.key)}>
                              删除
                            </button>
                          )}
                        </div>
                        {row.lock ? (
                          <p class="bs-lock-note">这条点开就是座位图页，不用写话术，也不能删。</p>
                        ) : (
                          <textarea
                            class="bs-text"
                            value={row.text}
                            rows={2}
                            maxLength={MAX_HOME_BAR_TEXT}
                            placeholder="点这条栏会把这句直接发给 AI"
                            onInput={(e) => patchRow(row.key, { text: (e.target as HTMLTextAreaElement).value })}
                          />
                        )}
                      </div>
                    ))}
                    {chatRows.length === 0 ? <p class="bars-empty">还没有栏，点下面「加一条」。</p> : null}
                  </div>
                  {error ? <p class="hint warn">{error}</p> : null}
                </div>
                <div class="bs-acts">
                  <button type="button" class="bs-add" onClick={addRow} disabled={chatRows.length >= MAX_HOME_BARS}>
                    + 加一条
                  </button>
                  <span class="bs-space" />
                  <button type="button" class="ghost" onClick={closeSheet}>
                    取消
                  </button>
                  <button type="button" class="primary" onClick={saveAll}>
                    保存
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

function shortName(name?: string): string {
  if (!name) return '';
  return name.replace(/^主校区/, '').replace(/图书馆$/, '') || name;
}

/* ---------------- 学期课表 ---------------- */

const PERIOD_START = ['08:00', '08:55', '10:10', '11:05', '14:00', '14:55', '16:00', '16:55', '19:00', '19:55', '20:50', '21:45'];
const PERIOD_END = ['08:45', '09:40', '10:55', '11:50', '14:45', '15:40', '16:45', '17:40', '19:45', '20:40', '21:35', '22:30'];
/* 学期课表上给每门课一个色块：压暗一档的纯色，白字压得住，几门课挨着也分得清 */
// 课表配色：压深、压灰一档——十来门课挨着也不刺眼，白字仍然压得住。
const COLORS = [
  '#4f2a33',
  '#4f3a26',
  '#49452a',
  '#2c4032',
  '#284046',
  '#2c3b50',
  '#3a3148',
  '#472f3f',
  '#4c3a2a',
  '#2f4238',
];

/** #rrggbb → [r,g,b] */
function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1]!, 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 相对亮度（WCAG） */
function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** a 里掺 weight 比例的 b */
function mixHex(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = hexRgb(a);
  const [br, bg, bb] = hexRgb(b);
  const to = (x: number, y: number) => Math.round(x * (1 - weight) + y * weight);
  return `#${[to(ar, br), to(ag, bg), to(ab, bb)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** #rrggbb → [h(0-360), s(0-1), l(0-1)] */
function rgbToHsl(hex: string): [number, number, number] {
  const [r0, g0, b0] = hexRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r0) h = (g0 - b0) / d + (g0 < b0 ? 6 : 0);
  else if (max === g0) h = (b0 - r0) / d + 2;
  else h = (r0 - g0) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return `#${rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 课表色块按主题调：米白主题用浅色块 + 深字，深色主题保持深色块 + 浅字；
 * 最后按背景亮度选字色，保证对比度（小字号也看得清）。
 */
function coursePaint(base: string, theme: string): { bg: string; ink: string } {
  let bg: string;
  if (theme === 'cream' || theme === 'pink') {
    /* 保留色相、提亮降饱和，做成能分辨的浅色块，而不是混成一片灰 */
    const [h, s] = rgbToHsl(base);
    bg = hslToHex(h, Math.min(0.6, Math.max(0.4, s * 1.8)), 0.83);
  } else {
    /* 深色主题：往主题底色靠一点，别和背景打架 */
    bg = mixHex(base, theme === 'teal' ? '#07191a' : '#0b1220', 0.12);
  }
  const ink = luminance(bg) > 0.45 ? '#14202e' : '#f3f5f9';
  return { bg, ink };
}

function colorOf(name: string): string {
  /* FNV-1a：比 h*31 散得开，几门课的色块不会挤在同一两个颜色上 */
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return COLORS[h % COLORS.length]!;
}

/** 2026-2027-1 → 2026-2027 第一学期；认不出来就原样显示 */
function termLabel(term: Term | null): string {
  if (!term?.code) return '本学期';
  const m = /^(\d{4})-(\d{4})-(\d)$/.exec(term.code);
  if (!m) return term.code;
  const n = Number(m[3]);
  const name = n === 1 ? '第一学期' : n === 2 ? '第二学期' : n === 3 ? '第三学期' : `第 ${n} 学期`;
  return `${m[1]}-${m[2]} ${name}`;
}

/** 主页「今日课表」用的颜色：比课表色块那套更亮、彼此更好区分，深浅两套底色都能看清 */
const LESSON_COLORS = [
  '#c0392b',
  '#d2691e',
  '#b8860b',
  '#4d7c0f',
  '#0f766e',
  '#1d4ed8',
  '#6d28d9',
  '#be185d',
  '#0369a1',
  '#92400e',
];

/** 同一屏里两门课不撞色：先按名字取下标，撞了就往后面顺延到空位 */
function assignColors(list: Course[], palette: string[] = COLORS): Record<string, string> {
  const used = new Set<number>();
  const map: Record<string, string> = {};
  for (const c of list) {
    if (map[c.name]) continue;
    let h = 0x811c9dc5;
    for (let i = 0; i < c.name.length; i += 1) {
      h ^= c.name.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    let picked = h % palette.length;
    for (let k = 0; k < palette.length; k += 1) {
      const idx = (picked + k) % palette.length;
      if (!used.has(idx)) {
        picked = idx;
        break;
      }
    }
    used.add(picked);
    map[c.name] = palette[picked]!;
  }
  return map;
}

/** 把课程放到 12 行的哪几行 */
function spanOf(c: Course): { row: number; span: number } {
  const start = c.sectionStart ?? periodOf(c.startTime);
  const end = c.sectionEnd ?? periodOf(c.endTime, true);
  const row = Math.min(Math.max(start, 1), 12);
  const span = Math.min(Math.max(end - row + 1, 1), 13 - row);
  return { row, span };
}

function periodOf(time: string, isEnd = false): number {
  const m = minutesOf(time);
  for (let i = PERIOD_START.length - 1; i >= 0; i--) {
    const s = minutesOf(PERIOD_START[i]!);
    const e = minutesOf(PERIOD_END[i]!);
    if (m >= s && m <= e) return i + 1;
    if (m > e && !isEnd) return i + 2 <= 12 ? i + 2 : 12;
  }
  return 1;
}

export function ScheduleView(props: {
  call: Caller;
  term: Term | null;
  today: string;
  refreshKey: number;
  /** 当前配色：色块的深浅跟着主题走 */
  theme: string;
  /** 回主页：底部已经没有课表入口，靠这个返回 */
  onBack: () => void;
}) {
  const { call, term, today } = props;
  /* 周次范围先算出来，下面把「本周」夹在范围内 */
  const weeks = term?.weeks?.length ? term.weeks : Array.from({ length: 19 }, (_, i) => i + 1);
  const maxWeek = Math.max(...weeks, 1);
  const minWeek = Math.min(...weeks, 1);

  /**
   * 本周是第几周：按「学期首周周一 + 今天」推（服务端 currentWeek 可能是缓存的旧值，
   * 只在没有 startDate 时兜底），再夹进本校历的周次范围。
   */
  const currentWeek = useMemo(
    () => Math.min(Math.max(currentWeekOf(term, today), minWeek), maxWeek),
    [term, today, minWeek, maxWeek],
  );
  const [week, setWeek] = useState<number>(currentWeek);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const colorMap = useMemo(() => assignColors(courses), [courses]);
  /* 每门课的色块：浅/深跟着主题，字色按亮度选，保证对比度 */
  const paintOf = useMemo(() => {
    const map: Record<string, { bg: string; ink: string }> = {};
    for (const c of courses) map[c.name] = coursePaint(colorMap[c.name] ?? colorOf(c.name), props.theme);
    return map;
  }, [courses, colorMap, props.theme]);

  /* 左右滑换周：拖动时跟手，松手超过 56px 就换周，否则弹回 */
  const [dragX, setDragX] = useState(0);
  const [flip, setFlip] = useState<'' | 'left' | 'right'>('');
  const drag = useRef<{ x: number; y: number; live: boolean; locked: boolean } | null>(null);
  const flipTimer = useRef<number | undefined>(undefined);

  const goWeek = (dir: -1 | 1) => {
    setFlip(dir > 0 ? 'left' : 'right');
    setWeek((w) => Math.min(maxWeek, Math.max(minWeek, w + dir)));
    window.clearTimeout(flipTimer.current);
    flipTimer.current = window.setTimeout(() => setFlip(''), 280);
  };

  /* 学期信息晚到 / 换了一天：跟着本周走（不覆盖用户手动翻的周，只对齐"本周变了"） */
  const lastCurrent = useRef(currentWeek);
  useEffect(() => {
    if (lastCurrent.current === currentWeek) return;
    lastCurrent.current = currentWeek;
    setWeek(currentWeek);
  }, [currentWeek]);

  const [at, setAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  /* 学期信息没拿到时，先问一次「本周」（不带 week），用工具算出来的周次兜底 */
  const weekSynced = useRef(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    /* 离线缓存按周存：第 9 周的缓存不能铺到第 10 周上 */
    const cacheKey = `schedule:week:${week}`;
    void (async () => {
      const cached = await readCache<{ week: number; courses: Course[] }>(cacheKey);
      if (!alive) return;
      if (cached && cached.data.week === week) setCourses(cached.data.courses);
      else setCourses([]);
    })();
    void (async () => {
      const askCurrent = !term && !weekSynced.current;
      const res = await call('get_schedule', askCurrent ? {} : { week });
      if (!alive) return;
      if (res.ok) {
        const payload = (res.data as any)?.data ?? res.data;
        const list = Array.isArray(payload?.courses) ? payload.courses : [];
        /* 服务端/工具算出的当前周：界面周次跟着它走，别停在默认的第 1 周 */
        if (askCurrent && typeof payload?.week === 'number' && payload.week > 0) {
          weekSynced.current = true;
          void writeCache(`schedule:week:${payload.week}`, { week: payload.week, courses: list });
          if (payload.week !== week) {
            setWeek(payload.week);
            setLoading(false);
            return;
          }
        }
        setCourses(list);
        setAt(Date.now());
        void writeCache(cacheKey, { week, courses: list });
      } else {
        /* 失败时只认这一周的缓存；没缓存就空着，别拿别的周凑数 */
        const cached = await readCache<{ week: number; courses: Course[] }>(cacheKey);
        if (cached && cached.data.week === week) {
          setCourses(cached.data.courses);
          setErr(`离线：第 ${week} 周课表是${ageText(cached.at)}的`);
        } else {
          setCourses([]);
          setErr(`离线：第 ${week} 周还没有缓存，联网后再看`);
        }
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [week, props.refreshKey, tick, term]);

  const monday = mondayOf(today, week - currentWeek);
  const dayDates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const todayIdx = dayDates.indexOf(today);

  /* 拖动时顶部先预览「松手会到第几周」 */
  const previewWeek =
    dragX <= -56 ? Math.min(maxWeek, week + 1) : dragX >= 56 ? Math.max(minWeek, week - 1) : week;

  return (
    <>
      <header class="top">
        <div class="who">
          <div class="termline">
            <button class="back" onClick={props.onBack} aria-label="回主页">
              ‹
            </button>
            {termLabel(term)}
            <span class="caret">▾</span>
          </div>
        </div>
      </header>
      <main class="tabbody">
        <div class="weekbar">
          <button onClick={() => goWeek(-1)} disabled={week <= minWeek} aria-label="上一周">
            ‹
          </button>
          <span>
            <b class={previewWeek !== week ? 'preview' : ''}>第 {previewWeek} 周</b> / 共 {maxWeek} 周
          </span>
          <button onClick={() => goWeek(1)} disabled={week >= maxWeek} aria-label="下一周">
            ›
          </button>
        </div>

        {err && <p class="empty-line">{err}</p>}

        <div
          class={`grid-wrap${dragX ? ' dragging' : ''}${flip ? ` flip-${flip}` : ''}`}
          style={dragX ? `transform:translate3d(${dragX}px,0,0)` : ''}
          title="左右滑动换周"
          onPointerDown={(e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            drag.current = { x: e.clientX, y: e.clientY, live: true, locked: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d?.live) return;
            const mx = e.clientX - d.x;
            const my = e.clientY - d.y;
            if (!d.locked) {
              if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
              /* 竖着划就让页面滚，横着划才接管 */
              if (Math.abs(mx) <= Math.abs(my) * 1.2) {
                d.live = false;
                return;
              }
              d.locked = true;
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            }
            const atMin = week <= minWeek && mx > 0;
            const atMax = week >= maxWeek && mx < 0;
            setDragX(atMin || atMax ? mx * 0.28 : mx);
          }}
          onPointerUp={() => {
            const d = drag.current;
            drag.current = null;
            if (!d?.locked) {
              setDragX(0);
              return;
            }
            if (dragX <= -56 && week < maxWeek) goWeek(1);
            else if (dragX >= 56 && week > minWeek) goWeek(-1);
            setDragX(0);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragX(0);
          }}
        >
          <div class="grid">
          <div />
          {['一', '二', '三', '四', '五', '六', '日'].map((d, i) => (
            <div class={`dow${i === todayIdx ? ' today' : ''}`} key={d}>
              {d}
              <span class="d">{dayDates[i]?.slice(5).replace('-', '-') ?? ''}</span>
            </div>
          ))}
          {PERIOD_START.map((s, i) => (
            <div class="slot-time" style={`grid-column:1;grid-row:${i + 2}`} key={s}>
              <b>{i + 1}</b>
              {s}-{PERIOD_END[i]}
            </div>
          ))}
          {courses.map((c) => {
            const { row, span } = spanOf(c);
            return (
              <div
                class="course"
                key={c.key}
                style={`grid-column:${c.weekday + 1};grid-row:${row + 1} / span ${span};background:${
                  paintOf[c.name]?.bg ?? coursePaint(colorOf(c.name), props.theme).bg
                };color:${paintOf[c.name]?.ink ?? coursePaint(colorOf(c.name), props.theme).ink}`}
                title={`${c.name} ${c.location ?? ''}`}
              >
                {c.name.startsWith('实验') && <span class="tag">实验</span>}
                <div class="n">{c.name}</div>
                <div class="r">{[c.location].filter(Boolean).join(' ')}</div>
              </div>
            );
          })}
          </div>
        </div>
        {loading && <p class="empty-line">读课表中…</p>}
        {!loading && !err && courses.length === 0 && <p class="empty-line">这周没有课。</p>}
        {at !== null && (
          <p class="hint fresh">
            更新于 {ageText(at)}
            <button class="link" onClick={() => setTick((n) => n + 1)}>
              刷新
            </button>
          </p>
        )}
      </main>
    </>
  );
}

/* ---------------- 宿舍电量 ---------------- */


/* ---------------- 天气 ---------------- */

/** 天气图标：统一 24 栅格线框，颜色跟随当前文字色 */
function WeatherGlyph({ name, size = 28 }: { name: WeatherIconName; size?: number }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
    width: size,
    height: size,
    'aria-hidden': true,
  };
  const cloud = <path d="M7.2 18.6h9.2a3.3 3.3 0 0 0 .2-6.6 4.6 4.6 0 0 0-8.8.9 2.9 2.9 0 0 0-.6 5.7Z" />;
  if (name === 'sun') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4.1" />
        <path d="M12 3.4v2.1M12 18.5v2.1M3.4 12h2.1M18.5 12h2.1M6 6l1.5 1.5M16.5 16.5 18 18M18 6l-1.5 1.5M7.5 16.5 6 18" />
      </svg>
    );
  }
  if (name === 'partly') {
    return (
      <svg {...common}>
        <circle cx="9.2" cy="9" r="3.1" />
        <path d="M9.2 3.6v1.5M3.8 9H5.3M5.4 5.2l1 1M13 5.2l-1 1" />
        {cloud}
      </svg>
    );
  }
  if (name === 'cloud') return <svg {...common}>{cloud}</svg>;
  if (name === 'overcast') {
    return (
      <svg {...common}>
        <path d="M4.6 14.2h9.1a2.9 2.9 0 0 0 .2-5.8 4 4 0 0 0-7.7.8 2.6 2.6 0 0 0-1.6 5Z" />
        <path d="M8.2 19h9.2a3.1 3.1 0 0 0 .2-6.2 4.3 4.3 0 0 0-8.2.8 2.7 2.7 0 0 0-1.2 5.4Z" />
      </svg>
    );
  }
  if (name === 'fog') {
    return (
      <svg {...common}>
        {cloud}
        <path d="M5.4 21h9.6M7.4 23h8.6" />
      </svg>
    );
  }
  if (name === 'drizzle') {
    return (
      <svg {...common}>
        {cloud}
        <path d="M9.4 20.2v1.4M13.6 20.4v1.4" />
      </svg>
    );
  }
  if (name === 'rain') {
    return (
      <svg {...common}>
        {cloud}
        <path d="M8.4 20.2 7.8 22M12 20.2 11.4 22M15.6 20.2 15 22" />
      </svg>
    );
  }
  if (name === 'sleet') {
    return (
      <svg {...common}>
        {cloud}
        <path d="M8.6 20.4v1.8M7.7 21.3h1.8M14.4 20.4v1.8M13.5 21.3h1.8" />
      </svg>
    );
  }
  if (name === 'snow') {
    return (
      <svg {...common}>
        {cloud}
        <path d="M8.4 20.4v2M7.4 20.9l2 1M9.4 20.9l-2 1M15.6 20.4v2M14.6 20.9l2 1M16.6 20.9l-2 1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      {cloud}
      <path d="m12.6 19.6-2.2 3.2h2.4l-1.4 2.6" />
    </svg>
  );
}

/** 昨天 / 今天 / 明天 / 后天 —— 只看真实日期，不跟课表的 20:00 翻页走 */
const WX_LABEL: Record<number, string> = { [-1]: '昨天', 0: '今天', 1: '明天', 2: '后天' };
const WEEK_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function WeatherView({ today }: { today: string }) {
  const [wx, setWx] = useState<Weather | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [tipSent, setTipSent] = useState(false);
  /* 22:00 之后要把「今日着装」换成「明日着装」，每分钟看一眼钟 */
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowTs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    setErr('');
    void (async () => {
      try {
        const data = await loadWeather(Date.now(), tick > 0);
        if (alive) setWx(data);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  const days = (wx?.days ?? []).filter((d) => {
    const diff = diffDays(today, d.date);
    return diff >= -1 && diff <= 2;
  });
  const stale = wx ? Date.now() - wx.fetchedAt > 30 * 60_000 : false;
  const todayDay = days.find((d) => diffDays(today, d.date) === 0);
  const alert = rainReminder(todayDay);
  const tomorrow = days.find((d) => diffDays(today, d.date) === 1);
  const lateNight = shanghaiHour(nowTs) >= 22;
  const dress = wx
    ? lateNight && tomorrow
      ? { label: '明日着装', ...dressAdviceFor(Math.round((tomorrow.max + tomorrow.min) / 2), tomorrow) }
      : { label: '今日着装', ...dressAdvice(wx.now, todayDay) }
    : null;

  /* 有雨提示每天只发一次：壳里走系统通知，浏览器里走 Notification（授权过才发） */
  useEffect(() => {
    if (!wx || !alert) return;
    const key = 'campus-layer:weatherTip';
    try {
      if (localStorage.getItem(key) === today) return;
      localStorage.setItem(key, today);
    } catch {
      return;
    }
    try {
      window.dispatchEvent(new CustomEvent('campus-note', { detail: alert }));
    } catch {
      /* 没有 toast 监听就算了 */
    }
    const bridge = (window as unknown as { CampusNotify?: { notify?: (t: string, b: string) => void } }).CampusNotify;
    try {
      if (bridge?.notify) {
        bridge.notify('天气提醒', alert);
        setTipSent(true);
        return;
      }
    } catch {
      /* 壳里发失败就退回下面 */
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('天气提醒', { body: alert });
        setTipSent(true);
      } catch {
        /* 忽略 */
      }
    }
  }, [wx, alert, today]);
  const nowKey = wx?.now.at ? wx.now.at.slice(0, 13) : '';
  /* 逐小时只留今天、且从当前这个小时往后（免得一进来先看到早上的） */
  const hours = (wx?.hours ?? []).filter(
    (h) => h.time.startsWith(today) && (!nowKey || h.time.slice(0, 13) >= nowKey),
  );

  return (
    <>
      <header class="top">
        <div class="who">
          <h1>天气</h1>
          <div class="sub">郑州 · 主校区</div>
        </div>
        <div class="acts">
          <button
            class={`iconbtn${refreshing ? ' spin' : ''}`}
            aria-label="刷新天气"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              setTick((n) => n + 1);
            }}
          >
            <RefreshIcon />
          </button>
        </div>
      </header>

      <main class="tabbody">
        {err && <p class="empty-line">天气没拉到：{err}</p>}
        {alert && (
          <div class="wx-alert-wrap">
            <p class="wx-alert">{alert}</p>
            {tipSent && <span class="wx-alert-sent">已发送一次通知，今天不再重复</span>}
          </div>
        )}
        {loading && !wx && <p class="empty-line">正在读天气…</p>}

        {wx && (
          <section class="card wx-now">
            <div class="wx-main">
              <WeatherGlyph name={wx.now.icon} size={56} />
              <div class="wx-temp">
                <b>{Math.round(wx.now.temp)}</b>
                <span>°C</span>
              </div>
              <div class="wx-meta">
                <strong>{wx.now.label}</strong>
                <span>体感 {Math.round(wx.now.feels)}°</span>
              </div>
              {dress && (
                <div class="wx-dress">
                  <span class="lbl">{dress.label}</span>
                  <strong>{dress.main}</strong>
                  {dress.extra && <em>{dress.extra}</em>}
                </div>
              )}
            </div>
            <div class="wx-sub">
              {wx.now.humidity !== undefined ? `湿度 ${wx.now.humidity}%` : ''}
              {wx.now.wind !== undefined ? ` · 风速 ${Math.round(wx.now.wind)} km/h` : ''}
              {wx.now.at ? ` · ${wx.now.at.slice(11, 16)} 更新` : ''}
              {stale ? ' · 显示的是上次缓存' : ''}
            </div>
          </section>
        )}

        {hours.length > 0 && (
          <section class="card wx-hours">
            <div class="cardhead">
              <strong>今天逐小时</strong>
              <span>{hours[0]!.time.slice(11, 16)} 起</span>
            </div>
            <div class="wx-hour-list">
              {hours.map((h) => (
                <div class={`wx-hour${h.time.slice(0, 13) === nowKey ? ' on' : ''}`} key={h.time}>
                  <span class="h">{h.time.slice(11, 16)}</span>
                  <WeatherGlyph name={h.icon} size={22} />
                  <b>{Math.round(h.temp)}°</b>
                  <em>{h.rain !== null && h.rain > 0 ? `${h.rain}%` : ''}</em>
                </div>
              ))}
            </div>
          </section>
        )}

        {days.length > 0 && (
          <section class="card wx-days">
            <div class="cardhead">
              <strong>多日天气</strong>
              <span>按真实日期</span>
            </div>
            {days.map((d) => {
              const diff = diffDays(today, d.date);
              return (
                <div class={`wx-day${diff === 0 ? ' on' : ''}${diff === -1 ? ' past' : ''}`} key={d.date}>
                  <div class="wx-d1">
                    <strong>{WX_LABEL[diff] ?? d.date.slice(5)}</strong>
                    <span>
                      {d.date.slice(5).replace('-', '/')} {WEEK_CN[weekdayOf(d.date)]}
                    </span>
                  </div>
                  <WeatherGlyph name={d.icon} size={26} />
                  <div class="wx-d2">
                    <span>{d.label}</span>
                    {d.rain !== null && d.rain > 0 && <em>降水 {d.rain}%</em>}
                  </div>
                  <div class="wx-d3">
                    <b>{Math.round(d.max)}°</b>
                    <span>{Math.round(d.min)}°</span>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        <p class="hint">天气数据来自 Open-Meteo，30 分钟更新一次；断网时显示上次结果。</p>
      </main>
    </>
  );
}

/* ---------------- 我的 ---------------- *//* ---------------- 我的 ---------------- */

function remindSub(on: boolean, next?: string, exactWarn?: boolean): string {
  if (!on) return '每节课开课前 30 分钟各弹一条';
  const base = next ? `下一条：${next}` : '每节课开课前 30 分钟各弹一条';
  return exactWarn ? `${base} · 精确闹钟没开，可能晚到` : base;
}

export function MineView(props: {
  version: string;
  themeLabel: string;
  jwtText: string;
  portalText: string;
  notifyClass: boolean;
  notifyNews: boolean;
  hasShell: boolean;
  /** 安卓壳的版本号（网页版没有，留空）；和网页版本分开显示 */
  shellVersion?: string;
  onLogin: () => void;
  onLibraryLogin: () => void;
  onRenew: () => void;
  onToggleClass: (v: boolean) => void;
  onToggleNews: (v: boolean) => void;
  onTheme: () => void;
  onSettings: () => void;
  onAbout: () => void;
  onCheckUpdate: () => void;
  checking: boolean;
  /** 线上有更新的版本时填它的版本号，用来在「检查更新」那行亮红点 */
  updateVersion?: string;
  renewBusy: boolean;
  onSurvey: () => void;
  /** 「反馈与问卷」那行右边的小字 */
  surveyStatus: string;
  /** 登录快到期时的一句提醒（为空就不显示） */
  loginWarn?: string;
  /** 下一条课前提醒（形如「今天 13:30 高等数学」） */
  remindNext?: string;
  /** 安卓壳没拿到「闹钟和提醒」权限 */
  remindExactWarn?: boolean;
  onTestNotify?: () => void;
}) {
  return (
    <>
      <header class="top">
        <div class="who">
          <h1>我的</h1>
        </div>
      </header>
      <main class="tabbody">
        {props.loginWarn && (
          <button class="mine-warn" onClick={props.onLogin}>
            <span>{props.loginWarn}</span>
            <span class="chev">›</span>
          </button>
        )}

        <div class="mine-card">
          <button class="mine-row" onClick={props.onLogin}>
            <span class="ic"><MineIcon name="login" /></span>
            <span class="tx">
              <span class="t">登录</span>
              <span class="s">
                教务 {props.jwtText} · 门户 {props.portalText}
              </span>
            </span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onLibraryLogin}>
            <span class="ic"><MineIcon name="library" /></span>
            <span class="tx">
              <span class="t">图书馆登录</span>
              <span class="s">另一套账号（学号 + 图书馆密码，加密存本机）</span>
            </span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onRenew} disabled={props.renewBusy}>
            <span class="ic"><MineIcon name="renew" /></span>
            <span class="tx">
              <span class="t">立即续期</span>
              <span class="s">{props.renewBusy ? '续期中…' : `教务 ${props.jwtText} · 验一次登录换新票`}</span>
            </span>
            <span class="chev">›</span>
          </button>
        </div>

        <div class="mine-card">
          <button class="mine-row" onClick={() => props.onToggleClass(!props.notifyClass)}>
            <span class="ic"><MineIcon name="alarm" /></span>
            <span class="tx">
              <span class="t">课前提醒</span>
              <span class="s">每节课开课前 30 分钟各弹一条</span>
            </span>
            <span class={`sw${props.notifyClass ? ' on' : ''}`} />
          </button>
          <button class="mine-row" onClick={() => props.onToggleNews(!props.notifyNews)}>
            <span class="ic"><MineIcon name="bell" /></span>
            <span class="tx">
              <span class="t">资讯通知</span>
              <span class="s">有新通知时提醒一次</span>
            </span>
            <span class={`sw${props.notifyNews ? ' on' : ''}`} />
          </button>
        </div>

        <div class="mine-card">
          <button class="mine-row" onClick={props.onTheme}>
            <span class="ic"><MineIcon name="theme" /></span>
            <span class="tx">
              <span class="t">外观</span>
              <span class="s">米白 / 藏青 / 蓝绿 / 亮粉</span>
            </span>
            <span class="val">{props.themeLabel}</span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onSettings}>
            <span class="ic"><MineIcon name="gear" /></span>
            <span class="tx">
              <span class="t">设置</span>
              <span class="s">服务商与模型、API Key、模型兜底</span>
            </span>
            <span class="chev">›</span>
          </button>
        </div>

        <div class="mine-card">
          <button class="mine-row" onClick={props.onSurvey}>
            <span class="ic"><MineIcon name="edit" /></span>
            <span class="tx">
              <span class="t">反馈与问卷</span>
              <span class="s">{props.surveyStatus}</span>
            </span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onCheckUpdate} disabled={props.checking}>
            <span class="ic"><MineIcon name="download" /></span>
            <span class="tx">
              <span class="t">
                检查更新
                {props.updateVersion ? <i class="dot" /> : null}
              </span>
              <span class="s">
                {props.checking
                  ? '正在检查…'
                  : props.updateVersion
                    ? `有新版本 v${props.updateVersion} · 点这里看改了什么`
                    : `当前 v${props.version}${props.shellVersion ? ` · 壳 ${props.shellVersion}` : ''} · 点这里手动检查`}
              </span>
            </span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onAbout}>
            <span class="ic"><MineIcon name="info" /></span>
            <span class="tx">
              <span class="t">关于</span>
              <span class="s">数据来源、隐私与致谢 · v{props.version}</span>
            </span>
            <span class="chev">›</span>
          </button>
        </div>
      </main>
    </>
  );
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minutesOf(hhmm: string): number {
  return minutes(hhmm);
}

function mondayOf(today: string, weekDelta: number): string {
  const d = new Date(`${today}T00:00:00`);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow + weekDelta * 7);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 拖一条线：按下、拖、松开都在这一条上，按宽度折算成 0–1。 */
function useTrack(onRatio: (r: number) => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const apply = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.width <= 0) return;
    onRatio(Math.min(1, Math.max(0, (clientX - box.left) / box.width)));
  };
  return {
    ref,
    onPointerDown: (e: PointerEvent) => {
      dragging.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      apply(e.clientX);
    },
    onPointerMove: (e: PointerEvent) => {
      if (dragging.current) apply(e.clientX);
    },
    onPointerUp: (e: PointerEvent) => {
      dragging.current = false;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    },
    onPointerCancel: () => {
      dragging.current = false;
    },
  };
}

/**
 * 一条线选色：左边红、右边紫。
 * 传了 level 就再多一条「白 → 黑」的明度线（目前只有背景用）。
 */
export function HueLine(props: {
  label: string;
  hex: string;
  hue: number;
  onChange: (hue: number) => void;
  level?: number;
  onLevel?: (level: number) => void;
}) {
  const hueTrack = useTrack((r) => props.onChange(Math.round(r * 360)));
  const levelTrack = useTrack((r) => props.onLevel?.(Math.round(r * 100)));
  return (
    <div class="pick">
      <div class="pick-head">
        <span class="pick-label">{props.label}</span>
        <code class="pick-hex">{props.hex.toUpperCase()}</code>
      </div>
      <div
        class="hue"
        ref={hueTrack.ref}
        onPointerDown={hueTrack.onPointerDown}
        onPointerMove={hueTrack.onPointerMove}
        onPointerUp={hueTrack.onPointerUp}
        onPointerCancel={hueTrack.onPointerCancel}
      >
        <span
          class="thumb"
          style={`left:${clampPct((props.hue / 360) * 100)}%;background:${props.level === undefined ? props.hex : props.hex}`}
        />
      </div>
      {props.level !== undefined && props.onLevel ? (
        <div
          class="depth"
          ref={levelTrack.ref}
          onPointerDown={levelTrack.onPointerDown}
          onPointerMove={levelTrack.onPointerMove}
          onPointerUp={levelTrack.onPointerUp}
          onPointerCancel={levelTrack.onPointerCancel}
        >
          <span class="thumb sm" style={`left:${clampPct(props.level)}%;background:${props.hex}`} />
        </div>
      ) : null}
    </div>
  );
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** 一条滑杆，右侧带数值。 */
export function LineSlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label class="line-slider">
      <span class="pick-label">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onInput={(e) => props.onChange(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="pick-num">
        {props.value}
        {props.suffix ?? ''}
      </span>
    </label>
  );
}


function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
      <path d="M13.7 17a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}

export interface HomeworkViewProps {
  items: HomeworkItem[];
  settings: HomeworkSettings;
  /** 一行提示（导入成功、删掉几条之类），由外面给，页面只负责显示 */
  note?: string;
  onAdd: (drafts: HomeworkDraft[]) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onImport: (code: string, mode: 'replace' | 'merge') => void;
  onExport: () => void;
  onSaveSettings: (next: HomeworkSettings) => void;
}

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 把 datetime-local 的值（2026-11-16T22:00）变成毫秒 */
function localToMs(v: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return Number.NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 选中的图片先压到 1400px、JPEG 0.82 再发：手机原图 5MB 级，既慢又容易被服务商拒 */
async function fileToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result ?? ''));
    fr.onerror = () => rej(new Error('读不了这张图'));
    fr.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('这张图打不开'));
      i.src = raw;
    });
    const side = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = Math.min(1, 1400 / Math.max(side, 1));
    if (scale >= 1 && raw.length < 700_000) return raw;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return raw;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    // WebView 里解不开的格式（华为相机常出 HEIC）就别把原图硬发出去，模型会直接拒
    if (!/^data:image\/(png|jpe?g|webp|gif);/i.test(raw)) {
      throw new Error('这张图打不开：换成 JPG / PNG 再试（相机原图如果是 HEIC 就常见这个）');
    }
    return raw;
  }
}

export function HomeworkView(props: HomeworkViewProps) {
  const now = Date.now();
  const [paste, setPaste] = useState('');
  const [drafts, setDrafts] = useState<HomeworkDraft[] | null>(null);
  /** 识别用的是模型还是规则、为什么退化——直接显示在草稿上方 */
  const [parseNote, setParseNote] = useState('');
  const [busy, setBusy] = useState(false);
  /** 读图是另一个耗时动作，跟文字识别分开标 */
  const [imgBusy, setImgBusy] = useState(false);
  /** 壳里能原生选图就不用 <input type="file">（WebView 那条路在鸿蒙上读不出文件） */
  const [nativePick] = useState(() => canPickNatively());
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [manual, setManual] = useState({ title: '', course: '', due: '' });
  const [manualOpen, setManualOpen] = useState(false);
  const [code, setCode] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [adv, setAdv] = useState(false);

  const stats = useMemo(() => homeworkStats(props.items, now), [props.items, now]);
  const todo = useMemo(() => props.items.filter((x) => !x.doneAt), [props.items]);
  const done = useMemo(() => props.items.filter((x) => x.doneAt).reverse(), [props.items]);
  const remind = props.settings.remind;

  const doParse = async () => {
    if (!paste.trim() || busy) return;
    setBusy(true);
    setParseNote('');
    try {
      /* 有模型就用模型读（准确得多），没有就退回规则；两种情况都会给一条说明 */
      const out = await parseHomeworkSmart(paste, { now: Date.now() });
      setDrafts(out.drafts.length ? out.drafts : null);
      setParseNote(out.drafts.length ? out.note ?? '' : '这段里没认出作业：可以手动填一条');
    } catch (err) {
      setParseNote(`识别失败：${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  /** 选几张图一起读：一张截图里通常就一条，清单/表格截图可能好几条 */
  const doImage = async (files: FileList | File[] | null) => {
    if (imgBusy) return;
    // 壳里走原生选图（files 为 null），浏览器里走 <input type="file">
    const picked = Array.from(files ?? [])
      .filter((f) => f.type.startsWith('image/') || (!f.type && /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(f.name)))
      .slice(0, 4);
    if (!picked.length && !nativePick) {
      setParseNote('没拿到图片：这台环境只能用浏览器选图，换台设备或更新壳再试');
      return;
    }
    setImgBusy(true);
    setParseNote('');
    try {
      const urls = picked.length
        ? await Promise.all(picked.map((f) => fileToDataUrl(f)))
        : ((await pickImagesNative(4)) ?? []);
      if (!urls.length) {
        setParseNote('没选图片。');
        return;
      }
      const out = await parseHomeworkFromImages(urls, { now: Date.now() });
      setDrafts(out.drafts.length ? out.drafts : null);
      setParseNote(out.note ?? '');
    } catch (err) {
      setParseNote(`读图失败：${(err as Error)?.message ?? err}`);
    } finally {
      setImgBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const addDrafts = (list: HomeworkDraft[]) => {
    props.onAdd(list);
    setDrafts(null);
    setParseNote('');
    setPaste('');
  };

  const patchRemind = (patch: Partial<HomeworkRemind>) => {
    props.onSaveSettings({ ...props.settings, remind: { ...remind, ...patch } });
  };

  return (
    <div class="hw-page">
      <div class="hw-chips">
        <button class="hw-chip" onClick={() => setShowDone(false)}>
          <b>{stats.todo}</b>
          <span>待交</span>
        </button>
        <button class="hw-chip" onClick={() => setShowDone(false)}>
          <b class={stats.overdue ? 'bad' : ''}>{stats.overdue}</b>
          <span>已逾期</span>
        </button>
        <div class="hw-chip flat">
          <b>{stats.rate}%</b>
          <span>完成率</span>
        </div>
      </div>

      {props.note && <p class="hint">{props.note}</p>}

      <section class="card hw-card">
        <div class="hw-head">
          <strong>待交</strong>
          <span>{todo.length ? `按截止时间排，最早 ${dueText(todo[0]!.dueAt, now)}` : '都交了'}</span>
        </div>
        {todo.length === 0 ? (
          <p class="hint">{props.items.length ? '全交完了，去休息。' : '还没有作业：把群里的消息粘到下面，或者手动加一条。'}</p>
        ) : (
          <ul class="hw-list">
            {todo.map((h) => (
              <li key={h.id} class={`hw-row ${homeworkState(h, now)}`}>
                <div class="hw-main">
                  <div class="hw-title">{h.title}</div>
                  <div class="hw-sub">
                    {h.course ? `${h.course} · ` : ''}
                    {dueText(h.dueAt, now)}
                    <span class={`hw-remain ${homeworkState(h, now)}`}>{remainText(h, now)}</span>
                  </div>
                  {h.note && <div class="hw-note">{h.note}</div>}
                </div>
                <div class="hw-acts">
                  <button class="mini" onClick={() => props.onToggle(h.id)}>
                    提交
                  </button>
                  <button class="mini ghost" onClick={() => props.onRemove(h.id)} aria-label="删掉">
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="card hw-card">
        <div class="hw-head">
          <strong>添加</strong>
          <span>粘一段群消息，或者手动填</span>
        </div>
        <textarea
          class="hw-paste"
          rows={3}
          placeholder="例如：@所有人 高数作业：习题册 3.1–3.4 周五前交，纸质交到学委那儿"
          value={paste}
          onInput={(e) => setPaste((e.currentTarget as HTMLTextAreaElement).value)}
          onPaste={(e) => {
            /* 截图直接粘进输入框也能读：剪贴板里带图就交给读图那条路 */
            const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
            if (!imgs.length) return;
            e.preventDefault();
            void doImage(imgs);
          }}
        />
        <div class="hw-acts-row">
          <button class="primary" disabled={!paste.trim() || busy} onClick={() => void doParse()}>
            {busy ? '识别中…' : '识别'}
          </button>
          {/*
            壳里（原生选图可用）：直接一个按钮，点了走 CampusNotify.pickImages，
            壳自己读图压成 data URL 交回来——不经过 WebView 的 file input
            （那条路在鸿蒙上选完图读不出内容，表现成「点了没反应」）。
            浏览器里：真按钮 + 盖在上面的透明 file input，样式仍是普通 ghost 按钮。
          */}
          {nativePick ? (
            <button class="ghost" type="button" disabled={imgBusy} onClick={() => void doImage(null)}>
              {imgBusy ? '读图中…' : '读图'}
            </button>
          ) : (
            <div class="hw-img-btn">
              <button class="ghost" type="button" disabled={imgBusy}>
                {imgBusy ? '读图中…' : '读图'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                class="hw-img-input"
                disabled={imgBusy}
                aria-label="读图"
                onChange={(e) => void doImage((e.currentTarget as HTMLInputElement).files)}
              />
            </div>
          )}
          <button class="ghost" onClick={() => setManualOpen((v) => !v)}>
            {manualOpen ? '收起手填' : '手动填'}
          </button>
        </div>
        <p class="hw-src">
          配了模型就让模型读（拆条、挑课程、算截止都准），没配才走规则；截图直接点「读图」，一次能挑好几张。
        </p>

        {manualOpen && (
          <div class="hw-manual">
            <label class="hw-field">
              <span>内容</span>
              <input
                value={manual.title}
                placeholder="习题册 3.1–3.4"
                onInput={(e) => setManual({ ...manual, title: (e.currentTarget as HTMLInputElement).value })}
              />
            </label>
            <label class="hw-field">
              <span>课程</span>
              <input
                value={manual.course}
                placeholder="可留空"
                onInput={(e) => setManual({ ...manual, course: (e.currentTarget as HTMLInputElement).value })}
              />
            </label>
            <label class="hw-field">
              <span>截止</span>
              <input
                type="datetime-local"
                value={manual.due}
                onInput={(e) => setManual({ ...manual, due: (e.currentTarget as HTMLInputElement).value })}
              />
            </label>
            <button
              class="primary wide"
              disabled={!manual.title.trim() || !manual.due}
              onClick={() => {
                const dueAt = localToMs(manual.due);
                if (!Number.isFinite(dueAt)) return;
                addDrafts([{ title: manual.title, ...(manual.course.trim() ? { course: manual.course.trim() } : {}), dueAt }]);
                setManual({ title: '', course: '', due: '' });
                setManualOpen(false);
              }}
            >
              加进清单
            </button>
          </div>
        )}

        {drafts && drafts.length > 0 && (
          <div class="hw-drafts">
            <div class="hw-head">
              <strong>识别到 {drafts.length} 条</strong>
              <span>不对就改，或先删掉不要的</span>
            </div>
            {parseNote && <p class="hw-src">{parseNote}</p>}
            {drafts.map((d, i) => (
              <div class="hw-draft" key={`${d.title}-${i}`}>
                <input
                  value={d.title}
                  onInput={(e) => {
                    const next = drafts.slice();
                    next[i] = { ...d, title: (e.currentTarget as HTMLInputElement).value };
                    setDrafts(next);
                  }}
                />
                <div class="hw-draft-sub">
                  <input
                    class="hw-course"
                    value={d.course ?? ''}
                    placeholder="课程"
                    onInput={(e) => {
                      const next = drafts.slice();
                      const v = (e.currentTarget as HTMLInputElement).value;
                      next[i] = { ...d, ...(v.trim() ? { course: v } : {}) };
                      setDrafts(next);
                    }}
                  />
                  <input
                    type="datetime-local"
                    value={toLocalInput(d.dueAt)}
                    onInput={(e) => {
                      const next = drafts.slice();
                      const ms = localToMs((e.currentTarget as HTMLInputElement).value);
                      if (Number.isFinite(ms)) next[i] = { ...d, dueAt: ms };
                      setDrafts(next);
                    }}
                  />
                  <button class="mini ghost" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              </div>
            ))}
            <div class="hw-acts-row">
              <button class="primary" onClick={() => addDrafts(drafts)}>
                全加进清单
              </button>
              <button class="ghost" onClick={() => { setDrafts(null); setParseNote(''); }}>
                不要了
              </button>
            </div>
          </div>
        )}
      </section>

      <section class="card hw-card">
        <div class="hw-head">
          <strong>班里共享</strong>
          <span>学委发一串码，粘进来就能同步</span>
        </div>
        <textarea
          class="hw-paste"
          rows={2}
          placeholder="粘学委发的作业码"
          value={code}
          onInput={(e) => setCode((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <div class="hw-acts-row">
          <button class="primary" disabled={!code.trim()} onClick={() => props.onImport(code, 'merge')}>
            合并
          </button>
          <button class="ghost" disabled={!code.trim()} onClick={() => props.onImport(code, 'replace')}>
            覆盖
          </button>
          <button class="ghost" onClick={props.onExport}>
            我的作业码
          </button>
        </div>
        {props.settings.lastImport && (
          <p class="hint">
            上次导入：{dueText(props.settings.lastImport.at, now)}
            {props.settings.lastImport.from ? ` · ${props.settings.lastImport.from}` : ''}
          </p>
        )}
      </section>

      <section class="card hw-card">
        <div class="hw-head">
          <strong>提醒</strong>
          <button class="mini ghost" onClick={() => setAdv((v) => !v)}>
            {adv ? '收起' : '改时间'}
          </button>
        </div>
        <button class="hw-set" onClick={() => patchRemind({ prev: !remind.prev })}>
          <span>前一天</span>
          <span class="hw-set-v">{String(remind.prevHour).padStart(2, '0')}:00</span>
          <span class={`sw${remind.prev ? ' on' : ''}`} />
        </button>
        <button class="hw-set" onClick={() => patchRemind({ sameDay: !remind.sameDay })}>
          <span>当天</span>
          <span class="hw-set-v">{String(remind.sameDayHour).padStart(2, '0')}:00</span>
          <span class={`sw${remind.sameDay ? ' on' : ''}`} />
        </button>
        <button class="hw-set" onClick={() => patchRemind({ soon: !remind.soon })}>
          <span>到期前</span>
          <span class="hw-set-v">{remind.soonHours} 小时</span>
          <span class={`sw${remind.soon ? ' on' : ''}`} />
        </button>
        {adv && (
          <div class="hw-manual">
            <label class="hw-field">
              <span>前一天几点</span>
              <input
                type="number"
                min={0}
                max={23}
                value={remind.prevHour}
                onInput={(e) => patchRemind({ prevHour: Number((e.currentTarget as HTMLInputElement).value) })}
              />
            </label>
            <label class="hw-field">
              <span>当天几点</span>
              <input
                type="number"
                min={0}
                max={23}
                value={remind.sameDayHour}
                onInput={(e) => patchRemind({ sameDayHour: Number((e.currentTarget as HTMLInputElement).value) })}
              />
            </label>
            <label class="hw-field">
              <span>到期前几小时</span>
              <input
                type="number"
                min={1}
                max={24}
                value={remind.soonHours}
                onInput={(e) => patchRemind({ soonHours: Number((e.currentTarget as HTMLInputElement).value) })}
              />
            </label>
            <label class="hw-field">
              <span>每周汇总</span>
              <select
                value={remind.summaryWeekday === null ? -1 : remind.summaryWeekday}
                onChange={(e) => {
                  const v = Number((e.currentTarget as HTMLSelectElement).value);
                  patchRemind({ summaryWeekday: v < 0 ? null : v });
                }}
              >
                <option value={-1}>不汇总</option>
                {WD.map((w, i) => (
                  <option value={i}>{`${w}晚上`}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <p class="hint">逾期之后不再催；提交了就把闹钟撤掉。</p>
      </section>

      <section class="card hw-card">
        <button class="hw-set" onClick={() => setShowDone((v) => !v)}>
          <span>已完成</span>
          <span class="hw-set-v">{done.length} 条</span>
          <span class="mini ghost">{showDone ? '收起' : '看看'}</span>
        </button>
        {showDone &&
          (done.length === 0 ? (
            <p class="hint">还没有提交过的作业。</p>
          ) : (
            <ul class="hw-list">
              {done.map((h) => (
                <li key={h.id} class="hw-row done">
                  <div class="hw-main">
                    <div class="hw-title">{h.title}</div>
                    <div class="hw-sub">
                      {h.course ? `${h.course} · ` : ''}
                      交于 {dueText(h.doneAt ?? 0, now)}
                    </div>
                  </div>
                  <div class="hw-acts">
                    <button class="mini ghost" onClick={() => props.onToggle(h.id)}>
                      撤销
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ))}
      </section>

      <p class="hint">作业只存在这台设备上，不上传；分享出去的码里有课程和作业内容，别发到公开群。</p>
    </div>
  );
}

