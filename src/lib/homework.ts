// 已读回执和作业统计的纯函数（不依赖 store，界面和单元测试都用这里）。
import type { Assignee, Completion, Occurrence, Profile, Reminder, ReminderRead, Submission, Team, TeamMembership } from './types';
import { resolveAssignees, teamIdsOf } from './occurrences';
import { ts } from './discussions';

/**
 * 这条提醒「该谁看 / 该谁交」：
 *   指派了人或小组 → 指派的人 + 小组成员（兼任也算）
 *   没指派：「全体」可见 = 全部成员；小组可见 = 那个小组的人；私人的 = 没有
 * 都不含共用设备账号、没激活的人，也不含创建人自己（发通知 / 收作业的人）。
 */
export function audienceOf(r: Reminder, assignees: Assignee[], profiles: Profile[], teams: Team[], memberships: TeamMembership[] = []): Profile[] {
  if (r.visibility === 'private') return [];
  const people = (() => {
    if (assignees.some((a) => a.reminder_id === r.id)) return resolveAssignees(r, assignees, profiles, teams, memberships).people;
    const all = profiles.filter((p) => p.active && !p.is_station);
    if (r.visibility === 'company') return all;
    if (r.team_id) return all.filter((p) => teamIdsOf(p, memberships).includes(r.team_id!));
    return [];
  })();
  return people.filter((p) => p.id !== r.created_by);
}

// ---------------------------------------------------------------------------
// 已读回执
// ---------------------------------------------------------------------------

function sameInstant(a: string | Date, b: string | Date): boolean {
  const ta = typeof a === 'string' ? ts(a) : a.getTime();
  const tb = typeof b === 'string' ? ts(b) : b.getTime();
  return Math.abs(ta - tb) < 60000;
}

export interface ReadStatus {
  people: Profile[];
  read: { person: Profile; at: string }[];
  unread: Profile[];
}

/** 这一次到期，受众里谁读了、谁没读 */
export function readStatusOf(o: Pick<Occurrence, 'reminder' | 'at'>, reads: ReminderRead[], audience: Profile[]): ReadStatus {
  const mine = reads.filter((x) => x.reminder_id === o.reminder.id && sameInstant(x.occurrence_at, o.at));
  const byUser = new Map(mine.map((x) => [x.user_id, x.read_at]));
  const read = audience.filter((p) => byUser.has(p.id)).map((p) => ({ person: p, at: byUser.get(p.id)! }));
  read.sort((a, b) => ts(a.at) - ts(b.at));
  return { people: audience, read, unread: audience.filter((p) => !byUser.has(p.id)) };
}

// ---------------------------------------------------------------------------
// 作业
// ---------------------------------------------------------------------------

export type HomeworkStatus = 'missing' | 'submitted' | 'returned' | 'accepted';

/** 共用设备交的文件记在所选的名字下；其他人按账号认 */
export function isSubmissionOf(s: Submission, p: Pick<Profile, 'id' | 'name'>): boolean {
  return s.uploaded_by_name ? s.uploaded_by_name === p.name : s.uploaded_by === p.id;
}

export function isCompletionOf(c: Completion, p: Pick<Profile, 'id' | 'name'>): boolean {
  return c.completed_by_name ? c.completed_by_name === p.name : c.completed_by === p.id;
}

