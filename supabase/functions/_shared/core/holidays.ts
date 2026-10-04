// 自动生成：源文件在 src/lib/，改那边再跑 npm run sync:core，不要直接改这里。
// 节假日：数据来自数据库的 holidays 表（管理员在「设置 → 节假日」里维护），这里只是查询。
//   off  = 放假（工作日也不上班）
//   work = 调休上班（周末也要上班）
// 前端和云函数 notify 共用这个文件（npm run sync:core 复制到 supabase/functions/_shared/core/）。

export type HolidayKind = 'off' | 'work';

export interface Holiday {
  day: string; // YYYY-MM-DD（机构时区的本地日期）
  kind: HolidayKind;
  name: string;
}

let byDay = new Map<string, Holiday>();

/** 换成新的节假日表（加载数据 / 实时同步后调用） */
export function setHolidays(rows: Holiday[]): void {
  const next = new Map<string, Holiday>();
  for (const r of rows) next.set(r.day.slice(0, 10), r);
  byDay = next;
}

export function holidayOn(ymd: string): Holiday | null {
  return byDay.get(ymd) ?? null;
}

/** 放假（法定假日，含放假期间的周末） */
export function isOffDay(ymd: string): boolean {
  return byDay.get(ymd)?.kind === 'off';
}

/** 调休上班（落在周末但要上班） */
export function isMakeupWorkday(ymd: string): boolean {
  return byDay.get(ymd)?.kind === 'work';
}

/** 休息日：放假，或者是周末且不调休。weekday：0 = 周日 … 6 = 周六 */
export function isRestDay(ymd: string, weekday: number): boolean {
  if (isOffDay(ymd)) return true;
  if (isMakeupWorkday(ymd)) return false;
  return weekday === 0 || weekday === 6;
}

function range(from: string, to: string, kind: HolidayKind, name: string): Holiday[] {
  const out: Holiday[] = [];
  const end = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  for (let t = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)); t <= end; t += 86400000) {
    out.push({ day: new Date(t).toISOString().slice(0, 10), kind, name });
  }
  return out;
}

/** 2026 年全国放假安排（国务院办公厅 2025-11-04 公布）；数据库里没有数据时（演示模式）用它 */
export const CN_HOLIDAYS_2026: Holiday[] = [
  ...range('2026-01-01', '2026-01-03', 'off', '元旦'),
  ...range('2026-02-15', '2026-02-23', 'off', '春节'),
  ...range('2026-04-04', '2026-04-06', 'off', '清明节'),
  ...range('2026-05-01', '2026-05-05', 'off', '劳动节'),
  ...range('2026-06-19', '2026-06-21', 'off', '端午节'),
  ...range('2026-09-25', '2026-09-27', 'off', '中秋节'),
  ...range('2026-10-01', '2026-10-07', 'off', '国庆节'),
  { day: '2026-01-04', kind: 'work', name: '元旦调休' },
  { day: '2026-02-14', kind: 'work', name: '春节调休' },
  { day: '2026-02-28', kind: 'work', name: '春节调休' },
  { day: '2026-05-09', kind: 'work', name: '劳动节调休' },
  { day: '2026-09-20', kind: 'work', name: '国庆节调休' },
  { day: '2026-10-10', kind: 'work', name: '国庆节调休' },
];

setHolidays(CN_HOLIDAYS_2026);
