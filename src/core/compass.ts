/**
 * 指南针的几个纯函数：角度归一化、跨 0° 的平滑、从传感器事件里取朝向。
 *
 * 方位角最烦的是 359° → 0° 的回绕：直接线性插值会从北一路倒转回北，
 * 所以平滑必须走「最短弧」；这里单独抽出来，方便单测。
 */

/** 任意角度 → [0, 360) */
export function normalizeDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return ((deg % 360) + 360) % 360;
}

/**
 * 沿最短弧从 from 往 to 靠 k（0–1）。
 * 例：350° → 10°，k=0.5 → 0°（而不是 180°）。
 */
export function circularLerp(from: number, to: number, k: number): number {
  const a = normalizeDeg(from);
  const b = normalizeDeg(to);
  const diff = ((b - a + 540) % 360) - 180;
  return normalizeDeg(a + diff * Math.min(1, Math.max(0, k)));
}

export interface CompassSample {
  /** iOS 的绝对朝向（0=北，顺时针） */
  webkitCompassHeading?: number;
  /** iOS 的精度（度，负值表示需要校准） */
  webkitCompassAccuracy?: number;
  /** Android 的相对朝向；absolute 为 true 时才是真北 */
  alpha?: number | null;
  absolute?: boolean;
  type?: string;
}

/** 从一次 deviceorientation 事件里取「表盘朝向」；没有可用数据返回 null */
export function headingFromSample(e: CompassSample): number | null {
  const w = e.webkitCompassHeading;
  if (typeof w === 'number' && Number.isFinite(w) && w >= 0) return normalizeDeg(w);
  if (typeof e.alpha !== 'number' || !Number.isFinite(e.alpha)) return null;
  return normalizeDeg(360 - e.alpha);
}

/** 精度分级：good（≤15°）/ fair（≤30°）/ poor（>30° 或负值=要校准） */
export function accuracyLevel(accuracy: number | null | undefined): 'good' | 'fair' | 'poor' | null {
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy)) return null;
  if (accuracy < 0) return 'poor';
  if (accuracy <= 15) return 'good';
  if (accuracy <= 30) return 'fair';
  return 'poor';
}
