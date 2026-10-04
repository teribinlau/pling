// notify 的「算」：给一份数据快照和当前时间，算出这一分钟该发的服务号消息和群消息（纯函数，不碰数据库和网络）。
//
// 阶段（和桌面版 src/lib/scheduler.ts 一致）：
//   pre        到期前 remind_before_min 分钟（> 0 才有）
//   due        到点
//   overdue#k  到期后每 overdue_repeat_min 分钟一次，k = 1 … push_overdue_max（桌面版不限次数，服务端最多催这么多次）
//   snooze:<until ISO>  稍后提醒到点（只对设了稍后的那个人；没到 until 之前这个人这一次到期什么都不发）
// 每次到期、每个接收对象只看「已经到点」的最晚那个阶段：12 小时以内、还没发过就发；更早的阶段不补。
import { buildOccurrences, resolveAssignees } from '../core/occurrences.ts';
import { inQuietTime } from '../core/recurrence.ts';
import { setHolidays } from '../core/holidays.ts';
import {
  type Assignee,
  DEFAULT_APP_SETTINGS,
  DEFAULT_NOTIFY_PREFS,
  type NotifyPrefs,
  type NotifyStage,
  type Occurrence,
  type Profile,
  type Reminder,
  setTimeZone,
  type Snooze,
  type Team,
  type TeamWebhook,
  type WechatBinding,
} from '../core/types.ts';
import type { TemplateValues } from '../wechat-mp.ts';
import { chatText, firstLine, normalizeMobile, reminderUrl, STAGE_LABEL, templateTime } from './content.ts';
import type { Snapshot } from './snapshot.ts';

/** 太久以前的阶段不再补发 */
export const FRESH_MS = 12 * 3600000;
/** 展开最近 48 小时的到期（逾期催办、稍后提醒都落在这里面） */
export const WINDOW_BACK_MS = 48 * 3600000;
/** 完成记录、稍后提醒和到期时间对得上的误差（和 core 的 sameInstant 一样） */
const SAME_INSTANT_MS = 60000;

export interface StagePoint {
  /** 写进 dedupe_key 和 notification_log.stage：pre / due / overdue#2 / snooze:<ISO> */
  stage: string;
  /** 显示用的阶段：即将到期 / 已到期 / 已逾期；机器人的 stages 也按它过滤 */
  kind: NotifyStage;
  at: number;
}

/** 一次到期的公共阶段（不含稍后提醒），按时间先后；逾期只算到已经到点的那几次 */
export function stagePoints(
  r: Pick<Reminder, 'remind_before_min' | 'overdue_repeat_min'>,
  at: Date,
  now: Date,
  overdueMax: number,
): StagePoint[] {
  const due = at.getTime();
  const out: StagePoint[] = [];
  if (r.remind_before_min > 0) out.push({ stage: 'pre', kind: 'pre', at: due - r.remind_before_min * 60000 });
  out.push({ stage: 'due', kind: 'due', at: due });
  const rep = r.overdue_repeat_min * 60000;
  if (rep > 0 && overdueMax > 0 && now.getTime() > due) {
    const k = Math.min(Math.floor((now.getTime() - due) / rep), overdueMax);
    for (let i = 1; i <= k; i++) out.push({ stage: `overdue#${i}`, kind: 'overdue', at: due + i * rep });
  }
  return out;
}

/** 稍后提醒到点时显示成哪个阶段：还没到期 = 即将到期；到期之后 = 已逾期 */
export function snoozeStage(until: Date, at: Date): StagePoint {
  const u = until.getTime();
  const due = at.getTime();
  const kind: NotifyStage = u < due ? 'pre' : u - due < SAME_INSTANT_MS ? 'due' : 'overdue';
  return { stage: `snooze:${until.toISOString()}`, kind, at: u };
}

/** 已经到点的最晚那个阶段；它超过 12 小时了（更早的只会更久）→ null */
export function latestStage(points: StagePoint[], now: Date): StagePoint | null {
  const t = now.getTime();
  let best: StagePoint | null = null;
  for (const p of points) if (p.at <= t && (!best || p.at >= best.at)) best = p;
  return best && t - best.at < FRESH_MS ? best : null;
}

export function wechatKey(userId: string, reminderId: string, at: Date, stage: string): string {
  return `wechat|${userId}|${reminderId}|${at.toISOString()}|${stage}`;
}

export function webhookKey(webhookId: string, reminderId: string, at: Date, stage: string): string {
  return `webhook|${webhookId}|${reminderId}|${at.toISOString()}|${stage}`;
}

