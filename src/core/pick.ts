/**
 * 原生选图（只在安卓壳里可用）。
 *
 * 壳里走 CampusNotify.pickImages(reqId, max) → 系统选图器 → 壳自己读图、压成 JPEG、
 * 调 window.__pickImages(reqId, {"ok":true,"urls":[...]}) 交回来。
 *
 * 为什么要绕开 <input type="file">：WebView 的选图回调在鸿蒙 / 部分 EMUI 上能弹出选图器，
 * 回来的 content:// URI 却读不出内容，页面侧只看到 change 事件里没有文件——表现就是
 * 「点了读图，选完什么也没发生」。壳自己读就没这个环节。
 *
 * 浏览器里没有这个桥，返回 null，调用方退回原来的 <input type="file">。
 */

export interface PickBridgeWindow {
  CampusNotify?: {
    pickImages?: (reqId: string, max: number) => void;
    shellInfo?: () => string;
  };
  __pickImages?: (reqId: string, payload: string) => void;
  __pickImageWaiters?: Record<string, (payload: string) => void>;
}

function pickWindow(win?: PickBridgeWindow): PickBridgeWindow | undefined {
  if (win) return win;
  if (typeof window === 'undefined') return undefined;
  return window as unknown as PickBridgeWindow;
}

/** 这台环境能不能用原生选图（壳里能，浏览器不能）。 */
export function canPickNatively(win?: PickBridgeWindow): boolean {
  const w = pickWindow(win);
  return !!w?.CampusNotify && typeof w.CampusNotify.pickImages === 'function';
}

/** 是不是在壳里（哪怕壳太旧、没有原生选图桥）。 */
export function inShell(win?: PickBridgeWindow): boolean {
  return !!pickWindow(win)?.CampusNotify;
}

/** 壳的版本号（读不到就是空串）。只用来把话说清楚，不参与任何判断逻辑。 */
export function shellVersionName(win?: PickBridgeWindow): string {
  const bridge = pickWindow(win)?.CampusNotify;
  if (!bridge || typeof bridge.shellInfo !== 'function') return '';
  try {
    const raw = bridge.shellInfo();
    if (!raw) return '';
    const info = JSON.parse(raw) as { versionName?: unknown };
    return typeof info.versionName === 'string' ? info.versionName : '';
  } catch {
    return '';
  }
}

/**
 * 弹原生选图器，返回图片的 data URL 列表。
 * - 没有原生桥 → 返回 null（调用方走 <input type="file">）
 * - 用户取消 → resolve([])
 * - 壳里读不出来 → reject（带中文原因）
 */
export function pickImagesNative(max = 4, win?: PickBridgeWindow): Promise<string[]> | null {
  const w = pickWindow(win);
  const bridge = w?.CampusNotify;
  if (!w || !bridge || typeof bridge.pickImages !== 'function') return null;

  const reqId = 'img' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
  w.__pickImageWaiters = w.__pickImageWaiters ?? {};
  w.__pickImages = (id: string, payload: string) => {
    const fn = w.__pickImageWaiters?.[id];
    if (fn) {
      delete w.__pickImageWaiters![id];
      fn(payload);
    }
  };

  return new Promise<string[]>((resolve, reject) => {
    // 选图 + 读图 + 压图都在壳里做，正常几秒就回来。给 45 秒：既不催人，也别让页面
    // 永远停在「读图中」（那看起来跟「没反应」一模一样）。
    const timer = setTimeout(() => {
      delete w.__pickImageWaiters![reqId];
      reject(
        new Error(
          '壳没把图送回来（45 秒）：可能这个壳版本还没有原生选图，也可能读图失败了。去「我的 → 检查更新」把壳升到最新再试',
        ),
      );
    }, 45_000);
    w.__pickImageWaiters![reqId] = (payload: string) => {
      clearTimeout(timer);
      try {
        const box = JSON.parse(payload) as { ok?: boolean; urls?: string[]; error?: string };
        if (!box?.ok) {
          reject(new Error(box?.error || '没读到图片'));
          return;
        }
        const urls = Array.isArray(box.urls) ? box.urls : [];
        resolve(urls.filter((u) => typeof u === 'string' && u.startsWith('data:image/')));
      } catch {
        reject(new Error('选图结果看不懂（壳和网页版本可能对不上）'));
      }
    };
    bridge.pickImages!(reqId, max);
  });
}
