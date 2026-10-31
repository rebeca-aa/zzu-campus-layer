import type { Course } from './types';
import { addDays, todayShanghai, weekdayOf } from './util';

/** 一条课前提醒（at 是绝对毫秒时间戳，由壳侧按这个时间点弹通知）。 */
export interface ReminderBlock {
  at: number;
  title: string;
  body: string;
}

/** 提前多少分钟提醒：每节课开课前 30 分钟各弹一条。 */
export const LEAD_MIN = 30;

/**
 * 默认往后排多少天。
 *
 * 原来是 7 天：只要有一周没打开 App，后面就再也没有闹钟了——这正是「有时候不通知」
 * 的主要原因之一。排 14 天，间隔一周再打开也接得上；闹钟条数最多也就几十个，
 * Android 那边（AlarmManager）完全吃得下。
 */
export const REMIND_DAYS = 14;

/** 已经进了 30 分钟窗口但课还没开始时，多久后补弹（秒级，别等下一轮）。 */
const CATCH_UP_MS = 5_000;

function hhmmToMin(v: string): number {
  const [h, m] = v.split(':');
  return Number(h) * 60 + Number(m);
}

/** 上海时区某天某时刻的绝对时间戳。 */
function at(date: string, hhmm: string): number {
  return new Date(`${date}T${hhmm}:00+08:00`).getTime();
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00+08:00`).getTime() - new Date(`${a}T00:00:00+08:00`).getTime()) / 86400000);
}

/** 同一节课在不在这一周（courses 里的 weeks 是教学周集合，空表示每周都有）。 */
function inWeek(course: Course, weekIndex: number): boolean {
  const weeks = course.weeks ?? [];
  return weeks.length === 0 || weeks.includes(weekIndex);
}

/** 通知标题：一节课一条，标题直接说是哪门课。remainMs 是「离上课还有多久」。 */
function titleOf(course: Course, remainMs: number): string {
  const min = Math.max(1, Math.round(remainMs / 60_000));
  /* 正常提前量（≥25 分钟）就说「半小时后」，晚开 App 补的那条要说实话 */
  if (min >= LEAD_MIN - 5) return `半小时后：${course.name}`;
  return `${min} 分钟后：${course.name}`;
}

/** 通知正文：时间段 + 第几节 + 地点 + 老师。 */
function bodyOf(course: Course): string {
  const span = `${course.startTime}-${course.endTime}`;
  const sections =
    course.sectionStart && course.sectionEnd ? `第${course.sectionStart}-${course.sectionEnd}节 ` : '';
  const where = course.location ? ` @${course.location}` : '';
  const teachers = course.teachers?.length ? ` · ${course.teachers.join('、')}` : '';
  return `${span} ${sections}${where}${teachers}`.replace(/\s+/g, ' ').trim();
}

/**
 * 把未来若干天的课排成提醒块。
 *
 * 规则（用户要求，2026-10 改）：**一节课一条，开课前 30 分钟弹，不做任何合并**。
 * 之前是把「同一半天、空档 ≤40 分钟的连堂课」并成一条 —— 上午满课时整上午只在
 * 第一节前弹一次，第二节课就没有提醒了；现在每节课各自独立。
 *
 * 已经开课的课不排（避免一开 App 就糊一脸旧通知）；但**还没开课、却已经进了 30 分钟
 * 窗口**的课（晚开 App 的典型情况）会补一条「N 分钟后：xxx」，不会白白丢掉。
 */
export function buildReminderBlocks(
  courses: Course[],
  opts: { now?: Date; days?: number; termStart?: string } = {},
): ReminderBlock[] {
  const now = opts.now ?? new Date();
  const days = opts.days ?? REMIND_DAYS;
  const termStart = opts.termStart;
  const nowMs = now.getTime();
  const today = todayShanghai(nowMs);
  const out: ReminderBlock[] = [];
  /* 门户给「事件」、教务给「模板」，同一节课可能两边都有；按 日期+时间+课名 去重 */
  const seen = new Set<string>();

  for (let i = 0; i < days; i += 1) {
    const date = addDays(today, i);
    const weekday = weekdayOf(date);
    const weekIndex = termStart ? Math.floor(daysBetween(termStart, date) / 7) + 1 : 0;

    const list = courses
      .filter((c) => c.weekday === weekday)
      .filter((c) => (weekIndex > 0 ? inWeek(c, weekIndex) : true))
      .sort((a, b) => hhmmToMin(a.startTime) - hhmmToMin(b.startTime));

    for (const course of list) {
      const startMs = at(date, course.startTime);
      if (startMs <= nowMs) continue; // 已经开课了，不补弹
      const leadMs = startMs - LEAD_MIN * 60_000;
      /* 正常情况按「开课前 30 分钟」；已经进了这个窗口（晚开 App）就立刻补一条 */
      const fireMs = leadMs > nowMs ? leadMs : nowMs + CATCH_UP_MS;

      const key = `${date}|${course.startTime}|${course.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ at: fireMs, title: titleOf(course, startMs - fireMs), body: bodyOf(course) });
    }
  }

  return out.sort((a, b) => a.at - b.at);
}

declare global {
  interface Window {
    CampusNotify?: { setReminders(json: string): void };
  }
}

/** 有壳就交给壳去定时，没有就当没发生（网页版没有通知能力）。 */
export function pushReminders(blocks: ReminderBlock[]): boolean {
  const bridge = typeof window === 'undefined' ? undefined : window.CampusNotify;
  if (!bridge || typeof bridge.setReminders !== 'function') return false;
  bridge.setReminders(JSON.stringify(blocks));
  return true;
}
