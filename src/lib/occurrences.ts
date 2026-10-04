import type { Assignee, Completion, Occurrence, Profile, Reminder, Snooze, Submission, Team, TeamMembership } from './types';
import { expandOccurrences } from './recurrence';

export function occurrenceKey(reminderId: string, at: Date | string): string {
  const iso = typeof at === 'string' ? at : at.toISOString();
  return `${reminderId}|${iso}`;
}

export interface BuildInput {
  reminders: Reminder[];
  completions: Completion[];
  snoozes: Snooze[];
  submissions?: Submission[];
  userId: string;
  from: Date;
  to: Date;
  now?: Date;
}

/** 把所有提醒展开成窗口内的具体到期项，并附上完成 / 稍后状态 */
export function buildOccurrences(input: BuildInput): Occurrence[] {
  const now = input.now ?? new Date();
  const byReminder = new Map<string, Completion[]>();
  for (const c of input.completions) {
    const list = byReminder.get(c.reminder_id) ?? [];
    list.push(c);
    byReminder.set(c.reminder_id, list);
  }
  const subsByReminder = new Map<string, Submission[]>();
  for (const s of input.submissions ?? []) {
    const list = subsByReminder.get(s.reminder_id) ?? [];
    list.push(s);
    subsByReminder.set(s.reminder_id, list);
  }
  const snoozeMap = new Map<string, Snooze>();
  for (const s of input.snoozes) {
    if (s.user_id === input.userId) snoozeMap.set(occurrenceKey(s.reminder_id, s.occurrence_at), s);
  }
  const out: Occurrence[] = [];
  for (const r of input.reminders) {
    if (r.archived) continue;
    const dates = expandOccurrences(r.due_at, r.rrule, r.skip_holidays, input.from, input.to);
    for (const at of dates) {
      const iso = at.toISOString();
      const key = occurrenceKey(r.id, at);
      const comps = (byReminder.get(r.id) ?? []).filter((c) => sameInstant(c.occurrence_at, iso));
      let completion: Completion | null = null;
      if (r.completion_mode === 'each') completion = comps.find((c) => c.completed_by === input.userId) ?? null;
      else completion = comps[0] ?? null;
      const subs = (subsByReminder.get(r.id) ?? []).filter((s) => sameInstant(s.occurrence_at, iso));
      const sn = snoozeMap.get(key);
      const snoozedUntil = sn && new Date(sn.until) > now ? new Date(sn.until) : null;
      const stale = !completion && !!r.rrule && now.getTime() - at.getTime() > 48 * 3600000;
      out.push({
        key,
        reminder: r,
        at,
        completion,
        completions: comps,
        submissions: subs,
        snoozedUntil,
        isOverdue: !completion && !stale && at < now,
        stale,
      });
    }
  }
  out.sort((a, b) => a.at.getTime() - b.at.getTime());
  return out;
}

function sameInstant(a: string, b: string): boolean {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60000;
}

/** 一个人所属的全部班组：主班组 + 兼任 */
export function teamIdsOf(p: Profile, memberships: TeamMembership[] = []): string[] {
  const ids = memberships.filter((m) => m.profile_id === p.id).map((m) => m.team_id);
  if (p.team_id && !ids.includes(p.team_id)) ids.unshift(p.team_id);
  return ids;
}

/** 这条提醒是否「与我有关」：指派给我 / 我所属的任一班组，或我创建的 */
export function concernsMe(r: Reminder, assignees: Assignee[], me: Profile, memberships: TeamMembership[] = []): boolean {
  if (r.created_by === me.id) return true;
  const mine = teamIdsOf(me, memberships);
  return assignees.some((a) => a.reminder_id === r.id && (a.user_id === me.id || (a.team_id && mine.includes(a.team_id))));
}

/** 展开后的指派对象：人 + 班组成员（兼任的也算这个班组的人） */
export function resolveAssignees(
  r: Reminder,
  assignees: Assignee[],
  profiles: Profile[],
  teams: Team[],
  memberships: TeamMembership[] = [],
): { people: Profile[]; teams: Team[] } {
  const rows = assignees.filter((a) => a.reminder_id === r.id);
  const teamIds = new Set(rows.map((a) => a.team_id).filter((x): x is string => !!x));
  const userIds = new Set(rows.map((a) => a.user_id).filter((x): x is string => !!x));
  const people = profiles.filter(
    (p) => p.active && !p.is_station && (userIds.has(p.id) || teamIdsOf(p, memberships).some((id) => teamIds.has(id))),
  );
  return { people, teams: teams.filter((t) => teamIds.has(t.id)) };
}

/** 这个人（按 id，工位模式按名字）在这次到期是否已经交过文件 */
export function hasSubmitted(o: Occurrence, userId: string, name?: string): boolean {
  if (name) return o.submissions.some((s) => s.uploaded_by_name === name);
  return o.submissions.some((s) => s.uploaded_by === userId && !s.uploaded_by_name);
}

/** 需要回传的提醒里，还没交文件的指派对象 */
export function missingSubmitters(o: Occurrence, people: Profile[]): Profile[] {
  return people.filter((p) => !o.submissions.some((s) => (s.uploaded_by_name ? s.uploaded_by_name === p.name : s.uploaded_by === p.id)));
}

export function teamName(t: Team | undefined, _lang?: string): string {
  return t?.name ?? '';
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // 中文名取最后一个字，拉丁名取首字母
  if (/[一-鿿]/.test(trimmed)) return trimmed.slice(-1);
  const parts = trimmed.split(/\s+/);
  return parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : trimmed.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = ['#3B7A2A', '#0E7C6B', '#A8560A', '#6B4FBB', '#C8261F', '#1E5A8A', '#5F5C55'];
export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** 客户端侧的可见范围判断（服务器端 RLS 也会拦，这里保证演示模式和界面一致） */
export function canSee(r: Reminder, assignees: Assignee[], me: Profile, memberships: TeamMembership[] = []): boolean {
  if (me.role === 'admin') return true;
  if (r.created_by === me.id) return true;
  if (r.visibility === 'company') return true;
  if (concernsMe(r, assignees, me, memberships)) return true;
  if (r.visibility === 'team' && r.team_id && teamIdsOf(me, memberships).includes(r.team_id)) return true;
  return false;
}