export interface PersonHomework {
  status: HomeworkStatus;
  /** 现在这一批（退回之后重交的算新的一批）：批改、文件数、显示的文件都按它 */
  current: Submission[];
  /** 这个人这一次交过的全部文件（含被退回的） */
  all: Submission[];
  /** 第一次交的时间：迟交按它算 */
  firstAt: string | null;
  /** 现在这一批最后一个文件的时间 */
  lastAt: string | null;
  late: boolean;
  /** 退回之后又交过 */
  resubmitted: boolean;
  note: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/**
 * 一个人在某一次到期的作业状态。
 * 批改是「一批一批」的：老师通过 / 退回时把这个人现在这一批文件一起改；退回后再交的文件是新的一批（状态「已交」）。
 *   现在这一批 = 最后一次退回之后交的文件；退回后还没重交 = 被退回的那一批
 *   状态：这一批里有「退回」→ 已退回；有「已交」（还没批）→ 已交；否则 → 已通过；一个文件都没有 → 未交
 *   迟交：第一次交的时间晚于这一次的到期时间（退回重交不改变迟没迟）
 */
export function personHomework(subs: Submission[], dueAt: Date): PersonHomework {
  const all = [...subs].sort((a, b) => ts(a.created_at) - ts(b.created_at));
  if (!all.length) {
    return { status: 'missing', current: [], all, firstAt: null, lastAt: null, late: false, resubmitted: false, note: '', reviewedBy: null, reviewedAt: null };
  }
  const lastReturn = Math.max(0, ...all.filter((s) => s.status === 'returned').map((s) => ts(s.reviewed_at) || ts(s.created_at)));
  let current = all.filter((s) => ts(s.created_at) > lastReturn);
  const resubmitted = lastReturn > 0 && current.length > 0;
  if (!current.length) current = all.filter((s) => s.status === 'returned' && (ts(s.reviewed_at) || ts(s.created_at)) === lastReturn);
  const status: HomeworkStatus = current.some((s) => s.status === 'returned') ? 'returned' : current.some((s) => s.status === 'submitted') ? 'submitted' : 'accepted';
  const reviewed = current.filter((s) => s.reviewed_at).sort((a, b) => ts(b.reviewed_at) - ts(a.reviewed_at))[0];
  const firstAt = all[0].created_at;
  return {
    status,
    current,
    all,
    firstAt,
    lastAt: current[current.length - 1].created_at,
    late: ts(firstAt) > dueAt.getTime() + 999,
    resubmitted,
    note: status === 'submitted' ? '' : (reviewed?.review_note ?? ''),
    reviewedBy: status === 'submitted' ? null : (reviewed?.reviewed_by ?? null),
    reviewedAt: status === 'submitted' ? null : (reviewed?.reviewed_at ?? null),
  };
}

/** 这个人现在有没有「算数」的作业（已交 / 已通过）；被退回的不算，要重交 */
export function hasValidHomework(o: Pick<Occurrence, 'submissions' | 'at'>, p: Pick<Profile, 'id' | 'name'>): boolean {
  const st = personHomework(o.submissions.filter((s) => isSubmissionOf(s, p)), o.at).status;
  return st === 'submitted' || st === 'accepted';
}

export interface HomeworkRow extends PersonHomework {
  person: Profile;
}

export interface HomeworkStats {
  rows: HomeworkRow[];
  expected: number;
  /** 已交 = 已交待批 + 已通过（被退回的不算，要重交） */
  submitted: number;
  onTime: number;
  late: number;
  missing: number;
  returned: number;
  accepted: number;
  /** 已交、还没批 */
  waiting: number;
}

const ORDER: Record<HomeworkStatus, number> = { submitted: 0, returned: 1, missing: 2, accepted: 3 };

/** 整个受众的作业统计。排序：待批的在前（要处理），然后退回、未交、通过；同一组里按姓名 */
export function homeworkStats(o: Pick<Occurrence, 'submissions' | 'at'>, audience: Profile[]): HomeworkStats {
  const rows: HomeworkRow[] = audience.map((person) => ({ person, ...personHomework(o.submissions.filter((s) => isSubmissionOf(s, person)), o.at) }));
  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.person.name.localeCompare(b.person.name, 'zh-CN'));
  const valid = rows.filter((r) => r.status === 'submitted' || r.status === 'accepted');
  return {
    rows,
    expected: rows.length,
    submitted: valid.length,
    onTime: valid.filter((r) => !r.late).length,
    late: valid.filter((r) => r.late).length,
    missing: rows.filter((r) => r.status === 'missing').length,
    returned: rows.filter((r) => r.status === 'returned').length,
    accepted: rows.filter((r) => r.status === 'accepted').length,
    waiting: rows.filter((r) => r.status === 'submitted').length,
  };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export interface ExportLabels {
  name: string;
  team: string;
  status: string;
  time: string;
  late: string;
  note: string;
  files: string;
  yes: string;
  no: string;
  statusText: Record<HomeworkStatus, string>;
}

/** 表格内容：第一行是表头。时间用机构时区的「2026-10-03 21:40」 */
export function homeworkTable(stats: HomeworkStats, teams: Team[], labels: ExportLabels, fmtTime: (iso: string) => string): string[][] {
  const head = [labels.name, labels.team, labels.status, labels.time, labels.late, labels.note, labels.files];
  const body = stats.rows.map((r) => [
    r.person.name,
    teams.find((t) => t.id === r.person.team_id)?.name ?? '',
    labels.statusText[r.status],
    r.firstAt ? fmtTime(r.firstAt) : '',
    r.status === 'missing' ? '' : r.late ? labels.yes : labels.no,
    r.note,
    String(r.current.length),
  ]);
  return [head, ...body];
}

/** CSV：UTF-8 BOM（Excel 才认得中文）+ CRLF；有逗号 / 引号 / 换行的格子加引号 */
export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** 粘到 Excel / WPS 用的制表符分隔；格子里的换行 / 制表符换成空格 */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => v.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
}

/**
 * 这个人完成这一次要不要先交文件：
 *   需要回传的提醒，受众里的人（学生）、共用设备、以及既不是创建人也不是管理员的人 → 要交；
 *   创建人 / 管理员自己不在受众里（布置作业的老师）→ 不用交，直接「标记完成」= 收齐了
 */
export function uploadRequiredFor(r: Reminder, me: Pick<Profile, 'id' | 'role' | 'is_station'>, audience: Pick<Profile, 'id'>[]): boolean {
  if (!r.require_upload) return false;
  if (me.is_station) return true;
  if (audience.some((p) => p.id === me.id)) return true;
  return me.id !== r.created_by && me.role !== 'admin';
}
