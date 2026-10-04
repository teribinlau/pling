import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useOccurrences } from '../lib/useData';
import { localYmd } from '../lib/recurrence';
import { dayDiff, todayYmd, zoned } from '../lib/format';
import { ReminderCard } from './ReminderCard';
import { ViewHeader } from './ViewHeader';
import { IconAlert } from './Icons';
import type { Occurrence } from '../lib/types';

export function BoardView() {
  const { t } = useTranslation();
  const teams = useStore((s) => s.teams);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  const now = new Date();
  const from = useMemo(() => new Date(now.getTime() - 30 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = useMemo(() => new Date(now.getTime() + 14 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const occs = useOccurrences(from, to);
  const today = todayYmd();

  const groups: { key: string; label: string; red?: boolean; items: Occurrence[] }[] = [
    { key: 'overdue', label: t('groups.overdue'), red: true, items: [] },
    { key: 'today', label: t('groups.today'), items: [] },
    { key: 'tomorrow', label: t('groups.tomorrow'), items: [] },
    { key: 'week', label: t('groups.week'), items: [] },
    { key: 'later', label: t('groups.later'), items: [] },
    { key: 'done', label: t('groups.done'), items: [] },
  ];
  for (const o of occs) {
    const diff = dayDiff(localYmd(o.at), today);
    if (o.completion) {
      if (diff >= -1) groups[5].items.push(o);
      continue;
    }
    if (o.isOverdue && diff < 0) groups[0].items.push(o);
    else if (diff === 0) groups[1].items.push(o);
    else if (diff === 1) groups[2].items.push(o);
    else if (diff > 1 && diff <= 7) groups[3].items.push(o);
    else if (diff > 7) groups[4].items.push(o);
  }
  groups[5].items.sort((a, b) => b.at.getTime() - a.at.getTime());
  const z = zoned(now);
  const pendingCount = groups.slice(0, 5).reduce((n, g) => n + g.items.length, 0);

  return (
    <section className="main">
      <ViewHeader title={t('views.board')} dim={`${z.getMonth() + 1}.${z.getDate()}`} sub={[t(`weekdaysLong.${z.getDay()}`), String(pendingCount), groups[0].items.length ? `${t('groups.overdue')} ${groups[0].items.length}` : ''].filter(Boolean).join(' · ')} />
      <div className="toolbar">
        <div className="chips">
          <button className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            {t('filters.all')}
          </button>
          <button className={`chip ${filter === 'mine' ? 'active' : ''}`} onClick={() => setFilter('mine')}>
            {t('filters.mine')}
          </button>
          <button className={`chip ${filter === 'created' ? 'active' : ''}`} onClick={() => setFilter('created')}>
            {t('filters.created')}
          </button>
          {teams.map((tm) => (
            <button key={tm.id} className={`chip ${filter === `team:${tm.id}` ? 'active' : ''}`} onClick={() => setFilter(`team:${tm.id}`)}>
              <span className="dot" style={{ background: tm.color, width: 8, height: 8 }} />
              {tm.name}
            </button>
          ))}
        </div>
      </div>
      <div className="scroll">
        {groups.map((g) =>
          g.items.length ? (
            <div key={g.key} className="group">
              <div className={`group-head ${g.red ? 'red' : ''}`}>
                {g.red && <IconAlert size={14} />}
                <span>{g.label}</span>
                <span className="cnt">{g.items.length}</span>
              </div>
              {g.items.map((o) => (
                <ReminderCard key={o.key} o={o} variant="row" showDate={g.key !== 'today'} />
              ))}
            </div>
          ) : null,
        )}
        {pendingCount === 0 && groups[5].items.length === 0 && <div className="empty-day" style={{ marginTop: 16 }}>{t('groups.none')}</div>}
      </div>
    </section>
  );
}
