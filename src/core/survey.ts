/**
 * 应用内问卷：什么时候问、问的时候带什么参数。
 *
 * 只在本地记状态（`campus-layer:survey`），不采集任何身份信息：
 * 那串 uid 是本地生成的随机串，只用来去重，不是设备指纹。
 */

import { getKV, type KV } from './kv';

/** 问卷地址（问卷星）。换平台只改这一行。 */
export const SURVEY_URL = 'https://v.wjx.cn/vm/tAvGpZ0.aspx';

export const SURVEY_KEY = 'survey';

/** 用满几天才问：刚装就弹会拿到一堆「还没用就打分」的假样本 */
export const MIN_DAYS = 3;
/** 至少打开过几次 */
export const MIN_LAUNCHES = 5;
/** 点了「稍后」之后，隔多久再问 */
export const COOLDOWN_DAYS = 14;

const DAY = 24 * 60 * 60_000;

export interface SurveyState {
  /** 第一次打开的时间 */
  firstSeenAt: number;
  /** 累计打开次数 */
  launches: number;
  /** 问过哪个版本（一个版本最多问一次） */
  askedVersion?: string;
  /** 最近一次弹的时间（点「稍后」也算） */
  lastAskAt?: number;
  /** 用户自己点过「我填过了」 */
  submittedAt?: number;
  /** 点了「不再问」 */
  optOut?: boolean;
  /** 本地随机串，只为去重 */
  uid: string;
}

export type SurveySource = 'popup' | 'mine';

export interface SurveyContext {
  version: string;
  /** 当前配色 */
  theme: string;
  /** 是不是装在安卓壳里 */
  shell: boolean;
  /** 有没有登录态（只传真假，不传票） */
  login: boolean;
  source: SurveySource;
}

function newUid(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += Math.floor(rand() * 16).toString(16);
  return out;
}

function norm(raw: unknown, now: number): SurveyState {
  const got = (raw ?? {}) as Partial<SurveyState>;
  const launches = typeof got.launches === 'number' && got.launches >= 0 ? Math.floor(got.launches) : 0;
  return {
    firstSeenAt: typeof got.firstSeenAt === 'number' ? got.firstSeenAt : now,
    launches,
    ...(typeof got.askedVersion === 'string' ? { askedVersion: got.askedVersion } : {}),
    ...(typeof got.lastAskAt === 'number' ? { lastAskAt: got.lastAskAt } : {}),
    ...(typeof got.submittedAt === 'number' ? { submittedAt: got.submittedAt } : {}),
    ...(got.optOut === true ? { optOut: true } : {}),
    uid: typeof got.uid === 'string' && /^[0-9a-f]{8}$/.test(got.uid) ? got.uid : newUid(),
  };
}

export async function loadSurvey(kv: KV = getKV(), now: number = Date.now()): Promise<SurveyState> {
  try {
    return norm(await kv.get<SurveyState>(SURVEY_KEY), now);
  } catch {
    return norm(undefined, now);
  }
}

export async function saveSurvey(state: SurveyState, kv: KV = getKV()): Promise<void> {
  try {
    await kv.set(SURVEY_KEY, state);
  } catch {
    /* 存不下就算了，不影响用 */
  }
}

/** 每次打开累加一次；第一次顺手记下时间 */
export function recordLaunch(state: SurveyState, now: number = Date.now()): SurveyState {
  return { ...state, firstSeenAt: state.firstSeenAt || now, launches: state.launches + 1 };
}

/**
 * 该不该弹。四条全满足才弹：
 * 用满 3 天、打开过 5 次、这个版本没问过、距离上次「稍后」超过 14 天。
 */
export function shouldAsk(state: SurveyState, version: string, now: number = Date.now()): boolean {
  if (state.optOut) return false;
  if (state.submittedAt) return false;
  if (state.askedVersion === version) return false;
  if (now - state.firstSeenAt < MIN_DAYS * DAY) return false;
  if (state.launches < MIN_LAUNCHES) return false;
  if (state.lastAskAt && now - state.lastAskAt < COOLDOWN_DAYS * DAY) return false;
  return true;
}

export function markAsked(
  state: SurveyState,
  version: string,
  now: number = Date.now(),
): SurveyState {
  return { ...state, askedVersion: version, lastAskAt: now };
}

export function markSubmitted(state: SurveyState, now: number = Date.now()): SurveyState {
  return { ...state, submittedAt: now, lastAskAt: now };
}

export function markOptOut(state: SurveyState): SurveyState {
  return { ...state, optOut: true };
}

/** 「还没填过」「上次填于 8 月 12 日」这类文案用的 */
export function surveyStatusText(state: SurveyState, now: number = Date.now()): string {
  if (state.submittedAt) {
    const d = new Date(state.submittedAt);
    return `上次填于 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }
  if (state.optOut) return '已设置不再提醒';
  return '30 秒，帮我把这东西做好用一点';
}

/**
 * 拼问卷链接：把版本、配色、是不是壳里、有没有登录态带过去，
 * 免得问卷里再问一遍，也能按来源分桶。
 */
export function surveyUrl(state: SurveyState, ctx: SurveyContext): string {
  const q = new URLSearchParams({
    v: ctx.version,
    theme: ctx.theme,
    shell: ctx.shell ? '1' : '0',
    login: ctx.login ? '1' : '0',
    src: ctx.source,
    uid: state.uid,
  });
  return `${SURVEY_URL}${SURVEY_URL.includes('?') ? '&' : '?'}${q.toString()}`;
}

/** 自己填还是弹窗引导的——只用于展示文案 */
export function surveyEntryHint(state: SurveyState): string {
  if (state.submittedAt) return '谢谢填过，后面想补充随时点';
  return '匿名，只带版本号、配色这类信息；不收登录票、学号、聊天记录';
}
