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
  CampusNotify?: { pickImages?: (reqId: string, max: number) => void };
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
    // 用户在选图器里翻半天很正常，给足 3 分钟；超时也只是给个提示，不是死等
    const timer = setTimeout(() => {
      delete w.__pickImageWaiters![reqId];
      reject(new Error('选图超时（3 分钟没回）'));
    }, 180_000);
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
