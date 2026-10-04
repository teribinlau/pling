// 稍后提醒：数据库返回的时间格式（+00:00）和本地算出来的（.000Z）不一样，以前按字符串比对不上，
// 从服务器重新加载后「稍后提醒」就失效了
import { describe, expect, it } from 'vitest';
import { buildOccurrences, findSnooze, isoInstant, occurrenceKey } from '../../src/lib/occurrences';
import type { Reminder, Snooze } from '../../src/lib/types';

const DUE = '2026-10-09T09:00:00.000Z';
const reminder: Reminder = {
  id: 'r1',
  title: '交周报',
  notes: '',
  due_at: DUE,
  tz: 'Asia/Shanghai',
  rrule: null,
  skip_holidays: false,
  remind_before_min: 15,
  overdue_repeat_min: 30,
  priority: 'medium',
  visibility: 'company',
  team_id: null,
  created_by: 'teacher',
  link: '',
  completion_mode: 'any',
  require_upload: false,
  archived: false,
  source: null,
  source_key: null,
  created_at: DUE,
  updated_at: DUE,
};
// PostgREST 返回 timestamptz 的样子
const fromServer = (until: string, user = 'me'): Snooze => ({ id: 's1', reminder_id: 'r1', user_id: user, occurrence_at: '2026-10-09T09:00:00+00:00', until });

const build = (snoozes: Snooze[], now: Date) =>
  buildOccurrences({
    reminders: [reminder],
    completions: [],
    snoozes,
    userId: 'me',
    from: new Date('2026-10-08T00:00:00Z'),
    to: new Date('2026-10-10T00:00:00Z'),
    now,
  });

describe('稍后提醒', () => {
  it('数据库格式的时间和本地格式算成同一个到期', () => {
    expect(isoInstant('2026-10-09T09:00:00+00:00')).toBe(DUE);
    expect(isoInstant('2026-10-09 17:00:00+08')).toBe(DUE);
    expect(occurrenceKey('r1', '2026-10-09T09:00:00+00:00')).toBe(occurrenceKey('r1', new Date(DUE)));
    expect(isoInstant('不是时间')).toBe('不是时间');
  });

  it('从服务器加载的稍后提醒生效：还没到 until 就不算逾期催办', () => {
    const now = new Date('2026-10-09T09:20:00Z');
    const [o] = build([fromServer('2026-10-09T09:30:00+00:00')], now);
    expect(o.snoozedUntil?.toISOString()).toBe('2026-10-09T09:30:00.000Z');
  });

  it('until 过了：不再算稍后，但调度器还找得到它，到点再提醒一次', () => {
    const now = new Date('2026-10-09T09:40:00Z');
    const [o] = build([fromServer('2026-10-09T09:30:00+00:00')], now);
    expect(o.snoozedUntil).toBeNull();
    expect(findSnooze([fromServer('2026-10-09T09:30:00+00:00')], 'r1', o.at, 'me')?.until).toBe('2026-10-09T09:30:00+00:00');
  });

  it('别人的稍后提醒不算我的', () => {
    const now = new Date('2026-10-09T09:20:00Z');
    const [o] = build([fromServer('2026-10-09T09:30:00+00:00', 'other')], now);
    expect(o.snoozedUntil).toBeNull();
    expect(findSnooze([fromServer('2026-10-09T09:30:00+00:00', 'other')], 'r1', o.at, 'me')).toBeUndefined();
  });
});
