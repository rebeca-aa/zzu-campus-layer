import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { Course, Term } from '../src/core/types';
import { currentWeekOf } from '../src/core/util';
import { ageText, readCache, writeCache } from '../src/core/offline';
import {
  MAX_HOME_BARS,
  MAX_HOME_BAR_LABEL,
  MAX_HOME_BAR_TEXT,
  addHomeBar,
  createCardBar,
  isCardBar,
  setCardBarVisible,
  updateHomeBar,
  type HomeBar,
} from '../src/core/homeBars';

export type TabKey = 'home' | 'ai' | 'schedule' | 'mine';

/** 一次工具调用的结果；失败时 ok=false，error 是给人看的一句话 */
export type Caller = (name: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }>;

/* 底部三栏：课表不再单独占一格，改成点主页的课表卡片进去 */
const TABS: { key: TabKey; label: string }[] = [
  { key: 'home', label: '主页' },
  { key: 'ai', label: 'AI' },
  { key: 'mine', label: '我的' },
];

/** 底部四栏的图标：描边 1.8，24 网格，-currentColor 跟随选中态 */
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
  /* 课表页不是底部入口，但它是从主页点进来的，所以高亮仍然停在「主页」 */
  const shown: TabKey = tab === 'schedule' ? 'home' : tab;
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
  text: string;
}

let draftSeq = 0;
const newDraftKey = () => `d${(draftSeq += 1)}`;

function draftOf(bars: HomeBar[]): BarDraft[] {
  return bars.map((bar) => {
    const kind = bar.kind ?? 'chat';
    return { key: bar.id, id: bar.id, kind, label: bar.label, text: kind === 'card' ? '' : bar.text };
  });
}

