/**
 * 图书馆座位图页：主页那条「图书馆」点进来就是这里。
 *
 * 上面切今天 / 明天，下面切一楼到四楼；每一层把它能预约的几个区域列成小卡，
 * 点哪一间就把那一间的座位平面图铺出来（图是 src/core/library.ts 按服务端给的坐标画的）。
 *
 * 取数走 readLibrarySeats：
 * - 安卓壳里由原生代取（带图书馆登录态，没登录时壳自己会先弹登录页，登录完接着答）；
 * - 浏览器里没有这条通道，会拿到一句「去 我的 → 图书馆登录」的提示，页面照实显示。
 * 浏览器没有空间给登录页，所以别想着在这里登录；页面只管「读」。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { FLOOR_AREA_ALTS, areaNameOf, seatMapDataUri, type LibSeatMap } from '../src/core/library';
import { readLibrarySeats } from '../src/core/libtab';
import { addDays, todayShanghai, weekdayOf } from '../src/core/util';

const FLOORS = ['一楼', '二楼', '三楼', '四楼'] as const;
type Floor = (typeof FLOORS)[number];
type DayKey = 'today' | 'tomorrow';

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 11月16日 周日 */
function dayLabel(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${Number(m[1])}月${Number(m[2])}日 ${WD[weekdayOf(date) % 7] ?? ''}`;
}

type Cell = { state: 'loading' | 'ok' | 'err'; map?: LibSeatMap; error?: string };

/** 读过的图按「日期 + 区域」留着：来回切楼层、切回来都不用再走一遍原生 */
const seatCache = new Map<string, LibSeatMap>();

/** 没登录 / 被别的设备顶掉：再一间一间地读只会把登录页弹一串，先停下 */
const loginish = (msg?: string): boolean => /登录|10001|顶掉/.test(msg ?? '');

interface LibBridge {
  loginLibrary?: () => void;
}

export function SeatMapView({ onBack }: { onBack: () => void }) {
  /* 跨天还开着页面：每次渲染都重算，日期一变下面的 effect 自己重读 */
  const today = todayShanghai();
  const dates: Array<{ key: DayKey; date: string; label: string }> = [
    { key: 'today', date: today, label: '今天' },
    { key: 'tomorrow', date: addDays(today, 1), label: '明天' },
  ];

  const [day, setDay] = useState<DayKey>('today');
  const [floor, setFloor] = useState<Floor>('一楼');
  const [tick, setTick] = useState(0);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [pick, setPick] = useState('');

  const date = day === 'today' ? today : addDays(today, 1);
  const ids = FLOOR_AREA_ALTS[floor] ?? [];
  const busy = ids.some((id) => cells[id]?.state === 'loading');

  /* 今天 / 楼层换了才清空重来；手动刷新（tick）保留已经画出来的，只补读 */
  const scope = `${date}|${floor}`;
  const lastScope = useRef('');
  useEffect(() => {
    const moved = lastScope.current !== scope;
    lastScope.current = scope;
    if (moved) {
      setCells({});
      setPick(ids[0] ?? '');
    }
    let alive = true;
    void (async () => {
      const put = (id: string, cell: Cell) => {
        if (alive) setCells((cur) => ({ ...cur, [id]: cell }));
      };
      for (const id of ids) {
        if (!alive) return;
        const hit = seatCache.get(`${date}|${id}`);
        if (hit) {
          put(id, { state: 'ok', map: hit });
          continue;
        }
        put(id, { state: 'loading' });
        let res: Awaited<ReturnType<typeof readLibrarySeats>>;
        try {
          res = await readLibrarySeats({ areaId: id, date });
        } catch (e) {
          put(id, { state: 'err', error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        if (!alive) return;
        if (!res.ok) {
          put(id, { state: 'err', error: res.error ?? '读不到这一间' });
          if (loginish(res.error)) {
            for (const rest of ids) put(rest, { state: 'err', error: '先登录图书馆，再点右上角刷新' });
            return;
          }
          continue;
        }
        const data = res.data;
        if (!data || data.seats.length === 0) {
          put(id, { state: 'err', error: '这一间当天没开放' });
          continue;
        }
        seatCache.set(`${date}|${id}`, data);
        put(id, { state: 'ok', map: data });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, tick]);

  /* 刷新：把这一层这一天的缓存丢掉，再读一遍 */
  const refresh = () => {
    for (const id of ids) seatCache.delete(`${date}|${id}`);
    setTick((n) => n + 1);
  };

  const current = pick ? cells[pick] : undefined;
  const map = current?.state === 'ok' ? current.map : undefined;
  /* 560 宽：手机上按屏宽铺满时座位号还能看清；再宽字就糊成一条线了 */
  const img = map ? seatMapDataUri(map, { width: 560 }) : '';
  const areaName = areaNameOf(pick) ?? map?.areaName ?? '';
  const free = map ? map.seats.filter((s) => s.free).length : 0;
  const total = map ? map.seats.length : 0;
  const bridge = (window as unknown as { CampusNotify?: LibBridge }).CampusNotify;
  const canLogin = typeof bridge?.loginLibrary === 'function';

  return (
    <>
      <header class="top">
        <div class="who">
          <div class="termline">
            <button class="back" onClick={onBack} aria-label="回主页">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.5 5.5-6.5 6.5 6.5 6.5" /></svg>
            </button>
            图书馆座位
          </div>
          <div class="sub">
            {dayLabel(date)} · {floor}
            {map ? ` · 空 ${free} / 共 ${total}` : ''}
          </div>
        </div>
        <div class="acts">
          <button
            class={`iconbtn${busy ? ' spin' : ''}`}
            aria-label="重新读座位图"
            disabled={busy}
            onClick={refresh}
          >
            <RefreshIcon />
          </button>
        </div>
      </header>

      <main class="tabbody">
        <div class="seat-day">
          {dates.map((d) => (
            <button
              type="button"
              class={d.key === day ? 'on' : ''}
              onClick={() => setDay(d.key)}
              key={d.key}
            >
              <b>{d.label}</b>
              <span>{dayLabel(d.date)}</span>
            </button>
          ))}
        </div>

        <div class="seat-floors">
          {FLOORS.map((f) => (
            <button type="button" class={f === floor ? 'on' : ''} onClick={() => setFloor(f)} key={f}>
              {f}
            </button>
          ))}
        </div>

        <div class={`seat-areas${ids.length === 1 ? ' solo' : ''}`}>
          {ids.map((id) => {
            const cell = cells[id];
            let line = '待读';
            if (cell?.state === 'loading') line = '读取中…';
            else if (cell?.state === 'ok' && cell.map) {
              const n = cell.map.seats.filter((s) => s.free).length;
              line = `空 ${n} / ${cell.map.seats.length}`;
            } else if (cell?.state === 'err') line = '没开放';
            return (
              <button
                type="button"
                class={`seat-area${id === pick ? ' on' : ''}`}
                onClick={() => setPick(id)}
                key={id}
              >
                <span class="sa-n">{areaNameOf(id) ?? `区域 ${id}`}</span>
                <span class="sa-c">{line}</span>
              </button>
            );
          })}
        </div>

        {ids.length === 0 && <p class="empty-line">这一层暂时没有可预约的区域。</p>}

        {current?.state === 'loading' && <p class="empty-line">正在读{areaName}的座位…</p>}

        {current?.state === 'err' && (
          <section class="seat-fail">
            <p>{current.error}</p>
            <div class="seat-fail-acts">
              {canLogin && (
                <button
                  class="primary"
                  onClick={() => {
                    bridge?.loginLibrary?.();
                  }}
                >
                  登录图书馆
                </button>
              )}
              <button class="ghost" onClick={refresh}>
                重试
              </button>
            </div>
          </section>
        )}

        {map && (
          <section class="seat-card">
            <div class="seat-cap">
              <b>{areaName}</b>
              <span>空 {free} / 共 {total}</span>
            </div>
            {img ? (
              <img class="seat-img" src={img} alt={`${areaName} ${dayLabel(date)}座位图`} />
            ) : (
              /* 服务端没给坐标（或座位太少）就退回座位号方格 */
              <div class="seat-nos">
                {map.seats.map((s) => (
                  <span class={`sn${s.free ? ' free' : ''}`} key={s.no}>
                    {s.no}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        <p class="seat-note">
          图上绿点是空位、灰点已占；座位号只是显示，点不了。要订座回 AI 说一句（例如「订一楼 001」）。
        </p>
      </main>
    </>
  );
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}
