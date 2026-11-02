import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_DAYS,
  MIN_DAYS,
  MIN_LAUNCHES,
  SURVEY_URL,
  markAsked,
  markOptOut,
  markSubmitted,
  recordLaunch,
  shouldAsk,
  surveyStatusText,
  surveyUrl,
  type SurveyState,
} from '../src/core/survey';

const NOW = new Date('2026-11-02T12:00:00+08:00').getTime();
const DAY = 24 * 60 * 60_000;

function state(patch: Partial<SurveyState> = {}): SurveyState {
  return { firstSeenAt: NOW - 10 * DAY, launches: 10, uid: 'ab12cd34', ...patch };
}

describe('recordLaunch', () => {
  it('第一次打开时记下时间，并开始计数', () => {
    const s = recordLaunch({ firstSeenAt: 0, launches: 0, uid: 'ab12cd34' }, NOW);
    expect(s.firstSeenAt).toBe(NOW);
    expect(s.launches).toBe(1);
  });

  it('之后的打开只加次数，不改首次时间', () => {
    const s = recordLaunch({ firstSeenAt: NOW - DAY, launches: 4, uid: 'ab12cd34' }, NOW);
    expect(s.firstSeenAt).toBe(NOW - DAY);
    expect(s.launches).toBe(5);
  });
});

describe('shouldAsk', () => {
  it('用满 3 天、开了 5 次就会问', () => {
    expect(shouldAsk(state(), '0.2.89', NOW)).toBe(true);
  });

  it('天数不够不问', () => {
    expect(shouldAsk(state({ firstSeenAt: NOW - (MIN_DAYS - 1) * DAY }), '0.2.89', NOW)).toBe(false);
  });

  it('打开次数不够不问', () => {
    expect(shouldAsk(state({ launches: MIN_LAUNCHES - 1 }), '0.2.89', NOW)).toBe(false);
  });

  it('同一个版本问过就不再问；换版本也要等冷却期过了才再问', () => {
    const asked = markAsked(state(), '0.2.89', NOW);
    expect(shouldAsk(asked, '0.2.89', NOW)).toBe(false);
    /* 冷却期内就算发了新版本也不立刻再问 */
    expect(shouldAsk(asked, '0.2.90', NOW + 2 * DAY)).toBe(false);
    expect(shouldAsk(asked, '0.2.90', NOW + (COOLDOWN_DAYS + 1) * DAY)).toBe(true);
  });

  it('点过「稍后」之后 14 天内不问，过了再问', () => {
    const later = markAsked(state(), '0.2.80', NOW);
    expect(shouldAsk(later, '0.2.89', NOW + (COOLDOWN_DAYS - 1) * DAY)).toBe(false);
    expect(shouldAsk(later, '0.2.89', NOW + (COOLDOWN_DAYS + 1) * DAY)).toBe(true);
  });

  it('填过的不再问，点了「不再问」的永远不问', () => {
    expect(shouldAsk(markSubmitted(state(), NOW), '0.3.0', NOW + 365 * DAY)).toBe(false);
    expect(shouldAsk(markOptOut(state()), '0.3.0', NOW + 365 * DAY)).toBe(false);
  });

  it('脏数据也不会把条件判反', () => {
    const dirty = { firstSeenAt: Number.NaN, launches: -3, uid: 'x' } as unknown as SurveyState;
    expect(shouldAsk(dirty, '0.2.89', NOW)).toBe(false);
  });
});

describe('surveyUrl', () => {
  it('把版本、配色、壳、登录态、来源、uid 都带上', () => {
    const url = surveyUrl(state(), {
      version: '0.2.89',
      theme: 'ink',
      shell: true,
      login: false,
      source: 'popup',
    });
    expect(url.startsWith(SURVEY_URL)).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('v')).toBe('0.2.89');
    expect(q.get('theme')).toBe('ink');
    expect(q.get('shell')).toBe('1');
    expect(q.get('login')).toBe('0');
    expect(q.get('src')).toBe('popup');
    expect(q.get('uid')).toBe('ab12cd34');
  });

  it('地址里本来就带 ? 时不重复加问号', () => {
    const url = surveyUrl(state(), {
      version: '0.2.89',
      theme: 'cream',
      shell: false,
      login: true,
      source: 'mine',
    });
    expect(url.match(/\?/g)?.length).toBe(1);
  });
});

describe('surveyStatusText', () => {
  it('没填过时是那句 30 秒', () => {
    expect(surveyStatusText(state(), NOW)).toContain('30 秒');
  });

  it('填过之后显示日期', () => {
    const s = markSubmitted(state(), new Date('2026-08-12T10:00:00+08:00').getTime());
    expect(surveyStatusText(s, NOW)).toBe('上次填于 8 月 12 日');
  });

  it('选了不再提醒就直说', () => {
    expect(surveyStatusText(markOptOut(state()), NOW)).toBe('已设置不再提醒');
  });
});