function HomeBars(props: {
  bars: HomeBar[];
  onChange: (next: HomeBar[]) => void;
  onPick: (text: string) => void;
  /** 一卡通栏上显示的余额文案 / 正在查 / 点一下刷新 */
  cardText: string;
  cardBusy: boolean;
  onCardClick: () => void;
}) {
  /* null = 设置窗关着；数组里是正在编辑的整份列表 */
  const [sheet, setSheet] = useState<BarDraft[] | null>(null);
  const [error, setError] = useState('');

  const openSheet = () => {
    setError('');
    setSheet(draftOf(props.bars));
  };

  const closeSheet = () => {
    setSheet(null);
    setError('');
  };

  const patchRow = (key: string, patch: Partial<BarDraft>) => {
    setSheet((rows) => (rows ? rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) : rows));
    setError('');
  };

  const addRow = () => {
    setSheet((rows) => {
      if (!rows || rows.filter((row) => row.kind !== 'card').length >= MAX_HOME_BARS) return rows;
      return [...rows, { key: newDraftKey(), id: null, kind: 'chat', label: '', text: '' }];
    });
    setError('');
  };

  const dropRow = (key: string) => {
    setSheet((rows) => (rows ? rows.filter((row) => row.key !== key) : rows));
    setError('');
  };

  /* 校园卡开关：只在设置窗里改草稿，点保存才生效 */
  const toggleCard = () => {
    setSheet((rows) => {
      if (!rows) return rows;
      if (rows.some((row) => row.kind === 'card')) return rows.filter((row) => row.kind !== 'card');
      const card = createCardBar();
      return [...rows, { key: card.id, id: card.id, kind: 'card' as const, label: card.label, text: '' }];
    });
    setError('');
  };

  const chatRows = sheet ? sheet.filter((row) => row.kind !== 'card') : [];
  const cardOn = Boolean(sheet?.some((row) => row.kind === 'card'));

  const saveAll = () => {
    if (!sheet) return;
    try {
      /* 老栏按原顺序留下（一卡通归开关管），再逐条套用改动；新栏接在后面 */
      let next = props.bars.filter((bar) => !isCardBar(bar) && chatRows.some((row) => row.id === bar.id));
      for (const row of chatRows) {
        const text = row.text.trim();
        const label = row.label.trim();
        /* 整行空着就当没加 */
        if (!text && !label) continue;
        if (!text) throw new Error('有一条还没写要发给 AI 的话');
        next =
          row.id && next.some((bar) => bar.id === row.id)
            ? updateHomeBar(next, row.id, { label, text })
            : addHomeBar(next, text, label);
      }
      props.onChange(setCardBarVisible(next, cardOn));
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
      {props.bars.map((bar) =>
        isCardBar(bar) ? (
          <button
            type="button"
            class="bar bar-card"
            key={bar.id}
            onClick={props.onCardClick}
            title="点一下刷新一卡通余额"
          >
            <span class="bar-t">{bar.label}</span>
            <span class="bar-s">{props.cardBusy ? '正在查余额…' : props.cardText || '点一下查余额'}</span>
          </button>
        ) : (
          <button
            type="button"
            class="bar"
            key={bar.id}
            onClick={() => props.onPick(bar.text)}
            title={bar.text === bar.label ? undefined : bar.text}
          >
            <span class="bar-t">{bar.label}</span>
            <span class="bar-s">{bar.text}</span>
          </button>
        ),
      )}
      {props.bars.length === 0 ? (
        <p class="bars-empty">点右上角 + 加自定义栏，点一下就把话发给 AI。</p>
      ) : null}
      {sheet
        ? createPortal(
            <div
              class="bar-sheet"
              onClick={(e) => {
                if (e.target === e.currentTarget) closeSheet();
              }}
            >
              <div class="bar-sheet-panel" role="dialog" aria-modal="true" aria-label="自定义栏设置">
                <div class="bs-head">
                  <strong>自定义栏</strong>
                  <span class="bs-count">
                    {chatRows.length} / {MAX_HOME_BARS}
                  </span>
                </div>
                <button
                  type="button"
                  class={`bs-switch${cardOn ? ' on' : ''}`}
                  role="switch"
                  aria-checked={cardOn}
                  onClick={toggleCard}
                >
                  <span class="bs-switch-t">
                    校园卡
                    <em>只查余额，不进会话</em>
                  </span>
                  <span class="bs-switch-knob" aria-hidden="true" />
                </button>
                <div class="bs-list">
                  {chatRows.map((row) => (
                    <div class="bs-row" key={row.key}>
                      <div class="bs-top">
                        <input
                          class="bs-label"
                          value={row.label}
                          maxLength={MAX_HOME_BAR_LABEL}
                          placeholder="标题，留空就用正文开头"
                          onInput={(e) => patchRow(row.key, { label: (e.target as HTMLInputElement).value })}
                        />
                        <button type="button" class="bs-del" aria-label="删掉这一条" onClick={() => dropRow(row.key)}>
                          删除
                        </button>
                      </div>
                      <textarea
                        class="bs-text"
                        value={row.text}
                        rows={2}
                        maxLength={MAX_HOME_BAR_TEXT}
                        placeholder="点这条栏会把这句直接发给 AI"
                        onInput={(e) => patchRow(row.key, { text: (e.target as HTMLTextAreaElement).value })}
                      />
                    </div>
                  ))}
                  {chatRows.length === 0 ? <p class="bars-empty">还没有自定义栏，点下面「加一条」。</p> : null}
                </div>
                {error ? <p class="hint warn">{error}</p> : null}
                <div class="bs-acts">
                  <button type="button" class="ghost" onClick={addRow} disabled={chatRows.length >= MAX_HOME_BARS}>
                    加一条
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
  if (theme === 'cream') {
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
    /* 先把上次的课表铺上：断网/接口慢时也不至于空白 */
    void (async () => {
      const cached = await readCache<Course[]>('schedule');
      if (alive && cached) setCourses(cached.data);
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
          if (payload.week !== week) {
            setWeek(payload.week);
            setLoading(false);
            return;
          }
        }
        setCourses(list);
        setAt(Date.now());
        void writeCache('schedule', list);
      } else {
        /* 失败时别把缓存清掉，改成提示"这是上次的" */
        const cached = await readCache<Course[]>('schedule');
        if (cached) {
          setCourses(cached.data);
          setErr(`离线：课表是 ${ageText(cached.at)}的`);
        } else {
          setCourses([]);
          setErr(res.error ?? '课表没读出来');
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


/* ---------------- 我的 ---------------- */

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
            <span class="ic">☺</span>
            <span class="tx">
              <span class="t">登录</span>
              <span class="s">
                教务 {props.jwtText} · 门户 {props.portalText}
              </span>
            </span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onLibraryLogin}>
            <span class="ic">▤</span>
            <span class="tx">
              <span class="t">图书馆登录</span>
              <span class="s">另一套账号（学号 + 图书馆密码）</span>
            </span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onRenew} disabled={props.renewBusy}>
            <span class="ic">⟳</span>
            <span class="tx">
              <span class="t">立即续期</span>
              <span class="s">{props.renewBusy ? '续期中…' : `教务 ${props.jwtText} · 验一次登录换新票`}</span>
            </span>
            <span class="chev">›</span>
          </button>
        </div>

        <div class="mine-card">
          <button class="mine-row" onClick={() => props.onToggleClass(!props.notifyClass)}>
            <span class="ic">◕</span>
            <span class="tx">
              <span class="t">课前提醒</span>
              <span class="s">每节课开课前 30 分钟各弹一条</span>
            </span>
            <span class={`sw${props.notifyClass ? ' on' : ''}`} />
          </button>
          <button class="mine-row" onClick={() => props.onToggleNews(!props.notifyNews)}>
            <span class="ic">◑</span>
            <span class="tx">
              <span class="t">资讯通知</span>
              <span class="s">有新通知时提醒一次</span>
            </span>
            <span class={`sw${props.notifyNews ? ' on' : ''}`} />
          </button>
        </div>

        <div class="mine-card">
          <button class="mine-row" onClick={props.onTheme}>
            <span class="ic">◐</span>
            <span class="tx">
              <span class="t">外观</span>
              <span class="s">米白 / 藏青 / 蓝绿</span>
            </span>
            <span class="val">{props.themeLabel}</span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onSettings}>
            <span class="ic">⚙</span>
            <span class="tx">
              <span class="t">设置</span>
              <span class="s">服务商与模型、API Key、模型兜底</span>
            </span>
            <span class="chev">›</span>
          </button>
        </div>

        <div class="mine-card">
          <button class="mine-row" onClick={props.onSurvey}>
            <span class="ic">✎</span>
            <span class="tx">
              <span class="t">反馈与问卷</span>
              <span class="s">{props.surveyStatus}</span>
            </span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onCheckUpdate} disabled={props.checking}>
            <span class="ic">⤓</span>
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
                    : `当前 v${props.version} · 点这里手动检查`}
              </span>
            </span>
            <span class="chev">›</span>
          </button>
          <button class="mine-row" onClick={props.onAbout}>
            <span class="ic">ⓘ</span>
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
