import { toZonedTime } from 'date-fns-tz';
import { TZ, type Reminder } from './types';
import { localHm, localYmd, parseRule } from './recurrence';
import i18n from '../i18n';

export function zoned(d: Date): Date {
  return toZonedTime(d, TZ);
}

export function todayYmd(): string {
  return localYmd(new Date());
}

export function ymdOffset(base: Date, days: number): string {
  const z = zoned(base);
  const d = new Date(z.getFullYear(), z.getMonth(), z.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dayDiff(ymdA: string, ymdB: string): number {
  const a = new Date(ymdA + 'T00:00:00Z').getTime();
  const b = new Date(ymdB + 'T00:00:00Z').getTime();
  return Math.round((a - b) / 86400000);
}

export function weekdayOf(ymd: string): number {
  return new Date(ymd + 'T00:00:00Z').getUTCDay();
}

export function isoWeek(ymd: string): number {
  const d = new Date(ymd + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function monthLabel(y: number, m: number): string {
  return `${y}年${m}月`;
}

/** 「今天 16:30」「明天 09:00」「9月20日 周日 12:00」 */
export function whenLabel(at: Date, withTime = true): string {
  const ymd = localYmd(at);
  const diff = dayDiff(ymd, todayYmd());
  const time = withTime ? ` ${localHm(at)}` : '';
  if (diff === 0) return i18n.t('time.today') + time;
  if (diff === 1) return i18n.t('time.tomorrow') + time;
  if (diff === -1) return i18n.t('time.yesterday') + time;
  return dateLabel(ymd) + time;
}

export function dateLabel(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number);
  const wd = i18n.t(`weekdaysLong.${weekdayOf(ymd)}`);
  return `${m}月${d}日 ${wd}`;
}

/** 距离到期的相对文字：还有 15 分钟 / 逾期 2 小时 */
export function relativeLabel(at: Date, now = new Date()): { text: string; hot: boolean } {
  const diffMin = Math.round((at.getTime() - now.getTime()) / 60000);
  if (diffMin >= 0) {
    if (diffMin < 60) return { text: i18n.t('time.inMin', { n: diffMin }), hot: diffMin <= 30 };
    if (diffMin < 24 * 60) return { text: i18n.t('time.inHours', { n: Math.round(diffMin / 60) }), hot: false };
    return { text: whenLabel(at, false), hot: false };
  }
  const over = -diffMin;
  if (over < 60) return { text: i18n.t('time.overdueMin', { n: over }), hot: true };
  if (over < 24 * 60) return { text: i18n.t('time.overdueHours', { n: Math.round(over / 60) }), hot: true };
  return { text: i18n.t('time.overdueDays', { n: Math.round(over / 1440) }), hot: true };
}

export function beforeLabel(min: number): string {
  if (min <= 0) return i18n.t('time.onTime');
  if (min % 60 === 0) return i18n.t('time.beforeH', { n: min / 60 });
  return i18n.t('time.before', { n: min });
}

export function repeatLabel(r: Reminder): string {
  const rule = parseRule(r.rrule);
  if (!rule) return i18n.t('repeat.once');
  if (rule.freq === 'DAILY') return i18n.t('repeat.daily');
  if (rule.freq === 'MONTHLY') return i18n.t('repeat.monthlyOn', { day: zoned(new Date(r.due_at)).getDate() });
  const days = rule.byday.length ? rule.byday : [zoned(new Date(r.due_at)).getDay()];
  const isWeekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
  if (isWeekdays) return i18n.t('repeat.weekdays');
  const names = days.map((d) => i18n.t(`weekdays.${d}`)).join('、');
  return i18n.t('repeat.weeklyOn', { days: names });
}

export function hm(at: Date): string {
  return localHm(at);
}

export function clockLabel(d: Date): string {
  return localHm(d);
}

/** 文件大小：12 KB / 3.4 MB */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 列表里的「多久以前」：刚刚 / 5 分钟前 / 今天就是 14:05 / 昨天 / 9月20日（跨年加年份） */
export function agoLabel(at: Date, now = new Date()): string {
  const min = Math.floor((now.getTime() - at.getTime()) / 60000);
  if (min < 1) return i18n.t('time.justNow');
  if (min < 60) return i18n.t('time.minAgo', { n: min });
  const ymd = localYmd(at);
  const diff = dayDiff(ymd, localYmd(now));
  if (diff === 0) return localHm(at);
  if (diff === -1) return i18n.t('time.yesterday');
  const [y, m, d] = ymd.split('-').map(Number);
  const sameYear = y === Number(localYmd(now).slice(0, 4));
  return sameYear ? `${m}月${d}日` : `${y}年${m}月${d}日`;
}

/** 短日期：10月2日 周五（不是今年的带上年份） */
export function shortDate(ymd: string, withWeekday = true): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const sameYear = y === Number(todayYmd().slice(0, 4));
  const date = `${sameYear ? '' : `${y}年`}${m}月${d}日`;
  if (!withWeekday) return date;
  return `${date} ${i18n.t(`weekdaysLong.${weekdayOf(ymd)}`)}`;
}

/** 完整的日期时间（导出名单用）：2026-10-03 21:40，机构时区 */
export function fullTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${localYmd(d)} ${localHm(d)}`;
}

/** 日期范围：10月1日–7日 / 9月30日–10月2日（同一天就一个日期） */
export function rangeLabel(from: string, to: string): string {
  if (from === to) return shortDate(from, false);
  const [, m1, d1] = from.split('-').map(Number);
  const [, m2, d2] = to.split('-').map(Number);
  return m1 === m2 ? `${m1}月${d1}日–${d2}日` : `${m1}月${d1}日–${m2}月${d2}日`;
}

/**
 * 讨论截止日期的说法：今天截止 / 明天截止 / 10月2日 周五截止 / 已过截止 · 9月22日。
 * 已结束的只说日期（不再催）。over = 进行中、已经过了截止日期；hot = 过了或者就是今天。
 */
export function dueLabel(ymd: string, closed: boolean, withWeekday = true): { text: string; hot: boolean; over: boolean } {
  const diff = dayDiff(ymd, todayYmd());
  if (!closed && diff < 0) return { text: i18n.t('discuss.overdueOn', { date: shortDate(ymd, false) }), hot: true, over: true };
  if (!closed && diff === 0) return { text: i18n.t('discuss.dueToday'), hot: true, over: false };
  if (!closed && diff === 1) return { text: i18n.t('discuss.dueTomorrow'), hot: false, over: false };
  return { text: i18n.t('discuss.dueOn', { date: shortDate(ymd, withWeekday) }), hot: false, over: false };
}
