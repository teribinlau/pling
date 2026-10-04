import { useTranslation } from 'react-i18next';
import type { Occurrence } from '../lib/types';
import { useStore } from '../lib/store';
import { resolveAssignees, teamName } from '../lib/occurrences';
import { audienceOf, homeworkStats, isSubmissionOf, personHomework, type HomeworkStatus } from '../lib/homework';
import { beforeLabel, hm, relativeLabel, repeatLabel, whenLabel } from '../lib/format';
import { AvatarStack } from './Avatar';
import { IconCheck, IconLink, IconPaperclip, IconRepeat, IconUpload } from './Icons';
import { linkTitle, parseLinks } from '../lib/links';

const PRIORITY_COLOR: Record<string, string> = { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--hair-2)' };
const HW_STATUS_KEY: Record<Exclude<HomeworkStatus, 'missing'>, string> = {
  submitted: 'homework.statusSubmitted',
  returned: 'homework.statusReturned',
  accepted: 'homework.statusAccepted',
};

interface Props {
  o: Occurrence;
  variant?: 'full' | 'compact' | 'row';
  showDate?: boolean;
}

export function ReminderCard({ o, variant = 'full', showDate = false }: Props) {
  const { t } = useTranslation();
  const teams = useStore((s) => s.teams);
  const profiles = useStore((s) => s.profiles);
  const assignees = useStore((s) => s.assignees);
  const memberships = useStore((s) => s.memberships);
  const me = useStore((s) => s.me);
  const selected = useStore((s) => s.selectedKey === o.key);
  const select = useStore((s) => s.select);
  const requestComplete = useStore((s) => s.requestComplete);
  const uncomplete = useStore((s) => s.uncomplete);

  const team = teams.find((x) => x.id === o.reminder.team_id);
  const color = team?.color ?? 'var(--hair-2)';
  const done = !!o.completion;
  const { people } = resolveAssignees(o.reminder, assignees, profiles, teams, memberships);
  const rel = relativeLabel(o.at);
  const cls = ['card', variant === 'full' ? '' : variant, selected ? 'selected' : '', done ? 'done' : '', o.isOverdue ? 'overdue' : ''].join(' ');
  const doneBy = o.completion ? (o.completion.completed_by_name || profiles.find((p) => p.id === o.completion!.completed_by)?.name || '') : '';

  const timeCol = (
    <div className="time-col" style={{ borderRightColor: done ? 'var(--hair-2)' : o.isOverdue ? 'var(--red)' : color }}>
      <span className="time">{hm(o.at)}</span>
      {done ? (
        <span className="time-sub">{t('detail.byName', { name: doneBy })}</span>
      ) : showDate ? (
        <span className={`time-sub ${o.isOverdue ? 'hot' : ''}`}>{o.isOverdue ? rel.text : whenLabel(o.at, false)}</span>
      ) : (
        <span className={`time-sub ${rel.hot ? 'hot' : ''}`}>{o.isOverdue || rel.hot ? rel.text : beforeLabel(o.reminder.remind_before_min)}</span>
      )}
    </div>
  );

  const links = parseLinks(o.reminder.link).filter((l) => l.url);
  const attCount = useStore((s) => s.attachments.filter((a) => a.reminder_id === o.reminder.id).length);
  // 需要回传的提醒：创建人 / 管理员在卡片上直接看到「已交 12/30」；交作业的人看到自己的状态（已交 / 已退回 / 已通过）；
  // 共用设备看这一次一共交了几份
  const canReview = !!me && !me.is_station && (me.id === o.reminder.created_by || me.role === 'admin');
  const hwCount = (() => {
    if (!o.reminder.require_upload) return null;
    if (canReview) {
      const audience = audienceOf(o.reminder, assignees, profiles, teams, memberships);
      if (audience.length) {
        const st = homeworkStats(o, audience);
        return t('homework.cardCount', { n: st.submitted, total: st.expected });
      }
    }
    if (me && !me.is_station) {
      const st = personHomework(o.submissions.filter((s) => isSubmissionOf(s, me)), o.at).status;
      return st === 'missing' ? t('submit.badge') : t(HW_STATUS_KEY[st]);
    }
    return o.submissions.length > 0 ? t('submit.count', { n: o.submissions.length }) : t('submit.badge');
  })();

  const label = [
    teamName(team),
    o.reminder.priority === 'high' ? t('priority.highLabel') : '',
    o.reminder.rrule ? repeatLabel(o.reminder) : '',
    // 看板的一行没有地方放小标签：作业的进度 / 状态直接写在这一行的标签里
    o.reminder.require_upload ? (variant === 'row' && hwCount ? hwCount : t('submit.badge')) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  if (variant === 'row') {
    return (
      <div className={cls} onClick={() => select(o.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(o.key)}>
        <button
          className="check"
          aria-label={done ? t('actions.undo') : t('actions.complete')}
          onClick={(e) => {
            e.stopPropagation();
            done ? void uncomplete(o) : requestComplete(o);
          }}
        >
          <span className={`check-sq ${done ? 'done' : o.isOverdue ? 'red' : ''}`}>{done && <IconCheck size={12} />}</span>
        </button>
        {timeCol}
        <div className="body">
          <span className="label" style={{ color: done ? 'var(--faint)' : color }}>{label}</span>
          <span className="title">{o.reminder.title}</span>
        </div>
        <div className="side">
          <AvatarStack people={people} onWhite={selected} />
          <span className="pri-dot" style={{ background: done ? 'var(--hair-2)' : PRIORITY_COLOR[o.reminder.priority] }} />
        </div>
      </div>
    );
  }

  if (variant === 'compact' || done) {
    return (
      <div className={`${cls} compact`} onClick={() => select(o.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(o.key)}>
        {timeCol}
        <div className="body" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {done && <IconCheck size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />}
          {!done && team && (
            <span className="label" style={{ color, flexShrink: 0 }}>
              {teamName(team)}
            </span>
          )}
          <span className="title">{o.reminder.title}</span>
        </div>
        <div className="side">
          <AvatarStack people={people} max={2} onWhite={selected} />
        </div>
      </div>
    );
  }

  return (
    <div className={cls} onClick={() => select(o.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(o.key)}>
      {timeCol}
      <div className="body">
        <span className="label" style={{ color }}>
          {label}
        </span>
        <span className="title">{o.reminder.title}</span>
        {(o.reminder.notes || links.length > 0 || o.reminder.rrule || o.reminder.require_upload || attCount > 0) && (
          <span className="meta">
            {hwCount && (
              <span className="meta-pill">
                <IconUpload size={11} />
                {hwCount}
              </span>
            )}
            {attCount > 0 && (
              <span className="meta-att" title={t('detail.attachments')}>
                <IconPaperclip size={12} />
                {attCount}
              </span>
            )}
            {links.length > 0 && <IconLink size={12} />}
            {o.reminder.rrule && !o.reminder.notes && <IconRepeat size={12} />}
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {(o.reminder.notes || (o.reminder.rrule ? repeatLabel(o.reminder) : links.length ? links.map(linkTitle).join(' · ') : '')).split('\n')[0]}
            </span>
          </span>
        )}
      </div>
      <div className="side">
        <AvatarStack people={people} onWhite={selected} />
      </div>
    </div>
  );
}
