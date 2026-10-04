import { Fragment, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../lib/store';
import { useOccurrences } from '../lib/useData';
import { useDueDiscussions } from '../lib/useDiscussions';
import { localHm, localYmd } from '../lib/recurrence';
import { holidayOn } from '../lib/holidays';
import { dayDiff, isoWeek, monthLabel, todayYmd, weekdayOf, zoned } from '../lib/format';
import { ReminderCard } from './ReminderCard';
import { DiscussionDueCard } from './DiscussionDueCard';
import { IconChevronL, IconChevronR, IconMoon, IconPlus } from './Icons';
import { ViewHeader } from './ViewHeader';

const DAYS_SHOWN = 14;

export function AgendaView() {
  const { t } = useTranslation();
  const anchor = useStore((s) => s.calendarAnchor);
  const setAnchor = useStore((s) => s.setCalendarAnchor);
  const openNew = useStore((s) => s.openNew);
  const teams = useStore((s) => s.teams);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  useStore((s) => s.holidays); // 节假日变了要重画（休 / 班 和节日名）

  const startYmd = localYmd(anchor);
  const from = useMemo(() => new Date(new Date(startYmd + 'T00:00:00Z').getTime() - 3 * 3600000), [startYmd]);
  const to = useMemo(() => new Date(from.getTime() + (DAYS_SHOWN + 1) * 86400000), [from]);
  const occs = useOccurrences(from, to);
  // 设了截止日期的讨论：放在那一天的最上面（跟着上面的筛选走）
  const { byDay: dueByDay, unread } = useDueDiscussions();

  const today = todayYmd();
  const now = new Date();
  const days: string[] = [];
  for (let i = 0; i < DAYS_SHOWN; i++) {
    const d = new Date(new Date(startYmd + 'T00:00:00Z').getTime() + i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const byDay = new Map<string, typeof occs>();
  for (const o of occs) {
    const k = localYmd(o.at);
    const list = byDay.get(k) ?? [];
    list.push(o);
    byDay.set(k, list);
  }
  const z = zoned(anchor);
  const overdueCount = occs.filter((o) => o.isOverdue).length;

  const shift = (days: number) => {
    setAnchor(new Date(anchor.getTime() + days * 86400000));
  };

  // 日期块粘在顶部时给它加 .stuck（只在真的被卡片顶到时显示阴影）
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = el.getBoundingClientRect().top;
      el.querySelectorAll<HTMLElement>('.day-section').forEach((sec) => {
        const num = sec.querySelector<HTMLElement>('.day-num');
        if (!num) return;
        const stuck = sec.getBoundingClientRect().top < top - 1 && num.getBoundingClientRect().top <= top + 1;
        num.classList.toggle('stuck', stuck);
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [startYmd, occs.length, dueByDay.size]);

  const dateLabel = (ymd: string) => `${Number(ymd.slice(5, 7))}.${Number(ymd.slice(8, 10))}`;

  return (
    <section className="main">
      <ViewHeader
        title={monthLabel(z.getFullYear(), z.getMonth() + 1)}
        sub={[t('time.week', { n: isoWeek(startYmd) }), String(occs.length), overdueCount ? `${t('groups.overdue')} ${overdueCount}` : ''].filter(Boolean).join(' · ')}
      />
      <div className="toolbar">
        <button className="icon-btn" aria-label="prev" onClick={() => shift(-7)}>
          <IconChevronL size={16} />
        </button>
        <button className="chip" onClick={() => setAnchor(new Date())}>
          {t('time.today')}
        </button>
        <button className="icon-btn" aria-label="next" onClick={() => shift(7)}>
          <IconChevronR size={16} />
        </button>
        <div className="grow" />
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
          <select className="select" value={filter.startsWith('team:') ? filter : ''} onChange={(e) => setFilter((e.target.value || 'all') as never)} aria-label={t('filters.team')}>
            <option value="">{t('filters.team')}</option>
            {teams.map((tm) => (
              <option key={tm.id} value={`team:${tm.id}`}>
                {tm.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="scroll" ref={scrollRef}>
        {days.map((ymd) => {
          const list = byDay.get(ymd) ?? [];
          const dues = dueByDay.get(ymd) ?? [];
          const diff = dayDiff(ymd, today);
          const wd = weekdayOf(ymd);
          const hol = holidayOn(ymd);
          const isOff = hol?.kind === 'off';
          const isMakeup = hol?.kind === 'work';
          const isWeekend = (wd === 0 || wd === 6) && !isMakeup;
          const dayNum = Number(ymd.slice(8, 10));
          // 当前时间线的位置：插在第一条未来提醒之前
          let nowInserted = false;
          return (
            <section key={ymd} data-ymd={ymd} className={`day-section ${diff === 0 ? 'today' : diff < 0 ? 'past' : ''} ${isOff ? 'off-day' : ''} ${isMakeup ? 'makeup-day' : ''}`}>
              <div className="day-num">
                <span className="n">{dayNum}</span>
                <span className="wd">
                  <span className="wd-top">
                    {t(`weekdaysLong.${wd}`)}
                    {hol && (
                      <i className={`hday ${isOff ? 'off' : 'work'}`} title={isOff ? t('holidays.off') : t('holidays.work')}>
                        {isOff ? t('holidays.badgeOff') : t('holidays.badgeWork')}
                      </i>
                    )}
                  </span>
                  <small>{diff === 0 ? t('time.today') : diff === 1 ? t('time.tomorrow') : diff === -1 ? t('time.yesterday') : dateLabel(ymd)}</small>
                  {hol?.name && <small className="hday-name">{isMakeup ? t('holidays.makeup', { name: hol.name }) : hol.name}</small>}
                </span>
              </div>
              <div className="day-cards">
                {dues.map((d) => (
                  <DiscussionDueCard key={d.id} d={d} u={unread.get(d.id)} />
                ))}
                {list.length === 0 && dues.length === 0 && (
                  <div className="empty-day">
                    {isWeekend || isOff ? <IconMoon size={18} /> : null}
                    {isOff ? t('groups.holidayQuiet', { name: hol?.name ?? '' }) : isWeekend ? t('groups.weekendQuiet') : t('groups.empty')}
                  </div>
                )}
                {list.map((o) => {
                  let line = null;
                  if (diff === 0 && !nowInserted && o.at > now) {
                    nowInserted = true;
                    const mins = Math.round((o.at.getTime() - now.getTime()) / 60000);
                    line = (
                      <div className="now-line">
                        <span className="dot" />
                        <span className="line" />
                        <span className="lbl">
                          {localHm(now)} · {mins > 90 ? t('time.inHours', { n: Math.round(mins / 60) }) : t('time.nextIn', { n: mins })}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <Fragment key={o.key}>
                      {line}
                      <ReminderCard o={o} />
                    </Fragment>
                  );
                })}
                {diff >= 0 && (
                  <button className="add-round" aria-label={t('actions.new')} onClick={openNew}>
                    <IconPlus size={16} />
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
