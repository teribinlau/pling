import { useTranslation } from 'react-i18next';
import { useStore, type View } from '../lib/store';
import { teamName } from '../lib/occurrences';
import { dayDiff, todayYmd } from '../lib/format';
import type { UnreadInfo } from '../lib/discussions';
import type { Discussion } from '../lib/types';
import { Avatar } from './Avatar';
import { IconChat, IconCheck } from './Icons';

/**
 * 日历里「讨论截止」的卡片：放在那一天的最上面（像全天事项），点一下直接打开这个讨论，关掉后回到日历。
 * 和提醒卡片同一个版式，但空心描边、分隔线是虚线，时间那一格是讨论图标 —— 一眼看得出不是定时提醒。
 * 已结束的讨论显示成已完成的样子。到期不弹提醒，只在这里显示。
 */
export function DiscussionDueCard({ d, u, from = 'calendar' }: { d: Discussion; u?: UnreadInfo; from?: View }) {
  const { t } = useTranslation();
  const profiles = useStore((s) => s.profiles);
  const teams = useStore((s) => s.teams);
  const members = useStore((s) => s.discussionMembers);
  const openDiscussion = useStore((s) => s.openDiscussion);

  const closed = !!d.closed_at;
  const diff = d.due_date ? dayDiff(d.due_date, todayYmd()) : 0;
  const over = !closed && diff < 0;
  const hot = !closed && diff <= 0;

  const creator = profiles.find((p) => p.id === d.created_by);
  const creatorName = d.created_by_name || creator?.name || '';
  const avatar = d.created_by_name ? (profiles.find((p) => p.name === d.created_by_name) ?? { id: `name:${d.created_by_name}`, name: d.created_by_name }) : (creator ?? { id: d.created_by, name: '?' });
  const rows = members.filter((m) => m.discussion_id === d.id);
  const scope =
    d.visibility === 'company'
      ? t('discuss.everyone')
      : [
          ...teams.filter((tm) => rows.some((m) => m.team_id === tm.id)).map((tm) => teamName(tm)),
          ...profiles.filter((p) => rows.some((m) => m.user_id === p.id)).map((p) => p.name),
        ].join('、');

  const open = () => openDiscussion(d.id, from);
  const cls = ['card', 'dcard', closed ? 'compact done' : '', over ? 'overdue' : '', u?.unread ? 'unread' : ''].filter(Boolean).join(' ');
  const status = closed ? t('discuss.tabClosed') : over ? t('discuss.calOver') : diff === 0 ? t('discuss.dueToday') : t('discuss.calDue');

  const timeCol = (
    <div className="time-col">
      <span className="time">
        <IconChat size={closed ? 16 : 20} />
      </span>
      <span className={`time-sub ${hot ? 'hot' : ''}`}>{status}</span>
    </div>
  );

  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-label={`${t('discuss.calTag')} · ${status}: ${d.title}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      {timeCol}
      {closed ? (
        <div className="body" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <IconCheck size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />
          <span className="title">{d.title}</span>
        </div>
      ) : (
        <div className="body">
          <span className="label">
            {t('discuss.calTag')} · {scope}
          </span>
          <span className="title">{d.title}</span>
          <span className="meta">
            <span className="dcard-by">{t('discuss.startedBy', { name: creatorName })}</span>
            <span className="meta-att" title={t('discuss.comments')}>
              <IconChat size={12} />
              {d.comment_count}
            </span>
            {u?.unread &&
              (u.isNew ? (
                <span className="dnew">{t('discuss.newBadge')}</span>
              ) : u.count > 0 ? (
                <span className="pill-count">{t('discuss.unreadN', { count: u.count })}</span>
              ) : (
                <span className="udot" aria-label={t('discuss.newBadge')} />
              ))}
          </span>
        </div>
      )}
      <div className="side">
        <Avatar p={avatar} size={closed ? 'sm' : ''} />
      </div>
    </div>
  );
}