interface JobBase {
  key: string;
  reminderId: string;
  at: Date;
  stage: string;
  kind: NotifyStage;
}

export interface WechatJob extends JobBase {
  channel: 'wechat';
  userId: string;
  openid: string;
  values: TemplateValues;
  url: string;
}

export interface WebhookJob extends JobBase {
  channel: 'webhook';
  webhook: TeamWebhook;
  text: string;
  mobiles: string[];
}

export type Job = WechatJob | WebhookJob;

export interface PlanOptions {
  now: Date;
  /** 消息里的链接用：https://pling.example.cn */
  publicUrl: string;
  /** 服务号能发（配了 appid / secret / 模板 id）；false = 只发群机器人 */
  wechat: boolean;
  /** 已经有的发送记录（dedupe_key） */
  sentKeys: Set<string>;
}

export interface Plan {
  jobs: Job[];
  /** 该发、但按规则这次不发的：关了服务号消息、免打扰 */
  skipped: number;
}

/** 机构时区、节假日装进 core（展开重复提醒、免打扰都按它们算） */
export function applyCoreSettings(s: Pick<Snapshot, 'settings' | 'holidays'>): void {
  setTimeZone(DEFAULT_APP_SETTINGS.timezone);
  setTimeZone(s.settings.timezone);
  setHolidays(s.holidays);
}

/** 这个人在这一次到期算不算完成了（工位账号代点的按选的名字算，和 core 的 missingSubmitters 一样） */
function doneBy(o: Occurrence, p: Profile): boolean {
  return o.completions.some((c) => (c.completed_by_name ? c.completed_by_name === p.name : c.completed_by === p.id));
}

class Context {
  readonly profilesById: Map<string, Profile>;
  readonly teamsById: Map<string, Team>;
  readonly members: Profile[];
  readonly assigneesByReminder = new Map<string, Assignee[]>();
  readonly snoozesBy = new Map<string, Snooze[]>();
  readonly prefsByUser: Map<string, NotifyPrefs>;
  readonly bindingByUser: Map<string, WechatBinding>;
  private readonly membership: Set<string>;
  private readonly snoozedReminders: Set<string>;
  private readonly peopleCache = new Map<string, Profile[]>();
  private readonly directCache = new Map<string, Profile[]>();

  constructor(readonly s: Snapshot) {
    this.profilesById = new Map(s.profiles.map((p) => [p.id, p]));
    this.teamsById = new Map(s.teams.map((t) => [t.id, t]));
    this.members = s.profiles.filter((p) => p.active && !p.is_station);
    this.membership = new Set(s.memberships.map((m) => `${m.profile_id}|${m.team_id}`));
    this.snoozedReminders = new Set(s.snoozes.map((sn) => sn.reminder_id));
    for (const a of s.assignees) {
      const list = this.assigneesByReminder.get(a.reminder_id) ?? [];
      list.push(a);
      this.assigneesByReminder.set(a.reminder_id, list);
    }
    for (const sn of s.snoozes) {
      const k = `${sn.reminder_id}|${sn.user_id}`;
      const list = this.snoozesBy.get(k) ?? [];
      list.push(sn);
      this.snoozesBy.set(k, list);
    }
    this.prefsByUser = new Map(s.prefs.map((p) => [p.user_id, p]));
    this.bindingByUser = new Map(s.bindings.map((b) => [b.user_id, b]));
  }

  rows(r: Reminder): Assignee[] {
    return this.assigneesByReminder.get(r.id) ?? [];
  }

  hasSnooze(reminderId: string): boolean {
    return this.snoozedReminders.has(reminderId);
  }

  /** 主小组或兼任 */
  inTeam(p: Profile, teamId: string): boolean {
    return p.team_id === teamId || this.membership.has(`${p.id}|${teamId}`);
  }

  /**
   * 接收人：指派的人 + 指派小组的成员（含兼任）；没指派 →「全体」可见的是全部成员，其余是创建人。
   * 工位账号和未激活的人都不算。
   */
  people(r: Reminder): Profile[] {
    let out = this.peopleCache.get(r.id);
    if (out) return out;
    const rows = this.rows(r);
    if (rows.length) {
      // 兼任关系只留指派到的小组的（结果一样，少算很多）
      const teamIds = new Set(rows.map((a) => a.team_id).filter((x): x is string => !!x));
      const memberships = this.s.memberships.filter((m) => teamIds.has(m.team_id));
      out = resolveAssignees(r, rows, this.s.profiles, this.s.teams, memberships).people;
    } else if (r.visibility === 'company') {
      out = this.members;
    } else {
      const c = this.profilesById.get(r.created_by);
      out = c && c.active && !c.is_station ? [c] : [];
    }
    this.peopleCache.set(r.id, out);
    return out;
  }

