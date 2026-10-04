// 自动生成：源文件在 src/lib/，改那边再跑 npm run sync:core，不要直接改这里。
// 重复规则：存成 RRULE 兼容字符串，只支持常用的几种，按机构时区（types.ts 的 TZ）的本地时间展开。
//   null                                  一次性
//   FREQ=DAILY                            每天
//   FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR      每周几（每个工作日就是这个）
//   FREQ=MONTHLY                          每月同一天
import { fromZonedTime, toZonedTime } from 'npm:date-fns-tz@3.2.0';
import { TZ } from './types.ts';
import { isMakeupWorkday, isOffDay } from './holidays.ts';

export type RepeatPreset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  byday: number[]; // 0 = Sunday … 6 = Saturday（仅 WEEKLY）
}

export function parseRule(rrule: string | null): ParsedRule | null {
  if (!rrule) return null;
  const parts = Object.fromEntries(
    rrule
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [k, v] = p.split('=');
        return [k.toUpperCase(), (v ?? '').toUpperCase()];
      }),
  ) as Record<string, string>;
  const freq = parts.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;
  const byday = (parts.BYDAY ?? '')
    .split(',')
    .map((c) => DAY_CODES.indexOf(c as (typeof DAY_CODES)[number]))
    .filter((i) => i >= 0);
  return { freq, byday };
}

export function buildRule(freq: ParsedRule['freq'], byday: number[] = []): string {
  if (freq === 'WEEKLY' && byday.length) {
    return `FREQ=WEEKLY;BYDAY=${byday.map((d) => DAY_CODES[d]).join(',')}`;
  }
  return `FREQ=${freq}`;
}

export function presetToRule(preset: RepeatPreset, dueLocal: Date, customDays: number[]): string | null {
  switch (preset) {
    case 'none':
      return null;
    case 'daily':
      return buildRule('DAILY');
    case 'weekdays':
      return buildRule('WEEKLY', [1, 2, 3, 4, 5]);
    case 'weekly':
      return buildRule('WEEKLY', [dueLocal.getDay()]);
    case 'monthly':
      return buildRule('MONTHLY');
    case 'custom':
      return customDays.length ? buildRule('WEEKLY', [...customDays].sort()) : buildRule('DAILY');
  }
}

export function ruleToPreset(rrule: string | null, dueLocal: Date): { preset: RepeatPreset; days: number[] } {
  const r = parseRule(rrule);
  if (!r) return { preset: 'none', days: [] };
  if (r.freq === 'DAILY') return { preset: 'daily', days: [] };
  if (r.freq === 'MONTHLY') return { preset: 'monthly', days: [] };
  const days = r.byday.length ? r.byday : [dueLocal.getDay()];
  const isWeekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
  if (isWeekdays) return { preset: 'weekdays', days };
  if (days.length === 1 && days[0] === dueLocal.getDay()) return { preset: 'weekly', days };
  return { preset: 'custom', days };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 把「机构时区本地的年月日 + 时分」转成 UTC Date */
export function localToUtc(y: number, m: number, d: number, hh: number, mm: number): Date {
  return fromZonedTime(new Date(y, m - 1, d, hh, mm, 0, 0), TZ);
}

/** 机构时区本地的日历日 YYYY-MM-DD */
export function localYmd(date: Date): string {
  const z = toZonedTime(date, TZ);
  return `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}`;
}

/** 机构时区本地的 HH:mm */
export function localHm(date: Date): string {
  const z = toZonedTime(date, TZ);
  return `${pad(z.getHours())}:${pad(z.getMinutes())}`;
}

/**
 * 展开一条提醒在 [from, to] 窗口内的所有到期时间（UTC Date）。
 * 一次性提醒：due_at 在窗口内则返回它（逾期的也返回，让看板能显示逾期）。
 * skipHolidays：放假的日子跳过；「每个工作日」的规则在调休上班的周末照样提醒。
 */
export function expandOccurrences(
  dueAtIso: string,
  rrule: string | null,
  skipHolidays: boolean,
  from: Date,
  to: Date,
): Date[] {
  const due = new Date(dueAtIso);
  const rule = parseRule(rrule);
  if (!rule) {
    return due >= from && due <= to ? [due] : [];
  }
  const dueLocal = toZonedTime(due, TZ);
  const hh = dueLocal.getHours();
  const mm = dueLocal.getMinutes();
  const startLocal = toZonedTime(from, TZ);
  const out: Date[] = [];
  // 从窗口起点的本地日期开始逐日检查
  const cursor = new Date(startLocal.getFullYear(), startLocal.getMonth(), startLocal.getDate());
  const endLocal = toZonedTime(to, TZ);
  const endDay = new Date(endLocal.getFullYear(), endLocal.getMonth(), endLocal.getDate());
  const firstDay = new Date(dueLocal.getFullYear(), dueLocal.getMonth(), dueLocal.getDate());
  const weekDays = rule.byday.length ? rule.byday : [dueLocal.getDay()];
  const workdayRule = rule.freq === 'WEEKLY' && weekDays.length === 5 && [1, 2, 3, 4, 5].every((d) => weekDays.includes(d));
  for (let day = cursor; day <= endDay; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    if (day < firstDay) continue;
    let matches = false;
    if (rule.freq === 'DAILY') matches = true;
    else if (rule.freq === 'WEEKLY') matches = weekDays.includes(day.getDay());
    else if (rule.freq === 'MONTHLY') matches = day.getDate() === dueLocal.getDate();
    const ymd = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    if (skipHolidays) {
      if (isOffDay(ymd)) continue;
      // 调休：周末要上班的那天，「每个工作日」的提醒照样提醒
      if (!matches && workdayRule && isMakeupWorkday(ymd)) matches = true;
    }
    if (!matches) continue;
    const at = localToUtc(day.getFullYear(), day.getMonth() + 1, day.getDate(), hh, mm);
    if (at >= from && at <= to) out.push(at);
  }
  return out;
}
