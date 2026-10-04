// 本地通知调度：每台电脑自己按时弹，不依赖服务器在线。
// 三个阶段：pre（提前量）→ due（到点）→ overdue（逾期后每 N 分钟重复），每个阶段每次到期只弹一次。
import { effectiveNotifyPrefs, useStore } from './store';
import { buildOccurrences, canSee, concernsMe, findSnooze, teamName } from './occurrences';
import { isTauri, playChime, sendSystemNotification, setTrayBadge, showAlertWindow } from './tauri';
import { inQuietTime, localHm } from './recurrence';
import type { NotifyPrefs, Occurrence } from './types';
import i18n from '../i18n';

const FIRED_KEY = 'pling-fired-v1';

function loadFired(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FIRED_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function saveFired(m: Record<string, number>) {
  // 只保留最近 3 天的记录，避免无限增长
  const cutoff = Date.now() - 3 * 86400000;
  const pruned: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) if (v > cutoff) pruned[k] = v;
  localStorage.setItem(FIRED_KEY, JSON.stringify(pruned));
}

/** 现在是不是免打扰：和服务器推送用同一份设置（notify_prefs）、同一个判断（inQuietTime，按机构时区、含节假日 / 调休） */
export function inDnd(p: NotifyPrefs, now = new Date()): boolean {
  return inQuietTime({ enabled: p.dnd_enabled, from: p.dnd_from, to: p.dnd_to, restDays: p.dnd_rest_days }, now);
}

async function fire(o: Occurrence, stage: 'pre' | 'due' | 'overdue') {
  const st = useStore.getState();
  const { settings, teams } = st;
  const team = teams.find((t) => t.id === o.reminder.team_id);
  const tName = teamName(team);
  const time = localHm(o.at);
  const stageLabel =
    stage === 'pre'
      ? i18n.t('notify.inMinutes', { n: o.reminder.remind_before_min })
      : stage === 'due'
        ? i18n.t('notify.now')
        : i18n.t('notify.overdue');
  const title = `${time} · ${o.reminder.title}`;
  const body = [tName, stageLabel].filter(Boolean).join(' · ');

  st.pushToast({ title, body, kind: 'reminder', occurrenceKey: o.key });
  if (settings.sound) playChime(o.reminder.priority === 'high' || stage === 'overdue');
  if (settings.systemNotifications) void sendSystemNotification(title, body);
  if (isTauri() && settings.alertWindow && (o.reminder.priority === 'high' || stage !== 'pre')) {
    void showAlertWindow({
      key: o.key,
      reminderId: o.reminder.id,
      occurrenceAt: o.at.toISOString(),
      title: o.reminder.title,
      body: [tName, o.reminder.notes].filter(Boolean).join(' · '),
      priority: o.reminder.priority,
      teamName: tName,
      teamColor: team?.color ?? '#121212',
      timeLabel: `${time} · ${stageLabel}`,
    });
  }
}

let timer: number | undefined;

export function startScheduler(): () => void {
  const tick = () => {
    const st = useStore.getState();
    if (!st.loaded || !st.me || !st.session) return;
    const now = new Date();
    const fired = loadFired();
    const occs = buildOccurrences({
      reminders: st.reminders.filter((r) => canSee(r, st.assignees, st.me!, st.memberships)),
      completions: st.completions,
      snoozes: st.snoozes,
      submissions: st.submissions,
      userId: st.session.userId,
      from: new Date(now.getTime() - 2 * 86400000),
      to: new Date(now.getTime() + 86400000),
      now,
    });
    const mine = occs.filter((o) => concernsMe(o.reminder, st.assignees, st.me!, st.memberships) || o.reminder.visibility === 'company');
    const overdueCount = mine.filter((o) => o.isOverdue && !o.snoozedUntil).length;
    void setTrayBadge(overdueCount);

    const muted = st.mutedUntil && st.mutedUntil > now;
    if (muted || inDnd(effectiveNotifyPrefs(st.notifyPrefs, st.session.userId), now)) return;

    let changed = false;
    for (const o of mine) {
      if (o.completion) continue;
      if (o.snoozedUntil && o.snoozedUntil > now) continue;
      const dueMs = o.at.getTime();
      const stages: Array<{ stage: 'pre' | 'due' | 'overdue'; at: number; key: string }> = [];
      if (o.reminder.remind_before_min > 0) stages.push({ stage: 'pre', at: dueMs - o.reminder.remind_before_min * 60000, key: `${o.key}|pre` });
      stages.push({ stage: 'due', at: dueMs, key: `${o.key}|due` });
      if (o.reminder.overdue_repeat_min > 0 && now.getTime() > dueMs) {
        const rep = o.reminder.overdue_repeat_min * 60000;
        const k = Math.floor((now.getTime() - dueMs) / rep);
        if (k >= 1) stages.push({ stage: 'overdue', at: dueMs + k * rep, key: `${o.key}|overdue` });
      }
      // 稍后提醒到期 → 立刻再提醒一次
      if (o.snoozedUntil === null) {
        const sn = findSnooze(st.snoozes, o.reminder.id, o.at, st.session!.userId);
        if (sn) {
          const until = new Date(sn.until).getTime();
          if (until <= now.getTime()) stages.push({ stage: 'due', at: until, key: `${o.key}|snooze|${until}` });
        }
      }
      for (const s of stages) {
        const already = fired[s.key] ?? 0;
        const isDue = now.getTime() >= s.at;
        const fresh = now.getTime() - s.at < 12 * 3600000; // 太久以前的不再补发
        if (isDue && fresh && already < s.at) {
          fired[s.key] = now.getTime();
          changed = true;
          void fire(o, s.stage);
          break; // 同一条同一时刻只弹一次
        }
      }
    }
    if (changed) saveFired(fired);
  };
  tick();
  timer = window.setInterval(tick, 20000);
  return () => window.clearInterval(timer);
}
