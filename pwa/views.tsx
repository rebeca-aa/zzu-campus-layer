import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Course, Term } from '../src/core/types';

export type TabKey = 'home' | 'ai' | 'schedule' | 'mine';

/** 一次工具调用的结果；失败时 ok=false，error 是给人看的一句话 */
export type Caller = (name: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }>;

const TABS: { key: TabKey; label: string }[] = [
  { key: 'home', label: '主页' },
  { key: 'ai', label: 'AI' },
  { key: 'schedule', label: '学期课表' },
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
  return (
    <nav class="tabbar">
      {TABS.map((t) => (
        <button class={t.key === tab ? 'on' : ''} onClick={() => onTab(t.key)} key={t.key}>
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

type TileState = { text: string; tone?: 'ok' | 'warn' };

export function HomeView(props: {
  today: string;
  call: Caller;
  refreshKey: number;
  onOpen: (kind: 'library' | 'rooms' | 'card') => void;
  onSchedule: () => void;
  onNotice: () => void;
  onBell: () => void;
  unread: number;
  onRefresh: () => void;
  busy: boolean;
}) {
  const { today, call, refreshKey } = props;
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [week, setWeek] = useState<number | null>(null);
  const [tiles, setTiles] = useState<Record<string, TileState>>({});
  const [notice, setNotice] = useState<{ title: string; kind: string } | null>(null);
  const [err, setErr] = useState('');
  const [needLogin, setNeedLogin] = useState(false);

  useEffect(() => {
    let alive = true;
    setErr('');
    void (async () => {
      const [sched, lib, rooms, card, news] = await Promise.all([
        call('get_schedule', { day: 'today' }),
        call('library_seats'),
        call('find_free_room', { date: today, limit: 5 }),
        call('get_card'),
        call('find_notices', { limit: 1 }),
      ]);
      if (!alive) return;

      const authFail = [sched, lib, rooms, card, news].some((r) => !r.ok && /登录/.test(r.error ?? ''));
      setNeedLogin(authFail);

      if (sched.ok && sched.data) {
        const payload = (sched.data as any).data ?? sched.data;
        setCourses(Array.isArray(payload?.courses) ? payload.courses : []);
        setWeek(typeof payload?.week === 'number' ? payload.week : null);
      } else {
        setCourses([]);
        setErr(sched.error ?? '');
      }

      const next: Record<string, TileState> = {};
      if (lib.ok) {
        const p = ((lib.data as any)?.data ?? lib.data) as { premises?: { name?: string; free?: number }[] } | undefined;
        const first = p?.premises?.[0];
        next.library = first
          ? { text: `${shortName(first.name) ?? '图书馆'} 剩 ${first.free ?? 0}`, tone: (first.free ?? 0) > 0 ? 'ok' : 'warn' }
          : { text: '查不到余量' };
      } else {
        next.library = { text: '点开看' };
      }
      if (rooms.ok) {
        const n = Number(((rooms.data as any)?.data ?? rooms.data)?.count ?? 0);
        next.rooms = { text: n > 0 ? `${n} 间空着` : '暂时没有' };
      } else {
        next.rooms = { text: '点开看' };
      }
      if (card.ok) {
        const bal = ((card.data as any)?.data ?? card.data)?.balance;
        next.card = { text: bal === undefined ? '看余额' : `¥ ${Number(bal).toFixed(2)}` };
      } else {
        next.card = { text: '看余额' };
      }
      setTiles(next);

      if (news.ok) {
        const list = ((news.data as any)?.data ?? news.data)?.cards as { title?: string; category?: string }[] | undefined;
        const first = Array.isArray(list) ? list[0] : undefined;
        setNotice(first?.title ? { title: first.title, kind: kindLabel(first.category) } : null);
      } else {
        setNotice(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey, today]);

  const nowMin = minutesOf(`${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`);
  const list = courses ?? [];
  const next = list.find((c) => minutesOf(c.endTime) > nowMin);

  return (
    <>
      <header class="top">
        <div class="who">
          <div class="date">
            {props.today.replace(/-/g, ' / ')}
            {week ? ` · 第 ${week} 周` : ''}
          </div>
          <h1>今天</h1>
        </div>
        <div class="acts">
          <button class="iconbtn" onClick={props.onBell} aria-label="通知">
            {props.unread > 0 && <span class="dot">{props.unread > 99 ? '99+' : props.unread}</span>}
            <BellIcon />
          </button>
          <button class="iconbtn" onClick={props.onRefresh} aria-label="刷新" disabled={props.busy}>
            <RefreshIcon />
          </button>
        </div>
      </header>

      <main class="tabbody">
        <section class="card">
          <div class="cardhead">
            <strong>今日课表</strong>
            <span>
              {needLogin ? '' : list.length ? `${list.length} 节 · ${new Set(list.map((c) => c.name)).size} 门` : '没有课'}
            </span>
          </div>
          {needLogin ? (
            <p class="empty-line">还没登录：去「我的 → 账号」登录一次，这里会显示今天的课。</p>
          ) : (
            <>
              {err && <p class="empty-line">{err}</p>}
              {!err && list.length === 0 && <p class="empty-line">今天没有课，好好休息。</p>}
            </>
          )}
          <div class="lessons">
            {list.map((c) => {
              const done = minutesOf(c.endTime) <= nowMin;
              const live = !done && minutesOf(c.startTime) <= nowMin;
              return (
                <div class={`lesson${done ? ' done' : ''}${live ? ' now' : ''}`} key={c.key}>
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
              {needLogin ? '' : next ? `下一节 ${next.startTime} ${shortName(next.name)}` : '今天的课都上完了'}
            </span>
            <button class="link" onClick={props.onSchedule}>
              学期课表 ›
            </button>
          </div>
        </section>

        <div class="tiles">
          <button class="tile" onClick={() => props.onOpen('library')}>
            <span class="sq" />
            <div class="t">图书馆</div>
            <div class={`s ${tiles.library?.tone ?? ''}`}>
              {needLogin ? '登录后看' : tiles.library?.text ?? '…'}
            </div>
          </button>
          <button class="tile" onClick={() => props.onOpen('rooms')}>
            <span class="sq" />
            <div class="t">空教室</div>
            <div class={`s ${tiles.rooms?.tone ?? ''}`}>{needLogin ? '登录后看' : tiles.rooms?.text ?? '…'}</div>
          </button>
          <button class="tile" onClick={() => props.onOpen('card')}>
            <span class="sq" />
            <div class="t">校园卡</div>
            <div class="s">{needLogin ? '登录后看' : tiles.card?.text ?? '…'}</div>
          </button>
        </div>

        <button class={`notice-line${notice ? '' : ' empty'}`} onClick={props.onNotice}>
          <span class="kind">{notice ? notice.kind : '通知'}</span>
          <span class="nt">{notice ? notice.title : '暂无新通知'}</span>
          <span class="more">›</span>
        </button>
      </main>
    </>
  );
}

function shortName(name?: string): string {
  if (!name) return '';
  return name.replace(/^主校区/, '').replace(/图书馆$/, '') || name;
}

function kindLabel(cat?: string): string {
  switch (cat) {
    case 'lecture':
      return '讲座';
    case 'competition':
      return '比赛';
    case 'activity':
      return '活动';
    case 'meeting':
      return '会议';
    case 'academic':
      return '教务';
    case 'life':
      return '生活';
    default:
      return '通知';
  }
}

/* ---------------- 学期课表 ---------------- */

const PERIOD_START = ['08:00', '08:55', '10:10', '11:05', '14:00', '14:55', '16:00', '16:55', '19:00', '19:55', '20:50', '21:45'];
const PERIOD_END = ['08:45', '09:40', '10:55', '11:50', '14:45', '15:40', '16:45', '17:40', '19:45', '20:40', '21:35', '22:30'];
const COLORS = ['#6a2f6d', '#255f63', '#4b3a7a', '#4f5c22', '#5a4632', '#6b3a2c', '#62501f', '#2f4a6b', '#7a3550', '#2d6355'];

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

/** 同一屏里两门课不撞色：先按名字取下标，撞了就往后面顺延到空位 */
function assignColors(list: Course[]): Record<string, string> {
  const used = new Set<number>();
  const map: Record<string, string> = {};
  for (const c of list) {
    if (map[c.name]) continue;
    const base = COLORS.indexOf(colorOf(c.name));
    let picked = base < 0 ? 0 : base;
    for (let k = 0; k < COLORS.length; k += 1) {
      const idx = (picked + k) % COLORS.length;
      if (!used.has(idx)) {
        picked = idx;
        break;
      }
    }
    used.add(picked);
    map[c.name] = COLORS[picked]!;
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
}) {
  const { call, term, today } = props;
  const [week, setWeek] = useState<number>(() => term?.currentWeek ?? 1);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const colorMap = useMemo(() => assignColors(courses), [courses]);

  useEffect(() => {
    if (term?.currentWeek) setWeek(term.currentWeek);
  }, [term?.currentWeek]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    void (async () => {
      const res = await call('get_schedule', { week });
      if (!alive) return;
      if (res.ok) {
        const payload = (res.data as any)?.data ?? res.data;
        setCourses(Array.isArray(payload?.courses) ? payload.courses : []);
      } else {
        setCourses([]);
        setErr(res.error ?? '课表没读出来');
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [week, props.refreshKey]);

  const weeks = term?.weeks?.length ? term.weeks : Array.from({ length: 19 }, (_, i) => i + 1);
  const maxWeek = Math.max(...weeks, 1);
  const minWeek = Math.min(...weeks, 1);

  const monday = mondayOf(today, week - (term?.currentWeek ?? week));
  const dayDates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const todayIdx = dayDates.indexOf(today);

  return (
    <>
      <header class="top">
        <div class="who">
          <div class="termline">
            {termLabel(term)}
            <span class="caret">▾</span>
          </div>
        </div>
      </header>
      <main class="tabbody">
        <div class="weekbar">
          <button onClick={() => setWeek((w) => Math.max(minWeek, w - 1))} disabled={week <= minWeek}>
            ‹
          </button>
          <span>
            <b>第 {week} 周</b> / 共 {maxWeek} 周
          </span>
          <button onClick={() => setWeek((w) => Math.min(maxWeek, w + 1))} disabled={week >= maxWeek}>
            ›
          </button>
        </div>

        {err && <p class="empty-line">{err}</p>}

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
                style={`grid-column:${c.weekday + 1};grid-row:${row + 1} / span ${span};background:${colorMap[c.name] ?? colorOf(c.name)}`}
                title={`${c.name} ${c.location ?? ''}`}
              >
                {c.name.startsWith('实验') && <span class="tag">实验</span>}
                <div class="n">{c.name}</div>
                <div class="r">{[c.location].filter(Boolean).join(' ')}</div>
              </div>
            );
          })}
        </div>
        {loading && <p class="empty-line">读课表中…</p>}
        {!loading && !err && courses.length === 0 && <p class="empty-line">这周没有课。</p>}
      </main>
    </>
  );
}

/* ---------------- 我的 ---------------- */

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
  renewBusy: boolean;
}) {
  return (
    <>
      <header class="top">
        <div class="who">
          <h1>我的</h1>
        </div>
      </header>
      <main class="tabbody">
        <div class="mine-card">
          <button class="mine-row" onClick={props.onLogin}>
            <span class="ic">☺</span>
            <span class="tx">
              <span class="t">账号</span>
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