  /**
   * 群消息里 each 模式的名单，和应用里作业统计的 audienceOf()（src/lib/homework.ts）一样：私人的 = 没有；
   * 指派了 → 接收人；没指派：「全体」可见 = 全部成员，小组可见 = 那个小组的人（含兼任）。都不含创建人（发通知、收作业的人）
   */
  roster(r: Reminder): Profile[] {
    if (r.visibility === 'private') return [];
    let base: Profile[];
    if (this.rows(r).length) base = this.people(r);
    else if (r.visibility === 'company') base = this.members;
    else if (r.team_id) base = this.members.filter((p) => this.inTeam(p, r.team_id!));
    else base = [];
    return base.filter((p) => p.id !== r.created_by);
  }

  /** 直接指派到的人（不含按小组展开的） */
  direct(r: Reminder): Profile[] {
    let out = this.directCache.get(r.id);
    if (out) return out;
    const ids = new Set(this.rows(r).map((a) => a.user_id).filter((x): x is string => !!x));
    out = this.members.filter((p) => ids.has(p.id));
    this.directCache.set(r.id, out);
    return out;
  }

  /** 机器人归属：指派了小组 → 这些小组的机器人；没指派小组：「全体」可见 → team_id 为空的；小组可见 → 提醒所属小组的 */
  webhooks(r: Reminder): TeamWebhook[] {
    const teamIds = new Set(this.rows(r).map((a) => a.team_id).filter((x): x is string => !!x));
    const all = this.s.webhooks.filter((w) => w.enabled);
    if (teamIds.size) return all.filter((w) => !!w.team_id && teamIds.has(w.team_id));
    if (r.visibility === 'company') return all.filter((w) => !w.team_id);
    if (r.visibility === 'team' && r.team_id) return all.filter((w) => w.team_id === r.team_id);
    return [];
  }

  snoozeFor(r: Reminder, userId: string, at: Date): Snooze | null {
    const list = this.snoozesBy.get(`${r.id}|${userId}`);
    if (!list) return null;
    return list.find((sn) => Math.abs(new Date(sn.occurrence_at).getTime() - at.getTime()) < SAME_INSTANT_MS) ?? null;
  }

  prefs(userId: string): Omit<NotifyPrefs, 'user_id'> {
    return this.prefsByUser.get(userId) ?? DEFAULT_NOTIFY_PREFS;
  }

  /** 模板里的「小组」：指派到的小组 → 提醒所属小组 → 「全体」可见的写机构的叫法 */
  teamLabel(r: Reminder): string {
    const assigned = this.rows(r)
      .map((a) => (a.team_id ? this.teamsById.get(a.team_id)?.name : ''))
      .filter((x): x is string => !!x);
    if (assigned.length) return assigned.join('、');
    const own = r.team_id ? this.teamsById.get(r.team_id)?.name : '';
    if (own) return own;
    return r.visibility === 'company' ? this.s.settings.org_label : '';
  }
}

