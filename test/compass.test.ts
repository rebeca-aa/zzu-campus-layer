import { describe, expect, it } from 'vitest';
import { accuracyLevel, circularLerp, headingFromSample, normalizeDeg } from '../src/core/compass';

describe('normalizeDeg', () => {
  it('把任意角度收进 [0, 360)', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(370)).toBe(10);
    expect(normalizeDeg(-10)).toBe(350);
    expect(normalizeDeg(720)).toBe(0);
    expect(normalizeDeg(Number.NaN)).toBe(0);
  });
});

describe('circularLerp', () => {
  it('沿最短弧走，不会从 350 倒回 0 再绕一圈', () => {
    expect(circularLerp(350, 10, 0.5)).toBeCloseTo(0, 5);
    expect(circularLerp(10, 350, 0.5)).toBeCloseTo(0, 5);
  });

  it('普通情况下就是线性插值', () => {
    expect(circularLerp(0, 90, 0.5)).toBeCloseTo(45, 5);
    expect(circularLerp(100, 100, 0.3)).toBeCloseTo(100, 5);
  });

  it('k 会被夹到 0–1', () => {
    expect(circularLerp(0, 90, 5)).toBeCloseTo(90, 5);
    expect(circularLerp(0, 90, -1)).toBeCloseTo(0, 5);
  });
});

describe('headingFromSample', () => {
  it('iOS 优先用 webkitCompassHeading', () => {
    expect(headingFromSample({ webkitCompassHeading: 45, alpha: 300 })).toBe(45);
  });

  it('Android 用 alpha 反推（0=北，顺时针）', () => {
    expect(headingFromSample({ alpha: 90 })).toBe(270);
    expect(headingFromSample({ alpha: 0 })).toBe(0);
  });

  it('没有可用数据就返回 null', () => {
    expect(headingFromSample({})).toBeNull();
    expect(headingFromSample({ alpha: null })).toBeNull();
    expect(headingFromSample({ webkitCompassHeading: Number.NaN })).toBeNull();
  });
});

describe('accuracyLevel', () => {
  it('按误差分级，负值表示要校准', () => {
    expect(accuracyLevel(5)).toBe('good');
    expect(accuracyLevel(20)).toBe('fair');
    expect(accuracyLevel(45)).toBe('poor');
    expect(accuracyLevel(-1)).toBe('poor');
    expect(accuracyLevel(undefined)).toBeNull();
  });
});
