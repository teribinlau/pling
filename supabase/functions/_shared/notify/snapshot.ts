// notify 每次运行读一份数据快照。时间列转成 ISO 字符串，和 core 的类型（前端从 PostgREST 拿到的是字符串）一致。
import type { Sql } from '../db.ts';
import type { Holiday } from '../core/holidays.ts';
import {
  type AppSettings,
  type Assignee,
  type Completion,
  DEFAULT_APP_SETTINGS,
  type NotifyPrefs,
  type Profile,
  type Reminder,
  type Snooze,
  type Team,
  type TeamMembership,
  type TeamWebhook,
  type WechatBinding,
} from '../core/types.ts';

/** 完成记录、稍后提醒读这么久以内的（展开窗口是 48 小时，多读一点没关系） */
export const LOOKBACK_MS = 3 * 86400000;

export interface Snapshot {
  settings: AppSettings;
  holidays: Holiday[];
  reminders: Reminder[];
  assignees: Assignee[];
  completions: Completion[];
  snoozes: Snooze[];
  profiles: Profile[];
  memberships: TeamMembership[];
  teams: Team[];
  prefs: NotifyPrefs[];
  bindings: WechatBinding[];
  webhooks: TeamWebhook[];
}

type Row = Record<string, unknown>;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function isoOrNull(v: unknown): string | null {
  return v == null ? null : iso(v);
}

/** 把 Date 列换成 ISO 字符串 */
function withIso<T>(rows: Row[], cols: string[]): T[] {
  return rows.map((r) => {
    const out: Row = { ...r };
    for (const c of cols) out[c] = isoOrNull(r[c]);
    return out as T;
  });
}

export async function loadSnapshot(sql: Sql, now: Date): Promise<Snapshot> {
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const [settings, holidays, reminders, assignees, completions, snoozes, profiles, memberships, teams, prefs, bindings, webhooks] =
    await Promise.all([
      sql`select org_name, team_label, org_label, timezone, push_overdue_max from public.app_settings where id = 1`,
      sql`select day::text as day, kind, name from public.holidays`,
      // 一次性的只要窗口附近的；重复的只要已经开始（或在提前量以内开始）的
      sql`
        select id, title, notes, due_at, tz, rrule, skip_holidays, remind_before_min, overdue_repeat_min, priority, visibility,
               team_id, created_by, link, completion_mode, require_upload, archived, source, source_key, created_at, updated_at
          from public.reminders
         where not archived
           and due_at <= ${now}::timestamptz + (greatest(remind_before_min, 0) + 1440) * interval '1 minute'
           and (rrule is not null or due_at >= ${since}::timestamptz)`,
      sql`
        select a.id, a.reminder_id, a.user_id, a.team_id
          from public.reminder_assignees a
          join public.reminders r on r.id = a.reminder_id
         where not r.archived`,
      sql`
        select id, reminder_id, occurrence_at, completed_by, completed_by_name, completed_at, note
          from public.completions
         where occurrence_at >= ${since}::timestamptz`,
      sql`select id, reminder_id, user_id, occurrence_at, until from public.snoozes where occurrence_at >= ${since}::timestamptz`,
      sql`select id, email, name, team_id, role, lang, is_station, active, phone, avatar_url, name_confirmed from public.profiles`,
      sql`select profile_id, team_id from public.profile_teams`,
      sql`select id, name, color, sort from public.teams`,
      sql`select user_id, wechat, dnd_enabled, dnd_from, dnd_to, dnd_rest_days from public.notify_prefs`,
      sql`select user_id, openid, unionid, subscribed, nickname, bound_at from public.wechat_bindings`,
      sql`
        select id, team_id, kind, name, url, secret, stages, enabled, created_at, last_at, last_status
          from public.team_webhooks
         where enabled`,
    ]);
  return {
    settings: settings.length ? ({ ...DEFAULT_APP_SETTINGS, ...settings[0] } as AppSettings) : { ...DEFAULT_APP_SETTINGS },
    holidays: holidays as unknown as Holiday[],
    reminders: withIso<Reminder>(reminders, ['due_at', 'created_at', 'updated_at']),
    assignees: assignees as unknown as Assignee[],
    completions: withIso<Completion>(completions, ['occurrence_at', 'completed_at']),
    snoozes: withIso<Snooze>(snoozes, ['occurrence_at', 'until']),
    profiles: profiles as unknown as Profile[],
    memberships: memberships as unknown as TeamMembership[],
    teams: teams as unknown as Team[],
    prefs: prefs as unknown as NotifyPrefs[],
    bindings: withIso<WechatBinding>(bindings, ['bound_at']),
    webhooks: withIso<TeamWebhook>(webhooks, ['created_at', 'last_at']),
  };
}