/** 算这一分钟要发的消息 */
export function planNotifications(s: Snapshot, opt: PlanOptions): Plan {
  applyCoreSettings(s);
  const now = opt.now;
  const ctx = new Context(s);
  const overdueMax = Math.max(0, Math.floor(Number(s.settings.push_overdue_max) || 0));
  const maxBefore = s.reminders.reduce((m, r) => Math.max(m, r.remind_before_min || 0), 0);
  const occs = buildOccurrences({
    reminders: s.reminders,
    completions: s.completions,
    snoozes: [],
    userId: '',
    from: new Date(now.getTime() - WINDOW_BACK_MS),
    to: new Date(now.getTime() + maxBefore * 60000 + 60000),
    now,
  });

  // 免打扰只和设置、当前时间有关：同样的设置这次运行只算一次
  const quietMemo = new Map<string, boolean>();
  const quiet = (pr: Omit<NotifyPrefs, 'user_id'>): boolean => {
    const k = `${pr.dnd_enabled}|${pr.dnd_from}|${pr.dnd_to}|${pr.dnd_rest_days}`;
    let v = quietMemo.get(k);
    if (v === undefined) {
      v = inQuietTime({ enabled: pr.dnd_enabled, from: pr.dnd_from, to: pr.dnd_to, restDays: pr.dnd_rest_days }, now);
      quietMemo.set(k, v);
    }
    return v;
  };

  const jobs: Job[] = [];
  let skipped = 0;
  for (const o of occs) {
    const r = o.reminder;
    const points = stagePoints(r, o.at, now, overdueMax);
    const latest = latestStage(points, now);
    // 公共阶段都过了 12 小时（或者还没到）、也没人设稍后提醒：这一次到期什么都不用发
    if (!latest && !ctx.hasSnooze(r.id)) continue;
    const people = ctx.people(r);
    const anyDone = o.completions.length > 0;
    const isDone = (p: Profile) => (r.completion_mode === 'each' ? doneBy(o, p) : anyDone);
    const url = reminderUrl(opt.publicUrl, r.id, o.at);

    // ---- 服务号：每个接收人 ----
    if (opt.wechat) {
      for (const p of people) {
        if (isDone(p)) continue;
        const sn = ctx.snoozeFor(r, p.id, o.at);
        const until = sn ? new Date(sn.until) : null;
        if (until && until.getTime() > now.getTime()) continue; // 稍后提醒还没到
        const mine = until ? latestStage([...points, snoozeStage(until, o.at)], now) : latest;
        if (!mine) continue;
        const key = wechatKey(p.id, r.id, o.at, mine.stage);
        if (opt.sentKeys.has(key)) continue;
        const binding = ctx.bindingByUser.get(p.id);
        if (!binding || !binding.subscribed || !binding.openid) continue; // 收不到：没绑定 / 取消关注了
        const pr = ctx.prefs(p.id);
        if (!pr.wechat) {
          skipped++;
          continue;
        }
        if (quiet(pr)) {
          skipped++; // 不记录：免打扰结束时还在 12 小时以内就发（发那时最晚的阶段）
          continue;
        }
        jobs.push({
          channel: 'wechat',
          key,
          userId: p.id,
          openid: binding.openid,
          reminderId: r.id,
          at: o.at,
          stage: mine.stage,
          kind: mine.kind,
          url,
          values: {
            title: r.title,
            time: templateTime(o.at),
            stage: STAGE_LABEL[mine.kind],
            team: ctx.teamLabel(r),
            creator: ctx.profilesById.get(r.created_by)?.name ?? '',
            note: firstLine(r.notes),
          },
        });
      }
    }

    // ---- 群机器人：每个机器人 ----
    // 阶段只看「已经到点的最晚那个」（不按机器人勾的阶段另算，免得补发一条过时的「即将到期」），再按机器人的 stages 过滤
    if (!latest) continue;
    const hooks = ctx.webhooks(r);
    if (!hooks.length) continue;
    // each 模式有名单：列出（并 @）还没完成的人，都完成了就不发；名单是空的、或者 any 模式：任一人完成就不发
    const roster = r.completion_mode === 'each' ? ctx.roster(r) : [];
    const listed = roster.length > 0;
    if (!listed && anyDone) continue;
    const left = roster.filter((p) => !doneBy(o, p));
    if (listed && !left.length) continue;
    const assignedTeams = new Set(ctx.rows(r).map((a) => a.team_id).filter((x): x is string => !!x));
    for (const w of hooks) {
      if (!w.stages.includes(latest.kind)) continue;
      const key = webhookKey(w.id, r.id, o.at, latest.stage);
      if (opt.sentKeys.has(key)) continue;
      // each：还没完成的人；any：直接指派到的人（按小组指派的不一个个列）
      let named = listed ? left : r.completion_mode === 'any' ? ctx.direct(r) : [];
      // 指派了好几个小组时，每个小组的群只列（和 @）自己组里的人；each 模式这个组的人都完成了，这个群就不发
      if (w.team_id && assignedTeams.has(w.team_id)) named = named.filter((p) => ctx.inTeam(p, w.team_id!));
      if (listed && !named.length) continue;
      const names = named.map((p) => p.name).sort(COLLATOR.compare);
      const text = chatText({
        title: r.title,
        at: o.at,
        now,
        stage: latest.kind,
        pending: listed ? names : null,
        owners: listed ? null : names,
        url,
      });
      const mobiles = named.map((p) => normalizeMobile(p.phone ?? '')).filter((x): x is string => !!x);
      jobs.push({ channel: 'webhook', key, webhook: w, reminderId: r.id, at: o.at, stage: latest.stage, kind: latest.kind, text, mobiles });
    }
  }
  return { jobs, skipped };
}

const COLLATOR = new Intl.Collator('zh-CN');
