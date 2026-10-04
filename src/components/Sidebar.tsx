import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useOccurrences } from '../lib/useData';
import { useDueDiscussions } from '../lib/useDiscussions';
import { resolveAssignees } from '../lib/occurrences';
import { localYmd } from '../lib/recurrence';
import { holidayOn } from '../lib/holidays';
import { dayDiff, hm, monthLabel, relativeLabel, todayYmd, zoned } from '../lib/format';
import { Avatar } from './Avatar';
import { IconChat, IconCheck, IconChevronL, IconChevronR, IconPlus, IconSearch } from './Icons';
import type { Discussion, Occurrence } from '../lib/types';

const PRIORITY_COLOR: Record<string, string> = { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--hair-2)' };

export function Sidebar() {
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const openNew = useStore((s) => s.openNew);
  const select = useStore((s) => s.select);
  const requestComplete = useStore((s) => s.requestComplete);
  const teams = useStore((s) => s.teams);
  const profiles = useStore((s) => s.profiles);
  const assignees = useStore((s) => s.assignees);
  const memberships = useStore((s) => s.memberships);
  const anchor = useStore((s) => s.calendarAnchor);
  const setAnchor = useStore((s) => s.setCalendarAnchor);
  const openDiscussion = useStore((s) => s.openDiscussion);
  useStore((s) => s.holidays); // 节假日变了要重画迷你月历
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  const now = new Date();
  const from = useMemo(() => new Date(now.getTime() - 14 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = useMemo(() => new Date(now.getTime() + 45 * 86400000), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const occs = useOccurrences(from, to, false);
  // 讨论的截止日期：迷你月历上也点一个点（不跟筛选走，和提醒的点一样）；今天截止的列在「今天」里
  const { byDay: dueByDay } = useDueDiscussions(false);

  const today = todayYmd();
  const todayList = occs.filter((o) => localYmd(o.at) === today && !o.completion);
  const overdueList = occs.filter((o) => o.isOverdue && localYmd(o.at) !== today);
  const pending = [...overdueList, ...todayList.filter((o) => o.isOverdue)];
  const upcoming = todayList.filter((o) => !o.isOverdue);
  const dueToday = (dueByDay.get(today) ?? []).filter((d) => !d.closed_at);

  const filtered = search.trim()
    ? occs.filter((o) => o.reminder.title.toLowerCase().includes(search.trim().toLowerCase()) && !o.completion).slice(0, 12)
    : null;

  // 迷你月历
  const z = zoned(anchor);
  const y = z.getFullYear();
  const m = z.getMonth() + 1;
  const first = new Date(y, m - 1, 1);
  const startOffset = (first.getDay() + 6) % 7; // 周一开头
  const cells: { ymd: string; day: number; other: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m - 1, 1 - startOffset + i);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    cells.push({ ymd, day: d.getDate(), other: d.getMonth() !== m - 1 });
  }
  const dotsByDay = new Map<string, string[]>();
  for (const o of occs) {
    if (o.completion) continue;
    const key = localYmd(o.at);
    const list = dotsByDay.get(key) ?? [];
    const c = o.isOverdue ? 'var(--red)' : teams.find((x) => x.id === o.reminder.team_id)?.color ?? 'var(--faint)';
    if (!list.includes(c) && list.length < 3) list.push(c);
    dotsByDay.set(key, list);
  }
  for (const [key, ds] of dueByDay) {
    if (!ds.some((d) => !d.closed_at)) continue;
    const list = dotsByDay.get(key) ?? [];
    const c = dayDiff(key, today) < 0 ? 'var(--red)' : 'var(--ink)';
    if (!list.includes(c) && list.length < 3) list.push(c);
    dotsByDay.set(key, list);
  }
  const selectedYmd = localYmd(anchor);

  const pickDay = (ymd: string) => {
    const [yy, mm, dd] = ymd.split('-').map(Number);
    setAnchor(new Date(Date.UTC(yy, mm - 1, dd, 12)));
    if (view !== 'calendar') setView('calendar');
  };

  const row = (o: Occurrence, withCheck: boolean) => {
    const person = resolveAssignees(o.reminder, assignees, profiles, teams, memberships).people[0] ?? profiles.find((p) => p.id === o.reminder.created_by);
    const rel = relativeLabel(o.at);
    return (
      <div key={o.key} className="side-row" role="button" tabIndex={0} onClick={() => select(o.key)} onKeyDown={(e) => e.key === 'Enter' && select(o.key)}>
        {withCheck ? (
          <span className="pri" style={{ background: o.isOverdue ? 'var(--red)' : PRIORITY_COLOR[o.reminder.priority] }} />
        ) : person ? (
          <Avatar p={person} size="sm" />
        ) : (
          <span className="pri" />
        )}
        <span className="t">{o.reminder.title}</span>
        {withCheck ? (
          <button
            className="check-sq"
            aria-label={t('actions.complete')}
            onClick={(e) => {
              e.stopPropagation();
              requestComplete(o);
            }}
          >
            <IconCheck size={12} style={{ opacity: 0 }} />
          </button>
        ) : (
          <span className={`time ${rel.hot ? 'soon' : ''}`}>{hm(o.at)}</span>
        )}
      </div>
    );
  };

  const dueRow = (d: Discussion) => (
    <div
      key={d.id}
      className="side-row"
      role="button"
      tabIndex={0}
      onClick={() => openDiscussion(d.id, view)}
      onKeyDown={(e) => e.key === 'Enter' && openDiscussion(d.id, view)}
    >
      <span className="side-ic">
        <IconChat size={14} />
      </span>
      <span className="t">{d.title}</span>
      <span className="time soon">{t('discuss.calDue')}</span>
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="head">
        <h1>{view === 'board' ? t('views.board') : view === 'settings' ? t('settings.title') : t('views.calendar')}</h1>
        <button className="icon-btn" aria-label={t('actions.search')} onClick={() => setShowSearch((v) => !v)}>
          <IconSearch size={18} />
        </button>
      </div>
      {showSearch && (
        <input className="input" autoFocus placeholder={t('actions.search')} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t('actions.search')} />
      )}
      {filtered ? (
        <div className="side-section">{filtered.length ? filtered.map((o) => row(o, false)) : <div className="hint-text">{t('groups.none')}</div>}</div>
      ) : (
        <>
          <div className="mini-month">
            <div className="month-nav">
              <button className="icon-btn sm" aria-label="prev" onClick={() => setAnchor(new Date(Date.UTC(y, m - 2, 1, 12)))}>
                <IconChevronL size={14} />
              </button>
              <span>{monthLabel(y, m)}</span>
              <button className="icon-btn sm" aria-label="next" onClick={() => setAnchor(new Date(Date.UTC(y, m, 1, 12)))}>
                <IconChevronR size={14} />
              </button>
            </div>
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <div key={d} className="wd">
                {t(`weekdays.${d}`)}
              </div>
            ))}
            {cells.map((c) => {
              const wd = new Date(c.ymd + 'T00:00:00Z').getUTCDay();
              const dots = dotsByDay.get(c.ymd) ?? [];
              const h = holidayOn(c.ymd);
              const rest = h ? h.kind === 'off' : wd === 0 || wd === 6;
              return (
                <button
                  key={c.ymd}
                  className={`cell ${c.other ? 'other' : ''} ${rest ? 'weekend' : ''} ${h ? `h-${h.kind}` : ''} ${c.ymd === today ? 'today' : ''} ${c.ymd === selectedYmd ? 'selected' : ''}`}
                  onClick={() => pickDay(c.ymd)}
                  aria-label={h ? `${c.ymd} ${h.name} ${h.kind === 'off' ? t('holidays.off') : t('holidays.work')}` : c.ymd}
                  title={h ? `${h.name} · ${h.kind === 'off' ? t('holidays.off') : t('holidays.work')}` : undefined}
                >
                  <span className="num">{c.day}</span>
                  {h && <i className={`hday mini ${h.kind}`}>{h.kind === 'off' ? t('holidays.badgeOff') : t('holidays.badgeWork')}</i>}
                  <span className="dots">
                    {dots.map((d, i) => (
                      <i key={i} style={{ background: d }} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="side-section">
            <div className="sec-head">
              <h2>{t('nav.today')}</h2>
              <button className="icon-btn sm" aria-label={t('actions.new')} onClick={openNew}>
                <IconPlus size={16} />
              </button>
            </div>
            {dueToday.map(dueRow)}
            {upcoming.length ? upcoming.slice(0, 6).map((o) => row(o, false)) : !dueToday.length && <div className="hint-text">{t('groups.none')}</div>}
          </div>

          <div className="side-section">
            <div className="sec-head">
              <h2>{t('nav.pending')}</h2>
              {pending.length > 0 && <span className="pill-count">{t('nav.overdue')} {pending.length}</span>}
            </div>
            {pending.length ? pending.slice(0, 6).map((o) => row(o, true)) : <div className="hint-text">{t('groups.none')}</div>}
          </div>
        </>
      )}
    </aside>
  );
}
